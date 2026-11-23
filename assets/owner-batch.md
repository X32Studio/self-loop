# B-NNNN Owner batch

phase: <phase>
from: <R-NNNN-role>
kind: intent
requirement: <P-NNNN>

Each question carries the loop's recommendation; answering "as recommended" is enough. The answer is recorded verbatim with `node scripts/decisions.mjs answer --records <records> --batch B-NNNN --words "<the owner's words>"`.

Intent batch 1 of at most 2 for <P-NNNN> in this phase. Question numbers and dependsOn are one-based (1 is the first question). The questions come in dependency order; where an earlier answer changes a recommendation, the question says which recommendation follows.

### 1. <one decision, stated so it can be answered in one line>
Context: <two or three sentences; record IDs and facts, not prose history>
Why asked: <why the records, the code and first principles cannot settle it>
Options: <A> / <B> / <C>
Recommendation: <option, and why in one sentence>
Cost of waiting: <what stalls until this is answered>

### 2. <a decision that depends on the first>
Why asked: <why the records, the code and first principles cannot settle it>
Depends on: question 1
Options: <D> / <E>
Recommendation: <option, and why in one sentence>
If question 1 is answered "<B>": <the recommendation that then follows>
If question 1 is answered "<C>": <the recommendation that then follows>

<!-- D-0015, D-0031 -->
