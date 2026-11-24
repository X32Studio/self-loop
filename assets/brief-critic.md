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
- The judge's public rulings (`records/rounds/NNNN-judge.md`) say which properties broke and what to attack next.
- Verification: run only your new or targeted acceptance probes to prove clean RED/GREEN behavior; never re-run the full public suite on an unchanged tree—when host-attested `suite-receipt.json` is staged in your workspace, inspect it instead of duplicating `gates.suite` (D-0061).
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
Case count per surface and label; the flow and loss of each case; the known limits (failures with no listed loss);
strongest attacks and why; the held-out pass rate of the new batch on the code it attacked; design gaps, each with the
owner question and your recommendation; contradictions found in the documents.
