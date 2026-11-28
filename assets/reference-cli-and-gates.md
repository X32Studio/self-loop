# Self-loop · CLI, Protocols & Gates Reference

Complete technical reference for `self-loop` CLI flags, JSON envelopes, dispatch gates (`G1–G7`), Paseo/Antigravity/T3 harness protocols, comment admission v2, SSOT checks, owner-word accounting, time budgets, supervision windows, and publication gates. For the concise Lead operating procedure, see [`SKILL.md`](../SKILL.md); for canonical domain vocabulary, see [`GLOSSARY.md`](../GLOSSARY.md).

---

## 1. Command Reference

```bash
# Role calls, preparation, recording & cancellation
node scripts/call.mjs <config.json> <role> --round N --task <file> [--step <role>-<mode>] [--view <records rev>] [--base <product rev>] [--plan PL-NNNN --package <id>] [--dry-run | --prepare]
node scripts/call.mjs <config.json> record --ws <prepared workspace> [--session <provider session ID>] [--transcript <file>]
node scripts/call.mjs <config.json> cancel --ws <prepared workspace> --reason "<text>"

# Dispatch & integration engine
node scripts/dispatch.mjs analyze|waves|integrate|prepare|record --records <dir> --plan PL-NNNN [--wave N] [--base <rev>] [--dry-run | --apply | --integrate] [--json]
node scripts/plan.mjs validate <plan file> [--records R] | ready --records R --plan PL-NNNN [--json] | measure --records R --plan PL-NNNN [--json]

# Suite, benchmark, CI, version & push gates
node scripts/ci-green.mjs --repo <product> --sha <commit> --require app/name,... [--remote origin] [--out <records>/evidence/NNNN/ci-<k>]
node scripts/suite-green.mjs --repo <product> --sha <commit> --command "<full suite>" [--install "<cmd>"] [--format node-test] [--relay | --no-relay] [--vary-version <V>] --out <records>/evidence/NNNN/suite-<k>
node scripts/bench-gate.mjs --repo <product> --base <rev> --candidate <commit> --command "<benchmark printing one JSON object>" --metric <field> [--install "<cmd>"] [--require "f=v,g<=w"] [--pairs 24] [--warmup 1] [--max-ratio 1.10] [--confidence 0.95] --out <records>/evidence/NNNN/bench-<k>
node scripts/gated-push.mjs --repo <product> --branch <b> [--suite-receipt <receipt.json>] [--sha <commit>] [--dry-run] [--verify-only] [--owner-store <dir>]
node scripts/version-gate.mjs tip --version <V> [--on <commit>] [--branch <b>]

# SSOT & records integrity
node scripts/ssot-check.mjs [check] --config <loop.json> [--sha <commit>] [--strict] [--json] [--out <receipt.json>] [--owner-store <dir>]
node scripts/ssot-check.mjs attest --config <loop.json> --id <entry-id> --sha <commit> --disposition <updated|no-contract-change> --by <role> --reason "<text>" [--round N] [--json] [--owner-store <dir>]
node scripts/records-check.mjs --repo <records> [--write] [--fast] [--staged] [--prune [--retain-rounds N] [--dry-run | --apply]] [--json]

# Unified front-door (self-loop.mjs), hygiene & bounded Lead micro-patch
node scripts/self-loop.mjs init [--product <dir>] [--records <dir>] [--name <name>] [--branch <branch>] [--harness t3|paseo] [--runner claude|codex|t3|paseo] [--provider <name>] [--adapter antigravity|claude|codex|generic] [--model <id>] [--actor-model <id>] [--critic-model <id>] [--judge-model <id>] [--reviewer-model <id>] [--independence vendor|model|session] [--local-exclude] [--register] [--owner-store <dir>] [--json]
node scripts/self-loop.mjs start [--config <loop.json>] [--parent-entry <public-input.json>] [--hours N] [--now <ISO time>] [--json] [--owner-store <dir>]
node scripts/self-loop.mjs next [--config <loop.json> | --all] [--full] [--parent-entry <public-input.json>] [--owner-store <dir>]
node scripts/self-loop.mjs stall [--hours N] [--config <loop.json> | --all] [--now <ISO time>] [--json] [--owner-store <dir>]
node scripts/self-loop.mjs tick [--hours N] [--now <ISO time>] [--json] [--owner-store <dir>]
node scripts/self-loop.mjs clean|prune|records gc|records compact [--config <loop.json> | --records <dir> | --all] [--retain-rounds N] [--dry-run | --apply] [--json] [--owner-store <dir>]
node scripts/self-loop.mjs patch --records <dir> [--diff <file|->] [--files <p1,p2>] --reason "<why>" --verify "<cmd>" [--dry-run] [--json]
node scripts/self-loop.mjs ssot [check|attest] [--config <loop.json>] ...
node scripts/self-loop.mjs window open|status|close --records <dir> ...
node scripts/self-loop.mjs dispatch analyze|waves|integrate|prepare|record --records <dir> --plan PL-NNNN ...
node scripts/self-loop.mjs heartbeat install|uninstall [--dry-run] [--platform launchd|cron] [--release <dir>] [--owner-store <dir>]
node scripts/self-loop.mjs hooks install --records <dir> [--dry-run] [--json]
node scripts/self-loop.mjs hooks install|check|uninstall --harness antigravity [--scope workspace|global] [--target <hooks.json>] [--all | --config <loop.json>] [--owner-store <dir>] [--release <dir>] [--dry-run] [--json]
node scripts/self-loop.mjs registry init [--roots <dir>,...] | add --name <name> --records <dir> [--aliases a,b] | list [--json]

# Driver, blueprint, trajectory, facts, windows, decisions & owner words
node scripts/loop.mjs next --config <loop.json> [--full]
node scripts/loop.mjs stall --hours N [--config <loop.json>]
node scripts/blueprint.mjs set --records <records> --feature F-NNNN --status <status> [--round R-NNNN-judge | --acceptance <path#heading@commit> --commit <sha> --ci <records-relative receipt>] [--decision D-NNNN] --by <who> --note "<text>"
node scripts/blueprint.mjs status --records <records> [--phase <phase>]
node scripts/blueprint.mjs view --records <records>
node scripts/trajectory.mjs append --file <records>/metrics/trajectory.jsonl --round N --phase P --role <judge|critic> --area A --verdict V --opened c:id,... --closed c:id,... [--shelved c:id,...] [--carried c:id,...] --suite p/f --commit SHA [--tip SHA]
node scripts/trajectory.mjs alarms --file <records>/metrics/trajectory.jsonl [--sizes <json>]
node scripts/window.mjs open --records <dir> --phase <phase> --horizon <2..12> --goal "<text>" --invariant "<text>" [--invariant ...] [--start-round N] [--by <who>] [--json]
node scripts/window.mjs status --records <dir> [--phase <phase>] [--json]
node scripts/window.mjs close --records <dir> --id <W-NNNN> --verdict verified|reframed [--commit <sha>] [--config <loop.json>] [--by <who>] [--note "<text>"] [--json]
node scripts/facts.mjs shipped|area|sizes ...
node scripts/decisions.mjs validate <decisions.json> | send --records R --file F --phase P --from R-NNNN-role | answer --records R --batch B-NNNN --words "<owner's words>" [--outcome as-recommended|amended|other] | replace --records R --batch B-NNNN --by B-MMMM [--note "<why>"] | status --records R [--phase P]
node scripts/owner-words.mjs capture|sync|open|pending|mark|metrics --records <records> ...
```

### Candidate development commands (supervised incremental release; `D-0041`)

Current development contract only (not in installed `v0.4.4`; operational gate use requires separate root exact-bootstrap admission per `D-0041`):

```bash
node scripts/version-gate.mjs release --repo <canonical-product> --branch <protected-branch> --sha <tip> --suite-receipt <receipt> --protected <nonempty-pinned-list> --require <exact-app/name-list> --records <records> --remote <pinned-remote> --release-admission <immutable-admission> --transaction <TransactionRequest-file>
node scripts/scoped-release.mjs --request <file> [--synthetic-blobs <file>]
SELF_LOOP_REPLAY_INPUT=<private-input-manifest> node scripts/suite-green.mjs --repo <managed-clean-candidate> --sha <tip> --command "node --test scripts/test acceptance/candidate-replay.mjs" --out <proof-prefix>
```

`scoped-release.mjs` prints JSON `VerifierResult` (exit `0` eligible/resume, `2` refused, `64` usage), accepts no CLI or environment-variable replacement trust root or trust callback, and is **non-authorizing even on `ELIGIBLE`**; production authority binds solely to the root-selected fixed OOB anchor `<authority-state>/self-loop-release-authority/anchor.json` (no `/etc` or `sudo`) under actual root custody. `gated-push.mjs --release-admission ...` shares the pure verifier predicate and refuses `ATOMIC_REQUIRED` for branch-only publication; absent scoped arguments, native `gated-push.mjs` and `version-gate.mjs` stay unchanged, and malformed scoped requests fail closed without falling back to native (`design/scoped-release.md`).

---

## 2. Parent Entry & Continuation Envelope (`continuation-entry/v1`)

At each actual parent turn (including child completion or recovery turns), use:

```bash
node scripts/self-loop.mjs start --parent-entry <public-input.json> --owner-store <dir> [--json]
node scripts/self-loop.mjs next --parent-entry <public-input.json> [selection flags]
```

This explicitly runs local continuation capture/reconciliation across **every registered product**, even when `next` selects only this session's product. Read each product's canonical next steps, pending owner, next trigger, blockers, and unknowns; local consumption does not finish a package, an unrelated product's completion does not discharge another product's work, and this command never launches a role or sends a message.

Envelope schema (public JSON, not a transcript, auth source, or platform lookup):

```json
{
  "schema": "continuation-entry/v1",
  "products": [
    {
      "records": "/absolute/registered/records",
      "parentBinding": null,
      "hostObservation": null,
      "observations": []
    }
  ]
}
```

- Use canonical registry records paths. Each product entry supplies `parentBinding` and `hostObservation` as accepted by `reconcileAtExistingParentEntry(records, parentBinding, hostObservation)` in `scripts/lib/continuation.mjs`; `observations` are `{publicObservation, bindingRef}` pairs passed unchanged to `capture(publicObservation, bindingRef, records)`.
- Supply only actual public launch/terminal binding references and explicit caller identity; never invent T3 identity from environment variables, task names, or unrelated runs.
- Both APIs are async and accept an optional fourth argument `{store}` (`{path, source}` owner-store object). ENTRY forwards the CLI-selected store for registry and host policy without mutating `process.env`.
- Null/missing `parentBinding` or `hostObservation` remains unknown. Omitted registered products are still visited with null inputs; an unregistered or duplicate `records` path exits `64` before capture.
- LOCAL validates the binding, canonical plan/attempt/hold references, and claimant identity; the envelope confers no authority. Capture errors remain visible without hiding other products. All LOCAL results (including unknowns and pending obligations) are emitted without collapsing into a success boolean. API/import/read failures exit `1`; malformed input exits `64`. `start --json` includes `continuation`.
- Plain `start` and `next` remain read-only and do not silently claim consumption. Hourly `tick`, stall alarms, and ordinary monitoring stay in force (not immediate terminal ingress or delivery proof). No hook, timer, receiver, replay executor, or unattended recovery is installed here. Computable external holds and unchecked prose holds remain distinct; security refusals never permit probes or retries. D-0003 stall/no-session and daily resume limits are unchanged.

---

## 3. Detailed Gate Semantics

### `call.mjs` (Single Control Plane; `v0.9.0`, D-0060, D-0061)

- Builds the role's records view from one commit via a public allow-list (never sealed records, evidence, briefs, symlinks, drafts, or round records unnamed by a hand-off).
- Enforces mandatory `--plan PL-NNNN --package <id>` (exit `7`) on every `critic`, `actor`, and code `judge` call (exempting only `reviewer`, `judge-frame*`, and `judge-comments*`).
- Verifies commit-graph provenance on `--base` (`verifyProvenance` above `provenanceBaseline`).
- Enforces 0-turn grace on substantive open owner words before `critic`/`actor` calls (exit `7`; `reviewer` stays open).
- Extinguishes historical `ci-absent` alarms covered by a descendant green CI row (amended `D-0017`).
- Evaluates delta-scoped `T3` breaches against the latest committed `reviewer-architecture` `arch-facts.json` baseline, scoping hard-blocks strictly to hotspot-intersecting packages while an async `reviewer-architecture` is active (amended `D-0058`, `D-0060`).
- Stages once-per-tree host suite receipts (`stageSuiteWorkspace`):
  - `"ensure"` pre-launch suite gate with per-key singleflight locking (exiting `2` on red before launching any code `judge` or planned read-only final `critic` with `files: []`).
  - `"lookup"` zero-delay staging for `actor` and write-mode `critic` (non-empty `files`).
  - `purgeTreeReceipts` on newly committed unattested product trees during `record`; Rung-3 `duplicateSuiteRuns` screening in `audit-access.mjs`.
- When `loop.json` configures `ssot`, injects read-only `ssot-status.md` (`runChecks: false` at `--base`) and a one-line prompt pointer into `actor` and `judge` workspaces (`critic`, `reviewer`, and non-`ssot` repos unchanged).
- Audits tool events afterwards with canonical paths, writes top-level `nonce` and serializes every `*-audit.json` through `serializeBoundedAudit(audit, 1048576)` (preserving Tier-0 security flags and capping ordinary flags at `16`/command and `256`/audit with `<= 240`-char previews), filters `<ws>/out/` through `collectCleanOutFiles` (excluding `pg_wal/`, PostgreSQL clusters, `*cache*`, `tmp/`, `node_modules/`, `.git` metadata while keeping sibling files, bare repos, binary/DB/source dumps, files `> 2 MiB`, and caps at `64` files / `10 MiB`), checks `parsePruneManifests` so pruned attempts are never reused, and commits one atomic hand-off: round record, evidence, actor `design/<area>.md`, `metrics/handoffs.jsonl`, and regenerated `INDEX.md`. On `record` (exit 0) and `cancel`, reclaims heavy workspace payloads via `reclaimWorkspacePayloads` while preserving `<ws>/call.json`.
- Fast-forwards `loop/<phase>` (`cfg.branch`) by compare-and-swap when the new product commit descends from branch head (never rewriting an active checkout; `next` reports index lag); non-descending commits leave the branch untouched.
- **Exit codes**: `0` recorded, `1` call failed (evidence committed), `2` pre-judge / read-only final critic suite gate failed before model launch, `6` certain access violation, `7` refused by records/plan/provenance/alarm/owner-word/comment rules (no model called), `64` usage.
- **Heavy-call leases**: while a CLI `critic`, `actor`, or `judge` runs, `call.mjs` holds `call-<pid>-<n>.json` (`{ "kind": "call", "pid", "role", "id", "records" }`) in `SELF_LOOP_LOAD_DIR` (default `~/.self-loop/load`); dead PIDs count for nothing. A live lease naming a planned package's hand-off counts as that package's start. Reviewers hold none.
- **Frame prerequisite**: before any `critic`, `actor`, or `judge` call, `--prepare`, or `--dry-run`, records HEAD must contain a `reviewer-frame` hand-off and record for the configured phase.
- **No adversarial call on an undiagnosed alarm**: `critic`, `actor`, `judge` calls, `--prepare`, and `--dry-run` refuse (exit `7`) while the view's trajectory has an alarm (`trajectory.mjs alarms`) on a row of the configured phase with no later `reviewer-diagnosis` (`reviewer-diagnosis` or `reviewer-diagnosis-<word>`) hand-off naming its key on an `alarms:` line of its task (D-0017). Only the task's `alarms:` line counts. Refusals list keys and print the diagnosis command.
- **Feature IDs**: every new task names the features it advances on one line (`features: F-0001, F-0002`, or `features: none` for `reviewer-frame`).

### `trajectory.mjs append` & CI Receipts

- Derives its loop exclusively from `loop.json` of the records repository holding the real path of `--file` (must be `metrics/trajectory.jsonl`), and requires `--phase` to match `loop.json`. Passing `--config`, `--repo`, `--remote`, `--ci`, or `--ci-receipt` exits `64`.
- When `loop.json` configures `ssot`, a `CONVERGED` or `PASS` row requires `ssot-check.mjs --strict` green on the pushed SHA (Rung-2 `anchors`/`check` green and zero unresolved Rung-3 `ssot-drift`; exit `2` otherwise with nothing written).
- Reads CI itself once (`lib/ci-receipt.mjs`) for the pushed SHA (`--tip`, which must follow `--commit` through single-parent commits whose difference is strictly `VERSION` per D-0009 item 2; else `--commit`), at the destination of `gates.remote` (default `origin`) over every `gates.require` check (`lib/ci.mjs`: latest run of each check wins), saves `evidence/NNNN/ci-<sha12>-<n>/receipt.json`, and records `ciReceipt` and `ci`.
- A `CONVERGED` or `PASS` row requires `ci === "success"` (unreadable CI included -> exit `2`, nothing written, prints `ci-green.mjs` command). Other verdicts write the word read (`unknown` if unreadable; `absent` without a loop).
- Supports both `--role judge` and `--role critic` (for no-dispute independent Critic convergence under D-0064 T10 / D-0067).
- `--opened` keys must be named by a round record of that round and phase; a key may appear in at most one of `--opened`, `--carried`, `--shelved`, and not both `--closed` and `--shelved` (exit `64`).

### `suite-green.mjs`, `gated-push.mjs`, `version-gate.mjs` & `bench-gate.mjs`

- **`suite-green.mjs`**: runs `--command` in a clean worktree at `--sha` (`git --no-replace-objects`, `ORIGINAL_OBJECTS` in `lib/ci.mjs`, so `git replace` refs cannot spoof or alter checks). For `--format node-test`, requires `tests > 0`, `fail === 0`, `cancelled === 0`.
- **Once-per-tree & `codeTree` caching (D-0020, D-0061, D-0064 T6)**: stores runs under `<Git common dir>/self-loop-suite/<sha256>/`, keyed by repository, tree/`codeTree` (tree hash with `VERSION` stripped), command, install, and runtime (pinned Node executable digest, version, platform, arch). Only direct literal `node --test` commands with no install, no `NODE_OPTIONS`, and a `PATH` Node resolving to the calling binary qualify for reuse; others run with `runtime: unknown` and no cache credit. Reused runs print `reused <receipt>` and name `reusedFrom`. A running suite holds `suite-<pid>-<n>.json` in `SELF_LOOP_LOAD_DIR`.
- **Resumable per-file checkpoint relay (`--relay` / `--no-relay`, `SELF_LOOP_RELAY_DIR`, `F-0016`, `W-ee79c72dc0`)**:
  - Enabled when `--format node-test`, `!noRelay` (`--no-relay` or `SELF_LOOP_NO_RELAY=1` disables), runtime execution qualifies (`!install`, `!NODE_OPTIONS`, `PATH` `node` matches `realpathSync(process.execPath)`), and `--command` is a decomposable `node --test` path list with no filter/watch flags; non-decomposable commands fall back transparently to whole-command execution.
  - Discovers `*.test.{js,mjs,cjs}` files strictly from the committed `tree` (`git --no-replace-objects ls-tree -r -z <tree>`, excluding `index.js`, never reading live working-tree bytes) and executes only unverified/failed files inside `suite-green.mjs`'s clean detached worktree (`gc.auto=0`, `maintenance.auto=false` appended to `GIT_CONFIG_COUNT`).
  - Persists fail-closed checkpoints under `SELF_LOOP_RELAY_DIR` (default `<suiteStore>/.relay/<codeTree>/<runtimeKey>/`), keyed on `(repository, command, install, execution.digest, varyVersion, node/platform/arch)` and verified against exact `(codeTree, relPath, fileBlobSha, runtimeKey, exitCode === 0, signal === null, pass > 0, fail === 0, cancelled === 0, todo === 0, skipped === 0, non-empty tapExcerpt)`. Synthesizes a full-tree green receipt + `ran.log` (re-verifiable under `storedGreen()`) once 100% of files pass; `purgeTreeReceipts` clears `.relay/<codeTree>` on unattested trees and `pruneSuiteStore` bounds `.relay/` retention (`14d` / `16` trees / `32 MiB`, preserving pinned trees).
- **Non-interactive bounded Lead micro-patch (`self-loop.mjs patch --diff <file|->`, `D-0064` T5, `F-0016`)**:
  - Accepts unified diff via `--diff <file>` or `--diff -` (stdin), mutually exclusive with `--files` (exit `2` on conflict or empty diff).
  - Pre-checks `reason`, `verify`, clean tracked working tree on non-detached non-protected `cfg.branch` (no untracked collision on patched paths), and `< 2` consecutive `lead-patch` handoffs before creating an isolated detached `tmpWt` at `base` (cleaned in `try/finally`).
  - Applies diff via `git apply --index --whitespace=nowarn -` and enforces hard bounds **before** `--verify`: `1..3` files, `1..20` added+deleted lines, modes strictly `{000000, 100644, 100755}` (rejecting symlinks `120000` and gitlinks `160000`), non-binary hunks, no `..`/`.git/**`/sealed paths, and `0` added prose comments.
  - Runs `--verify <cmd>` in `tmpWt` without staging scratch files; supports `--dry-run`. Commits `loop(<phase>): lead-patch - <reason>`, fast-forwards `cfg.branch` via `--ff-only`, records `LP-NNNN` (`role: "lead-patch"`, `diffMode: true`, `diffSha256`), and rolls back `cfg.product` to `base` if `commitRecords` throws. `lead-guard.mjs` remains unweakened.
- **`VERSION`-only tips & fast `pre-commit`**: `version-gate.mjs tip` builds a `VERSION`-only commit on the parent's published tree (`--no-replace-objects`) without touching the working tree/index and fast-forwards by CAS. `VERSION`-only commits reuse green `codeTree`-equivalent or `--vary-version <V>` suite and CI receipts (D-0064 T4/T6). `.githooks/pre-commit` fast-passes (`< 0.2s`) on `VERSION`-only or docs-only commits.
- **`gated-push.mjs`**: resolves remote (`gates.remote`, default `origin`), `protected`, `gates.require`, optional `ssot`, and `records` solely from the one registered loop matching `--repo` (none or several: exit `2`; missing `protected` or `gates.require` key: exit `2` with migration message; `[]` allowed; CLI overrides `--protected`, `--require`, `--remote`, `--records`: exit `64`). Auto-resolves a cached green suite receipt for exact `sha^{tree}` via `lookupSuiteReceipt` when `--suite-receipt` is omitted. Verifies measured `tree` equals published commit tree (`--no-replace-objects`), enforces `verifyProvenance`, enforces Rung-2 SSOT on all branches (`ssot-drift` warns on working branches, blocks on protected branches via `--strict`), and enforces single-destination remote resolution (`git remote get-url --push --all` must return exactly one URL; unknown or multiple URLs exit `2` naming both fixes).
- **Supported CI forges (`FORGES` in `lib/ci.mjs`)**:
  - `github.com` via `gh api --hostname <host>` with `GH_HOST` pinned.
  - AWS CodeCommit via `aws sts` + `aws codebuild` for `codebuild/<project>` checks with canonical `codecommitHost(region)`, pinned region, stripped endpoint overrides, and STS caller account binding (D-0053).
  - Every reading names `forge`, `host`, `repository` (plus `region`, `account` for CodeCommit), and `source` (`live` / `injected` / `from-json`); `http(s)` push URL userinfo is redacted to `***`. Unsupported hosts are unreadable CI (exit `2`).
- **Protected-branch convergence**: requires either a committed Judge hand-off + matching trajectory row (`VERDICT: CONVERGED`, `ACCEPTANCE: pass`) OR an independent no-dispute Critic hand-off (`VERDICT: PASS` or `CONVERGED`, `ACCEPTANCE: pass`, `DISPUTES: -`, `OPENED: -`, `audit.violations === 0`, covering every unjudged wave Actor under `judgeIndependence` with no contradicting trajectory row; D-0064 T10) on the pushed SHA, its `VERSION`-only ancestor (D-0009 item 2), or its same-tree second parent.
- **`bench-gate.mjs`**: clean worktrees for `--base` and `--candidate`, warm-up then alternating pairs, every run exit `0` meeting `--require`, distribution-free one-sided upper bound (`--confidence`, default `0.95`) of median per-pair ratio `<= --max-ratio`.

### Convergence Independence (`judgeIndependence`, `D-0068`)

Prior converged waves are authenticated against the historical `judgeIndependence` policy committed in `records/loop.json` when that wave's certifying hand-off, trajectory row, and view commit were recorded. Current wave certification requires every certifying Judge or independent Critic and every unjudged covering Actor above `provenanceBaseline` to satisfy `loop.json` `judgeIndependence`:
- `"vendor"` (default): distinct vendors and distinct models, with single-model runtime observed telemetry (`observedModels` / `observedModel`; fails closed on missing/`null`, unknown, or multi-model observations).
- `"model"`: distinct case-insensitive normalized models with known vendor (via built-in model families, router prefix stripping such as `openrouter/gemini-2.5-pro` -> `gemini-2.5-pro`, `loop.json` `modelVendors`, or explicit `agent.vendor`) and single-model observed telemetry across all runners.
- `"session"`: distinct non-empty sessions across Judge/Critic and covering Actors (permitting same-model/same-vendor certification across genuinely separate sessions when rate limits leave one model available, while failing closed on missing or shared session).
- Any unrecognized value fails closed.

---

## 4. Runner, Harness & Hook Protocols (T3, Paseo, Antigravity, Claude)

### Decoupled Agent Configuration (`D-0066`, `D-0068`)

Each role in `loop.json` configures:
`{ "runner": "t3" | "paseo" | "claude" | "codex", "provider": "<any non-empty string>", "adapter": "antigravity" | "claude" | "codex" | "generic" (optional), "model": "<id>", "effort": "<level>", "vendor": "<optional>" }`.

- `resolveAdapter` infers `"antigravity"` (`*antigravity*`, including `better-paseo-antigravity`), `"claude"` (`*claude*`), or `"codex"` (`*codex*`), or falls back to `"generic"` for any other provider (`pi`, `cursor`, `opencode`, `gemini-cli`, custom Paseo plugins). Explicit `agent.adapter` overrides inference.
- **Frame reviewer confinement**: runs on Claude CLI (`--restricted`, file tools only) or on `t3` / `paseo` with non-`codex` adapters (`antigravity`, `claude`, or explicit `adapter`) with fail-closed confined transcript auditing (`auditAccess([ws])`, file tools only). Codex CLI and any `codex`-adapter prepared role are refused for the frame reviewer.
- **Prepared child workflow (`runner: "t3" | "paseo"`)**:
  1. `call.mjs ... --prepare` enforces every gate, builds workspace/worktree, writes `t3-prompt.md` (with nonce) and `call.json`, and prints `{ id, ws, wt, nonce, prompt, target }`.
  2. Launch one child with `t3-prompt.md` verbatim:
     - **T3 (`runner: "t3"`)**: `delegate_task` with `target` and `prompt` (full access when running real product tests).
     - **Paseo (`runner: "paseo"`)**: `create_agent` (`mcp_paseo_create_agent` / `mcp__paseo__create_agent`) passing `provider` and verbatim `t3-prompt.md` as `initialPrompt`.
  3. Record with `call.mjs <config> record --ws <ws>`. `--session` is optional when the nonce uniquely matches one transcript (`resolveChildSession` fails closed on `0` or `> 1` matches; Codex transcripts auto-discover by nonce under `~/.codex/sessions/`; Antigravity scans `ANTIGRAVITY_HOME`, `ANTIGRAVITY_APP_DATA_DIR`, `GEMINI_HOME`, and T3 instances and requires untruncated `transcript_full.jsonl`; `generic`-adapter providers record via `--transcript <file>` and `--session <id>`).
  4. **Paseo envelope unwrapping**: for Paseo-launched Antigravity children, a single well-formed outermost `<paseo-system ... kind="agent-message">...</paseo-system>` envelope is stripped with single-pass XML entity unescaping (`&amp;`, `&lt;`, `&gt;`, `&quot;`, `&apos;`, `&#39;`); non-`agent-message`, malformed, unclosed, concatenated, or trailing-text envelopes fail closed.
  5. **Authentic provenance**: `metrics/handoffs.jsonl` records `runner: "<runner>:<provider>"` (e.g. `paseo:better-paseo-antigravity`).
  6. **Cancellation**: `call.mjs <config> cancel --ws <ws> --reason "<text>"` removes the worktree and frees `G3` / `Load N`. Unstarted prior-round workspaces with dead PIDs expire automatically from `preparedIn`.

### Lead Hooks (Antigravity & Claude Code)

- **Antigravity hooks** (`assets/antigravity/hooks.json`, workspace `.agents/hooks.json` excluded via `.git/info/exclude` or global `${GEMINI_HOME:-~/.gemini}/config/hooks.json`; honors `ANTIGRAVITY_HOME`):
  ```bash
  node scripts/self-loop.mjs hooks install|check|uninstall --harness antigravity [--scope workspace|global] [--all | --config <loop.json>] [--owner-store <dir>]
  ```
  Global `--owner-store <dir>` binds `SessionStart`, `PreInvocation`, `PreToolUse`, and `Stop` dynamically across all registered products (including products added later via `registry add`).
- **`lead-guard.mjs` (`PreToolUse`)**:
  - Extracts write targets strictly from tool-defined path fields (`extractStructuredToolPaths`, decoding `file://` URIs without scanning content/body text; fails closed when no structured destination is present or stdin is malformed).
  - Refuses any structured delegation tool (`delegate_task`, `Agent`, `spawn_agent`, `invoke_subagent`, `t3_thread_launch`, `create_threads`, `run_workflow`, `swarm`, `create_agent`, `mcp_paseo_create_agent`, `mcp__paseo__create_agent`) whose prompt (`initialPrompt` included) lacks a live unrecorded `call.json` nonce (Lead cross-product `mcp_paseo_send_agent_prompt` remains allowed, while `audit-access.mjs` refuses bare `create_agent` and all Paseo MCP tools in non-lead role transcripts).
  - Confines confirmed delegated children (including Paseo-wrapped children) to `<ws>/out/**` (plus `<ws>/wt/**` excluding `.git` for `critic`/`actor`).
  - Narrows Lead workspace writes strictly to `<workDir>/tasks/**`, blocks product edits outside `--allow`, and blocks `git push` hook-bypass flags (`--no-verify`).
- **Claude Code `.claude/settings.local.json` hooks**:
  ```json
  {
    "hooks": {
      "UserPromptSubmit": [{
        "hooks": [{ "type": "command", "command": "node '/abs/self-loop/scripts/owner-words.mjs' capture --records '/abs/records' --project '/abs/product,/abs/lead-checkout'" }]
      }],
      "PreToolUse": [{
        "matcher": "Edit|Write|MultiEdit|NotebookEdit|Bash",
        "hooks": [{ "type": "command", "command": "node '/abs/self-loop/scripts/lead-guard.mjs' --product '/abs/product' --workspaces '/abs/workspaces'" }]
      }]
    }
  }
  ```

---

## 5. Comment Admission v2 (`D-0016`, `D-0023`, `D-0064` T1/T10)

`scripts/lib/comments.mjs` owns admission at `critic`/`actor` hand-off and phase close:
- Whole-source ECMAScript parsing and deterministic multi-language lexers (`scripts/lib/lexers.mjs`, `lexers-cfamily.mjs`, `lexers-extra.mjs` covering JS/TS/JSX, Python, Swift, Shell, YAML, CSS, HTML, SQL, Go, Rust, C/C++, Java, Kotlin, TOML) establish comment spans in `< 1ms`.
- Comment-free files, documented tool directives (`scripts/lib/directives.mjs`), and pure record/design pointers (`D-NNNN`, `R-NNNN-*`, `W-<10 hex>`, `design/<file>.md#<anchor>`) admit automatically without spawning LLM micro-audits.
- Real added prose comments fail deterministically with line/text diagnostics. Unsupported syntax or unavailable parsing falls back fail-closed to independent whole-file review; unknown extensions stay outside `languageOf`.
- When whole-file review is required, `call.mjs` retains `<step>-<k>-comments.json` and exits `7` while added candidates are pending or judged prose. Dispatch an independent judge with the frozen source and candidates; its `out/comment-resolutions.json` copies every identity field and supplies verdict + authoritative evidence (`RECORDS.md`, Comment resolution), then retry `record --ws` on unchanged source.
- A judge's prose finding remains a refusal even against a competing approval; any source-byte or identity change invalidates its resolution; a known author session cannot approve. At phase close after `reviewer-subtraction`, both unresolved review and established prose prevent zero-prose convergence.

---

## 6. Phase State, Host Load, Advancing Cadence & Measures (`loop.mjs`)

- **Integration SHA**: derived from records (D-0015 item 5) as the latest judge/critic trajectory row's `commit`, advanced along a single linear chain to the newest phase hand-off commit recorded after that row. Diverged heads print merge commands; `next` reads and never moves a ref. CI is read on the trajectory row's `VERSION` tip, else `loop/<phase>` tip, else the integration SHA.
- **Host load bound (`lib/host.mjs`, `lib/thresholds.mjs`, D-0025, D-0029)**:
  - `next` prints `Load N` listing unrecorded prepared workspaces with live worktrees across the owner store + loop, live `call-*` leases, and live `suite-*` leases (shown, never the cap; `heavyBudget` is ignored).
  - Suggests heavy calls (`critic`, `actor`, `judge`, `suite`) only while 1-minute load average `<= maxLoadRatio * cores` (default `0.7`) AND available memory (`os.freemem()`, Linux `MemAvailable`) `>= minAvailableMemoryGB` GiB (default `min(16, totalmem/4)`). Both are overridable in `products.json`. Over the bound, prints `Host over the bound` and waits while reviewer calls, `record`, and CI reads stay available.
- **Advancing-round cadence (`lib/cadence.mjs`, D-0032)**:
  - An advancing round holds `reviewer-frame` (or `reviewer-frame-<word>`) and `judge-frame`. Adversarial rounds count phase judge rows with a verdict once per round (never an advancing round's own row).
  - Reaching `cadence.adversarial` (default `3`, positive integer; invalid exits `64`) prints `advancing round due` with its three calls (`reviewer-frame-blind`, `reviewer-frame`, `judge-frame`) and withholds convergence (screening, refuses no call). `Returns per area` lists blockers opened/closed/shelved per judged round; areas whose returns fall steeply are left for new features while their blockers stay open until closed or shelved.
- **Measures header (A4)**: printed at the top of `next` and `start` from `phaseMetrics` and `measurePlan` (`owner directions`, `raised first`, `precision of batch answers`, `owner waiting`, per-plan `critical path · idle dispatchable · owner waiting`). Unknowns print `unknown` with reason, never `0`; no target, alarm, or gate rests on them. Quote verbatim in phase-close reports.
- **`loop.mjs stall`**: exits `2` when unfinished features (or none) have elapsed `>= N` hours since the last phase blueprint event, hand-off, judge ruling, or owner batch answer.

---

## 7. Time Budgets (`plan-time/v2`, `plan-forecast/v1`) & Normal-Opportunity Alarms

- For plans with a `plan-time/v2` baseline, `plan.mjs measure`, `self-loop.mjs next`, and `self-loop.mjs start` render time projections without publishing forecasts or launching work (`RECORDS.md`, Forecast observation). Checkpoints request cadence; they create no autonomous wake.
- Ordinary entry captures one system UTC clock. `--now <UTC ISO ending in Z>` selects a read-only labelled simulation (cannot combine with `--parent-entry`). Elapsed time is nonnegative or unknown; remaining time is signed (`0` due now, negative overdue); clock anomalies yield unknown rather than resetting budgets.
- Historical ETAs stay fixed at their pinned `basedOn` cut; later completions may make an old forecast stale without recalculating it. Root clock, deadline, and missed-checkpoint history survive forecast refresh, cancellation, and restart. Deadlines never weaken quality gates.
- **Positive-evidence contract** (`RECORDS.md`, `f81d0e8:evidence/0012/admitted-positive-final/`): separate Scope assessment, Release assessment (exact candidate + all gates + usable availability), and Event attesting actual occurrence, carried in immutable Evidence paths. Verified availability and verified time are separate; missing evidence stays unknown and never blocks ready work.
- **Alarm occurrences**: normal-opportunity views display committed alarm occurrences and applicability/diagnosis metadata separately from exact-version disposition status; unknown metadata leaves other ready work visible, and source-null tombstones do not waive live canonical diagnoses.

---

## 8. Multi-Product Registry, Heartbeat & Setup (`self-loop.mjs`)

- **Owner store**: `--owner-store`, else `SELF_LOOP_OWNER_STORE`, else `~/.self-loop/owner-store`, holding `products.json` (`name`, `records`, `aliases`, `roots`).
- **Config resolution**: `--config`, else `SELF_LOOP_CONFIG`, else `<git-toplevel>/.self-loop/loop.json`, else registered product matching `cwd` (its records, product checkout, or `projects`). None or multiple candidates exit `64`.
- **`tick`**: runs `stall` and `next` for every registered product; commits durable stall alarms (`metrics/alarms.jsonl`, once per idle period, default `tick.stallHours: 12`); reports `idle` ready packages (A3), `unchecked-release` word holds, missing records/`no loop`, unregistered `records.json` repos under `roots` (bounded by `ROOT_SCAN_FOLDERS`), and scan errors. Exit `0` quiet, `2` findings. `tick.onStall` is `show` (default) or `resume` (D-0003).
- **`start`**: strictly read-only summary across all registered products (live stalls, `tick` findings, Antigravity hook health probe `hooks: { healthy, findings }`, read-only hygiene screening `session.hygiene`) plus this session's `next`. Never mutates files or `git config`. Exit `0`, `64` usage.
- **`clean` / `prune` / `records gc` / `records compact` (`F-0015`)**: unified operational hygiene (`--dry-run` by default; pass `--apply` to mutate). Runs `pruneAndCompactRecords()` (`P1–P6` protection, `prune/PR-NNNN.md` cryptographic tombstones, in-place `> 1 MiB` audit compaction), `cleanWorkDir()` (deleting expired/terminal `<ws>` tombstones & `.prepared/` sidecars), `pruneSuiteStore()` (evicting unpinned receipts, dangling `.code-tree/` refs, and expired `.gen/` dirs), and (on `--apply`) installs portable `<records>/.githooks/pre-commit`.
- **`hooks install --records <dir>`**: installs portable, secret-free `<records>/.githooks/pre-commit` (`records-check.mjs --repo "$REPO_ROOT" --staged`) and sets local `core.hooksPath=.githooks`.
- **Sub-2s fast diagnostics**: routine `loop.mjs next` / `self-loop.mjs next` runs `records-check` in `{ fast: true }` mode, caches `collectArchFacts` and `proseInTree` by tree OID, bounds uncached pre-subtraction `proseInTree` (`2000` files / `1500ms`), and uses `O(1)` `${round}/${step}` audit lookup via `buildSharedPlanContext`; pass `--full` for complete historical screening and unbounded prose scanning.
- **`heartbeat install`**: installs hourly OS schedule (launchd on macOS, cron elsewhere) pointing strictly to a plain `X.Y.Z` release worktree detached at `v<VERSION>` (prereleases `X.Y.Z-<pre>` are refused as live installs).
- **One-time product setup (`self-loop.mjs init`)**: creates Git-ignored `<product>/.self-loop/` (`.gitignore` or `--local-exclude` `.git/info/exclude`, or external `--records <dir>`; refuses tracked paths fail-closed), installs `.githooks/pre-commit`, and commits `README.md`, `records.json`, `loop.json`, `.gitignore`, `.githooks/pre-commit`, `INDEX.md`; add `--register` to register in owner store. Keep held-out cases and backtest keys in a **separate** sealed repo given only to `judge`.

---

## 9. Owner Words, Interventions & Metrics (`owner-words.mjs`)

```bash
node scripts/owner-words.mjs capture|sync --records <records> --project <dir>[,<dir>...]
node scripts/owner-words.mjs sync --owner-store <dir>
node scripts/owner-words.mjs open --records <records> [--hints] [--json]
node scripts/owner-words.mjs pending --records <records> --discard <key> --note "<why>"
node scripts/owner-words.mjs mark --records <records> --id <W-id[,W-id2]> | --ids <W-id,W-id2> --as direction --intervention I-NNNN [--note "<why>"]
node scripts/owner-words.mjs mark --records <records> --id <W-id[,W-id2]> | --ids <W-id,W-id2> --as answer --batch B-NNNN [--note "<why>"]
node scripts/owner-words.mjs mark --records <records> --id <W-id[,W-id2]> | --ids <W-id,W-id2> --as routine|not-owner --note "<why>"
node scripts/owner-words.mjs metrics --records <records> [--phase <phase>] [--json]
```

- **Envelope filtering**: deterministically skips T3/harness relays (`Delegated task node:delegated-task:`, `[T3 Code: the agent in T3 thread`, index-0 `[T3 Code: scheduled task "..."]`, `<CONTEXT_SUMMARY>`, `<SYSTEM_MESSAGE>`, leading `<chat-history-summary>...</chat-history-summary>` blocks, whole-message single/batched `<paseo-system ...>` `agent-notification`/`agent-message` envelopes while keeping Lead sessions open and preserving human prose mentioning them). Antigravity `PreInvocation` deduplicates strictly against active unresolved pending entries at the current transcript user step.
- **Classes (`owner/word-marks.jsonl`)**: `direction` (settled only once `interventions/I-NNNN.md` is committed), `answer` (`--batch B-NNNN`), `routine`, `not-owner`. Supports atomic multi-ID batch marking (`--id a,b`, `--ids a,b`, repeated `--id`) while preserving `UsageError` (`exit 64`) on unknown/conflicting marks; `open` prints read-only verbatim-quote `W-id -> record` hints and routine check-in batch commands without auto-discarding words. Substantive open owner words (`isSubstantiveOwnerWord`) trigger `reviewer-distill` and refuse `plan.mjs validate` and `call.mjs critic|actor` immediately (exit `7`, 0-turn grace per `D-0060`).
- **Interventions (`interventions/I-NNNN.md`)**: carry `words:`, frame/reframe/general question, `raised-first: <record ID | no>` (checked by `records-check.mjs` against first-adding commit timestamp strictly predating every cited word's capture time), `rung: <construction | hard gate | screening predicate | question bank | owner-only>`, and `carried-by: <mechanism | PREDICATES id | none: why>` (`PREDICATES` in `scripts/loop.mjs`: `stall`, `advancing-round-due`, `idle-packages`, `open-words`, `area-rounds`, `blocker-recurring`, `partly-closed`, `ci-not-green`, `ci-absent`).
- **`metrics` (`phaseMetrics` in `scripts/lib/owner-metrics.mjs`)**: computes settled counts, `ownerDirections`, `raisedFirst`/`raisedFirstShare`, replay `wouldHaveFired` + false alarms (A2), `batchesSent`/`batchesAnswered`, `ownerWaiting`, `answersByOutcome`/`precision`, and `unclassified`.

---

## 10. Planning, Dispatch & Integration Engine (`G1–G7`, `P-0012`, `D-0059`, `D-0063`)

- **Plans (`plans/PL-NNNN.md`)**: one revision-linked plan per phase and scope. Each package declares authority (committed decision or judge ruling; never bare `by:lead` or staged records), goal, `files:` (whole-file paths, trailing-slash dirs, or globs; empty `files:` is read-only), `interface:`, `needs:`, role/settings, acceptance, and hand-off ID.
- **Ownership & sequential sharing (`D-0063`)**: concurrent/unordered packages (`!reaches(A, B) && !reaches(B, A)` over in-plan `needs:`) must never overlap `files:`, including independent branches at different depths. Transitively `needs:`-ordered packages (e.g. `critic-initial -> actor -> critic-post-actor`) may edit the same living domain file in place, serialized by `writer` holds and `G2`/`G3`.
- **Cross-plan single writer (`admitAcrossPlans`)**: `plan.mjs ready` and `loop.mjs next` reconcile all current plans of the phase together in plan ID and package order so no single reading offers two overlapping writers.
- **Recorded holds & idle screening (A3)**: `hold: <why>` + `release: <record IDs | capacity | ISO time>` holds silently while unmet; releases in prose wait as `unchecked-release` on every `next`/`tick`/`start` reading. Unstarted ready packages with no hold are surfaced as `idle`.
- **Dispatch Engine (`scripts/dispatch.mjs`)**:
  - `analyze`: joins `plan-globs.mjs` with `arch-facts.mjs` (`buildImportGraph`) to classify pairs as `decoupled`, `interface-coupled` (permitted concurrently when both `interface:` cite committed contracts), `undeclared-coupled` (refused concurrently), or `write-coupled`, and computes Critic `reviewCoverage` (`unified` vs `parallel`).
  - `waves`: computes topological waves, parallel Actor fan-out batches, pipelined/post-merge Critic batches, integration status, and Judge barrier reasons.
  - `integrate [--wave N] [--dry-run | --apply]`: verifies pairwise diff disjointness across landed Actor/writing-Critic commits and folds conflict-free heads via `git merge-tree --write-tree` into a clean multi-parent merge commit on `cfg.branch` (CAS ref update, working tree untouched).
- **Hard Gates `G1–G7` (`call.mjs --plan PL-NNNN --package <id>`, exit `7`)**:
  - **G1**: valid non-superseded plan/package contract.
  - **G2**: completed DAG `needs:` and answered `B-NNNN` batches.
  - **G3**: live writer glob disjointness across active workspaces/leases.
  - **G4**: undeclared import-coupling refusal against live peer Actors.
  - **G5**: per-package write confinement (`package.files ∩ cfg.owns[role]`) with path-level peer write refusal (`inPkg` evaluated before `peerHits`).
  - **G6**: host capacity & parallel decomposition alignment.
  - **G7**: Judge join barrier (`judgeLineageProblems`) requiring every landed Actor and writing-Critic commit merged into `--base`, every post-actor Critic's `product.base` descending from its ordered prerequisite Actor commits, and all covering Critics recorded outside window `slack`. Records `dispatch: { plan, package, files }` in `metrics/handoffs.jsonl`.

---

## 11. Supervision, Windows, Outer Loop, SSOT & Phase Close

- **Trajectory alarms (`trajectory.mjs alarms`)**: area in `>= 3` rounds; blocker class with `>= 2` distinct openings (carried blockers excluded, D-0024); `partly-closed` (`>= 2` rulings with earlier non-shelved blockers still open, L-0002); `ci-not-green`; `ci-absent`; watched module growth. New or grown alarms require `reviewer-diagnosis` (`PREMISE:` / `OBSERVATION:`) before the next adversarial call.
- **Bounded Horizon Window (`window.mjs`, `metrics/windows.jsonl`)**: `open --horizon <2..12>` (at most one open window per phase, no silent extension) grants `H - 1` `slack` actor rounds, 1 `converging` round, then `gate-due` (refusing further `actor` calls exit `7` while `critic`/`judge`/`reviewer` remain open). Phase convergence is blocked while open. Close via `window.mjs close --verdict verified` (committed independent Critic or Judge convergence + green suite + green CI) or `--verdict reframed` (after `reviewer-diagnosis` citing `alarms: window-horizon:<phase>:<id>`). A `CONTINUE` ruling inside a window raises `window-horizon:<phase>:<id>`.
- **Async Outer Loop (`arch-facts.mjs`, `anti-rot.mjs`, `reviewer-architecture`, `T1–T4`, P-0011, D-0058)**:
  - Computes `largestFiles`, `growthFiles`, `churnHotspots`, `importHubs`, `parallelSiblings`, and `antiRot` (`compatRemnants`, `deadExports`, `hardcodedLiterals`, `testRot`, `commentBloat`).
  - `T1`: periodic delivery cadence (`cadence.deliveries`, default `4` actor rounds); `T2`: phase/milestone boundary; `T3`: structural/anti-rot breach (`> 800`L, `>= 35%` growth from `>= 100`L, churn accompanied by structural degradation — healthy shrinking refactors never hard-block per D-0064 T8 — plus anti-rot breaches); `T4`: window-horizon / trajectory alarm stop.
  - Emits async read-only `reviewer-architecture` (`FILE_TOOLS` on `[ws, wt]`, zero Bash, zero writes to `wt`, Codex refused). After `cadence.outerGrace` (default `2`) deliveries outside a window (or delta-scoped `T3`), `call.mjs actor` refuses exit `7` (narrowed to hotspot-intersecting packages while an async `reviewer-architecture` is active).
- **SSOT checks (`ssot-check.mjs`, F-0014, D-0057)**: Rung-2 (`missing-doc`, `anchors`, `check` in clean detached worktrees) gates every branch push; Rung-3 `ssot-drift` warns on working branches and blocks protected pushes and `CONVERGED`/`PASS` trajectory appends under `--strict`. Attest entries via `ssot-check.mjs attest`.
- **Phase close**: (1) `reviewer-subtraction` pass + subtraction rounds until zero prose comments and every requirement retains mechanism + test; (2) protected promotion via `gated-push.mjs`; (3) rule -> code -> test traceability check; (4) converged rules into authoritative docs; (5) `lessons/L-NNNN.md` (`applies-to: skill|product|both`); (6) Owner report quoting `next`'s `Measures` header verbatim.
- **Supervised incremental release (`4a`, candidate under `D-0041`)**: bounded route alongside native convergence (`design/scoped-release.md`); requires separate root exact-bootstrap admission (`ir-admission/2`), fresh cross-vendor `SCOPE_CONVERGED` (`external-release-certificate/2`), exact full-suite/log, live dual-platform Linux/macOS CI, isolated Linux/macOS `BASE` replay, atomic host authority publication (`version-gate.mjs release`), and pre-switch `DELTA` owner-word replay with no-rewind rollback.

---

## 12. Owner Interface & Intent Batches (`decisions.mjs`)

- Questions come from Judge and Frame Reviewer in `out/decisions.json` and must pass `decisions.mjs validate` (question, `>= 2` distinct options, recommendation, no duplicates).
- **Generation-Engine-First Sender Gate (`I-0005`, `F-0015`)**: `decisions.mjs send` hard-refuses (`exit 2`, `refused:`) unless `--from` matches `/^R-\d{4}-(?:reviewer|judge)(?:-[a-z0-9-]+)*$/`, and emits a non-blocking `screening:` notice if `metrics/handoffs.jsonl` lacks that hand-off ID. Never ask the owner derivable engineering questions before running `P-NNNN` + `reviewer-frame` / `reviewer-distill` + `judge-frame`.
- **Intent batches (`D-0031`)**: `{ "kind": "intent", "requirement": "P-NNNN", "questions": [...] }` with `whyAsked`, dependency-ordered 1-based `dependsOn`, and `ifOther` mapping alternate options of the depended-on question. `send` allows at most one intent batch and one follow-up per requirement per phase (a third exits `2`).
- **Answers & replacement**: `decisions.mjs answer --records <r> --batch B-NNNN --words "<verbatim>" [--outcome as-recommended|amended|other]` preserves owner text verbatim (invalid `--outcome` exits `64`). When a later answered batch re-asks and names an earlier batch, close the earlier one with `decisions.mjs replace --batch B-NNNN --by B-MMMM --note "<why>"`.
- **Question-bank updates**: distill general questions from `interventions/I-NNNN.md` into `engines/frame-reviewer.md` and re-score on held-out backtests (`scripts/backtest.mjs`, sealed keys, blind cross-vendor grader).

---

## 13. Full Enforcement Ladder Details & Portability

Every rule sits on the highest rung it can reach. Hard-gate admission requires both directions of proof in `scripts/test/` (turns a recorded real defect red, keeps legitimate historical samples green); un-admitted candidates stay screening.

- **Rung 1 — Construction**: OS-scheduled `tick` from plain `X.Y.Z` release worktree; append-only owner-word capture/sync; fresh isolated workspace per call; allow-listed public views & sealed Judge records; confined frame reviewer (`claude --restricted` or audited `t3`/`paseo` non-`codex`); atomic single-tree hand-off commits; owned product paths only; single-source `loop.json` push config (`protected`, `gates.require`, `gates.remote`, redacted URLs); `version-gate.mjs tip` `VERSION`-only CAS commits; `codeTree` + runtime suite caching and leases; records-derived integration SHA & CAS branch fast-forward; `lib/blockers.mjs` disjoint blocker state lists (`opened`/`closed`/`shelved`/`carried`).
- **Rung 2 — Hard gates**: exact-SHA green suite & `codeTree` verification (`--no-replace-objects`); `bench-gate.mjs` paired median bound; live forge-pinned CI (`github.com`, CodeCommit/CodeBuild) with single-destination remote enforcement; protected-branch convergence (Judge `CONVERGED` or independent no-dispute Critic `PASS`/`CONVERGED` under `judgeIndependence`) and strict SSOT; `call.mjs` access audit, frame prerequisite, alarm-diagnosis gate, 0-turn open substantive owner-word gate, `G1–G7` dispatch/lineage gates, and deterministic `lib/comments.mjs` admission; `records-check.mjs` index/blueprint/blocker-bar (`D-0018` `flow:`/`loss:`)/`raised-first:` checks; `decisions.mjs` intent-batch & outcome validation; `plan.mjs validate`; `lead-guard.mjs` `PreToolUse` confinement & nonce gate.
- **Rung 3 — Screening**: trajectory alarms (`area-rounds`, `blocker-recurring`, `partly-closed`, `ci-not-green`, `ci-absent`, module growth); `loop.mjs` / `self-loop.mjs` host load bounds (`maxLoadRatio`, `minAvailableMemoryGB`), advancing cadence & returns per area, `Measures` header, idle-package & unchecked-release holds, missing intervention dispositions, `arch-facts` anti-rot & shrinking-safe churn, `owner-words.mjs metrics` replay & false-alarm counts, multi-product `tick` stalls & unregistered-repo discovery, `audit-access.mjs` shell-path & `duplicateSuiteRuns` screening.
- **Rung 4 — Model judgment**: Lead task authoring, parallel track scheduling, and escalation decisions; Frame Reviewer diagnoses & proposals; Judge dispute arbitration & derivation rulings.
- **Rung 5 — Prose**: tracked in `DEBT.md` and shrunk each phase.

**Elsewhere**: the procedure is plain text; point another tool's rules file (`AGENTS.md`, Cursor rules) at `SKILL.md`. Without `call.mjs`, spawn each role from its brief with a fresh agent and allow-listed view, and run the same gates. Full unit suite: `node --test scripts/test`.
