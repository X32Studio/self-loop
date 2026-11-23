# Why `self-loop` Is Built This Way

Most "autonomous coding loops" in 2026 boil down to a `while true` shell script: run an agent, run unit tests, feed stderr back into the prompt, repeat until exit 0.

On toy tasks, that works. On real software, it fails in four predictable ways:

1. **Test-gaming & silent compromises.** An agent that writes both the implementation and the checks optimizes for passing checks, not solving the problem.
2. **Patching on a broken premise.** When two fixes fail in the same area, a retry loop writes patch #3, #4, and #5—growing complexity while the underlying assumption is false.
3. **Context & document rot.** Architecture docs, rationale, and "Round N" notes blur together until nobody knows what the system actually guarantees.
4. **Prose rules decay under load.** Instructions written only in prompts get skipped after a few turns, forcing the human owner back into full-time babysitting.

`self-loop` treats autonomous delivery as a **systems-engineering and verification problem**, not a prompting trick.

---

## 1. Two Engines: Generative Framing + Adversarial Hardening

Error-driven loops wait for failures to discover missing requirements. `self-loop` separates **what should exist** from **whether the implementation holds up**:

- **Generative Engine (`Frame Reviewer`)**: Runs at every phase start and whenever supervision alarms fire. Working from purpose docs, Git facts, and trajectory history (never guessing from stale chat context), it derives the design from first principles and proposes `CONTINUE` or `REFRAME`.
- **Adversarial Engine (`Critic / Actor / Judge`)**: Hardens what was decided.
  - **Critic** writes realistic, executable acceptance cases (kept white-box from round 2, while held-out sets stay sealed).
  - **Actor** builds the general solution and maintains its design note.
  - **Judge (deliberately a different model vendor than the Actor)** runs the full suite in a clean checkout, audits fixes as `GENERAL` or `HACK`, and rules `CONTINUE`, `CONVERGED`, or `REFRAME`.

**Cross-vendor independence is enforced in the records**: if the Actor runs on Claude, the Judge runs on Codex/GPT (or vice versa), and hand-offs record both configured and observed models.

---

## 2. The 5-Rung Mechanization Ladder

> **Code gates over prompt obedience.** Every rule sits on the highest rung it can reach.

| Rung | Mechanism | Example in `self-loop` |
|---|---|---|
| **1. Prevention by construction** | The agent literally cannot see or do the forbidden thing | Role views are exported from a pinned records commit via allow-list (`call.mjs`). Critic and Actor never see `sealed/`. |
| **2. Hard gate** | Deterministic code check that refuses invalid state (exit 2 / exit 7) | `gated-push.mjs` refuses pushes without an exact-tree `suite-green.mjs` receipt, committed Judge `CONVERGED`, and live remote CI `success` on that SHA. |
| **3. Screening predicate** | Heuristic alarm that never silently blocks, but routes evidence to diagnosis | `trajectory.mjs alarms` flags ≥3 rounds in one area, recurring blocker classes, partly-closed areas, missing CI, and module bloat. |
| **4. Model judgment** | Tool-equipped model evaluates meaning within verified facts | Lead decides next packages; Frame Reviewer runs premise tests on alarms; Judge evaluates `GENERAL` vs `HACK`. |
| **5. Prose debt** | Rules still left in plain text are tracked explicitly in `DEBT.md` | Every phase aims to shrink `DEBT.md` by moving items up the ladder—never adding unverified gates without two-way admission tests. |

---

## 3. Attack the Premise (Not the Symptom)

Borrowed from `pstack` and battle-tested in real loops (Lesson `L-0001`):

When an area stalls across multiple rounds or a blocker class recurs, `trajectory.mjs alarms` raises an alarm. At that moment, **`call.mjs` mechanically refuses** any new `critic`, `actor`, or `judge` call in that phase until a `reviewer-diagnosis` hand-off is committed that:

1. Explicitly names the active alarm keys (`alarms: ...`),
2. States the **shared premise** behind the repeated fixes (`PREMISE:`), and
3. Runs a falsifiable factual check (`OBSERVATION:`) before deciding `CONTINUE` or `REFRAME`.

Instead of burning 5 more rounds polishing code for a feature nobody shipped or an assumption that is false, the loop stops and cuts the wrong premise out.

---

## 4. Why We Deleted the v0.2 Orchestrator (Lesson `L-0002`)

In `v0.2`, `self-loop` had an 865-line autonomous state-machine orchestrator that tried to decide convergence, close rounds, manage owner budgets, and resume automatically.

Two independent reviews caught subtle false positives in that orchestrator—and every patch added more edge-case branches (`550 → 865` lines).

In `v0.3`, we **deleted the entire orchestrator decision layer** instead of patching it. Today:
- Scripts do **only deterministic things**: isolated role invocations (`call.mjs`), immutable Git-backed records (`records-check.mjs`), exact-tree test receipts (`suite-green.mjs`), live CI verification (`ci-green.mjs`), and push/release gates (`gated-push.mjs`, `version-gate.mjs`).
- Judgment returns to the **tool-equipped Lead model**, guided by `self-loop.mjs next` and forced to prove every claim through a gate before stating it.

---

## 5. Human Attention Is the Only Metric

We ran a blind backtest on 12 real historical pivot points:
- A trajectory-reading Frame Reviewer caught **~90% of real engineering issues** (and twice spotted needed direction shifts earlier than the human owner).
- However, it fully replicated only **~1/6 of human strategic reframes**.

That empirical finding shaped the owner interface: `self-loop` does not pretend humans are obsolete. Instead, it measures **owner directions**, **share raised by the loop first**, **owner waiting time**, and **batch recommendation precision**. Whenever human judgment is genuinely required, the loop batches questions with explicit options and a concrete recommendation—never asking the owner to go hunt for what broke.
