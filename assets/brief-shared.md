# <Product> self-loop, phase <P>: shared brief (every role reads this)

## Purpose
<Owner's purpose for this phase, quoted verbatim with date, and the records IDs that hold it: P-NNNN.>
The scarcest resource is the owner's attention. Never ask the owner for what an agent can find out or do.

## Where
- You run in a fresh working folder named in your prompt; it holds this brief, your role brief, `records/` (a read-only
  view of the loop's records at one commit, holding only what your role may read; read `records/INDEX.md` first) and
  `out/`, the only place you write outside the paths your role owns.
- `task.md` in the same folder is the lead's instruction for this call (the mode, what to attack or fix, alarms and
  facts gathered for you).
- Critic, actor and judge also get a fresh detached worktree of the product at the commit the lead names, as their
  current directory. How to run code, tests and the type check: `<commands>`. Shared machine limits: `<limits>`.
- Your changes to the paths your role owns are committed for you; changes elsewhere are not taken and are reported.
  Everything you write under `out/` is recorded with your report.

## Read first (authoritative, in order)
1. <product purpose and requirements documents>
2. <architecture / rules documents; the rule IDs and the code and tests each names>
3. <contracts and their validators>
4. Decisions in force: `records/decisions/` (the index marks superseded ones).

## Hard constraints from the owner (non-negotiable, verbatim)
- <numeric budgets, stability, scale>
- Architecture: <entry points and boundaries>; contract changes only as proposals.
- Real dependencies from round one: <which real services/models, spend bound>.

## Fixed interfaces
- Critic owns `<cases dir>`, `<runner>`; writes `<scenario type>` first.
- Actor owns `<implementation dirs>`, `<adapter>`; its design note is `out/design/<area>.md`, recorded with its report; the lead promotes it to `design/<area>.md`.
- Judge writes only its reports (`out/report.md` private, `out/public.md` for critic and actor); held-out cases are its alone.

## Citations
Cite records by ID (`D-NNNN`, `R-NNNN-judge`), mutable files at a commit (`src/x.js@<commit>`), evidence by digest. A
bare `file:line` in a file that changes is not a citation.
