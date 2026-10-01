# Putting it on a server — ADR-0019

**The primary lives in the cloud now.** ADR-0019 moved it off the DC office machine, because the
control room is not in that building and the Deputy Commissioner needs the district's live data
in Peshawar with no laptop of their own.

**`installer/` is a different thing and the two must not be merged.** That builds `setup.exe`
for a **Windows** machine, and it is still how a field or office Windows install is done. This
directory is the **server**.

---

## The one command

```bash
# On a bare Ubuntu 24.04 server, as root:
mkdir -p /opt/dnc && cd /opt/dnc
git clone <the repository> .          # or scp the folder up
sudo ./installer/cloud/setup.sh dnc.example.com admin@example.com
```

It installs PostgreSQL 17, Node 22 and Caddy; creates the database and a service user; builds
the application; runs the migrations; registers a systemd unit; obtains a TLS certificate that
renews itself; closes every port except 22, 80 and 443 — and then **asks `/health` over the
public domain and fails if the answer is wrong.**

That last part is the point. Announcing success is not the same as having succeeded, which this
project has now been bitten by twice: `npm start` was broken for a day while 338 tests passed,
and the application could not boot in production at all while every test was green.

---

## Before you run it

**The DNS record has to exist first.** Caddy proves it owns the name by answering a challenge on
this machine over HTTP, so a name pointing somewhere else fails with an error about ACME rather
than about DNS. The script checks and refuses.

```
Type: A     Name: dnc     Value: <the server's IP>     TTL: 300
```

**If Cloudflare is proxying the record (orange cloud), the check will warn** that the resolved
address is not this machine. That is expected and it continues — but see the note below on why
the grey cloud is preferred.

---

## Three rules it follows, which are what make it safe to re-run

1. **It refuses rather than guesses.** No domain, no email, not Ubuntu, not root — it stops and
   says which one. A half-configured server that reports success is how somebody finds out at
   02:00 that TLS was never set up.

2. **It never overwrites an existing `.env`.** That file *is* the secret store on this
   deployment (ADR-0007). Re-running on a live server must not replace the district's WhatsApp
   token with a blank.

3. **It proves what it did**, over the real domain, from outside.

---

## What it deliberately does not do

- **It does not open PostgreSQL to the internet.** It listens on `127.0.0.1` and the application
  is the only thing that talks to it. A district's record reachable on 5432 is found by a
  scanner within the hour.
- **It does not fill in WhatsApp or the backup bucket.** Those are R-05 and R-06, they are
  secrets, and `npm run setup:whatsapp` exists because it writes them, restarts, and then
  *proves* they work.
- **It does not create a sign-in.** `npm run dev:account` does, deliberately as a separate act.

---

## Cloudflare: DNS yes, proxy no

The district's DNS is on Cloudflare, and that is useful — one account holds the DNS, the tunnel
and the R2 backup bucket.

**Leave the proxy off (grey cloud).** With it on, Cloudflare terminates TLS and can read the
district's emergency traffic — a decision worth making deliberately rather than by default — and
it complicates Caddy's certificate, which then needs a DNS challenge or origin certificates.
ADR-0007 asks for boring. At this volume there is nothing to protect against that the proxy buys.

---

## Moving from a local machine to this server

The application holds no state of its own. Everything machine-specific is in `.env`, so a move
is a dump, a restore and a DNS change.

```bash
# On the machine it is leaving:
cd app && npm run backup            # a verified dump; see ops/backup.ts

# On the server, after setup.sh has run:
systemctl stop dnc
sudo -u postgres psql -v ON_ERROR_STOP=1 -d dnc -f /path/to/dump.sql
systemctl start dnc
```

**`ON_ERROR_STOP=1` is not optional.** Without it `psql` reports success after replaying a dump
that half-failed — which is the difference between a restore and the belief that you have one
(`ops/restore.ts` has the same rule and the same reason).

Then check `npm run doctor`, and confirm the event count matches what left.
