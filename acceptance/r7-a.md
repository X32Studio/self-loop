# Round 7 acceptance · CI identity and publication evidence

Run the batch with `node --test acceptance/r7-a.test.mjs`. To run one case, pass
`--test-name-pattern '^R7-A01 '` before the file and substitute its ID. For the timing
and stability table, run `node acceptance/run.mjs --seeds 101,202,303 acceptance/r7-a.test.mjs`.
The seeds vary the host and remote names, the check set and its failed rerun, the version
drift, and the runtime patch difference.

The CI stand-in serves GitHub CLI's check-run projection keyed by host, repository and
commit. It takes the explicit hostname before the environment default. Git publishes
only to temporary repositories. [GitHub CLI API manual](https://cli.github.com/manual/gh_api),
[GitHub CLI environment manual](https://cli.github.com/manual/gh_help_environment).

The runtime cases give the CLI and its Node test subprocess the same changed runtime
identity via a preload. The suite and repository stay fixed. This keeps the acceptance
batch runnable with one Node installation. In the release and hook cases, an ordinary Git
replacement ref is still active from local review. The tested local tree and the original
object tree that Git sends to a remote differ even though the working tree is clean.
[Git replacement refs manual](https://git-scm.com/docs/git-replace).

| ID | Surface | Label | Flow and why realistic | Loss | Expected property |
|---|---|---|---|---|---|
| R7-A01 | A5 CI diagnostic | ordered | A maintainer checks a mirrored commit from a shell with GitHub Enterprise selected. The two repositories share a slug but run their CI independently. | false-verdict | The public destination's failure wins. The diagnostic and saved receipt name its identity. After the public rerun succeeds, both report success. |
| R7-A02 | A5 close | ordered | A lead closes the round after running enterprise tools in the same shell. | false-verdict | CONVERGED refuses without appending when public CI is red. A public rerun closes the round, records the destination identity, and authorizes the protected push. |
| R7-A03 | A5 protected push | ordered | A lead promotes a previously accepted commit after a check reruns on the public destination. The enterprise mirror remains green. | false-verdict | Refusal preserves the destination refs. Public recovery permits promotion even after a failure on the mirror. |
| R7-A04 | A5 unsupported destination | ordered | A maintainer switches the push remote to an enterprise mirror while a public repository with the same slug and SHA has green checks. | false-verdict | No CI API is called. The diagnostic and CONTINUE receipt report unknown and identify the destination. CONVERGED and promotion refuse. Restoring the supported destination permits both. |
| R7-A05 | A6 gated push | ordered | A release lead selects the receipt generated while experimenting with a different VERSION for the same commit. | false-verdict | The command refuses, names both tree IDs, and leaves remote refs intact. An exact-tree receipt permits publication. |
| R7-A06 | A6 release | fresh | A release lead has a local replacement ref from reviewing a corrected tree. The original candidate still fails. | false-verdict | Release leaves the local tag and remote refs alone. It reports both tree IDs if the mismatched receipt reaches the gate, or evaluates and rejects the actual red tree if it rules out the mismatch earlier. The verified corrected commit can release. |
| R7-A07 | A6 pre-push | fresh | A lead pushes a tagged commit while the corrected local review view is still active. | false-verdict | The hook refuses mismatched evidence with both tree IDs or independently measures the original red tree. A real push through the hook leaves remote refs alone. The verified corrected commit pushes its branch and tag. |
| R7-A08 | A7 Node version | ordered | A lead repeats suite verification after upgrading Node within the same major and minor version. | false-verdict | The same runtime reuses the green result. The new runtime executes the now-red suite and the receipts name their respective runtimes. |
| R7-A09 | A7 platform | fresh | A lead verifies from a different operating system with the repository cache still available. | false-verdict | The repeat on the original platform reuses. The alternate platform executes the suite and reports its own red result and identity. |
| R7-A10 | A7 architecture | fresh | A lead switches architecture with the Git cache still available, such as when changing a macOS Node installation from x64 under Rosetta to arm64. | false-verdict | The alternate architecture runs the suite and exposes the failure. The original architecture reuses and both are named. |
| R7-A11 | A8 configured name | ordered | A release lead selects a namespaced Git remote accepted by `git remote add`. | false-verdict | The unknown name refuses. The configured name can diagnose CI, record convergence and deliver the tip. |
| R7-A12 | A9 missing protection | ordered | An older registration omits the protected branch list because the lead previously supplied it at promotion. | false-verdict | The command refuses with the migration instruction. An explicit empty list permits publication without a judge ruling or CI reading. |
| R7-A13 | A9 missing checks | ordered | The lead upgrades a loop that lists the protected branch but previously supplied required checks at promotion. | false-verdict | Omitting required checks refuses with the migration instruction. Explicitly configuring no checks still requires a judge ruling. With the ruling recorded, promotion proceeds without a CI reading. |
| R7-A14 | A6 exact version variation | ordered | A lead prepares a VERSION-only release after measuring the intended version in advance and publishes with the hook installed. | false-verdict | Release and pre-push reuse the already measured exact tree. The remote receives the version tag and branch after one suite run. |
