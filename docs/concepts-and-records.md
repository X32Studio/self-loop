# Concepts, Records, and CLI Reference

This guide is a human-readable companion to [`RECORDS.md`](../RECORDS.md) (the normative schema parsed directly by [`scripts/records-check.mjs`](../scripts/records-check.mjs)) and a quick reference for day-to-day CLI commands.

## How the Records Repository Works

Every product loop maintains its own Git repository of records (by default nested at `<product>/.self-loop/` and git-ignored by the product repo, or placed externally via `--records <dir>`).

Three rules keep records trustworthy across long-running phases:

1. **Every file belongs to a declared kind** — `records-check.mjs` parses the layout table in [`RECORDS.md`](../RECORDS.md) (plus optional `extraKinds` in `records.json`) and fails on undeclared tracked files.
2. **History belongs in Git, not inside mutable prose** — Current-state files (`design/<area>.md`, `blueprint/F-NNNN.md`) describe *only* the current state; append-only ledgers (`*.jsonl`) and immutable records (`D-NNNN`, `R-NNNN-*`, `B-NNNN`, `PL-NNNN`, `evidence/`) provide auditability.
3. **Generated indexes never drift** — `INDEX.md` and `BLUEPRINT.md` are generated deterministically by `records-check.mjs --write` and verified read-only by `records-check.mjs`.

## Record Kinds at a Glance

| Directory / File | Kind & Mutability | Cited As | What It Holds |
|---|---|---|---|
| `purpose/P-NNNN.md` | **Purpose** (append-only) | `P-NNNN` | Dated phase/product requirements distilled from owner words (carrying a `words: W-...` header line). |
| `decisions/D-NNNN.md` | **Decisions** (immutable) | `D-NNNN` | Decisions by `owner`, `lead`, or `judge`. Changed only by a newer decision with `supersedes: D-NNNN`. |
| `blueprint/F-NNNN.md`<br>`metrics/blueprint.jsonl`<br>`BLUEPRINT.md` | **Blueprint** (editable)<br>**Feature status** (append-only)<br>**Blueprint view** (generated) | `F-NNNN` | Feature definitions (requirements, rationale, design/acceptance pointers — never inline status). Status (`planned`, `designing`, `building`, `done`, `retired`) lives strictly in `metrics/blueprint.jsonl` via `blueprint.mjs set`. |
| `design/<area>.md` | **Design** (editable, current state only) | `design/<area>.md@<commit>` | Maintained by `call.mjs` from the Actor's `out/design/<area>.md`. Never holds "Round N" history sections; conflicts are preserved in evidence and screened. |
| `plans/PL-NNNN.md` | **Plan** (immutable; revised via `supersedes:`) | `PL-NNNN` | Dependency-ordered work packages with disjoint file ownership, authority IDs, role settings, expected hand-off IDs, and optional `hold:`/`release:` conditions. |
| `rounds/NNNN-<role>.md`<br>`metrics/handoffs.jsonl` | **Rounds** (immutable)<br>**Hand-offs** (append-only) | `R-NNNN-<role>` | Verbatim task + report written by `call.mjs` (for `judge`, only `out/public.md`). Each successful call appends one factual JSON line to `metrics/handoffs.jsonl` (never a verdict). |
| `metrics/trajectory.jsonl`<br>`metrics/alarms.jsonl`<br>`metrics/ssot-sync.jsonl` | **Trajectory** (append-only)<br>**Alarms** (append-only)<br>**SSOT sync** (append-only) | Line by round / key / entry ID | `trajectory.jsonl` records each Judge ruling (`verdict`, `opened`/`closed`/`shelved`/`carried` blockers, `suite`, `commit`, optional `tip`, and auto-read `ci` + `ciReceipt`). `alarms.jsonl` records stall episodes written by `tick`. `ssot-sync.jsonl` records cross-repo authority doc syncs and one-shot `no-contract-change` attestations written by `ssot-check.mjs attest`. |
| `evidence/NNNN/` | **Evidence** (immutable) | Path + SHA-256 | Per-attempt gzipped logs, `*-audit.json` access audits, role `out/` artifacts, `*-comments.json` prose candidates, `suite-*` receipts, `bench-*` receipts, and `ci-<sha12>-<n>/receipt.json` readings. Failed attempts are preserved here. |
| `sealed/` | **Sealed** (immutable, restricted) | Path at commit | Judge private full rulings (`sealed/judge/NNNN/<step>-<attempt>.md`, logs, audits) plus held-out acceptance suites. Readable **only** by Judge and Lead; excluded from all other role views by construction. |
| `owner/words.jsonl`<br>`owner/word-marks.jsonl` | **Owner words** (append-only)<br>**Owner word marks** (append-only) | `W-<10-hex>` | Verbatim owner utterances captured by hooks or transcript `sync`, plus latest classification marks (`direction`, `answer`, `routine`, `not-owner`). |
| `owner/B-NNNN.md`<br>`owner/answers.jsonl` | **Owner batches** (immutable)<br>**Owner answers** (append-only) | `B-NNNN` | Structured question batches (options + recommendation; intent batches add `kind: intent`, `requirement: P-NNNN`, `whyAsked`, `dependsOn`, `ifOther`) and verbatim owner answer or replacement events. |
| `interventions/I-NNNN.md` | **Interventions** (append-only) | `I-NNNN` | Logs each owner direction/reframe outside a batch (`words:`, `raised-first:`, `rung:`, `carried-by:`) to feed question banks and measure owner-attention trends. |
| `lessons/L-NNNN.md` | **Lessons** (append-only) | `L-NNNN` | Post-phase lessons with `applies-to: skill / product / both` and the concrete change each produced. |
| `engines/<role>.md` | **Engines** (versioned) | At commit | Project-specific role briefs read from the committed view commit on every `call.mjs` run. |

For additional specialized kinds (`Backtests`, `Research`, `Forecast observation`, `Continuation delivery`, `Normal-entry inventory`, `Blueprint evidence`), see [`RECORDS.md`](../RECORDS.md).

## Citation & Code-Comment Discipline

- **Cite by ID or commit**: Reference records by ID (`D-0018`, `R-0005-judge`, `W-0123456789`), mutable files at a commit (`src/parser.mjs@a1b2c3d`), and evidence by path + `sha256:<64-hex>`. Bare `file:line` references drift and are flagged by `records-check.mjs`.
- **No prose comments in product code (`D-0016`)**: Comments in product source files must be either **pointers** (record IDs or `design/<area>.md#<anchor>` / `docs/<file>.md#<anchor>`) or **documented tool directives** (shebangs, TypeScript/ESLint/Prettier/coverage/SPDX directives in `scripts/lib/directives.mjs`). `call.mjs` gates added/modified comments at Critic/Actor hand-off, and after `reviewer-subtraction`, zero prose comment lines at the integration SHA is required for phase close.

## SSOT Authority Documents

When `loop.json` declares an optional `ssot` block (`D-0057`), `self-loop` binds each domain's single authoritative document to watched product paths across two deterministic rungs (repos without `ssot` experience zero behavior change):

- **Rung-2 Hard Gate (`exit 2` on `ssot-check.mjs` and every `gated-push.mjs`, including working branches)**: verifies that every `entries[].doc` exists as a regular tracked file (`missing-doc`), checks declarative `anchors`, and runs any custom `check` command in clean detached worktrees.
- **Rung-3 Drift Screening (`ssot-drift`)**: detects commits touching `watch` (minus `ignore`) after the document's last touch (product repo) or latest valid receipt in `metrics/ssot-sync.jsonl` (external repo). Advisory on working branches (`self-loop.mjs next`, `trajectory.mjs alarms`, `records-check.mjs`, working-branch `gated-push.mjs` warnings); hard-blocks (`exit 2`) Judge `CONVERGED` rows in `trajectory.mjs append` and protected-branch `gated-push.mjs`. `mode` (`"same-batch"` or `"phase-close"`) is a display label; both share identical `D-0057` gate timing.
- **External repositories (`ssot.repos`)**: every path under `ssot.repos` resolves strictly relative to the directory containing `loop.json` (both relative and absolute paths undergo `realpath` validation refusing symlinks and repository escapes).
- **Role view injection (`call.mjs`)**: when `loop.json` configures `ssot`, `call.mjs` runs read-only evaluation (`runChecks: false`, never executing custom `check` commands or reading dirty working trees) at the base SHA and injects read-only `ssot-status.md` (`0444`) plus a one-line prompt pointer into `actor` and `judge` workspaces (both CLI `prompt.md` and T3 `t3-prompt.md`). `critic`, `reviewer`, and repositories without `ssot` are completely unaffected.

### `check` Command Environment Contract

Each entry's optional `check` command executes via `sh -c` inside a **clean detached product worktree** at the exact candidate `--sha` (and, when `repo !== "product"`, a second clean detached worktree of the external document repository at its committed `HEAD`). Live dirty working trees are never exposed. Five environment variables are injected:

| Variable | Value |
|---|---|
| `SELF_LOOP_SSOT_ID` | Entry `id` from `ssot.entries` |
| `SELF_LOOP_SSOT_DOC` | Repo-relative path of `doc` |
| `SELF_LOOP_SSOT_SHA` | Full 40-character product commit SHA being verified |
| `SELF_LOOP_SSOT_PRODUCT` | Absolute path to the clean detached product worktree at `SELF_LOOP_SSOT_SHA` (also the command's `cwd`) |
| `SELF_LOOP_SSOT_DOC_REPO` | Absolute path to the clean detached document repository root (`SELF_LOOP_SSOT_PRODUCT` for `"product"` entries; the clean detached external checkout—plus any declared subdirectory prefix—for `ssot.repos` entries) |

> **External-repo `check` scripts must read `$SELF_LOOP_SSOT_DOC_REPO/$SELF_LOOP_SSOT_DOC`**, never a hardcoded relative path into the live external working tree (such as `../design/...`). Reading the live working tree bypasses clean-checkout isolation and lets uncommitted edits pass Rung-2 checks.

### Built-In Declarative `anchors` Contract

Each object in `entries[].anchors` verifies one scalar fact between `doc` and a committed product file at `--sha` without external scripts:

- `name` *(required)*: unique non-empty one-line identifier within the entry.
- `docPattern` *(required)*: JavaScript regular expression string (compiled with `gm` flags) that must match **exactly once** in `doc` and expose capture group 1 (`match[1]`). Zero matches, multiple matches, or a missing capture group fail closed (`exit 2`).
- `source` *(required)*: safe product-relative path read strictly from the committed Git tree at `--sha`.
- `jsonPointer` **or** `sourcePattern` *(mutually exclusive; exactly one required)*:
  - `jsonPointer`: valid RFC 6901 pointer into JSON `source` (using own-property traversal; must resolve to a string, finite number, or boolean).
  - `sourcePattern`: JavaScript regular expression string (compiled with `gm` flags) that must match **exactly once** in `source` with capture group 1.

### `metrics/ssot-sync.jsonl` Receipts & `attest` Refusal Rules

`ssot-check.mjs attest` appends one JSON object per line to `metrics/ssot-sync.jsonl` and commits it atomically into records (validated by `records-check.mjs`):

- **Row fields**: `id`, `productSha` (40-hex), `docRepoSha` (40-hex), `disposition` (`"updated"` | `"no-contract-change"`), `entryDigest` (64-hex SHA-256 over `{ doc, repo, watch, ignore }`; changing or widening any of these invalidates prior receipts), `docBlobSha` (40-hex Git blob SHA of `doc`, recorded on `"updated"` rows), `reason`, `by`, optional `round` (positive integer), and `time` (UTC ISO-8601).
- **Three `attest` refusal rules (`exit 2`, nothing written)**:
  1. **Product entries refuse `updated`**: entries with `repo: "product"` cannot attest `--disposition updated`; commit the document change directly in the product repository or use `--disposition no-contract-change` (which expires on the next watched commit).
  2. **Committed & clean external document required**: for external-repo `"updated"` attestations, `doc` must have zero uncommitted or untracked changes in the external working tree (`git status --porcelain --untracked-files=all -- <doc>` must be empty) and exist as a regular tracked file at `HEAD`.
  3. **`docBlobSha` must change on `updated`**: an external-repo `"updated"` attestation is refused if `doc`'s committed Git blob SHA equals the previous `"updated"` receipt for that entry (commit an actual doc update or use `--disposition no-contract-change`).

---

## High-Frequency CLI Cheat Sheet

Every command below is verified against `scripts/*.mjs`.

### Daily Entry, Status, and Multi-Product Supervision

```bash
# Start of every session (read-only: stalls across all registered products + current product's next)
node scripts/self-loop.mjs start [--config <loop.json>] [--hours N] [--now <ISO>] [--json] [--owner-store <dir>]

# Exact next commands, integration SHA, host capacity, measures, and convergence checks
node scripts/self-loop.mjs next [--config <loop.json> | --all] [--owner-store <dir>]

# Check stall status (exit 0 active/settled, exit 2 stalled or unreadable)
node scripts/self-loop.mjs stall [--hours N] [--config <loop.json> | --all] [--now <ISO>] [--json] [--owner-store <dir>]

# Run hourly check across all registered products (commits stall alarms; exit 2 on findings)
node scripts/self-loop.mjs tick [--hours N] [--now <ISO>] [--json] [--owner-store <dir>]

# Direct single-loop driver (when not using owner store resolution)
node scripts/loop.mjs next --config <loop.json>
node scripts/loop.mjs stall --hours N [--config <loop.json>]
```

### Initialization, Owner Store, Hooks, and Heartbeat

```bash
# Initialize in-repo .self-loop/ (or --local-exclude / external --records <dir>)
node scripts/self-loop.mjs init [--local-exclude] [--records <dir>]

# Manage the owner store product registry
node scripts/self-loop.mjs registry init [--roots <dir>,...]
node scripts/self-loop.mjs registry add --name <name> --records <abs-dir> [--aliases a,b]
node scripts/self-loop.mjs registry list [--json]

# Manage Antigravity harness hooks
node scripts/self-loop.mjs hooks install|check|uninstall --harness antigravity \
  [--scope workspace|global] [--target <hooks.json>] [--config <loop.json>] [--release <dir>] [--dry-run] [--json]

# Manage OS scheduler heartbeat (requires a detached plain X.Y.Z release worktree)
node scripts/self-loop.mjs heartbeat install|uninstall [--dry-run] [--platform launchd|cron] [--release <dir>] [--owner-store <dir>]
```

### Isolated Role Calls

```bash
# Run a CLI role (reviewer, critic, actor, judge) or prepare a T3 child (--prepare)
node scripts/call.mjs <loop.json> <role> --round N --task <file> \
  [--step <role>-<mode>] [--view <records-rev>] [--base <product-rev>] [--dry-run | --prepare]

# Record a finished T3 child thread after verifying nonce, session ID, and transcript
node scripts/call.mjs <loop.json> record --ws <prepared-workspace> [--session <provider-session-id>] [--transcript <file>]
```

### Verification Gates & Pushing

```bash
# Run full test suite in a clean detached worktree on an exact SHA (exit 0 green, 2 red, 64 usage)
node scripts/suite-green.mjs --repo <product> --sha <commit> --command "<cmd>" \
  [--install "<cmd>"] [--format auto|node-test] [--vary-version <V>] [--timeout-min 60] --out <prefix>

# Check live remote CI on an exact SHA (exit 0 green, 2 not green/unknown, 64 usage)
node scripts/ci-green.mjs --repo <product> --sha <commit> --require app/name,... \
  [--remote origin] [--from-json <file>] [--out <prefix>]

# Run paired statistical performance benchmark gate (exit 0 green, 2 regression, 64 usage)
node scripts/bench-gate.mjs --repo <product> --base <rev> --candidate <rev> \
  --command "<json-bench>" --metric <field> [--install "<cmd>"] [--require "f=v,g<=w"] \
  [--pairs 24] [--warmup 1] [--max-ratio 1.10] [--confidence 0.95] [--timeout-min 30] [--out <prefix>]

# Push a commit after verifying suite receipt (and judge convergence + CI on protected branches)
node scripts/gated-push.mjs --repo <product> --branch <branch> \
  --suite-receipt <receipt.json> [--sha <commit>] [--dry-run] [--owner-store <dir>]

# Verify SSOT authority docs (Rung-2 anchors/check + Rung-3 drift) and record sync attestations
# (see "SSOT Authority Documents" above for check env vars, anchors, receipts, and attest refusal rules)
node scripts/ssot-check.mjs [check] --config <loop.json> [--sha <commit>] [--strict] [--json] [--out <receipt.json>] [--owner-store <dir>]
node scripts/ssot-check.mjs attest --config <loop.json> --id <entry-id> --sha <commit> \
  --disposition <updated|no-contract-change> --by <role> --reason "<text>" [--round N] [--json] [--owner-store <dir>]

# Version tips, atomic releases, and unattested-tip reconciliation
node scripts/version-gate.mjs tip --version <V> [--on <commit>] [--branch <name>]
node scripts/version-gate.mjs release [--remote origin] [--branch <name>]
node scripts/version-gate.mjs reconcile [--remote origin] [--branch <name>] \
  [--close <finding-id> --cite <W-or-D-id> --records <records>]
```

### Records, Trajectory, Facts, Blueprint, Plans, Decisions, and Owner Words

```bash
# Validate records and regenerate INDEX.md / BLUEPRINT.md
node scripts/records-check.mjs --repo <records> [--write] [--json] [--layout <RECORDS.md>]

# Append a judged round row (auto-reads CI) and check supervision alarms
node scripts/trajectory.mjs append --file <records>/metrics/trajectory.jsonl \
  --round N --phase P --role judge --commit <40-sha> [--tip <40-sha>] \
  [--area A --verdict V --suite p/f --opened c:id,... --closed c:id,... --shelved c:id,... --carried c:id,...]
node scripts/trajectory.mjs alarms --file <records>/metrics/trajectory.jsonl [--sizes <json>] [--json]

# Query Git and trajectory facts for the frame reviewer
node scripts/facts.mjs shipped --repo <product> (--path <p> | --symbol <text> [--path <p>]) [--refs <glob,...>]
node scripts/facts.mjs area --file <records>/metrics/trajectory.jsonl [--area <a>] [--phase <p>]
node scripts/facts.mjs sizes --repo <product> --paths a,b --commits c1,c2

# Manage blueprint feature statuses and owner view
node scripts/blueprint.mjs set --records <records> --feature F-NNNN --status <planned|designing|building|done|retired> \
  [--round R-NNNN-judge | --acceptance <path#heading@commit> --commit <sha> --ci <receipt>] \
  [--decision D-NNNN] --by <who> --note "<text>"
node scripts/blueprint.mjs status --records <records> [--phase <phase>]
node scripts/blueprint.mjs view --records <records>

# Validate, inspect ready packages, and measure parallel work plans
node scripts/plan.mjs validate <records>/plans/PL-NNNN.md [--records <records>]
node scripts/plan.mjs ready --records <records> --plan PL-NNNN [--json]
node scripts/plan.mjs measure --records <records> --plan PL-NNNN [--json]

# Validate, send, answer, replace, and inspect owner decision batches
node scripts/decisions.mjs validate <decisions.json>
node scripts/decisions.mjs send --records <records> --file <decisions.json> --phase <phase> --from <R-NNNN-role>
node scripts/decisions.mjs answer --records <records> --batch B-NNNN --words "<verbatim>" [--outcome as-recommended|amended|other]
node scripts/decisions.mjs replace --records <records> --batch B-NNNN --by B-MMMM [--note "<why>"]
node scripts/decisions.mjs status --records <records> [--phase <phase>]

# Capture, sync, inspect, classify, and measure owner words
node scripts/owner-words.mjs sync --records <records> --project <dir>[,<dir>...]
node scripts/owner-words.mjs open --records <records> [--json]
node scripts/owner-words.mjs mark --records <records> --id W-xxxxxxxxxx --as <direction|answer|routine|not-owner> \
  [--intervention I-NNNN | --batch B-NNNN] [--note "<why>"]
node scripts/owner-words.mjs pending --records <records> --discard <key> --note "<why>"
node scripts/owner-words.mjs metrics --records <records> [--phase <phase>] [--json]

# Run held-out blind backtests on engine question banks and audit access standalone
node scripts/backtest.mjs --runner claude|codex --model <M> --effort <E> \
  --brief <file> --scope full|docs --snapshots <dir> --order 01,02,... --work <dir>
node scripts/audit-access.mjs <work-dir>
```
