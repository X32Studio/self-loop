# Round 6 acceptance · push and suite gates

Run the batch with `node --test acceptance/r6-a.mjs`, or run a single case with
`node --test --test-name-pattern '^R6-A02 ' acceptance/r6-a.mjs` (substitute its ID).
Run `node acceptance/run.mjs --seeds 101,202,303 acceptance/r6-a.mjs` for the timing
and stability table. The seeds vary repository names, the number of required checks,
the failing check and the SemVer core. Temporary bare repositories receive real Git
updates through a local-only transport. A separate stand-in serves CI snapshots per
destination and SHA.

| Case | Surface | Label | flow: who does what and why | loss: | Expected property |
|---|---|---|---|---|---|
| R6-A01 | A1 protected push | ordered | Lead adds a Git push mirror for redundancy and promotes while its required check is red. | false-verdict | Exit 2 with both URLs and both remedies. Both remote ref snapshots stay byte-for-byte equal. |
| R6-A02 | A1 close | ordered | Lead appends a CONVERGED row after a mirror is added to a loop with earlier green evidence. | false-verdict | Exit 2 names both URLs. Existing ledger bytes are identical. |
| R6-A03 | A1 close | ordered | Lead records CONTINUE while the same two-destination configuration is in use. | false-verdict | Append one row with CI unknown and both SHAs. Preserve the prior bytes and name both URLs. |
| R6-A04 | A1 diagnostic | ordered | Lead runs the CI diagnostic for the mirror-configured remote before promotion. | false-verdict | Exit 2 names both URLs. |
| R6-A05 | A1 next | ordered | Lead resumes after adding a mirror to a loop whose ledger records an earlier green reading. | false-verdict | Next reports unreadable live CI and names both URLs. |
| R6-A06 | A1 default remote | ordered | Lead verifies, closes and promotes to the ordinary single origin after CI passes. | false-verdict | Diagnostic and close succeed. Only the verified destination receives main. |
| R6-A07 | A1 configured remote | ordered | Lead promotes a release via a named remote while origin also has green CI. | wrong-result | Query and delivery follow the configured remote. Origin's remote refs stay unchanged. |
| R6-A08 | A1 Git rewrite | ordered | Lead uses Git's pushInsteadOf for the writable fork of a fetch-only upstream. | wrong-result | Diagnostic and promotion agree on the rewritten URL. Only the rewritten destination receives main. |
| R6-A09 | A1 separate remotes | ordered | Lead replaces a fan-out with two remotes and promotes each after its own CI. | false-verdict | First succeeds. Second refuses while red and succeeds when green without changing the first. |
| R6-A10 | A2 protected branches | ordered | Lead reuses a stale invocation whose branch list omits main. | false-verdict | Exit 64 names --protected and both remotes remain unchanged. The current invocation succeeds when green. |
| R6-A11 | A2 required checks | ordered | Lead reuses an earlier check list after a newly required check fails. | false-verdict | Exit 64 names --require and both remotes remain unchanged. The current invocation succeeds when green. |
| R6-A12 | A2 push remote | ordered | Lead reuses an old remote argument pointing at a green checks snapshot on the wrong destination. | false-verdict | Exit 64 names --remote and both remotes remain unchanged. The current invocation succeeds when green. |
| R6-A13 | A2 records | ordered | Lead uses an old command with a records path after upgrade. | false-verdict | Exit 64 names --records and both remotes remain unchanged. The current invocation succeeds when green. |
| R6-A14 | A2 absent registration | ordered | Lead selects a fresh owner store before importing the product and tries to promote. | false-verdict | Exit 2 identifies the missing match and no push occurs. The registered store succeeds. |
| R6-A15 | A2 duplicate registration | ordered | Lead imports a second registration pointing to a linked worktree of the same product and promotes. | false-verdict | Exit 2 identifies both matches. Register the product once and promotion from its linked checkout succeeds. |
| R6-A16 | A2 live CI | fresh | Lead promotes a previously green ruling after a required check's rerun goes red. | false-verdict | Refuse with the failed check and preserve remote refs. A subsequent green reading allows publication. |
| R6-A17 | A2 judge | ordered | Lead requests protected promotion on green live CI following a CONTINUE ruling. | false-verdict | Refuse on judge convergence and preserve remote refs. R6-A06 covers the CONVERGED counterpart. |
| R6-A18 | A1 working push | fresh | Lead first publishes a candidate for CI while origin still has two push URLs. | wrong-result | Refuse the fan-out even on a working branch. Removing the extra URL admits candidate publication. |
| R6-A19 | A1 version gates | ordered | Lead publishes the tagged candidate through Git's installed hook with a push mirror configured. | wrong-result | The hook prevents both updates. Release and reconcile also explain the two URLs. A single URL restores all three paths. |
| R6-A20 | A1 explicit destination | fresh | Lead pushes through the hook to a single SSH or filesystem endpoint supplied instead of a remote name. | false-verdict | The direct filesystem endpoint receives both the branch and tag. The configured remote stays unchanged. |
| R6-A21 | A3 fast-forward | ordered | Lead prepares a release branch from a reviewed commit while another checkout has staged and unstaged edits. | data | The named branch advances to a VERSION-only child, other checkout bytes stay intact and release publishes its branch and tag. |
| R6-A22 | A3 non-fast-forward | ordered | Lead constructs a tip using an older review base after development advances the branch. | data | Exit 2 prints the new commit without moving the branch or touching checkout files. Retrying on the new base advances. |
| R6-A23 | A3 version validation | ordered | Lead mistypes a SemVer or reuses a release number when constructing the tip. | false-verdict | Invalid and non-increasing versions have distinct refusals. A numerically higher prerelease succeeds on the default branch and preserves checkout bytes. |
| R6-A24 | A3 close integration | ordered | Lead closes a round after creating a VERSION tip on the judged commit. | false-verdict | The public close accepts the generated tip and records CI on its exact SHA. |
| R6-A25 | A4 shared receipt | ordered | Lead commits with the installed hook and releases with pre-push enabled, then saves the suite evidence. | false-verdict | The signed-off tree consumes one suite run across all entry points. Same-key evidence has a reuse reference and verifiable log. |
| R6-A26 | A4 positive variation | ordered | Lead measures the parent tree with the planned VERSION before testing its VERSION-only child. | false-verdict | The CLI tests the altered VERSION in isolation and the child reuses the matching green run with its own exact SHA. |
| R6-A27 | A4 normal receipt | ordered | Lead has a green parent run with no version variation and prepares a higher VERSION. | false-verdict | The green child runs once on its own tree before obtaining a verdict. |
| R6-A28 | A4 version-sensitive suite | fresh | Lead releases a VERSION whose behavior the suite rejects after the ordinary parent suite passed. | false-verdict | The child's suite runs, fails and leaves the remote refs empty. |
| R6-A29 | A4 lease on success | ordered | A green suite is waiting on a test dependency when the lead checks host load. | false-verdict | The lease has a live PID and the product and commit. The process removes it at exit. |
| R6-A30 | A4 lease on failure | ordered | A suite with a failing test runs while another lead is choosing whether the host has room. | false-verdict | The running lease is visible until the suite fails, then disappears. |
| R6-A31 | A4 install key | fresh | Lead retries the same tree with a different installation command after a prior green run. | false-verdict | A failing install refuses before the test command can run. |
