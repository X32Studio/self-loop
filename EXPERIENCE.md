# Self-loop · Engineering Experience & Technical Option Blacklist

Living, actionable blacklist of proven low-level anti-patterns and their mandatory superior primitives (`P-0019`, `F-0017`). Companion to [`SKILL.md`](SKILL.md), [`GLOSSARY.md`](GLOSSARY.md), [`REQUIREMENTS.md`](REQUIREMENTS.md), and [`DEBT.md`](DEBT.md).

## Technical Option Blacklist

| ID | Forbidden Naive Option | Mandatory Better Option | Why (Observed Failure Mode) | Enforcement Rung |
|---|---|---|---|---|
| `TB-01` | Calling `git merge-base --is-ancestor` or `git rev-list --min-parents=2` inside loops | Shared bounded in-memory commit DAG (`scripts/lib/dag.mjs`: `isAncestorFast`, `firstMergeBetweenFast`, `hasCommitFast` with `--no-replace-objects` + unreachable fallback) | `O(N)` subprocess storm causing multi-minute hangs | Rung 1 (Construction: `dag.mjs`) + Rung 4 (Review) |
| `TB-02` | Calling `git show <rev>:<path>` per file inside loops | Chunked `git cat-file --batch` (`blobs()` in `scripts/lib/git-plumbing.mjs` / `plan.mjs:snapshot`) | 10,000+ spawns (~100s) on multi-round ledgers | Rung 1 (Construction: `blobs()`) + Rung 4 (Review) |
| `TB-03` | Calling `git log --diff-filter=A -- <path>` per file inside loops | Single cached repo-wide `git log --reverse --no-renames --format=%x00%cI --name-only --diff-filter=A <rev>` pass (`scripts/lib/plan-measures.mjs:firstPublication`) | `O(F * C)` history scans across ledger files | Rung 1 (Construction: `firstPublication`) + Rung 4 (Review) |
| `TB-04` | Calling subprocess-spawning error formatters (e.g. `shownTree` / `receiptProblem`) inside boolean `.find()`/`.filter()` predicates | Split pure zero-spawn boolean predicate (`receiptMatches`) from diagnostic formatter (`receiptProblem`) | Hundreds of wasted `git rev-parse` spawns per check | Rung 1 (Construction: `receiptMatches`) + Rung 4 (Review) |
| `TB-05` | CJS `index.js` barrel shims in test dirs or bare `node --test <dir>` on Node 24 | Delete barrel shims; use explicit `*.test.mjs` globs or `suite-green.mjs --relay` committed-tree discovery | Forces single-core serial CI (18m+) and `MODULE_NOT_FOUND` on Node 24 | Rung 1 (Construction: `--relay`) + Rung 2 (CI workflow) |
| `TB-06` | Spawning Git in tests/CI without disabling background maintenance | Merge `gc.auto=0` & `maintenance.auto=false` via `withGitNoMaintenance()` / `GIT_CONFIG_COUNT` | macOS `.git/objects/maintenance.lock` race failures | Rung 1 (Construction: `withGitNoMaintenance`) + Rung 2 (macOS CI) |
| `TB-07` | Storing cross-run caches in ephemeral `RUNNER_TEMP`/`/tmp` or comparing un-canonicalized `tmpdir()` paths | Persist cross-run caches under `${HOME:-/tmp}/.self-loop/...` and wrap temp paths with `realpathSync()` | Wiped CI relay caches; macOS `/var` vs `/private/var` mismatches | Rung 1 (Construction: `path-canonical.mjs`, `suite-relay.mjs`) + Rung 2 (macOS CI) |
| `TB-08` | Re-running full suites from scratch on 1-file failure or swallowing failing stderr in gate wrappers | Content-addressed per-file `--relay` checkpoints + stderr failure excerpt while keeping stdout pure JSON | Wasted compute and blind CI failures | Rung 1 (Construction: `suite-relay.mjs`) + Rung 2 (Gate JSON/stderr contract) |
| `TB-09` | Unconditional Linux `/proc` assertions in cross-platform suites (or silent `() => {}` empty files) | Gate with `{ skip: !linuxIdentity }` so cross-platform suites report `tests >= 1, fail === 0` | Spurious macOS failures or broken checkpoint verification | Rung 2 (Dual-platform CI & relay verifier) + Rung 4 (Review) |
| `TB-10` | Hardcoded per-file line-count assertions in unit tests, round-numbered/`-attack` test filenames, or unlinked prose comments | Black-box domain-named `< 500`L seam tests and `D-0016` pointer-only comments | Brittle test churn and context rot | Rung 2 (`lib/comments.mjs`, `records-check.mjs`) + Rung 4 (Dual-Axis Critic) |

## Maintenance Rule

- **Actors**: check `EXPERIENCE.md` before coding and never introduce a blacklisted `TB-*` option; use the mandatory better primitive (or build one reusable primitive once).
- **Critics**: explicitly reject any diff introducing a `TB-*` pattern under Axis 2 (Standards, Subtraction & Zeroing) and sweep horizontally for sibling occurrences (`D-0067`).
- **Frame Reviewers**: prohibit applicable `TB-*` options in frame specs and append new entries whenever a recurring low-level failure or performance cliff is diagnosed (`P-0019`), climbing the Enforcement Ladder toward construction and mechanical hard gates.
- **Public Hygiene (`D-0069`)**: keep every entry concise, generic, and secret-free (zero private paths, usernames, or private repo/product names); remove an entry only when made impossible by construction.
