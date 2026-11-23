# Round 6 package C

C1 follows D-0018 and D-0023. C2 follows D-0019. The base is cc3231e40f37e36f1d48fe9db49ba0fbad96f0b6.

| ID | Surface | Attack or control | Why realistic | Expected property | Label |
|---|---|---|---|---|---|
| R6-C-R01 | Judge records | Missing flow | A judge reports the outcome without the user path | Hard failure names the record, key and flow | ordered |
| R6-C-R02 | Judge records | Missing loss | A judge describes the user path and omits the loss | Hard failure names the record, key and loss | ordered |
| R6-C-R03 | Judge records | Loss outside the list | A judge coins a compound for a consequence | Hard failure names the record, key and loss | ordered |
| R6-C-R04 | Judge records | Borrowing a neighboring block's loss | A judge opens two blockers and annotates only the second fully | Each key needs both fields in its own block | fresh |
| R6-C-R05 | Judge records | Confusing an ID with a longer ID | A longer review enumerates blockers and mixes short and qualified names | Exact keys and all five loss words are recognized | fresh |
| R6-C-R06 | Judge records | Historical replay | R-0001-judge through R-0005-judge are real public reports | The four old rulings and the first compliant ruling pass | ordered |
| R6-C-R07 | Judge records | A judge hands off after the decision takes effect | A prepared call can use the earlier pinned view | Adoption is decided from the view commit | ordered |
| R6-C-R08 | Judge records | A closed blocker lacks the new fields | A judge closes an existing blocker without opening another | The requirement applies to opened keys | fresh |
| R6-C-G01 | Lead guard | Local Git exclude | The lead changes the hook settings file from D-0019 | Local settings pass and shared settings remain protected | ordered |
| R6-C-G02 | Lead guard | Gitignore on a first write | A harness creates its local settings tree on first use | An ignored new path passes and a trackable one is refused | ordered |
| R6-C-G03 | Lead guard | User-wide excludesFile | A lead keeps one ignore list across products | Paths in core.excludesFile remain editable | ordered |
| R6-C-G04 | Lead guard | Tracked ignore match or new source | An ignore rule can match an already tracked file | Tracked and trackable source remain protected | ordered |
| R6-C-G05 | Lead guard | Same path with different index entries | A local settings file can be staged in just one linked checkout | The edited checkout's index determines tracked status | fresh |
| R6-C-G06 | Lead guard | Custom allow paths and role workspaces | The lead writes documentation while actors edit source | Both exceptions pass and source outside them is refused | ordered |
| R6-C-G07 | Lead guard | Direct push and unreadable hook input | The hook receives both commands and adapter payloads | Direct push is refused, readable benign and unreadable input pass | ordered |

Run the records or guard file directly with Node's test runner. To select a case, pass its ID as the test name pattern.

```sh
node --test --test-name-pattern=R6-C-R04 acceptance/round6-judge-records.test.mjs
node --test --test-name-pattern=R6-C-G05 acceptance/round6-lead-guard.test.mjs
node acceptance/run.mjs --seeds 101,202,303 acceptance/round6-judge-records.test.mjs
node acceptance/run.mjs --seeds 101,202,303 acceptance/round6-lead-guard.test.mjs
```

The C1 refusal samples are constructed. R6-C-R06 replays the five public ruling files and their trajectory rows from records commit a77bdf27d1b100236861f1eb1c583239fa67be37. It reconstructs the relevant pre- and post-adoption Git views and substitutes their local SHAs in the report headers. It uses public-only hand-off entries so the acceptance suite is self-contained.
