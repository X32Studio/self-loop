---
name: self-loop
description: Run rigorous, parallel-first software development to completion with minimal owner attention and first-principles mechanical gates — configurable models/harnesses via loop.json (t3, paseo, better-paseo-antigravity, claude, codex, generic adapters; vendor/model/session independence), file-disjoint multi-track Actor fan-out, Dual-Five Zeroing (root-cause + whole-repo horizontal sweep + management zeroing), and independent no-dispute Critic convergence alongside neutral Judge dispute arbitration. Use when the user says "self-loop", "自循环设计开发", "take this project to completion", "run the loop on this phase", "reduce my attention", "harden and build", "design and build this with critic / actor / judge", or adversarial-design triggers ("attack our design", "find cases that break it", "critic / actor / judge", "red team the algorithm", "对抗设计", "攻击方 实现方 裁判"), or when acceptance cases and mechanical verification gates must prove a design holds.
---

# Self-loop

Ship real, verified software end to end while spending the owner's attention only on what only the owner can decide. This file is the Lead's operating procedure. Full CLI flags, JSON envelopes, and gate mechanics live in `assets/reference-cli-and-gates.md`; why each rule exists in `REQUIREMENTS.md`; record schemas in `RECORDS.md`; prose debt in `DEBT.md`.

## Why this exists · Intention & Motivation

Self-loop turns engineering discipline into mechanical code (construction > hard gate > screening > model judgment > prose) so agents stay aligned with the owner, maximize parallel throughput across disjoint work, and verify every claim on exact commits—without weaponized ceremony or unnecessary human interruption (P-0001, P-0006, D-0064, D-0067, D-0068).

### What failure looks like

- **Serial idle-waiting**: leaving authorized, file-disjoint Tracks 2 & 3 sitting idle while waiting on Track 1's Critic, Judge, or CI until the owner has to ask *"why are you waiting?"*.
- **Weaponized ceremony**: running a redundant Judge when an independent Critic already passed with `0` defects and `0` disputes; spawning `judge-comments` LLM audits on 0-comment or pointer-only files; spinning up a full Actor worktree for a 2-line hygiene fix.
- **Symptom patching without Dual-Five Zeroing**: fixing one file while leaving four sibling state machines, consumers, or harness paths broken by the same root cause.
- **Hardcoded model/harness lock-ins**: forcing unavailable or rate-limited providers (e.g. hardcoded Claude/Codex) instead of letting `loop.json` configure any working harness, provider, adapter, and model.
- **Unverified claims & self-certification**: claiming convergence without exact-commit gate output, skipping remote CI, or certifying your own edits.

## Operating Flow & Required Outcomes

**You, the Lead, decide from records and gates—never from memory.**

### Step 0 — Start & Reconcile

Start every session and parent recovery turn by reconciling committed state, host load, hook health, and pending work:

```bash
node scripts/self-loop.mjs start [--parent-entry <public-input.json>] [--owner-store <dir>]
node scripts/loop.mjs next --config <loop.json> [--full]
node scripts/loop.mjs stall --hours N [--config <loop.json>]
node scripts/self-loop.mjs clean|prune|records gc|records compact [--config <loop.json> | --records <dir> | --all] [--dry-run | --apply]
node scripts/self-loop.mjs hooks install --records <dir>
```

- **Generation-Engine-First Rule (`I-0005`, `D-0030`)**: whenever the owner states a new direction or defect class, NEVER call `ask_question` or send an owner batch first. Distill verbatim words into `purpose/P-NNNN.md`, run `reviewer-frame` / `reviewer-distill` + `judge-frame`, and escalate ONLY genuine owner-only vision/policy trade-offs (`decisions.mjs send` refuses non-role `--from` senders, exit 2).
- **Phase start & advancing cadence**: run `call.mjs <config> reviewer --round N --step reviewer-frame --task <file>` (drafts features to `out/blueprint/F-NNNN.md`, cites `purpose/P-NNNN.md`), commit blueprint & validated owner decisions (`decisions.mjs send|answer`), and distill/mark open owner words (`owner-words.mjs open|mark`) before launching hardening roles.
- **Record, diagnose & maintain hygiene**: record finished child workspaces (`call.mjs <config> record --ws <ws>` — auto-reclaims heavy payloads while keeping `call.json`, filters junk in `out/`, bounds `*-audit.json <= 1 MiB`), diagnose fired alarms (`trajectory.mjs alarms` -> `reviewer-diagnosis`), and run `self-loop.mjs clean --apply` / `hooks install --records` when read-only `start`/`next` hygiene screening fires.

### Step 1 — Parallel-First Multi-Track Planning (`PL-NNNN` & `admitAcrossPlans`)

- **Default to parallel fan-out (D-0064 T2)**: any feature or refactor spanning `>= 2` decoupled surfaces MUST split into `2–4` file-disjoint parallel Actor packages in `plans/PL-NNNN.md` (`plan.mjs validate`, `dispatch.mjs analyze`, `dispatch.mjs waves`).
- **Publish all authorized orthogonal tracks upfront**: `plan.mjs ready` and `loop.mjs next` reconcile all current plans together (`admitAcrossPlans` — one writer per file across plans) and emit every ready command.
- **Cross-wave pipelining (D-0064 T3)**: once Wave N is local-green, launch decoupled Wave N+1 immediately while Wave N's remote CI and review run asynchronously.

> **Pre-Idle Anti-Serial Check (MANDATORY before ending any turn to wait):**
> Ask: *"Are there any other authorized features or tracks with disjoint `files:` and no causal `needs:` on running work?"*
> If **yes**, publish & launch them **NOW** up to `hostLoad` capacity (`Host within the bound`) — **NEVER** sit idle waiting on Track 1!

### Step 2 — Execution & Bounded Micro-Patch (T5)

- **Substantive work -> isolated parallel Actors**: prepare with `call.mjs <config> actor --round N --plan PL-NNNN --package <id> --task <file> [--prepare]` or `dispatch.mjs prepare --records <dir> --plan PL-NNNN`. On completion, run `call.mjs <config> record --ws <ws>` (auto-prunes finished `wt/`, skips `out/tmp/` & `.git/`, discovers nonce) and fold conflict-free heads with `dispatch.mjs integrate --apply`.
- **Trivial hygiene -> bounded micro-patch (D-0064 T5)**: edits within hard caps (`<= 20` changed lines, `<= 3` files, `<= 2` consecutive per wave) may use:
  ```bash
  node scripts/self-loop.mjs patch --records <dir> --reason "<why>" --verify "<cmd>"
  ```
  Enforces `0` added prose comments and `--verify` exit 0 inline, records `role: "lead-patch"`, and never weakens protected-branch convergence.
- **Multi-round refactors**: open a Bounded Horizon Window (`window.mjs open --horizon <2..12>`) when intermediate Critic/CI checks are unproductive; `reviewer-architecture` runs asynchronously on `T1`/`T3` and only blocks packages intersecting breaching hotspots.

### Step 3 — Dual-Five Zeroing (双五归零, `D-0067`)

- **Technical Zeroing (every Actor fix & Critic check)**:
  1. **Pinpoint root cause** — locate the true failure source; never patch symptoms.
  2. **Clarify mechanism** — state the exact violated invariant and trigger boundary.
  3. **Reproduce deterministically** — prove the failure with a test or probe before fixing.
  4. **Verify cleanly** — fix with T1 pre-handback self-check (targeted tests, `0` added prose comments, `G5` scope).
  5. **Mandatory Horizontal Sweep (举一反三)** — grep the entire repository for every sibling consumer, state machine, variant, harness path, and protocol boundary sharing the same pattern; fix all in-scope siblings in the same batch and report the sweep table in `out/report.md`.
- **Management Zeroing (every alarm or escaped defect)**: trace how the defect slipped past existing briefs or gates and harden the responsible role brief, template, or deterministic gate so the entire defect class cannot recur.

### Step 4 — Independent Verification & No-Dispute Convergence (`D-0064` T10)

- **Living domain acceptance suites (D-0063)**: independent Critic attacks by defect class with horizontal sweep in domain-organized suites (`< 500`L, `0` prose, never append-only `-attack`, `-closure`, or round-numbered files). Post-actor Critic runs once per substantive wave; small (`<= 20–30`L) RED-to-GREEN fixes skip recursive Critics (T7).
- **Deterministic zero-comment admission**: `lib/lexers*.mjs` and `lib/directives.mjs` verify JS/TS/JSX, Python, Swift, Shell, YAML, CSS, HTML, SQL, Go, Rust, C/C++, Java, Kotlin, and TOML in `< 1ms`. Comment-free, pointer-only, and tool-directive files pass immediately with zero `judge-comments` LLM audits; added prose fails deterministically with line diagnostics.
- **No-Dispute No-Judge Convergence**: when an independent Critic passes with these exact headers and `audit.violations === 0` covering all unjudged wave Actors -> **converged directly without a redundant Judge** (honored uniformly by `ci.mjs`, `provenance.mjs`, `window-state.mjs`, `trajectory.mjs`, `facts.mjs`, and `loop.mjs`):
  ```text
  VERDICT: PASS | CONVERGED
  ACCEPTANCE: pass
  DISPUTES: -
  OPENED: -
  ```
- **Invoke Judge ONLY when needed**: real Actor/Critic disputes (`DISPUTES:` non-empty), unresolved/open defects, non-independent Critic, held-out `sealed/` verification, `judge-frame` derivation review, or explicit owner request.
- **Once-per-tree suite & `codeTree` reuse (D-0061, T6)**: `suite-green.mjs` caches green runs per `codeTree` + runtime; `VERSION`-only release tips reuse `codeTree`-equivalent suite and CI receipts; `pre-commit` fast-passes on `VERSION`/docs-only commits.
- **Phase close & Owner interface**: run `reviewer-subtraction` (zero prose comments + every requirement retains mechanism & test), promote protected branches solely via `gated-push.mjs`, record lessons (`lessons/L-NNNN.md`), and quote `next`'s `Measures` header verbatim in the owner report. Batch owner-only decisions via `decisions.mjs validate|send|answer|replace` (intent batches `D-0031`: `1` initial + at most `1` follow-up per requirement per phase) and log unbatched owner reframes in `interventions/I-NNNN.md`.

### Step 5 — Configurable Models & Harnesses (`D-0068`, `D-0066`)

- `loop.json` is the single configurable source for every role — zero hardcoded model or harness lock-ins.
- Configure any `runner` (`t3`, `paseo`, `claude`, `codex`), any non-empty `provider` (`better-paseo-antigravity`, `antigravity`, `claude`, `codex`, `pi`, `cursor`, `opencode`, or custom Paseo plugins), optional `adapter` (`antigravity | claude | codex | generic`), router-prefixed `model` IDs, custom `modelVendors`, and `judgeIndependence: "vendor" | "model" | "session"`.
- Example role & policy configuration in `loop.json`:
  ```json
  {
    "judgeIndependence": "model",
    "modelVendors": { "openrouter/": "google" },
    "agents": {
      "actor": { "runner": "paseo", "provider": "better-paseo-antigravity", "model": "gemini-2.5-pro" },
      "critic": { "runner": "paseo", "provider": "better-paseo-antigravity", "model": "gemini-2.5-flash" }
    }
  }
  ```
- Bootstrap cleanly with CLI flags:
  ```bash
  node scripts/self-loop.mjs init --harness <t3|paseo> --runner <...> --provider <...> [--adapter <...>] [--actor-model <id>] [--critic-model <id>] [--judge-model <id>] [--independence vendor|model|session]
  node scripts/self-loop.mjs hooks install|check|uninstall --harness antigravity [--scope workspace|global] [--owner-store <dir>]
  ```

### Roles

| Role | Owns | Core duty |
|---|---|---|
| Lead (you) | next step, plans, tasks, config, decisions, trajectory, promotion | Decide from records & gates; maximize disjoint parallelism; run Pre-Idle Check; record owner words verbatim |
| Frame reviewer | report, `out/blueprint/F-NNNN.md`, `out/decisions.json` | First-principles FRAME/DIAGNOSIS/SUBTRACTION/ARCHITECTURE/DISTILL; default `>= 2` surfaces to `2–4` parallel packages; Management Zeroing |
| Critic | `acceptance/` living domain suites, structured verdict header | White-box defect-class attacks + horizontal sweep (`< 500`L, `0` prose); emit `VERDICT`/`ACCEPTANCE`/`DISPUTES`/`OPENED`; delete redundant tests |
| Actor | implementation, unit tests, `out/design/<area>.md` | Derive from requirements; Dual-Five Zeroing + horizontal grep sweep; T1 self-check (targeted tests, `0` prose, `G5` scope); subtract superseded code |
| Judge | `out/report.md` (sealed), `out/public.md`, `out/decisions.json` | Neutral dispute arbitrator (not a rubber-stamp on clean Critic passes); rule KEEP/REJECT/GAP, BLOCKER/SHELVED, MERGE/RETIRE, GENERAL/HACK; drive `judge-frame` |
| Owner | purpose, vision, batched decisions | Never asked what an agent can determine or execute |

### Enforcement Ladder

| Rung | Mechanism | Enforced by |
|---|---|---|
| 1 Construction | Isolated worktrees/views, allow-listed public records, nonce-bound delegation, `codeTree` suite cache, `lead-guard` & confined reviewer | `call.mjs`, `decisions.mjs`, `gated-push.mjs`, `suite-green.mjs`, `version-gate.mjs`, `.githooks/` |
| 2 Hard gates | Exact-SHA green suite & CI receipts, `G1–G7` plan/package/lineage gates, deterministic comment lexing, `judgeIndependence`, alarm & open-word gates | `call.mjs`, `gated-push.mjs`, `trajectory.mjs`, `plan.mjs`, `dispatch.mjs`, `records-check.mjs`, `ssot-check.mjs`, `lead-guard.mjs`, `lib/comments.mjs` |
| 3 Screening | Trajectory alarms, idle-package & unchecked-release screening, host load bounds, advancing cadence, `arch-facts` anti-rot, stall alarms, owner metrics | `loop.mjs`, `self-loop.mjs`, `trajectory.mjs`, `plan.mjs`, `owner-words.mjs`, `audit-access.mjs`, `records-check.mjs` |
| 4 Model judgment | Task authoring, parallel track scheduling, dispute arbitration, reviewer diagnoses & reframes | `SKILL.md`, `assets/brief-*.md` |
| 5 Prose | Unmechanized rules tracked explicitly and shrunk each phase | `DEBT.md` |

### Before-You-Claim Gate Table

A claim without its gate output on the exact commit you name is not made (detailed semantics in `assets/reference-cli-and-gates.md`):

| Before you claim | Run | It holds only when |
|---|---|---|
| a role's output may be used | `call.mjs` (or `call.mjs record --ws <ws>`) | exit 0: one hand-off line, audit without violations, deterministic comment gate clean |
| round N is closed | `trajectory.mjs append --file <records>/metrics/trajectory.jsonl --commit <SHA>` (plus `--tip <SHA>`, `--role critic` or `--role judge`) | exit 0: live CI receipt saved (`success` required for `CONVERGED`/`PASS`), `ssot-check.mjs --strict` green when configured |
| the phase converged | `self-loop.mjs next`, `records-check.mjs`, `blueprint.mjs status --records <records> --phase <phase>`, `decisions.mjs status --phase`, `trajectory.mjs alarms`, `owner-words.mjs open --records <records>` (plus `ssot-check.mjs --strict` if `ssot` configured) | single integration SHA; independent Critic (`VERDICT: PASS` or `CONVERGED`, `ACCEPTANCE: pass`, `DISPUTES: -`, `OPENED: -`, `0` violations) or Judge `CONVERGED` satisfying `judgeIndependence`; `0` open blockers; green CI; records check and blueprint status exit 0; owner words check exit 0; `0` open batches; all alarms diagnosed; no advancing round due |
| the phase is closed | same gates after `reviewer-subtraction` | convergence holds plus zero established prose comment lines at integration SHA |
| a commit may be pushed | `suite-green.mjs` -> `gated-push.mjs` | exact `codeTree` green suite receipt, verified provenance, `G1–G7` & SSOT clean; protected branches additionally require independent convergence and green remote CI |
| the candidate meets latency bar | `bench-gate.mjs --base <rev> --candidate <sha> --max-ratio X` | exit 0: paired clean-worktree runs meet `--require` and distribution-free upper bound <= X |
| the owner decided | `decisions.mjs status` | batch shows `answered` from an event holding the owner's verbatim words |
| the records are in order | `records-check.mjs --repo <records>` | exit 0 (index, blueprint, handoffs, trajectory, word marks, `ssot-sync.jsonl` valid) |

## Not for / Must Not

- **Not for**: trivial one-off Q&A, throwaway prototypes, or single-line exploratory edits that need no durable records, parallel orchestration, or adversarial verification.
- **Must Not**:
  - Never wait serially on Track 1 when orthogonal, file-disjoint authorized tracks can launch in parallel (run the Pre-Idle Anti-Serial Check first).
  - Never run a redundant Judge on a clean independent Critic pass (`VERDICT: PASS` or `CONVERGED`, `ACCEPTANCE: pass`, `DISPUTES: -`, `OPENED: -`, `0` violations).
  - Never spawn `judge-comments` micro-audits on comment-free or deterministically lexed files.
  - Never ship a symptom fix without Dual-Five Technical Zeroing's whole-repo horizontal grep sweep (举一反三).
  - Never hardcode unavailable models or harnesses; always configure via `loop.json`.
  - Never edit product code directly outside a planned Actor or bounded `self-loop.mjs patch`, and never pass `--no-verify` to bypass hooks.
  - Never claim convergence, closure, or green CI without exact-commit gate output, and never record owner words or answers the owner did not give.
  - Never ask the owner what an agent can investigate, derive via the Generation Engine (`P-NNNN` + `reviewer-frame`/`reviewer-distill` + `judge-frame`, `I-0005`), or execute.

## Reference

- [`assets/reference-cli-and-gates.md`](assets/reference-cli-and-gates.md) — Complete CLI flag reference, JSON envelopes (`continuation-entry/v1`, `plan-time/v2`, `plan-forecast/v1`, `scoped-release`), dispatch gates `G1–G7`, Paseo/Antigravity/`better-paseo-antigravity` protocols, comment admission v2, SSOT checks, owner-word metrics, supervision/cadence/window mechanics, `suite-green`/`gated-push`/`bench-gate`, and full Enforcement Ladder details.
- [`RECORDS.md`](RECORDS.md) — Records repository layout, schemas, and commit discipline.
- [`REQUIREMENTS.md`](REQUIREMENTS.md) — First-principles requirements and rationale behind every rule.
- [`DEBT.md`](DEBT.md) — Rules still left to judgment or prose.
- `assets/brief-*.md` — Role briefs (`brief-shared.md`, `brief-frame-reviewer.md`, `brief-critic.md`, `brief-actor.md`, `brief-judge.md`).
