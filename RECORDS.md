# The loop's records

How a self-loop keeps its own documents, so that every agent knows where to look and whether what it reads is true.
It applies to the loop the rule the loop enforces on products: records are working material, managed by mechanism.

## Why records must be managed

Without structured, versioned records, autonomous loops fail in predictable ways:

- Gigabytes of working state and thousands of files end up in `/tmp` or scratch folders that a reboot can wipe, mixed with requirements and rulings.
- Design notes grow to thousands of lines mixing current architecture with "Round N" history, making it impossible to know what the system guaranteed at any point in time.
- Reports cite `file:line` in mutable files, drifting as code changes.
- Rulings sit in prose files with no lifecycle status, so superseded assertions stay buried.
- Briefs list paths manually, and agent memory files grow by appending stale restatements.

## Layout

One records repository per product loop, versioned, outside scratch space, created before round 1. By default,
`self-loop.mjs init` creates it as a nested, Git-ignored repository at `<product>/.self-loop/` (ignored via the parent
repository's `.gitignore`, or `--local-exclude` in `.git/info/exclude` for a zero-diff parent working tree; a path
already tracked by the parent repository is refused fail-closed). An explicit external `--records <dir>` uses the same
repository layout and rules without touching the parent repository's ignore files. Because role calls run in detached
product worktrees created from committed product trees, nested `.self-loop/` records never appear in role worktrees and
remain forbidden to non-lead roles under `audit-access.mjs`. Bulky working state (worktrees, dependencies, builds,
temporary directories) never lives in the records repository and is never cited.

| Kind | Path | Writer | Changes | Cited as |
|---|---|---|---|---|
| Purpose | `purpose/P-NNNN.md` | lead, distilling dated requirements from owner words | append-only; a later entry may supersede | `P-NNNN` |
| Decisions | `decisions/D-NNNN.md` | owner, lead or judge (field `by`) | immutable; status changes only by a new decision with `supersedes` | `D-NNNN` |
| Design | `design/<area>.md` | `call.mjs`, from the actor's `out/design/<area>.md` | edited in place, current state only; history is the repo's history | `design/<area>.md@<commit>` |
| Rounds | `rounds/<NNNN>-<role>.md` | `call.mjs`: the lead's task and the role's report verbatim, the view commit; for the judge only its public report (`out/public.md`) | immutable | `R-NNNN-<role>` |
| Sealed | `sealed/` | critic (held-out cases), `call.mjs` (the judge's full record, log, audit and outputs, per attempt) | immutable; readable only by judge and lead; public cases live in the product repo | path at commit |
| Evidence | `evidence/<NNNN>/` | `call.mjs`, per attempt (`<step>-<k>`): log, audit, every other file the role wrote under `out/`; failed attempts included. A critic or actor attempt refused by the comment gate (D-0016) also gets `<step>-<k>-comments.json` = `{ id, role, attempt, base, prose }`, where `prose` contains established prose `{ path, line, text }` or pending source-bound candidates (Comment resolution below). `trajectory.mjs append`: the CI reading of each row it writes (`ci-<sha12>-<n>/receipt.json`) | immutable | path plus SHA-256 |
| Normal-entry inventory | `evidence/normal-entry/` | coordinator (lead) | edited in place, current snapshot only; history is the repo's history | path at commit |
| Blueprint evidence | `evidence/blueprint/` | lead, baseline CI receipts from `ci-green.mjs --out` | immutable | records path |
| Hand-offs | `metrics/handoffs.jsonl` | `call.mjs`, one line per successful role call | append-only | line, by its record ID |
| Trajectory | `metrics/trajectory.jsonl` | lead (`trajectory.mjs append`), one row per ruling: area, verdict, blockers opened, closed, shelved and carried, the CI word and receipt of the append's own reading, and the pushed tip when it is a VERSION-only descendant of the ruled commit | append-only | line, by round |
| Alarms | `metrics/alarms.jsonl` | `self-loop.mjs tick`, through the records commit helper: one line per stall (one idle period), with the action taken | append-only | line, by its key |
| SSOT sync | `metrics/ssot-sync.jsonl` | `ssot-check.mjs attest`, one line per authority doc sync or no-contract-change attestation | append-only | line, by entry ID |
| Continuation delivery | `metrics/continuations.jsonl` | continuation-store.mjs | append-only | records commit + row ID |
| Owner batches | `owner/B-NNNN.md` | `decisions.mjs send`, from validated questions only | immutable | `B-NNNN` |
| Owner answers | `owner/answers.jsonl` | `decisions.mjs answer`: the owner's words verbatim, one event per answer; `decisions.mjs replace`: one event per replaced batch, with no words | append-only | line, by batch |
| Interventions | `interventions/I-NNNN.md` | lead | append-only | `I-NNNN` |
| Lessons | `lessons/L-NNNN.md` | lead | append-only; field `applies-to: skill / product / both` and the change it led to | `L-NNNN` |
| Engines | `engines/<engine>.md` | lead | versioned; each change names its backtest score | at commit |
| Backtests | `backtests/<date>/` | builder, reviewers, grader (separate) | immutable | path |
| Research | `research/<topic>.md` | lead or a research agent | edited in place, dated | `research/<topic>.md@<commit>` |
| Blueprint | `blueprint/F-NNNN.md` | lead, from the frame reviewer's design at a phase start or the owner's requirement | edited in place, current state only; never holds a status | `F-NNNN` |
| Feature status | `metrics/blueprint.jsonl` | `blueprint.mjs set`, one event per status change, with its evidence | append-only | line, by feature |
| Plan | `plans/PL-NNNN.md` | lead, from an owner decision or an independent ruling; `plan.mjs validate` before the commit | immutable; revised by a new plan whose `supersedes:` names it | `PL-NNNN` |
| Forecast observation | `forecasts/FO-<digest>.json` | lead, through the ordinary explicit-path records commit workflow | immutable; digest is SHA-256 of exact UTF-8 JSON file bytes | path at commit plus SHA-256; no `citedAs` |
| Repository | `README.md`, `records.json`, `loop.json`, `.gitignore` | lead | edited in place | — |
| Index | `INDEX.md` | generated by the check | regenerated | — |
| Blueprint view | `BLUEPRINT.md` | generated by the check from the blueprint and its status events | regenerated | — |
| Owner words | `owner/words.jsonl` | `owner-words.mjs capture` or `sync`, verbatim | append-only | line by its W-xxxxxxxxxx ID |
| Owner word marks | `owner/word-marks.jsonl` | `owner-words.mjs mark`: the word's class (`direction` with its intervention, `answer` with its batch, `routine` or `not-owner` with a reason); the latest valid mark of a word holds | append-only | line by its W-xxxxxxxxxx ID |
| Rules | `AGENTS.md` | lead | edited in place | at commit |

Forecast observations use `plan-forecast/v1`, separately from the optional `plan-time/v2` root baseline in
`plans/PL-NNNN.md`. The coordinator registers this exact extra kind in the records repository before publication:

```json
{"kind":"Forecast observation","path":"forecasts/FO-<digest>.json","changes":"immutable","settlesOwnerWords":false}
```

There is no `citedAs`: a forecast cannot settle owner words. Its filename contains the lowercase 64-hex SHA-256 of
its exact file bytes, without an embedded self hash. Root/plan refs, parent forecasts, `outlook.basedOn`, inputs,
estimates, reserve and promises are pinned public evidence; `scripts/lib/plan-time.mjs` reads committed blobs and
reachable publication history at one query commit. It ignores working-tree edits. Missing objects, invalid digests,
rewrites, deletions or conflicting maximal forecasts remain visible uncertainty rather than a fresh older forecast.
A forecast-only update leaves execution plan bytes, delegation and continuation binding unchanged. A real execution
change still requires ordinary plan supersession. Restart/cancellation preserves the root start, deadline, minimum,
promises and prior checkpoint history. Amending the undertaking requires explicit authority; a forecast cannot do it.

This registration does not widen `call.mjs` `PUBLIC_KINDS` or expose general evidence to roles. Authorized briefs
must supply required public forecast/snapshot material explicitly; unavailable material stays unknown. Git first-addition
provenance identifies publication order, not trusted event time. No registration or forecast outcome proves usable
delivery. The admitted positive-evidence contract below defines the matcher obligation; implementation and real
production evidence remain separate obligations in `DEBT.md` (Time-budget evidence).

### Time-binding evidence contract

Time-binding evidence attaches verifiable `Scope`, `Release`, and `Event` claims to committed public artifacts.

Bindings reuse the existing **Evidence** kind at
`evidence/<NNNN>/time-binding/TB-<lowercase-64-hex>.json`: four decimal round digits, one `time-binding` directory,
and a regular Git blob. The filename digest is SHA-256 of its exact UTF-8 JSON bytes, with no embedded self hash.
No extra kind, `records.json` change or `PUBLIC_KINDS` expansion is needed. Corrections append a new binding with
`supersedes` refs; reachable history must expose modifications, deletions and conflicting unsuperseded assertions.
Conflicts yield unknown for the affected subject, never timestamp or filename last-writer-wins.

A `Ref` is `{repository,commit,path,sha256}`: canonical absolute public repository, full commit SHA, regular
public relative path and exact byte hash. A `plan-time-binding/v1` envelope contains `schema`,
`type` (`scope|release|event`), `rootRef`, `planRef`, `basedOn` (full records SHA), `sourceRef`, `authorizationRef`,
`authorizationSelector`, `provenanceRefs`, `supersedes` and `claim`. Root, plan and scope operands must exist at `basedOn`. The source is an
independently authored public assessment or attestation; authorization grants that author the particular operation
and scope; provenance binds assigned request, author/role and archived output digest.

Reject duplicate keys in raw Evidence and JSON source, authorization and endorsement blobs before use. Only finite
IEEE-754 numbers serializable by RFC8785 are valid. The claim digest is SHA-256 of RFC8785 UTF-8 serialization of
exactly `{type,rootRef,planRef,basedOn,claim}`. `sourceRef`, `authorizationRef`, `provenanceRefs` and `supersedes`
are outside that digest. This canonical claim digest differs from the filename's exact-blob digest.

| Claim | Structured fields and required meaning |
|---|---|
| Scope | `criteria: [{ref,selector,purpose:minimum|promise,promiseId,packages}]`, `releasePackages: string[]`, `deferred: [{package,authorityRef,selector,reason}]`, `gatePolicyRefs: Ref[]`. Independently assess every baseline minimum criterion and targeted promise criterion, their package dependency closure and the selected release terminals. Each omitted package must be explicitly optional in the unique pinned authority fragment (its ID as a whole token), and outside the required closure. Missing enumeration is unknown, not empty completion. Negative assessment, required-scope deferral or plan/contract mismatch cannot authorize a release ETA; arithmetic may remain separately diagnostic. |
| Release | `scopeRef`, `candidate: {repository,sha,tree,destination:{host,repository}}`, nonempty `recipient` and `channel` tokens, `gateRefs: [{kind,ref}]`, `criteriaResults: [{criterion:{ref,selector},evidenceRefs,availability:{artifactSha256,recipient,channel,usable},result:pass|fail|unknown}]`. One exact candidate must pass all targeted criteria and applicable gates together. The recipient cannot be implementer-only. Each availability digest is lowercase SHA-256 of the exact artifact blob or candidate tree as the criterion requires; independent assessment binds build, candidate and criterion. Recipient/channel must match the Release and usable must be true. Incompatible partial candidates cannot be combined. |
| Event | `event: forecast-published|release-available|handoff-completed`, `subjectRef`, `at` (UTC ISO ending in Z), nonempty `basisRefs: Ref[]`. Attest the exact FO, Release binding or public handoff respectively, its digest, root/plan, occurrence time and recipient/channel where applicable. Publication means reaching the ordinary public records channel, not draft existence. Release availability means criterion-complete availability and all applicable green gates already held at that time. A completed handoff is not usable delivery. |

Resolve criteria and added promises across all branches. Each promise uses its own complete criteria; minimum
completion does not imply a different promise is met. A source must contain the same structured claim or explicitly
endorse its canonical digest; the lead may transcribe an envelope but cannot supply independent endorsement.

#### Public sources and recording trust

Allowed source/provenance path classes are `plans/`, `forecasts/`, `decisions/`, `purpose/`, `blueprint/`, `rounds/`,
`reviews/`, `design/`, `docs/`, `evidence/`, and exactly `metrics/handoffs.jsonl`, `metrics/trajectory.jsonl` or
`metrics/blueprint.jsonl`. Exclude sealed/private/auth/transcript/session material and `.gz`/`.log` files.
Authorization refs have the narrower exceptions `decisions/D-NNNN.md`, `purpose/P-NNNN.md` or
`delegations/T-NNNN.md`; gate-policy refs may additionally name pinned `loop.json`. Selectors are RFC6901 JSON
pointers or exact headings; multiple heading matches mean unknown, not first match.
The envelope's `authorizationSelector` is required for both native and external correspondence. An empty pointer
selects the whole JSON value; an exact Markdown heading includes its `#` prefix and selects through the next heading
of equal or lower depth. The unique selected fragment contains whole tokens for the operation and, natively,
`handoff.id`, `handoff.role`, `handoff.task`; externally, source `author`, `role`, `requestId`.

Native correspondence uses a provenance ref to a public `metrics/handoffs.jsonl` object with
`id,role,step,view,task,files,record`. `sourceRef.path` must be listed in `files`, outside `sealed/`, and its hash
must match the blob at the handoff commit. Request identity is `{id,view,task}`; authorization exists at `view`,
and the handoff commit descends from that view and is an ancestor of query commit Q. Only reviewer or judge roles
qualify; actor or critic yields source-unverified. The public round record is the report. This does not call
`judgeAccepted`, read private audits or sealed/session/transcript data, or establish native protected-push acceptance.

External correspondence requires a JSON source with `author`, `role`, `requestId` and either `claim` RFC8785-equal
to the envelope claim or `endorsesClaim` equal to its canonical digest. Roles are reviewer, judge, time-observer
or independent-assessor, never actor, lead or implementer. Selected authorization bytes must contain whole-token
UTF-8 matches of author, role, requestId and the operation `scope-assess`, `release-assess` or `event-attest`
according to type. Match the assigned request, issuer, source digest, authorized operation, root/plan/basedOn,
criteria/candidate and claim bytes. Authorization cannot equal the source ref or binding path. For same-repository
refs, authorization precedes source, source precedes binding first-addition, and all are ancestors of Q; assignment
order uses Git ancestry, not dates. Cross-repository sources use their own pinned cut, not the records DAG;
authorization must still exist at `basedOn` in records. No native Cursor handoff is required for this external
screening assessment. Requested model names and model self-report do not authenticate execution.

External `provenanceRefs` include exact public JSON platform and archive-hashes blobs from the source directory,
repository and commit. Platform fields are existing task-status fields: `status` and `latestTerminalStatus` equal
`completed`, `hasPendingChildRuns` is false, `taskId == source.requestId`, `childThreadId == source.author`, and
`childRunId == latestTerminalRunId`; each identity/run field is nonempty. The archive-hashes object maps direct
relative filenames to lowercase SHA-256, with entries for the exact source and platform bytes. Traversal is invalid.
The assigned author is the platform child identity; role comes from pinned pre-assessment authorization.
Provider/model/options/summary fields do not authenticate execution. A completed run and hashes alone grant no authority.

The existing archive recording provenance is an explicit trust boundary. Offline checks establish correspondence
and authorization under it, not archive integrity against its recorder, physical clock truth or provider/model
attestation. No caller trust boolean, issuer whitelist or schema-valid envelope creates authority. The implementer
and forecast author cannot endorse their own optional-scope, delivery or time claims. Without authenticated
independent public provenance, report source-unverified for that claim only. Synthetic acceptance archives must
label their stipulated trusted roots; they create no production event and require no production test bypass.
Inspect reachable supersessions/revocations under the same policy; contradictions remain evidence-conflict.
Changing required criteria still needs the ordinary owner-authorized baseline amendment.

#### Archived gates, clocks and projection

Derive required gates from pinned policy, never from the Release's offered `gateRefs`. CI uses pinned
`loop.json` `gates.require`: missing is unknown; only explicit `[]` means no required specs. Apply existing
`rowReceiptProblem` and blueprint `problemWithReceipt` semantics offline, additionally matching receipt host,
repository, exact SHA and every required app/name with success and `missing: []`. Preserve the archived receipt's
latest-run semantics; it is no live CI reading. Suite validation retains `receiptProblem` semantics: canonical
repository identity, exact SHA/tree, green, required command, valid summary and log digest. The existing VERSION-only
tip exception needs original-object tree/chain proof, never blanket ancestor equivalence or a live repository
realpath as identity. Other applicable gates retain their validators; unsupported gates yield unknown, never omission.
Public acceptance/handoff evidence supports the assessment but substitutes for neither delivery nor sealed acceptance.

Readers use the same pinned original-object walk as forecast loading, with Git replacement objects disabled.
The existing snapshot has `{records,revision,files,bytes,read}`; historical snapshots are keyed by exact `basedOn`.
Every historical operand ref must exist at that cut. No HEAD, worktree, live remotes/config/CI, network or writer
fallback is allowed. The admitted evaluator interface in `scripts/lib/plan-time-evidence.mjs` is
`evaluateTimeEvidence({stateAtQ,plan,forecastHistory,historicalSnapshots,now,clockMode}) -> EvidenceProjection`.
It discovers bindings in those snapshots, with no caller-supplied bindings or trust flags. Projection contains
`scopeByObservation`, `eventsBySubject`, `releaseEvidence`, `releases` (ref, criteria, candidate, availableAt,
verification verified/unverified/conflict and currentAvailability verified/unverified/unavailable),
`historicalDoneByObservation`, `checkpointResolutions` and `findings`.

The projection preserves existing plan-time signatures and joins this result into budget, promises and
`renderMeasures`. `budget` includes status, evidenceStatus, evidenceRefs, deliveredAt and currentAvailability;
`progress.releases` retains independently verified historical delivery and current regression separately.
Forecast earliestAt/latestAt retain conditional arithmetic diagnostics; `forecast.releaseEta` exposes those bounds
only with verified Scope correspondence for the observation. Missing scope leaves the release ETA unknown.
`checkpoint.resolved` annotates timely publication; unresolved or proved-late entries remain in `checkpoint.missed`. `deliveredAt` is copied only from a verified release-available Event on a verified Release, otherwise null.
Complete verified availability with unknown occurrence time may establish release evidence, but never on-time/late.
With a known deadline, verified delivery at or before it is delivered-on-time; after it is delivered-late. Without
verified time retain active/due-now/overdue (availability may still be verified); no deadline remains unspecified. Promises use
their own dueAt. Original elapsed and signed remaining time survive: zero means due now, negative means overdue,
null means unknown. Root budget inheritance survives omitted time on execution descendants, restart and refresh.

Git dates, recordedAt/asOf, envelope write time and `outlook.outcome.deliveredAt` are assertions/order, not event
proof. Historical zero remaining requires trusted handoff-completed proof present at basedOn and at or before asOf.
Later proof can improve current outcome, never recompute historical ETA. Progress comparisons retain their historical
cut labels. Past delivery and a later red gate or inaccessible artifact remain separate historical/current facts.
Verified delivery by frozen latestAt prevents only the completion-expired-without-delivery reason; other stale
reasons survive, and a later delivery remains a missed forecast.

A checkpoint needs trusted timely publication of a valid descendant FO on the same stable PL/root, with complete
parent history and later update order. Early asOf alone fails; conflict-branch checkpoints remain independent.
Later proof annotates a prior timing-unverified report without rewriting it or erasing a known miss. Earlier actual
release delivery proved by later publication may meet a promise but does not excuse a missed update checkpoint.
Missing or malformed optional time evidence never blocks ready work or changes continuation. These are screening
results, not wake, transport, native acceptance or release gates.

Continuation delivery uses the admitted single-host protocol in `scripts/lib/continuation-store.mjs`, reached
only through `capture` and `reconcileAtExistingParentEntry` in `scripts/lib/continuation.mjs`. It is the sole writer,
using `commitRecords` and Git ref CAS. The coordinator must separately classify the path in the records repository:

```json
{"kind":"Continuation delivery","path":"metrics/continuations.jsonl","changes":"append-only","settlesOwnerWords":false}
```

This declaration classifies change mode only; it does not validate schema, admit authority or install a receiver.
The writer validates rows and transitions. Existing evidence immutability and the narrowly defined normal-entry
inventory remain unchanged. Do not put a second package outcome or launch ledger here: plans, ordinary attempts,
handoffs and holds remain canonical. Delivery consumption records canonical references and a local reconciliation,
not package success. Public source receipt and cursor advance publish in one append transaction. No side effect
belongs inside a retryable CAS build callback; losing writers reread canonical state.

The admitted serialization binds H to SHA-256 of UTF-8 compact JSON arrays; digests are lowercase hex, stored IDs
are `ct:` plus the digest, and nested hashes use unprefixed hex. Payload keys follow `rowTypes.<type>` in the frozen
contract after common fields. The JSONL `previousRowHash` chain is the only delivery index. Pending terminal statuses
are `completed`, `failed`, `cancelled`, `interrupted`; null run identity cannot create a terminal obligation.
Conflicting terminal observations stay unknown/conflicted; stale running observations cannot undo a terminal.
Source cursors from separate tasks or Git forks are not numerically ordered.

Claim/consume uses the same canonical generation and CAS snapshot. Plan replacement forces rereading or invalidation;
completed scopes stay complete. Claims before intent can be reclaimed only with verified same-host boot/start-specific
process death; timeouts and unknown identity are insufficient. After intent, uncertain execution or missing receipts
never justify blind retry. Intent and receipt schema support no runtime sender in this subset. The ordinary parent
entry reports missing binding/identity and the unavailable independent wake edge. No subsequent parent entry means
no local reconciliation; this ledger makes no autonomous recovery guarantee.

A hand-off line (JSON, `scripts/lib/handoff.mjs`): its record ID, time, phase, round, step (the role, or the role and a
mode such as `reviewer-frame`), the attempt number, the agent (runner, configured and observed model, cost, seconds),
the view commit the role read, the briefs, the task's digest, the product commit it started from and the one it produced,
the exit code, the audit counts, the feature IDs, the public record and every file of the hand-off. It states facts about one call and
carries no verdict. The committed `reviewer-frame` hand-off and its round record establish that the
generative engine ran for that phase. Other reviewer modes cannot supply the phase frame. A line exists only for a call with no access violation, committed together with every file it names.
A row of the trajectory is the lead's account of a ruling (area, verdict, blockers `class:id`, suite counts, the commit)
and the append's own CI reading; the supervision alarms read it. When the lead pushed a commit raising `VERSION` on top
of the ruled commit (D-0009 item 2), the row's `tip` names the pushed SHA and `commit` stays the ruled one. The loop is
never told to the append: it is the loop.json of the records repository holding the ledger's real path, the row's
`phase` is that loop's phase, and the append reads CI once for the pushed SHA (the tip, else the commit) where a push
to the loop's `gates.remote` goes, over every `gates.require` check. The row carries the reading's word (`ci`) and
names the reading saved under the round's evidence (`ciReceipt`, `evidence/<NNNN>/ci-<sha12>-<n>/receipt.json`: the
ci-green receipt, or `{ sha, ci: "unknown", ok: false, error }` when no reading could be made). A CONVERGED row is
written only when that word is `success`; a row in records without a loop.json, or in a ledger outside a records
repository, carries CI `absent` and no receipt. The records check verifies offline that a CONVERGED row naming a
`ciReceipt` names a receipt the records hold, for its pushed SHA, with the word `success`; rows written before the
append read CI itself carry no `ciReceipt` and are read as they are. Commit the receipt with the row.

Structured blocker admission is owned by `scripts/lib/blockers.mjs`. The last compatible structured judge ruling
supplies the complete disposition set, ordered by first-addition Git commit then path (uncommitted files follow by
path). Compatibility includes phase and product SHA when supplied. Explicit flags may supplement historical rulings
but cannot reverse a selected disposition. Whole tokens, including Unicode and punctuation, must match; a longer
identifier is not evidence for its prefix. `next`, append explanations and alarms use the shared state transition.
Semantic retries (phase, round, commit, area, verdict and normalized disposition sets) do not create extra reviews;
timestamps and repeated CI readings do not change retry identity. Earlier rows require no migration.

The row's blockers are four lists of `class:id` (self-loop D-0024, D-0026; `design/trajectory.md`):
- `opened`: blockers this ruling opens. The append refuses (exit 2, nothing written, no CI read) a key that no judge
  round record of the row's round and phase in the same records repository (`rounds/NNNN-judge.md` or
  `rounds/NNNN-judge-<word>.md`; a record without a `phase:` line counts for any phase) names in its report, by the
  whole `class:id` or by its id where no other class precedes it (the judge record's matcher, below). A ledger outside a
  records repository has no judge records, so an opened key is refused there too. Copy the keys from the ruling's
  `OPENED:` line; when the ruling itself lacks one, a further judge call of the round names it.
- `closed`: earlier blockers this ruling closes.
- `shelved`: earlier blockers this ruling rules SHELVED: they stop gating (no longer open for `next`) and stay visible,
  apart from closed ones. Derived from structured rulings or supplied explicitly.
- `carried`: blockers carried from an earlier phase, still open, and not an opening of this row. Derived from structured rulings or supplied explicitly.

A key appears in at most one of `opened`, `carried` and `shelved`, and not in both `closed` and `shelved` (exit 64).
Rows written before these fields parse as they are: Legacy migrated rows name shelved findings by bare ID
(`"shelved": "S12-1,S12-2"`), which parse and match no blocker; the append writes `class:id` only. The recurrence
alarm counts distinct blockers of a class: each key once, at the first row that opens it; a key first seen as carried
never counts; distinct keys of one ruling count. The partly-closed alarm counts the distinct earlier blockers of an area
still open after its next ruling: a shelved key is not open (its evidence lists it under `shelved`), and a carried key
never enters the count. `next` reads the open blockers from the phase's judge rows that hold a verdict, in round order:
a row's `opened` and `carried` keys enter the open set, then its `closed` keys leave it, then its `shelved` keys leave
it and are listed apart. A key a ruling both carries (or opens) and closes therefore ends closed.

A judge round record (`rounds/NNNN-judge.md`, or `rounds/NNNN-judge-<word>.md` for a further judge call of the round)
holds the judge's public report verbatim under the header `call.mjs` writes (`phase:`, `view: records@<commit>`). It is
held to the blocker bar (D-0018) when its `view:` commit contains the decision that adopted the bar in these records:
`decisions/D-0018.md`, or the records path named by `blockerBar` in `records.json` where the records number that
decision otherwise (e.g., `decisions/D-0052.md`). Then every key in the `opened` field of the trajectory's judge rows
of that round and phase needs, in a held judge record of the round, a block that names the key (its whole `class:id`,
or its id where no other class precedes it) and holds a line beginning `flow:` and a line beginning `loss:` whose first
word is `data`, `wrong-result`, `false-verdict`, `disclosure` or `stuck` (list, quote and emphasis marks before the
field name are ignored). A block is a paragraph (cut also before a list item or a bold lead line that names a key the
paragraph has not named yet), or a heading together with everything up to the next heading, which names the keys its
heading names. Otherwise the records check fails each held record of the round, naming the record, the key and what is
missing; a view commit it cannot read is screened instead. Records whose views lack the decision are read as they are.
The row cannot change, so the way out is a further judge call in the same round (`call.mjs ... judge --step
judge-<word>`) whose public report carries the missing block. The judge brief states this format.

An alarm line (`metrics/alarms.jsonl`, written by `self-loop.mjs tick` through the records commit helper):
`{ "type": "stall", "key": "stall:<phase>:<since>", "time", "phase", "since", "source", "hours", "threshold",
"unsettled", "by": "tick", "onStall", "action" }`. `since` is the time of the last recorded phase activity, so one idle
period is one line however often the heartbeat runs; a later intervention record can cite the key to show the loop
raised the stall first. The first line also regenerates the index in the same commit. An alarm stays live while its key
is the phase and the last recorded activity; `start` and `next` show only live alarms and never write one.

An intent batch (`owner/B-NNNN.md`, D-0031) carries `kind: intent` and `requirement: P-NNNN` beside its `phase:` and
`from:` headers. `decisions.mjs send` derives the allowance of one intent batch and one follow-up per requirement and
phase from these immutable records. Its questions show `Why asked:`, an optional `Depends on: question N` and `If
question N is answered "<option>":` lines; question and dependency numbers are one-based. Every field is flattened to
one prefixed line, so quoted record text cannot create headers, questions or answer state.

An owner batch is closed by an event of `owner/answers.jsonl` naming it. An answer event holds the owner's words verbatim:
`{ "batch": "B-NNNN", "time", "words", "outcome"? }`. `words` is the input exactly as given, surrounding whitespace and
line breaks included. `outcome`, when present, is the lead's reading of the answer, one of `as-recommended`, `amended`
and `other`; it never closes a batch by itself or stands in for the owner's words, and answer events without one
(every event written before it) stay valid. The parser the records check shares refuses any other outcome value and an
outcome on a replacement event. A replacement event closes a batch the owner answered through a later batch:
`{ "batch": "B-NNNN", "time", "replacedBy": "B-MMMM", "note"? }`. It carries no words. It is valid only when B-MMMM
was sent after B-NNNN (a higher number), an answer event for B-MMMM precedes it, B-MMMM's text names B-NNNN, and no
earlier event answered or replaced B-NNNN. `decisions.mjs replace` writes only valid ones and the records check fails
any other. The index and `decisions.mjs status` show such a batch as `replaced by B-MMMM`. Like an answered batch, it
no longer counts as open. Owner words that arrive later for it are still recorded as an answer event.

An intervention entry: time, the owner's words, the frame the loop was in, the reframe, the general question behind it,
whether the loop had raised it first, and the mechanism that carries the general question. It feeds the engines'
question banks.

### The owner's words

A word's class is its latest valid mark (`owner/word-marks.jsonl`, one JSON line per mark):
`{ "id": "W-…", "as": "direction", "intervention": "I-NNNN", "note"?, "time" }`,
`{ "id", "as": "answer", "batch": "B-NNNN", "note"?, "time" }`, or `{ "id", "as": "routine" | "not-owner", "note", "time" }`.
A mark of another class, a direction without an `I-NNNN`, an answer without a `B-NNNN`, or a mark carrying the link of
another class is not valid and is ignored. A word settles in one of three ways:
- **`direction` mark.** The word settles only when its intervention record exists in the tree, whatever cites it.
- **`answer`, `routine` or `not-owner` mark.** The mark settles the word.
- **No mark.** The word settles when a purpose, decision, blueprint, intervention or lesson record cites its ID. Such a
  word is `unclassified`: `owner-words.mjs metrics` reports it, and it never fails a check.

To count citations from an additional text kind, set `settlesOwnerWords: true` on its `extraKinds` entry in
`records.json`. This applies to distillations such as an owner's themes index. Raw evidence, generated views and the
word ledger are excluded by default.

An intervention record (`interventions/I-NNNN.md`, append-only) carries:
- one or more `words:` lines naming the direction words;
- a `raised-first:` line. Its value is `no`, or one or more record IDs (other text on the line is ignored). The last
  such line holds, so a correction is appended;
- its disposition (F-0011 A1): a `rung:` line, one of `construction`, `hard gate`, `screening predicate`, `question
  bank` and `owner-only` (case and spacing ignored), and a `carried-by:` line naming the existing mechanism or admitted
  feature that carries the general question, or `none:` followed by why none can. The last line of each holds. An
  intervention without a valid rung and a nonblank `carried-by:` (or with a bare `none`) is listed by `next` as
  screening; no check refuses on it. With the rung `screening predicate`, every id of `PREDICATES` in `scripts/loop.mjs`
  that `carried-by:` names (as a whole word) is a cited predicate.

The words the intervention cites are all word IDs in its text, plus the words whose `direction` mark names it. The
records check fails (certain, `raised-first`) when the value is not `no` and:
- names no record ID;
- names an ID no record carries;
- names a record with no commit; or
- names a record whose first commit is not strictly earlier than the `time` of every cited word in
  `owner/words.jsonl`. The first commit is the earliest adding commit in the history of HEAD for its declared path (renames are path additions).
  Git stores committer timestamps in whole seconds; comparison is strictly `<` against the capture timestamp.

It screens:
- an intervention with no `raised-first:` line;
- a cited word that the ledger lacks (its capture time is unknown, so the word is not compared);
- a claim with no cited word to compare;
- a word with an invalid capture timestamp;
- a record whose history cannot be read, including a shallow repository.

A claim counts as raised first only when every cited word can be compared and every named record passes. An unknown
word does not count as proof. `no` bypasses priority checks. These checks establish file chronology, not the semantic
priority of mutable text or the integrity of a supplied clock. The meaning remains for independent review. A scoped
hand-off screens failures of unrelated interventions; checking the word/mark ledgers also checks their linked claims.

`owner-words.mjs metrics` reads one committed snapshot. Its phase defaults to committed `loop.json`; without one,
pass `--phase`. `phaseMetrics(records, phase)` in `scripts/lib/owner-metrics.mjs` is the only counter: words captured
from the phase's earliest hand-off through now, inclusive; the settled words per class and the open ones (a direction
whose intervention is not committed is open and listed in `awaitingIntervention`, not counted among the directions);
one direction per settled direction word even when several share an intervention; a raised-first count and its
share of the settled directions, a direction counting only when its intervention's claim verifies by commit order
(D-0030 item 1); apart from it, `wouldHaveFired`: the directions whose word a predicate their intervention cites
fires before when replayed, each direction listing those predicates, coverage for the independent review that never
counts as raised first and never stands against a `raised-first: no`; per cited predicate, the words it would have
fired before, would not have fired before or could not decide, and its false alarms; every intervention's
disposition and the IDs of those without one (`undisposed`); sent batches in that phase and those with actual answer
events; `ownerWaiting`, each batch of the phase from its first publication in the records history to its first answer,
its replacement event or, while unanswered, now, summed (`null` with the reasons when a time cannot be established);
answer events by outcome, one count per event, and precision (`as-recommended / answeredWithOutcome`);
citation-settled unclassified words.
The predicate replay (F-0011 A2) reads the first-parent history of the records HEAD. The snapshot just before a word
is the last commit whose committer time is earlier than the word's capture. A predicate is evaluated by its own code on
that commit's tree, at the word's time; a predicate whose result depends on the clock (`stall`) is evaluated at the
end of each commit's span. Its false alarms are its firing episodes (maximal runs of consecutive commits on which it
fires) among the commits from the phase window's start to the last word citing it that contain no commit just before
such a word; commits it cannot decide break an episode and are counted apart. A predicate that needs data the records
do not hold names the event and the feature that owns it (`needs`) and decides only that it does not fire.
Replacement events close batches but are neither answers nor precision observations. A mixed batch answer may have
a direction mark and a separate batch answer event; the word class stays singular. Empty ratios are `null`, displayed
as `n/a`; without a phase hand-off no word enters the window. Screening lists unavailable priority evidence.

From 2026-11-21, purpose records put `words: W-xxxxxxxxxx[, ...]` in the dated header. A named ID must exist
in the word log. The checker screens for a missing source line and for each open word. The owner-words command
checks committed records and their configuration. The records checker also sees staged records for review.
Legacy declarations of native kinds in `extraKinds` keep their existing index presentation until the lead removes
them and regenerates the index.

### Plans

A plan (`plans/PL-NNNN.md`, immutable; F-0012) records the packages of one scope and phase:

```
# PL-NNNN <title>
scope: <scope>
phase: <phase>
supersedes: PL-MMMM

## <package id>
authority: D-NNNN, R-NNNN-judge
goal: <text>
files: scripts/lib/plan*.mjs, docs/
interface: <text or a record pointer>
needs: <package id or record ID>, B-NNNN
role: actor
settings: current
acceptance: <text or a record pointer>
handoff: R-NNNN-actor-<word>
task: <path>
```

`supersedes:` is present only in a revision. `authority` names committed decisions or judge rulings. A package the
lead holds (F-0012 A3) also carries `hold: <why it waits>` and `release: <what releases it>`; both lie outside the
hand-off contract, so a revision that records, moves or lifts a hold keeps the hand-off ID. A release made only of
record IDs (an owner batch counts once answered or replaced), `capacity` and ISO times, comma-separated, is computed and
released when every part is met. Any other release, a part in words included, still holds the package but cannot be
checked: `next`, `tick` and `start` list it for review on every reconciliation, including other registered products until a revision names a computable release. A blank `release:`
is no hold. Empty `files:` is read-only work; a trailing slash owns a directory. Packages of one plan never overlap;
packages of two current plans of a phase may, and then the dispatcher offers a start to one at a time (plan ID order,
then package order), the other waiting on a `writer` hold. A `needs` entry is a package of the plan, an owner batch (released by
its answer) or a record that must exist. `settings` is `current` (the default) or a JSON object whose values must
match the role's configured agent (a mismatch waits for that configuration). `task` is optional (default
`<workDir>/tasks/<handoff>.md`). Lists are comma-separated or JSON arrays (a value that starts with `[` but is no JSON
array, such as `[A-Z]*.md`, is a glob); the same keys as one JSON object, with
packages as a list or an ID-keyed map, are also read. `plan.mjs validate` checks a draft against the committed records; `ready` and `measure` read the
plan and every record they use from one records commit. A revision is a new plan whose `supersedes:` names the current
head of the same scope and phase; a package whose contract changes takes a new hand-off ID, so an old completion never
counts for changed work. Records that declared the kind in `records.json` `extraKinds` before this row keep working:
that declaration replaces the native row.

### The owner store

One per owner, outside every product's records (design §5.2): a Git repository that starts as a skeleton of
`README.md` and `products.json` (`self-loop.mjs registry init`, from `assets/owner-store/`). Slice 4 adds the owner's
words, marks, routes and principles to it without changing the registry.

| Path | Kind | Writer | Changes |
|---|---|---|---|
| `products.json` | the registry: every product the lead runs | lead, `self-loop.mjs registry add` (validated, committed) | edited in place |
| `README.md` | entry | lead | edited in place |

```
{ "products": [ { "name": "example-app", "records": "/abs/example-loop", "aliases": ["ExampleApp"] } ],
  "roots": ["/abs/projects"] }
```

A name is lower-case letters, digits and inner hyphens (the prefix of a qualified citation, `example-app:D-0046`); `records`
is the absolute path of the product's records repository, whose `loop.json` is the product's loop; names and aliases
share one case-insensitive namespace; a records repository is registered once; `roots` are absolute folders under which
`tick` and `start` report records repositories nobody registered, at any depth. Unknown fields are refused, so a misspelt field never silently
drops a product. A product's `loop.json` may list `projects` (folders whose sessions belong to it, relative to the file
or absolute) and `tick` (`stallHours`, `onStall`: `show` or `resume`). The records a driver reads and writes are the
registered folder holding that `loop.json`, whatever its `records` field says.

### The blueprint

The one map of the product: every important feature, the requirement it serves, why, where its design is, how it is
accepted, what it depends on, and whether it is done. It holds no design text of its own (rule 9): the design is in
the product's documents, the blueprint points at it.

A feature file `blueprint/F-NNNN.md` (the owner reads it, so its prose is in the owner's language):

```
# F-NNNN <title>

id: F-NNNN
phase: <phase>                      the phase that builds it (A1, S4, ...; `later` while unscheduled)
requirements: P-0003, docs/PRODUCT.zh-CN.md#顶层需求@<commit>   one or more: purpose IDs or product-document anchors
depends: F-0002, F-0005             optional: features that must be done first
decisions: D-0036                   optional: decisions that shape it

## 为什么        why the owner needs it, citing the requirement's words
## 做什么        what it is, current state only, one paragraph
## 设计          pointers `path#heading@<commit>` into the product repository (none while planned)
## 验收          pointers to acceptance cases and tests (none while planned)
```

A status event, one JSON line in `metrics/blueprint.jsonl`, written only by `blueprint.mjs set`:
`{ "feature", "phase", "status", "time", "by", "note", "evidence" }`. Status is one of `planned`, `designing`, `building`,
`done`, `retired`. `done` needs evidence `{ "commit": "<full SHA>", "ci": "<records path of a green ci-green receipt for the
pushed SHA>" }` plus the acceptance that ruled it: `"round": "R-NNNN-judge"` (a round record that exists, whose hand-off names the judged SHA and, when available, the feature), or, only for
work accepted before the records existed, `"acceptance": "<product path>#<heading>@<commit>"` (a baseline event,
`by: lead`); each resolving. With a round, `blueprint.mjs set` takes `commit`, `tip` (when the row names one; the
receipt is then the tip's) and `ci` from that round's last judge row in the trajectory, which must be CONVERGED and
name its `ciReceipt`; `--commit` or `--ci` with `--round` on a `done` is a usage error. A baseline gives `--commit`
and `--ci` (a receipt in the same records) and is confirmed by one reading of that commit at the moment of writing,
where a push to the `gates.remote` of the records' loop.json goes, over its `gates.require`; without a loop.json there
is no done. `retired` needs a
decision `D-NNNN` that names the feature; a done feature goes back to `building` only with the round whose ruling
reopened it. A feature's status is its last event; a feature with no event has none.

The structured header ends at the first body heading. A `status:` header field is reserved for the event log.
The role of the prose sections, including whether they explain the right requirement, is reviewed. Purpose IDs,
dependency IDs and decisions resolve by their record paths. Structured product pointers resolve through the
`product` checkout named in `loop.json` (relative to that file or absolute), reading the cited Git commit. Use the
literal Markdown heading or its slug and a full or unambiguous abbreviated SHA of at least seven hex digits.

An event records a change, so repeating the current status is refused. Its time is an ISO timestamp and its
evidence is an object (empty when there is no evidence). The first completion may use a lead baseline even if
planning was already recorded. A later completion needs a judge round this feature has not cited before. The baseline pointer pins the acceptance document independently
of the product SHA in the CI receipt. Returning to building after completion
needs a different judge round even if an intermediate status was recorded. A retirement decision explicitly
names the feature by ID. These checks establish the cited files, their identifiers and the CI receipt's green
verdict for the event's pushed SHA (`tip`, else `commit`); the records check reads earlier events offline as before.
Other statuses may cite a round, commit and receipt as given; they are checked offline and read nothing. The lead verifies what the ruling or decision means and whether a baseline really
predates the records. Keep the evidence cited by the event log, including older events. Keep baseline CI receipts under `evidence/blueprint/`. The checker screens missing
legacy hand-offs, unavailable product checkouts, unknown feature header fields and differences between the current
phase and the phase recorded in the last status event. A new baseline must resolve when written.

The blueprint CLI reads existing unignored working files, including evidence that the lead is about to stage.
The records check works on its managed set as usual. `status` without `--phase` checks all features, including
`later`; an empty selection returns 2 because it provides no evidence of phase convergence.

The check (rule 7) fails on: a feature file with a malformed header, a `status` line, an unknown requirement, decision
or dependency, or a dependency cycle; an event that is malformed, names no feature file, or lacks the evidence its
status needs; `BLUEPRINT.md` differing from the generated view. It alarms on: an active purpose record no feature
serves; a feature with no status; a `building` feature no role call named in the phase's last three rounds; a design
pointer whose section changed after its commit; a done feature whose dependency is not done.

An unsuperseded purpose record with no status or with `status: active` is active. Put `scope: process` in a purpose
record's header when it governs the development process. The blueprint lists that purpose and exempts it from the
feature-coverage alarm. Retired features do not serve active product requirements. The three-round alarm uses distinct round numbers in the phase's hand-offs and
trajectory and starts once there are three such rounds. Legacy hand-offs without feature IDs give no evidence
that a call named a feature. Design drift compares the cited section, including its subsections, to the configured
product branch (or HEAD when there is no branch); an unreadable citation or tip is also reported for review.

The owner view's pending section shows requirements without features, features without status and phase changes
from the last recorded event. Phase totals count both done and retired features. The other alarms
are in the checker output. A repository with no managed feature files, status log or existing managed view
needs no generated view and receives only the blueprint coverage alarms. Generated files do not index themselves.

`call.mjs` refuses a role call whose task has no line `features: F-NNNN[, ...]` naming existing features (the frame
reviewer may write `features: none`) and records the IDs in the hand-off line. The declaration is one unquoted line outside code fences. IDs
must name regular feature files at the selected records view commit, including for `--prepare` and dry runs.
`features: none` is recorded as an empty list. Historical hand-offs and workspaces prepared before feature
declarations keep the field absent. The role view includes feature files. The exact hand-off check covers its
own paths; the lead runs the complete blueprint check on the records repository. A phase converges only when
`blueprint.mjs status --phase <phase>` exits 0: every feature of the phase done or retired.

## Rules

1. **Durable from the first round.** Nothing a later round, a ruling or a backtest may need lives in scratch space,
   including the raw files a role wrote and cited. Commit at every hand-off, and only that hand-off's paths: `call.mjs`
   builds the exact tree (HEAD plus its own files plus the index generated from that tree), checks it and commits it,
   so nothing else staged rides along. A failed attempt commits only its evidence, numbered per attempt, and gets no
   hand-off line. The lead commits its own records by explicit path.
2. **Each kind has one writer and one way of changing.** Append-only kinds are never edited; immutable records change status only through a new record that supersedes them; Design and Normal-entry inventory are edited in place as specified in the layout. A hand-off that
   would rewrite a committed immutable record, or change an append-only one other than by appending, fails; edits made
   outside `call.mjs` are reported by the check (`changed-record`).
3. **Current state and history are separate.** An actor's direct regular `out/design/<area>.md` files replace the
   corresponding `design/<area>.md` files in its successful hand-off commit. Evidence keeps the original bytes.
   Other paths in that output directory are refused. The check alarms on design files no actor hand-off wrote in
   the current phase named in `loop.json`. Design files describe the design now. Why it changed lives in rounds and
   decisions; what it said before lives in the repository's history. No "Round N" sections inside a design file.
4. **Citations stay true.** Cite records by ID, mutable files at a commit, evidence by digest. A bare line number in a
   file that changes is not a citation.
5. **Agents find records through the index.** A brief names the index and the IDs the role needs; the role reads the
   index first. A record that is not in the index does not exist for the loop. Each role reads a view built from one
   records commit by an allow-list of what is public by construction (`call.mjs` `PUBLIC_KINDS`; round records only
   when a hand-off names them, or `records.json` `publicImports` lists them): never an ignored, staged or uncommitted
   draft, a symlink, `sealed/`, evidence or briefs; only the judge's view also holds the judge's own earlier private
   records (`sealed/judge/`). The view carries its own index of exactly what it holds.
6. **Any past moment can be rebuilt.** Because everything is versioned with dates, the state at time T is the
   repository at its last commit before T. Backtests, audits and handoffs need no reconstruction by hand.
7. **The check runs at every hand-off and fails loudly.** It verifies that every file belongs to a declared kind and
   path, every citation resolves (ID exists, commit exists, digest matches), superseded records are marked, sealed files
   are not referenced from briefs to roles that must not read them, nothing cited lives outside the repository, and no
   secret or personal data is present. A failure is an alarm to the lead, not a log line.
   Which findings block and which only alarm follows the enforcement ladder (REQUIREMENTS item 11): a file of the
   checked set outside every declared kind and an index that differs from the generated one fail; everything decided
   from free text (IDs and sealed paths named in prose, citations, secrets) is reported for review, since a template's
   example or a judge-only brief can name such things legitimately. For a hand-off the checked set is the hand-off's own
   paths, so a stray file elsewhere never fails unrelated work. A hand-off line that names a file the records do not
   hold, two lines for one record, a malformed answer event, and a judge record held to the blocker bar whose round
   opened a key without its `flow:` and listed `loss:` (above) also fail. `scripts/records-check.mjs` implements the
   check and the index; an owner batch's status in the index comes from the answer events alone.
8. **Evidence has a retention rule.** Evidence stays while any open record cites it. When a phase closes, uncited
   evidence is pruned and a prune record lists what was removed with digests.
9. **Promotion to the product is one way.** Converged design goes into the product's authoritative documents, current
   state only, one source per rule. The loop's records keep the path from purpose to decision to design; they are not
   a second source of the product's rules.
10. **Agent memory points, it does not copy.** Cross-session memory holds the records repository's location and the
    IDs that matter, not restatements that drift.

## Mapping to a work-graph runtime

The same layout can serve as a general work-graph runtime's records model (inventory, resolver, check, owner view):
decisions map to the ledger, rounds to task contracts and receipts, evidence to content-addressed artifacts, the
index to the resolver, and the check to the inventory check.

## Comment resolution

The comment-admission-v2 output contract is implemented and awaits independent judge assessment. A pending candidate
carries `path`, `source` (SHA-256 of the complete source text), `line`, `rule: D-0016`,
`contract: comment-admission-v2`, `scope: comment|source`, `language` and `text`. All identity fields must match.
The judge writes an array to `out/comment-resolutions.json`, copying those fields and adding nonempty authoritative
`evidence` and `verdict`. Comment scope accepts `literal`, `directive`, `pointer` or `prose`; source scope accepts
`compliant` (the entire frozen source satisfies D-0016) or `prose`. Any matching prose judgment wins over approval.
A changed source, path, scope, language, rule, contract or candidate requires new adjudication.
Source-scope prose keeps that entire identity and never supplies cross-file move credit. For a change within one
path, the judge may optionally attach `proseComments`: a complete inventory of every prohibited comment's text,
including duplicates, to each source's `prose` judgment. This certifies completeness, not advisory lexer output.
Only nonempty inventories of nonblank strings, agreed by every supplied valid inventory on each source, allow
a multiset subset comparison: all after-comments must already exist before. This admits code-only changes and
comment deletion without calling either source compliant. A changed or additional comment still refuses; phase
close still refuses any source judged prose. Without complete inventories, changed prose sources refuse until
independent evidence or subtraction resolves them. A fresh audited inventory may supplement an earlier bare
prose verdict; conflicting inventories do not establish a delta. Unchanged sources and whole-file deletions need no delta proof.
This optional inventory extension also awaits independent judge assessment.

The consumer reads committed `sealed/judge/<NNNN>/<step>-<attempt>/out/comment-resolutions.json` only when a successful
judge hand-off lists that file and its matching audit, with zero violations and matching id, role, attempt, runner
and session. Both files are read at the first publication of that hand-off identity (id plus attempt) along
the records HEAD's first-parent history, using the immutable commit's blobs. Current hand-off fields must still
match that publication. Later output/audit edits cannot supply or replace a verdict; corrections require a new
audited hand-off. This uses the records writer's append/publication lineage and does not authenticate rewritten
Git history. A known non-judge author session cannot approve. CLI processes retain their existing audited process
boundary without an invented session requirement. Actor exception lists and uncommitted outputs do not count.
This verifies provenance and identity, not semantic correctness or independent vendor identity. No implicit model
call occurs: dispatch, record and retry use the existing role protocol. Non-JavaScript and unsupported dialect
files incur whole-file review even without scanner hits. Unknown extensions remain outside the declared scope.

## Normal-entry public inventory

The coordinator publishes the current snapshot at `evidence/normal-entry/manifest.json`, after declaring
Normal-entry inventory in that records repository's `records.json` extraKinds. The example configuration is
illustrative, not a publication or a change to an existing records repository. Public artifacts under
`evidence/normal-entry/public-[a-z0-9-]+.json` are immutable: publish a new file per artifact, never overwrite
another artifact's bytes despite the directory's editable classification. Evidence under `evidence/<NNNN>/`
remains immutable.

The adapter reads committed Git objects at a pinned cut. Source payloads are limited to `owner/words.jsonl`,
`owner/answers.jsonl`, `decisions/D-[0-9]{4}.md` trial passages and `reviews/grok-R[0-9]{4}-[a-z0-9-]+.md`
judge gaps. An activated `normal-entry-manifest/v2` additionally supports `kind: alarm` only at
`metrics/trajectory.jsonl` and `metrics/alarms.jsonl`, through the bounded alarm selector below.
Links may cite those decisions/reviews or the explicit public artifact route. Task links use
`plans/PL-[0-9]{4}.md` or declared `delegations/T-[0-9]{4}.md`; no `plans/*.json` fallback exists. Installed
v0.4.4 has no Plan kind. Withhold may use `task: null`, with a release condition. Artifact payloads are not
recursively followed. Never publish private role evidence, raw sessions or sealed content on these routes.

Byte spans, complete blob and clause SHA-256 digests, first-parent revisions, predecessor versions and explicit
exact-version dispositions preserve historical obligations. The earliest publication fixes the baseline;
missing inputs and omitted obligations remain visible. Structural reconciliation does not establish semantic
SOUND or permission to launch. Ordinary cadence, blocker, readiness and convergence readers remain authoritative.

### Alarm occurrences and current metadata

AE1 is defined by `evidence/0012/alarm-response/proposal.md` at records commit `9f4cef3`,
including Responses 001–003; admission is `evidence/0012/alarm-grok/ruling.json` at `6e37763`.
The original NOT_ADMITTED headers are historical, not rewritten by admission.

Alarm selectors contain exactly `type: "alarm"`, `origin: "trajectory" | "stall"`, `key`,
`lineSha256`, zero-based `occurrence`, and `detectorRevision`. The supported detector revision is
`32c9634ed2457e47e1e12f4a3d4e59a337a3472a`; arbitrary revisions are not dynamically loaded.
The complete physical JSONL line, without CR/LF, is both the entry and clause span. Phase follows the
canonical firing row. The occurrence ID binds repository, phase, origin, exact key, continuous first-parent
publication episode and line digest. Full-blob stale-inventory rules still require explicit tuple rebinds.

Raw trajectory multiplicity is preserved. Canonical groups are checked before phase filtering; a repeated
key, repeated selected trajectory line, changed singleton fingerprint or disappearing/reappearing selection
within one episode makes that key ambiguous. No identity is manufactured for ambiguity. Equal durable stall
lines may share an episode, but conflicting bytes for one stall key break it. Removing and readding a source
starts a new episode. Inventory replay is distinct from raw source-ledger replay.

`next` supplies internal context for its pinned records cut and configured phase. It shares one canonical
undiagnosed result with the existing diagnosis display and convergence check, and one committed `liveStall`
result with the stall display. It preserves the complete canonical firing list. No CLI takes context, no
reviewer payload is exposed by the normal reader, and no observation clock becomes occurrence identity.
`start` forwards the session's `next` text through its existing entry path.

Facts/projection v2 carry `alarmStates`, one row per distinct emitted alarm version. Each row contains
`version`, nullable verified `occurrenceId`, `identityBasis` (`source`, `predecessor`, `unverified`),
`evaluatedAtCut`, `applicability` (`active`, `superseded`, `inactive`, `unknown`), `diagnosis` (`covered`,
`required`, `not_applicable`, `unknown`), nullable `successorOccurrenceId`, and `reason`. Invalid keyed
versions have unknown metadata and null identity; unkeyed invalid rows create no invented state. A valid
source-null tombstone binds a verified predecessor, is inactive/not_applicable, and can receive an exact
deletion disposition even without current context. It does not discharge unresolved predecessors.
Unknown current-upsert context prevents reconciliation; historical accounting remains independent.
Diagnosis coverage is neither a disposition nor semantic admission; inactive metadata does not clear blockers.

Migration is derived from first-parent history. A valid v2 envelope, including both arrays, activates v2
before member processing. Invalid v2 before activation retains/poisons the prior snapshot without importing
rows and keeps v1 output. After activation a v1 snapshot is rejected before mutations, retaining dispositions
and poisoning all current items with `unsupported_downgrade`. Recovery needs a valid v2 snapshot against the
last accepted inventory; omitted dispositions are then withdrawn and omitted inventory stays an obligation.
This uncertainty stays within the additive projection: existing readiness, cadence, diagnosis and exits remain
authoritative. These interfaces do not publish sources, launch tasks or create a scheduler. AE18 requires
actual authorized source-to-consumer evidence; synthetic tests do not establish live acceptance.
