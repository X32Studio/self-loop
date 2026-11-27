// F-0008, D-0060, D-0066, D-0068, design/mandatory-control-plane.md#5
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
  antigravityAppDirs,
  antigravityFirstPrompt,
  antigravityStatus,
  appDirFromTranscriptPath,
  conversationIdFromPath,
  readConversationSummaries,
  resolveAuthoritativeTranscript,
} from "./antigravity.mjs";
import { ARCH_STEP } from "./cadence.mjs";
import { git, gitOk } from "./git-plumbing.mjs";
import { HANDOFFS, recordOf, ROLES } from "./handoff.mjs";
import { resolveAdapter, unwrapPaseoAgentMessage } from "./paseo.mjs";
import { canonical } from "./path-canonical.mjs";

const EXIT = { failure: 1, records: 7, usage: 64 };
const TRAJECTORY = "metrics/trajectory.jsonl";
const stop = (code, message) => Object.assign(new Error(message), { code });
const digest = text => createHash("sha256").update(text).digest("hex");

export const preparationFile = (cfg, ws) => join(cfg.workDir, ".prepared", `${basename(ws)}.json`);
export const preparationScope = cfg => [canonical(cfg.records), canonical(cfg.product), cfg.phase, ...cfg.sealed.map(canonical)];
const commonDir = repo => canonical(git(repo, "rev-parse", "--path-format=absolute", "--git-common-dir"));
const hasReviewerWorkspace = ws => existsSync(join(ws, "purpose")) && existsSync(join(ws, "records")) && existsSync(join(ws, "out"));

export function preparedPhase(ctx, ws) {
  if (ctx.phase) return ctx.phase;
  const prompt = join(ws, "prompt.md");
  return existsSync(prompt) ? /, phase (.+?)\. Your working folder is /m.exec(readFileSync(prompt, "utf8"))?.[1] ?? null : null;
}

const codexHome = () => process.env.CODEX_HOME || join(homedir(), ".codex");
const claudeHome = () => process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
const lines = file => readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } });
const textOf = content => typeof content === "string" ? content : Array.isArray(content) ? content.map(p => p?.text ?? "").join("\n") : "";

const injected = /^(?:<environment_context>|# AGENTS\.md instructions\b|<user_instructions>|<permissions instructions>)/;
const codexMeta = rows => rows.find(r => r.type === "session_meta")?.payload ?? {};
const codexSession = rows => codexMeta(rows).id ?? codexMeta(rows).session_id ?? null;
const claudeSession = rows => rows.find(r => r.type === "user" && r.sessionId)?.sessionId ?? null;

function codexFirstPrompt(rows) {
  for (const r of rows) {
    const p = r.type === "event_msg" || r.type === "response_item" ? r.payload : null;
    if (p?.type === "user_message" && typeof p.message === "string") return p.message;
    if (p?.type !== "message" || p.role !== "user") continue;
    const text = textOf(p.content);
    if (!injected.test(text)) return text;
  }
  return "";
}

const claudePrompt = r => r.type === "user" && !r.toolUseResult && !r.isMeta && !r.isCompactSummary
  && !r.isSidechain && r.promptSource !== "system" && (typeof r.message?.content === "string"
    || Array.isArray(r.message?.content) && r.message.content.some(p => p?.type === "text"));
const claudeFirstPrompt = rows => textOf(rows.find(claudePrompt)?.message?.content);
const recent = (dir, since) => (existsSync(dir) ? readdirSync(dir).filter(n => n.endsWith(".jsonl")).map(n => join(dir, n)).filter(f => statSync(f).mtimeMs >= since) : []);

const providerNameOf = runnerOrAgent => (runnerOrAgent && typeof runnerOrAgent === "object" ? runnerOrAgent.provider : runnerOrAgent);

function candidateFiles(runnerOrAgent, since) {
  const kind = resolveAdapter(runnerOrAgent);
  since -= 2_000;
  if (kind === "claude") {
    const projects = join(claudeHome(), "projects");
    return existsSync(projects) ? readdirSync(projects, { withFileTypes: true }).filter(p => p.isDirectory())
      .flatMap(p => recent(join(projects, p.name), since)) : [];
  }
  if (kind === "antigravity") {
    const files = [];
    for (const appDir of antigravityAppDirs()) {
      const brain = join(appDir, "brain");
      let dirs;
      try { dirs = readdirSync(brain, { withFileTypes: true }); } catch { continue; }
      for (const d of dirs) {
        if (!d.isDirectory()) continue;
        const logs = join(brain, d.name, ".system_generated", "logs");
        const full = join(logs, "transcript_full.jsonl");
        const compact = join(logs, "transcript.jsonl");
        const file = existsSync(full) ? full : existsSync(compact) ? compact : null;
        if (!file) continue;
        try { if (statSync(file).mtimeMs >= since) files.push(file); } catch {}
      }
    }
    return files;
  }
  if (kind !== "codex") return [];
  const files = recent(join(codexHome(), "archived_sessions"), since);
  const day = 86_400_000;
  for (let t = since - day; t <= Date.now() + day; t += day) {
    const d = new Date(t);
    const dir = join(codexHome(), "sessions", String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0"));
    files.push(...recent(dir, since));
  }
  return files;
}

export function findTranscripts(runnerOrAgent, nonce, since, session = null) {
  const provider = providerNameOf(runnerOrAgent);
  const kind = resolveAdapter(runnerOrAgent);
  if (!kind || kind === "generic") return [];
  const first = kind === "codex" ? codexFirstPrompt : kind === "antigravity" ? antigravityFirstPrompt : claudeFirstPrompt;
  const identity = kind === "codex" ? codexSession : kind === "antigravity" ? ((_rows, file) => conversationIdFromPath(file)) : claudeSession;
  return [...new Set(candidateFiles(kind, since))].flatMap(file => {
    const rows = lines(file), nativeId = identity(rows, file);
    return (!session || session === nativeId) && first(rows).includes(nonce) ? [{ runner: provider, adapter: kind, file, session: nativeId }] : [];
  });
}

// D-0060, D-0068, design/mandatory-control-plane.md#5
export function resolveChildSession(runnerOrAgent, nonce, since, explicitSession = null, explicitTranscript = null) {
  const provider = providerNameOf(runnerOrAgent);
  const kind = resolveAdapter(runnerOrAgent);
  if (explicitTranscript) return { runner: provider, adapter: kind, file: resolve(explicitTranscript), session: explicitSession || null };
  if (kind === "generic") {
    throw stop(EXIT.failure, `provider ${provider} uses the generic adapter and does not auto-discover transcripts; pass --transcript <file> (and --session <id> if not recorded in the transcript)`);
  }
  const matches = findTranscripts(runnerOrAgent, nonce, since, explicitSession || null);
  if (matches.length === 1) return matches[0];
  throw stop(EXIT.failure, matches.length
    ? `${matches.length} transcripts hold nonce ${nonce} (${matches.map(f => `${f.file} [${f.session}]`).join(", ")}); pass --session and, if needed, --transcript`
    : `no transcript holds nonce ${nonce} for the prepared ${provider} child; check the provider session ID`);
}

function claudeStatus(rows) {
  let complete = false;
  for (const r of rows) {
    if (r.type === "user" && r.promptSource !== "sdk" && /^\[Request interrupted by user(?: for tool use)?\]$/.test(textOf(r.message?.content)))
      return "failed";
    if (r.type === "result" && (r.is_error || r.subtype?.startsWith("error"))) return "failed";
    if (claudePrompt(r)) complete = false;
    if (r.type === "result" && r.subtype === "success" || r.type === "assistant" && r.message?.stop_reason === "end_turn") complete = true;
  }
  return complete ? "complete" : "pending";
}

function codexStatus(rows) {
  let turn = null, complete = false;
  for (const { type, payload: p } of rows) {
    if (type !== "event_msg" || !p || p.root_turn_id && p.turn_id && p.root_turn_id !== p.turn_id) continue;
    if (p.type === "task_started") { turn = p.turn_id ?? null; complete = false; }
    if (turn && p.turn_id && turn !== p.turn_id) continue;
    if (["turn_aborted", "task_failed", "turn_failed"].includes(p.type)) return "failed";
    if (p.type === "task_complete") complete = true;
  }
  return complete ? "complete" : "pending";
}

function codexTools(rows) {
  const calls = new Map(), outputs = new Map(), completedCommands = [], fileEvents = [], unknown = [];
  for (const r of rows) {
    const p = r.payload;
    if (r.type === "event_msg" && p?.type === "item_completed" && p.item?.type === "FileChange") {
      fileEvents.push({ type: "item.completed", item: { ...p.item, type: "file_change" } });
    }
    if (r.type === "event_msg" && p?.type === "item_completed" && p.item?.type === "CommandExecution") {
      const argv = p.item.command;
      const command = Array.isArray(argv)
        ? (argv.length >= 3 && /^-l?c$/.test(argv.at(-2)) ? argv.at(-1) : argv.join(" "))
        : argv;
      if (typeof command === "string" && command.trim()) completedCommands.push({ command, exit: p.item.exit_code, call: p.item.call_id ?? p.item.id });
      else unknown.push(p.item.id);
    }
    if (r.type !== "response_item" || !p) continue;
    if (p.type === "function_call" || p.type === "custom_tool_call") {
      if (!p.call_id || calls.has(p.call_id)) unknown.push(p.call_id);
      else calls.set(p.call_id, p);
    }
    if (p.type === "function_call_output" || p.type === "custom_tool_call_output") {
      if (!p.call_id || outputs.has(p.call_id)) unknown.push(p.call_id);
      else outputs.set(p.call_id, p.output);
    }
  }
  const execution = ({ command, call, exit }) => ({ type: "item.completed", item: { type: "command_execution", command, id: call, exit_code: exit ?? null } });
  const events = [...completedCommands.map(execution), ...fileEvents];
  const counted = new Set(completedCommands.map(item => item.call));
  for (const [id, call] of calls) {
    if (counted.has(id)) continue;
    if (outputs.has(id) && (call.name === "wait"
        || call.name === "exec" && call.type === "custom_tool_call" && typeof call.input === "string")) continue;
    let args;
    if (call.type === "function_call") {
      try { args = JSON.parse(call.arguments); } catch {}
    }
    const command = args?.cmd ?? args?.command;
    if (["exec_command", "shell_command", "shell"].includes(call.name) && typeof command === "string" && command.trim()) {
      events.push(execution({ command, call: id, exit: outputs.get(id)?.exit_code }));
      if (!outputs.has(id)) unknown.push(id);
    } else unknown.push(id);
  }
  for (const id of outputs.keys()) if (!calls.has(id) && !counted.has(id)) unknown.push(id);
  return events.concat(unknown.map(call_id => ({ type: "unparsed_tool_call", call_id: call_id ?? null })));
}

const distinctModels = list => [...new Set(list.filter(m => typeof m === "string" && m.trim()).map(m => m.trim()))];

function genericSession(rows) {
  for (const r of rows) {
    for (const cand of [r?.sessionId, r?.session_id, r?.session, r?.conversationId, r?.threadId, r?.payload?.id, r?.payload?.session_id]) {
      if (typeof cand === "string" && cand.trim()) return cand.trim();
    }
  }
  return null;
}

function genericFirstPrompt(rows, text) {
  for (const r of rows) {
    const role = r?.role ?? r?.message?.role ?? r?.payload?.role;
    const type = r?.type ?? r?.payload?.type;
    const isUser = role === "user" || type === "user" || type === "user_message" || type === "USER_INPUT";
    if (!isUser) continue;
    const raw = textOf(r?.content ?? r?.message?.content ?? r?.text ?? r?.prompt ?? r?.payload?.message ?? r?.payload?.content);
    if (!raw.trim()) continue;
    const unwrapped = unwrapPaseoAgentMessage(raw);
    return unwrapped ? unwrapped.body : raw;
  }
  return text;
}

function genericStatus(rows, text) {
  if (!rows.length) return text.trim() ? "complete" : "pending";
  let complete = false;
  let sawPending = false;
  for (const r of rows) {
    const type = r?.type ?? r?.payload?.type;
    const status = r?.status ?? r?.payload?.status;
    if (r?.is_error === true || type === "error" || type === "turn_aborted" || type === "task_failed" || type === "turn_failed"
      || status === "failed" || status === "error" || status === "aborted") return "failed";
    if (status === "complete" || status === "completed" || status === "done" || status === "DONE" || type === "result" || type === "task_complete") {
      complete = true;
    } else if (status === "pending" || status === "running" || status === "in_progress") {
      sawPending = true;
      complete = false;
    }
  }
  return complete || !sawPending ? "complete" : "pending";
}

export function transcriptEvents(id, { runner, file, adapter = null, session: explicitSession = null }) {
  const kind = adapter ? resolveAdapter({ adapter }) : resolveAdapter(runner);
  const actualFile = kind === "antigravity" ? resolveAuthoritativeTranscript(file) : file;
  const text = readFileSync(actualFile, "utf8"), rows = lines(actualFile);
  const times = rows.map(r => Date.parse(r.timestamp ?? r.created_at ?? "")).filter(Number.isFinite);
  const seconds = times.length ? Math.round((Math.max(...times) - Math.min(...times)) / 100) / 10 : null;
  if (kind === "antigravity") {
    const session = conversationIdFromPath(actualFile);
    const nonAuthoritative = basename(actualFile) !== "transcript_full.jsonl";
    const truncated = rows.some(r => Array.isArray(r.truncated_fields) && r.truncated_fields.length > 0);
    if (nonAuthoritative || truncated) {
      return {
        nonAuthoritative, truncated,
        refusalReason: "Antigravity child record requires an untruncated transcript_full.jsonl",
        events: [], session, forked: false, status: "failed", firstPrompt: "",
        observedModel: null, observedModels: [], seconds, cwd: null, text,
      };
    }
    const appDir = appDirFromTranscriptPath(actualFile);
    const db = appDir ? readConversationSummaries(appDir) : { state: "unavailable" };
    const summary = db.state === "ok" && session ? (db.rows.get(session) ?? null) : null;
    const firstPrompt = antigravityFirstPrompt(rows);
    const forked = Boolean(summary?.parent_conversation_id)
      || (summary?.nesting_depth ?? 0) > 0
      || /^Context handoff \([a-z_]+\):/.test(firstPrompt.trimStart());
    const observedModels = distinctModels(rows.map(r => (r?.type === "PLANNER_RESPONSE" ? r.model : null)));
    return {
      events: rows.map(event => ({ id, event })), session, forked, status: antigravityStatus(rows, summary),
      firstPrompt, observedModel: observedModels[0] ?? null, observedModels, seconds, cwd: summary?.workspaces?.[0] ?? null, text,
    };
  }
  if (kind === "claude") {
    const session = claudeSession(rows);
    const events = rows.filter(r => r.type === "assistant" || r.type === "user").map(event => ({ id, event }));
    const observedModels = distinctModels(rows.map(r => (r?.type === "assistant" ? r.message?.model : r?.type === "system" ? r.model : null)));
    return { events, session, forked: rows.some(r => r.sessionId && r.sessionId !== session), status: claudeStatus(rows),
      firstPrompt: claudeFirstPrompt(rows), observedModel: observedModels[0] ?? null, ...(observedModels.length ? { observedModels } : {}),
      seconds, cwd: rows.find(r => typeof r.cwd === "string")?.cwd ?? null, text };
  }
  if (kind === "codex") {
    const meta = codexMeta(rows);
    const observedModels = distinctModels(rows.map(r => (r?.type === "turn_context" ? r.payload?.model : null)));
    return { events: codexTools(rows).map(event => ({ id, event })), session: codexSession(rows), forked: Boolean(meta.forked_from_id),
      status: codexStatus(rows), firstPrompt: codexFirstPrompt(rows), observedModel: observedModels[0] ?? null,
      ...(observedModels.length ? { observedModels } : {}), seconds, cwd: meta.cwd ?? null, text };
  }
  const session = genericSession(rows) ?? (typeof explicitSession === "string" && explicitSession.trim() ? explicitSession.trim() : null);
  const observedModels = distinctModels(rows.flatMap(r => [r?.model, r?.message?.model, r?.payload?.model]));
  const cwdRow = rows.find(r => typeof r?.cwd === "string" || typeof r?.payload?.cwd === "string");
  return {
    events: [],
    session,
    forked: rows.some(r => Boolean(r?.forked_from_id || r?.payload?.forked_from_id || r?.parent_conversation_id)),
    status: genericStatus(rows, text),
    firstPrompt: genericFirstPrompt(rows, text),
    observedModel: observedModels[0] ?? null,
    ...(observedModels.length ? { observedModels } : {}),
    seconds,
    cwd: typeof cwdRow?.cwd === "string" ? cwdRow.cwd : (typeof cwdRow?.payload?.cwd === "string" ? cwdRow.payload.cwd : null),
    text,
  };
}

export function t3Prompt({ id, nonce, wt, ws, text, runner = "t3" }) {
  const childLabel = runner === "paseo" ? "Paseo child agent" : "T3 child thread";
  return [`self-loop call ${id} · nonce ${nonce}`, "",
    `You run as a ${childLabel} whose session starts in another directory. Work only in the folders below, by absolute path.`,
    `- Your working folder: ${ws} (brief-shared.md, brief.md, task.md, records/${wt ? "" : ", purpose/"}; write under ${ws}/out).`,
    wt
      ? `- The product worktree: ${wt}. Run every shell command as \`cd ${wt} && ...\`.`
      : `- Confined reviewer mode: use file tools only (no shell, web, delegation, or MCP tools) and stay strictly inside ${ws} (write only under ${ws}/out). Any disallowed tool call or path outside ${ws} fails the access audit.`,
    "- Do not commit, push, stash or switch branches: when you finish, the lead records your work from this folder and your transcript.",
    "", text].filter(line => line !== null).join("\n");
}

// D-0060, design/mandatory-control-plane.md#5
export function isStalePreparation(prep, currentMaxRound = null) {
  if (!prep || typeof prep !== "object") return true;
  if (prep.cancelled === true || prep.recorded === true) return true;
  if (Number.isSafeInteger(currentMaxRound) && Number.isSafeInteger(prep.round) && prep.round < currentMaxRound) {
    const pid = prep.pid;
    if (Number.isInteger(pid) && pid > 0) {
      try { process.kill(pid, 0); return false; } catch (e) { if (e.code === "EPERM") return false; }
    }
    return true;
  }
  return false;
}

function maxRecordedRound(cfg) {
  if (!cfg?.records || !existsSync(cfg.records)) return null;
  let max = 0;
  for (const rel of [HANDOFFS, TRAJECTORY]) {
    if (!gitOk(cfg.records, "cat-file", "-e", `HEAD:${rel}`)) continue;
    try {
      for (const line of git(cfg.records, "show", `HEAD:${rel}`).split("\n").filter(Boolean)) {
        const row = JSON.parse(line);
        if ((!cfg.phase || row.phase === cfg.phase) && Number.isSafeInteger(row.round) && row.round > max) max = row.round;
      }
    } catch {}
  }
  return max > 0 ? max : null;
}

export function readPreparation(cfg, ws) {
  const manifest = join(ws, "call.json");
  if (!existsSync(manifest)) throw stop(EXIT.usage, `${ws} holds no call.json: it was not prepared with --prepare`);
  const bytes = readFileSync(manifest, "utf8"), ctx = JSON.parse(bytes);
  if (ctx.cancelled === true) throw stop(EXIT.records, `${ws} was cancelled (${ctx.cancelReason ?? "no reason"}); prepare a new call`);
  const expected = readFileSync(join(ws, "t3-prompt.md"), "utf8");
  const task = readFileSync(join(ws, "task.md"), "utf8");
  const snapshot = preparationFile(cfg, ws);
  if (existsSync(snapshot)) {
    const saved = JSON.parse(readFileSync(snapshot, "utf8"));
    if (saved.manifest !== digest(bytes) || saved.task !== digest(task) || saved.prompt !== digest(expected)
      || JSON.stringify(saved.scope) !== JSON.stringify(preparationScope(cfg)))
      throw stop(EXIT.records, "the repositories, phase, or prepared files differ from the lead's preparation snapshot");
  } else if (ctx.version !== 1 || preparedPhase(ctx, ws) !== cfg.phase || task !== ctx.task
    || !gitOk(cfg.records, "cat-file", "-e", `${ctx.view}^{commit}`)) {
    throw stop(EXIT.records, "the call has no matching preparation snapshot");
  }
  if (ctx.ws !== ws) throw stop(EXIT.records, "the prepared workspace or worktree does not match call.json");
  if (ctx.role === "reviewer") {
    if (resolveAdapter(ctx.agent) === "codex") throw stop(EXIT.records, `the frame reviewer cannot run on ${ctx.agent?.runner ?? "t3"}:codex`);
    if (ARCH_STEP.test(ctx.step ?? "")) {
      if (ctx.wt !== join(ws, "wt")) throw stop(EXIT.records, "the prepared workspace or worktree does not match call.json");
      if (!existsSync(ctx.wt) || !hasReviewerWorkspace(ws)) throw stop(EXIT.failure, `the prepared workspace ${ws} is gone; prepare the call again`);
      if (commonDir(ctx.wt) !== commonDir(cfg.product)) throw stop(EXIT.records, "the prepared worktree belongs to a different product repository");
    } else {
      if (ctx.wt !== null) throw stop(EXIT.records, "the prepared workspace or worktree does not match call.json");
      if (!hasReviewerWorkspace(ws)) throw stop(EXIT.failure, `the prepared workspace ${ws} is gone; prepare the call again`);
    }
  } else {
    if (ctx.wt !== join(ws, "wt")) throw stop(EXIT.records, "the prepared workspace or worktree does not match call.json");
    if (!existsSync(ctx.wt)) throw stop(EXIT.failure, `the worktree ${ctx.wt} is gone; prepare the call again`);
    if (commonDir(ctx.wt) !== commonDir(cfg.product)) throw stop(EXIT.records, "the prepared worktree belongs to a different product repository");
  }
  ctx.phase = preparedPhase(ctx, ws);
  return { ctx, expected, binding: snapshot + ".session" };
}

export function preparedIn(cfg, { currentMaxRound = null, includeStale = false } = {}) {
  if (!existsSync(cfg.workDir)) return [];
  const maxRound = currentMaxRound ?? maxRecordedRound(cfg);
  const found = [];
  for (const entry of readdirSync(cfg.workDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const ws = join(cfg.workDir, entry.name);
    const file = join(ws, "call.json");
    if (!existsSync(file)) continue;
    const ctx = JSON.parse(readFileSync(file, "utf8"));
    if (![1, 2].includes(ctx.version) || ctx.ws !== ws || !ctx.nonce || !ROLES.includes(ctx.role) || !Number.isInteger(ctx.round)
        || !/^[a-z]+(-[a-z]+)*$/.test(ctx.step) || ctx.record !== recordOf(ctx.round, ctx.step))
      throw new Error(`${file} is not a supported prepared call`);
    const phase = preparedPhase(ctx, ws);
    const phaseMax = !cfg.phase || !phase || phase === cfg.phase ? maxRound : null;
    if (!includeStale && isStalePreparation(ctx, phaseMax)) continue;
    const liveWorkspace = ctx.role === "reviewer"
      ? (ARCH_STEP.test(ctx.step)
        ? ctx.wt === join(ws, "wt") && existsSync(ctx.wt) && hasReviewerWorkspace(ws)
        : ctx.wt === null && hasReviewerWorkspace(ws))
      : ctx.wt === join(ws, "wt") && existsSync(ctx.wt);
    found.push({ ...ctx, phase, ws, liveWorkspace });
  }
  return found.sort((a, b) => a.round - b.round || a.step.localeCompare(b.step) || a.ws.localeCompare(b.ws));
}

export function cancelPreparedCall({ ws, product, reason, now = () => new Date() }) {
  const wsDir = resolve(ws);
  const manifest = join(wsDir, "call.json");
  if (!existsSync(manifest)) throw stop(EXIT.usage, `${wsDir} holds no call.json: it was not prepared with --prepare`);
  if (typeof reason !== "string" || !reason.trim()) throw stop(EXIT.usage, "--reason must be a non-empty string");
  const ctx = JSON.parse(readFileSync(manifest, "utf8"));
  if (ctx.ws !== wsDir || !ctx.id || !ctx.nonce) throw stop(EXIT.records, `${manifest} does not match workspace ${wsDir}`);
  if (ctx.wt && existsSync(ctx.wt)) {
    spawnSync("git", ["-C", product, "worktree", "remove", "--force", ctx.wt], { stdio: "ignore" });
    if (existsSync(ctx.wt)) {
      rmSync(ctx.wt, { recursive: true, force: true });
      spawnSync("git", ["-C", product, "worktree", "prune"], { stdio: "ignore" });
    }
  }
  const updated = { ...ctx, cancelled: true, cancelledAt: now().toISOString(), cancelReason: reason.trim() };
  writeFileSync(manifest, `${JSON.stringify(updated, null, 1)}\n`);
  return { id: ctx.id, ws: wsDir, cancelled: true, cancelReason: updated.cancelReason };
}
