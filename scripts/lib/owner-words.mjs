// F-0002, F-0009, F-0015, D-0006, D-0007, D-0052, R-0033-judge-hooks
import { randomUUID } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { antigravityHookSession, antigravityTranscript, collectAntigravityStoreWords, collectAntigravityWords } from "./antigravity-words.mjs";
import { git } from "./git-plumbing.mjs";
import {
  captureOwnerText,
  codexAgentSession,
  DELEGATED_NOTICE,
  delegatedThread,
  handoffMessage,
  HARNESS_ENVELOPE,
  inside,
  isLeadPrompt,
  isRoutineCheckInCandidate,
  isSubstantiveOwnerWord,
  LeadSends,
  MARKS,
  numberWords,
  ownerPrompt,
  ownerPromptText,
  projectRoots,
  ROUTINE_CHECKIN_RE,
  rowsOf,
  SEND,
  sha,
  stripChatHistorySummary,
  T3_AGENT_NOTICE,
  T3_SCHEDULED_TASK_NOTICE,
  textOf,
  wordId,
  WORDS,
} from "./owner-words-core.mjs";
import { appendJsonLines, commitRecords, recordsSnapshot } from "./records-commit.mjs";

export {
  captureOwnerText,
  codexAgentSession,
  DELEGATED_NOTICE,
  delegatedThread,
  handoffMessage,
  HARNESS_ENVELOPE,
  inside,
  isLeadPrompt,
  isRoutineCheckInCandidate,
  isSubstantiveOwnerWord,
  LeadSends,
  MARKS,
  numberWords,
  ownerPrompt,
  ownerPromptText,
  projectRoots,
  ROUTINE_CHECKIN_RE,
  rowsOf,
  sha,
  stripChatHistorySummary,
  T3_AGENT_NOTICE,
  T3_SCHEDULED_TASK_NOTICE,
  wordId,
  WORDS,
};

const CODEX_INJECTED = /^(?:<environment_context>|# AGENTS\.md instructions\b|<user_instructions>|<permissions instructions>|<turn_aborted>|<user_shell_command>)/;

function claudeOwnerPrompt(row) {
  if (row?.type !== "user" || row.toolUseResult || row.isMeta || row.isCompactSummary || row.isSidechain) return null;
  if (row.promptSource === "system" || row.origin?.kind || row.source?.subagent) return null;
  return ownerPrompt(textOf(row.message?.content), { claude: true });
}

export const claudeOwnerText = row => claudeOwnerPrompt(row)?.text ?? null;

const claudeAgent = rows => rows.some(row => row.type === "session_meta" && row.source?.subagent)
  || isLeadPrompt(rows.map(claudeOwnerText).find(text => text !== null) ?? "");

export const claudeAgentSession = file => existsSync(file) && claudeAgent(rowsOf(file));

export function claudeHookSession(input, projects, env = process.env) {
  return Boolean(input?.session_id && input.cwd && inside(input.cwd, projects)
    && !delegatedThread(env) && !(input.transcript_path && claudeAgentSession(input.transcript_path)));
}

function claudeSessionItems(file, expected = null) {
  if (!existsSync(file)) return { session: null, items: [], words: [], echoes: [] };
  const rows = rowsOf(file);
  if (claudeAgent(rows)) return { session: null, items: [], words: [], echoes: [] };
  const fileSession = basename(file, ".jsonl");
  const session = expected ?? (rows.some(r => r.sessionId === fileSession) ? fileSession : rows.find(r => r.sessionId)?.sessionId ?? fileSession);
  const seen = new Set(), sends = new LeadSends(), items = [], echoes = [];
  for (const row of rows) {
    if (row.sessionId && row.sessionId !== session || expected && !row.sessionId) continue;
    if (row.type === "assistant" && Array.isArray(row.message?.content)) {
      for (const tool of row.message.content) if (tool.type === "tool_use") sends.add(tool.name, tool.input, row.timestamp);
    }
    const prompt = claudeOwnerPrompt(row), event = row.promptId ?? row.uuid;
    if (!prompt || event && seen.has(event)) continue;
    if (event) seen.add(event);
    const item = { ...prompt, time: row.timestamp ?? null, cwd: row.cwd, event };
    if (sends.matches(prompt.text, item.time)) echoes.push({ ...item, source: "claude", session });
    else items.push(item);
  }
  return { session, items, words: numberWords(session, items, "claude"), echoes };
}

function claudeTranscript(file, roots, expected) {
  const { items, words, echoes } = claudeSessionItems(file, expected);
  const inScope = item => item.cwd && inside(item.cwd, roots);
  return { words: roots ? words.filter((_, i) => inScope(items[i])) : words, echoes: roots ? echoes.filter(inScope) : echoes };
}

export function claudeSessionWords(file, roots = null, { session = null } = {}) {
  return claudeTranscript(file, roots, session).words;
}

function codexMessages(file) {
  const rows = rowsOf(file);
  const meta = rows.find(r => r.type === "session_meta")?.payload ?? {};
  let cwd = meta.cwd;
  const submitted = [], completed = [], rawResponses = [];
  const trackers = new Map([submitted, completed, rawResponses].map(items => [items, new LeadSends()]));
  const collect = (items, text, time, event) => {
    const owner = CODEX_INJECTED.test(text.trimStart()) ? null : ownerPromptText(text);
    const echoed = owner !== null && trackers.get(items).matches(owner, time);
    items.push({ text: echoed ? null : owner, time, cwd, event });
  };
  for (const row of rows) {
    const p = row.payload;
    if (row.type === "response_item" && p?.type === "function_call" && SEND.test(p.name ?? "")) {
      try {
        const input = JSON.parse(p.arguments);
        for (const tracker of trackers.values()) tracker.add(p.name, input, row.timestamp);
      } catch {}
    }
    if (row.type === "turn_context" && p?.cwd) cwd = p.cwd;
    if (row.type === "event_msg" && p?.type === "user_message" && typeof p.message === "string")
      collect(submitted, p.message, row.timestamp, p.id);
    if (row.type === "event_msg" && p?.type === "item_completed" && p.item?.type === "UserMessage")
      collect(completed, textOf(p.item.content), row.timestamp, p.item.id);
    if (row.type === "response_item" && p?.type === "message" && p.role === "user")
      collect(rawResponses, textOf(p.content), row.timestamp, p.id);
  }
  const messages = completed.length ? completed : submitted.length ? submitted : rawResponses;
  return { meta, session: meta.id ?? meta.session_id ?? file, items: messages.filter(i => i.text) };
}

function codexSessionItems({ meta, session, items }, sessions) {
  if (codexAgentSession(meta) || !items.length) return { session, items: [], words: [] };
  if (meta.forked_from_id) {
    const parent = sessions.get(meta.forked_from_id);
    if (parent) {
      let inherited = 0;
      while (inherited < items.length && inherited < parent.items.length) {
        const a = items[inherited], b = parent.items[inherited];
        if (a.text !== b.text || a.event && b.event && a.event !== b.event || a.time && b.time && a.time !== b.time) break;
        inherited++;
      }
      items = items.slice(inherited);
    } else {
      const forkedAt = Date.parse(meta.timestamp ?? "");
      items = items.filter(item => Date.parse(item.time ?? "") > forkedAt);
    }
  }
  if (!items.length || isLeadPrompt(items[0].text)) return { session, items: [], words: [] };
  return { session, items, words: numberWords(session, items, "codex") };
}

function codexWords(sessionData, roots, sessions) {
  const { items, words } = codexSessionItems(sessionData, sessions);
  return words.filter((_, i) => items[i].cwd && inside(items[i].cwd, roots));
}

export const codexSessionWords = (file, roots) => codexWords(codexMessages(file), roots, new Map());

const entries = dir => existsSync(dir) ? readdirSync(dir, { withFileTypes: true }) : [];
const jsonl = dir => entries(dir).filter(f => f.isFile() && f.name.endsWith(".jsonl")).map(f => join(dir, f.name));
const projectSessions = dir => entries(dir).filter(p => p.isDirectory()).flatMap(p => jsonl(join(dir, p.name)));
const walk = dir => [...jsonl(dir), ...entries(dir).filter(p => p.isDirectory()).flatMap(p => walk(join(dir, p.name)))];
export const claudeSlug = dir => resolve(dir).replace(/[/.]/g, "-");
const defaultClaude = () => process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
const defaultCodex = () => process.env.CODEX_HOME || join(homedir(), ".codex");

function loadCodexSessions(codexHome) {
  const rollouts = [...walk(join(codexHome, "sessions")), ...jsonl(join(codexHome, "archived_sessions"))];
  const sessions = new Map();
  for (const file of rollouts) {
    const session = codexMessages(file), prior = sessions.get(session.session);
    if (!prior || prior.items.length < session.items.length) sessions.set(session.session, session);
  }
  return sessions;
}

export function transcriptWordsReport(roots, { claudeHome = defaultClaude(), codexHome = defaultCodex(), env = process.env, home, sqliteLoader } = {}) {
  const claude = projectSessions(join(claudeHome, "projects")).flatMap(file => claudeSessionWords(file, roots));
  const sessions = loadCodexSessions(codexHome);
  const codex = [...sessions.values()].flatMap(s => codexWords(s, roots, sessions));
  const antigravity = collectAntigravityWords(roots, { env, ...(home !== undefined ? { home } : {}), ...(sqliteLoader ? { sqliteLoader } : {}) });
  const words = [...claude, ...codex, ...antigravity.words].sort((a, b) => String(a.time).localeCompare(String(b.time)));
  return { words, antigravity: { skipped: antigravity.skipped, reason: antigravity.reason } };
}

export function transcriptStoreWordsReport(storeProducts, { routeProduct, claudeHome = defaultClaude(), codexHome = defaultCodex(), env = process.env, home, sqliteLoader } = {}) {
  const byProduct = new Map(storeProducts.map(p => [p.name, { words: [], antigravity: { skipped: 0, reason: null }, unresolved: [] }]));
  const unresolved = [];
  const routeSession = (source, session, items, words) => {
    if (!items.length) return;
    const dirs = [...new Set(items.map(i => i.cwd).filter(Boolean))];
    const routed = routeProduct(dirs, storeProducts);
    if (routed.status === "skip") return;
    if (routed.status === "ambiguous") {
      unresolved.push({ status: "ambiguous", source, session, workspaces: dirs, products: routed.products ?? [], reason: routed.error });
      return;
    }
    const matched = words.filter((_, i) => items[i].cwd && inside(items[i].cwd, routed.projects));
    byProduct.get(routed.product.name).words.push(...matched);
  };
  for (const file of projectSessions(join(claudeHome, "projects"))) {
    const { session, items, words } = claudeSessionItems(file);
    routeSession("claude", session, items, words);
  }
  const sessions = loadCodexSessions(codexHome);
  for (const s of sessions.values()) {
    const { session, items, words } = codexSessionItems(s, sessions);
    routeSession("codex", session, items, words);
  }
  const ag = collectAntigravityStoreWords(storeProducts, { routeProduct, env, ...(home !== undefined ? { home } : {}), ...(sqliteLoader ? { sqliteLoader } : {}) });
  unresolved.push(...ag.unresolved);
  let totalAgSkipped = ag.storeSkipped;
  const allAgReasons = [...ag.storeReasons];
  for (const p of storeProducts) {
    const bucket = byProduct.get(p.name);
    const agBucket = ag.byProduct.get(p.name) ?? { words: [], skipped: 0, reasons: [] };
    totalAgSkipped += agBucket.skipped;
    for (const r of agBucket.reasons) if (!allAgReasons.includes(r)) allAgReasons.push(r);
    bucket.words.push(...agBucket.words);
    bucket.words.sort((a, b) => String(a.time).localeCompare(String(b.time)));
    const reasons = [...ag.storeReasons];
    for (const r of agBucket.reasons) if (!reasons.includes(r)) reasons.push(r);
    bucket.antigravity = { skipped: agBucket.skipped + ag.storeSkipped, reason: reasons.length ? reasons.join("; ") : null };
    bucket.unresolved = unresolved.filter(u => !u.products.length || u.products.includes(p.name));
  }
  return { byProduct, unresolved, antigravity: { skipped: totalAgSkipped, reason: allAgReasons.length ? allAgReasons.join("; ") : null } };
}

export function transcriptWords(roots, opts = {}) {
  return transcriptWordsReport(roots, opts).words;
}

const pendingDir = records => join(git(records, "rev-parse", "--absolute-git-dir"), "self-loop-owner-pending");
const discardedPath = path => join(path, "..", "discarded", basename(path));
export const pendingKey = prompt => basename(prompt.path, ".json");

function savePending(path, value) {
  const folder = join(path, "..");
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const draft = join(folder, `.${randomUUID()}.tmp`);
  writeFileSync(draft, JSON.stringify(value), { flag: "wx", mode: 0o600 });
  try { linkSync(draft, path); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  finally { rmSync(draft, { force: true }); }
}

export function queueOwnerPrompt(records, prompt) {
  const key = prompt.pendingKey ?? (prompt.event ? sha(JSON.stringify([prompt.session, prompt.event])) : randomUUID());
  const { pendingKey: _ignored, ...stored } = prompt;
  const path = join(pendingDir(records), `${key}.json`);
  if (!existsSync(discardedPath(path))) savePending(path, stored);
  if (!existsSync(discardedPath(path))) return path;
  rmSync(path, { force: true });
  return null;
}

function readPending(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

export function hasPendingForSession(records, session) {
  if (!session) return false;
  const dir = pendingDir(records);
  return entries(dir).some(f => {
    if (!f.isFile() || !f.name.endsWith(".json")) return false;
    const path = join(dir, f.name);
    if (existsSync(discardedPath(path))) return false;
    const prompt = readPending(path);
    return Boolean(prompt && prompt.session === session);
  });
}

function archivePending(path, prompt, note) {
  savePending(discardedPath(path), { ...prompt, note, discardedAt: new Date().toISOString() });
  rmSync(path, { force: true });
}

export function discardOwnerPrompt(records, key, note) {
  if (!/^(?:[0-9a-f]{64}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/.test(key) || !note.trim()) return false;
  const path = join(pendingDir(records), `${key}.json`);
  const prompt = readPending(path);
  if (!prompt) return false;
  archivePending(path, prompt, note);
  return true;
}

export function pendingOwnerPrompts(records, session = null) {
  const dir = pendingDir(records);
  return entries(dir).filter(f => f.isFile() && f.name.endsWith(".json")).flatMap(f => {
    const path = join(dir, f.name);
    const prompt = readPending(path);
    if (!prompt || session && prompt.session !== session) return [];
    if (existsSync(discardedPath(path))) {
      rmSync(path, { force: true });
      return [];
    }
    const text = captureOwnerText(prompt.text);
    if (text !== null) return [{ ...prompt, text, path }];
    archivePending(path, prompt, "Rejected by the current owner prompt capture filter");
    return [];
  });
}

const stepIndexOf = event => {
  const m = /^step-(\d+)$/.exec(String(event ?? ""));
  return m ? Number(m[1]) : null;
};

export function reconcileOwnerPrompts(records, words, session = null, echoes = []) {
  const pending = pendingOwnerPrompts(records, session);
  const pool = [...words, ...echoes];
  const candidates = pending.map(prompt => {
    const expectedSource = prompt.source ?? "claude";
    const textMatches = pool.filter(word => {
      if (word.source !== expectedSource || word.session !== prompt.session) return false;
      if (word.text !== prompt.text) {
        const args = word.command && prompt.text.startsWith(word.command) && prompt.text.slice(word.command.length);
        if (!args || !/^\s/.test(args) || args.trimStart() !== word.text.trimStart()) return false;
      }
      return true;
    });
    if (prompt.event) {
      const exact = textMatches.filter(word => word.event === prompt.event);
      if (exact.length || !Number.isInteger(prompt.anchorStep)) return exact;
    }
    if (expectedSource === "antigravity") {
      return textMatches.filter(word => {
        if (Number.isInteger(prompt.anchorStep)) {
          const step = stepIndexOf(word.event);
          if (step === null || step < prompt.anchorStep) return false;
        }
        const diff = Math.abs(Date.parse(word.time) - Date.parse(prompt.time));
        return Number.isFinite(diff) && diff <= 10_000;
      });
    }
    return textMatches.filter(word => {
      const afterHook = Date.parse(word.time) - Date.parse(prompt.time);
      return afterHook >= 0 && afterHook <= 2_000;
    });
  });
  const counts = new Map();
  for (const matches of candidates) for (const w of matches) counts.set(w, (counts.get(w) ?? 0) + 1);
  const unresolved = [];
  for (const [i, prompt] of pending.entries()) {
    const matches = candidates[i];
    if (matches.length === 1 && (prompt.event || counts.get(matches[0]) === 1)) rmSync(prompt.path, { force: true });
    else unresolved.push(prompt.path);
  }
  return unresolved;
}

const HARNESS_ADAPTERS = {
  claude: {
    sessionId: input => input?.session_id,
    transcriptPath: input => input?.transcript_path,
    hookSession: (...a) => claudeHookSession(...a),
    transcript: (file, projects, session) => claudeTranscript(file, projects, session),
  },
  antigravity: {
    sessionId: input => input?.conversationId,
    transcriptPath: input => input?.transcriptPath,
    hookSession: (...a) => antigravityHookSession(...a),
    transcript: (file, projects, session) => antigravityTranscript(file, projects, session),
  },
};

export function syncPromptSession(harness, records, projects, input) {
  const adapter = HARNESS_ADAPTERS[harness];
  const session = adapter.sessionId(input);
  const path = adapter.transcriptPath(input);
  const { words, echoes } = path ? adapter.transcript(path, projects, session) : { words: [], echoes: [] };
  if (words.length) appendWords(records, words);
  return { pending: reconcileOwnerPrompts(records, words, session, echoes), words, echoes };
}

export function syncClaudePromptSession(records, projects, input) {
  return syncPromptSession("claude", records, projects, input);
}

export const parseWords = text => text.split("\n").filter(Boolean).map(l => JSON.parse(l));

export const CLASSES = ["direction", "answer", "routine", "not-owner"];
export const LINKS = { direction: { flag: "intervention", pattern: /^I-\d{4}$/, form: "I-NNNN" },
  answer: { flag: "batch", pattern: /^B-\d{4}$/, form: "B-NNNN" } };

export function markProblem(mark) {
  if (typeof mark?.id !== "string" || !mark.id) return "a mark names the word's ID";
  if (!CLASSES.includes(mark.as)) return `--as must be ${CLASSES.join(", ")}`;
  const link = LINKS[mark.as];
  if (link && !link.pattern.test(mark[link.flag] ?? "")) return `--as ${mark.as} needs --${link.flag} ${link.form}`;
  for (const other of Object.values(LINKS))
    if (other !== link && mark[other.flag] !== undefined) return `--${other.flag} belongs to --as ${Object.keys(LINKS).find(k => LINKS[k] === other)}`;
  return null;
}

export const sameClass = (a, b) => a?.as === b?.as && (LINKS[a.as] ? a[LINKS[a.as].flag] === b[LINKS[a.as].flag] : true);

export function wordClasses(marks) {
  const latest = new Map();
  for (const mark of marks) if (!markProblem(mark)) latest.set(mark.id, mark);
  return latest;
}

export const committedWords = records => parseWords(recordsSnapshot(records).read(WORDS));

export function appendWords(records, words, { message = null, attempts = 5 } = {}) {
  const { commit, value: added } = commitRecords(records, ({ read, add }) => {
    const old = read(WORDS);
    const known = new Map(parseWords(old).map(w => [w.id, w]));
    const fresh = [];
    for (const word of words) {
      if (known.has(word.id)) continue;
      const matches = (id, text) => {
        const prior = known.get(id);
        return prior && !prior.event && prior.source === word.source && prior.session === word.session
          && prior.text === text && Math.abs(Date.parse(prior.time) - Date.parse(word.time)) <= 2_000;
      };
      if (matches(word.legacyId, word.text) || matches(word.trimmedId, word.text.trim())) continue;
      known.set(word.id, word);
      fresh.push(word);
    }
    if (fresh.length) add(WORDS, appendJsonLines(old, fresh));
    return { message: message ?? `owner: record ${fresh.length} word(s) verbatim`, value: fresh.length };
  }, { attempts });
  return { added, commit };
}

const QUOTE_RECORD_RE = /^(?:purpose\/(P-\d{4})|decisions\/(D-\d{4})|interventions\/(I-\d{4})|blueprint\/(F-\d{4}))\.md$/;
const WORD_CITE_RE = /(?<![\w-])W-[0-9a-zA-Z]+(?![\w-])/g;
const normQuote = text => String(text ?? "").replace(/\s+/g, " ").trim();

function quoteClauses(text) {
  const out = [];
  for (const part of String(text ?? "").split(/(?:\r?\n|[。！？!?；;，,：:]|\.(?:\s|$))+/)) {
    const norm = normQuote(part);
    if (norm.length >= 16) out.push(norm);
  }
  return out;
}

export function findVerbatimQuoteMatches(state, openList) {
  if (!state || !Array.isArray(openList) || !openList.length) return [];
  const snap = typeof state === "string" ? recordsSnapshot(state) : state;
  const paths = snap.files instanceof Map ? [...snap.files.keys()] : [...(snap.files ?? [])];
  const records = [];
  for (const path of paths.sort()) {
    const m = QUOTE_RECORD_RE.exec(path);
    if (!m) continue;
    const raw = snap.read(path) ?? "";
    if (!raw) continue;
    const cited = new Set([...raw.matchAll(WORD_CITE_RE)].map(x => x[0]));
    const quotedSpans = [...raw.matchAll(/(?:「([^」]{16,})」|“([^”]{16,})”|"([^"\r\n]{16,})")/g)]
      .map(x => normQuote(x[1] ?? x[2] ?? x[3])).filter(s => s.length >= 16);
    records.push({ recordId: m[1] || m[2] || m[3] || m[4], path, norm: normQuote(raw), cited, quotedSpans });
  }
  const matches = [];
  for (const w of openList) {
    const rawText = w?.text ?? w?.words ?? "";
    const norm = normQuote(rawText);
    if (norm.length < 10) continue;
    const clauses = norm.length >= 16 ? quoteClauses(rawText) : [];
    for (const rec of records) {
      if (rec.cited.has(w.id)) continue;
      if (rec.norm.includes(norm) || clauses.some(c => rec.norm.includes(c))
        || (norm.length >= 16 && rec.quotedSpans.some(span => norm.includes(span)))) {
        matches.push({ wordId: w.id, recordId: rec.recordId, path: rec.path });
      }
    }
  }
  return matches;
}
