---
name: self-loop
description: Take a software project to completion with as little owner attention as possible - a frame reviewer that designs from purpose, trajectory, facts and first principles at every phase start and diagnoses supervision alarms (premise test, CONTINUE or REFRAME); an adversarial hardening engine (critic writes executable acceptance cases, actor builds the general solution, a judge of another vendor rules each case and fix, and a round closes only on green remote CI for its exact commit); managed loop records; gates ranked from construction to prose; owner decisions in small batches with recommendations. Successor of adversarial-design. Use when the user says "self-loop", "自循环设计开发", "take this project to completion", "run the loop on this phase", "reduce my attention", "harden and build", "design and build this with critic / actor / judge", or the adversarial-design triggers ("attack our design", "find cases that break it", "critic / actor / judge", "red team the algorithm", "对抗设计", "攻击方 实现方 裁判", "设计很多验收 case 证明它 work"), when acceptance cases for a core algorithm are missing, or when a design must hold under scale, noise and edge cases nobody has enumerated.
---

# Self-loop

A simplified operating loop for a project: plan the phase from first principles, harden what was decided by adversarial
rounds, supervise the trajectory, keep the loop's own records true, and spend the owner's attention only on what only
the owner can decide. This file says what to do. Why each rule exists: `REQUIREMENTS.md`. How records are laid out:
`RECORDS.md`. What is still left to judgment or prose, and why: `DEBT.md`.

## Who decides

**You, the lead, decide.** Start every session with `self-loop.mjs start`: every registered product's live stall alarm
and what cannot be watched, then this product's `next` (`next --all` for every registered product): the phase's records,
missing evidence and commands in procedure order. Use the gate results to decide which task to write, whether the round can close, whether the phase
has converged and what needs the owner's attention. `call.mjs` makes one isolated role call and records it. Each gate
answers one factual question. The lead evaluates the meaning of rulings, diagnoses and owner answers
(lesson `L-0002`, `DEBT.md`).

At each actual parent turn, including a child completion or recovery turn, use
`self-loop.mjs start --parent-entry <public-input.json> --owner-store <dir>` (optionally `--json`),
or `next --parent-entry <public-input.json>` with its ordinary selection flags. This explicitly runs local
continuation capture/reconciliation across **every registered product**, even when `next` selects only this
session's product. Read each product's canonical next steps, pending owner, next trigger, blockers and unknowns;
local consumption does not finish the package. An unrelated product's completion does not discharge another
product's work. This command never launches a role or sends a message.

The input is a public JSON envelope, not a transcript, authentication source or platform lookup:

```json
{"schema":"continuation-entry/v1","products":[{"records":"/absolute/registered/records","parentBinding":null,"hostObservation":null,"observations":[]}]}
```

Use canonical registry records paths. Each product entry may supply `parentBinding` and `hostObservation` exactly
as accepted by `reconcileAtExistingParentEntry(records,parentBinding,hostObservation)` in
`scripts/lib/continuation.mjs`; observations are `{publicObservation,bindingRef}` pairs passed unchanged to
`capture(publicObservation,bindingRef,records)`. Supply only actual public launch/terminal binding references and
explicit caller identity; do not invent T3 identity from environment variables, task names or unrelated runs.
Both APIs are async and accept an optional fourth argument `{store}`, where `store` is the resolved
`{path,source}` owner-store object. ENTRY forwards the CLI-selected store for registry and host policy;
omitting it retains default store resolution. This does not mutate the process environment.
Null/missing parent binding or host observation remains unknown. Omitted registered products are still visited
with null inputs; an unregistered or duplicate input records path is a usage error before capture. LOCAL validates
the binding, canonical plan/attempt/hold references and claimant identity; the envelope confers no authority.
Capture errors remain visible and do not prevent inspecting other products. All LOCAL results, including unknowns
and pending obligations, are emitted without collapsing them into a success boolean. The ordinary canonical next
steps for every product follow, including compatible ready work and unresolved holds. API/import/read failures
are visible and the explicit entry exits 1; malformed input exits 64. `start --json` includes `continuation`.

Plain `start` and `next` retain their read-only behavior and do not silently claim consumption. The hourly `tick`,
stall alarms and ordinary monitoring remain in force. They are not immediate terminal ingress or proof of delivery.
No hook, timer, receiver, replay executor or automatic unattended recovery is installed here. If the parent never
enters again, pending work remains pending; independent wake is unavailable. A local consume proves a recorded
canonical reading, not package delivery, an acknowledged launch or incident closure. Prepared calls retain their
existing running classification with unknown launch acknowledgment. Computable external holds and unchecked prose
holds remain distinct; a security refusal never permits probes or retries. D-0003's stall/no-session and daily
resume limits are unchanged. Full transport acceptance is deferred separately from local acceptance.

**Run the gate before you claim.** A claim without its gate's output, run on the exact commit you name, is not made:

| Before you claim | Run | It holds only when |
|---|---|---|
| a role's output exists and may be used | `call.mjs` | exit 0: one hand-off line, audit without violations |
| round N is closed | `trajectory.mjs append --file <records>/metrics/trajectory.jsonl --commit <ruled SHA>` (with `--tip <pushed SHA>` when you pushed a VERSION commit on top of the ruling); `next` prints it. Commit the row with the receipt it names | the append exit 0. The append is told no loop: the loop is the loop.json of the records repository holding the real path of `--file` (which must be that repository's `metrics/trajectory.jsonl`), and `--phase` must be its phase. When `loop.json` configures `ssot`, a `CONVERGED` row first requires `ssot-check.mjs --strict` to pass on the pushed SHA (Rung-2 `anchors`/`check` green and zero unresolved Rung-3 `ssot-drift`, exit 2 otherwise with nothing written). It reads CI itself, once (`lib/ci-receipt.mjs`), for the pushed SHA (the tip, which must follow the ruled SHA through single-parent commits whose difference from it is exactly `VERSION`, D-0009 item 2; else the ruled SHA), where a push to the loop's `gates.remote` (default `origin`) goes, over every `gates.require` check, through the CI gate (`lib/ci.mjs`: the latest run of each check wins), saves that reading as `evidence/NNNN/ci-<sha12>-<n>/receipt.json` and names it in the row (`ciReceipt`) with its word (`ci`). A CONVERGED row needs the word `success`: anything else, CI that cannot be read included, refuses it (exit 2, nothing written; an unreadable reading prints the ci-green command that reads it). Other rows are written with the word read (`unknown` when unreadable). Without a loop (no loop.json, or a ledger outside a records repository) CONVERGED is refused and other rows are written with CI `absent`. `--config`, `--repo`, `--remote`, `--ci` and `--ci-receipt` exit 64 |
| the phase converged | `self-loop.mjs next` (it names the integration SHA from the records and reads that SHA's CI itself, or the CI of the VERSION tip the trajectory row records, and names which SHA it read), `records-check.mjs`, `blueprint.mjs status --records <records> --phase <phase>`, `decisions.mjs status --phase`, `trajectory.mjs alarms`, `owner-words.mjs open --records <records>` (and `ssot-check.mjs --strict` when `loop.json` configures `ssot`) | `next` prints that the recorded convergence checks are satisfied: one integration SHA (no diverged hand-off heads), the judge ruled CONVERGED on it with no failing suite count, no blocker open in the trajectory (opened or carried keys not later closed or shelved) and `ACCEPTANCE: pass`, next's CI reading is green, and (when `ssot` is configured) zero Rung-2 failures or unresolved Rung-3 `ssot-drift`. Records check and blueprint status exit 0. The owner words check must exit 0. The phase has no open batch (a batch is closed by its answer, or by `decisions.mjs replace` once a later answered batch that names it replaced it), every alarm was diagnosed, no advancing round is due (the `Cadence:` line, D-0032 item 1), and judge and actor used different vendors and models (the hand-offs' `agent`) |
| the phase is closed | the same, for the subtraction round | as for convergence, after the subtraction round. Once the phase has a recorded `reviewer-subtraction` hand-off, `next` also needs resolved independent comment review and zero established prose comment lines in the product tree at the integration SHA (D-0016, D-0023 item 3; `lib/comments.mjs`); before it, `next` shows the count and convergence does not depend on it |
| the owner decided | `decisions.mjs status` | the batch shows `answered`, from an answer event holding the owner's own words |
| a commit may be pushed (any branch) | `suite-green.mjs --sha <commit> --command "<full suite>" --out <evidence prefix>`, then `gated-push.mjs --suite-receipt <prefix>.json` | suite-green exit 0 (command exit 0; for node --test a summary with tests > 0, fail 0, cancelled 0) in a clean worktree at that exact SHA, or a green run reused for the same repository, tree, command, install and runtime from `<Git common dir>/self-loop-suite/` (it says `reused <receipt>`, the evidence names it in `reusedFrom`, and the requested `--format` is applied to the stored output); the runtime is the Node the command's shell resolves in the product checkout (its version, platform and architecture, as that Node reports them with the caller's `PATH` and `NODE_OPTIONS`), a run is reused only on an equal runtime, and every receipt names it in `runtime`; pre-commit, `version-gate.mjs release` and pre-push run and reuse the same way. Every publication gate (gated-push, `release`, pre-push) compares, when it publishes, the receipt's measured `tree` with the tree of the commit it publishes and refuses a mismatch (exit 2) naming both trees; a receipt that names no tree (written before receipts named one) measured its own commit's tree. Every tree, VERSION and ancestry `suite-green.mjs` and these gates read is the commit as Git publishes it (`git --no-replace-objects`; the suite runs on a checkout of those objects), so a local `git replace` ref neither satisfies nor changes a check; a refusal names the tree Git publishes and the tree a replacement shows, and `release` and pre-push refuse with exit 2. A VERSION-only commit (`version-gate.mjs tip`, built on the parent's published tree) is covered only by its own receipt or by a green `suite-green.mjs --vary-version <its VERSION>` receipt of the commit it follows with only `VERSION` changed; otherwise it runs. A running suite holds `suite-<pid>-<n>.json` in `SELF_LOOP_LOAD_DIR` (default `~/.self-loop/load`). gated-push takes the push remote, protected branches, required checks, optional `ssot` registry and records from the loop.json of the one registered product whose repository is `--repo` (none or several: exit 2) and refuses any other SHA, repository or a red receipt before pushing; when `ssot` is configured, Rung-2 (`missing-doc`, `anchors`, and `check` in clean detached worktrees) must pass on any branch (exit 2 otherwise), while Rung-3 `ssot-drift` warns on working branches without blocking (`D-0057`). A loop.json without a `protected` key or without `gates.require` is unconfigured, and every gated push of it refuses (exit 2) with the migration (add the key; `[]` is allowed). Every push, by gated-push, `release`, `reconcile` or the pre-push hook, needs a remote Git knows (any name Git accepts, dots and slashes included; Git is asked first) with exactly one push URL (`git remote get-url --push --all`); an unknown name or several URLs are refused (exit 2, nothing pushed), several naming every URL and both ways out: one remote per destination, promoted separately, or remove the extra push URL |
| the candidate is at most X times slower than the base | `bench-gate.mjs --base <rev> --candidate <commit> --command "<benchmark>" --metric <field> --max-ratio X --out <evidence prefix>` | exit 0: both commits in clean worktrees, warm-up then alternating base/candidate pairs, every run exit 0 with its `--require` conditions met, and the distribution-free one-sided upper bound (`--confidence`, default 0.95) of the median per-pair ratio at most X |
| a commit is on a protected branch | `gated-push.mjs` | exit 0 with a committed judge hand-off on that SHA, on an earlier SHA it follows with only `VERSION` changed (D-0009 item 2), or on its same-tree second parent, a matching trajectory row, and a sealed full ruling with `VERDICT: CONVERGED` and `ACCEPTANCE: pass`, in the records of the loop whose product is the pushed repository, the coverage read on the objects Git publishes (a local `git replace` ref neither grants nor withholds it). When `loop.json` configures `ssot`, strict SSOT verification (`ssot-check.mjs --strict`: Rung-2 green and zero unresolved Rung-3 `ssot-drift` across both `same-batch` and `phase-close`) is also required (exit 2 otherwise). Every `gates.require` check of that loop is green on the pushed SHA in the one destination of its `gates.remote`, read only from the API of that destination's own forge (`github.com` via `gh api --hostname` with `GH_HOST` pinned, or AWS CodeCommit via `aws sts` + `aws codebuild` for `codebuild/<project>` checks with canonical host, pinned region, stripped endpoint overrides, and STS caller account binding), and the reading names its `forge`, `host`, `repository` (plus `region` and `account` for CodeCommit), and `source`; a destination on an unsupported host is unreadable CI (exit 2; `ci-green.mjs` exits 2, a CONVERGED append is refused, other verdicts are written `unknown`). The branch is protected when the loop's `protected` lists it; `"protected": []` protects no branch and `"require": []` requires no check (the judge convergence still applies). `--protected`, `--require`, `--remote` and `--records` exit 64 |
| the records are in order | `records-check.mjs` | exit 0 (also validates `metrics/ssot-sync.jsonl` lines as certain failures and screens unresolved `ssot-drift` when `loop.json` configures `ssot`) |

If a gate is red, the claim is false; say what is missing and what you will do next. Never record an answer the owner
did not give, never append a trajectory row the ruling does not state, never call a round closed on a SHA you did not
check.

## Roles

| Role | Owns | Must | Must not |
|---|---|---|---|
| Lead (you) | the next step, tasks, config, briefs, decisions, the trajectory, lessons, promotion, spend | decide from the records and the gates; write each call's task; run the gates before every claim (above); record the owner verbatim (`decisions.mjs answer`); review screening findings | ask the owner what an agent can find out or do; brief a further fix on an alarmed area before the premise test exists (`call.mjs` refuses the call) |
| Frame reviewer | its report, its decisions | use the trajectory, the facts in its task and first principles; test premises; propose subtraction; at most five proposals, owner questions with options and a recommendation | review cases or diffs (the judge does); read outside its folder |
| Critic | case files, scenario type, generators, runner | realistic, rule-decided attacks; white-box from round 2; label `fresh` or `ordered` | invent expectations where the rules are silent (those are gaps); edit the actor's files |
| Actor | implementation, adapter, its design note (`out/design/<area>.md`) | derive from requirements; read cases as training signal; delete what its change supersedes | key behaviour on a case; change contracts or architecture (propose instead) |
| Judge | its private report, its public report, its decisions | rule cases KEEP/REJECT/GAP and failures BLOCKER/SHELVED; audit fixes GENERAL/HACK; run the suite itself; drive phase acceptance; verdict CONTINUE / CONVERGED / REFRAME; on a `judge-frame` call, rule a derivation's inferences and fidelity to the owner's words and admit only what is sound (D-0030 item 2) | edit code or its worktree; put held-out content in the public report |
| Owner | purpose, vision, decisions in batches | — | is never asked to find the problem |

Briefs: `assets/brief-shared.md`, `brief-frame-reviewer.md`, `brief-critic.md`, `brief-actor.md`, `brief-judge.md`.
Different vendors for judge and actor; the strongest models for design and audit. The frame reviewer runs on Claude CLI
(`--restricted`, file tools only: confined by construction) or on `t3` (`antigravity` or `claude`) with fail-closed
confined transcript auditing (`auditAccess([ws])`, file tools only, rejecting disallowed tools, outside paths, and
unparsed/insufficient evidence); Codex (CLI and `t3:codex`) is refused.

## Commands

```
node scripts/call.mjs <config.json> <role> --round N --task <file> [--step <role>-<mode>] [--view <records rev>] [--base <product rev>] [--dry-run | --prepare]
node scripts/call.mjs <config.json> record --ws <prepared workspace> --session <provider session ID> [--transcript <file>]
node scripts/ci-green.mjs --repo <product> --sha <commit> --require app/name,... [--remote origin] [--out <records>/evidence/NNNN/ci-<k>]
node scripts/suite-green.mjs --repo <product> --sha <commit> --command "<full suite>" [--install "<cmd>"] [--format node-test] [--vary-version <V>] --out <records>/evidence/NNNN/suite-<k>
node scripts/bench-gate.mjs --repo <product> --base <rev> --candidate <commit> --command "<benchmark printing one JSON object>" --metric <field> [--install "<cmd>"] [--require "f=v,g<=w"] [--pairs 24] [--warmup 1] [--max-ratio 1.10] [--confidence 0.95] --out <records>/evidence/NNNN/bench-<k>
node scripts/gated-push.mjs --repo <product> --branch <b> --suite-receipt <receipt.json> [--sha <commit>] [--dry-run] [--owner-store <dir>]
node scripts/ssot-check.mjs [check] --config <loop.json> [--sha <commit>] [--strict] [--json] [--out <receipt.json>] [--owner-store <dir>]
node scripts/ssot-check.mjs attest --config <loop.json> --id <entry-id> --sha <commit> --disposition <updated|no-contract-change> --by <role> --reason "<text>" [--round N] [--json] [--owner-store <dir>]
node scripts/version-gate.mjs tip --version <V> [--on <commit>] [--branch <b>]
node scripts/records-check.mjs --repo <records> [--write] [--json]
node scripts/self-loop.mjs init [--product <dir>] [--records <dir>] [--name <name>] [--branch <branch>] [--local-exclude] [--register] [--owner-store <dir>] [--json]
node scripts/self-loop.mjs start [--config <loop.json>] [--hours N] [--now <ISO time>] [--json] [--owner-store <dir>]
node scripts/self-loop.mjs next [--config <loop.json> | --all] [--owner-store <dir>]
node scripts/self-loop.mjs stall [--hours N] [--config <loop.json> | --all] [--now <ISO time>] [--json] [--owner-store <dir>]
node scripts/self-loop.mjs tick [--hours N] [--now <ISO time>] [--json] [--owner-store <dir>]
node scripts/self-loop.mjs ssot [check|attest] [--config <loop.json>] ...
node scripts/self-loop.mjs window open|status|close --records <dir> ...
node scripts/window.mjs open --records <dir> --phase <phase> --horizon <2..12> --goal "<text>" --invariant "<text>" [--invariant ...] [--start-round N] [--by <who>] [--json]
node scripts/window.mjs status --records <dir> [--phase <phase>] [--json]
node scripts/window.mjs close --records <dir> --id <W-NNNN> --verdict verified|reframed [--commit <sha>] [--config <loop.json>] [--by <who>] [--note "<text>"] [--json]
node scripts/self-loop.mjs heartbeat install|uninstall [--dry-run] [--platform launchd|cron] [--release <dir>] [--owner-store <dir>]
node scripts/self-loop.mjs hooks install|check|uninstall --harness antigravity [--scope workspace|global] [--target <hooks.json>] [--config <loop.json>] [--owner-store <dir>] [--release <dir>] [--dry-run] [--json]
node scripts/self-loop.mjs registry init [--roots <dir>,...] | add --name <name> --records <dir> [--aliases a,b] | list [--json]
node scripts/loop.mjs next --config <loop.json>
node scripts/loop.mjs stall --hours N [--config <loop.json>]
node scripts/blueprint.mjs set --records <records> --feature F-NNNN --status <status> [--round R-NNNN-judge | --acceptance <path#heading@commit> --commit <sha> --ci <records-relative receipt>] [--decision D-NNNN] --by <who> --note "<text>"
node scripts/blueprint.mjs status --records <records> [--phase <phase>]
node scripts/blueprint.mjs view --records <records>
node scripts/trajectory.mjs append --file <records>/metrics/trajectory.jsonl --round N --phase P --role judge --area A --verdict V --opened c:id,... --closed c:id,... [--shelved c:id,...] [--carried c:id,...] --suite p/f --commit SHA [--tip SHA]
node scripts/trajectory.mjs alarms --file <records>/metrics/trajectory.jsonl [--sizes <json>]
node scripts/facts.mjs shipped|area|sizes ...
node scripts/decisions.mjs validate <decisions.json> | send --records R --file F --phase P --from R-NNNN-role | answer --records R --batch B-NNNN --words "<owner's words>" [--outcome as-recommended|amended|other] | replace --records R --batch B-NNNN --by B-MMMM [--note "<why>"] | status --records R [--phase P]
node scripts/plan.mjs validate <plan file> [--records R] | ready --records R --plan PL-NNNN [--json] | measure --records R --plan PL-NNNN [--json]
```

`call.mjs` (role: `reviewer`, `critic`, `actor`, `judge`): builds the role's view of the records from one commit by an
allow-list of what is public by construction (never sealed records, evidence, briefs, symlinks, drafts, or round
records no hand-off names); when `loop.json` configures `ssot`, also injects a read-only `ssot-status.md` (`runChecks: false` at the base SHA) and a one-line prompt pointer into `actor` and `judge` workspaces (`critic`, `reviewer`, and repos without `ssot` are unchanged), runs the agent once (Claude CLI always `--restricted`; Codex CLI and `t3:codex` never for the frame reviewer),
audits its tool events afterwards with canonical paths, and commits one hand-off: the round record (your task and the
report verbatim; for the judge only `out/public.md`, its full record sealed), evidence (log, audit, every file under
`out/`), the actor’s current `design/<area>.md` files, the line in `metrics/handoffs.jsonl` and the index of that exact tree. If the current design changed since the actor’s view, the hand-off retains the proposal in evidence and raises a design conflict. Critic and actor changes to owned paths
become a product commit. After the records commit, `loop/<phase>` (`loop.json` `branch`) is fast-forwarded to it when
the commit descends from the branch head, by compare-and-swap (a checkout of the branch is never rewritten; `next`
reports a checkout whose index lags the moved ref); a commit that does not descend from it leaves the branch alone, and
`next` names both heads. A `--base` branch other than the loop branch moves from the base by compare-and-swap. A
critic or actor hand-off whose base does not descend from the last judged commit of the phase is recorded with a
warning naming that commit. Exit 0 recorded, 1 the call failed (setup, agent exit, no
report; only its evidence is committed), 6 certain access violation, 7 refused by the records rules (for example the
round record already exists, or an alarm of the phase waits for its diagnosis; no model is called), 64 usage.

**Comments are pointers or tool directives** (D-0016, D-0023 item 3). `lib/comments.mjs` owns
admission at critic/actor hand-off and phase close. A successful whole-source ECMAScript parse establishes comment
spans; documented directives (`lib/directives.mjs`) and pure record/design pointers admit automatically. Other
comments await independent classification, including ordinary prose. Non-JavaScript source, TypeScript/JSX dialects,
unsupported syntax or unavailable parsing require whole-file review even when an advisory scanner finds no comments.
The bounded extension/interpreter scope lives in `languageOf`; unknown extensions remain outside it.

`call.mjs` retains `<step>-<k>-comments.json` and refuses the hand-off (exit 7) while added candidates are pending or
judged prose. Pending is not a prose verdict. Dispatch an independent judge with the frozen source and candidates;
its `out/comment-resolutions.json` must copy every identity field and supply a verdict plus authoritative evidence
(RECORDS.md, Comment resolution). Record that audited judge output, then retry `record --ws` on unchanged source.
Only the output and audit bytes at the original hand-off publication are consumed; later corrections require a
fresh audited hand-off. For code-only changes in prose-bearing sources, the optional complete judge inventories
in RECORDS.md establish the comment delta. A known author session cannot approve. This is process provenance,
not proof of a different vendor or semantic correctness. The expanded source-review contract awaits independent judge
assessment; its implementation does not close the comment-admission blockers.

A judge's prose finding remains a refusal even against a competing approval. Any source-byte or identity change
invalidates its resolution. Pending and source-scope candidates get no cross-file move credit; established comment-scope prose moved
without addition keeps the existing diff credit. At phase close, `next` supplies the records to the same reader: after subtraction, both
unresolved review and established prose prevent the zero-prose condition. Lexical utilities are advisory outside
established coverage; their tests do not prove universal absence of false kills.

**Heavy calls hold a lease.** While a CLI critic, actor or judge runs, `call.mjs` keeps
`call-<pid>-<n>.json` (`{ "kind": "call", "pid", "role", "id", "records" }`, `id` the call's record ID) in the host load
directory (`SELF_LOOP_LOAD_DIR`, else `~/.self-loop/load`), removed when the agent exits; a lease whose pid is dead counts
for nothing. A live lease naming a planned package's hand-off is that package's start (Planning and dispatch). The
reviewer holds none.

Before a critic, actor or judge call or preparation, the records HEAD must contain a `reviewer-frame` hand-off
and its record for the configured phase. This also applies to dry runs. An explicitly pinned view still controls the
record material presented to the role.

**No adversarial call on an undiagnosed alarm.** A critic, actor or judge call, its `--prepare` and its dry run are
refused (exit 7, no model runs, nothing is recorded) while the trajectory in the call's view has an alarm
(`trajectory.mjs alarms`) that fired on a row of the configured phase and no `reviewer-diagnosis` hand-off of that
phase (`--step reviewer-diagnosis`, or `reviewer-diagnosis-<word>` for a further one in the same round), recorded after
that row, names its key on an `alarms:` line of its task. Recorded after means a later time than the row's; on the same
second, the commit that added the hand-off already holds the row (D-0017 item 3). An alarm fires on the row whose
recording last changed it, so one that grew (the area ruled on again, the blocker class opened again) needs a new
diagnosis; alarms on rows of other phases do not count, and every alarm of the phase counts, `ci-absent` on old rows
included (D-0017 item 1). Only the task's `alarms:` line counts, never prose in the task or the report. The refusal lists
the keys and prints the diagnosis call. The view decides, so a call and its preparation or dry run on the same view
agree. The reviewer and `record` are never refused by it.

Every new task names the features it advances on one line, for example `features: F-0001, F-0002`. Use IDs from
the selected records commit. The frame reviewer may use `features: none`. New hand-offs keep those IDs.

`blueprint.mjs status` returns 0 when all selected features are done or retired, 2 when the selection is empty
or unfinished or the records are invalid, and 64 for usage errors.

**Roles as T3 child threads** (agent `{ "runner": "t3", "provider": "codex" | "claude" | "antigravity", "model", "effort" }`;
`t3:codex` is refused for the frame reviewer, while `t3:antigravity` and `t3:claude` are allowed for `reviewer` in
confined mode without a product worktree and audited fail-closed on `[ws]` with file tools only): so the owner can watch
each role live in T3 and stop it, the agent run moves to a T3 child thread while the view, the gates and the hand-off stay here.
1. `call.mjs ... --prepare` makes every refusal, the workspace, the worktree and its setup exactly as a CLI call, writes
   `t3-prompt.md` (a nonce, the folders to work in, the role prompt) and `call.json`, and prints `{ id, ws, wt, nonce,
   prompt, target }`. No model runs and nothing is recorded.
2. Start one T3 child (`delegate_task`) with `target` (provider, model, effort) and exactly `prompt` as its task; give
   it full access when the role must run the product's real tests.
3. Confirm the started child's provider-native session ID. It is `session_meta.payload.id` in the Codex rollout
   or `sessionId` on the first user entry in the Claude session. The T3 thread ID identifies the thread in T3.
   Run `call.mjs <config> record --ws <ws> --session <provider session ID>` after the child finishes. The command
   checks the prepared repositories, phase, task and prompt against the lead's snapshot. Transcript discovery
   searches only the prepared provider and supplied session. The first submitted prompt must contain
   `t3-prompt.md` verbatim. Use `--transcript` to choose between copies of that session. A retry may omit the
   session after it has been bound. A terminal failure records attempt evidence. A missing terminal event
   keeps the worktree available for a retry.

### Phase state and activity

Run `loop.mjs next` when resuming and after a hand-off or ruling. It prints the phase, `loop/<phase>` and the
integration SHA, then actions in order from prepared calls through convergence. The integration SHA comes from the
records (D-0015 item 5): the last judged commit of the phase (the `commit` of its latest judge trajectory row),
advanced to the newest critic, actor or judge hand-off commit of the phase recorded after that row (in commit order)
that descends from it, when those commits form one line. When they diverge, `next` names each head and prints the merge;
the merge becomes the integration SHA when the next hand-off records on it, and the suite, CI and judge run on the merge
meanwhile. `next` names the judged commit's VERSION tip when a VERSION-only child of it heads `loop/<phase>` or a
protected branch (both when they differ). When `loop/<phase>` lags the integration SHA it prints the fast-forward (to
the protected branch's VERSION tip when one exists); diverged, the merge; ahead by commits no hand-off records, that
they become the integration SHA only when a hand-off records on them. The suite, CI and judge actions are about the
integration SHA; its CI is read on the VERSION tip the trajectory row records, else the tip on `loop/<phase>`, else the
SHA itself, and the action names which. `next` reads and never moves a ref.

`next` prints `Load N` and lists each heavy call on the host (D-0020 item 2, D-0023 item 6): every unrecorded
prepared critic, actor or judge workspace with a live worktree in any loop of the owner store's registry (read even
when the loop was named with `--config`) and in the loop itself, every live `call-*` lease, and every live `suite-*`
lease (`{ "kind": "suite", "pid", "repo", "sha", "started" }`, written by the suite gates). The count is shown, not
used as the bound (D-0025, D-0027 item 1). The bound is the host's measured state, read when `next` runs: it suggests a
critic, actor, judge or suite command only while the one-minute load average is at most `maxLoadRatio` × cores and the
available memory (`os.freemem()`, on Linux the kernel's `MemAvailable`; container limits are not the host's capacity) is
at least `minAvailableMemoryGB` GiB (2^30 bytes). The defaults are 0.7 and the smaller of 16 GiB and a quarter of the
host's total memory (`os.totalmem()`), in `lib/thresholds.mjs` (D-0029); the owner store's `products.json` may set
either, and a `minAvailableMemoryGB` set there is the floor as written. It prints `Host within the bound` or `Host over the bound` with the readings, the limits and where they came
from; over the bound those actions wait, naming the measurement that exceeds it, while reviewer calls, `record` and
gates that run no suite are offered as before. `heavyBudget` is no longer read (a store that has it still loads, and
`next` says it is not read). The reading is advisory: nothing is reserved. `start --owner-store <dir>` runs its `next`
with that store (D-0027 item 2).

`next` also keeps the advancing-round cadence (D-0032 item 1; `lib/cadence.mjs`). An advancing round is a round of the
phase holding a `reviewer-frame` or `reviewer-frame-<word>` hand-off and a `judge-frame` hand-off. Adversarial rounds are
the phase's judge rows in the trajectory that hold a verdict, counted once per round, an advancing round's own row never.
The `Cadence:` line counts them since the last advancing round, or before the first one from the round of the phase
frame, and says how many more make the next advancing round due; `Returns per area` lists, per area of that window, the
blockers each judged round opened, closed and shelved. When the count reaches `cadence.adversarial` (loop.json, a
positive whole number, default 3; any other value exits 64), the line says `advancing round due` and `next` lists
`advancing round due` with the count and the rounds, ahead of every other item but unattested remote tips: the advancing
round's number and its three calls in order, blind frame (`reviewer --step reviewer-frame-blind`), frame (`reviewer
--step reviewer-frame`) and `judge --step judge-frame`, each shown as recorded, prepared or to run (the blind frame is
not needed once the frame is recorded). A round after the counted ones that already holds one of these calls is the
advancing round, so the remaining calls stay in it. While it is due, convergence is withheld; hardening of an area under
review pauses, and settled work runs alongside: the critic call `next` suggests for a building feature is numbered after
the advancing round. It refuses no call (screening). A `judge-frame` hand-off rules on a derivation, not on the product:
`next` asks no trajectory row for it and does not take it as a ruling on the integration SHA.

When the records hold a plan of the phase that no later plan supersedes (`plans/PL-NNNN.md`, Planning and dispatch
below), `next` lists it with its ready set, from the same `readyPlan` as `plan.mjs ready`: each waiting package with
what holds it and what releases it, and, as one screening item ahead of the plans, every package ready by the plan
with no start and no recorded hold, with its call command or the lead's step it waits on (A3). Every current plan of
the phase is reconciled together: no two packages whose files overlap are offered a start from one reading (below). A
second screening item lists every recorded wait whose release is written in words, which no code can check (A3). A
plan that does not validate is listed with its errors. It prepares and launches nothing.

`next` lists every intervention record without a disposition (`rung:` and `carried-by:`, Owner words below) as one
screening item, with what each lacks (A1). Nothing refuses on it, and convergence does not wait for it.

The header of `next` ends with the measures F-0011 and F-0012 admitted (A4): `Measures (…): owner directions N ·
raised first N · precision of batch answers P (…) · owner waiting S s over K owner batches of the phase (…)` from
`phaseMetrics`, one line per current plan with `critical path · idle dispatchable · owner waiting S s on B-NNNN` from
`measurePlan` (`owner waiting n/a` when the plan names no batch), and the returns per area of the cadence lines
below it. Raised first counts record claims proven by commit order only. Owner waiting sums, over the batches of the
phase, each batch's time from its first publication to its first answer or its replacement, and an unanswered batch
accrues from its publication to now and is named as open. Every value its counter cannot compute prints `unknown`
with the reason, never 0; no target, deviation alarm or gate rests on them. Quote this header in reports.

`next` also shows the number of prose comment lines in the product tree at the integration SHA. It is a convergence
condition only once the phase has a recorded `reviewer-subtraction` hand-off, then listing the first lines to remove. Each action names its evidence and the command to
run. Write the indicated task before calling a role, and fill in the indicated shell variables from the ruling,
record or gate when their values depend on a lead decision. For a diagnosis task use one `alarms: <key>[, ...]`
line to name the trajectory alarms it addresses. `next` lists exactly the alarms the gate above would refuse on (the
same `lib/diagnosis.mjs`, at the records HEAD) with that line ready to copy; `call.mjs` prints the same keys when it
refuses.

The hand-offs, word citations, blueprint events, suite receipts and rulings come from committed records.
`next` also reads prepared workspaces, runs the read-only records check and queries live CI for the integration SHA.
For a ruling not yet in the trajectory it prints the append with the ruled SHA (and `--tip <tip>` when
`loop/<phase>` or a protected branch holds a VERSION-only child of it) and the ruling's fields to fill in; it passes no CI word, receipt or loop, because the append reads
CI itself in the loop that owns the ledger.
Set `gates.suite` to the full-suite command and `gates.require` to the required CI checks by `app/name` in the
config. Set `gates.remote` when the push destination differs from `origin`. The suggested suite command uses
`setup` for installation unless `gates.install` specifies a different command. In a prepared workspace, confirm the
child has finished before recording it. The lead runs each selected command.

`loop.mjs stall` exits 2 when the phase has unfinished work or no features and at least N hours have elapsed
since the last phase blueprint event, hand-off, judge ruling or owner batch answer. With no activity, it dates the
phase from the latest committed configuration, else the last records commit other than the driver's own alarms.
Without `--config` the command uses `loop.json` in the current directory. Stalls and
suggested actions are supervision findings for the lead.

### Time budgets at ordinary entry

For plans with a `plan-time/v2` baseline, `plan.mjs measure --records <records> --plan PL-NNNN --json`,
`self-loop.mjs next --config <loop.json>` and `self-loop.mjs start --config <loop.json>` show the time projection.
Forecast storage and publication rules are in `RECORDS.md` (Forecast observation); only the lead publishes through
that existing workflow. These readers do not publish forecasts or launch work. A checkpoint requests the next
review cadence; it creates no autonomous wake. Action still waits for an actual parent entry/event.

Ordinary entry captures one system UTC clock. `--now <UTC ISO timestamp ending in Z>` selects a read-only
simulation, labelled in output; it cannot be combined with `--parent-entry`. It is useful for replay, not live
reconciliation. Elapsed time is nonnegative or unknown; remaining time is signed (zero is due now, negative is
overdue). A clock anomaly yields unknown affected values rather than resetting the budget. A 24-hour example in
fixtures illustrates arithmetic and never establishes the current undertaking's deadline.

Read the fixed historical ETA separately from current canonical progress. Completion after a forecast's pinned
`basedOn` cut can make it stale, but cannot recalculate its old ETA. A new full observation may revise the estimate;
its later timestamp alone is not progress. The original root clock, deadline and missed-checkpoint history survive
forecast refresh, cancellation and restart. Keep unknown upper bounds, capacity assumptions and uncovered review/CI
costs visible; a deadline never permits weaker quality gates.

The admitted positive-evidence contract is in `RECORDS.md` (Time-binding evidence contract). Use an independently
authorized Scope assessment to cover the fixed minimum and any optional omissions, a Release assessment for one
exact candidate with all applicable gates and usable availability for the intended recipient/channel, and an Event
attesting actual occurrence. Existing immutable Evidence paths carry these bindings; no public-role visibility
expansion is authorized. Archive recording provenance is explicitly trusted, not proof of a physical clock or
provider identity. A handoff, Git date or forecast marked delivered establishes none of this by itself.

Verified availability and verified time are separate: availability with unknown time cannot establish on-time or late
delivery. A later proof may improve current outcome while preserving the old forecast, checkpoint reports and
historically labelled progress. Missing evidence remains unknown for the affected claim and never blocks ready work.
The final contract is `f81d0e8:evidence/0012/admitted-positive-final/` in self-loop records.
The evaluator and projection join are implemented; focused acceptance and integration receipts establish only their
covered surfaces (`DEBT.md`, Time-budget evidence). Final independent review, exact-commit full suite and remote CI
remain required. `measure` renders delivery status; the separate `next/start` renderer still needs the P2-owned
budget/current-availability and resolved-checkpoint display hookup. No actual production trusted event is supplied by the design, and no wake or transport is promised.

The normal-opportunity view may additionally show committed alarm occurrences and their current
applicability/diagnosis metadata (`RECORDS.md`, “Alarm occurrences and current metadata”). Read that metadata
separately from exact-version disposition status: covered diagnosis does not account for an occurrence,
and reconciled accounting does not authorize a task. Unknown alarm metadata leaves other ready work visible
under its existing gates. A source-null inventory tombstone does not waive a live canonical diagnosis.
`start` forwards this view from the session's `next`; neither display records an alarm or starts work.

### Every product the lead runs is watched

The owner store (one per owner, `RECORDS.md` § The owner store) holds `products.json`, the registry of every product
the lead runs: name, records repository, aliases, and `roots` to search for records nobody registered. `self-loop.mjs`
is the one command over it, under any harness or none:
- `next` and `stall` find their configuration by `--config`, else `SELF_LOOP_CONFIG`, else an in-repo
  `<toplevel>/.self-loop/loop.json` at the root of the Git working tree containing the working directory (so detached
  role worktrees never discover the primary checkout's records), else the registered product whose folders hold the
  working directory (its records, the product checkout its `loop.json` names, and the folders under `loop.json`
  `projects`). None or several candidates exit 64 naming them; `--all` covers every product.
  The owner store is `--owner-store`, else `SELF_LOOP_OWNER_STORE`, else `~/.self-loop/owner-store`.
- `tick` runs `stall` and `next` for every registered product. A stall (unfinished features or none, and no recorded
  activity for `loop.json` `tick.stallHours`, default 12, or `--hours`) is committed as one line of
  `metrics/alarms.jsonl` in that product's records through the records commit helper, once per idle period (its key is
  the phase and the last recorded activity); `next` shows it until activity resumes. Each product, and within it the
  stall decision, the alarm and `next`, gives results of its own: a product whose records or next steps cannot be
  computed is an `error` finding and hides nothing else, and a stall its records decide is recorded even when `next`
  fails. A product whose current plans hold packages ready by the plan with no start and no recorded hold is an `idle`
  finding naming each package, its plan and its command or step (A3); nothing is recorded for it. It reports a
  registered product whose records are missing or that has no `loop.json` (`no loop`), and a
  records repository under the roots that nobody registered: the top of its own Git working tree holding
  `records.json`, found at any depth (also nested in a code repository, or under a root that is itself one), never a
  product's tracked test fixtures, hidden folders, `node_modules`, the owner store or a registered loop's work folder;
  a root that cannot be searched, or whose search reaches `ROOT_SCAN_FOLDERS`, is an `error` finding. Exit 0 quiet,
  2 findings. `loop.json` `tick.onStall` is `show` (default) or `resume` (D-0003); with no installed `run-lead`
  capability, `resume` reports `resume unavailable` and shows.
- `start`, run from any folder, shows every registered product's live stall: the committed alarm of its current idle
  period (with the action `tick` took, `show` or `resume unavailable`), or a stall no tick has recorded (the heartbeat
  is not running); then what `tick` would report besides stalls (idle packages included), and the session's own
  product with its `next`, whose header carries the measures. It
  reads committed records only and writes nothing; a missing registry or a folder of no product is reported in it.
  Exit 0, 64 usage.
- `stall --all` gives each product a result of its own; one whose records cannot be read is `error: …` (exit 2).
- `heartbeat install` makes the OS scheduler (launchd on macOS, cron elsewhere) run `tick` hourly from the release
  worktree (a checkout detached at the tag `v<VERSION>` of its own `VERSION`), never the development clone; `--dry-run`
  prints the launchd plist and the cron line and writes nothing. Only a plain `X.Y.Z` release is installed, here and as
  the live skill: a prerelease `X.Y.Z-<prerelease>` (for example `0.4.4-v1.5`) is a round's candidate, pushed and
  tagged so it reaches real CI, and a worktree detached at its tag is refused as a release (README, Versions).

## Procedure

### 0. Set up (once per product loop)

1. **Records repository** outside scratch space, before any round (`RECORDS.md` layout): run
   `node scripts/self-loop.mjs init` inside the product repository to create a nested, Git-ignored records repository
   at `<product>/.self-loop/` (appends `.self-loop/` to `.gitignore`, or use `--local-exclude` to write
   `.git/info/exclude` with zero parent-repo diff; pass `--records <dir>` for an external records repository without
   touching the product's ignore files; pass `--register` to also add it to the owner store). `init` refuses tracked
   paths fail-closed, initializes `README.md`, `records.json`, `loop.json`, `.gitignore` and generated `INDEX.md`, and
   makes the initial commit so `self-loop.mjs next` and `records-check.mjs --repo <records>` work immediately. Held-out
   cases and backtest keys live in a **separate** sealed repository that only the judge's calls are given.
2. **Purpose**: capture the owner's words verbatim, then distil the product and phase requirements as dated
   `purpose/P-NNNN.md` records citing the source IDs on a `words:` line.
3. **Owner constraints**, verbatim and numeric where possible (budgets, stability, scale, "architecture unchanged",
   spend envelope for real calls). They go into `engines/shared.md`.
4. **Briefs**: copy the `assets/brief-*.md` templates into `engines/` of the records, fill them, **commit** them: a call
   reads the briefs from the records commit its view is built from.
5. **Config** from `assets/self-loop.example.json`: product repository, a loop branch that is not protected, records,
   work folder, phase, purpose documents, briefs, owned paths, agents per role (judge on another vendor than the
   actor), setup commands, sealed roots. Keep the product checkout and loop branch in the records' `loop.json` so the
   blueprint can resolve product pointers. Record the required CI checks (`app/name`) and full suite under `gates` for the phase report.
6. Agent memory holds only the records location and the IDs that matter (`RECORDS.md` rule 10).
7. **Register the product** in the owner store (`self-loop.mjs registry init` once per owner, then `registry add --name
   <name> --records <records>`), list the folders whose sessions belong to it under `projects` in `loop.json`, and
   install the heartbeat once per host from the release (`self-loop.mjs heartbeat install`, after `--dry-run`).

### Lead hooks

In the lead project's `.claude/settings.local.json`, add these entries under `hooks`. Use absolute paths for
the skill, records, product and workspace directories. A comma-separated `--project` list can name the lead's
other checkouts. Keep the lead's rules in the records `AGENTS.md` and load them into lead sessions.

For the Antigravity harness (`--harness antigravity`), install and verify workspace (`.agents/hooks.json`,
git-excluded via `.git/info/exclude`) or global (`${GEMINI_HOME:-~/.gemini}/config/hooks.json`) hooks from
`assets/antigravity/hooks.json` with:

```
node scripts/self-loop.mjs hooks install --harness antigravity [--scope workspace|global] [--config <loop.json>]
node scripts/self-loop.mjs hooks check --harness antigravity [--scope workspace|global] [--config <loop.json>]
node scripts/self-loop.mjs hooks uninstall --harness antigravity [--scope workspace|global] [--config <loop.json>]
```

For T3 child threads (`runner: "t3"`), `provider` may be `codex`, `claude`, or `antigravity` (`t3:codex` is refused for
the frame reviewer; `t3:antigravity` and `t3:claude` run the frame reviewer in confined mode with fail-closed transcript
auditing on `[ws]`). Antigravity children bind by `conversationId` (`--session <conversationId>`)
and require an untruncated `transcript_full.jsonl`. Because Antigravity hosts multiple vendors, convergence
independence resolves vendor from the full observed model set (`observedModels`) and fails closed on unknown models
or mid-conversation vendor switches.

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node '/abs/self-loop/scripts/owner-words.mjs' capture --records '/abs/records' --project '/abs/product,/abs/lead-checkout'"
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Edit|Write|MultiEdit|NotebookEdit|Bash",
        "hooks": [
          {
            "type": "command",
            "command": "node '/abs/self-loop/scripts/lead-guard.mjs' --product '/abs/product' --workspaces '/abs/workspaces'"
          }
        ]
      }
    ]
  }
}
```

### Owner words

The owner's words are recorded verbatim by mechanism (`owner/words.jsonl`, RECORDS.md "The owner's words"):

```
node scripts/owner-words.mjs capture --records <records> --project <dir>[,<dir>...]
node scripts/owner-words.mjs sync --records <records> --project <dir>[,<dir>...]
node scripts/owner-words.mjs open --records <records> [--json]
node scripts/owner-words.mjs pending --records <records> --discard <key> --note "<why>"
node scripts/owner-words.mjs mark --records <records> --id <W-id> --as direction --intervention I-NNNN [--note "<why>"]
node scripts/owner-words.mjs mark --records <records> --id <W-id> --as answer --batch B-NNNN [--note "<why>"]
node scripts/owner-words.mjs mark --records <records> --id <W-id> --as routine|not-owner --note "<why>"
node scripts/owner-words.mjs metrics --records <records> [--phase <phase>] [--json]
```

- `capture` is the prompt hook (above). It reads the hook's JSON on stdin and records the prompt when the session runs
  inside a project and the prompt is the owner's. It queues the raw prompt and takes the word's ID from the provider
  transcript. A pending or failed capture prints a diagnostic, and the hook always exits 0.
- `sync` reads every Claude Code and Codex transcript of sessions run inside the projects and records the words not yet
  recorded: history from before the hook, sessions with no hook, and failed hooks. `pending` archives an unresolved hook
  capture with a reason. Transcript sync can still record the confirmed word.
- `open` lists the words that are not settled. It exits 0 when there are none and 2 when there are some. The phase does
  not converge while one is open.
- **Classify every word with `mark`.** A word has one class, taken from its latest valid mark in
  `owner/word-marks.jsonl`:
  - `direction`: a new direction, reframe or correction from the owner;
  - `answer`: an answer to a batch;
  - `routine`: a go-ahead or a status question;
  - `not-owner`: text the filters let through that is not the owner's.

  A `direction` word is settled only once its intervention `I-NNNN` is committed. Until then `open` lists it, and the
  phase does not converge. Marking `answer`, `routine` or `not-owner` settles the word.

  `mark` exits 64 and writes nothing for any of these: a word the ledger lacks; a direction without
  `--intervention I-NNNN`; an answer without `--batch` naming a sent batch; routine or not-owner without `--note`; a
  link flag of another class; a mark equal to the word's current class and link. A different class or link is appended
  and becomes the word's class, which is how a misclassification is corrected.

  A word with no mark that a record cites is settled but **unclassified**. `metrics` reports it; classify it with a
  mark.
- **Write the intervention** for each direction word as `interventions/I-NNNN.md`. It holds:
  - a `words:` line naming the direction words;
  - the frame the loop was in, the reframe, and the general question behind it;
  - `raised-first: <record ID>` naming the record that had the direction on record before the owner said it, or
    `raised-first: no`;
  - its disposition (A1): `rung: <construction | hard gate | screening predicate | question bank | owner-only>` and
    `carried-by: <the existing mechanism or admitted feature that carries its general question, or none: why none can>`.
    A screening predicate is named in `carried-by:` by its id in `PREDICATES` (`scripts/loop.mjs`): `stall`,
    `advancing-round-due`, `idle-packages`, `open-words`, `area-rounds`, `blocker-recurring`, `partly-closed`,
    `ci-not-green`, `ci-absent`. The last line of each holds, so a correction is appended. `next` lists every
    intervention without both; nothing judges the content or refuses on its absence (REQUIREMENTS item 11). A cited
    predicate never makes a direction raised first: `metrics` replays it and reports whether it would have fired.

  `records-check.mjs` fails a `raised-first:` that names no record ID or a record no file carries. It also fails one
  whose record's first adding commit in the history of HEAD (committer timestamp) is not strictly
  earlier than the capture time of every word the intervention cites anywhere in its text, plus the direction
  marks naming it. `no` is always accepted. The record is append-only, so a correction is appended: the last
  `raised-first:` line holds. Missing capture times or unreadable/incomplete history are screening, never evidence of
  priority. A claim earns credit only when every cited word has a known capture time and every named record predates
  all of them. This checks file history, not the semantic priority of a passage added later; independent review still
  decides whether the record actually raised the direction.
- **Count with `metrics`.** It counts the words captured in the phase's window, which runs from the phase's first
  hand-off to now, inclusively. A later phase does not truncate that window. It prints:
  - the settled words per class, and `open` for the words not yet settled (a direction whose intervention is not
    committed is open, listed with that intervention, and counted as a direction only once it settles);
  - `ownerDirections`, the settled direction words;
  - `raisedFirst` (directions whose intervention's claim the check above verifies: a named record committed before
    every cited word, D-0030 item 1) and `raisedFirstShare` over `ownerDirections`;
  - `wouldHaveFired`, apart from it: the directions whose word a cited screening predicate fires before when today's
    code is replayed on the records commit just before the word (first-parent history, the last commit earlier than
    the capture). It is coverage for the independent review, never raised first: nothing the loop wrote then says it
    raised the direction, and it never overrides or contradicts a `raised-first: no`. Each direction lists the
    predicates that would have fired. Per cited predicate (A2): the words it would and would not have fired before, and
    its false alarms, the firing episodes over the phase window's commits up to the last citing word that contain no
    such commit. A predicate the records cannot decide (`idle-packages`: launch events and capacity are not records)
    names the event and the feature that owns it. `next`'s header reads the same raised-first count without the false
    alarms;
  - `batchesSent` and `batchesAnswered` (committed batches whose `phase:` is the phase; answered means at least one
    actual answer event, not a replacement event);
  - `ownerWaiting`: over the same batches, each from its first publication in the records history to its first answer,
    to its replacement event, or, while unanswered, to now (open, accruing), summed; `unknown` with the reason when a
    publication or an end time cannot be established, and `0 s` only when the phase sent no batch;
  - `answersByOutcome` (the `outcome` on the answer events of those batches, one count per event) and `precision`,
    which is as-recommended answers over `answeredWithOutcome`. Unlabelled answers and replacements do not enter
    precision;
  - `unclassified`, with the IDs of unclassified and open words.

  The phase defaults to the phase in the committed `loop.json` (exit 64 when there is none and no `--phase`). Empty
  ratio denominators are `null` in JSON and `n/a` in text. A phase without a hand-off has no words in its window.
  A mixed batch answer may be classified as a direction; its verbatim batch answer event is counted independently. One
  function, `phaseMetrics` in `scripts/lib/owner-metrics.mjs`, computes every number. The phase report's owner
  interventions and the share raised first (Phase close step 6) are its output.

### 1. Phase start (generative engine)

1. Gather facts for the frame reviewer: `trajectory.mjs alarms`, `facts.mjs area` and `shipped` for what matters. Write
   its task with mode FRAME, the facts, what the phase is for, and `features: none` if there are no existing features
   to review. Ask it to write new and revised feature drafts to `out/blueprint/F-NNNN.md` in its workspace. Give it the
   next available IDs and the requirements the phase serves. Run `call.mjs <config> reviewer --round N
   --step reviewer-frame --task <file>`.
2. Its brief asks it to include, if not yet settled, the acceptance semantics, each with options and a recommendation:
   the tolerance below the best that still passes; what "stable" means; quality versus speed (default: never trade
   quality for speed); the spend envelope.
3. Update the blueprint from the reviewer's drafts and the owner's decisions. Write the current feature files to
   `blueprint/F-NNNN.md` in the records, set their statuses with `blueprint.mjs set`, stage the records, then run
   `records-check.mjs --write`. Commit the feature files, status log, generated `BLUEPRINT.md` and index by explicit
   path before calling the hardening roles. Use `blueprint.mjs view` to read the owner view.
4. Owner questions: copy its `out/decisions.json` from the hand-off's evidence, `decisions.mjs send` it (only a valid
   list becomes `owner/B-NNNN.md`), commit, and put the batch to the owner. A new requirement's intent questions go
   before its design, as one intent batch (`"kind": "intent"`, Owner interface); where the records already settle the
   intent, record the grounds instead of asking. When the owner answers, record the words
   with `decisions.mjs answer` and commit; record each decision as `decisions/D-NNNN.md` (`by: owner`); fill the briefs;
   commit. Update any affected feature files before calling a role on them. Proposals not escalated go into the
   critic's or judge's tasks as candidate cases.

### 2. Hardening (adversarial engine)

Per round, call critic, actor and judge in the order their dependencies require, independent packages together
(2b, Planning and dispatch; `--base` the loop branch; the judge's base is the integration SHA `next` names, which a
recorded actor commit advances), each with a task you write from the last public ruling and the trajectory. Start a
critic, actor, judge or suite only when `next` shows the host within the bound. After the judge:

1. Read its public record and its full sealed record. Run `suite-green.mjs` on the SHA it ruled on (receipt under
   `evidence/`, committed), then push the loop branch with `gated-push.mjs --suite-receipt`, raising `VERSION` on top
   of the ruled SHA when the push needs it (D-0009 item 2). Every round's candidate reaches real CI.
2. Append the round's row: the closing command `next` prints (`trajectory.mjs append … --commit <ruled SHA> [--tip
   <pushed SHA>]`), with the area, the verdict, blockers opened, closed, shelved and carried (`class:id`, from the
   ruling's `OPENED:`, `CLOSED:`, `SHELVED:` and `CARRIED:` lines, derived from the selected compatible structured ruling;
   explicit flags remain for historical or supplemental dispositions and cannot reverse that ruling) and the suite counts exactly as the ruling states them; an opened key no judge record of the round names is refused (RECORDS.md, the trajectory). The append reads
   the pushed SHA's CI itself and saves the receipt it names; a CONVERGED row is written only when that reading says
   `success`, and a refusal says why (the check that did not pass, or that CI could not be read, with the command that
   reads it). When the ruling accepts a feature, record `done` with `blueprint.mjs set --round R-NNNN-judge`: the
   commit and CI receipt come from that round's CONVERGED row, never from flags. Stage the row, the receipt and the status log, regenerate the views, and commit those records by
   explicit path. A baseline without a round cites `--acceptance`, `--commit` and a CI receipt in the same records
   (`ci-green.mjs --out <records>/evidence/blueprint/ci-<k>`); the done is confirmed by one reading of that commit now
   where the records' loop pushes.
3. Decide the next step: another round (CONTINUE), the owner (REFRAME or owner questions), a diagnosis (an alarm), or
   phase close (convergence, checked with the gates above).

The work itself:

- **Real dependencies from round 1.** Measure the real models and services with a small bounded run before the critic
  builds its world; run a small real trial every round within the spend envelope. Merge the integration branch every
  round.
- **GAN-style alternation.** From round 2 the critic attacks the actor's actual code (white-box); each new batch is the
  held-out set for the code it attacks. Track the generalisation gap on `fresh` cases.
- **Interfaces move; keep the critic off them.** The critic's world states ground truth in the scenario shape; only the
  actor's adapter maps it to ports.
- **Weight shifts to real trials** when the simulated world stops finding defects the judge or a trial had not named:
  fixtures written by someone who has not seen the measured items, measurements pre-registered with the judge, blind
  review with the label mapping stored outside the folder.
- **Blockers gate; nitpicks shelve.** Only BLOCKERs (a realistic flow ending in one of D-0018's losses) block
  convergence; each carries a class so supervision can count recurrences. A blocker the judge later rules SHELVED stops
  gating and stays visible in the trajectory (`shelved`); one carried into a new phase is not a new opening (`carried`).
- **Convergence**: the judge rules CONVERGED when (1) the round's attacks bring no further benefit and (2) the solution
  is complete. You accept it only through the convergence gates above. A round budget is yours to set; running out of
  it is reported as not converged.
- **Acceptance without nitpicking**: near-optimal within the owner's tolerance; stability means a re-request repeats
  and fresh runs stay within the tolerance; speed comes from structure, never from weaker models or lower reasoning.
- **The judge rejects**: cases failing only on an unspecified preference; impossible inputs; fixes keyed on case ids or
  magic sizes; thresholds tuned from one instance; mechanisms the design note cannot trace to a requirement; stability
  measured with zero noise; latency with mocked instant calls; prompt heuristics added after a failure; fixtures shaped
  to the implementation; scope drift.

### 2a. Pipeline the roles (the owner's time is the scarcest resource; lesson L-0003)

- With a plan, `next` and `plan.mjs ready` list every package that can start now (2b); start them together.
- Do not wait for a ruling when the facts for the next fix are already objective (for example the regressions your own
  `suite-green` comparison names): start the next actor while the judge still rules, and fold the ruling's extra
  findings into the round after.
- Split independent work between parallel actors with disjoint scopes (`--step actor-a`, `--step actor-b`, each on
  the same base). The first recorded fast-forwards `loop/<phase>`; the others leave it, and `next` names the diverged
  heads and prints the merge. Merge them yourself, run `suite-green` on the merge, then record the judge on it: the
  merge becomes the integration SHA when that hand-off records on it.
- Let the critic attack the newest code in parallel; keep its entry-point mapping in one place so it can follow an
  actor's new names with a one-line change.
- In a round that can only be CONTINUE, ask the judge for targeted probes on top of your gates; the full repeated runs
  (three packaging runs, both concurrencies, held-out) are for the closing round.

### 2b. Planning and dispatch (F-0012; P-0006)

Dependencies decide what runs in parallel; this section is the dispatch rule 2 and 2a point to, and their integration
and verification steps still apply. From an admitted direction (an owner decision or an independent ruling), record
one revision-linked plan per phase and scope, `plans/PL-NNNN.md` (RECORDS.md, Plans). Each package names its
authority, goal, files, fixed interface, prerequisites, role and settings, acceptance and expected hand-off. Empty
`files:` is read-only work. Files are whole-file ownership: a path, a directory with a trailing slash, or a glob; no
two packages of one plan may overlap, future files included, so a later writer of the same files goes in a successor
plan. A revised contract takes a new hand-off ID; an unchanged package keeps its ID, so its completion still counts.

```
node scripts/plan.mjs validate <records>/plans/PL-NNNN.md
node scripts/plan.mjs ready --records <records> --plan PL-NNNN [--json]
node scripts/plan.mjs measure --records <records> --plan PL-NNNN [--json]
```

- `validate` before committing a plan (exit 1 with the errors): a package without an authority that is a committed
  decision or judge ruling, overlapping files, a `needs` cycle, a reference to a record the records HEAD lacks, a
  duplicate hand-off, or a `supersedes:` that is not the current head of the same scope and phase. Staged records are
  not committed authority.
- `ready` reads the committed records and reports every package `done` (its hand-off recorded), `running` (a live
  prepared workspace, or a live call lease of `call.mjs` naming its hand-off; the launch itself is not known), `ready`
  or `waiting`, each hold with what releases it. The holds of the plan: an unfinished package it needs (`package`), an
  unanswered owner batch (`batch`), a live writer of overlapping files from an earlier plan (`writer`), the host over
  its measured bound for a heavy role (`capacity`), and the lead's recorded hold (`hold`, below). The lead's own steps:
  a missing task (`task`, `<workDir>/tasks/<hand-off>.md` or the package's `task:`), settings other than the role's
  configured ones (`settings`), for a judge hand-off heads that still diverge (`merge`), and an attempt whose worktree
  is gone with no committed evidence that it stopped (`attempt`). Every ready package comes with its exact `call.mjs`
  command (`--prepare` for a `t3` runner; for a judge, `--base` with the integration SHA `next` names). `--json` adds
  `idle`, the packages ready by the plan with no start and no recorded hold, and `unchecked`, those held by a release in
  words. Run them all, then reconcile and measure again: a ready set reserves nothing, and a preparation is not a
  launch acknowledgement. The command launches nothing.
- **One writer across current plans** (F-0012 design 2, R-0008-judge with the Grok 4.6 review under D-0036): `ready`
  and `next` reconcile every current plan of the phase together, in plan ID order and package order. A package whose
  files overlap a running package of another current plan, or a package of another plan already offered a start in
  that order, waits on a `writer` hold naming it, released by its recorded hand-off; it gets no command and is not
  flagged idle. So one reading never offers two overlapping packages.
- **A hold is recorded in the plan** (A3): a package that is not to start now carries `hold: <why it waits>` and
  `release: <what releases it>` in a revision of its plan (the fields are outside the hand-off contract, so the hand-off
  ID stays). A release written as record IDs (a hand-off `R-NNNN-<step>`, a decision, a plan, a feature; an owner batch
  releases at its answer), `capacity` (the measured host within the bound) or an ISO time, comma-separated, is computed:
  once every part is met the hold is released and the package counts as unheld; until then it holds silently. A
  release with any part in words cannot be checked: the package still waits (nothing is refused), and `next`, `tick` and `start` list it
  on every reconciliation (including other registered products at start) as `release in words: cannot be checked; name a record ID, an owner batch ID, capacity or an ISO time
  to make it computable`, apart from the idle packages, until a revision names a computable release. A `hold:` with an
  empty `release:` is no hold.
- **Idle packages are screened** (A3): after each reading (`next`, `ready --json`, the heartbeat's `tick` and `start`),
  a package ready by the plan (every hold left is the lead's own step) with no start and no recorded hold is reported
  with its command or the step it waits on. It is the computable form of I-0002's and I-0003's general question; it
  refuses nothing and has no minute threshold until a launch or acknowledgement event is recorded. Start it, or record
  why it waits.
- `measure` reports the dependency critical-path work, observed execution elapsed time, candidate idle intervals (not
  claimed as dispatchable idle time while admission and launch history is not recorded) and the publication-to-answer
  interval of each owner batch the plan names (an unanswered one to now, marked open; a replaced one to its
  replacement's answer). Missing telemetry is unknown, never zero; publication stands in for the send; a plan that
  names no batch has no figure (`n/a`, `null` in JSON), never 0 s. A package is complete at its successful hand-off, which is not
  acceptance of its feature.

After a relevant hand-off, answer, revision, failure or capacity change, read `next` (or `ready`) again and start what
became ready, or record its hold, before ending the turn. Independent settled work runs through an advancing round;
work on a new or changed derivation waits for
the ruling that admits it (D-0032 item 1, R-0008-judge-frame-dispatch).

### 3. Supervision (after every round)

1. `trajectory.mjs alarms` after every row: an area in three or more rounds of a phase; a blocker class with two or
   more distinct blockers, each counted once at its first opening and a carried one never (self-loop D-0024); an area
   ruled on twice or more with earlier blockers still open, shelved ones not open (`partly-closed`, lesson `L-0002`); a
   judged round whose CI failed (`ci-not-green`); a judge row whose CI never ran, was never read or could not be read
   (`ci-absent`: its candidate never reached real CI); a watched module that grew past the ratio. Alarms are screening,
   each with evidence.
2. A new alarm (or one that grew since its diagnosis) means a frame-reviewer call in DIAGNOSIS mode
   (`--step reviewer-diagnosis`) before the next round, with the alarm keys on its task's `alarms:` line and the facts
   in its task. `call.mjs` enforces this: no critic, actor or judge call of the phase runs, or is prepared, until that
   hand-off is recorded (see Commands). For a recurring area or blocker class it writes `PREMISE:` and `OBSERVATION:`
   and tests the premise against facts.
3. CONTINUE: put the diagnosis into the next round's tasks. REFRAME: send its questions to the owner and stop the area
   until they are answered.
4. **Step back yourself.** Three rounds on one thing, or one area reviewed twice with blockers only partly closed: name
   the class and test the premise before briefing another fix. That is what removed the orchestrator (`L-0002`).
5. **Advance on the cadence** (D-0032). When `next` lists `advancing round due`, run that round: the blind frame, the
   frame and the judge-frame, in the round `next` names. Hardening of the area under review pauses; packages whose
   direction an owner decision or an independent ruling already settles run alongside (2b), and a package on a new or
   changed derivation waits for the ruling that admits it (R-0008-judge-frame-dispatch). The frame reviewer reviews
   the direction, the value of continuing each area from `Returns per area` (blockers opened and closed per judged
   round), and the next features; a judge of another vendor rules on its derivations, and only what it rules sound
   enters the blueprint or a critic's or actor's task (D-0030 item 2). An area whose returns have fallen steeply is left for new features: its blockers stay open in the
   trajectory until a judge closes or shelves them (D-0032 item 2). The count restarts after the round that holds both
   the frame and the judge-frame hand-off.
6. **Bounded Horizon Window** (`window.mjs`, `metrics/windows.jsonl`). When a multi-round architectural refactoring
   crosses an intermediate valley where per-round Critic/Judge/Suite/CI checks are unproductive, open one bounded window
   for the phase with `window.mjs open --records <records> --phase <phase> --horizon <2..12> --goal "<text>" --invariant "<text>"`
   (at most one open window per phase; no silent extension). A window of `horizon = H` grants `H - 1` slack actor rounds
   (`mode: slack`, where `next` defers intermediate critic/suite/CI/judge actions and prompts the next actor round), then
   1 convergence actor round (`mode: converging`), and then enters `mode: gate-due`, where `call.mjs` mechanically
   refuses further `actor` calls (exit 7) while keeping `critic`, `judge`, and `reviewer` open. Phase convergence is
   refused while any window is open. Close a window only with `window.mjs close --verdict verified` (verified from
   committed `CONVERGED` judge ruling with passing suite count, independent judge/actor vendor & model, committed green
   `suite-green` receipt, and committed green CI receipt when `gates.require` is configured) or `--verdict reframed`
   (after a post-open `reviewer-diagnosis` hand-off citing `alarms: window-horizon:<phase>:<id>`). A `CONTINUE` judge
   ruling inside an open window raises the deterministic supervision alarm `window-horizon:<phase>:<id>`.
8. **Asynchronous periodic outer loop (`arch-facts.mjs`, `anti-rot.mjs`, `reviewer-architecture`, `T1`–`T4`, P-0011, D-0058)**:
   - `scripts/lib/arch-facts.mjs` + `scripts/lib/anti-rot.mjs` compute deterministic whole-repo facts on a committed SHA (`largestFiles`, `growthFiles`, `churnHotspots`, `importHubs`, `parallelSiblings`, and `antiRot`: `compatRemnants`, `deadExports`, `hardcodedLiterals`, `testRot`, `commentBloat`) and `T3` breaches (`> 800` lines, `>= 35%` growth from `>= 100` lines, `>= 3`-commit churn since last outer loop, plus anti-rot `compat-remnant`, `hardcoded-literal`, `test-rot`, and `comment-bloat` breaches).
   - `T1` (periodic delivery cadence: `cadence.deliveries`, default `4` committed `actor` hand-off rounds since the latest `reviewer-frame`/`reviewer-architecture`/`judge-frame`, advancing even on 0-bug green streaks), `T2` (phase/milestone boundary), `T3` (`arch-facts` structural or anti-rot breach), and `T4` (window-horizon / trajectory alarm hard stop).
   - On `T1` or `T3`, `loop.mjs next` emits an async read-only `reviewer-architecture` recommendation (`--step reviewer-architecture --base <sha>`) covering all four equal outer-loop mandates (first-principles evolution, single-control-plane convergence, anti-rot cleanup including zero bulky prose code comments, and code-to-design liveness QA + Occam reflexive audit) while in-flight inner-loop work finishes; `call.mjs` gives it a detached read-only product worktree + `arch-facts.json` under strict `FILE_TOOLS` confinement (`[ws, wt]`, zero Bash, zero writes to `wt`, `sealed/` and `records` forbidden, Codex/t3:codex refused, zero product commits). After `cadence.outerGrace` (default `2`) additional deliveries outside an active Bounded Window, `call.mjs actor` mechanically refuses (exit 7) until `reviewer-architecture` commits.
9. **Owner-word capture & distillation gate (`owner-words.mjs`, `reviewer-distill`, `self-loop.mjs start`, P-0011, D-0058)**:
   - `owner-words` deterministically filters T3/harness orchestration envelopes (`Delegated task node:delegated-task:`, `[T3 Code: the agent in T3 thread`, `<CONTEXT_SUMMARY>`, `<SYSTEM_MESSAGE>`) and distinguishes substantive owner words (`isSubstantiveOwnerWord`) from short routine acknowledgements.
   - `self-loop.mjs start` runs a read-only Antigravity hook health probe (`checkAntigravityHooks`) and surfaces missing `hooks.json` immediately in both text and `--json` (`hooks: { healthy, findings }`).
   - Substantive open owner words trigger an async `reviewer-distill` recommendation in `loop.mjs next`; if ignored past 1-turn grace (older than the latest committed `actor` hand-off in the phase), `call.mjs actor` mechanically refuses (exit 7) until distilled into records or marked.

### 4. Phase close

1. **Subtraction pass**: a frame-reviewer call in SUBTRACTION mode (`--step reviewer-subtraction`) with the `shipped`
   facts; then subtraction rounds (actor deletes, judge confirms each requirement keeps a mechanism and a test) until one
   converges by the gates. From that hand-off on, zero prose comment lines at the integration SHA is a convergence
   condition: the actor moves what the comments say into the records or design documents and leaves pointers, and the
   judge confirms nothing is lost (D-0016 item 3).
2. **Promotion** to a protected branch only through `gated-push.mjs` (it refuses, before pushing anything, a SHA without a
   green suite receipt or whose required checks did not all pass in the destination repository).
3. **Traceability**: run the product's own rule → code → test check; every design rule has an ID, names the code that
   enforces it and the tests that prove it, and code enforces no rule a document lacks. If the product has no such check,
   that is a product requirement proposal (step 6).
4. **Design**: `call.mjs` has already recorded the actor's current design. Converged
   rules go into the product's authoritative documents, current state only, one source per rule; the judge checks them.
5. **Lessons**: each lesson as `lessons/L-NNNN.md` with `applies-to: skill / product / both` and the change it led to;
   turn them into skill changes and product requirement proposals, batched for the owner.
6. **Report** to the owner: suite size by surface, pass counts, constraint numbers, owner interventions this phase and
   how many the loop raised first, open items, what was rejected and why, what is not verified, and the gate outputs
   behind each claim. Quote the Measures header of `next` as printed (A4), unknowns included.

## Owner interface

- Questions come from the judge and the frame reviewer as structured decisions (`out/decisions.json`). Only what passes
  `decisions.mjs validate` is sent: a question, at least two distinct options, a recommendation, nothing repeated in the
  batch. A malformed list goes back to its role in your next task, or you drop it.
- Intent batches (D-0031) use `{ "kind": "intent", "requirement": "P-NNNN", "questions": [...] }`. Each intent question
  carries `whyAsked`: why the records, the code and first principles cannot settle it. Order the questions by
  dependency: `dependsOn` is the one-based number of an earlier question (1 is the first), and `ifOther` maps that
  question's other options to the recommendation that follows from each. `validate` refuses an intent question without
  `whyAsked`, a missing or forward `dependsOn`, an `ifOther` without `dependsOn`, and an `ifOther` key that is not an
  option of the question depended on. Whether each reason holds and whether every changed branch is covered is yours
  and the judge's reading; a recommendation may still carry its rationale in prose.
- `send` permits one intent batch and at most one follow-up per requirement per phase; a third exits 2 and writes
  nothing. Answered and replaced intent batches still count; ordinary batches and other requirements or phases do not.
  A repeated question, a follow-up and a requirement with no `purpose/P-NNNN.md` are screened. A follow-up does not
  itself replace the earlier batch: use `replace` only when its conditions hold.
- How many ordinary batches a phase sends is your call; keep it small (the owner's budget for this phase, when the
  owner set one, is a hard limit; the intent limit above is not yours to raise). A question already asked in the phase
  is reported by `send`; the earlier answer stands.
- A batch is answered only by an answer event holding the owner's own words: `decisions.mjs answer --records <records>
  --batch B-NNNN --words "<owner words>" [--outcome as-recommended|amended|other]` keeps the words exactly as given,
  surrounding whitespace and line breaks included. `--outcome` is your reading of the answer, stored beside the words,
  never in them: `as-recommended`, `amended` or `other`. `status` shows it; omitting it is valid and screened; any
  other value exits 64 and writes nothing. Only `owner-words.mjs metrics` computes precision from it. A replacement
  event carries neither words nor an outcome. Nothing converges on a question that rides on the verdict while its batch
  is open.
- When a later batch re-asked a batch's questions and the owner answered the later one, close the earlier batch with
  `decisions.mjs replace --records <records> --batch B-NNNN --by B-MMMM --note "<why>"`. It writes one event with no
  owner words, and only when B-MMMM was sent after B-NNNN, is answered and names B-NNNN in its text; otherwise it exits
  2 with the reason (unknown batch, itself, an earlier or unanswered replacement, a batch already answered or replaced,
  not named). `status` and the index then show the batch as `replaced by B-MMMM`, and `next`'s convergence check counts
  it as closed. Commit the ledger by explicit path. Owner words that later arrive for the replaced batch are still recorded with `answer`.
- Every owner intervention outside a batch is logged as `interventions/I-NNNN.md`: the owner's words, the frame the loop
  was in, the reframe, the general question behind it, whether the loop raised it first, and the rung and mechanism
  that carry its general question (A1). The general question goes into
  the frame reviewer's question bank (`engines/frame-reviewer.md`); a change to a question bank is re-scored on a
  held-out backtest (`scripts/backtest.mjs`, sealed keys, blind grader of another vendor) before it is kept.

## Enforcement ladder

Every rule sits on the highest rung it can reach. A hard gate is admitted only with a test in `scripts/test/` where the
same command turns a recorded real defect red and keeps a labelled set of legitimate historical samples green; a
candidate that fails admission stays screening.

| Rung | Rules here | Where |
|---|---|---|
| 1 Construction | `tick` over every registered product by the OS scheduler, from the release worktree (no session or harness needed); prompt capture and transcript sync into the append-only owner word ledger; fresh agent and folder per call (Claude CLI `--restricted`: no project or session memory; the `cmd` stand-in only under `SELF_LOOP_TEST=1`; a `t3` role is recorded only from the transcript whose first prompt holds its nonce and its prepared prompt verbatim); role views from one records commit by an allow-list of public records (no sealed, evidence, briefs, symlinks, drafts, unnamed round records); briefs from that commit; reviewer confined to file tools in its folder (`claude` CLI by construction; `t3:antigravity` and `t3:claude` by fail-closed confined transcript audit; Codex CLI and `t3:codex` refused); only the judge is given the sealed repository; the judge's full record sealed (readable by later judge calls only), its public report shared; one hand-off commit of an exact tree (nothing staged rides along), including the actor’s current designs and their evidence; owned product paths only; failed calls keep numbered evidence; batch fields one line each; answers as separate events; every `gated-push.mjs` push, on any branch, takes its remote, required checks, protected branches and records from the one registered loop whose loop.json `product` is the same repository as `--repo` (same Git common directory): `gates.remote` (default `origin`), `gates.require`, `protected` and the registered records folder, never from flags; an explicit `"protected": []` protects no branch and an explicit `"require": []` requires no check, the suite receipt and the judge convergence still applying (A9); a push URL shown in a message, reading or receipt has its `http(s)` user information replaced by `***` (A5); the VERSION-only commit written by `version-gate.mjs tip` (its parent is `--on`, else the head of `--branch`; its tree differs from the parent's only in `VERSION`; working tree and index untouched; the branch moved only as a fast-forward, by compare-and-swap); one tree, one suite run: every suite run of `suite-green.mjs`, the pre-commit hook, `version-gate.mjs release` and pre-push stores its run keyed by repository, tree, command, install and runtime (the pinned Node executable digest, version, platform and architecture; only direct literal `node --test` commands with no install, no NODE_OPTIONS and a PATH Node resolving to the calling binary can reuse; all other commands execute with runtime unknown and no cache credit) under the product's Git common directory (`self-loop-suite/<sha256 of the key>/`), and a stored run whose own key, runtime and tree equal the request's, whose log matches its digest and which is green under the requested `--format` is reused instead of running (A7); a VERSION-only commit has a tree of its own, so it reuses only a run of that tree, which `suite-green.mjs --vary-version <its VERSION>` on its parent makes, else it runs the suite; a `suite-<pid>-<n>.json` lease in the host load directory while a suite runs (none on reuse; a lease that cannot be written is logged and the run is not counted); the integration SHA named by `next` from the records: the phase's last judged commit, advanced to the newest hand-off commit recorded after that ruling that descends from it when those commits form one line (with no ruling yet, the head of every hand-off commit of the phase; with none, the head of `loop/<phase>`), and the judged commit's VERSION-only tips on `loop/<phase>` and protected branches, CI read on the tip the trajectory row records, else the tip on `loop/<phase>`, else the integration SHA; `loop/<phase>` fast-forwarded (compare-and-swap, a checkout never rewritten) by `call.mjs ... record` to a critic's or actor's hand-off commit that descends from its head, unless `protected` lists it; `self-loop.mjs start --owner-store <dir>` runs its `next` with the same store (B7); the trajectory row's blocker lists: `opened`, `closed`, `shelved` (an earlier blocker ruled SHELVED: it stops gating and stays visible, apart from closed) and `carried` (a blocker from an earlier phase, not an opening), a key in at most one of opened, carried and shelved, and not both closed and shelved (C4) | `call.mjs`, `decisions.mjs`, `backtest.mjs`, `gated-push.mjs`, `version-gate.mjs`, `suite-green.mjs`, `.githooks/`, `loop.mjs`, `self-loop.mjs`, `trajectory.mjs` |
| 2 Hard gates | the full suite green on an exact SHA in a clean worktree, or a green receipt of the same repository, tree, command, install and runtime, required by every push; every publication gate (`gated-push.mjs`, `version-gate.mjs release`, pre-push) compares the receipt's measured tree with the tree of the commit it publishes, at the moment it publishes, and refuses a mismatch (exit 2) naming both trees, a VERSION-only commit being accepted only on a green `--vary-version` run whose VERSION equals the commit's, and a receipt that names no measured tree refused with a fresh-suite instruction; `next` applies the same check (`receiptProblem` in `lib/ci.mjs`) to the integration SHA's receipt (A6); every gate that reads a product commit to publish it or to cover it (`suite-green.mjs` and its checkout, `gated-push.mjs` with the protected push's judge coverage, `version-gate.mjs release`, `tip` and pre-push, and the VERSION-only rule of `lib/tip.mjs` in `trajectory.mjs append --tip` and `next`) reads its tree, `VERSION` and ancestry as Git publishes them (`git --no-replace-objects`, `ORIGINAL_OBJECTS` in `lib/ci.mjs`), so a local `git replace` ref neither satisfies nor changes a check (A6); a pre-registered latency bar on a paired benchmark of two exact commits in clean worktrees (distribution-free bound of the median ratio); CI green on an exact SHA in the push destination (checks by app/name, latest run wins), read only from the API of that destination's forge (`FORGES` in `lib/ci.mjs`: `github.com` via `gh api --hostname <host>` with `GH_HOST` pinned, and AWS CodeCommit via `aws sts` + `aws codebuild` with canonical `codecommitHost(region)`, stripped endpoint overrides, and STS caller account binding): a destination on any unsupported host is unreadable CI, so the protected push exits 2 and the append refuses CONVERGED and writes other verdicts as `unknown`, and every reading and receipt names the forge, host, repository (plus region and account for CodeCommit), and source (`live` / `injected` / `from-json`) it read (A5, D-0053); one push destination per remote: the one resolver (`lib/ci.mjs`) asks Git for the remote first, with no name pattern of its own (any name Git accepts, dots and slashes included; the push passes `--` before the remote, so a name beginning with `-` stays a name; A8), and returns the destination only when `git remote get-url --push --all` (pushurl and pushInsteadOf applied) yields exactly one URL, else (Git knows no such remote, or it has no push URL or several) `gated-push.mjs` (any branch), `version-gate.mjs release` and `reconcile`, and the pre-push hook on a push to a configured remote (a push to an explicit URL goes to that URL alone) exit 2 with nothing pushed, `ci-green.mjs` exits 2, a CONVERGED append is refused (other verdicts are written with `ci: unknown`) and `next` reports the CI as not readable, each naming every URL and both ways out (one remote per destination, promoted through each, or remove the extra push URL); a `gated-push.mjs` push (any branch) with no product registry, or whose `--repo` is the product of no registered loop or of several, or whose loop.json cannot be used (exit 2, nothing pushed), or given `--protected`, `--require`, `--remote`, `--records` or another option it does not take (exit 64); a `gated-push.mjs` push, on any branch, for a registered loop whose loop.json has no `protected` key or no `gates.require` key: unconfigured, refused (exit 2) with the migration instruction (add the key; `[]` is allowed), and one whose `protected`, `gates.require` or `gates.remote` has the wrong type, refused (exit 2) naming the value (A9); a committed judge convergence before a protected-branch push; certain access outside what a role may see; a path outside the actor’s reserved design output layout; a hand-off file outside the declared kinds or rewriting a committed record; a hand-off line naming a missing file; index or blueprint view drift; malformed hand-off, trajectory or answer lines, and a batch replacement that `decisions.mjs replace` would refuse; malformed blueprint headers, unknown structured feature references or dependency cycles, and invalid feature events or evidence; an adversarial call before its phase’s frame hand-off; an adversarial call, its preparation or dry run while an alarm of its phase in the view has no later `reviewer-diagnosis` hand-off naming its key on the task's `alarms:` line; a new role task without valid feature IDs; open owner words at convergence; an unfinished or empty phase blueprint; unknown owner-word IDs in purpose headers; owner questions without distinct options or a recommendation; an intent question without `whyAsked`, with a missing or forward `dependsOn`, or with an `ifOther` key that is not an option of the question depended on (`decisions.mjs validate`), a third intent batch for one requirement in a phase (`send`, exit 2, nothing written), an `--outcome` outside `as-recommended`, `amended` and `other` (exit 64, nothing written), and an answer event with another outcome or a replacement event with one (records check); a `raised-first:` claim that names no record ID, an ID no record carries, a record with no commit, or a record whose first adding commit is not strictly earlier than the capture of every word the intervention cites or marks to it (records check; `no` always passes; unreadable history and unknown capture times are screened); a plan without a committed decision or judge ruling as authority, with overlapping files, a `needs` cycle, a missing record, a duplicate hand-off, a changed contract under an old hand-off ID, or a `supersedes:` that is not its scope's current head (`plan.mjs validate`, when the lead runs it before committing the plan); a round's pushed tip or a protected push on a SHA other than the ruled one unless only `VERSION` follows it (D-0009 item 2); a `version-gate.mjs tip` whose `VERSION` is invalid (exit 64), not greater than its parent's by SemVer precedence or over a parent with no valid `VERSION` (exit 2), or whose new commit does not follow the branch head or whose branch moved meanwhile (exit 2: the new SHA printed, the branch untouched); a trajectory append naming its loop, push remote, checks or CI word (`--config`, `--repo`, `--remote`, `--ci`, `--ci-receipt`), or whose `--phase` is not the phase of the loop.json in the records holding its ledger; a trajectory append with an `--opened` key that no judge round record of its round and phase in the same records repository (`rounds/NNNN-judge*.md`) names by its whole `class:id` or its id (exit 2, nothing written, no CI read; a ledger outside a records repository has none), or with a key in two of `--opened`, `--carried` and `--shelved`, in both `--closed` and `--shelved`, or a `--shelved` or `--carried` item that is not `class:id` (exit 64) (C4); a CONVERGED row whose own reading of the pushed SHA, where that loop pushes, over every `gates.require` check, is not `success` (unreadable included), or with no loop; a blueprint `done --round` given a commit or CI, or whose round has no CONVERGED row naming its receipt; a baseline `done` whose commit's CI, read once at the moment of writing where the records' loop pushes, is not `success`; a CONVERGED row whose `ciReceipt` is not a green reading of its pushed SHA in the records (records check); a configuration resolved from none or several registered products; a malformed product registry; a heartbeat pointing anywhere but a release worktree; comment admission through `lib/comments.mjs` as specified in Commands: added pending candidates or independently judged prose stop critic/actor hand-off (exit 7, evidence retained); after subtraction, pending full-tree review or established prose prevents convergence; no definitive prose verdict is inferred from an unmatched directive or an uncertain lexical scan; diverged hand-off heads at convergence (no integration SHA until they are merged); an open blocker at convergence, `next` and trajectory projections using the shared `lib/blockers.mjs` transition over the phase's judge rows that hold a verdict in round order, each row first adding its `opened` and `carried` keys, then removing its `closed` keys, then setting its `shelved` keys apart (listed as shelved, not open), so a key carried and closed in one row ends closed (DEBT row 40; B8, C4; exhaustive over one key, four rulings and seven dispositions, `bounded-models.test.mjs`); a judge round record whose `view:` commit contains `decisions/D-0018.md` (or the records' `blockerBar`) when a key its round's judge trajectory row opened has no block in the record that names it and holds a `flow:` line and a `loss:` line whose first word is `data`, `wrong-result`, `false-verdict`, `disclosure` or `stuck` (records check); the lead's edit, in any checkout of the product repository, of a file Git tracks or would track (untracked and not ignored by `.gitignore`, `.git/info/exclude` or `core.excludesFile`) outside `--allow` and the role workspaces, and the lead's direct `git push` (a Claude Code `PreToolUse` hook; it lets the call through when it cannot read the hook input) | `suite-green.mjs`, `bench-gate.mjs`, `ci-green.mjs`, `gated-push.mjs`, `call.mjs`, `audit-access.mjs`, `records-check.mjs`, `trajectory.mjs`, `decisions.mjs`, `blueprint.mjs`, `self-loop.mjs`, `version-gate.mjs`, `plan.mjs`, `lib/ci.mjs`, `lib/tip.mjs`, `lib/comments.mjs`, `lib/directives.mjs`, `lead-guard.mjs` |
| 3 Screening | trajectory alarms (the recurrence alarm counts a class's distinct blockers, each once at the row that first opens it, distinct blockers of one ruling included, a blocker first seen as carried never; the partly-closed alarm counts an area's distinct earlier blockers still open after its next ruling, a shelved one not being open and a carried one never entering; C4, self-loop D-0024); open owner words and missing source lines in dated purpose records; record IDs no record carries; sealed paths in non-judge material; immutable or append-only records changed against HEAD; undeclared files outside a hand-off; bare `file:line` citations, scratch paths, unresolved `path@commit`, digest mismatch, secrets, history in design files or no actor hand-off writing a design this phase; shell commands naming outside paths; refused (denied) tool calls; logs of unknown shape; a question already asked in the phase; active purpose without a feature, feature without status, building feature absent from hand-offs in the last three phase rounds, a cited design section changed since its commit, and a done feature with a dependency still outstanding; next actions and inactivity while features are building; stalls of every registered product as durable alarms, shown with every live alarm at `start`; registered products without records or `loop.json`, products whose records or next steps cannot be computed, records under the registry's roots nobody registered, and roots that cannot be searched; the host's measured state, advisory with no reservation: `next` suggests a critic, actor or judge call or the integration head's suite command only while the host's one-minute load average (`os.loadavg()`) is at most `maxLoadRatio` × logical cores and its available memory, read as `os.freemem()` in GiB (2^30 bytes; on Linux the kernel's `MemAvailable`), is at least `minAvailableMemoryGB` GiB, the defaults being 0.7 and, for memory, the smaller of 16 GiB and a quarter of the host's total memory (`os.totalmem()`; 16 GiB when the total cannot be read) in `scripts/lib/thresholds.mjs` (D-0029 item 2), and either one settable in the owner store's `products.json` (a positive ratio, a floor from 0 used as written; a registry that cannot be read leaves the defaults and is shown as not read); it prints `Host within the bound` or `Host over the bound` with each reading, limit, source and method, and over the bound those actions read `Waiting on the host load:` naming each exceeded measurement, while reviewer calls, `record` and the CI reading stay; `Load N` counts and lists the heavy calls (an unrecorded prepared critic, actor or judge workspace with a live worktree in every registered loop and in the loop `next` runs for, and every `call-*` and `suite-*` lease in the host load directory whose pid is alive), shown and never the bound; a `heavyBudget` in `products.json` still loads and `next` says it is no longer read (B6, self-loop D-0025, D-0027 item 1); `loop/<phase>` lagging, diverged from, or ahead of the integration SHA by commits no hand-off records (with the fast-forward or merge command; `next` moves no ref), integration heads that diverged (with the merge command), a protected branch holding the integration SHA's VERSION tip that `loop/<phase>` lacks, a checkout of `loop/<phase>` whose index differs from its ref, and a critic's or actor's hand-off whose base does not descend from the last judged commit (a warning at `record`); the number of prose comment lines at the integration SHA before the phase's subtraction; a judge record held to the blocker bar whose view commit cannot be read; the advancing-round cadence (`next` lists `advancing round due` with its three calls and withholds convergence, refusing no call) and the returns per area (D-0032); unclassified and open owner words, the owner directions of a phase and the share the loop raised first, batches and answer outcomes with precision (`owner-words.mjs metrics`); an intent follow-up, a repeated question and an intent requirement with no purpose record at `send`, and an answer recorded without an outcome; the current plans' ready set with each wait's hold and release, every current plan of the phase reconciled together so that no two packages with overlapping files are offered a start from one reading (`next`, `plan.mjs ready`; advisory, nothing reserved or launched) and their measurements with unknowns named (`plan.mjs measure`); every package ready by the plan with no start and no recorded hold, through `next`, `tick` (exit 2) and `start` (A3); every recorded wait whose release is written in words, through `next`, `tick` and `start` on every reconciliation as `unchecked-release`, separately from idle (A3); every intervention without a disposition, through `next` (A1); the replay of each screening predicate an intervention cites, reported as would-have-fired coverage apart from raised first, with its false alarms (`owner-words.mjs metrics`, A2); the Measures header of `next` and `start`, with unknown values printed as unknown and no target, alarm or gate on it (A4) | `trajectory.mjs`, `records-check.mjs`, `audit-access.mjs`, `decisions.mjs`, `loop.mjs`, `lib/cadence.mjs`, `lib/host.mjs`, `owner-words.mjs`, `plan.mjs`, `self-loop.mjs`, `call.mjs` |
| 4 Model judgment | choosing and briefing the next role, claiming convergence, closing, when to ask the owner (the lead, through the gates above); judge verdicts, reviewer diagnoses and proposals | this file, briefs |
| 5 Prose | everything in `DEBT.md`; shrink it every phase | `DEBT.md` |

## Elsewhere

The procedure is plain text; point another tool's rules file (AGENTS.md, Cursor rules) at this file. Without
`call.mjs`, spawn each role from its brief with a fresh agent and a view built the same way, and run the gates the same
way. Tests: `node --test scripts/test`.
