# edtech-billing-core

[![CI](https://github.com/alt-f6/edtech-billing-core/actions/workflows/ci.yml/badge.svg)](https://github.com/alt-f6/edtech-billing-core/actions/workflows/ci.yml)

The money-handling core of an EdTech platform: lesson billing that stays exact when several people click at once, a payment webhook that trusts nothing it is sent, and a login that doesn't reveal who has an account.

I built and run the production platform this comes from (CRM + LMS + payments for an online school, 300+ active students a month). Its code is private, so this repository is a standalone extraction of the parts worth reviewing, rewritten as a small framework-free TypeScript library on plain PostgreSQL. Where this version deliberately differs from production, the [last section](#differences-from-production) says how and why.

```bash
docker compose up -d --wait && cp .env.example .env && npm ci && npm test
```

## What's inside

| Module | The problem | The design |
|---|---|---|
| [`billing`](src/billing/billing.service.ts) | Staff mark, re-mark, clear and cancel lessons concurrently; the student must be charged exactly once, and the ledger must always agree with the attendance journal | **Append-only ledger** (a trigger rejects `UPDATE`/`DELETE`): corrections are reversal rows. Writes for one student are ordered by a `FOR NO KEY UPDATE` lock on the student; cancellations exclude marks via `FOR SHARE` / `FOR UPDATE` on the lesson. One lock order everywhere, so no deadlocks and no lost races to retry |
| [`payments`](src/payments/webhook.handler.ts) | A webhook can be forged, replayed, tampered with, or delivered ten times at once | Rate limit → constant-time secret check (mandatory in live mode) → provider IP allowlist → **re-fetch the payment from the provider's API** and validate the response at runtime → check owner, amount and currency against our own payment intent → credit with `ON CONFLICT DO NOTHING` on the provider's payment id |
| [`auth`](src/auth/login-rate-limit.ts) | Response time leaks which emails are registered; per-IP limits are bypassed by spoofing `X-Forwarded-For`; check-then-increment limiters let bursts through | Unknown emails still cost one bcrypt compare. Limits per (IP, email) and per email across IPs, checked and counted atomically under a per-email advisory lock, on normalized emails, with IPs stored only as keyed hashes (HMAC) |
| [`rate-limit`](src/rate-limit/rate-limit.ts) | An in-memory limiter resets on deploy and isn't shared between instances | One atomic `INSERT … ON CONFLICT DO UPDATE` per hit, in Postgres |
| [`money`](src/money.ts) | `Number("0.29") * 100` is `28.999…` | Kopecks as safe integers throughout; provider amounts parsed from the decimal string, never through a float; the DB driver refuses `BIGINT`s beyond 2^53 |

## Locking

Every billing write takes its locks in the same order:

| Operation | 1. student row | 2. lesson row |
|---|---|---|
| mark, clear | `FOR NO KEY UPDATE` | `FOR SHARE` |
| cancel | (only `KEY SHARE`, via foreign-key checks) | `FOR UPDATE` |

- Two writes for the same student run one after the other; each re-reads the committed state after its lock wait, so plain `READ COMMITTED` is enough.
- Marks on the same lesson coexist; a cancellation waits for in-flight marks and they wait for it. So "is this lesson cancelled?" can't change between the check and the write.
- `NO KEY UPDATE` rather than `UPDATE` on the student is what keeps this deadlock-free: a cancellation writing a reversal for a student needs a `KEY SHARE` lock on that student, which `NO KEY UPDATE` allows and `FOR UPDATE` would block.

## How it's tested

104 tests, all against a real PostgreSQL; no database mocks, because the guarantees live in locks, constraints and triggers.

- **Deterministic interleavings.** A test pauses one operation right after it has taken its locks, starts a competing one, and asserts it waits. There is one such test per lock, plus one for the deadlock case above.
- **Bursts.** 20 simultaneous marks of one lesson, 10 lessons for one student at once, 10 students on one lesson, conflicting PRESENT/EXCUSED marks: every call succeeds and the ledger comes out exact. 10 identical webhook deliveries credit once. 50 parallel login guesses get exactly 5 tries. 100 parallel hits on a limit of 10 let exactly 10 through.
- **Webhook attacks.** Missing or wrong secret, right secret from a wrong IP, inflated amount in the body, "succeeded" for a payment the provider says is pending, wrong currency, zero amount, amount different from the intent, metadata naming a different student, malformed provider response, provider outage with redelivery.
- **Randomized ledger invariants.** [`invariants.test.ts`](tests/invariants.test.ts) runs 200 random operations per seed (marks, clears, cancellations, payments and redelivered payments, five at a time in parallel) and checks eight ledger invariants after every batch (one student is on a billing freeze, so the frozen path runs too), plus that the ledger never shrinks. The only refusal it accepts is touching an already-cancelled lesson. Seeded, so a failure replays exactly.

**Mutation-checked.** [`npm run mutants`](scripts/mutants.ts) removes each defence in turn in a throwaway copy and runs the suite: either lock, `FOR UPDATE` instead of `FOR NO KEY UPDATE`, the cancelled-lesson guard, the price snapshot, the payment idempotency key, the payment id, amount and zero-amount checks, the dummy bcrypt compare, the login lock, email normalization. All 12 mutants are killed.

### A bug the invariant test caught

The first run of the randomized test failed on *"a cancelled lesson nets to zero for every student"*. The sequence: a student is charged, the lesson is cancelled (the charge is reversed), then the attendance mark is cleared, which reversed the charge a second time. The student was credited for a lesson they were never charged for.

The fix: clearing refuses a cancelled lesson, and the check runs under the lesson's share lock, so a cancellation committing at the same moment can't slip between check and write. Both the plain case and the race are now tests; the race test fails if the share lock is removed.

## Layout

```
src/
  billing/billing.service.ts   mark / clear / cancel / balance on an append-only ledger
  payments/webhook.handler.ts  verification pipeline + idempotent credit
  payments/provider.ts         provider interface, runtime response validation, REST client
  payments/webhook-auth.ts     constant-time secret, provider IP ranges (node:net BlockList)
  auth/password.ts             enumeration-safe password check
  auth/login-rate-limit.ts     atomic login limits + the login flow
  rate-limit/rate-limit.ts     atomic Postgres rate limiter
  db.ts                        pool, transaction helper
migrations/001_init.sql        schema, CHECK constraints, append-only trigger
tests/                         104 integration tests
scripts/mutants.ts             mutation check: npm run mutants
```

## Differences from production

The production system runs on Next.js with Prisma. This extraction uses `pg` with plain SQL, so every lock and constraint is visible on the page, and leaves out notifications, fiscal receipts and the UI.

Two parts were redesigned here after review, and the reasons apply back to production:

- **Locking.** Production wraps billing in `SERIALIZABLE` transactions *and* takes `SELECT … FOR UPDATE` on the student. The first version of this extraction copied that design, and an ad-hoc concurrency probe during code review showed the cost: roughly 9 in 10 concurrent writes aborted with serialization failures, and `FOR UPDATE` deadlocked against a cancellation's foreign-key checks. This version uses one explicit lock order under `READ COMMITTED` instead, and every concurrent call in the burst tests succeeds.
- **Ledger history.** Production deletes and rewrites a lesson's charge when attendance changes. Here the ledger is append-only and enforced by the database, so every balance can be explained row by row.

## Running it

Requires Node 20.12+ and Docker.

```bash
docker compose up -d --wait   # Postgres 16 on localhost:54329
cp .env.example .env
npm ci
npm run typecheck
npm test                      # rebuilds the schema of the *_test database on each run
npm run mutants               # optional: confirms every defence is covered by a test (~2 min)
```

## License

MIT
