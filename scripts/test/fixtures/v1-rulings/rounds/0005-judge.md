# R-0005-judge

phase: v1
role: judge
agent: t3 gpt-6.2-astra
view: records@81ff4c8825952d1c182d0b24296e0c2608fc77e4
briefs: engines/shared.md, engines/judge.md
product: c9b604e170d403ecb9af27020813b97c64ab6e95
audit: 0 violations, 0 denied, 42 flags (sealed/judge/0005/judge-1-audit.json)

## Public report (verbatim, out/public.md)

# R-0005 judge ruling

**CONTINUE for round-close. Release the watch scope separately under D-0015 item 2.** The ruled commit c9b604e170d403ecb9af27020813b97c64ab6e95 passed all 342 script and public acceptance tests. Registry, next/stall across products, tick and start passed user-path acceptance.

**CLOSED — tip-ci-evidence:R1-5.** The trajectory writer derives its loop from the receiving ledger. The former caller inputs cannot substitute a different loop's CI. The writer and receipt module are both smaller than at b9073ee.

**OPEN — tip-ci-evidence:R5-1, round-close.**  
flow: A lead closes a round and requests protected publication. The live gate approves an operation whose effective destination set exceeds the scope of the green CI evidence.  
loss: false-verdict. The protected operation can be authorized while a destination it updates has a failed required check.

- **Critic:** Assert that authorization covers every destination of the proposed protected update. Include a legitimate green publication.
- **Actor:** Derive the effective destination set once and use it for verification and publication. Keep single-repository closes and valid aliases working. Provide an actionable route to publish when destinations need separate certification.
- **Lead:** File the blocker under slice 5. Proceed with the plain watch release, its normal gates, and the D-0009 pre-upgrade replay. The current product origin resolves to a single destination.

The corrected RULE-28, R5-VER-02 and HB-01 cases are KEEP. The judge hand-off exists in RULE-28. The event carries the judged commit and the pushed tip. The two release fixtures now exercise their intended behavior on both platforms and across candidate versions. The alarm and batch changes passed admission and regression coverage. No owner decision is required.
