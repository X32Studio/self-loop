# bench-gate admission evidence

`r41-judge.jsonl`: the 25 pairs (pair 0 is the warm-up) the R-0041 judge of the ExampleApp loop measured with
`node scripts/bench-local.js 24 2` on the owner's Mac, base `9aafd69` against candidate `952bf8b`, metric
`releaseToLastAdoptionMs` (one row per run; reduced from the judge's `evidence/bench.jsonl`). The judge's own summary:
median ratio 1.6887863733144073, 8th ordered ratio 1.6782670454545454 (lower bound), 17th 1.698140200286123 (upper).
