# Architecture

`self-loop` is designed around one scarcest resource—**the owner's attention**—and one engineering rule: **anything that can be enforced deterministically without false kills should be code, and anything that requires judgment should stay with an accountable LLM agent backed by factual gates.**

## The 5-Rung Enforcement Ladder

Every invariant in `self-loop` sits on the highest rung it can reliably reach (defined in [`REQUIREMENTS.md`](../REQUIREMENTS.md) item 11 and tracked in [`DEBT.md`](../DEBT.md)):

| Rung | Mechanism | Semantics | Examples in `self-loop` |
|---|---|---|---|
| **1. Construction** | Structural impossibility | The agent cannot see or execute the forbidden action by construction. | Allow-listed read-only record views (`PUBLIC_KINDS`), `sealed/` omitted from non-judge views, `claude --restricted` with file tools only for CLI `reviewer`, Git `--no-replace-objects` reads. |
| **2. Hard Gate** | Deterministic refusal (non-zero exit) | Decided strictly from structured facts; admitted only with **two-way proof** (turns a real defect red and keeps legitimate history green, zero false kills). | `audit-access.mjs` violations (exit `6`, including fail-closed confined transcript audits for `t3` `reviewer` on `antigravity`/`claude`), `call.mjs` undiagnosed-alarm & comment-admission refusals (exit `7`), `suite-green.mjs` exact-tree receipts, `ci-green.mjs` / `gated-push.mjs` / `version-gate.mjs` (exit `2`), `records-check.mjs` structural checks. |
| **3. Screening** | Advisory alarms & predicates | Highlights anomalies with structured evidence and routes them to model diagnosis; **never blocks on its own**. | `trajectory.mjs alarms` (`area-rounds`, `blocker-recurring`, `partly-closed`, `ci-not-green`, `ci-absent`, `growth`), `stall`, `advancing-round-due`, `idle-packages`, `records-check.mjs` text screenings (dangling IDs, secret patterns, bare `file:line`). |
| **4. Model Judgment** | Accountable LLM evaluation | Evaluates meaning, design soundness, root causes, and trade-offs; proposals still pass through rungs 1–3. | Lead decisions (`SKILL.md`), Frame Reviewer premise tests and subtraction passes, Critic attacks, Actor implementations, cross-vendor Judge rulings. |
| **5. Prose** | Written instructions | Rules not yet mechanized; explicitly listed in [`DEBT.md`](../DEBT.md) with why they remain prose and what would promote them. | Semantic quality of design distillations, whether an intervention's `carried-by` carrier truly eliminates the root class. |

## Why v0.3 Deleted the Outer Orchestrator

In `self-loop` v0.2, an outer script (`self-loop.mjs`) tried to own the full state machine: choosing the next role, deciding round closure, enforcing convergence, managing owner batch budgets, and replaying failed attempts.

Across two independent reviews, that deciding layer grew from 550 to 865 lines while repeatedly producing **false verdicts** (lesson `L-0002`, detailed in [`DEBT.md`](../DEBT.md)):
- A held reframe could still close a phase with zero batches sent.
- A phase converged while the product's real entry point failed.
- Stale or queued CI runs were misclassified.
- Text matching on `## Answers` treated quoted meeting notes as owner answers.

Meanwhile, the native path—where a tool-using **Lead agent** decides what to do next by reading `SKILL.md` and running deterministic scripts—had none of those failure modes.

In **v0.3+**, the deciding orchestrator was deleted rather than patched. Scripts now own strictly two deterministic responsibilities:

1. **Isolated Role Execution (`scripts/call.mjs`)** — Build an allow-listed view from one records commit, create a detached product worktree, run (or `--prepare`) a single role call, audit structured tool events, apply comment admission, commit owned product changes, and atomically commit the hand-off + regenerated `INDEX.md`.
2. **Factual Truth Gates** — Answer one objective question per claim (`suite-green.mjs`, `ci-green.mjs`, `bench-gate.mjs`, `gated-push.mjs`, `ssot-check.mjs`, `version-gate.mjs`, `records-check.mjs`, `trajectory.mjs`, `decisions.mjs`, `blueprint.mjs`, `plan.mjs`, `owner-words.mjs`).

`self-loop.mjs` remains the unified read-only driver (`start`, `next`, `stall`), hourly watcher (`tick`, `heartbeat`), SSOT gate entry (`ssot`), hook manager (`hooks`), initializer (`init`), and owner-store registry (`registry`). It reads committed records and suggests exact commands in procedure order, but **never launches a model or makes a verdict on its own**.

## Two Engines and Five Roles

```text
                  ┌──────────────────────────────────────────┐
                  │         Owner (Purpose & Batches)        │
                  └────────────────────┬─────────────────────┘
                                       │ verbatim words / decisions
                                       ▼
┌────────────────────────────────────────────────────────────────────────────┐
│                        Lead Agent (follows SKILL.md)                       │
│  Reads `self-loop.mjs start|next`, writes tasks, runs gates, promotes code │
└──────┬───────────────────────────────────────────────────────────────┬─────┘
       │ Generative Engine (phase start, alarms, cadence, close)       │ Hardening Engine (per round)
       ▼                                                               ▼
┌────────────────────┐                                  ┌───────────────────────────────┐
│   Frame Reviewer   │                                  │ Critic ──► Actor ──► Judge    │
│ (claude CLI or t3  │                                  │ (cases)   (fix)  (other vendor│
│  confined audit)   │                                  │                   + sealed/)  │
└────────────────────┘                                  └───────────────────────────────┘
```

- **Lead** — Reads `start`/`next`, decomposes admitted work into `plans/PL-NNNN.md`, writes role tasks, runs every gate before making a claim, records owner answers verbatim, and promotes converged commits. Under lead hooks (`lead-guard.mjs`), the lead is prevented from directly editing tracked product code or running raw `git push`.
- **Frame Reviewer (`reviewer`)** — Runs at phase start (`reviewer-frame`), on every supervision alarm (`reviewer-diagnosis`, performing premise tests before further fixes), on the advancing-round cadence (`reviewer-frame-blind` + `reviewer-frame`), and at phase close (`reviewer-subtraction`). Runs on `claude` CLI (`--restricted`, file tools only, confined by construction) or as a `t3` child on `antigravity` / `claude` with fail-closed confined transcript auditing (`auditAccess([ws])`, file tools only, rejecting outside paths, non-file/MCP tools, and unparsed/insufficient audit evidence). Codex (CLI and `t3:codex`) remains refused.
- **Critic (`critic`)** — Writes realistic, rule-decided executable acceptance cases in owned test paths; switches to white-box attacks from round 2 onward.
- **Actor (`actor`)** — Derives general solutions from requirements (never keying behavior on case IDs), deletes superseded code, and maintains current-state design notes in `out/design/<area>.md`.
- **Judge (`judge`)** — Runs on a **different vendor and model** than the Actor, has sole non-lead access to `sealed/` held-out cases and prior private rulings, runs the test suite itself, audits fixes (`GENERAL` vs `HACK`), and emits both a private full ruling (`out/report.md` → `sealed/judge/`) and a public summary (`out/public.md` → `rounds/NNNN-judge.md`).

## Cross-Vendor Independence & Transcript Verification

Self-reported model names and configured defaults do not prove independence—especially on multi-vendor harnesses like Antigravity where a model can change mid-conversation.

`self-loop` enforces independence from **recorded execution transcripts**:
- **Direct CLI runs (`claude` / `codex`)** stream structured JSON events; `call.mjs` captures the observed model from stream metadata and audits every tool call via `scripts/audit-access.mjs`.
- **T3 child threads (`runner: "t3"`)** bind a cryptographic `nonce` in `t3-prompt.md` and require `--session <provider-session-id>` on `call.mjs record`. `scripts/lib/t3-child.mjs` locates the provider-native rollout/transcript, verifies the first prompt holds `t3-prompt.md` verbatim, refuses forked or truncated transcripts (Antigravity strictly requires untruncated `transcript_full.jsonl`), and records `observedModels`.
- **Vendor resolution (`scripts/lib/vendor.mjs`)** maps observed model names (`claude*` → `anthropic`, `gpt-*`/`o<N>*`/`codex*` → `openai`, `gemini*` → `google`) and **fails closed (`null`)** if an Antigravity run has no observed models, an unknown model, or models from more than one vendor. Convergence checks in `scripts/loop.mjs` require Judge and Actor to resolve to distinct vendors and models.

## Repository Topology: Product Repo, `.self-loop/`, and `sealed/`

```text
my-project/                        # Product Git repository
├── src/                           # Actor-owned paths
├── test/                          # Unit & public acceptance tests
├── .gitignore                     # Includes `.self-loop/` (or `.git/info/exclude`)
├── .agents/hooks.json             # Optional workspace hooks (git-excluded)
└── .self-loop/                    # Independent nested Records Git repository
    ├── records.json               # Layout extensions, sealed paths, publicImports
    ├── loop.json                  # Product path, branch, protected, agents, gates
    ├── INDEX.md                   # Generated deterministically by records-check.mjs
    ├── BLUEPRINT.md               # Generated from blueprint/ + metrics/blueprint.jsonl
    ├── purpose/                   # P-NNNN.md (dated requirements citing W-ids)
    ├── decisions/                 # D-NNNN.md (immutable decisions)
    ├── blueprint/                 # F-NNNN.md (current feature definitions)
    ├── design/                    # <area>.md (current state only; Git holds history)
    ├── plans/                     # PL-NNNN.md (work packages & disjoint ownership)
    ├── engines/                   # Role briefs (read from committed view)
    ├── rounds/                    # R-NNNN-<role>.md (public verbatim records)
    ├── owner/                     # words.jsonl, word-marks.jsonl, B-NNNN.md, answers.jsonl
    ├── interventions/             # I-NNNN.md (owner reframes & dispositions)
    ├── lessons/                   # L-NNNN.md
    ├── metrics/                   # handoffs.jsonl, trajectory.jsonl, blueprint.jsonl, alarms.jsonl, ssot-sync.jsonl
    ├── evidence/                  # Per-round logs, audits, CI/suite/bench receipts
    └── sealed/judge/              # Full judge rulings (never exported to non-judge views)

../my-project-sealed/              # Separate held-out cases repo (Judge & Lead only)
```

### Why Records Are a Separate Git Repository

1. **Clean product history** — Product commits contain only code and tests. Even when `.self-loop/` is nested inside the product directory (the v0.6.0 default), it is its own `.git` repository ignored by the outer repo.
2. **Allow-listed views by construction** — When `call.mjs` prepares a workspace, `buildView()` exports files strictly from one committed records revision (`--view`, default `HEAD`) filtered by `PUBLIC_KINDS` (`Purpose`, `Decisions`, `Design`, `Blueprint`, `Hand-offs`, `Trajectory`, `Owner batches`, `Owner answers`, `Interventions`, `Lessons`, `Research`, `Plan`) plus only those `Rounds` files named by `metrics/handoffs.jsonl` or `records.json` `publicImports`. Ignored files, uncommitted drafts, symlinks, `evidence/`, `engines/` (copied separately as briefs), and `sealed/` are omitted by construction. Only the Judge receives `sealed/judge/` and external `sealed` roots.
3. **Atomic hand-off commits** — `scripts/lib/records-commit.mjs` builds candidate Git trees in a temporary index and updates the records ref via compare-and-swap (CAS), ensuring unrelated staged files never ride along and concurrent writers never overwrite one another.
4. **Separate `workDir` invariant** — `call.mjs` refuses any configuration where `workDir` and `records` contain one another.

## Integration SHA, Host Capacity, and Heartbeat

- **Records-derived integration SHA (`scripts/loop.mjs`)** — Rather than trusting whatever a local branch happens to point at, `next` computes the integration SHA from the phase's latest judged trajectory row advanced along descending Critic/Actor/Judge hand-off commits. Diverged heads are listed with merge commands; `call.mjs` fast-forwards `loop/<phase>` by CAS only on descending commits and never rewrites a checked-out working tree.
- **Measured host capacity (`scripts/lib/host.mjs`, `scripts/lib/thresholds.mjs`)** — Heavy calls (`critic`, `actor`, `judge`) and `suite-green.mjs` hold PID leases in `SELF_LOOP_LOAD_DIR` (default `~/.self-loop/load`). Rather than capping concurrency at a fixed count, `next` measures live host load (`1-min load <= maxLoadRatio * logicalCores`, default `0.7`) and available memory (`os.freemem() >= floor`, default `min(16 GiB, 0.25 * totalMemory)`), overridable in the owner store's `products.json`. When over the bound, `next` withholds heavy-role and suite suggestions while continuing to offer `reviewer`, `record`, and non-suite gates.
- **Harness-independent heartbeat (`scripts/lib/heartbeat.mjs`, `scripts/lib/tick.mjs`)** — Runs `self-loop.mjs tick` hourly via `launchd` (macOS) or `cron` (Linux) from a detached plain `vX.Y.Z` release worktree, recording durable stall alarms in `metrics/alarms.jsonl` and flagging idle plan packages or unregistered records repositories under configured `roots`.

## Zero-Dependency Principle

`self-loop` deliberately ships with **zero npm dependencies**:
- Every script is standard Node.js ESM (`*.mjs`) using built-in modules (`node:child_process`, `node:crypto`, `node:fs`, `node:os`, `node:path`, `node:sqlite`, `node:zlib`, `node:test`).
- Git plumbing, GitHub CLI (`gh`), AWS CLI (`aws`), and agent CLIs (`claude`, `codex`) are invoked directly with explicit argument arrays (`execFileSync`/`spawnSync` without shell interpolation on security-sensitive paths).
- Every gate runs identically on a developer laptop, a remote Linux server, or a macOS CI runner with no package-manager bootstrap, lockfile churn, or transitive supply-chain surface.
