// F-0002, F-0009, D-0016, D-0062, design/paseo-and-judge-policy.md#1
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { isPaseoSystemEnvelope } from "./paseo.mjs";
import { canonical } from "./path-canonical.mjs";

export const WORDS = "owner/words.jsonl";
export const MARKS = "owner/word-marks.jsonl";
const LEAD_MARKERS = ["self-loop call ", "[lead", "Your task is the file "];
const HANDOFF = /^Context handoff \([a-z_]+\):(?:\r?\n|$)/;
const SLASH_COMMAND = /^<command-name>(\/[^<]+)<\/command-name>\s*<command-message>[\s\S]*?<\/command-message>\s*<command-args>([\s\S]*)<\/command-args>$/;
export const SEND = /^(?:mcp__t3[-_]code__|mcp_t3[-_]code_)t3_thread_send(?:_attachments)?$/;
export const DELEGATED = /^Act as the [\w -]+ sub-agent for this task\./;
export const T3_AGENT_NOTICE = /^\[T3 Code: (?:the agent in T3 thread "[^"\r\n]+"(?: on linked environment "[^"\r\n]+")? sent this message, not the user|this message came through T3 Code's tools, not from the user typing in this chat)\.\](?:\r?\n|$)/;
export const DELEGATED_NOTICE = /^Delegated task (?:node:|thread:)?delegated-task:\S+(?: \([^\r\n]*\))?(?: in child thread \S+)? (?:\[(?:completed|failed|cancelled|interrupted)\](?::|\. Use task_status\b)|asked a question and is still working\.)/;
export const HARNESS_ENVELOPE = /^\s*(?:Delegated task node:delegated-task:|\[T3 Code:\s*the agent in T3 thread\b|<CONTEXT_SUMMARY>|<SYSTEM_MESSAGE>)/;

const ROUTINE_ACKS = new Set([
  "ok", "okay", "k", "kk", "go", "go ahead", "yes", "y", "yep", "yeah", "sure", "done", "ack",
  "lgtm", "proceed", "continue", "confirm", "approved", "thanks", "thx", "ty",
  "好", "好的", "好吧", "行", "行的", "可以", "没问题", "同意", "确认", "继续", "去做", "去做吧",
  "开始", "开始吧", "执行", "通过", "批准", "收到", "明白", "了解", "谢谢", "嗯", "嗯嗯", "对", "是的",
]);

export const sha = text => createHash("sha256").update(text).digest("hex");
export const rowsOf = file => readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } });
export const textOf = content => typeof content === "string" ? content : Array.isArray(content)
  ? content.filter(p => p?.type === "text" || p?.type === "input_text").map(p => p.text ?? "").join("\n") : "";

export const projectRoots = value => String(value ?? "").split(",").map(s => s.trim()).filter(Boolean).map(p => resolve(p));
export const delegatedThread = (env = process.env) => /delegated-task/.test(env.T3CODE_THREAD_ID ?? "");

export const isLeadPrompt = text => DELEGATED.test(text.trimStart()) || LEAD_MARKERS.some(m => text.trimStart().startsWith(m));
export const codexAgentSession = meta => meta.thread_source === "subagent" || Boolean(meta.source?.subagent)
  || Boolean(meta.parent_thread_id && !meta.forked_from_id) || meta.source === "exec" || meta.originator === "codex_exec";

export function inside(dir, roots) {
  const child = canonical(dir);
  return roots.some(root => {
    const r = relative(canonical(root), child);
    return r !== ".." && !r.startsWith(".." + sep) && !r.startsWith(sep);
  });
}

export function wordId(session, text, ordinal) {
  return `W-${sha(`${session}\0${text}\0${ordinal}`).slice(0, 10)}`;
}

export function handoffMessage(text) {
  if (!HANDOFF.test(text.trimStart())) return null;
  const marker = [...text.matchAll(/(?:\r?\n){2,}User message:\r?\n/g)].at(-1)
    ?? [...text.matchAll(/\r?\nUser message:\r?\n/g)].at(-1);
  const message = marker && text.slice(marker.index + marker[0].length);
  return message?.trim() ? message : null;
}

export function ownerPrompt(text, { claude = false } = {}) {
  while (HANDOFF.test(text.trimStart())) {
    text = handoffMessage(text);
    if (text === null) return null;
  }
  const content = text.trim();
  if (!content
    || (claude && /^\[Request interrupted by user(?: for tool use)?\]$/.test(content))
    || /^(?:\[Historical (?:user|assistant); [^\]\r\n]*\]|<codex_internal_context\b)/.test(content)
    || T3_AGENT_NOTICE.test(content) || DELEGATED_NOTICE.test(content) || HARNESS_ENVELOPE.test(content)
    || isPaseoSystemEnvelope(content)
    || /^<(task-notification|system-reminder|local-command-stdout)>[\s\S]*<\/\1>$/.test(content)
    || /^<local-command-caveat>[\s\S]*?<\/local-command-caveat>/.test(content)) return null;
  const command = SLASH_COMMAND.exec(content);
  if (command) return command[2].trim() ? { text: command[2], command: command[1] } : null;
  return { text };
}

export const ownerPromptText = text => ownerPrompt(text)?.text ?? null;

export function captureOwnerText(text) {
  if (typeof text !== "string" || HARNESS_ENVELOPE.test(text) || isPaseoSystemEnvelope(text)) return null;
  const owner = ownerPrompt(text, { claude: true })?.text ?? null;
  return owner && !isLeadPrompt(owner) ? owner : null;
}

export function isSubstantiveOwnerWord(text) {
  if (typeof text !== "string") return false;
  const trimmed = text.trim();
  if (!trimmed || HARNESS_ENVELOPE.test(trimmed) || T3_AGENT_NOTICE.test(trimmed) || DELEGATED_NOTICE.test(trimmed) || isPaseoSystemEnvelope(trimmed)) return false;
  if (/[?？]/.test(trimmed)) return true;
  const norm = trimmed.replace(/[.!。！~～,，]+$/u, "").trim().toLowerCase();
  return !(trimmed.length <= 8 && ROUTINE_ACKS.has(norm));
}

export class LeadSends {
  recent = [];

  add(name, input, time) {
    if (typeof name !== "string" || !SEND.test(name) || typeof input?.message !== "string") return;
    this.recent.push({ text: input.message, attachments: name.endsWith("_attachments"), time });
  }

  matches(text, time) {
    const i = this.recent.findIndex(send => {
      const elapsed = Date.parse(time) - Date.parse(send.time);
      if (Number.isFinite(elapsed) && (elapsed < 0 || elapsed > 30_000)) return false;
      return text === send.text || (send.attachments && text.startsWith(send.text)
        && /^(?:\s*\[Attached file "[^"\r\n]+" is saved at: [^\r\n]+\])+\s*$/.test(text.slice(send.text.length)));
    });
    if (i !== -1) {
      this.recent.splice(i, 1);
      return true;
    }
    this.recent = [];
    return false;
  }
}

export function numberWords(session, items, source) {
  const seen = new Map(), trimmed = new Map();
  return items.map(({ time, text, event, command }) => {
    const n = (seen.get(text) ?? 0) + 1;
    seen.set(text, n);
    const normalized = text.trim();
    const ordinal = (trimmed.get(normalized) ?? 0) + 1;
    trimmed.set(normalized, ordinal);
    const legacyId = wordId(session, text, n);
    const id = event && (source === "claude" || source === "antigravity")
      ? wordId(session, `${source}-event:${event}`, 1) : legacyId;
    const word = { id, time, source, session, text, sha256: sha(text), ...(event ? { event } : {}) };
    return Object.defineProperties(word, { legacyId: { value: legacyId }, trimmedId: { value: wordId(session, normalized, ordinal) },
      command: { value: command } });
  });
}
