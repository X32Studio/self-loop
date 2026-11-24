# Actor brief

Read the shared brief first. Derive the design from first principles (requirements, domain facts, ownership; never from
the cases) and read the critic's cases as labelled training data: fix the general mechanism each failing case exposes. A
change that cannot be justified from the requirements is overfitting, however many cases it passes. Never key behaviour
on a case id, name, size or constant.

## What it must do
<requirements digest with record IDs and pointers into the documents>

## Deliverables (only the paths you own)
- Implementation split by responsibility, thresholds as rule data defined once, unit tests for non-trivial logic, the
  scenario adapter (scripted fakes).
- `out/design/<area>.md` (recorded as `design/<area>.md`): current state only (no "Round N" sections; history lives in rounds and the repository):
  each mechanism traced to the requirement it comes from, module map, data flow, how each owner constraint is met with
  measured numbers, every place the documents were silent and the choice made, contract changes as proposals only.
- Verification: run targeted unit and package acceptance tests during iteration; when host-attested `suite-receipt.json` is staged in your workspace, do not re-run the full public suite on an unchanged tree (the host runs `gates.suite` once per `HEAD^{tree}` via `suite-green.mjs`, D-0061).
- Subtraction is part of the work: when a mechanism is superseded, delete it and its tests in the same change.
- When the previous round's remote CI was not green, making it green on the real CI platform comes first.
- Comments are pointers or tool directives (self-loop D-0016): a comment line holds only record IDs (`D-0016`,
  `R-0006-actor-b`, `SL-05`, `W-` and ten hex digits) or design anchors (`design/<file>.md#<anchor>`), or it is an
  interpreter line or a type, lint, coverage, formatter or build directive. Every "why" goes into `out/design/<area>.md`
  or the records, and the code points to it. The hand-off is refused (exit 7, nothing committed to the product) when
  your changes add or change any other comment line; deleting a comment always passes. In a subtraction round, move what an old comment says into the design
  first, then delete it.

Never lower a model's reasoning or swap to a weaker model to meet a latency target. Prompts give the model facts, never a
heuristic added after a failure. Real calls only within the bound in your prompt, raw answers saved per call.

## Report (`out/report.md`)
Module map; constraint numbers; targeted test counts as you ran them (plus the staged host `suite-receipt.json` counts when present), and for each failure whether the case is unfair
and why; what you deleted; open questions for the owner, each with your recommendation (the judge or the lead decides whether they reach the owner).
