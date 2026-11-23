# Fixtures: real ExampleApp S4 history

Admission evidence for the hard gates (REQUIREMENTS item 11) and calibration data for the screening alarms. Every file
here was read from a real record on 2026-11-20; nothing is synthetic unless a test says so.

| File | Source | Labels |
|---|---|---|
| `s4-check-runs.json` | `gh api` on `example/app`: the last 100 workflow runs (67 commits) and each commit's check runs; plus `9fc7a06`, which never ran alone | `workflow` = the workflow run's own conclusion (an independent source from the check runs the gate reads): 54 success, 13 failure, 1 none. Red includes the four consecutive S4 pushes `7da50ab`, `c6dff19`, `6506fa8`, `c7d752c` whose Linux `verify` failed while actor and judge reported green |
| `s4-trajectory.tsv` | judge rulings 24–30 of the S4 loop (`example-loop` baseline `s4/judge/judge-round-N.md`: first line, the SHA ruled on), CI from `s4-check-runs.json` | areas and blocker classes assigned by hand: `keyfile` / `keyfile-migration` for rounds 27–30 from the rulings' BLOCKER headings and lesson L-0001; round 26's two blockers get distinct placeholder classes; rounds 24–25 are unlabelled (`-`) |
| `s4-access-sizes.json` | `git show <sha>:src/access.js \| wc -l` in the S4 worktree | — (the module grew 128 → 809 lines over five rounds of one problem, then 130 after the subtraction `cd26bb3`) |
| `s4-judge-28-paragraph.md` | line 11 of `judge-round-28.md` | cites `…/judge/wt/src/access.js:148` in a worktree that moved: line 148 was `const copy = statSync(temporary);` at `7da50ab`, unrelated text at `c7d752c`, and past the end of the 130-line file at `0322425` |
| `l-0001.md` | `lessons/L-0001.md` of `example-loop` at `b2ca438`, frozen so no test reads the live directory | cites "lead ruling T", a ruling that never reached the durable repository (the dangling-ID screening sample) |
| `backtest-tool-events.json` | the four runs of `example-loop` `backtests/2026-11-20-frame-roles/runs/*/logs/*.jsonl` at `b2ca438`: tool_use parts, tool_result errors and Codex command completions only | each run's own `audit.json` had 0 violations (the access audit's legitimate green) |
| `v0.2-red/` | the review cases of `self-loop-v0.2.md` (and `-v0.1.md`) that still apply to v0.3, plus the L-0002 alarm, run by `probes.mjs.txt` against the skill at `a4db050` on 2026-11-20 (`v0.2-red/README.md`) | every value in `probes.log` is a result the review ruled wrong, except `ci-reruns.failedRerunOk`, already right on a4db050; each regression test reads its case with `redOn` |
| `v0.1-post-report-test.log` | the v0.1 reviewer's own run of the suite at `a8d6043` after a new file appeared in example-loop (38 pass, 2 fail) | the red half of "no test reads the live example-loop directory"; the other v0.1 red logs went with the orchestrator they tested (`v0.1-red/` at `a4db050`) |
| `example-loop-files.txt` | `git ls-files` of the `example-loop` records repository at `b2ca438` | every path above `# baseline sample` is a legitimate managed record; below it, every 100th of the 18,315 paths of `baseline-2026-11-20/`, the unmanaged rescue copy that RECORDS says the managed layout replaces |
| `v1-rulings/` | this loop's records at 149fd8c2: `rounds/0001-judge.md` to `rounds/0006-judge.md` verbatim and `metrics/trajectory.jsonl` (rounds 1 to 6) | every opened key of the six judge rows (16 keys in 5 rows) is named by its round's judge record: the legitimate green of the opened-key refusal (D-0026 item 2, DEBT row 34). The ledger also carries the real recurrence history: `tip-ci-evidence:R1-5` closed in round 3 and opened again in round 4, and two distinct blockers of one class in round 6 (`suite-evidence`, `comment-admission`) |
| `suite-green/` | `node scripts/suite-green.mjs --repo <this skill> --sha <c> --command "node --test scripts/test" --format node-test --out …` run on 2026-11-20 for c7e7c50, a4db050 and 4748705: receipt (`.json`) and full output (`.log.gz`, digest in the receipt) | c7e7c50 red: the lead committed it with 2 failing tests (68/2, the two owner-budget tests); a4db050 (70/0) and 4748705 (61/0) green |

`d0002-claude.jsonl` keeps the relevant user and assistant tool-call rows of Claude session
`6f5ed2d7-9d3f-40ab-9936-beabfc5ac7ce`. Notice bodies, the hand-off summary and tool arguments unrelated to speaker
identity were removed. `d0002-words.json` contains the 20 owner messages identified in the review, verbatim.

`s4-history.json` projects the historical Git graph onto the commits needed by the S4 CLI tests. It retains their real
SHAs, relevant ancestry and refs, and the exact lines matching `lsof` in `src/access.js`. The replay uses new Git
objects and maps CI samples from the source SHAs to those objects so the gate still has to query the exact replay SHA.

The D-0007 guard replay in `d0007-lead-guard-replay.json` keeps one entry per recorded invocation
from the November 19–21 Claude sessions identified by the review. It keeps the here-document operators,
delimiters, push command fragments and text-only mentions. Unrelated lines were cut, bodies without a
text-only mention were elided and local paths were replaced. The 15 rows cover 11 pushes to real remotes,
one push to a scratch remote and three text-only mentions. Tests pass the strings to the guard without
running them.
