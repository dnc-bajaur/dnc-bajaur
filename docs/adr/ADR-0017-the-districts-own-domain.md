# ADR-0017 — The district's own domain, over TLS, in front of the district's own machine

**Status:** Accepted
**Date:** 2026-08-06
**Reversal cost:** Low — a reverse proxy and a DNS record. Nothing in the application changes.
**Builds on:** [ADR-0011](ADR-0011-deployment-topology.md) (one record on district hardware),
[ADR-0002](ADR-0002-offline-first.md) (offline is the substrate).
**Source:** the district, via the project owner, 2026-08-06 — *"client chahta hai k ye webapp
ho, un k pas domain pehle sai hai"*.

---

## This closes a defect, and that was not why it was asked for

The product is already a web application. What the district asked for is that it live on **their
domain**, which sounds like packaging and is not.

**Service workers and geolocation only run in a secure context** — HTTPS, or `localhost`. The
installer's guide tells officers to open `http://<office-machine-IP>:3000` from their phones.
That address is neither. So on every real handset in Bajaur today:

- **the service worker never registers**, and the app does not open without a network — the
  single claim ADR-0002 exists to make
- **`navigator.geolocation` is refused**, so layered location capture silently falls back to
  whatever an operator types
- `navigator.clipboard` fails too, which `web/src/contact.ts` already has a fallback for —
  the one symptom that was noticed, treated locally, and never traced to its cause

None of this shows in the test suite, because Playwright drives `127.0.0.1`, and `127.0.0.1`
**is** a secure context by explicit exception in the specification. So the offline gate passes
against the one origin where the problem cannot occur.

That is the same shape as the `npm start` fault of 2026-08-04, where 338 tests passed against an
application that could not be launched: **the tests were right about the code and wrong about
the deployment.** TLS is not a hardening task here. It is the thing that makes the offline
substrate real on a device anybody actually holds.

## Decision

**The application is served over HTTPS on a name the district owns, by a reverse proxy in front
of the existing Node process, on the existing machine in the DC office.**

- **The record does not move.** ADR-0011 stands entirely: PostgreSQL stays on district hardware,
  the AC Headquarter standby stays the plan, the nightly encrypted copy stays off-site.
- **A reverse proxy terminates TLS** and forwards to the Node server on `127.0.0.1`. The
  application keeps speaking plain HTTP to the proxy and gains no certificate handling, no
  renewal logic, and no new failure mode of its own.
- **Certificates are obtained and renewed automatically** by that proxy (ACME / Let's Encrypt).
  A certificate somebody has to remember to renew expires on a Sunday.
- **The control room does not depend on the district's internet line.** It reaches the same
  application on the LAN. If the line drops, the control room keeps working and only *external*
  access is lost — which is exactly the trade ADR-0011 made and is the reason a rented database
  was rejected.
- **`X-Forwarded-For` becomes real, and `auth/throttle.ts` must be told.** Today the throttle
  reads the socket address and **deliberately ignores that header**, because a header the caller
  writes is a rate limiter an attacker opts out of. Behind a proxy every request appears to come
  from `127.0.0.1`, so **one officer's bad password would throttle the whole district.** The
  proxy's own address must be pinned and the header trusted only from it. This is named in
  ADR-0011's file as "the line to change, deliberately" and this is the change.

## Rationale

### Why not move it to a cloud server

Tempting, and it makes the domain trivially reachable. Rejected for ADR-0011's original reason,
which has not weakened: **the control room must not go down with the district's internet line.**
A cloud-hosted application means an operator in the DC office cannot record an emergency
happening two streets away because a fibre cut in another city took the line out. On-premise,
that operator keeps working and the record keeps growing.

### What that costs, stated plainly

When the district's line is down, **the acknowledge link in a WhatsApp message will not
resolve** on an officer's mobile data (ADR-0014), and no handset syncs. The message itself still
goes — it left through Meta, not through the DC office — so the officer is still told; what they
cannot do is tap the link until the line returns. The outbox holds their work meanwhile
(ADR-0002), which is what it was built for.

**This is the sharpest live consequence of ADR-0011 and it should be revisited if the district's
line proves worse than assumed.** The condition is in "How we would know this was wrong".

### Why a reverse proxy rather than TLS in the Node process

Node can terminate TLS. Doing so would put certificate loading, renewal and reload into the one
process that must never fail to accept an emergency report, to save installing one well-tested
piece of software. §7's question for a new dependency — *who restarts this when it fails, and
how do they know it failed?* — is answered better by a proxy that fails **in front of** the
application, visibly, than by a renewal bug that takes the application down at 02:00.

## Consequences

### We gain
- The offline shell and location capture start working on real handsets, which is a defect fix
  the district did not know they were asking for.
- One address that does not change when the office machine's IP does — the guide currently has a
  blank for an officer to write an IP into by hand.
- Passwords and session tokens stop crossing the district LAN in clear text. Worth saying out
  loud: they do today.

### We give up
- A second piece of software on the machine, and a DNS record somebody must not let lapse.
- The domain must resolve to the office. That needs either a static public IP with a forwarded
  port, or an outbound tunnel — see the setup steps.

### We must therefore also
- **Change `auth/throttle.ts` in the same release as the proxy, not after it.** Deployed in the
  wrong order, the first officer to mistype a password slows down sign-in for everybody.
- Keep the LAN address working. The control room's path must not route through the internet to
  reach a machine in the same room.
- Update `installer/guide/` — the phone sheet's hand-written IP blank becomes the domain.
- Re-run the offline gate **against the real origin**, not only `127.0.0.1`. The gate as it
  stands cannot see this class of fault and would not have caught it.

## Alternatives considered

**Leave it on HTTP over the LAN.** This is the status quo and it is what exposed the defect.
Rejected.

**A self-signed certificate.** Free, no domain needed — and every officer meets a browser
warning teaching them to click through security prompts, on the app that holds the district's
emergency record. Rejected for the same reason R-18 treats the unsigned installer as a real
cost.

**Cloud hosting.** Rejected above, with the condition for revisiting stated below.

## How we would know this was wrong

- **The district's line is down often enough that officers routinely cannot open the app on
  mobile data.** Then on-premise is costing more than it protects, and the honest move is a
  cloud primary with the DC office holding a standby — the inverse of ADR-0011, and a decision
  for the owner, not a drift.
- **Certificate renewal fails and nobody notices until the browser refuses.** Then automatic was
  not automatic, and renewal belongs on the dashboard's `condition` panel beside the backup.
- **The offline gate is re-run against the real origin and still passes on `127.0.0.1` only.**
  Then the test was moved rather than fixed.
