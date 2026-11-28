# Acceptance suites

Run `node --test acceptance/*.test.mjs acceptance/time-budget/*.test.mjs` from the product worktree (Node 24 and Git).
This direct file-glob form runs suites across worker processes without a barrel file. These cases start the real
commands as child processes. Products, owner store, Git branches, records, clock, CI responses and scheduler paths are
isolated fixtures. Git network transports and provider commands are disabled in the children.

`node acceptance/run.mjs` discovers `acceptance/*.test.mjs` and `acceptance/time-budget/*.test.mjs`, repeats the public
cases with seeds 101, 202 and 303, and prints a timing and stability table. To run one domain or case, use
`node --test --test-name-pattern=REG-03 acceptance/registry.test.mjs`. For seeded subsets, use for example
`node acceptance/run.mjs --seeds 287,512 --test-name-pattern=REG-04` or target specific files directly.

## Living domain suites

- **Foundation, entrypoints, and hooks**: `registry.test.mjs`, `tick.test.mjs`, `heartbeat.test.mjs`, `normal-entry.test.mjs`, `alarm-entry.test.mjs`, `alarm-gate.test.mjs`, `lead-guard.test.mjs`, `delegation-guard.test.mjs`, `operational-hygiene.test.mjs`, `driver-regressions.test.mjs`, `continuation.test.mjs`, `antigravity-*.test.mjs`, `paseo-*.test.mjs`
- **Release, CI, and repository integration**: `closing.test.mjs`, `close-identity.test.mjs`, `ruling.test.mjs`, `prerelease.test.mjs`, `live-ci.test.mjs`, `codecommit-ci.test.mjs`, `push-destination.test.mjs`, `version-release-gate.test.mjs`, `suite-verification.test.mjs`, `suite-once.test.mjs`, `branch-integration.test.mjs`, `scoped-release*.test.mjs`
- **Comments and subtractive review**: `comment-admission.test.mjs`, `comment-directives.test.mjs`, `comment-resolution-and-subtraction.test.mjs`
- **Owner intent, provenance, and cadence**: `owner-words-and-interventions.test.mjs`, `owner-decisions.test.mjs`, `provenance-gate.test.mjs`, `predicate-coverage-and-cadence.test.mjs`, `cadence-delta.test.mjs`, `batch-replacement.test.mjs`
- **Planning, dispatch, capacity, and trajectory**: `plan-authority-batch.test.mjs`, `plan-file-ownership.test.mjs`, `plan-validation-and-overlap.test.mjs`, `dispatch-lifecycle.test.mjs`, `dispatch-holds-and-idle.test.mjs`, `host-capacity.test.mjs`, `judge-records.test.mjs`, `trajectory-and-blockers.test.mjs`, `measures-and-metrics.test.mjs`, `mandatory-control-plane.test.mjs`
- **Time-budget and fixtures**: `time-budget/*.test.mjs`, shared `*-fixture.mjs` modules, `fixtures/*.json`, and `candidate-replay.mjs`

## Baseline scenario catalogue

The owner store fixture uses the documented registry envelope. The clock varies by seed. Cases that
exercise concurrent ticks also vary their scheduled timestamps, and discovery cases vary the nesting depth.
`tick --json` exits 0 when quiet and 2 when it reports findings. An alarm is identified by the product's
Git records repository, phase and last activity. Tests read the alarm ledger at HEAD to verify durability.
Round closure cases vary the push repository, required checks, deciding run IDs and volume of unrelated check runs.
The two-loop cases use independent records and push destinations with identical Git objects. A fake `gh api`
serves check runs by repository and SHA and logs queries. The tests assert on ledger bytes and receipt contents.
The replay fixture projects public hand-off fields and preserves the original trajectory rows at records commit
`23bbfbb2c08ce1cb9446d3a53c804a0ee0f9f255`. It reconstructs the records view before each historical call. The passing replay changes only the round-1 CI word
in memory (D-0017). The equal-timestamp case commits the same records in both orders.
The prerelease cases run the release command and the actual pre-push gate against a disposable bare Git destination.

| ID | Surface | Attack | Why realistic | Expected property | Label |
|---|---|---|---|---|---|
| REG-01 | Registry | Start from a nested directory in one of two checkouts | Editors and sessions open in subdirectories | Both commands resolve only that product | ordered |
| REG-02 | Registry | Start in a sibling whose name starts with the registered path | Related notes and checkouts share prefixes | Exit 64 with a no-candidate diagnostic | fresh |
| REG-03 | Registry | A checkout rooted inside another registered project | Repositories can contain independent packages | Exit 64 naming both candidates | ordered |
| REG-04 | Registry | Use `--all` from outside six projects, with mixed activity and shuffled order | Schedulers and leads start outside a product | Every product gets its own `next` and stall result | ordered |
| REG-05 | Registry | Explicit flag and environment name different products than cwd | A lead can inspect another product from the current project | Flag wins, then environment, then registry | fresh |
| TICK-01 | Heartbeat | Recent and idle phase records coexist | A busy product had masked an idle one in I-0001 | Both products are counted. Only the idle product has a finding and a committed alarm | ordered |
| TICK-02 | Discovery | One registered repository lacks a config, one nested repository is unregistered, and one peer is outside the roots | Bootstrapping and forgotten registrations occur | Distinct findings inside the configured roots, and the recent control stays quiet | ordered |
| TICK-03 | Stall action | A new lead process starts in another product after the scheduler ran | Lead startup commonly happens away from an idle product | The default shows the already recorded stall | ordered |
| TICK-04 | Stall action | Resume is configured and a lead starts in another product with every adapter absent | Supported harness-neutral mode | Tick records `resume unavailable` and startup shows the alarm across products | ordered |
| TICK-05 | Records | Three ticks overlap across two products sharing a phase and activity time. One later resumes and stalls again | Schedulers and manual retries overlap, and products can stall more than once | Each product and idle period has one alarm. Retry leaves both records tips and the staged edit intact | ordered |
| HB-01 | Installation | Generate a scheduler setup from a dev clone newer than its installed release | A lead installs from a working checkout | Both scheduler commands call the detached release | ordered |
| RULE-01 | Ruling | Promote the actual judged SHA with green CI | Existing release path | Remains eligible | fresh |
| RULE-02 | Ruling | Promote a version-only tip on top of the ruled SHA | Each push changes VERSION | Eligible with CI queried for the tip | ordered |
| RULE-03 | Ruling | Promote a tip with VERSION and a code change | A version bump can accidentally include other changes | The ruling cannot authorize that tip | ordered |
| RULE-04 | Ruling | The ruled SHA's CI is green and the version tip's CI is red | CI is scoped to each revision | The current check queries the tip and rejects it | fresh |
| DISC-01 | Discovery | A Git records root sits beneath a project's nested team folders | Teams group products under ordinary directories | The deep and shallow records repositories each appear as unregistered | ordered |
| DISC-02 | Discovery | Tracked `records.json` fixtures in an ordinary code repository | CLI and integration tests ship fixture data | No discovery findings | ordered |
| CLOCK-01 | Heartbeat | The configured integration branch is renamed after a product goes idle | Branch renames can precede config updates | Tick reports the `next` error and commits the independently determinable stall | ordered |
| CLOCK-02 | Heartbeat | The same branch rename happens during active work | A broken ref alone says nothing about idle time | Tick reports the error and creates no stall alarm | ordered |
| ISOLATE-01 | Stall view | The first registered product has a malformed committed trajectory row | A partial ledger write can reach a records commit | A per-product read diagnostic accompanies the healthy products' respective clock results | ordered |
| ISOLATE-02 | Stall view | Both registered products are readable and active | This is a normal inspection during work | Exit 0 includes both quiet products | ordered |
| RULE-05 | Trajectory | Close a VERSION-only tip on green CI | A release commit follows a ruling | One live read for the pushed SHA, both SHAs and a success receipt in the row | ordered |
| RULE-06 | Trajectory | A green tip also edits release notes | An edit can slip into a bump | Refuse before querying or writing | ordered |
| RULE-07 | Trajectory | Pass the removed `--ci success` flag | A lead can paste an old command | Exit 64 naming the flag before any CI read | ordered |
| RULE-08 | Trajectory | The exact pushed tip fails a required job | The job can fail after the judge rules | No CONVERGED row, and the diagnostic names the failing check | ordered |
| RULE-09 | Trajectory | Only the earlier judged SHA has green CI | The bump has independent CI | One live read for the red tip and no row | ordered |
| RULE-10 | Trajectory | Record CONTINUE while the pushed tip is red | Supervision needs the failed CI fact | Both SHAs and a failure receipt from one live read | ordered |
| RULE-11 | Next | Execute the printed command for a judged tip | The lead copies commands from next | No identity or receipt flags and one live destination read | ordered |
| RULE-12 | Trajectory | The fetch repository is green and the push fork is red on the same SHA | Fetch and push URLs can diverge | Read the fork, refuse and preserve the ledger | ordered |
| RULE-13 | Next and trajectory | Copy the printed append while an upstream receipt is green and destination CI is red | Review and landing use different repositories | The copied command queries the destination and refuses | ordered |
| RULE-14 | Next and trajectory | Partial receipt is green while a required job is missing, then finishes | A manual query can use fewer checks | The same command declines until the full live check set passes | ordered |
| RULE-15 | Trajectory | Non-default release remote, distinct push URL, reversed checks | Release remotes coexist and response order varies | Green closes in both orders with one read per row | ordered |
| RULE-16 | Next and trajectory | A red rerun is recorded after the command was copied | Reruns can finish before the lead writes | Reject from one current destination read | ordered |
| RULE-17 | Next and trajectory | Red reruns green with a red receipt still on disk | A rerun can recover without a new receipt | The same append succeeds after recovery | ordered |
| RULE-18 | Next and trajectory | Green and red receipts share a timestamp and misleading filenames | Evidence prefixes are user-chosen | The live red result controls | ordered |
| RULE-19 | Next and trajectory | Red rerun exists only on the server | No one has collected the new result | The copied append declines without modifying the ledger | ordered |
| RULE-20 | Next and trajectory | A green rerun exists only on the server | A maintenance rerun can pass again | The copied append still succeeds, recording its one live reading | ordered |
| RULE-21 | Next and trajectory | CI becomes unreadable after a green receipt exists | API or auth can fail | Refuse with a new reading command and no row | ordered |
| RULE-22 | Blueprint | Baseline completion with an old green receipt and a live red rerun | Baseline evidence can be collected early | Refuse done and preserve the ledger after one live read | ordered |
| RULE-23 | Blueprint | Baseline completion after a newer green rerun | A baseline check can rerun green | Append done after one live read | ordered |
| RULE-24 | Blueprint | Server becomes unreadable before baseline completion | The local receipt can outlive API access | Refuse done after one attempted read | ordered |
| RULE-25 | Trajectory | Record CONTINUE while CI is unreadable and an older receipt is green | A ruling can proceed during an outage | Write unknown with its cause and one attempted read | ordered |
| RULE-26 | Blueprint | Non-done event cites prior round evidence during an outage | Design work continues even if CI cannot be read | Append the non-done event without a live check | ordered |
| RULE-27 | Trajectory | The exact judged SHA reruns red, with no version tip | Some rulings target the integration head itself | Refuse from one read of the judged SHA | ordered |
| RULE-28 | Blueprint | Mark done from a round after CI reruns red on its VERSION-only tip | The lead advances a feature after closing the round | Done records the ruled SHA, the pushed tip and its historical green receipt without a new CI read | ordered |
| RULE-29 | Blueprint | A CONTINUE ruling has CI success | A judge can find a blocker even when CI passes | Done refuses and preserves the ledger | ordered |
| RULE-30 | Blueprint | Add either legacy evidence flag to the round-backed done command | Old copied commands may include them | Exit 64 naming the flag and preserve the ledger | ordered |
| RULE-31 | Blueprint | Baseline points to an otherwise valid receipt outside its records | A lead collects evidence in a sibling directory | Refuse done and preserve the ledger | fresh |
| R5-CI-01 | Ledger identity | Pass the old A config and green receipt while writing B | Two loops share Git history and commands can be copied | B stays byte-for-byte unchanged and the old arguments are refused | ordered |
| R5-CI-02 | Ledger identity | Supply each of the five removed flags separately | All five appear in old scripts or commands | Each exits 64 naming itself before reading or writing | ordered |
| R5-CI-03 | Ledger identity | Leave A in the environment or run from A's records or checkout | The lead can work on multiple loops in one shell | Only B's destination is read and the red ledger is preserved | ordered |
| R5-CI-04 | Ledger identity | Open B's ledger through a shortcut under A | A local alias can point across records repositories | Red B refuses. Green B writes exactly one row and receipt in B | ordered |
| R5-CI-05 | Ledger identity | Place A's authentic green receipt under B's evidence | Copies of CI receipts can land in the wrong project | Query B's destination and preserve B's red ledger | ordered |
| R5-CI-06 | Phase | Append with another phase or case-only spelling change | Copied or mistyped phase names are common | Exit 2 naming both phases before query or append | ordered |
| R5-CI-07 | Ledger identity | Close a detached log or a records repo without loop.json | A repository can be copied without its configuration | CONVERGED refuses. CONTINUE records absent without a query | ordered |
| R5-CI-08 | Offline check | Alter the stored receipt's SHA or CI word after recording a genuine row | A review can receive a damaged or copied receipt | Records check detects the mismatch offline | fresh |
| R5-CI-09 | CI alarms | Replay all four relevant words plus an unjudged row | Historical and new ledgers can mix CI results | Only judged absent and unknown raise ci-absent | ordered |
| R5-CI-10 | Ledger identity | Point to a trajectory copy beside the canonical ledger | A lead may mistake an archival copy for the ledger | The copied path cannot receive CONVERGED | fresh |
| R5-CI-11 | CI coverage | Read empty results and hundreds of unrelated successful runs with matching names | Many checks can share a name across apps | Distinguish absent, red and green with one read per attempt | fresh |
| R5-AL-01 | Alarm gate | Replay R-0003-critic and R-0004-critic on the original history | Both calls followed undiagnosed partly closed rounds with absent CI | Exit 7. Round 3 names `partly-closed:v1:watch:2`, `blocker-recurring:tip-ci-evidence`, `ci-absent:v1:1` and `ci-absent:v1:2`. Round 4 also names `partly-closed:v1:watch:3`, `area-rounds:v1:watch` and `ci-absent:v1:3`. | ordered |
| R5-AL-02A | Alarm gate | Replay every round-2 call on the original history | Round 1 never reached CI, and no diagnosis names the gap | Exit 7 naming exactly `ci-absent:v1:1` for each call | ordered |
| R5-AL-02B | Alarm gate | Replay every round-1 and round-2 call with round 1's CI word set to `success` | A green first round is the legitimate counterpart to the absent-CI replay | Every call passes on the otherwise identical history | ordered |
| R5-AL-05 | Alarm gate | A partly-closed alarm grows after diagnosis of the earlier key | A later ruling can leave a blocker open again | Prepare refuses the new key until a later diagnosis names it | ordered |
| R5-AL-06 | Alarm gate | Older phase has an alarm on an overlapping round number | Phase histories share one ledger | A call in the clean phase passes | ordered |
| R5-AL-07 | Alarm gate | Run, prepare or dry-run any adversarial role while a diagnosis is owed | Both launch paths are used in regular work | All adversarial modes refuse before a workspace exists. Reviewer proceeds | ordered |
| R5-AL-08 | Alarm gate | Diagnosis predates the row or belongs to another phase | Reviews can be recorded before a delayed ruling or concern another phase | Both acknowledgements leave the current alarm active | fresh |
| R5-AL-09 | Alarm gate | Alarm appears while a prepared child is finishing | An in-flight child still owes a hand-off | Record commits the existing child's hand-off | ordered |
| R5-AL-10 | Alarm gate | A task quotes the key in prose and another report has an alarms line | Historical notes can copy alarms verbatim | The diagnosis task's declaration is required | fresh |
| R5-AL-11 | Alarm gate | Swap the commit order of a diagnosis and a triggering row with identical timestamps | A ruling and a diagnosis hand-off can land in the same second | The gate admits the call only when the diagnosis commits after the row | ordered |
| R5-VER-01 | Prerelease | Release prereleases and then a plain release for the same core version | Round candidates precede general release | Every branch update and exact tag arrives at the destination | ordered |
| R5-VER-02 | Prerelease | Push numeric, mixed ASCII and equal-prefix identifiers with distinct case-folded tag names | CI increments can have several digits and prerelease channels vary | Real pre-push follows SemVer precedence | fresh |
| R5-VER-03 | Prerelease | Try v1.9 after v1.10 and a prerelease after the final version | A stale branch or stale counter can make either | Both refuse and preserve destination refs | fresh |
| R5-VER-04 | Prerelease | Use invalid numeric identifiers, symbols, empty suffix or build metadata | Operators can edit VERSION manually | CLI and actual hook refuse, even with matching tag names | fresh |
| R5-VER-05 | Prerelease | Use a mismatched tag, omit the exact tag, then release with a red suite | Candidate pushes still need the release guarantees | Each refusal identifies its gate before remote updates | fresh |
| R5-VER-06 | Prerelease | Close and promote a VERSION-only prerelease tip | The round push needs a new VERSION after judgment | The ruling covers the tip and CI is read for that SHA | ordered |
| R5-BAT-01 | Decisions | Replace an unknown original | A copied batch ID can be wrong | Exit 2 with no record changes | ordered |
| R5-BAT-02 | Decisions | Cite an unknown replacement | A copied batch ID can be wrong | Exit 2 with no record changes | ordered |
| R5-BAT-03 | Decisions | Replace a batch with itself | A command can duplicate the same ID | Exit 2 naming the self-replacement | ordered |
| R5-BAT-04 | Decisions | An answered lower-ID batch names the pending later one | A backlog may discuss future questions | Exit 2 for the incorrect ordering | ordered |
| R5-BAT-05 | Decisions | Newer replacement remains unanswered | The lead can try to close both before a response arrives | Exit 2 identifying the unanswered replacement | ordered |
| R5-BAT-06 | Decisions | Try to replace a batch already answered | Owner answers and lead follow-up can overlap | Exit 2 and preserve the prior words | ordered |
| R5-BAT-07 | Decisions | Later answered batch text omits the original | A related decision could be mistaken for its replacement | Exit 2 for the missing citation | ordered |
| R5-BAT-08 | Decisions | Replace an already replaced batch | A retry may choose a different newer answer | Exit 2 and leave the prior replacement intact | ordered |
| R5-BAT-09 | Decisions | Later answered text names the open original | An owner can resolve an earlier question by settling its replacement | Close in status and next, keep exact owner words, pass records check | ordered |
