# Round 7 package C acceptance

The cases exercise C4 through `trajectory.mjs append` and `trajectory.mjs alarms`. Each uses disposable records or
products. R7-C01 models the ExampleApp incident recorded in D-0024 using its class, duplicated key, phases and four-to-five
count. The three other blocker IDs and their exact rounds are stand-ins. The other scenarios are constructed. R7-C02
varies the number of distinct keys and repeats by seed. R7-C03 exercises the degenerate case of a ruling that introduces
zero distinct IDs after an alarm has fired.

| ID | Surface | Attack or control | Flow and realism | Loss | Expected property | Label |
|---|---|---|---|---|---|---|
| R7-C01 | Recurrence | ExampleApp R33-1 repeats in round 35 | The lead runs supervision on the recorded phase transition. The old writer put a carried issue in the openings column. | false-verdict | Four distinct IDs trigger at four but stay quiet at five. A genuine fifth opening triggers at five. | ordered |
| R7-C02 | Recurrence | Many distinct IDs share one ruling and some appear twice | A judge consolidates findings from a long review and the lead transcribes that ruling before running alarms. | false-verdict | Distinct IDs count even within one round. Repeated entries contribute neither to the count nor to the blocker list. | fresh |
| R7-C03 | Recurrence | A repeated ID refreshes an existing alarm | After diagnosing a recurrence, the lead moves phases and runs supervision over an older carry-over row of the form in D-0024. The role gate inspects whether the diagnosed alarm changed. | false-verdict | The duplicate leaves the alarm unchanged, so it does not invalidate the prior diagnosis or move the alarm to the new phase. | fresh |
| R7-C04 | Shelving | Shelving is lost or treated as a closure | A lead records a follow-up ruling that closes a fix, shelves a known limit, and leaves one defect open. At the next ruling the last defect is shelved as well. | false-verdict | The ledger distinguishes shelved from closed. The first partial alarm lists only the remaining defect as open and only the explicit closure as closed. No new recurrence or partial alarm fires from the shelving. | ordered |
| R7-C05 | Carry-over | An earlier-phase blocker is filed as new or partial | A lead records an outstanding blocker as carried into a new phase, completes a second ruling and then records a genuine opening of the same class. | false-verdict | Carry is durable and feeds neither alarm. The genuine opening contributes to recurrence and can remain partly closed. | ordered |
| R7-C06 | Opened-key admission | A valid key accompanies a typo resembling a longer ID and another class | The lead transcribes two keys from a follow-up report into one closing command and tries again with the documented key. | wrong-result | Refuse the mixed batch without any ledger or evidence change. Accept and record the documented key on its own. | fresh |
| R7-C07 | Opened-key admission | Neighboring round and peer repository have the missing key | The lead closes one loop from another checkout after reading related reports. A further judge call documents the correct opening in the target records. | wrong-result | The neighboring round and peer repository cannot authorize the append. A suffixed judge report that names the ID in the target round can. | ordered |
| R7-C08 | Historical reads | TSV and JSONL rows have neither field | A lead reads archived trajectory exports alongside JSONL rows from before C4 adoption to reconstruct supervision. | stuck | Both layouts retain the recurrence, partial closure and area alarms with the same historical inputs and byte content. | ordered |

```sh
node --test acceptance/round7-c-trajectory.test.mjs
node --test --test-name-pattern=R7-C01 acceptance/round7-c-trajectory.test.mjs
node acceptance/run.mjs --seeds 101,202,303 acceptance/round7-c-trajectory.test.mjs
```
