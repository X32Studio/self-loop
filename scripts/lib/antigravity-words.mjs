// F-0009, D-0052, R-0032-reviewer-architecture, design/antigravity-harness.md#owner-words-capture-and-sync
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { antigravityAppDirs, appDirFromTranscriptPath, conversationIdFromPath, decodeToolCallArgs, extractHookDirs, readConversationSummaries, resolveAuthoritativeTranscript, unwrapAntigravityUserText } from "./antigravity.mjs";
import { DELEGATED_NOTICE, T3_AGENT_NOTICE, LeadSends, captureOwnerText, delegatedThread, handoffMessage, inside, isLeadPrompt, numberWords, ownerPrompt } from "./owner-words-core.mjs";

const TRUNCATED_REASON = "compact transcript has truncated USER_INPUT without transcript_full.jsonl";
const isChildSummary = summary => Boolean(summary && (summary.parent_conversation_id || summary.nesting_depth > 0));
const isExplicitUserRow = row => row?.type === "USER_INPUT" && row.source === "USER_EXPLICIT";
const isUserRow = row => isExplicitUserRow(row) && typeof row.content === "string";
const isTruncatedContent = row => Array.isArray(row?.truncated_fields) && row.truncated_fields.includes("content");

function readTranscriptRows(file) {
  const rows = [];
  let parseErrors = 0;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); }
    catch { parseErrors++; }
  }
  return { rows, parseErrors };
}

function unwrapHandoffText(text) {
  let current = text;
  while (/^Context handoff \([a-z_]+\):(?:\r?\n|$)/.test(current)) {
    const next = handoffMessage(current);
    if (next === null) break;
    current = next.trim();
  }
  return current;
}

function parseFirstPrompt(rows, parseErrors = 0) {
  if (parseErrors > 0) return { ok: false, unresolved: true, unparseableFirstPrompt: true, truncatedFirstPrompt: false, reason: "transcript has unparseable JSON line(s)", text: null };
  const first = rows.find(isExplicitUserRow);
  if (!first) return { ok: false, unresolved: false, unparseableFirstPrompt: false, truncatedFirstPrompt: false, reason: null, text: null };
  if (Number.isInteger(first.step_index) && first.step_index > 0 && !rows.some(r => r?.step_index === 0)) {
    return { ok: false, unresolved: true, unparseableFirstPrompt: false, truncatedFirstPrompt: false, reason: "transcript is missing step 0 before first USER_INPUT", text: null };
  }
  if (typeof first.content !== "string") return { ok: false, unresolved: true, unparseableFirstPrompt: true, truncatedFirstPrompt: false, reason: "first USER_INPUT has missing content", text: null };
  if (isTruncatedContent(first)) return { ok: false, unresolved: true, unparseableFirstPrompt: false, truncatedFirstPrompt: true, reason: TRUNCATED_REASON, text: null };
  const unwrapped = unwrapAntigravityUserText(first.content);
  if (unwrapped === null) return { ok: false, unresolved: true, unparseableFirstPrompt: true, truncatedFirstPrompt: false, reason: "unparseable first prompt", text: null };
  return { ok: true, unresolved: false, unparseableFirstPrompt: false, truncatedFirstPrompt: false, reason: null, text: unwrapped };
}

function antigravityAgent(rows, summary = null, { parseErrors = 0 } = {}) {
  const res = (agent, extra = {}) => ({ agent, unresolved: false, unparseableFirstPrompt: false, truncatedFirstPrompt: false, reason: null, firstPrompt: null, ...extra });
  const parsed = parseFirstPrompt(rows, parseErrors);
  if (isChildSummary(summary)) return res(true, { firstPrompt: parsed.ok ? parsed.text : null });
  if (!parsed.ok) {
    if (parsed.unresolved) return res(false, { unresolved: true, unparseableFirstPrompt: parsed.unparseableFirstPrompt, truncatedFirstPrompt: parsed.truncatedFirstPrompt, reason: parsed.reason });
    return Number.isInteger(summary?.last_user_input_step_index) && summary.last_user_input_step_index >= 0
      ? res(false, { unresolved: true, reason: "transcript is missing first USER_INPUT step" })
      : res(false);
  }
  const trimmed = unwrapHandoffText(parsed.text.trim());
  if (T3_AGENT_NOTICE.test(trimmed) || DELEGATED_NOTICE.test(trimmed) || isLeadPrompt(ownerPrompt(parsed.text)?.text ?? "")) {
    return res(true, { firstPrompt: parsed.text });
  }
  return res(false, { firstPrompt: parsed.text });
}

function lookupConversationSummary(actual, conversationId = null) {
  const id = conversationId || conversationIdFromPath(actual);
  const appDir = id ? appDirFromTranscriptPath(actual) : null;
  const db = appDir ? readConversationSummaries(appDir) : null;
  return db?.state === "ok" ? (db.rows.get(id) ?? null) : null;
}

export function antigravitySessionState(file, { summary = undefined, conversationId = null } = {}) {
  const empty = { agent: false, unresolved: false, unparseableFirstPrompt: false, truncatedFirstPrompt: false, reason: null, firstPrompt: null };
  if (!file) {
    return isChildSummary(summary)
      ? { state: "confirmed-child", ...empty, agent: true }
      : { state: "owner", ...empty };
  }
  const actual = resolveAuthoritativeTranscript(file);
  const resolved = summary === undefined ? lookupConversationSummary(actual, conversationId) : summary;
  const childBySummary = isChildSummary(resolved);
  if (!existsSync(actual)) {
    return childBySummary
      ? { state: "confirmed-child", ...empty, agent: true }
      : { state: "owner", ...empty };
  }
  let read;
  try { read = readTranscriptRows(actual); }
  catch (error) {
    return childBySummary
      ? { state: "confirmed-child", ...empty, agent: true }
      : { state: "unresolved", ...empty, unresolved: true, reason: error?.message ?? String(error) };
  }
  const status = antigravityAgent(read.rows, resolved, { parseErrors: read.parseErrors });
  return { state: status.agent ? "confirmed-child" : status.unresolved ? "unresolved" : "owner", ...status };
}

export function antigravityChildSession(file, summary = undefined) {
  return antigravitySessionState(file, { summary }).state === "confirmed-child";
}

export function antigravityHookSession(input, projects, env = process.env) {
  if (typeof input?.conversationId !== "string" || !input.conversationId) return false;
  const dirs = extractHookDirs(input);
  if (!dirs.length || !dirs.some(d => inside(d, projects))) return false;
  if (delegatedThread(env)) return false;
  if (typeof input.parentConversationId === "string" && input.parentConversationId.length > 0) return false;
  if (input.transcriptPath && antigravitySessionState(input.transcriptPath, { conversationId: input.conversationId }).state === "confirmed-child") return false;
  return true;
}

export function antigravityTranscript(file, _roots = null, expectedSession = null, { summary = null } = {}) {
  const empty = { words: [], echoes: [], skippedTruncated: 0, unparseableFirstPrompt: false, unresolved: false, unresolvedReason: null };
  if (!file) return empty;
  const actual = resolveAuthoritativeTranscript(file);
  if (!existsSync(actual)) return empty;
  const session = expectedSession ?? conversationIdFromPath(actual);
  if (!session) return empty;
  const { rows, parseErrors } = readTranscriptRows(actual);
  const status = antigravityAgent(rows, summary, { parseErrors });
  if (status.agent || status.unresolved) {
    return {
      ...empty,
      skippedTruncated: status.truncatedFirstPrompt ? 1 : 0,
      unparseableFirstPrompt: status.unparseableFirstPrompt,
      unresolved: status.unresolved,
      unresolvedReason: status.reason,
    };
  }
  const sends = new LeadSends();
  const items = [];
  const echoes = [];
  let skippedTruncated = 0;
  for (const row of rows) {
    if (row?.type === "PLANNER_RESPONSE" && Array.isArray(row.tool_calls)) {
      for (const tc of row.tool_calls) {
        const decoded = decodeToolCallArgs(tc);
        if (decoded.ok) sends.add(tc?.name, decoded.args, row.created_at);
      }
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
  return { ...empty, words: numberWords(session, items, "antigravity"), echoes, skippedTruncated };
}

export function checkAntigravityTurnConfirmation({ transcriptPath, text, initialNumSteps, words = [], echoes = [] }) {
  if (!transcriptPath) return { confirmed: false, event: null };
  const actual = resolveAuthoritativeTranscript(transcriptPath);
  if (!existsSync(actual)) return { confirmed: false, event: null };
  const { rows } = readTranscriptRows(actual);
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
      if (isChildSummary(summary)) continue;
      if (roots && summary && !summary.workspaces.some(ws => inside(ws, roots))) continue;
      try {
        const result = antigravityTranscript(file, roots, id, { summary });
        if (result.unresolved) {
          skipped++;
          note(result.unresolvedReason ?? "unresolved Antigravity transcript");
          continue;
        }
        if (result.skippedTruncated > 0) {
          skipped += result.skippedTruncated;
          note(TRUNCATED_REASON);
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

export function collectAntigravityStoreWords(storeProducts, { routeProduct, env = process.env, home, sqliteLoader } = {}) {
  const byProduct = new Map(storeProducts.map(p => [p.name, { words: [], skipped: 0, reasons: [] }]));
  const unresolved = [];
  const storeReasons = [];
  let storeSkipped = 0;
  const note = (list, reason) => { if (reason && !list.includes(reason)) list.push(reason); };
  let appDirs = [];
  try { appDirs = antigravityAppDirs({ env, ...(home !== undefined ? { home } : {}) }); }
  catch (error) {
    const reason = error?.message ?? String(error);
    unresolved.push({ status: "unresolved", source: "antigravity", session: null, workspaces: [], products: [], reason });
    return { byProduct, storeSkipped: 1, storeReasons: [reason], unresolved };
  }
  for (const appDir of appDirs) {
    const convs = brainTranscripts(appDir);
    if (!convs.length) continue;
    const db = readConversationSummaries(appDir, sqliteLoader ? { sqliteLoader } : {});
    if (db.state === "unavailable") {
      storeSkipped += convs.length;
      note(storeReasons, db.reason);
      unresolved.push({ status: "unresolved", source: "antigravity", session: null, workspaces: [], products: [], reason: db.reason });
      continue;
    }
    for (const { id, file } of convs) {
      const lookup = db.get(id);
      if (lookup.state === "missing-row") {
        storeSkipped++;
        const reason = "missing conversation_summaries.db row";
        note(storeReasons, reason);
        unresolved.push({ status: "unresolved", source: "antigravity", session: id, workspaces: [], products: [], reason });
        continue;
      }
      const summary = lookup.summary;
      if (isChildSummary(summary)) continue;
      const routed = routeProduct(summary?.workspaces ?? [], storeProducts);
      if (routed.status === "skip") continue;
      if (routed.status === "ambiguous") {
        let isAgent = false;
        try {
          const { rows, parseErrors } = readTranscriptRows(resolveAuthoritativeTranscript(file));
          isAgent = antigravityAgent(rows, summary, { parseErrors }).agent;
        } catch {}
        if (isAgent) continue;
        unresolved.push({
          status: "ambiguous",
          source: "antigravity",
          session: id,
          workspaces: summary?.workspaces ?? [],
          products: routed.products ?? [],
          reason: routed.error,
        });
        continue;
      }
      const bucket = byProduct.get(routed.product.name);
      try {
        const result = antigravityTranscript(file, null, id, { summary });
        if (result.unresolved) {
          bucket.skipped++;
          const reason = result.unresolvedReason ?? "unresolved Antigravity transcript";
          note(bucket.reasons, reason);
          unresolved.push({ status: "unresolved", source: "antigravity", session: id, workspaces: summary?.workspaces ?? [], products: [routed.product.name], reason });
          continue;
        }
        if (result.skippedTruncated > 0) {
          bucket.skipped += result.skippedTruncated;
          note(bucket.reasons, TRUNCATED_REASON);
          unresolved.push({ status: "unresolved", source: "antigravity", session: id, workspaces: summary?.workspaces ?? [], products: [routed.product.name], reason: TRUNCATED_REASON });
        }
        bucket.words.push(...result.words);
      } catch (error) {
        bucket.skipped++;
        const reason = error?.message ?? String(error);
        note(bucket.reasons, reason);
        unresolved.push({ status: "unresolved", source: "antigravity", session: id, workspaces: summary?.workspaces ?? [], products: [routed.product.name], reason });
      }
    }
  }
  return { byProduct, storeSkipped, storeReasons, unresolved };
}
