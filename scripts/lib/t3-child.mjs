// A role run as a T3 child thread (runner `t3`): the prompt the lead starts it with, and its session transcript, found
// by the provider session and the nonce that prompt carried, with its tool events in the shapes audit-access.mjs reads. Claude Code writes `<config>/projects/<cwd>/<session>.jsonl` (the same
// `assistant` / `user` events as `claude -p --output-format stream-json`); Codex writes
// `<home>/sessions/YYYY/MM/DD/rollout-*.jsonl` (moved to `<home>/archived_sessions/` when T3 archives the thread), whose rollouts include tool calls, results and completed commands.
// Its first actual user message must hold the nonce: the lead's own session also names the
// nonce (in the call that started the child), but never in its first message.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Old prepared contexts carry the phase only in the generated role prompt. */
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

function candidateFiles(runner, since) {
  // File clocks can round down across prepare. The first prompt's nonce and native session ID still bind the child.
  since -= 2_000;
  if (runner === "claude") {
    const projects = join(claudeHome(), "projects");
    return existsSync(projects) ? readdirSync(projects, { withFileTypes: true }).filter(p => p.isDirectory())
      .flatMap(p => recent(join(projects, p.name), since)) : [];
  }
  const files = recent(join(codexHome(), "archived_sessions"), since);
  const day = 86_400_000;
  for (let t = since - day; t <= Date.now() + day; t += day) {
    const d = new Date(t);
    const dir = join(codexHome(), "sessions", String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0"));
    files.push(...recent(dir, since));
  }
  return files;
}

export function findTranscripts(runner, nonce, since, session = null) {
  const first = runner === "codex" ? codexFirstPrompt : claudeFirstPrompt;
  const identity = runner === "codex" ? codexSession : claudeSession;
  return [...new Set(candidateFiles(runner, since))].flatMap(file => {
    const rows = lines(file), nativeId = identity(rows);
    return (!session || session === nativeId) && first(rows).includes(nonce) ? [{ runner, file, session: nativeId }] : [];
  });
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
  const calls = new Map(), outputs = new Map(), legacy = [], fileEvents = [], unknown = [];
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
      if (typeof command === "string" && command.trim()) legacy.push({ command, exit: p.item.exit_code, call: p.item.call_id ?? p.item.id });
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
  const events = [...legacy.map(execution), ...fileEvents];
  const counted = new Set(legacy.map(item => item.call));
  for (const [id, call] of calls) {
    if (counted.has(id)) continue;
    // Code-mode calls wrap provider work. Audit their structured command and file events instead of the wrapper text.
    if (outputs.has(id) && (call.name === "wait"
        || call.name === "exec" && call.type === "custom_tool_call" && typeof call.input === "string")) continue;
    let args;
    if (call.type === "function_call") {
      try { args = JSON.parse(call.arguments); } catch { /* report insufficient evidence below */ }
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

export function transcriptEvents(id, { runner, file }) {
  const text = readFileSync(file, "utf8"), rows = lines(file);
  const times = rows.map(r => Date.parse(r.timestamp ?? "")).filter(Number.isFinite);
  const seconds = times.length ? Math.round((Math.max(...times) - Math.min(...times)) / 100) / 10 : null;
  if (runner === "claude") {
    const session = claudeSession(rows);
    const events = rows.filter(r => r.type === "assistant" || r.type === "user").map(event => ({ id, event }));
    const observedModel = rows.find(r => r.type === "assistant" && r.message?.model)?.message.model ?? null;
    return { events, session, forked: rows.some(r => r.sessionId && r.sessionId !== session), status: claudeStatus(rows),
      firstPrompt: claudeFirstPrompt(rows), observedModel, seconds, cwd: rows.find(r => typeof r.cwd === "string")?.cwd ?? null, text };
  }
  const meta = codexMeta(rows);
  const observedModel = rows.find(r => r.type === "turn_context" && r.payload?.model)?.payload.model ?? null;
  return { events: codexTools(rows).map(event => ({ id, event })), session: codexSession(rows), forked: Boolean(meta.forked_from_id),
    status: codexStatus(rows), firstPrompt: codexFirstPrompt(rows), observedModel, seconds, cwd: meta.cwd ?? null, text };
}

/** The prompt of a role run as a T3 child thread: the nonce that identifies its transcript, where to work, the role prompt. */
export function t3Prompt({ id, nonce, wt, ws, text }) {
  return [`self-loop call ${id} · nonce ${nonce}`, "",
    "You run as a T3 child thread whose session starts in another directory. Work only in the folders below, by absolute path.",
    `- Your working folder: ${ws} (brief-shared.md, brief.md, task.md, records/; write under ${ws}/out).`,
    wt ? `- The product worktree: ${wt}. Run every shell command as \`cd ${wt} && ...\`.` : null,
    "- Do not commit, push, stash or switch branches: when you finish, the lead records your work from this folder and your transcript.",
    "", text].filter(line => line !== null).join("\n");
}
