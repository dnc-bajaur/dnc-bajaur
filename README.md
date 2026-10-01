# District Nerve Center — Bajaur

A district-wide operational platform for emergency response and government coordination in
**Bajaur, Khyber Pakhtunkhwa**, run from the Deputy Commissioner's control room.

Any emergency reported in Bajaur must enter the system, reach the responsible officer over
WhatsApp, appear in the central view, be acknowledged under a server-enforced SLA, escalate if
it is not, and remain traceable through response to closure. There is one record, not two
copies being synchronised.

## Start here

| If you are | Read |
|---|---|
| An AI agent, or anyone about to change code | [`CLAUDE.md`](CLAUDE.md) — **the isolation rules at the top first** |
| Looking for what is next, or what is still needed | [`PLAN.md`](PLAN.md) |
| New to the design | [`docs/00-thesis.md`](docs/00-thesis.md) |
| Wondering why something is built the way it is | [`docs/adr/`](docs/adr/) |

## Running it

```
cd app
npm ci
npm run check      # typecheck + lint + format + tests
npm start
```

Copy `app/.env.example` to `app/.env` first. Never commit `.env`.

## Status

Code ready and cleaned for Bajaur; **not yet deployed**. See [`PLAN.md`](PLAN.md).
