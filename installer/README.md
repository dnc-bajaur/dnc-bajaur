# The release

Everything needed to turn this repository into the one file the district receives: a Windows
`setup.exe` that installs the District Nerve Center on an office machine, and the ZIP that goes
around it.

```
.\installer\build-installer.ps1
```

That is the whole procedure, and it is the **only** supported one. It builds the application
from source, stages the payload, compiles the installer and packages the ZIP into
`installer/out/`. Do not open `setup.iss` in the Inno Setup IDE and press Compile — the payload
it points at is staged by that script, and a hand-compile silently ships whatever happened to be
in `stage/` from last time.

## What is in the box

The district is not expected to install anything first, so the installer carries it:

| | |
|---|---|
| The application | Compiled server, the production client bundle, the migrations |
| Node.js | `node.exe` only, the one binary needed to run the compiled server |
| PostgreSQL 17 | The server, pruned — see below |
| The district's contact list | `app/db/seed/directory.json`, if it is present in the working tree |

**pgAdmin is deliberately not included.** An unpacked PostgreSQL distribution is around 850 MB
and roughly 670 MB of that is a graphical database editor. Shipping it would put a second way
into the district's record on the same machine — one that goes around every authority check the
application makes (INV-05), with the password sitting in `.env` beside it. It is dropped because
it should not be there, not because of its size. `doc`, `include`, `StackBuilder` and
`share/locale` go for ordinary reasons.

## Prerequisites for building

| | |
|---|---|
| Inno Setup 6 | `winget install JRSoftware.InnoSetup` |
| Node 22+ | The version bundled is whichever `node` is on PATH, and the script refuses anything older |
| PostgreSQL 17, unpacked | Defaults to the portable cluster `scripts/dev-db.ps1` uses, so a development machine needs no arguments |

`-PostgresDir`, `-NodeExe`, `-Version` and `-SkipBuild` are there when the defaults are wrong.

**ffmpeg** (Activities videos, ADR-0039 §4) is bundled by default from any unpacked build under
`-FfmpegDir` (default `D:\dnc-bajaur-ffmpeg`): only `ffmpeg.exe`, `ffprobe.exe` and their GPL
licence, installed to `{app}\ffmpeg` and written into `.env` as `FFMPEG_PATH`/`FFPROBE_PATH`.
About 210 MB on disk. `-NoFfmpeg` builds without it; videos then wait, and the DC is told.
**`-SkipBuild` is for iterating on the installer itself**, not for cutting a release: it stages
whatever is in `app/dist` and `app/web/dist` already, which after a test run is a development
build. The script checks the staged bundle for minification and refuses rather than letting that
ship.

## What the installer does that copying files does not

`runtime/first-run.mjs` is where the real work is. Setup copies bytes; this turns them into a
district that can be signed into:

1. Creates the PostgreSQL cluster, on a port it picks by asking rather than assuming.
2. Creates the `dnc` role and database, and writes `app/.env`.
3. Applies the migrations.
4. Loads the district's 79 offices and 81 posts.
5. **Marks the two administrative offices**, and **re-derives every seat's tier**.
6. Creates the one account that can sign in.

Steps 5 and 6 exist because of ordering faults that no test in this repository can see, and both
are worth reading before changing anything here:

- **Migration 0007 marks the DC Office and AC Headquarter Bajaur as administration, and on a
  fresh install it matches nothing** — migrations run against an empty database and the
  departments are created minutes later by the directory load. Every office came out ordinary.
- **Migration 0010's trigger derives a seat's tier when the seat is written.** Every seat was
  written before the flag above was set, so the Deputy Commissioner's own post came out
  `department` tier — and `viewerFor` keys on tier, so the DC would have signed in and been
  shown their own office instead of the district.
- **A person who already holds a post keeps it.** The first version always created a
  `System Administrator` seat, which given the DC's own number made one person the current
  holder of two posts — and `resolveIdentity` selects a seat with no `ORDER BY`, so the
  authority returned was whichever row PostgreSQL felt like giving back.

Every test in the repository builds its departments before its seats, and none of them installs
twice. That ordering only occurs on a real installation, which is why all three arrived together
the first time one was performed.

## Runtime layout

```
C:\Program Files\District Nerve Center Bajaur\  the program
  app\        dist, web\dist, db\migrations, db\seed, node_modules, .env
  node\       node.exe
  pgsql\      the PostgreSQL server
  runtime\    dnc.ps1, first-run.mjs, open.vbs, register.ps1, app.ico

C:\ProgramData\District Nerve Center Bajaur\    the record — NOT removed on uninstall
  pgdata\     the cluster
  backups\    nightly dumps
  logs\
  install.json   ports and generated passwords
```

`runtime/dnc.ps1` is the only runtime entry point — `start`, `stop`, `status`, `open`. The
desktop icon runs `open`, which starts whatever is not running and then opens the browser: a
person clicking an icon at the start of a shift should not have to know what needed starting.

`register.ps1` adds a scheduled task that starts the system at boot under SYSTEM, so a power cut
at 03:00 brings it back with nobody signed in, and a firewall rule for the one port the
application listens on. Both report failure and neither is fatal — a district that cannot report
an emergency because a firewall rule failed would be this project's own rule about refusals
applied backwards.

## Silent installation

```
setup.exe /VERYSILENT /NAME="..." /PHONE="03001234567" /PASSWORD="..."
```

The one place a password is passed on a command line, and a deliberate exception. An interactive
install writes the three values into a file in a directory only administrators can write, which
`first-run.mjs` reads and deletes within seconds — a command line is visible to every process on
the machine and shows up in Task Manager. Whoever installs silently is choosing that trade for a
reason this installer cannot second-guess.

## What is not signed

`setup.exe` carries no Authenticode signature, so Windows SmartScreen shows "Windows protected
your PC" and the district has to click through it. Signing needs a code-signing certificate the
district does not have. It is named in the guide rather than left as a surprise.

## The district's own domain, over TLS

`proxy/` is a separate step, run once after the district has pointed a subdomain at this machine
(R-21 — a DNS record and an afternoon, since they already own the domain).

```
installer\proxy\install-proxy.ps1 -Domain dnc.bajaur.gkp.pk -Email ops@example.com
```

**It is not part of `setup.exe`, deliberately.** The application must install and work on the day
the district has no domain, no forwarded port and no certificate — a setup that failed at the
last step because DNS was not ready would leave a district with nothing rather than with a
working LAN install.

### Why it exists at all

Not hardening. **The product is served over plain HTTP and that is a live defect** (ADR-0017).
Service workers and geolocation only run in a secure context, so on every real handset in Bajaur
opened at `http://<office-IP>:3000` the service worker never registered, **the app did not open
without a network** — the single claim ADR-0002 exists to make — and location capture fell back
to typed guesses. `navigator.clipboard` failed for the same reason: the one symptom that was
noticed, patched where it appeared, and never traced.

Nothing in the test suite could see it, because Playwright drives `127.0.0.1`, which *is* a secure
context by explicit exception. `offlineLaunch.e2e.test.ts` §13 now covers the part that can be
tested — that the failure stops being silent — and the proxy is what actually fixes it.

### The three things that ship together

The script does all three in one run because the third one alone is an outage:

1. **Caddy answers** on the district's name (443, certificates obtained and renewed by itself)
   and on the LAN (3000, unchanged, so the office wall's written-up address keeps working).
2. **The application moves to `127.0.0.1:3001`** — `HOST` and `PORT` in `app/.env`. Loopback is a
   security boundary here rather than tidiness: if the process stayed reachable directly,
   somebody could bypass the proxy, and then `X-Forwarded-For` is a header the caller writes.
3. **`TRUSTED_PROXIES=127.0.0.1`** so `auth/throttle.ts` believes that header from the proxy and
   from nothing else. **Without it every request looks like `127.0.0.1`: the whole district shares
   one throttle key, and one officer mistyping a password slows sign-in for everybody**, at 02:00,
   with nothing on any screen saying so. ADR-0011's own file named this as "the line to change,
   deliberately".

`PUBLIC_ORIGIN` is set at the same time, because the WhatsApp acknowledge link is built from it
(M6-22) — an office IP there is a link that fails on every handset the message reaches.

### caddy.exe is not bundled

One file, no dependencies, from https://caddyserver.com/download — put it beside the script. A
web server is a thing the district should be able to update on its own schedule rather than
waiting for a release of this application, and bundling one would mean shipping a security fix
for somebody else's software inside `setup.exe`.

### What does not change

**The record does not move.** ADR-0011 stands in full: TLS is terminated in front of the same
Node process, on the same disk, in the DC office. The control room still reaches it on the LAN,
and the district's internet line going down still does not stop the control room working — which
is why the `:3000` block is in the Caddyfile and must stay there (M6-41).
