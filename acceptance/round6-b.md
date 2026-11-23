# Round 6 package B acceptance

Run all cases with `node --test acceptance/round6-b.mjs`. Run the seeded timing and stability table with
`node acceptance/run.mjs --seeds 101,202,303 acceptance/round6-b.mjs`.
Use `node --test --test-name-pattern R6-B1-03 acceptance/round6-b.mjs` to run one case by ID.

The scenarios describe three independent sources of truth.

```ts
type History = {
  git: { branchHead: SHA; protectedHeads: SHA[]; parents: [SHA, SHA][] };
  recordsInCommitOrder: ({ judged: SHA; versionTip?: SHA } | { handoff: SHA; base: SHA })[];
};
type Host = {
  budget: number;
  prepared: { loop: string; workspaceLive: boolean; recorded: boolean }[];
  processes: { kind: "role" | "reviewer" | "suite"; live: boolean }[];
};
type Patch = {
  role: "actor" | "critic";
  baseFiles: Record<string, string>;
  edits: Record<string, string | null>;
  newProse: [path: string, line: number, text: string][];
};
```

| ID | Surface | Label | flow: realistic attack | loss: | Expected property |
| --- | --- | --- | --- | --- | --- |
| R6-B1-01 | Integration | ordered | The lead runs both next entries from a lagging integration ref after closing a round on a protected VERSION tip. | false-verdict | Both name the judged SHA and tip, propose a fast-forward and retain the ruling. |
| R6-B1-02 | Integration | ordered | The lead records a critic and then an actor prepared on explicit SHAs for reproducibility. | wrong-result | Both descending hand-offs advance the integration ref. |
| R6-B1-03 | Integration | ordered | The lead opens next after a ref recovery left recorded hand-offs ahead of the ref. | wrong-result | Suite and judge commands and the live CI query target the newest recorded descendant. |
| R6-B1-04 | Integration | ordered | Two roles prepared concurrently from the same judged SHA finish in either order. | wrong-result | The second hand-off preserves the first branch update. Next names both heads and requests a merge. |
| R6-B1-05 | Integration | ordered | A lead records a role that was still in flight when a different SHA became the judged baseline. | wrong-result | The result remains recorded with a stale-base warning and the branch preserves the judged SHA. |
| R6-B1-06 | Integration | fresh | The lead checks next after a local branch picks up a source change and a version bump absent from the records. | false-verdict | The source-changing tip cannot substitute for the latest judged SHA in live checks. |
| R6-B1-07 | Integration | fresh | A parallel role is recorded immediately before the judge row, within the same timestamp second. | wrong-result | An earlier recorded hand-off does not advance the new ruling. |
| R6-B1-08 | Integration | fresh | The lead resumes with an integration branch containing independent recovery work. | wrong-result | Next names the divergence and prints a usable merge command for the newest judged SHA. |
| R6-B2-01 | Host load | ordered | The lead opens next on the second loop while two roles and a host suite are active. | wrong-result | The three live jobs fill the shared budget. Removing the suite restores heavy actions. Finishing both roles clears the load. |
| R6-B2-02 | Host load | ordered | The lead adjusts host capacity and resumes after killed jobs and a removed prepared worktree. | false-verdict | Dead work does not consume slots. Live load at or above the new budget inhibits heavy suggestions. |
| R6-B2-03 | Host load | fresh | The lead runs a reviewer while a separate loop prepares a role and needs to record it. | false-verdict | The reviewer consumes no slot and the full budget leaves recording available. |
| R6-B3-01 | Comment gate | ordered | An actor hands off a new prose comment and then corrects it in the prepared worktree. | false-verdict | Exit 7 gives the exact location and permits a pointer-only retry with no rejected commit. |
| R6-B3-02 | Comment gate | ordered | An actor edits an inline comment, then tries a valid code edit that shifts the original comment down. | false-verdict | Changed comment text refuses. Unchanged legacy text passes. |
| R6-B3-03 | Comment gate | ordered | A critic adds explanatory prose in an acceptance source file. | false-verdict | The critic faces the same refusal as the actor and can retry with record pointers. |
| R6-B3-04 | Comment gate | ordered | An actor adds scripts with directives used by both products and removes old comments during subtraction. | false-verdict | Captured directives, pointers, and deletions pass intact. |
| R6-B3-05 | Comment gate | ordered | An actor adds generated JS with URLs, regular expressions after an if condition and template data. | false-verdict | Valid expressions and literals pass at seeded scale. |
| R6-B3-06 | Comment gate | fresh | An actor adds prose inside a JS template expression and after a string containing URL slashes. | false-verdict | The actual comments refuse, while surrounding code still passes on retry. |
| R6-B3-07 | Comment gate | ordered | An actor adds configuration, rendered HTML, and scripts with comment-like data. | false-verdict | Hashes in values, heredoc contents, nested Swift pointers and markers in strings pass. |
| R6-B3-08 | Comment gate | fresh | An actor adds prose adjacent to string tokens and nested Swift comments. | false-verdict | All seven real comment lines are named, while the surrounding fixture can be retried. |
| R6-B3-09 | Subtraction | ordered | The lead reads next before subtraction with two legacy comments in the judged tree and a different local draft. | wrong-result | Next shows the judged tree's count and continues to report convergence. |
| R6-B3-10 | Subtraction | ordered | The lead records subtraction review and checks completion while legacy prose remains. | false-verdict | The reviewer hand-off activates the convergence condition and next names the count. |
| R6-B3-11 | Subtraction | ordered | A lead checks completion after subtraction review in a tree with only pointers and ordinary source strings. | false-verdict | The legitimate closing tree still converges. |
| R6-B3-12 | Comment gate | fresh | An actor adds prose in extensionless Node and shell scripts and an extensionless Git hook. | false-verdict | Shebang and hook detection enforce the same rule, and reference-only retries pass. |
| R6-B3-13 | Comment gate | fresh | An actor copies an existing legacy comment when adding a similar default. | false-verdict | Copying counts as a new addition and is refused, while retaining the original passes. |
