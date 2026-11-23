# Forges and Remote CI

A round in `self-loop` never closes on an agent's self-report that tests passed locally. Every push targets **one destination**, and remote CI checks are read directly from that destination's own forge API on the **exact published commit SHA** (with `git --no-replace-objects`).

## Unified Forge Control Plane (`FORGES`)

Destination parsing, credential redaction, and remote CI reading are governed by a single control plane across three modules:

- [`scripts/lib/ci-destination.mjs`](../scripts/lib/ci-destination.mjs) — Pure URL parsing (`parseDestination`), canonical host normalization, credential redaction (`shownUrl`, `redactDestinationOutput`), GRC endpoint guard (`grcEndpointProblem`), and check-spec validation (`checkAppProblem`). Zero subprocesses, zero I/O.
- [`scripts/lib/ci-codebuild.mjs`](../scripts/lib/ci-codebuild.mjs) — AWS STS account binding and AWS CodeBuild reader.
- [`scripts/lib/ci.mjs`](../scripts/lib/ci.mjs) — Sole public control plane (`FORGES` registry, `pushDestination`, `ciDestination`, `ciGreen`, `receiptProblem`, `judgeAccepted`, `pushCommit`).

### Single-Destination Invariant

Every push gate (`gated-push.mjs`, `version-gate.mjs release|reconcile`, `.githooks/pre-push`, `ci-green.mjs`, and `trajectory.mjs append`) asks Git directly via `git remote get-url --push --all -- <remote>`:

- Any remote name Git accepts (including dots, slashes, or leading hyphens) is allowed; unknown remote names are refused (exit `2`).
- A remote configured with **more than one push URL** (e.g., a push mirror added with `git remote set-url --add --push`) is **refused** (exit `2`, nothing pushed, CI `unknown`). Give each destination its own remote and promote through each separately, or remove the extra push URL (`git remote set-url --delete --push <remote> <url>`).
- **Latest-run semantics (`scripts/lib/check-runs.mjs`)**: Every required check is named `app/name`. When multiple runs exist for the same commit and check, the latest run wins—a failed re-run is `failure`, and a queued/in-progress re-run is `pending` (never masked by an earlier green run).

---

## GitHub (`github.com` / GitHub Actions)

GitHub is registered in `FORGES` as `github`.

### Supported Remotes & Check Specs

- **Remotes**: `https://github.com/<owner>/<repo>[.git]`, `ssh://git@github.com/<owner>/<repo>[.git]`, and `git@github.com:<owner>/<repo>[.git]` (default ports only; non-default ports like `:8443` fail closed as unsupported hosts).
- **Check format in `loop.json`**: `<app-slug>/<check-name>`, for example:

```json
"protected": ["main"],
"gates": {
  "suite": "node --test scripts/test/*.test.mjs",
  "require": ["github-actions/verify"],
  "remote": "origin"
}
```

### How Checks Are Read

- Executes `gh api --hostname github.com --paginate repos/<owner>/<repo>/commits/<sha>/check-runs?per_page=100&filter=all` with `GH_HOST=github.com` pinned in the child environment (immune to an ambient `GH_HOST` pointing at another host).
- Uses your existing `gh auth` / `GH_TOKEN` credentials.
- Receipts record `{ forge: "github", host: "github.com", repository, sha, ci, ok, missing, conclusions, runs, source }`.

---

## AWS CodeCommit + AWS CodeBuild (`F-0013`)

AWS CodeCommit is registered in `FORGES` as `codecommit`, with AWS CodeBuild (`codebuild/<project-name>`) as its remote CI provider.

### Supported Remote URLs

Every URL transport across the **commercial (`aws`)**, **China (`aws-cn`)**, and **GovCloud (`aws-us-gov`)** partitions is accepted and normalized to one canonical host `git-codecommit.<region>.amazonaws.com[.cn]` with case-preserved `repository`:

| Transport | Accepted Form |
|---|---|
| **HTTPS** (standard, FIPS, PrivateLink VPC) | `https://[userinfo@]git-codecommit[-fips].<region>.amazonaws.com[.cn][:443]/v1/repos/<repo>[.git]`<br>`https://[userinfo@]vpce-<id>.git-codecommit[-fips].<region>.vpce.amazonaws.com[.cn][:443]/v1/repos/<repo>[.git]` |
| **SSH URL** (standard, FIPS, VPC) | `ssh://[SSH-KEY-ID@]git-codecommit[-fips].<region>.amazonaws.com[.cn][:22]/v1/repos/<repo>[.git]` |
| **SSH SCP** (standard, FIPS, VPC) | `[SSH-KEY-ID@]git-codecommit[-fips].<region>.amazonaws.com[.cn]:[/]v1/repos/<repo>[.git]` |
| **GRC (explicit region)** | `codecommit::<region>://[<profile>@]<repo>` |
| **GRC (regionless)** | `codecommit://[<profile>@]<repo>` |

**Strict URL validation:**
- Rejects percent-encoding (`%`), query strings (`?`), fragments (`#`), plaintext `http://`, `ext::` helpers, non-default ports, and spoofed hostnames.
- GRC URLs do **not** strip trailing `.git` (matching official `git-remote-codecommit` and AWS CodeCommit's prohibition on repo names ending in `.git`).
- For regionless `codecommit://` remotes, region resolution follows `git-remote-codecommit` (botocore) precedence (`AWS_DEFAULT_REGION`, else `aws configure get region [--profile=<profile>]`) and refuses any disagreement with `AWS_REGION` (`DestinationError`).

### `loop.json` Configuration

Required checks use `codebuild/<project-name>` where `<project-name>` is 2–255 characters matching `[A-Za-z0-9][A-Za-z0-9_-]{1,254}`:

```json
"protected": ["main"],
"gates": {
  "suite": "npm test",
  "require": ["codebuild/my-project-ci"],
  "remote": "origin"
}
```

### How CodeBuild Reads Are Verified (`scripts/lib/ci-codebuild.mjs`)

1. **Pinned AWS child environment**: Invokes `aws` via `execFileSync` (zero shell, every value passed as `--flag=value`), strips all `AWS_ENDPOINT_URL*` variables, sets `AWS_IGNORE_CONFIGURED_ENDPOINT_URLS=true`, `AWS_CLI_AUTO_PROMPT=off`, `AWS_PAGER=""`, and pins `AWS_REGION` / `AWS_DEFAULT_REGION` to the destination's region.
2. **Mandatory AWS account binding**: Calls `aws sts get-caller-identity` once per reading and requires a 12-digit `Account`. Every CodeBuild build's `arn` must match the expected partition, region, project name, build UUID, and caller `Account`.
3. **Bounded manual pagination**: Paginates `aws codebuild list-builds-for-project --max-items=100` (with `--starting-token`, capped at 500 builds per project) followed by `aws codebuild batch-get-builds --cli-input-json=...`. Never passes `--sort-order` or `--no-paginate`.
4. **Strict ordering & exact-commit checks**:
   - Verifies strictly decreasing positive integer `buildNumber` across every page.
   - Matches only primary `build.source.type === "CODECOMMIT"` whose normalized `source.location` matches the destination's region and exact case-sensitive repository name.
   - Requires `resolvedSourceVersion === fullSha` (a `SUCCEEDED` build without `resolvedSourceVersion` is never accepted).
   - Fails closed (`ci: "unknown"`) on `buildsNotFound`, batch builds (`buildBatchArn`), or invalid metadata.
   - Protects against newer unresolved `IN_PROGRESS` reruns: an in-progress build with a higher `buildNumber` than a matched build forces `pending` until it resolves to another SHA or completes.
5. **Status mapping**: `SUCCEEDED` → `success`, `FAILED`/`FAULT` → `failure`, `TIMED_OUT` → `timed_out`, `STOPPED` → `cancelled`, `IN_PROGRESS` → `in_progress` (`pending`).
6. **Receipts**: Carry `{ forge: "codecommit", host, region, account, repository, sha, ci, ok, missing, conclusions, runs, source }` (with `build_id` retained on each run for AWS auditability, and zero profile names or URLs written to receipts).

### Batch-1 Scope Boundaries (Documented in [`DEBT.md`](../DEBT.md))

- **HTTPS/SSH push-account visibility**: CodeCommit HTTPS and SSH remote URLs do not embed an AWS account ID; only GRC (`codecommit://` / `codecommit::<region>://`) binds push and CI-read accounts by construction when both share the same profile/credential chain.
- **CodePipeline & cross-region CodeBuild**: CodeBuild projects whose primary `source.type` is `CODEPIPELINE`, cross-region CodeBuild projects, and CodeBuild batch builds (`buildBatchArn`) are not supported in Batch 1 (`codepipeline/*` fails closed as an unsupported check app).

---

## Other Git Hosts (GitLab, Bitbucket, GitHub Enterprise Server)

`FORGES` in [`scripts/lib/ci.mjs`](../scripts/lib/ci.mjs) currently registers live remote CI readers for **GitHub (`github.com`)** and **AWS CodeCommit + CodeBuild**. Any other host—including **GitLab (`gitlab.com` or self-hosted)**, **Bitbucket**, and **GitHub Enterprise Server**—parses with `forge: null` and **fails closed** on remote CI reads (`ci-green.mjs` exits `2` with `ci: "unknown"`).

### What Works Out of the Box on GitLab & Other Hosts

- **Local suite & benchmark gates**: `suite-green.mjs` and `bench-gate.mjs` work identically on any Git repository.
- **Working-branch gated pushes**: `gated-push.mjs --branch <working-branch>` verifies the exact-tree suite receipt and single push URL without querying remote CI.
- **Version and tag gates**: `version-gate.mjs tip`, `release`, `reconcile`, and `.githooks/` (`pre-commit`, `pre-push`) work on any single-URL Git remote.
- **Protected branches without remote CI**: Setting explicit `"protected": ["main"]` and `"gates": { "require": [] }` in `loop.json` allows `gated-push.mjs` to enforce the suite receipt and committed Judge `CONVERGED` ruling while skipping remote CI (note: `trajectory.mjs append` still requires a green CI reading to record a `CONVERGED` trajectory row per `D-0014`).

### Extending `FORGES` for GitLab CI (or Another Forge)

Because all callers dispatch through `FORGES` in [`scripts/lib/ci.mjs`](../scripts/lib/ci.mjs), adding native GitLab CI (e.g., via `glab api` over pipeline/commit statuses) requires:

1. Recognizing the forge in `parseDestination(url)` in [`scripts/lib/ci-destination.mjs`](../scripts/lib/ci-destination.mjs) (returning `{ forge: "gitlab", host, region: null, repository, profile: null }`).
2. Adding a single `gitlab` entry to `FORGES` in [`scripts/lib/ci.mjs`](../scripts/lib/ci.mjs) with `apps` (e.g. `["gitlab-ci"]`), optional `validateSpec`, and `fetchRuns(destination, sha, parsedRequired)` returning `{ runs, error? }` in the `scripts/lib/check-runs.mjs` run shape.

No downstream script (`ci-green.mjs`, `gated-push.mjs`, `trajectory.mjs`, `loop.mjs`, `blueprint.mjs`) needs control-flow changes.

---

## Gate CLI Reference

### `scripts/ci-green.mjs`

Reads remote CI checks for one exact commit at one push remote:

```bash
node scripts/ci-green.mjs \
  --repo <product> \
  --sha <commit> \
  --require app/name[,app/name,...] \
  [--remote origin] \
  [--from-json <check-runs.json>] \
  [--out <records>/evidence/NNNN/ci-<k>]
```

- **Exit codes**: `0` all required checks green, `2` not green (`failure`, `pending`, `absent`, or `unknown`/unreadable), `64` usage error (or `--out` already exists — evidence is never overwritten).
- **`--from-json`**: Offline evaluation for tests or inspection; sets `source: "from-json"` in the receipt (live reads set `source: "live"`). Still enforces forge/check-app compatibility before reading the file.

### `scripts/gated-push.mjs`

Publishes a commit only after verifying its exact-tree suite receipt and—for protected branches—its committed Judge `CONVERGED` ruling and live remote CI:

```bash
node scripts/gated-push.mjs \
  --repo <product> \
  --branch <branch> \
  --suite-receipt <receipt.json> \
  [--sha <commit>] \
  [--dry-run] \
  [--owner-store <dir>]
```

- **Policy comes strictly from registered `loop.json`**: `--protected`, `--require`, `--remote`, and `--records` flags were intentionally removed (passing them exits `64`). `gated-push.mjs` finds the single registered product in the owner store whose Git common directory matches `--repo` (supporting linked worktrees) and reads `protected`, `gates.require`, and `gates.remote` (default `"origin"`) from its `loop.json`.
- **Protection is never retired by omission**: A `loop.json` missing either `"protected"` or `"gates.require"` is refused as unconfigured (exit `2`) even when pushing a working branch. Write explicit `"protected": []` or `"require": []` if you intend no protection or no checks.
- **Exit codes**: `0` pushed (or would push under `--dry-run`), `2` refused (nothing pushed), `64` usage error.

---

## GRC Endpoint Fail-Closed Security & Credential Redaction

### Fail-Closed `CODE_COMMIT_ENDPOINT` Guard

`git-remote-codecommit` respects an ambient `CODE_COMMIT_ENDPOINT` environment variable that could redirect a `git push` away from the canonical AWS CodeCommit endpoint while CI reads still query canonical CodeBuild.

`grcEndpointProblem(url, env)` in [`scripts/lib/ci-destination.mjs`](../scripts/lib/ci-destination.mjs) **refuses any non-empty `CODE_COMMIT_ENDPOINT`** on `codecommit://` and `codecommit::<region>://` remotes across every gate:
- `pushDestination` (`ci-green.mjs`, `gated-push.mjs`, `version-gate.mjs release`, `version-gate.mjs reconcile`, `trajectory.mjs append`)
- `.githooks/pre-push` (`version-gate.mjs pre-push`), including explicit `git push codecommit://...` invocations that bypass remote names.
- `pushCommit` additionally strips `CODE_COMMIT_ENDPOINT` from its `git push` child environment as defense-in-depth.

Unset `CODE_COMMIT_ENDPOINT` so Git connects strictly to the canonical regional CodeCommit endpoint.

### Credential & Profile Redaction Guarantees

Because gate errors and receipts are committed to loop records, `self-loop` redacts sensitive URL components at the single boundary (`shownUrl` and `redactDestinationOutput` in [`scripts/lib/ci-destination.mjs`](../scripts/lib/ci-destination.mjs)):

- `http(s)://<user>:<token>@host/...` → `https://***@host/...`
- `codecommit://[profile@]MyRepo` and `codecommit::<region>://[profile@]MyRepo` → `codecommit://***@MyRepo` / `codecommit::<region>://***@MyRepo`
- `ssh://<SSH-KEY-ID>@git-codecommit...` or any non-`git` SSH user → `ssh://***@...` (non-credential `git@github.com:...` and `ssh://git@github.com/...` remain readable)
- `git push` stdout/stderr is scrubbed via `redactDestinationOutput` so errors such as `ProfileNotFound` do not leak AWS profile names.
- AWS subprocess errors are classified into redacted summaries (e.g., `aws sts get-caller-identity failed (AccessDenied)`), never dumping raw stderr or credentials into receipts.
- [`scripts/records-check.mjs`](../scripts/records-check.mjs) additionally screens committed records for `AKIA...`, `ASIA...`, `AWS_SECRET_ACCESS_KEY` / `aws_secret_access_key` / `SecretAccessKey`, GitHub PATs, Anthropic/OpenAI keys, Slack tokens, and PEM private keys.
