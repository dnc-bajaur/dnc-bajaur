# ADR-0019 — The record moves to the cloud, because the control room left the building

**Status:** Accepted
**Date:** 2026-08-07
**Reversal cost:** Medium — the application does not change, but the district's data would have
to be moved back and a machine found to hold it. See *Consequences*.
**Supersedes:** [ADR-0011](ADR-0011-deployment-topology.md) §1, §2 and §3 — the primary no
longer runs on district hardware, and there is no AC Headquarter standby. **§4 stands and
matters more than before:** off-site copies, nightly.
**Amends:** [ADR-0017](ADR-0017-the-districts-own-domain.md) — the district's own domain still
fronts the application over TLS. What it points at is no longer a machine in the DC office.
**Source:** the project owner, 2026-08-06/07, relaying the client.

---

## Context

ADR-0011 put PostgreSQL on a machine in the DC office. It was the right decision on 2 August
and it was argued carefully, so it is worth being precise about **what changed** rather than
simply reversing it.

### What the client asked for

> *"Client keh raha hai ke ye software webapp ki tarah use ho jaye — jahan se marzi login
> details daal diye jayen aur DC access kar sake."*

…pointing at `ipms.kpdata.gov.pk` as the shape they have in mind.

**That request on its own would not have moved anything.** ADR-0011 §3 already required the
server to be reachable from the public internet, and ADR-0017 already put the district's domain
and a TLS certificate in front of it. A district officer logging in from anywhere was a DNS
record away, not an architecture away. It was answered that way, and then two facts arrived that
had not been on the table.

### The two facts that actually moved this

**1. The control room is not in the DC office.**

> *"Control room wala hamesha DC office mein nahi hoga, wo to apne control mein hoga jahan se ye
> sab manage kar raha hoga. DC ko to sirf bana banaya dashboard hi dekhna hai."*

ADR-0011's central argument was that **the server and the control room share a building**, so an
internet outage cost the district its field reports while the control room kept working on the
LAN. If the control room is somewhere else, that argument describes a building with nobody in it.

**2. The DC needs the district in their hand, not on a desk.**

> *"Kal ko agar DC Bajaur se Peshawar aa jaye aur CM ke sath meeting mein apne district ka live
> data dikhana chahe, magar laptop apna nahi hai to kya karega?"*

A concrete, ordinary requirement that a machine under a desk in Bajaur cannot meet.

### And one argument that had already expired without being noticed

ADR-0011 was written on **2 August**, when the model was that **every department would use the
app**. "Keep the whole district working on the local network during an outage" was a strong
claim then.

**ADR-0018 removed that audience on 6 August.** There is one user. The LAN argument had already
collapsed and nobody went back to this decision — the same failure this project has now recorded
four times in a week, where a document outlives the decision it was written under.

### An overstatement, corrected by the owner

While arguing for the status quo it was claimed that cloud hosting would reduce the control room
to *"a notepad"* during an outage. The owner did not accept it:

> *"Internet na ho to waise bhi kisi bhi surat mein kisi ko inform nahi kar payenge na?"*

**Correct, and the claim was inflated.** WhatsApp Cloud API needs internet wherever the database
lives. What local hosting actually buys during the district's own outage is narrower:

| During the district's own internet outage | Server in the district | Server in the cloud |
|---|---|---|
| Capture a new report | yes (outbox) | yes (outbox) |
| **Tell anybody** | **no** | **no** |
| Read the board — who was told, who answered | **yes** | no |

One row, not the whole product. The decision below is made knowing exactly what is being given
up.

---

## Decision

### 1. The primary runs in the cloud

One PostgreSQL, one application process, reachable at the district's own domain over TLS. The
control room, the Deputy Commissioner and anybody else the district authorises reach it the same
way, from anywhere, on any device.

**Hosting provider is deliberately not fixed by this ADR.** The application is an ordinary Node
process against an ordinary PostgreSQL and runs the same on any of them, so the choice is an
operational one the district can revisit without another architecture decision. The two
candidates and the honest state of each:

- **KPITB / `kpdata.gov.pk`** — where IPMS itself is hosted. The right long-term home: the data
  stays in government hands and no question of residency arises. **Requires a formal request
  from the DC office**, and the process is not known to this project — it is a row on
  `backlog/for-the-district.md`, not an assumption.
- **A commercial VM** — available today. A single small instance (1 vCPU, 1–2 GB) is enough.

**Cloudflare cannot host this application**, and it is written down here because it was proposed:
R2 is object storage, Workers cannot run this process, D1 is SQLite and Hyperdrive is a pooler in
front of a Postgres that has to exist somewhere else. ADR-0011 already said so. **Cloudflare does
have a real role** — DNS in front, and R2 as the off-site backup target below.

**Free tiers are a trap for this particular payload, and one of them is a data-loss event.**
Render's free PostgreSQL is deleted after 90 days. A district's emergency record is not a
workload to run on something that expires. Oracle's free tier is a genuine always-on VM and is
the only free option this project will recommend; otherwise the cost of being certain is a few
dollars a month, which is the cheapest line item in this entire system.

### 2. Still one record. This does not change and cannot

ADR-0011's sharpest paragraph survives intact: **two databases accepting writes produce two
divergent histories of one district**, both append-only, both correct by their own lights, with
no principled way to merge them and no answer to *"what happened in Bajaur on Tuesday"*.

The owner's phrasing when this began — *"ek laptop par save hoga aur ek online"* — describes
exactly that, and it is refused. One primary. Everything else is a **copy**, never a second
place to write.

### 3. The AC Headquarter standby is dropped

It existed to cover *the DC office machine dies*. There is no DC office machine. The failure it
guarded against has been replaced by the provider's own redundancy, and running a standby in an
office for a database that is not in that office would be a second thing to maintain for nothing.

**If hosting later moves to KPITB, this is worth reopening** — a government data centre may make a
second region trivial.

### 4. Off-site backups stay nightly, and now matter more

ADR-0011 §4 is unchanged and is **the** safety net now that the record is not on district
premises. Nightly, verified, encrypted, and to storage **that is not the same provider as the
primary** — a backup inside the account that holds the database is not an off-site backup, it is
a second copy of the same blast radius.

R2 is a good target: cheap, S3-compatible, and a different failure domain from any VM provider.

### 5. Offline capture on handsets is untouched

ADR-0002 lives on the officer's phone, not on the server. A report captured with no signal is
still durable on the device and still delivers itself when a network appears. **INV-01 is
unaffected by this decision**, and `spine.e2e.test.ts` still proves it.

---

## Consequences

**Good**

- The client's actual requirement is met: a webapp, from anywhere, on any device.
- The control room is free to be wherever the operator is.
- No laptop to guard, no UPS, no Windows update at 03:00, no dynamic IP, no port forwarding, no
  CGNAT, no certificate anybody has to remember.
- Uptime becomes somebody's profession rather than somebody's favour.

**Bad, and accepted knowingly**

- **During the district's own internet outage the control room cannot read the board.** They can
  still capture reports, and they could not have sent anything either way. This is the one row
  given up, and it is the price of the four benefits above.
- **The district's emergency record leaves district premises.** Under KPITB it stays inside
  government; on a commercial provider it does not, and the district should decide that
  deliberately rather than by default.
- The record's safety is now a **backup discipline** rather than a building. §4 stops being
  prudent and starts being load-bearing.

**What has to change in the software — none of it structural**

- `TRUSTED_PROXIES` must be set, together with the proxy, exactly as `installer/proxy/` already
  requires. Behind a load balancer every request looks like `127.0.0.1` and one officer mistyping
  a password would throttle the district (ADR-0011's own warning, now unavoidable rather than
  optional).
- `PUBLIC_ORIGIN` must be the district's domain, so acknowledge links in WhatsApp resolve.
- Evidence files need a persistent volume, or to move to object storage. They are on local disk
  today (M1-05).
- The off-site backup path is written for Google Cloud Storage; an S3-compatible target is a
  small change to the same, already-tested code.
- **Nothing about the domain model, the event log, the authority table or the client changes.**

**Open**

- Which host (KPITB or commercial) — `for-the-district.md`.
- Whether the district accepts a commercial provider holding the record while KPITB is pending.
