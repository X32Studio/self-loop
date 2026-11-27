# R-0006-judge

phase: v1
role: judge
agent: t3 gpt-5.4-pro
view: records@f2fc97cd34020dac4583f622c235bc7861e36d5d
briefs: engines/shared.md, engines/judge.md
product: f9b245d7deacd2eb57821e021c6eb450adca6d2f
audit: 0 violations, 0 denied, 65 flags (sealed/judge/0006/judge-1-audit.json)

## Public report (verbatim, out/public.md)

# Round 6 ruling

**CONTINUE.** All 444 suite tests passed on `f9b245d7deacd2eb57821e021c6eb450adca6d2f` on both Node 24 and Node 26. Keep all 70 new public cases and the five migrated cases. The prerelease has green CI according to the lead's receipt. Hold the plain release and installation.

**Closed — tip-ci-evidence:R5-1.** The shared resolver refuses remote fan-out. The protected push, close, diagnostic and driver honor that refusal. A separate CI authority issue remains.

## Open blockers

### ci-host-binding:R6-1

flow: A lead promotes or closes a mirrored project from a workstation that uses more than one CI host.
loss: false-verdict. A successful check on another host can authorize a destination with a failed check. Bind the CI reader to the full repository identity.

### suite-evidence:R6-2

flow: A release lead supplies suite evidence collected while preparing a version change to the publication gate.
loss: false-verdict. The gate can authorize a commit whose actual tree failed the suite. Compare the measured tree with the publication tree at the point of use.

### suite-evidence:R6-3

flow: A lead switches to the release toolchain and requests suite verification again in the same checkout.
loss: false-verdict. Cached success can survive a runtime change that makes the same suite fail. Include the executing runtime in the reuse decision.

### comment-admission:R6-4

flow: An actor records a valid product edit containing user-visible text in a supported source language.
loss: false-verdict. The hand-off gate refuses literal data as prose commentary. Classify the text in its language context.

### comment-admission:R6-5

flow: An actor records source with an instruction its language processor consumes.
loss: false-verdict. A valid tool directive prevents the hand-off. Verify directive recognition against the consuming tool.

### remote-admission:R6-6

flow: A lead promotes a green commit through a configured Git remote with one destination.
loss: false-verdict. The resolver rejects a valid remote name before consulting Git. Give Git authority over configured names.

### protection-migration:R6-7

flow: A lead upgrades a registered loop that previously supplied its branch protection policy at invocation, then uses the new promotion command.
loss: false-verdict. An omitted policy can silently retire a previously enforced check. Distinguish an unconfigured migration from an explicit decision to protect no branches.

## Follow-up

- **Critic:** Cover each property through its consuming command. Pair each refusal with legitimate success, and test the producer and consumer together for suite evidence and CI identity.
- **Actor:** Fix authority selection, suite evidence identity, source classification, Git name resolution and policy migration at their shared boundaries. Preserve single-destination closes, exact-tree reuse, intentional empty protection lists and valid working-branch publications.
- **Lead:** Retry the complete records check on the pinned records repository with history and evidence. Retain D-0026's per-product adoption decision. D-0025 and D-0027 already schedule the host-budget and session-start changes.
