#!/usr/bin/env bash
#
# One command, from a bare Ubuntu server to the district's system running on its own domain.
# ADR-0019 — the record moved to the cloud, so this replaced the Windows office-machine path
# for the primary. `installer/` (Inno Setup, PowerShell) is still how a *field* Windows machine
# is set up; it is not this and the two must not be merged.
#
#   sudo ./setup.sh dnc.example.com admin@example.com
#
# ------------------------------------------------------------------------------------------
# What it installs, and why each one
# ------------------------------------------------------------------------------------------
#
#   PostgreSQL 17   the record itself (ADR-0001). From the PGDG repository, because Ubuntu's
#                   own package lags and `migrations.test.ts` is written against 17.
#   Node 22 LTS     the application. From NodeSource, same reason.
#   Caddy           TLS that renews itself (ADR-0017). The alternative is nginx plus certbot
#                   plus a timer plus a renewal nobody watches — three things that fail
#                   silently on the machine holding a district's emergency record.
#   ufw             everything closed except 22, 80, 443.
#
# ------------------------------------------------------------------------------------------
# Three rules this script follows, and they are the ones that make it safe to re-run
# ------------------------------------------------------------------------------------------
#
#   1. **It refuses rather than guesses.** No domain, no email, not Ubuntu, not root — it
#      stops and says which. A half-configured server that reports success is how somebody
#      discovers at 02:00 that TLS was never set up.
#
#   2. **It never overwrites an existing .env.** That file is the secret store on this
#      deployment (ADR-0007). Re-running the script on a live server must not silently
#      replace the district's WhatsApp token with a blank.
#
#   3. **It proves what it did.** The last thing it does is ask /health over the public
#      domain and fail if the answer is not the district's own system. Announcing success is
#      not the same as having succeeded — the same rule `npm run setup:whatsapp` follows.

set -euo pipefail

DOMAIN="${1:-}"
EMAIL="${2:-}"
APP_USER="dnc-bajaur"
APP_DIR="/opt/dnc-bajaur"
DB_NAME="dnc_bajaur"
DB_USER="dnc_bajaur"

say()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
ok()   { printf '    \033[32mok\033[0m  %s\n' "$*"; }
die()  { printf '\n\033[1;31mstopped: %s\033[0m\n\n' "$*" >&2; exit 1; }

#-------------------------------------------------------------------------------------------
# Refuse early, and say which thing is wrong
#-------------------------------------------------------------------------------------------

[ "$(id -u)" -eq 0 ] || die "run with sudo"
[ -n "$DOMAIN" ] || die "usage: sudo ./setup.sh dnc.yourdomain.com you@yourdomain.com"
[ -n "$EMAIL" ]  || die "an email is needed — Let's Encrypt sends expiry warnings to it, and an unwatched certificate is what Caddy is here to prevent"
# The version, not just the distribution. This check used to be `grep -qi ubuntu` while its own
# message said "tested for Ubuntu 24.04" — so a Hetzner image of 26.04 passed it happily on
# 2026-08-10 and would have failed forty lines later, when PGDG had no repository for that
# release. That error arrives as an apt failure and reads like a network fault, which is an
# evening spent debugging the wrong thing. A guard weaker than the sentence beside it is the
# thing this script's first rule exists to prevent: refuse, and say which.
#
# 24.04 specifically, because PostgreSQL (PGDG), Node (NodeSource) and Caddy all publish per
# release codename and all lag a new Ubuntu by months. When they have caught up, change the
# number here deliberately — and run this on a throwaway server before a district's does.
UBUNTU_VERSION="$(. /etc/os-release && echo "${VERSION_ID:-}")"
[ "$(. /etc/os-release && echo "${ID:-}")" = "ubuntu" ] || die "this is written for Ubuntu, and this machine is not Ubuntu"
[ "$UBUNTU_VERSION" = "24.04" ] || die "Ubuntu 24.04 is required and this is $UBUNTU_VERSION.
    PostgreSQL, Node and Caddy each publish their apt repository per Ubuntu codename, and all
    three lag a new release by months — so this would install cleanly and then fail on
    postgresql-17 with an error about apt rather than about the operating system.
    On a cloud host the fix is a rebuild, not a workaround: the server is empty and the IP
    does not change."

# The DNS record has to exist *before* Caddy asks Let's Encrypt for a certificate: the
# challenge is served over HTTP on this machine, so a name pointing somewhere else fails in a
# way whose error message is about ACME rather than about DNS.
say "Checking that $DOMAIN points here"
apt-get install -y -qq dnsutils curl >/dev/null 2>&1 || true
RESOLVED="$(dig +short "$DOMAIN" A | tail -n1 || true)"
PUBLIC_IP="$(curl -fsS --max-time 10 https://api.ipify.org || true)"

if [ -z "$RESOLVED" ]; then
  die "$DOMAIN does not resolve yet. Add:  A   ${DOMAIN%%.*}   $PUBLIC_IP   TTL 300"
fi
if [ "$RESOLVED" != "$PUBLIC_IP" ]; then
  printf '    \033[33mwarning\033[0m  %s resolves to %s, this machine is %s\n' "$DOMAIN" "$RESOLVED" "$PUBLIC_IP"
  printf '             If Cloudflare is proxying (orange cloud) this is expected. Otherwise the\n'
  printf '             certificate will fail. Continuing in 10s — Ctrl-C to stop.\n'
  sleep 10
else
  ok "$DOMAIN -> $PUBLIC_IP"
fi

#-------------------------------------------------------------------------------------------
# Packages
#-------------------------------------------------------------------------------------------

say "Installing PostgreSQL 17, Node 22 and Caddy"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg git ufw debian-keyring debian-archive-keyring apt-transport-https

# PostgreSQL 17 — PGDG, because Ubuntu ships older and the migrations are written against 17.
install -d /usr/share/postgresql-common/pgdg
curl -fsS https://www.postgresql.org/media/keys/ACCC4CF8.asc \
  -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc
echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt $(. /etc/os-release && echo "$VERSION_CODENAME")-pgdg main" \
  > /etc/apt/sources.list.d/pgdg.list

# Node 22 LTS
curl -fsS https://deb.nodesource.com/setup_22.x | bash - >/dev/null

# Caddy
curl -fsS https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
  | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -fsS https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
  > /etc/apt/sources.list.d/caddy-stable.list

apt-get update -qq
apt-get install -y -qq postgresql-17 nodejs caddy
ok "postgres $(psql --version | awk '{print $3}') · node $(node -v) · caddy $(caddy version | head -n1)"

#-------------------------------------------------------------------------------------------
# The clock. S3 refuses anything signed more than 15 minutes out and its error says nothing
# about time — so this is set here rather than diagnosed later (see ops/offsite.ts).
#
# The TIMEZONE is set here too, and that line was missing until 2026-08-13. A Hetzner Ubuntu
# comes up as Etc/UTC, and four places in the application computed "the district's day" from
# the machine's own midnight — so the district's today began at 05:00 Bajaur time, and every
# "today" counter, the board's occurredToday flag, every report boundary and the nightly
# backup's own has-one-run-today check were wrong between midnight and dawn. Every night.
#
# The application no longer depends on this: domain/districtTime.ts names Asia/Karachi as data
# and reads nothing from the machine. This is set anyway, because `journalctl`, `ls -l`, a
# `psql` prompt and every log line an operator reads at 02:00 still use the system zone — and
# an operator comparing a log timestamp against a wall clock five hours out will conclude the
# wrong thing about what happened when.
#-------------------------------------------------------------------------------------------

timedatectl set-ntp true 2>/dev/null || true
timedatectl set-timezone Asia/Karachi 2>/dev/null || true
ok "clock synchronised · $(timedatectl show -p Timezone --value 2>/dev/null || echo 'timezone unknown')"

#-------------------------------------------------------------------------------------------
# Database and service user
#-------------------------------------------------------------------------------------------

say "Creating the database"
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --home-dir "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"

DB_PASS="$(head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 32)"
if sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='$DB_USER'" | grep -q 1; then
  ok "role $DB_USER already exists — password left alone"
  DB_PASS=""
else
  sudo -u postgres psql -qc "CREATE ROLE $DB_USER LOGIN PASSWORD '$DB_PASS'"
  ok "role $DB_USER created"
fi
sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" | grep -q 1 \
  || sudo -u postgres createdb -O "$DB_USER" "$DB_NAME"
ok "database $DB_NAME ready"

#-------------------------------------------------------------------------------------------
# The application
#-------------------------------------------------------------------------------------------

say "Building the application"
[ -d "$APP_DIR/app" ] || die "copy the repository to $APP_DIR first (so that $APP_DIR/app/package.json exists), then re-run"

cd "$APP_DIR/app"
# NOT --omit=dev, and not an oversight. `npm run build` is esbuild and `build:server` is tsc,
# and both of those are devDependencies — omitting them installs cleanly and then fails on the
# next line with MODULE_NOT_FOUND, which reads like a broken repository rather than a flag.
#
# Nor are they pruned after the build. `doctor`, `setup:whatsapp` and `dev:account` each run
# `build:server` first, so a server pruned to production dependencies loses all four of the
# commands this script's own closing message tells the district to run next.
npm ci --silent 2>/dev/null || npm install --silent
npm run build --silent
npm run build:server --silent
ok "built"

#-------------------------------------------------------------------------------------------
# .env — written once, never overwritten
#-------------------------------------------------------------------------------------------

if [ -f "$APP_DIR/app/.env" ]; then
  ok ".env already exists — left untouched (rule 2)"
else
  say "Writing .env"
  [ -n "$DB_PASS" ] || die "the database role existed but .env does not — put DATABASE_URL in $APP_DIR/app/.env by hand, then re-run"
  cat > "$APP_DIR/app/.env" <<ENVEOF
NODE_ENV=production
DATABASE_URL=postgres://$DB_USER:$DB_PASS@127.0.0.1:5432/$DB_NAME

# Behind Caddy. Both of these ship together or the second is an outage: behind a proxy every
# request arrives from 127.0.0.1, so without TRUSTED_PROXIES the whole district shares one
# throttle key and one officer mistyping a password slows sign-in for everybody (M6-37).
HOST=127.0.0.1
PORT=3001
TRUSTED_PROXIES=127.0.0.1

# Acknowledge links in WhatsApp messages are built from this. An address officers' phones
# cannot reach is a link that fails on every handset it arrives on.
PUBLIC_ORIGIN=https://$DOMAIN

# --- still to fill in ---
# WhatsApp (R-05): npm run setup:whatsapp
# Off-site backup (R-06): S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY,
#   BACKUP_PASSPHRASE — Cloudflare R2, five minutes, see backlog/how-to-set-these-up.md
ENVEOF
  ok ".env written"
fi

chown -R "$APP_USER:$APP_USER" "$APP_DIR"
chmod 600 "$APP_DIR/app/.env"
ok "secrets readable only by $APP_USER"

say "Running migrations"
sudo -u "$APP_USER" bash -c "cd $APP_DIR/app && node -e \"
  import('./dist/db/pool.js').then(async (m) => {
    const fs = await import('node:fs');
    const url = fs.readFileSync('.env','utf8').match(/^DATABASE_URL=(.*)\$/m)[1].trim();
    const pool = m.createPool(url);
    await m.migrate(pool, 'db/migrations');
    await pool.end();
    console.log('migrations applied');
  });
\""
ok "schema up to date"

#-------------------------------------------------------------------------------------------
# systemd
#-------------------------------------------------------------------------------------------

say "Registering the service"
cat > /etc/systemd/system/dnc-bajaur.service <<UNITEOF
[Unit]
Description=District Nerve Center — Bajaur
After=network.target postgresql.service
Requires=postgresql.service

[Service]
Type=simple
User=$APP_USER
WorkingDirectory=$APP_DIR/app
ExecStart=/usr/bin/node dist/main.js
Restart=always
RestartSec=5
# The record is on this machine. A process that dies at 02:00 and does not come back is a
# district that cannot report an emergency (INV-01).
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNITEOF

systemctl daemon-reload
systemctl enable --now dnc-bajaur
ok "dnc-bajaur.service enabled and started"

#-------------------------------------------------------------------------------------------
# Caddy — two lines, and the certificate looks after itself
#-------------------------------------------------------------------------------------------

say "Configuring TLS for $DOMAIN"
cat > /etc/caddy/Caddyfile <<CADDYEOF
{
	email $EMAIL
}

$DOMAIN {
	# Compress text responses. Without this the origin sends every asset uncompressed and the
	# ~160 KB shell is re-downloaded in full on every dnc-shell-vNNN bump — on one bar of signal
	# in Mamund. gzip takes index.html + app.js from ~160 KB to ~43 KB on the wire; zstd a little
	# more. The match list is an explicit allow-list so the board's SSE stream (/board/live,
	# text/event-stream) is never buffered or encoded, and woff2/png are left alone.
	encode {
		zstd
		gzip
		match {
			header Content-Type text/html*
			header Content-Type text/css*
			header Content-Type text/javascript*
			header Content-Type application/javascript*
			header Content-Type application/json*
			header Content-Type application/manifest+json*
			header Content-Type image/svg+xml*
		}
	}

	reverse_proxy 127.0.0.1:3001

	# The application already logs one JSON line per request with a correlation id an operator
	# can quote (M0-03). This is the proxy's own view, in the same shape, so a bad night reads
	# as one format rather than two.
	log {
		output file /var/log/caddy/dnc-bajaur.log {
			roll_size 20MiB
			roll_keep 10
		}
	}
}
CADDYEOF

mkdir -p /var/log/caddy && chown caddy:caddy /var/log/caddy
systemctl reload caddy || systemctl restart caddy
ok "caddy configured"

#-------------------------------------------------------------------------------------------
# Firewall
#-------------------------------------------------------------------------------------------

say "Closing everything except 22, 80 and 443"
ufw --force reset >/dev/null
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow 22/tcp >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null
# Postgres is deliberately NOT opened. It listens on 127.0.0.1 and the application is the only
# thing that talks to it; a district's record reachable from the internet on 5432 is the kind
# of thing found by a scanner within the hour.
ok "postgres is not reachable from outside"

#-------------------------------------------------------------------------------------------
# Prove it, rather than announce it
#-------------------------------------------------------------------------------------------

say "Checking it actually works"
for i in $(seq 1 30); do
  if curl -fsS --max-time 5 "https://$DOMAIN/health" >/tmp/dnc-bajaur-health.json 2>/dev/null; then break; fi
  sleep 2
done

grep -q '"ok":true' /tmp/dnc-bajaur-health.json 2>/dev/null \
  || die "https://$DOMAIN/health did not answer. Look at:  journalctl -u dnc-bajaur -n 50  and  journalctl -u caddy -n 50"

ok "https://$DOMAIN/health answered"
cat /tmp/dnc-bajaur-health.json | head -c 400; echo

cat <<DONEEOF

  Running at  https://$DOMAIN

  Still to do, and none of it is code:
    1.  cd $APP_DIR/app && npm run dev:account 03001234567     — a sign-in
    2.  npm run setup:whatsapp                                 — R-05
    3.  the five S3_/BACKUP_ values in .env                    — R-06
    4.  npm run doctor                                         — says what is still missing

  Logs:      journalctl -u dnc-bajaur -f
  Restart:   systemctl restart dnc-bajaur

DONEEOF
