# Self-loop · Ubiquitous Domain Glossary

Authoritative product-repository vocabulary for `self-loop` (pointer-driven companion to [`SKILL.md`](SKILL.md), [`REQUIREMENTS.md`](REQUIREMENTS.md), [`RECORDS.md`](RECORDS.md), [`DEBT.md`](DEBT.md), and [`assets/reference-cli-and-gates.md`](assets/reference-cli-and-gates.md)). Use these exact terms across briefs, blueprints, plans, and reviews to prevent naming drift.

## Loop & Engine Terms

| Term | Canonical Definition & Source Pointer |
|---|---|
| **Generation Engine** | First-principles derivation and self-supervision roles (`reviewer-frame`, `reviewer-distill`, `reviewer-architecture`, `reviewer-subtraction`, `judge-frame`) that derive blueprints, diagnoses, and outer-loop refactors before asking the owner (`D-0030`, `D-0032`, `I-0005`). |
| **Dispatch & Integration Engine** | Plan validation, import-graph coupling analysis, wave scheduling, parallel workspace prep, and conflict-free merge folding (`scripts/plan.mjs`, `scripts/dispatch.mjs`, `plans/PL-NNNN.md`, gates `G1–G7`, `admitAcrossPlans`; `D-0059`, `D-0063`). |
| **Adversarial Engine** | Isolated role execution (`critic`, `actor`, `judge`) orchestrated by `scripts/call.mjs` over allow-listed public record views, fresh detached worktrees, nonce-bound delegation, and access/comment audits (`D-0060`). |
| **Bounded Horizon Window (`W-NNNN`)** | Time-boxed refactor window (`scripts/window.mjs`, `metrics/windows.jsonl`) granting `H - 1` `slack` actor rounds, `1` `converging` round, then `gate-due` enforcement before closing `verified` or `reframed` (`D-0058`). |
| **Bounded Lead Micro-Patch (`LP-NNNN` via `patch --diff`)** | Non-interactive surgical Lead fix (`node scripts/self-loop.mjs patch --records <dir> --diff <file\|-> --reason "<why>" --verify "<cmd>"`, `scripts/lead-patch.mjs`) applied in an isolated detached worktree under hard bounds (`1..3` files, `1..20` lines, `< 2` consecutive, `0` prose, `--verify` exit `0`) without weakening `lead-guard.mjs` (`D-0064` T5, `F-0016`). |
| **No-Dispute Convergence (`D-0064` T10)** | Direct convergence certified by an independent Critic (`judgeIndependence`) emitting `VERDICT: PASS\|CONVERGED`, `ACCEPTANCE: pass`, `DISPUTES: -`, `OPENED: -` with `audit.violations === 0` covering all unjudged wave Actors, skipping a redundant Judge. |
| **Dual-Five Zeroing (`D-0067`)** | **Technical Zeroing**: pinpoint root cause -> clarify mechanism -> deterministic repro -> verify fix -> whole-repo horizontal sweep (举一反三). **Management Zeroing**: trace why a defect escaped and harden the responsible brief, template, or deterministic gate. |

## Tree, Relay & Hygiene Terms

| Term | Canonical Definition & Source Pointer |
|---|---|
| **`tree`** | Published Git tree OID (`sha^{tree}`) resolved with `--no-replace-objects` (`ORIGINAL_OBJECTS`), binding suite receipts and push verification to exact committed bytes (`D-0020`). |
| **`codeTree`** | Canonical tree OID with `VERSION` normalized/stripped (`D-0064` T6) so `VERSION`-only release tips reuse verified suite and CI receipts without redundant reruns. |
| **`Suite Relay Checkpoint`** | Fail-closed, content-addressed per-file green proof (`scripts/lib/suite-relay.mjs`, `suite-green.mjs --relay`) stored under `<suiteStore>/.relay/<codeTree>/<runtimeKey>/` (or `SELF_LOOP_RELAY_DIR`), keyed on `(codeTree, relPath, fileBlobSha, runtimeKey)`, synthesizing a full-tree green receipt once 100% of discovered files pass (`F-0016`, `W-ee79c72dc0`). |
| **`Prune Tombstone`** | Cryptographic digest manifest (`prune/PR-NNNN.md`, `F-0015`) committed when historical evidence or workspaces are pruned so pruned attempt IDs and payloads are never silently reused. |
| **`Enforcement Ladder`** | Five-rung priority hierarchy: `1 Construction` > `2 Hard Gate (zero false kills)` > `3 Screening` > `4 Model Judgment` > `5 Prose (DEBT.md)`. Every rule climbs as high as zero-false-kill mechanics allow. |

## Seam-First & Modularity Terms

| Term | Canonical Definition & Source Pointer |
|---|---|
| **Public Seam** | Observable contract boundary (CLI flags/exit codes/stdout-stderr, exported module signature, JSON schema, or Git hook I/O) against which behavioral tests and parallel packages bind (`F-0016`). |
| **Deep Module** | Module exposing a narrow, stable public seam that encapsulates substantial domain logic and invariants, preferred over fragmented shallow pass-through wrappers (`F-0016`). |
| **Implementation-Coupled Test** *(banned)* | Brittle white-box test binding to private internals, mock call order, or hardcoded per-file line-count limits inside behavioral suites; breaks legitimate refactors without catching real loss (`F-0016`). |
| **Tautological Test** *(banned)* | Test asserting mocked return values or mirroring implementation code rather than exercising real system behavior through a public seam (`F-0016`). |
| **Living Domain Acceptance Suite (`D-0063`)** | Capability-organized black-box suite (`acceptance/<domain>.test.mjs`, `< 500`L, `0` prose comments) updated in place across waves — replacing banned append-only round-numbered (`r6-*`, `round8-*`), `-closure`, or `-attack` files. |
| **Dual-Axis Review** | Independent Critic review explicitly separating **Axis 1 (Spec & Behavioral Invariants)** from **Axis 2 (Standards, Structural Smells, Subtraction & Dual-Five Zeroing)** so neither axis pollutes the other (`F-0016`). |
