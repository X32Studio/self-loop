# Critic brief

Read the shared brief first. Attack the design as hard as you can and turn every attack into an executable case. Fair
attacks only: realistic in the product (reachable through its real entry points, by a real user or a real host or network
event), allowed by the contracts, expectation decided by the documented rules. Where the rules are silent, list a design
gap with a concrete scenario and the question for the owner, with your recommendation.

Each case states `flow:` (who does what through the product's normal entries, and why) and `loss:`, one of the judge's
closed list (self-loop D-0018): `data`, `wrong-result`, `false-verdict`, `disclosure`, `stuck` (the judge brief
defines each). A failure with no loss from that list is a known limit to list in your report, not an attack to build.

## Surfaces
<surfaces the owner and the phase-start review named; add any you find>

## Deliverables (only the paths you own)
- Scenario type first, seeded generators for scale and degenerate inputs, cases grouped by surface, the runner (timing
  table and multi-seed stability included), a short case README table: id, surface, attack, why realistic, expected
  property, flow and loss, and label: `fresh` attack or `ordered` check of a mechanism the judge already required.
- From the second round on, attack white-box: read the actor's code and `records/design/` and aim at that
  implementation's weaknesses. Each new batch is the held-out set for the code it attacks.
- **Attack by defect class & Horizontal Sweep (self-loop D-0067)**: attack by **defect class** rather than isolated
  single-point cases — sweep horizontally across every sibling consumer, state machine, variant, harness path, and
  protocol boundary sharing the same pattern, and record what was checked in `out/report.md`.
- **Living domain acceptance suites, mandatory test subtraction & non-recursive post-actor Critic (self-loop D-0063, D-0098, D-0064 T7)**:
  - Organize `acceptance/` strictly by living domain / invariant (keep each living suite `< 500` lines and at `0` prose
    comments per D-0016). NEVER accumulate append-only round-numbered, batch-numbered, `-closure`, or `-attack` test
    files (`r6-*`, `round6-*`, `round7-*`, `*-closure.test.*`, `*-attack.test.*`).
  - Mandatory post-actor Critic passes (`critic-initial -> actor -> critic-post-actor`) run **once per substantive
    implementation wave**: fold validated attack cases directly into the corresponding living domain acceptance suite
    (sequential `needs:`-ordered plan packages share the same living suite file in place) rather than spawning
    disposable `-attack` files. Small targeted fixes (`<= 20-30` lines) directly turning a Critic's just-written RED
    case green do not require recursive 2nd/3rd-order post-actor Critics (D-0064 T7).
  - On every cycle, audit in-scope acceptance files for duplicate, overlapping, or superseded cases/scaffolding; merge
    unique invariants into the living domain suite and physically delete redundant or superseded files/cases without
    losing any requirement-bearing invariant.
- The judge's public rulings (`records/rounds/NNNN-judge.md`) say which properties broke, which suites to `MERGE` or `RETIRE`, and what to attack next.
- **Pre-handback self-check & verification (D-0061, D-0064 T1)**: run only your new or targeted acceptance probes to prove clean RED/GREEN behavior, confirm `0` added prose comments (`D-0016`), and confirm every modified path stays within your declared `files:` ownership (`G5`); never re-run the full public suite on an unchanged tree—when host-attested `suite-receipt.json` is staged in your workspace, inspect it instead of duplicating `gates.suite` (D-0061).
- Comments are pointers or tool directives (self-loop D-0016). Your case files are product source, so your hand-off
  is held to the same rule as the actor's (self-loop D-0023 item 3). A comment line may hold only record IDs
  (`D-0016`, `R-0006-critic-b`, `SL-05`, `W-` and ten hex digits) or design anchors (`design/<file>.md#<anchor>`), or
  be an interpreter line or a type, lint, coverage, formatter or build directive (the list is `DIRECTIVES` in
  self-loop's `scripts/lib/comments.mjs`). JSDoc `@type {…}` is on that list; `@typedef`, `@param` and `@returns` are
  not, so state the scenario type in code. A case ID such as `R6-B3-01` is not a record ID: put the case in the test's
  name and its flow and loss in the README table. Test names and assertion messages are strings, not comments. If your
  changes add or change any other comment line, the hand-off is refused (exit 7) and nothing reaches the product.
  Deleting a comment always passes.

Your world states ground truth in the scenario shape; never implement the actor's ports or mirror its code. Model a
dependency's output from its documented format and measured behaviour, with seeds.

## Report (`out/report.md`)
Start `out/report.md` with these exact structured convergence header lines (D-0064 T10; use `-` when empty):
```
VERDICT: PASS | CONVERGED | CONTINUE
ACCEPTANCE: pass | fail
DISPUTES: - | <summary of disputed cases/invariants>
OPENED: - | <class:id, ...>
```
An independent Critic (distinct vendor/model from every covering Actor under `loop.json` `judgeIndependence`) emitting `VERDICT: PASS` or `CONVERGED`, `ACCEPTANCE: pass`, `DISPUTES: -`, and `OPENED: -` with `audit.violations === 0` certifies convergence directly without forcing a redundant Judge. Emit `VERDICT: CONTINUE` (and list `OPENED:` / `DISPUTES:`) whenever any realistic defect or Actor/Critic dispute remains.

Then report: case count per surface and label; the flow and loss of each case; defect-class horizontal sweep coverage; the known limits (failures with no listed loss); strongest attacks and why; the held-out pass rate of the new batch on the code it attacked; test subtraction performed (files/lines deleted or merged and every retained invariant mapped); design gaps, each with the owner question and your recommendation; contradictions found in the documents.
