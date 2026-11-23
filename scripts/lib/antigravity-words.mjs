// Antigravity owner-words adapter: transcript parsing, child-session exclusion, three-state DB sync isolation,
// and step_index-anchored PreInvocation confirmation (F-0009, design/antigravity-harness.md#owner-words-capture-and-sync).
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  antigravityAppDirs,
  appDirFromTranscriptPath,
  conversationIdFromPath,
  readConversationSummaries,
  resolveAuthoritativeTranscript,
  unwrapAntigravityUserText,
} from "./antigravity.mjs";
import {
  DELEGATED_NOTICE,
  T3_AGENT_NOTICE,
  LeadSends,
  captureOwnerText,
  delegatedThread,
  inside,
  isLeadPrompt,
  numberWords,
  ownerPrompt,
  rowsOf,
} from "./owner-words-core.mjs";

const isUserRow = row => row?.type === "USER_INPUT" && row.source === "USER_EXPLICIT" && typeof row.content === "string";
const isTruncatedContent = row => Array.isArray(row?.truncated_fields) && row.truncated_fields.includes("content");

/** Classify whether an Antigravity transcript belongs to a subagent/delegated child session. */
export function antigravityAgent(rows, summary = null) {
  if (summary && (summary.parent_conversation_id || summary.nesting_depth > 0)) return { agent: true, unparseableFirstPrompt: false };
  const first = rows.find(isUserRow);
  if (!first || isTruncatedContent(first)) return { agent: false, unparseableFirstPrompt: false };
  const unwrapped = unwrapAntigravityUserText(first.content);
  if (unwrapped === null) return { agent: false, unparseableFirstPrompt: true };
  const trimmed = unwrapped.trim();
  if (T3_AGENT_NOTICE.test(trimmed) || DELEGATED_NOTICE.test(trimmed) || isLeadPrompt(ownerPrompt(unwrapped)?.text ?? "")) {
    return { agent: true, unparseableFirstPrompt: false };
  }
  return { agent: false, unparseableFirstPrompt: false };
}

/** Child-session check for Antigravity hooks (treats unparseable step-0 as non-owner/skip in hooks). */
export function antigravityChildSession(file, summary = null) {
  if (summary && (summary.parent_conversation_id || summary.nesting_depth > 0)) return true;
  if (!file) return false;
  const actual = resolveAuthoritativeTranscript(file);
  if (!existsSync(actual)) return false;
  const status = antigravityAgent(rowsOf(actual), summary);
  return status.agent || status.unparseableFirstPrompt;
}

export function antigravityHookSession(input, projects, env = process.env) {
  if (typeof input?.conversationId !== "string" || !input.conversationId) return false;
  const dirs = [input.cwd, ...(Array.isArray(input.workspacePaths) ? input.workspacePaths : [])]
    .filter(d => typeof d === "string" && d.length > 0);
  if (!dirs.length || !dirs.some(d => inside(d, projects))) return false;
  if (delegatedThread(env)) return false;
  if (typeof input.parentConversationId === "string" && input.parentConversationId.length > 0) return false;
  if (input.transcriptPath) {
    const actual = resolveAuthoritativeTranscript(input.transcriptPath);
    const appDir = appDirFromTranscriptPath(actual);
    const db = appDir ? readConversationSummaries(appDir) : null;
    const summary = db?.state === "ok" ? (db.rows.get(input.conversationId) ?? null) : null;
    if (antigravityChildSession(actual, summary)) return false;
  }
  return true;
}

export function antigravityTranscript(file, _roots = null, expectedSession = null, { summary = null } = {}) {
  if (!file) return { words: [], echoes: [], skippedTruncated: 0, unparseableFirstPrompt: false };
  const actual = resolveAuthoritativeTranscript(file);
  if (!existsSync(actual)) return { words: [], echoes: [], skippedTruncated: 0, unparseableFirstPrompt: false };
  const rows = rowsOf(actual);
  const session = expectedSession ?? conversationIdFromPath(actual);
  if (!session) return { words: [], echoes: [], skippedTruncated: 0, unparseableFirstPrompt: false };
  const status = antigravityAgent(rows, summary);
  if (status.agent || status.unparseableFirstPrompt) {
    return { words: [], echoes: [], skippedTruncated: 0, unparseableFirstPrompt: status.unparseableFirstPrompt };
  }
  const sends = new LeadSends();
  const items = [];
  const echoes = [];
  let skippedTruncated = 0;
  for (const row of rows) {
    if (row?.type === "PLANNER_RESPONSE" && Array.isArray(row.tool_calls)) {
      for (const tc of row.tool_calls) sends.add(tc?.name, tc?.args, row.created_at);
      continue;
    }
    if (!isUserRow(row)) continue;
    if (isTruncatedContent(row)) { skippedTruncated++; continue; }
    const unwrapped = unwrapAntigravityUserText(row.content);
    if (unwrapped === null) continue;
    const prompt = ownerPrompt(unwrapped);
    if (!prompt) continue;
    const event = Number.isInteger(row.step_index) ? `step-${row.step_index}` : null;
    const item = { ...prompt, time: row.created_at ?? null, event };
    if (sends.matches(prompt.text, item.time)) echoes.push({ ...item, source: "antigravity", session });
    else items.push(item);
  }
  return { words: numberWords(session, items, "antigravity"), echoes, skippedTruncated, unparseableFirstPrompt: false };
}

/** Check whether the current PreInvocation turn is already confirmed in the transcript, anchored by step_index. */
export function checkAntigravityTurnConfirmation({ transcriptPath, text, initialNumSteps, words = [], echoes = [] }) {
  if (!transcriptPath) return { confirmed: false, event: null };
  const actual = resolveAuthoritativeTranscript(transcriptPath);
  if (!existsSync(actual)) return { confirmed: false, event: null };
  const rows = rowsOf(actual);
  let lastRow = null;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (isUserRow(rows[i])) { lastRow = rows[i]; break; }
  }
  if (!lastRow) return { confirmed: false, event: null };
  const event = Number.isInteger(lastRow.step_index) ? `step-${lastRow.step_index}` : null;
  const isCurrentTurn = typeof initialNumSteps === "number"
    ? (Number.isInteger(lastRow.step_index) && lastRow.step_index >= initialNumSteps - 1)
    : true;
  if (!isCurrentTurn) return { confirmed: false, event: null };
  if (isTruncatedContent(lastRow)) return { confirmed: false, event };
  const unwrapped = unwrapAntigravityUserText(lastRow.content);
  const rowText = unwrapped === null ? null : captureOwnerText(unwrapped);
  if (rowText !== text || !event) return { confirmed: false, event };
  const confirmed = [...words, ...echoes].some(item => item.event === event && item.text === text);
  return { confirmed, event };
}

function brainTranscripts(appDir) {
  const brain = join(appDir, "brain");
  let dirs;
  try { dirs = readdirSync(brain, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const logs = join(brain, d.name, ".system_generated", "logs");
    const full = join(logs, "transcript_full.jsonl");
    const compact = join(logs, "transcript.jsonl");
    if (existsSync(full)) out.push({ id: d.name, file: full });
    else if (existsSync(compact)) out.push({ id: d.name, file: compact });
  }
  return out;
}

/** Scan Antigravity transcripts with strict DB error isolation and explicit skip reporting (A10, R8). */
export function collectAntigravityWords(roots, { env = process.env, home, sqliteLoader } = {}) {
  const words = [];
  const reasons = [];
  let skipped = 0;
  const note = reason => { if (reason && !reasons.includes(reason)) reasons.push(reason); };
  let appDirs = [];
  try { appDirs = antigravityAppDirs({ env, ...(home !== undefined ? { home } : {}) }); }
  catch (error) { return { words: [], skipped: 1, reason: error?.message ?? String(error) }; }
  for (const appDir of appDirs) {
    const convs = brainTranscripts(appDir);
    if (!convs.length) continue;
    const db = readConversationSummaries(appDir, sqliteLoader ? { sqliteLoader } : {});
    if (db.state === "unavailable") {
      skipped += convs.length;
      note(db.reason);
      continue;
    }
    for (const { id, file } of convs) {
      const lookup = db.get(id);
      if (lookup.state === "missing-row") {
        if (roots) {
          skipped++;
          note("missing conversation_summaries.db row");
          continue;
        }
      }
      const summary = lookup.state === "ok" ? lookup.summary : null;
      if (summary && (summary.parent_conversation_id || summary.nesting_depth > 0)) continue;
      if (roots && summary && !summary.workspaces.some(ws => inside(ws, roots))) continue;
      try {
        const result = antigravityTranscript(file, roots, id, { summary });
        if (result.unparseableFirstPrompt) {
          skipped++;
          note("unparseable first prompt");
          continue;
        }
        if (result.skippedTruncated > 0) {
          skipped += result.skippedTruncated;
          note("compact transcript has truncated USER_INPUT without transcript_full.jsonl");
        }
        words.push(...result.words);
      } catch (error) {
        skipped++;
        note(error?.message ?? String(error));
      }
    }
  }
  return { words, skipped, reason: reasons.length ? reasons.join("; ") : null };
}
