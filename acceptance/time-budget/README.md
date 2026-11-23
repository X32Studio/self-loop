# Independent time-budget acceptance

Contract: `self-loop-records@bd8a1ad:evidence/0012/admitted-time-budget/contracts.json`, amended by the external design ruling at `b6bd6a4`. See `cases.json` for every archived abstract scenario and TB-ADD-01..08, including explicit gaps.

Run from product root with Node 24.21.0, after measuring load1 <= 14 and available memory >= 16 GiB:

```
node --test --test-reporter=tap --test-concurrency=1 acceptance/time-budget/*.test.mjs
```

`fixture.mjs` creates independent temporary Git repositories under this directory and removes them after each test. No product copy, provider calls, network fetch, real time waits, full suite, or real owner records are used. Git commits and branch-independent objects belong only to these fixture repositories. Production modules and CLI files are imported/run directly. Clock values are synthetic and supplied only to read-only time projection. The continuation tests run actual capture/reconcile against a temporary registry with exact synthetic public terminal receipts; this proves compatibility of the real continuation implementation, not provider transport or application acknowledgement.

`product.test.mjs` checks model + pinned reader + process-restarted measure + next/start. `continuation.test.mjs` checks stable execution binding, terminal variants, genuine supersession, idempotence and uncertain claims. Caller-injected forged current status and wrongly keyed historical snapshots are bounded mutation sensitivity controls, not mutations of production source. Corrupt history is tested only after a valid positive fixture; an implementation returning unknown for everything fails positive ETA controls.

No claim that every positive delivery case passes: trusted release criteria/candidate/gate/availability/event-time evidence has no complete admitted matcher yet. Consequently usable on-time/late delivery and trusted checkpoint repair remain explicit gaps; the negative handoff-only check does not fill them. TB-ADD-08 remains a coordinator candidate-review/full-suite/CI dependency, not a second scheduler inside these tests.
