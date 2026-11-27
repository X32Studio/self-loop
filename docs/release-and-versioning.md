# Release and Versioning

`self-loop` treats every pushed branch tip and every version tag as a verifiable publication bound to the exact Git tree that leaves the machine.

## SemVer 2.0 `VERSION` Contract

The repository's version lives in `VERSION` at the repo root and is parsed by [`scripts/lib/version.mjs`](../scripts/lib/version.mjs):

- **Format**: SemVer 2.0 **without build metadata** — either a plain release `X.Y.Z` or a prerelease `X.Y.Z-<prerelease>` (for example `0.4.11-v1.1`).
- **Precedence**: Standard SemVer ordering: `0.4.10 < 0.4.11-v1.1 < 0.4.11-v1.2 < 0.4.11`.
- **Two distinct roles**:
  - **Prerelease (`X.Y.Z-<prerelease>`)**: A round's candidate pushed to a working branch (such as `loop/v1`) so it runs on real remote CI without cutting a release.
  - **Plain release (`X.Y.Z`)**: A reviewed, converged release. **Only plain `X.Y.Z` releases are installed** as live skills and heartbeat release worktrees.
- **Tag immutability**: Every pushed branch tip must have a `VERSION` strictly greater than the destination branch's previous `VERSION` and must be tagged `v<VERSION>` on that exact commit by the end of the push. `v*` tags never move and are never deleted.

## Creating `VERSION`-Only Tips (`version-gate.mjs tip`)

A Judge rules on one commit SHA, and the Lead then raises `VERSION` on top of it so the candidate can be pushed to CI. Rather than manually editing `VERSION` and committing in a dirty checkout, create a single-parent `VERSION`-only commit directly from Git's original objects:

```bash
node scripts/version-gate.mjs tip --version 0.6.0-v1.1 [--on <ruled-sha>] [--branch <branch>]
```

- Builds a commit whose parent is `--on` (default: head of `--branch`, default: current branch) and whose tree differs from the parent's **only** in `VERSION`.
- Verifies `<V>` is strictly greater than the parent's `VERSION` (exit `64` invalid format, exit `2` not greater).
- Moves `--branch` **only as a fast-forward via compare-and-swap** (`git update-ref`); if it would not fast-forward, exits `2`, prints the created SHA, and leaves the branch untouched.
- Never modifies your working tree or index (if the moved branch is checked out elsewhere, stderr prints `git checkout HEAD -- VERSION`).

### Linking a Ruling to Its `VERSION`-Only Tip

[`scripts/lib/tip.mjs`](../scripts/lib/tip.mjs) verifies with `--no-replace-objects` that a pushed tip stands for a ruled commit iff the ruled commit is an ancestor of the tip through single-parent commits only and `git diff --no-renames --name-only <ruled> <tip>` is exactly `VERSION`:

- `trajectory.mjs append --commit <ruled-sha> --tip <pushed-tip-sha> ...` records both SHAs and reads remote CI for `--tip`.
- `gated-push.mjs` allows a protected branch to promote a `VERSION`-only tip whose ruled parent has a committed Judge `CONVERGED` ruling.
- `blueprint.mjs set --status done --round R-NNNN-judge` inherits `commit`, `tip`, and `ciReceipt` directly from that round's `CONVERGED` trajectory row.

## Exact-Tree Suite Verification & Reuse

Every suite gate (`suite-green.mjs`, `.githooks/pre-commit`, `version-gate.mjs release`, `.githooks/pre-push`) executes through [`scripts/suite-green.mjs`](../scripts/suite-green.mjs) in a fresh detached temporary worktree checked out from Git's original objects (`--no-replace-objects`):

```bash
# Test the exact commit
node scripts/suite-green.mjs \
  --repo . --sha <commit> \
  --command "node --test scripts/test/*.test.mjs" \
  --format node-test \
  --out <records>/evidence/0001/suite-1

# Pre-warm exact-tree coverage for a planned VERSION-only child before creating the tip
node scripts/suite-green.mjs \
  --repo . --sha <ruled-sha> --vary-version 0.6.0-v1.1 \
  --command "node --test scripts/test/*.test.mjs" \
  --format node-test \
  --out <records>/evidence/0001/suite-1
```

### How Reuse & Measured-Tree Checking Work

- **Cache store**: `<git-common-dir>/self-loop-suite/<sha256-of-key>/`, keyed by `(repository, tree, command, install, executable-sha256, runtime)`.
- **Strict reuse conditions**: Reuse applies only to direct literal `node --test <files...>` commands with no `--install` command, no `NODE_OPTIONS`, and a `node` executable on `PATH` whose realpath matches the calling process's binary. Stored logs are verified by SHA-256 and re-evaluated under the requested `--format`. Any other command runs fresh every time.
- **`--vary-version <V>`**: Synthesizes the parent's tree with `VERSION` set to `<V>\n` (recording `versionVaried` on the receipt). That receipt **never** covers the parent's own tree; it covers only a `VERSION`-only descendant whose published tree matches byte-for-byte.
- **Anti-`git-replace` protection**: Every gate compares the receipt's measured `tree` against `git --no-replace-objects rev-parse <sha>^{tree}`. A local `git replace` ref can neither make a red commit appear green nor break a green original commit.

## Atomic Release Push (`version-gate.mjs release`) & Local Hooks

Once `VERSION` is raised on a clean working tree, push the branch and its annotated `v<VERSION>` tag atomically:

```bash
node scripts/version-gate.mjs release [--remote origin] [--branch <branch>]
```

What `release` enforces before pushing:
1. Clean working tree (`git status --porcelain` empty) and valid SemVer `VERSION`.
2. Single effective push URL on `--remote` (no multi-URL push mirrors; refuses `CODE_COMMIT_ENDPOINT` on GRC remotes).
3. Remote branch fast-forward check and immutability check on `refs/tags/v<VERSION>` (neither local nor remote tag may point at another commit).
4. `VERSION` strictly greater than the remote branch's `VERSION`.
5. Green full test suite on the exact published tree (for `self-loop`, every `*.test.mjs` directly under `scripts/test/` and `acceptance/`).
6. Creates annotated tag `v<VERSION>` if not already present, then executes `git push --atomic` with `--force-with-lease` on both the branch and tag refs, recording a local gate receipt in `<git-common-dir>`.

### Local Git Hooks (`.githooks/`)

Enable once per clone with `git config core.hooksPath .githooks`:
- **`.githooks/pre-commit`**: Runs `version-gate.mjs pre-commit` against the exact staged tree.
- **`.githooks/pre-push`**: Runs `version-gate.mjs pre-push`, enforcing `VERSION` precedence, `v<VERSION>` tag alignment, tag immutability, GRC endpoint guard, single push URL, and green suite on every pushed branch tip and `v*` tag.

## Reconciling Unattested Remote Tips (`version-gate.mjs reconcile`)

Because a human can explicitly pass `git push --no-verify`, `self-loop.mjs next` checks whether remote branch tips have a corresponding local gate receipt. To inspect and resolve unattested tips from your checkout:

```bash
# List persistent unattested-tip findings
node scripts/version-gate.mjs reconcile --remote origin --branch <branch>

# Close a finding after linking it to an owner word (W-...) or decision (D-...) in records
node scripts/version-gate.mjs reconcile \
  --remote origin --branch <branch> \
  --close <finding-id> --cite <W-id-or-D-id> --records <records-repo>
```

Receipts and findings are stored under the product repository's Git common directory.

## Dual-Platform CI Verification

For `self-loop` itself, [`.github/workflows/test.yml`](../.github/workflows/test.yml) runs both the unit suite (`node --test scripts/test/*.test.mjs`) and the acceptance suite (`node --test acceptance`) on **Linux (ARM64)** and **macOS (ARM64)** under Node 24. A prerelease tip (e.g., `0.6.0-v1.1`) verifies both platforms on live remote CI before any plain `0.6.0` release is cut and installed.

## Multi-Host Controlled Installation & Rollback

Keep live installations strictly separated from development clones:

1. **Create a dedicated detached release worktree** on each host:
   ```bash
   git -C /path/to/self-loop fetch --tags origin
   git -C /path/to/self-loop worktree add --detach /path/to/self-loop-release v0.6.0
   ```
2. **Verify release eligibility**: `scripts/lib/heartbeat.mjs` (`releaseProblem`) verifies that a release worktree is:
   - The top of a Git checkout with detached `HEAD` (never on a mutable branch),
   - Carrying a plain `X.Y.Z` `VERSION` (prereleases are refused),
   - Tagged `v<VERSION>` at `HEAD`,
   - Free of local modifications to tracked files.
3. **Install or refresh host integrations from the release worktree**:
   ```bash
   # Hourly OS heartbeat (launchd on macOS, cron on Linux)
   node /path/to/self-loop-release/scripts/self-loop.mjs heartbeat install --release /path/to/self-loop-release

   # Workspace or global Antigravity hooks pinned to the release worktree
   node /path/to/self-loop-release/scripts/self-loop.mjs hooks install \
     --harness antigravity --release /path/to/self-loop-release
   node /path/to/self-loop-release/scripts/self-loop.mjs hooks check --harness antigravity
   ```
4. **Upgrading across hosts**: Fetch tags on each host, move its detached release worktree to the new plain tag (`git -C /path/to/self-loop-release checkout --detach v0.6.1`), and re-run `hooks check` (and `heartbeat install` if paths changed).
5. **Rolling back cleanly**: Move the affected host's detached release worktree back to the previous plain tag (`git -C /path/to/self-loop-release checkout --detach v0.6.0`) and re-verify hooks. **Never delete or force-move published remote `v*` tags, and never rewind your records repository's append-only ledgers (`owner/words.jsonl`, `metrics/trajectory.jsonl`, `metrics/handoffs.jsonl`).**

> **Note on candidate supervised incremental release:** [`design/scoped-release.md`](../design/scoped-release.md) and [`scripts/scoped-release.mjs`](../scripts/scoped-release.mjs) define an experimental candidate contract for single-authority scoped incremental releases alongside—never replacing—the standard whole-phase `CONVERGED` release workflow described above.
