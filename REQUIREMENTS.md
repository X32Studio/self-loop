# self-loop: requirements (owner, 2026-11-20)

Owner: 一方面打磨目标产品，另一方面优化对抗设计这个 skill，升级一个自循环设计开发 skill 出来，这套东西最后应该在目标产品中也是有用的。

Why: in the target-product loop the owner keeps supplying the essential reframes (provable identity, preferences as input,
multi-user scope, orchestrating outside agents, implicit context, delete the old client, managed records), without
reading results. adversarial-design is error-driven by construction: cases pull designs, the actor may not change
architecture, and the consequence-only blocker rule shelves anything that has not failed yet. First-principles design
is left to the human, so the human must stay in the loop.

Requirements (design follows from these; evidence from the backtest in the target-product session decides the details):
1. Two engines. A generative engine designs from first principles (purpose and scarcest resource; the product's
   entities x standing concerns; mapping onto the mature domain it imitates and that domain's institutions and
   standards; invariants) from purpose documents only, results withheld. It runs at every phase start and when
   supervision asks for it. The adversarial engine (critic / actor / judge, from adversarial-design) hardens what the
   generative engine and the owner decided.
2. Supervision, fast and diagnosed. Rule-based alarms on the trajectory (rounds per area, recurring blockers, finer and
   finer blockers, code churn per requirement, cost per closed blocker) trigger a model diagnosis (trajectory
   reviewer). Same shape as the product's own supervisor: fast alarms by rules, diagnosis by a model.
3. REFRAME is a verdict. Besides CONTINUE and CONVERGED the loop can stop with a reframe proposal. Owner decisions come
   in batches, each with a recommendation and options; the owner is never asked to find the problem.
4. The owner's time is the metric. Track owner interventions per phase and the share the loop raised before the owner.
   Every owner intervention is logged (frame before, the reframe, the general question behind it) and distilled into
   the engines' question banks; each change to a question bank is re-scored on a held-out backtest (snapshots before
   each intervention, sealed keys, blind grader, different model) so it neither regresses nor overfits.
5. The loop's own records are managed (owner requirement A1 applied to the loop): briefs, rulings, cases, design
   notes, intervention log, metrics and backtests are declared, versioned, with identity and provenance, and kept
   outside scratch space. Design: RECORDS.md.
6. Delivery discipline proven on the target product is part of the skill: real dependencies from round one, different vendors per
   role, held-out and blind checks, full suite green before any push, fresh agents resumed from role artifacts,
   never ask the owner for what an agent can do.
7. Portable into the target product. Roles, artifacts and verdicts are expressed so the target product can run the loop as its own work graph
   (planning = generative engine, acceptance = critic/judge, supervision = alarms + reviewer, alignment = intervention
   log). The procedure stays plain text any agent CLI can follow.
8. One source. self-loop supersedes adversarial-design; adversarial-design is folded in as the hardening engine and
   retired once self-loop has run one target-product phase end to end.

## Added 2026-11-20 (owner)

Owner: 如何保证设计文档、代码不腐败也是你需要做的。准确说这个 skill 就是一个简化版的目标产品系统，保证我们的项目能够在减少人的
attention 关注下彻底完成。你在开发目标产品过程中也在学习如何更好地做项目，如何更好做项目也推进到了目标产品的设计中，两者相辅相成。

9. **Design documents and code do not rot.** Keeping them sound is the loop's job, not a closing chore:
   - every rule in the design documents has an ID, names the code that enforces it and the tests that prove it, and a
     check fails when a link breaks, a rule has no test, or code enforces a rule no document states (traceability both
     ways; one source per rule);
   - structural policy is code, not a test subset: module boundaries, single writers, declared records, forbidden
     direct access, checked on every hand-off;
   - rot is measured in the trajectory: size and churn per module, special cases added per requirement, documents that
     grow without the code changing or the reverse; thresholds raise alarms (S4 evidence: `src/access.js` reached
     809 lines over five rounds of one key-file problem; the architecture document is 54 KB of dense paragraphs);
   - a subtraction pass runs at each phase gate: remove dead code, merged-away mechanisms, outdated text and superseded
     tests, with the judge confirming nothing that a requirement needs was lost.
10. **The skill mirrors the target product, and the two teach each other.** The skill's parts are the target product's methodology at
    small scale: the generative engine is planning, critic and judge are acceptance, supervision is the Andon, records
    are the archive, the intervention log is alignment, the owner's attention is the metric both optimise. Every lesson
    from running a project is recorded with where it applies (skill, product, or both); at each phase gate the lead turns
    lessons into skill changes and product requirement proposals (batched for the owner). When the target product can run a work graph
    end to end, the skill runs on it.
11. **Mechanism before discipline, and gates that never kill legitimate work** (owner: 能用代码和 lints 来约束和检测的，
    不要依靠模型自觉；或者说能转化为明显不会误杀的 lint、代码和 Jev 判断（智能决策和筛查）脚本的，不要依靠模型自觉).
    Every rule the loop relies on sits on the highest rung it can reach:
    1. prevention by construction (an agent cannot see or do it: what is revealed when, which tools and directories);
    2. a hard gate (lint, check, hook) only where a hit is certain: decided by structured facts, with a test corpus
       showing zero false kills on the loop's own history before it may block;
    3. screening (heuristic code, Jev or a decision model) that raises an alarm with its evidence and routes it to model
       diagnosis, never blocking by itself; its false alarms and misses are counted;
    4. model judgment, whose conclusion is a proposal executed through the same checks;
    5. prose instructions to a model, kept as a listed debt: each such rule names why it is not yet mechanised.
    The skill keeps that list and shrinks it every phase. First instance: `scripts/backtest.mjs` reveals snapshots one
    at a time and confines tools (rung 1), blocks on file-tool access outside the workspace (rung 2), and flags shell
    commands that mention outside paths for review (rung 3).

## Borrowed from pstack (Lauren Tan, cursor/plugins `pstack/` 0.15.46; study: product-loop research/pstack.md)

These refine the items above; they are not new goals.
- Item 2 (supervision): **attack the premise.** When two or more fixes sharing one premise fail the same gate, the
  trajectory reviewer writes the premise down and tests it with an observation that would differ if it were false,
  before any further fix ([principle-attack-the-premise](https://github.com/cursor/plugins/blob/fbb86c09bbb4a25e490aaed136899ced1e9140e4/pstack/skills/principle-attack-the-premise/SKILL.md)).
  The count only triggers diagnosis; the reviewer decides CONTINUE or REFRAME.
- Item 11 (gates): **admission of a hard gate needs both directions of proof**: the same command turns a recorded real
  defect red and keeps a labelled set of legitimate historical samples green; a gate that cannot fail is rejected.
  Candidates that fail admission stay screening.
- Item 9 (rot): **verification carries its sync commit.** Each rule-to-code-to-test link records the commit it was last
  verified against and the symbols it covers; the hand-off check lists changes since then to the reviewer (screening);
  only broken structured links fail hard.
- Item 6 / judge: **user-path acceptance with drift triage.** Phase acceptance drives the product through the user's
  real entry point; each mismatch is classified as document drift, harness gap, product regression or unreachable
  precondition, so a broken product is never "fixed" by editing the document.
- RECORDS rule 7: **generated index with a read-only `--check`** that names the file and the fix command on drift.
- Backtests: screen visible material for hints of the answer (folder names, briefs, self-described intent) and grade
  old and new question banks on one blind scale.
Kept different on purpose: durable records from round one (not local logs), generative design that does not wait for
a failure, owner attention as the metric, and push only after the full suite.

## Added 2026-11-20 (gates that already caught something)

- **A round closes only when the remote CI is green on its exact SHA**, read from the CI's structured check results,
  not from an agent's report. Evidence: CI `verify` on Linux failed on four consecutive S4 pushes (7da50ab … c7d752c,
  `xattr` missing and lsof behaviour) while actor and judge reported all green from macOS runs; nobody looked.
- **Protected branches take only commits whose required checks already passed** (`scripts/gated-push.mjs`), because the
  host cannot enforce branch protection on a private repository without a paid plan. Tested: refuses an unpushed SHA
  and a SHA with a failed `verify`, passes the current `rewrite` head.

## Decisions on v0.2 open questions (lead, 2026-11-20)

- Item 1 amended by evidence: the frame reviewer sees the trajectory, the owner's earlier answers and the facts. The
  blind backtest (product-loop backtests/2026-11-20-frame-roles/RESULTS.md) found a trajectory-reading reviewer reproduces
  owner reframes better than a results-blind designer; results-blind design is no longer required.
- The owner budget defaults to three batches per phase: the phase-start batch plus at most two escalations.
- The access audit stays a hard gate: it reads structured tool fields only, and no legitimate non-judge role reads a
  sealed path; its red sample remains constructed until a real one is recorded (DEBT).
- `ACCEPTANCE: pass` stays one convergence condition among the structured ones until the product has its own
  acceptance tool.

## Added 2026-11-21 (owner): one blueprint

Owner: 你有没有一张整体设计的蓝图呢？ 你的生成引擎应该有一张整体的蓝图，记录你的顶层需求，整体重要feature的设计，为什么要这些
feature，以及哪些做完了，哪些没有。不然我们的设计稿件就也无法做到完整和单一真相源吧

Why: the loop had purpose records, decisions, a trajectory of blockers and the product's documents, but nothing that
joined them: no list of the product's features, each with the requirement it serves, why, where its design is, and
whether it is done. The order of the next phases lived only in the lead's private memory. A design set that cannot say
what it contains and what is finished cannot be complete or one source.

Requirement: the records hold one blueprint (RECORDS.md, kinds Blueprint, Feature status, Blueprint view): every
important feature with its requirements, why, design pointers into the product's documents (never copies, rule 9),
acceptance pointers and dependencies; its status only from append-only events that carry evidence; a generated view
the owner reads. A role call names the features it advances; a phase converges only when its features are done or
retired.
