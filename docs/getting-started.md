# Getting Started

This guide walks through installing `self-loop`, initializing a loop for a repository, wiring optional harness hooks, and running your first Frame → Critic → Actor → Judge round.

## Prerequisites

- **Node.js `>= 22`** (`>= 22.13` is required for built-in `node:sqlite`, which Antigravity session discovery uses to read `conversation_summaries.db`; CI runs on **Node 24**).
- **`git`** (recent version supporting `git worktree`, `git --no-replace-objects`, and `git push --atomic`).
- **Zero npm dependencies**: `self-loop` uses only Node.js built-in modules and spawns existing host CLIs directly.
- **Optional forge CLIs** (needed only for live remote CI reads):
  - **GitHub**: [`gh`](https://cli.github.com/) authenticated for `github.com` (or `GH_TOKEN`).
  - **AWS CodeCommit + CodeBuild**: AWS CLI v2 (`aws`) with standard AWS credentials (`AWS_PROFILE`, IAM role, or environment credentials) and, for `codecommit://` remotes, `git-remote-codecommit`.
- **Agent runners**: `claude` CLI, `codex` CLI, or T3 Code (`runner: "t3"` with `provider: "claude" | "codex" | "antigravity"`). Confined Frame Reviewer runs use `claude` CLI (`--restricted`, file tools only) or `t3` (`antigravity` / `claude`) with fail-closed confined transcript auditing; Codex (CLI and `t3:codex`) is refused for `reviewer`.

## Installation

Clone `self-loop` once and pin a **plain `X.Y.Z` release tag** for live operation (never run production hooks or heartbeats from a mutable dev branch or a `-<prerelease>` tag):

```bash
git clone https://github.com/X32Studio/self-loop.git ~/tools/self-loop
cd ~/tools/self-loop
git checkout v0.6.0
```

Verify the installation with the unit test suite:

```bash
node --test scripts/test/*.test.mjs
```

If you plan to contribute to `self-loop` itself, enable its repository hooks once per clone:

```bash
git config core.hooksPath .githooks
```

## Initializing a Project Loop

A `self-loop` setup separates **product code** from **loop records** (its own Git repository).

### Option A: In-repo `.self-loop/` (default in v0.6.0)

Run `self-loop.mjs init` inside your product repository to create a nested Git records repository at `<repo>/.self-loop/` and automatically add `.self-loop/` to `.gitignore`:

- **`self-loop.mjs init`** gives immediate zero-config auto-discovery for `start`, `next`, `stall`, and `hooks` inside that checkout (no owner store required).
- **`self-loop.mjs init --register`** additionally initializes `~/.self-loop/owner-store` (if missing) and registers the product in one step, which is **required** before running `gated-push.mjs` or multi-repo `tick` / `heartbeat`.

```bash
cd /path/to/my-project

# Zero-config local discovery (start / next / stall / hooks):
node ~/tools/self-loop/scripts/self-loop.mjs init

# Recommended when using gated-push.mjs or multi-repo tick / heartbeat:
node ~/tools/self-loop/scripts/self-loop.mjs init --register
```

If you prefer not to modify the repository's tracked `.gitignore`, use `--local-exclude` to write `.self-loop/` to `.git/info/exclude` instead (combinable with `--register`):

```bash
node ~/tools/self-loop/scripts/self-loop.mjs init --local-exclude --register
```

Because `.self-loop/` is its own Git repository ignored by the outer product repo, records history stays cleanly isolated from product commits while living right beside your code. When initialized on a protected branch such as `main` (or `master`), `init` sets `branch` in `.self-loop/loop.json` to `"loop/v1"` so working commits never target the protected branch directly.

### Option B: External Records Repository (`--records`)

If you prefer to keep records outside the product checkout (for example, to back them up to a separate private Git remote), pass `--records` (add `--register` to register it in your owner store at the same time):

```bash
node ~/tools/self-loop/scripts/self-loop.mjs init --records ../my-project-records --register
```

### Manual Setup & Owner Store Registration

If you already passed `--register` to `self-loop.mjs init`, your product is already registered in the **owner store** (`~/.self-loop/owner-store` by default, override via `--owner-store <dir>` or `SELF_LOOP_OWNER_STORE`). If you ran `init` without `--register`, want to configure `--roots` / `--aliases`, or are registering an existing records repository so `gated-push.mjs`, multi-repo `tick`, `--all`, and `heartbeat` can see it, manage the registry explicitly:

```bash
# Once per machine / owner (optional --roots lets `tick` discover unregistered records repos)
node ~/tools/self-loop/scripts/self-loop.mjs registry init --roots /path/to/projects

# Register each product loop (records path must be absolute)
node ~/tools/self-loop/scripts/self-loop.mjs registry add \
  --name my-project \
  --records /path/to/my-project/.self-loop \
  --aliases MyProject

# Inspect registered products
node ~/tools/self-loop/scripts/self-loop.mjs registry list
```

### Configuring `loop.json`, `records.json`, Purpose, and Briefs

Inside your records repository (`.self-loop/` or `../my-project-records`), verify four files before round 1:

1. **`records.json`** — Copy from [`assets/records.example.json`](../assets/records.example.json). Point `sealed` at a **separate** held-out repository outside public records if you keep held-out acceptance suites.
2. **`loop.json`** — Copy from [`assets/self-loop.example.json`](../assets/self-loop.example.json) and configure:
   - `product`: absolute (or records-relative) path to your product repo.
   - `branch`: a non-protected working loop branch (for example `loop/v1`).
   - `protected`: explicit list of protected branches (for example `["main"]`, or `[]` if none — omitting this key refuses every gated push).
   - `records` and `workDir`: `workDir` (scratch role workspaces) must **never** be inside `records` or contain `records`.
   - `phase`: current phase identifier (for example `"v1"`).
   - `briefs`: paths inside the records repo (`engines/shared.md`, `engines/frame-reviewer.md`, `engines/critic.md`, `engines/actor.md`, `engines/judge.md`).
   - `owns`: product paths each writing role may modify (`critic` vs `actor`).
   - `agents`: runner/model per role. Put `judge` and `actor` on **different vendors and models**; run `reviewer` on `claude` CLI (`--restricted`, file tools only) or `t3` (`antigravity` / `claude`, verified by fail-closed confined transcript auditing). Codex (CLI and `t3:codex`) is refused for `reviewer`.
   - `gates`: `suite` (full test command), `require` (required CI checks as `app/name`, e.g. `["github-actions/verify"]` or `["codebuild/my-project"]`, or explicit `[]`), and `remote` (default `"origin"`).
   - `ssot` *(optional)*: declarative Single Source of Truth authority-document registry (`entries` binding `doc`, `watch`/`ignore`, optional `anchors` and `check`, and display `mode` `"same-batch"` | `"phase-close"`, plus optional `repos` resolved relative to `loop.json`'s directory). Gate timing follows `D-0057` identically for both modes (Rung-2 hard-blocks all `gated-push`; Rung-3 `ssot-drift` screens on working branches and hard-blocks `CONVERGED` and protected-branch `gated-push`). See [`docs/concepts-and-records.md#ssot-authority-documents`](concepts-and-records.md#ssot-authority-documents) for `check` environment variables, `anchors` semantics, receipt fields, and `attest` rules (plus [`RECORDS.md`](../RECORDS.md)).
3. **Role briefs** — Copy [`assets/brief-shared.md`](../assets/brief-shared.md), [`assets/brief-frame-reviewer.md`](../assets/brief-frame-reviewer.md), [`assets/brief-critic.md`](../assets/brief-critic.md), [`assets/brief-actor.md`](../assets/brief-actor.md), and [`assets/brief-judge.md`](../assets/brief-judge.md) into `engines/`, customize them for your project, and **commit** them.
4. **Purpose** — Write your phase requirements verbatim into `purpose/P-0001.md`.

Stage your initial records, generate `INDEX.md`, and commit explicitly:

```bash
cd /path/to/my-project/.self-loop
git add README.md records.json loop.json purpose/P-0001.md engines/
node ~/tools/self-loop/scripts/records-check.mjs --repo . --write
git add INDEX.md
git commit -m "Initialize self-loop records for phase v1"
```

## Connecting Harness Hooks

`self-loop` scripts and Git hooks work without any harness integration. To add earlier guardrails (blocking direct lead edits to product code, blocking raw `git push`, capturing owner prompts verbatim, and injecting `start` output on session start):

### Antigravity

```bash
cd /path/to/my-project
node ~/tools/self-loop/scripts/self-loop.mjs hooks install --harness antigravity --dry-run
node ~/tools/self-loop/scripts/self-loop.mjs hooks install --harness antigravity
node ~/tools/self-loop/scripts/self-loop.mjs hooks check --harness antigravity
```

This writes `.agents/hooks.json` in the product workspace and adds `/.agents/hooks.json` to `.git/info/exclude` so your repository stays clean.

### Claude Code and Codex

- **Claude Code**: Configure `UserPromptSubmit`, `PreToolUse`, and `Stop` hooks in `.claude/settings.local.json` (complete JSON snippet in [`docs/harnesses.md`](harnesses.md#claude-code-harness)).
- **Codex**: Run `owner-words.mjs sync` to ingest session transcripts into `owner/words.jsonl` (see [`docs/harnesses.md`](harnesses.md#codex-harness)).

## Running Your First Round

### Step 1: Check session entry status

Always start a session with `self-loop.mjs start` (read-only):

```bash
cd /path/to/my-project
node ~/tools/self-loop/scripts/self-loop.mjs start
```

It reports any stalled registered products, live host load against capacity bounds, and the exact next commands for the current product.

### Step 2: Run the Phase Frame (`reviewer-frame`)

Adversarial calls (`critic`, `actor`, `judge`) are refused until the phase has a committed `reviewer-frame` hand-off. Write a task file (include `features: none` when creating the initial blueprint) and invoke the frame reviewer:

```bash
# Direct CLI (runner: "claude")
node ~/tools/self-loop/scripts/call.mjs .self-loop/loop.json reviewer \
  --round 1 --step reviewer-frame --task /tmp/r1-frame-task.md

# Or as a confined T3 child (runner: "t3", provider: "antigravity" | "claude")
node ~/tools/self-loop/scripts/call.mjs .self-loop/loop.json reviewer \
  --round 1 --step reviewer-frame --task /tmp/r1-frame-task.md --prepare
# Start the T3 child with t3-prompt.md verbatim, then record:
node ~/tools/self-loop/scripts/call.mjs .self-loop/loop.json record \
  --ws <prepared-workspace> --session <provider-session-id>
```

From the reviewer's report:
1. Create `blueprint/F-0001.md` (and any additional features) in `.self-loop/` and set initial statuses with `blueprint.mjs set`.
2. If the reviewer produced `out/decisions.json`, validate and publish an owner batch:
   ```bash
   node ~/tools/self-loop/scripts/decisions.mjs validate <evidence-decisions.json>
   node ~/tools/self-loop/scripts/decisions.mjs send \
     --records .self-loop --file <evidence-decisions.json> \
     --phase v1 --from R-0001-reviewer-frame
   ```
   Once the owner responds, record their exact words verbatim:
   ```bash
   node ~/tools/self-loop/scripts/decisions.mjs answer \
     --records .self-loop --batch B-0001 --words "as recommended" --outcome as-recommended
   ```
3. Regenerate `INDEX.md` and `BLUEPRINT.md` with `records-check.mjs --repo .self-loop --write` and commit explicitly.

### Step 3: Run Critic → Actor → Judge

Each task file must include a `features: F-0001, ...` line matching committed blueprint IDs.

**Direct CLI runners (`claude` / `codex`):**

```bash
node ~/tools/self-loop/scripts/call.mjs .self-loop/loop.json critic --round 1 --task /tmp/r1-critic.md
node ~/tools/self-loop/scripts/call.mjs .self-loop/loop.json actor  --round 1 --task /tmp/r1-actor.md
node ~/tools/self-loop/scripts/call.mjs .self-loop/loop.json judge  --round 1 --task /tmp/r1-judge.md
```

**T3 child threads (`runner: "t3"` with `provider: "codex" | "claude" | "antigravity"`):**

```bash
# 1. Prepare workspace, detached worktree, and nonce-bound prompt
node ~/tools/self-loop/scripts/call.mjs .self-loop/loop.json actor \
  --round 1 --task /tmp/r1-actor.md --prepare

# 2. Launch the T3 child with the exact printed prompt (t3-prompt.md)

# 3. After the child finishes, audit its transcript and commit the hand-off
node ~/tools/self-loop/scripts/call.mjs .self-loop/loop.json record \
  --ws <prepared-workspace> --session <provider-session-id>
```

`call.mjs` exit codes: `0` recorded, `1` call failed (evidence committed, no hand-off), `6` certain access violation, `7` refused by records/alarm/comment rules (no model called), `64` usage error.

### Step 4: Verify Suite, Push Through Gate, and Record Trajectory

Before pushing any branch, run the full test suite in a clean detached worktree on the exact commit:

```bash
node ~/tools/self-loop/scripts/suite-green.mjs \
  --repo . --sha HEAD --command "npm test" \
  --out .self-loop/evidence/0001/suite-1

node ~/tools/self-loop/scripts/gated-push.mjs \
  --repo . --branch loop/v1 \
  --suite-receipt .self-loop/evidence/0001/suite-1.json
```

Then run `self-loop.mjs next`—it prints the exact `trajectory.mjs append` command for the unlogged judge ruling. Appending the row automatically reads live remote CI from your push destination and saves the CI receipt under `evidence/0001/`:

```bash
node ~/tools/self-loop/scripts/trajectory.mjs append \
  --file .self-loop/metrics/trajectory.jsonl \
  --round 1 --phase v1 --role judge --area core \
  --verdict CONTINUE --suite 42/0 --commit <40-char-ruled-sha>

node ~/tools/self-loop/scripts/trajectory.mjs alarms \
  --file .self-loop/metrics/trajectory.jsonl
```

If any supervision alarm fires, `call.mjs` will refuse further adversarial calls until you run a `reviewer --step reviewer-diagnosis` call naming the alarm keys on an `alarms:` line in its task.

### Step 5: Optional Hourly Heartbeat

To watch all registered products for stalls automatically (using macOS `launchd` or Linux `cron`), inspect and install the heartbeat from your detached `vX.Y.Z` release worktree:

```bash
node ~/tools/self-loop/scripts/self-loop.mjs heartbeat install --dry-run
node ~/tools/self-loop/scripts/self-loop.mjs heartbeat install
```

## Next Steps

- Understand the design philosophy and isolation boundaries in [`docs/architecture.md`](architecture.md).
- Configure Claude Code, Codex, and Antigravity in [`docs/harnesses.md`](harnesses.md).
- Configure GitHub Actions or AWS CodeBuild CI gates in [`docs/forges-and-ci.md`](forges-and-ci.md).
- Review the full runtime contract in [`SKILL.md`](../SKILL.md).
