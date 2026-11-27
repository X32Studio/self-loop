# Harnesses

`self-loop` is **harness-independent by design**: every core gate (`call.mjs`, `suite-green.mjs`, `ci-green.mjs`, `gated-push.mjs`, `version-gate.mjs`, `records-check.mjs`, `self-loop.mjs`) is a plain Node.js process that runs under any agent harness, IDE, or terminal.

Harness adapters add earlier interception and lower friction: injecting `start` output at session start, capturing owner messages verbatim, preventing the Lead from directly editing product code or bypassing `gated-push.mjs`, and verifying cross-vendor independence from native session transcripts.

## Harness Support Matrix

| Capability | Claude Code | Codex | Antigravity (`F-0009`) |
|---|---|---|---|
| **Direct CLI runner** (`call.mjs`) | `runner: "claude"` (`--restricted --strict-mcp-config`) | `runner: "codex"` (`codex exec --json`) | Planned (Batch 2); use T3 runner today |
| **T3 child runner** (`call.mjs --prepare` / `record`) | `runner: "t3", provider: "claude"` (`sessionId`) | `runner: "t3", provider: "codex"` (`session_meta.payload.id`) | `runner: "t3", provider: "antigravity"` (`conversationId`, requires untruncated `transcript_full.jsonl`) |
| **Frame Reviewer confinement** | **Supported** (`claude` CLI `--restricted` by construction; `t3:claude` by fail-closed confined audit) | Refused (CLI sandbox confines writes, not reads; `t3:codex` uses shell `command_execution`) | **Supported via `t3:antigravity`** (fail-closed confined audit on untruncated `transcript_full.jsonl`) |
| **Lifecycle hooks** | `.claude/settings.local.json` (`UserPromptSubmit`, `PreToolUse`, `Stop`) | None required (landing gates + transcript sync) | `self-loop.mjs hooks install\|check\|uninstall --harness antigravity` (`SessionStart`, `PreInvocation`, `PreToolUse`, `Stop`) |
| **Owner-words transcript sync** | `owner-words.mjs capture` + `sync` | `owner-words.mjs sync` | `owner-words.mjs capture` + `sync` (fail-closed tail-anchored envelope unwrapping) |
| **Structured access audit** | `audit-access.mjs` (`tool_use` / `tool_result`) | `audit-access.mjs` (`command_execution` / `file_change`) | `audit-access.mjs` (`PLANNER_RESPONSE.tool_calls` + `GENERIC` pairing, universal path & `file://` screening, delegation tool blocking) |

---

## Antigravity Harness (`F-0009`)

Antigravity is supported end-to-end for Lead lifecycle hooks, verbatim owner-word capture/sync, T3 child role execution, structured access auditing, and multi-vendor independence checks.

### Installing, Checking, and Uninstalling Hooks

`scripts/lib/hooks.mjs` manages Antigravity hooks through `self-loop.mjs hooks` using the template in [`assets/antigravity/hooks.json`](../assets/antigravity/hooks.json):

```bash
# Preview changes without writing
node scripts/self-loop.mjs hooks install --harness antigravity --dry-run

# Workspace install (default): writes <product>/.agents/hooks.json
# and adds /.agents/hooks.json to .git/info/exclude so Git status stays clean
node scripts/self-loop.mjs hooks install --harness antigravity

# Global install: writes ${GEMINI_HOME:-~/.gemini}/config/hooks.json
node scripts/self-loop.mjs hooks install --harness antigravity --scope global --config <loop.json>

# Verify hook health, script paths, git exclusion, T3 instances, version pin, and skill discovery
node scripts/self-loop.mjs hooks check --harness antigravity

# Remove the "self-loop" hook entry cleanly (preserves other user hooks and sibling worktrees)
node scripts/self-loop.mjs hooks uninstall --harness antigravity
```

**Supported flags:**

| Flag | Description |
|---|---|
| `--harness antigravity` | Required. Harness adapter name. |
| `--scope workspace\|global` | Default `workspace` (`<product>/.agents/hooks.json`). `global` targets `${GEMINI_HOME:-~/.gemini}/config/hooks.json`. |
| `--target <hooks.json>` | Explicit path override (bypasses `--scope` path resolution). |
| `--config <loop.json>` | Explicit loop configuration (otherwise resolved via `SELF_LOOP_CONFIG` or registered workspace). |
| `--owner-store <dir>` | Owner store directory override. |
| `--release <dir>` | Pin hook commands to a specific plain `vX.Y.Z` release worktree's `scripts/`. |
| `--dry-run` | Print planned JSON and `.git/info/exclude` changes without modifying files. |
| `--json` | Emit machine-readable JSON output. |

**Safety invariants of `hooks install|check|uninstall`:**
- Refuses (exit `2`) to overwrite a workspace `hooks.json` that is tracked by Git; merges only the `"self-loop"` top-level key and leaves other user hooks untouched.
- `hooks check` (exit `0` healthy, `2` unhealthy) validates all four event handlers, verifies each script exists on disk, checks `.git/info/exclude` coverage, inspects any T3 Antigravity provider instances under `${T3CODE_HOME:-~/.t3}/userdata/providers/antigravity/*`, warns if `ANTIGRAVITY_LS_VERSION` drifts from the verified runtime (`cli-1.5.14`), and checks workspace/global `self-loop/SKILL.md` discovery.
- `self-loop.mjs start` surfaces non-blocking hook health findings automatically when Antigravity hooks are unhealthy or a T3 Antigravity instance is missing `"self-loop"`.

### Antigravity Hook Events & Protocols

All four handlers emit pure JSON on `stdout` (diagnostics only on `stderr`), resolve workspace directories strictly from stdin (`input.cwd ?? input.workspacePaths?.[0]` — never `process.cwd()`), and skip delegated child sessions (`T3CODE_THREAD_ID`, `parentConversationId`, or child transcript first-prompt markers):

1. **`SessionStart`** → `self-loop.mjs start --hook antigravity`
   Injects the read-only `start` report via `{"injectSteps":[{"systemMessage":{"systemMessage":"..."}}]}` (or `{}` for child sessions / missing workspace).
2. **`PreInvocation`** → `owner-words.mjs capture --harness antigravity --records <records> --project <projects>`
   Uses an `invocationNum > 0` fast path (zero transcript or SQLite reads unless a pending capture exists), unwraps `<USER_REQUEST>` / `<t3_code_instructions>` / `<user_request>` envelopes fail-closed via tail-anchored parsing, confirms against `transcript_full.jsonl` anchored by `step_index`, and queues an idempotent pending capture if the transcript has not flushed yet.
3. **`PreToolUse`** (`matcher: "*"`) → `lead-guard.mjs --harness antigravity --product <product> --workspaces <workspaces>`
   Denies tracked/unignored product edits outside `--allow` (default `docs/,AGENTS.md,CLAUDE.md,README.md`) and workspaces, and denies direct `git push` commands via `{"decision":"deny","reason":"lead-guard: ..."}`. On allowed calls, emits the verified least-privilege pass-through (empty stdout + exit `0`) — **never** blanket `{"decision":"allow"}` — so the user's own approval policy stays intact.
4. **`Stop`** → `word-gate.mjs --harness antigravity --records <records> --project <projects>`
   Emits `{"decision":"continue","reason":"..."}` when the session has unsettled owner words or pending captures, bounded per item by `--max-blocks` (default `3`, keyed on `conversationId`). Immediately short-circuits to `{}` when `continuationActive === true`, `fullyIdle === false`, or `terminationReason` is present and not `"NO_TOOL_CALL"`.

### Running Antigravity Roles as T3 Child Threads

Configure `reviewer`, `critic`, `actor`, or `judge` in `loop.json` with:

```json
"actor": { "runner": "t3", "provider": "antigravity", "model": "gemini-2.5-pro", "effort": "high" }
```

Run `--prepare`, start the T3 child with `t3-prompt.md` verbatim, and record using the child's `conversationId`:

```bash
node scripts/call.mjs <loop.json> actor --round 1 --task <task.md> --prepare
node scripts/call.mjs <loop.json> record --ws <prepared-ws> --session <conversationId>
```

**Fail-closed transcript and audit rules (`scripts/lib/antigravity.mjs`, `scripts/lib/t3-child.mjs`, `scripts/audit-access.mjs`):**
- Always resolves sibling `transcript_full.jsonl` when given compact `transcript.jsonl`. `call.mjs record` **refuses (exit `7`)** if the resolved file is not `transcript_full.jsonl` or if any step carries a non-empty `truncated_fields` array.
- Audits every `PLANNER_RESPONSE.tool_calls` entry across all scalar path keys, `paths[]`, and embedded `file://` URLs.
- Blocks native delegation/spawn tools (`invoke_subagent`, `run_workflow`, `define_subagent`, `swarm`, `send_message`, `browser_subagent`) and every non-read-only T3 MCP tool as access violations in role audits.
- Credits a denied tool call only when the step's `GENERIC` result count strictly equals `tool_calls.length` with a following turn step and `status === "ERROR"` (`CANCELED` and `RUNNING` count as executed).

---

## Claude Code Harness

### Role Execution

- **Direct CLI (`runner: "claude"`)**: Runs `claude -p --restricted --strict-mcp-config --permission-mode acceptEdits --output-format stream-json --verbose`.
  - For `reviewer`, passes `--tools Read,Write,Edit,Glob,Grep` (no `Bash`) with `cwd` pinned to the role workspace — confined by construction.
  - For `critic`, `actor`, and `judge`, adds `Bash` and `--add-dir` for the workspace (plus `sealed` roots for `judge`).
- **T3 child (`runner: "t3", provider: "claude"`)**: Valid for `reviewer` (confined mode: no product worktree, file tools only inside `[ws]`, fail-closed audit), `critic`, `actor`, and `judge`. Bind `--session` to `sessionId` from the child's first user entry under `${CLAUDE_CONFIG_DIR:-~/.claude}/projects/`.

### Lead Hooks (`.claude/settings.local.json`)

Add `UserPromptSubmit`, `PreToolUse`, and optionally `Stop` under `hooks` using absolute paths:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node '/abs/self-loop/scripts/owner-words.mjs' capture --records '/abs/records' --project '/abs/product'"
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Edit|Write|MultiEdit|NotebookEdit|Bash",
        "hooks": [
          {
            "type": "command",
            "command": "node '/abs/self-loop/scripts/lead-guard.mjs' --product '/abs/product' --workspaces '/abs/workspaces'"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node '/abs/self-loop/scripts/word-gate.mjs' --records '/abs/records' --project '/abs/product'"
          }
        ]
      }
    ]
  }
}
```

Pass comma-separated paths to `--project` if the lead works across multiple checkouts of the same product.

---

## Codex Harness

### Role Execution

- **Direct CLI (`runner: "codex"`)**: Runs `codex exec --json --skip-git-repo-check -C <cwd> -c sandbox_mode="<mode>"`.
  - `sandbox` defaults to `"workspace-write"`. Set `"sandbox": "danger-full-access"` in `loop.json` when a role must run real product tests that open listening sockets or access host resources.
  - Refused for `reviewer` because Codex's sandbox confines writes, not reads.
- **T3 child (`runner: "t3", provider: "codex"`)**: Valid for `critic`, `actor`, and `judge` (refused for `reviewer` because Codex transcripts use shell `command_execution` rather than structured file-only tools). Bind `--session` to `session_meta.payload.id` from `${CODEX_HOME:-~/.codex}/sessions/YYYY/MM/DD/rollout-*.jsonl` (or `archived_sessions/`).

### Transcript Sync

Codex requires no lifecycle hooks. Run `owner-words.mjs sync` to ingest owner prompts from Codex rollouts into `owner/words.jsonl`:

```bash
node scripts/owner-words.mjs sync --records <records> --project <product>[,<other-checkout>]
```

---

## Owner-Words Capture, Sync, and Settlement

Every owner message in a tracked project session is recorded verbatim in `owner/words.jsonl` with a deterministic `W-<10-hex>` ID (guaranteed identical between live hook capture and offline `sync`).

```bash
# Ingest all unrecorded owner words from Claude Code, Codex, and Antigravity transcripts
node scripts/owner-words.mjs sync --records <records> --project <dir>[,<dir>...]

# List unsettled owner words (exit 0 when empty, exit 2 while open words remain)
node scripts/owner-words.mjs open --records <records> [--json]

# Classify a word in owner/word-marks.jsonl
node scripts/owner-words.mjs mark --records <records> --id W-xxxxxxxxxx --as direction --intervention I-0001 [--note "<why>"]
node scripts/owner-words.mjs mark --records <records> --id W-xxxxxxxxxx --as answer --batch B-0001 [--note "<why>"]
node scripts/owner-words.mjs mark --records <records> --id W-xxxxxxxxxx --as routine --note "<why>"
node scripts/owner-words.mjs mark --records <records> --id W-xxxxxxxxxx --as not-owner --note "<why>"

# Archive an unresolved pending hook capture
node scripts/owner-words.mjs pending --records <records> --discard <key> --note "<why>"

# Compute phase owner-attention metrics (directions, raised-first share, precision, waiting time)
node scripts/owner-words.mjs metrics --records <records> [--phase <phase>] [--json]
```

**Settlement rules:**
- A phase does **not** converge while `owner-words.mjs open` exits `2`.
- Marking a word `answer`, `routine`, or `not-owner` settles it immediately.
- Marking a word `direction` keeps it **open** until its linked `interventions/I-NNNN.md` is committed.
- If `sync` encounters an unreadable Antigravity summary DB or skipped Antigravity session, it reports `{ antigravity: { skipped, reason } }` and exits `1` so skips are never silent.

---

## Cross-Vendor & Model Independence Rules

Convergence requires the phase's Judge and Actor to use **different vendors and different models** (`scripts/lib/vendor.mjs`, consumed by `scripts/loop.mjs`):

| Model Prefix (case-insensitive) | Resolved Vendor |
|---|---|
| `claude*` | `anthropic` |
| `gpt-*`, `o<digit>*`, `codex*` | `openai` |
| `gemini*` | `google` |
| Any other / empty | `null` (unknown) |

- **Single-vendor runners (`claude`, `codex`)**: Prefer observed transcript models (`observedModels` / `observedModel`), falling back to configured `model` and finally runner vendor (`claude` → `anthropic`, `codex` → `openai`).
- **Multi-vendor runners (`antigravity` or any hand-off carrying `observedModels[]`)**: Resolve **strictly** from `observedModels` in the authoritative transcript.
  - Empty `observedModels` → `null` (fails closed).
  - Any unknown model prefix → `null` (fails closed).
  - Mid-conversation switch across two vendors (e.g., `gemini-*` and `claude-*` in one session) → `null` (fails closed).
  - `independenceModel()` likewise requires exactly one observed model for Antigravity hand-offs.

When either vendor or model resolves to `null`, or when Judge and Actor share a vendor or model, `self-loop.mjs next` withholds convergence and names the independence failure.
