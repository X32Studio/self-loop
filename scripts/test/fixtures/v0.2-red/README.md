# Red evidence on a4db050

The review cases of example-loop `reviews/self-loop-v0.2.md` (and `-v0.1.md`) that still apply to what v0.3 keeps,
plus the L-0002 alarm, run against the skill at `a4db050` on 2026-11-20. `probes.mjs.txt` is the script; each line of
`probes.log` is one case, `<case> <json>`, and every value there is the old result the review ruled wrong, except
`ci-reruns.failedRerunOk: false`, which a4db050 already got right (kept as the green half of that case).

To re-run: `git archive a4db050 | tar -x -C <dir>`, copy `probes.mjs.txt` to `probes.mjs` outside that tree, and run
`SK=<dir> node probes.mjs`. Each regression test (`call.test.mjs`, `audit-access.test.mjs`, `ci-gate.test.mjs`,
`decisions.test.mjs`, `trajectory.test.mjs`) reads its case's line with `redOn(<case>)`, asserts the old result, and
then asserts the v0.3 behaviour of the same case.
