# self-loop: Core Requirements

`self-loop` takes a software project from intent to verified completion while minimizing owner attention. It combines a first-principles **generative framing engine** with an **adversarial hardening engine**, trajectory-driven supervision, and Git-backed mechanical gates.

## Core Design Requirements

1. **Two engines.**
   - **Generative engine (`Frame Reviewer`)**: Runs at every phase start and whenever supervision alarms fire. Derives architecture and phase plans from purpose documents, Git facts, trajectory history, and first principles (`CONTINUE` or `REFRAME`).
   - **Adversarial engine (`Critic / Actor / Judge`)**: Hardens what was decided. The Critic writes executable acceptance cases, the Actor builds the general solution, and a cross-vendor Judge independently verifies fixes on clean checkouts.
2. **Supervision, fast and diagnosed.**
   - Rule-based alarms on the trajectory (rounds per area, recurring blocker classes, partly-closed areas, missing/failing remote CI, module size growth) block further adversarial calls until a model diagnosis (`reviewer-diagnosis`) is recorded.
   - **Attack the premise** (inspired by `pstack`): when two or more fixes sharing a premise fail the same gate, the reviewer states the premise explicitly and tests a falsifiable observation before another patch is briefed.
3. **`REFRAME` is a first-class verdict.**
   - Alongside `CONTINUE` and `CONVERGED`, the loop can stop with a structured `REFRAME` proposal. Owner decisions arrive in small batches with at least two distinct options and a concrete recommendation; the owner is never asked to hunt for the problem.
4. **Owner attention is the primary metric.**
   - Track owner interventions per phase and the share raised by the loop before the owner. Every out-of-band intervention is logged (`interventions/I-NNNN.md`), distilled into the reviewer's question bank, and re-scored on held-out backtests (`scripts/backtest.mjs`) to prevent regressions or overfitting.
5. **Managed, immutable records.**
   - Briefs, rulings, cases, design notes, intervention logs, metrics, and backtests are declared, versioned in a dedicated Git records repository outside scratch space, and verified via `records-check.mjs` (see `RECORDS.md`).
6. **Delivery discipline.**
   - Real dependencies from round 1, different model vendors for Judge and Actor, held-out and blind checks, full suite green on the exact published tree before any push, fresh agents resumed from committed role artifacts, and never asking the owner for anything an agent can check.
7. **Design documents and code do not rot.**
   - Rules carry IDs, code enforcers, and tests. Structural policies (module ownership, single writers, allowed record kinds) are enforced at every hand-off.
   - Code and document rot is tracked in the trajectory, and every phase closes with a **subtraction pass** (`reviewer-subtraction`) removing dead code, superseded mechanisms, and prose comments (enforcing pointer/directive-only source comments via `lib/comments.mjs`).
8. **5-Rung Mechanization Ladder (mechanism before discipline).**
   Every rule sits on the highest rung it can reach:
   1. **Prevention by construction**: the agent cannot see or perform the forbidden action (commit-pinned allow-list views, sealed repo isolation, `--restricted` runtime).
   2. **Hard gate**: deterministic code/lint/hook check where hits are certain, admitted only with two-way proof (turns a real defect red and keeps legitimate history green).
   3. **Screening predicate**: heuristic alarm with evidence routed to model diagnosis; never silently blocks on unverified heuristics.
   4. **Model judgment**: tool-equipped model decision verified against gate outputs.
   5. **Prose debt**: remaining natural-language rules, tracked explicitly in `DEBT.md` and reduced each phase.
9. **Remote CI truth on exact commits.**
   - A round closes only when live remote CI (`ci-green.mjs`) is `success` on the exact judged SHA (or its `VERSION`-only descendant tip) in the actual push destination repository.
10. **Single-source blueprint.**
    - `blueprint/F-NNNN.md` and `metrics/blueprint.jsonl` connect owner requirements (`purpose/P-NNNN.md`), design anchors, acceptance criteria, and completion status (`BLUEPRINT.md`) without duplicating mutable prose.
