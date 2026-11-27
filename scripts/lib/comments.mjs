// D-0016, D-0023, F-0015, P-0014, P-0015, R-0006-judge, design/driver.md#comments
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { directiveOf, isPointer } from "./directives.mjs";
import { blobs, git, regularFiles, run } from "./git-plumbing.mjs";
import { HANDOFFS, parseHandoffs } from "./handoff.mjs";
import { establishedJs, LEXERS, lexJs, lexicalCoverage } from "./lexers.mjs";

export { DIRECTIVES, directiveOf, isPointer, REFERENCE } from "./directives.mjs";
export { LEXERS, SQL_READINGS } from "./lexers.mjs";

const EXTENSIONS = {
  js: "js", jsx: "js", tsx: "js", mjs: "js", cjs: "js", ts: "js", mts: "js", cts: "js", swift: "swift",
  sh: "shell", bash: "shell", zsh: "shell", ksh: "shell", yml: "yaml", yaml: "yaml", py: "python", pyi: "python",
  sql: "sql", css: "css", html: "html", htm: "html",
  go: "go", rs: "rust", c: "c", h: "c", cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp",
  java: "java", kt: "kotlin", kts: "kotlin", toml: "toml",
};
const INTERPRETERS = [[/^(?:node|nodejs|deno|bun)$/, "js"], [/^(?:sh|bash|zsh|dash|ksh)$/, "shell"], [/^python[\d.]*$/, "python"]];

function interpreter(text) {
  const first = /^#!\s*(\S+)([^\n]*)/.exec(text);
  if (!first) return null;
  let name = first[1].split("/").pop();
  if (name === "env") name = first[2].trim().split(/\s+/).find(word => word && !word.startsWith("-") && !word.includes("=")) ?? "";
  return INTERPRETERS.find(([pattern]) => pattern.test(name))?.[1] ?? null;
}

export function languageOf(path, text = "") {
  const name = path.split("/").pop();
  const dot = name.lastIndexOf(".");
  if (dot > 0) return EXTENSIONS[name.slice(dot + 1).toLowerCase()] ?? null;
  if (/(?:^|\/)\.githooks\/[^/]+$/.test(path)) return "shell";
  return interpreter(text);
}

export const commentCandidate = path => {
  const name = path.split("/").pop();
  const dot = name.lastIndexOf(".");
  return dot <= 0 || Boolean(EXTENSIONS[name.slice(dot + 1).toLowerCase()]);
};

const DECORATION = { "//": /^\/+/, "#": /^#+/, "--": /^-+/ };

function normalize(piece, open, close, first, last) {
  let text = piece;
  if (first && text.startsWith(open)) text = text.slice(open.length);
  if (last && close && text.endsWith(close)) text = text.slice(0, -close.length);
  text = text.trim();
  if (open === "/*") text = text.replace(/^(?:\/?\*+\s*)+/, "").replace(/(?:\s*\*+\/?)+$/, "").trim();
  else if (first && DECORATION[open]) text = text.replace(DECORATION[open], "").trim();
  return text;
}

const TYPESCRIPT = /\.[mc]?ts$/i;
const UNIVERSAL_DIRECTIVES = new Set(["interpreter", "vim-modeline", "emacs-file-variables", "spdx", "noinspection", "cspell"]);
const CLANG_FORMAT_LANGUAGES = new Set(["c", "cpp", "java"]);
const UNIVERSAL_PROXY = { go: "js", rust: "js", c: "js", cpp: "js", java: "js", kotlin: "js", toml: "shell" };

function resolveDirective(span, raw, ctx) {
  const direct = directiveOf(span, raw, ctx);
  if (direct) return direct;
  const proxy = UNIVERSAL_PROXY[ctx.language];
  if (!proxy) return null;
  const candidate = directiveOf(span, raw, { ...ctx, language: proxy });
  if (!candidate) return null;
  return UNIVERSAL_DIRECTIVES.has(candidate.id) || (candidate.id === "clang-format" && CLANG_FORMAT_LANGUAGES.has(ctx.language))
    ? candidate : null;
}

export function commentLines(text, language, { path = "", spans: establishedSpans } = {}) {
  const lexer = LEXERS[language];
  if (!lexer) return [];
  const starts = [0];
  for (let at = text.indexOf("\n"); at >= 0; at = text.indexOf("\n", at + 1)) starts.push(at + 1);
  const lineOf = offset => {
    let low = 0, high = starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (starts[mid] <= offset) low = mid; else high = mid - 1;
    }
    return low;
  };
  const spans = establishedSpans ?? (language === "js" ? (establishedJs(text) ?? lexJs(text, 0, text.length, { jsx: !TYPESCRIPT.test(path) })) : lexer(text));
  const firstLine = text.slice(0, starts.length > 1 ? starts[1] - 1 : text.length);
  const lines = new Map();
  let code = false, previous = 0;
  for (const span of spans) {
    if (span.end <= span.start) continue;
    if (!code && text.slice(previous, span.start).trim()) code = true;
    previous = Math.max(previous, span.end);
    const firstIndex = lineOf(span.start), lastIndex = lineOf(span.end - 1);
    const raw = text.slice(span.start, span.end).replace(/\r(?=\n)|\r$/g, "");
    const directive = resolveDirective(span, raw, { path, language: span.language ?? language, line: firstIndex + 1, lines: starts.length,
      column: span.start - starts[firstIndex], own: !text.slice(starts[firstIndex], span.start).trim(), head: span.head ?? !code, firstLine });
    for (let n = firstIndex; n <= lastIndex; n++) {
      const lineStart = starts[n], lineStop = n + 1 < starts.length ? starts[n + 1] - 1 : text.length;
      const piece = text.slice(Math.max(span.start, lineStart), Math.min(span.end, lineStop)).replace(/\r$/, "");
      const words = span.kind === "hashbang" ? piece : normalize(piece, span.open, span.close, n === firstIndex, n === lastIndex);
      const kind = directive ? "directive" : isPointer(words) ? "pointer" : "prose";
      if (!lines.has(n + 1)) lines.set(n + 1, []);
      lines.get(n + 1).push({ raw: piece, text: words, kind, ...(directive ? { rule: directive.id } : {}) });
    }
  }
  return [...lines].sort((a, b) => a[0] - b[0]).map(([line, pieces]) => ({ line, pieces }));
}

export function proseLines(path, text, { resolutions = [] } = {}) {
  if (text === null || text === undefined) return [];
  const language = languageOf(path, text);
  if (!language) return [];
  const coverage = lexicalCoverage(text, language, { path });
  const source = createHash("sha256").update(text).digest("hex");
  const decide = (line, words, scope) => {
    const candidate = { path, source, line, rule: "D-0016", contract: "comment-admission-v2", scope, language, text: words };
    const matching = resolutions.filter(r => Object.entries(candidate).every(([k, v]) => r[k] === v)
      && typeof r.evidence === "string" && r.evidence.trim());
    const negatives = matching.filter(r => r.verdict === "prose");
    if (negatives.length) {
      if (scope === "comment") return [{ line, text: words }];
      const inventories = negatives.map(r => Array.isArray(r.proseComments) && r.proseComments.length
        && r.proseComments.every(s => typeof s === "string" && s.trim()) ? [...r.proseComments].sort() : null).filter(Boolean);
      const inventory = inventories[0];
      const complete = inventory && inventories.every(i => JSON.stringify(i) === JSON.stringify(inventory));
      return [{ ...candidate, ...(complete ? { proseComments: inventory } : {}) }];
    }
    const admitted = scope === "source" ? ["compliant"] : ["literal", "directive", "pointer"];
    if (matching.length && matching.every(r => admitted.includes(r.verdict))) return [];
    return [{ ...candidate, status: "pending" }];
  };
  if (coverage.confidence !== "established") {
    return decide(1, `Full-source lexical coverage is not established for ${language}.`, "source");
  }
  return commentLines(text, language, { path, spans: coverage.spans }).flatMap(({ line, pieces }) => {
    const prose = pieces.filter(p => p.kind === "prose");
    return prose.length ? decide(line, prose.map(p => p.text).join(" "), "comment") : [];
  });
}

const ALIGN_CELLS = 4_000_000;

function align(before, after) {
  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) head++;
  let tail = 0;
  while (tail < before.length - head && tail < after.length - head && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++;
  const a = before.slice(head, before.length - tail), b = after.slice(head, after.length - tail);
  const added = [], removed = [];
  if ((a.length + 1) * (b.length + 1) > ALIGN_CELLS) {
    const left = new Map();
    a.forEach((text, k) => left.set(text, [...(left.get(text) ?? []), k]));
    const matched = new Set();
    b.forEach((text, k) => {
      const free = left.get(text);
      if (free?.length) matched.add(free.shift());
      else added.push(head + k);
    });
    a.forEach((_, k) => { if (!matched.has(k)) removed.push(head + k); });
    return { added, removed };
  }
  const width = b.length + 1;
  const table = new Uint32Array((a.length + 1) * width);
  for (let x = a.length - 1; x >= 0; x--)
    for (let y = b.length - 1; y >= 0; y--)
      table[x * width + y] = a[x] === b[y] ? table[(x + 1) * width + y + 1] + 1 : Math.max(table[(x + 1) * width + y], table[x * width + y + 1]);
  let x = 0, y = 0;
  while (x < a.length && y < b.length) {
    if (a[x] === b[y]) { x++; y++; }
    else if (table[(x + 1) * width + y] >= table[x * width + y + 1]) removed.push(head + x++);
    else added.push(head + y++);
  }
  while (x < a.length) removed.push(head + x++);
  while (y < b.length) added.push(head + y++);
  return { added, removed };
}

export function addedProse(files, options = {}) {
  const additions = [], pool = new Map();
  for (const { path, before, after } of files) {
    const old = proseLines(path, before, options), next = proseLines(path, after, options);
    if (old.length === 1 && next.length === 1 && old[0].scope === "source" && next[0].scope === "source"
        && old[0].proseComments && next[0].proseComments) {
      const available = [...old[0].proseComments];
      const noAddition = next[0].proseComments.every(text => {
        const index = available.indexOf(text);
        if (index < 0) return false;
        available.splice(index, 1);
        return true;
      });
      if (noAddition) continue;
    }
    const key = l => l.status === "pending" || l.scope === "source" ? JSON.stringify(l) : l.text;
    const { added, removed } = align(old.map(key), next.map(key));
    for (const k of removed.filter(k => old[k].status !== "pending" && old[k].scope !== "source")) pool.set(old[k].text, (pool.get(old[k].text) ?? 0) + 1);
    for (const k of added) additions.push({ path, ...next[k] });
  }
  return additions.filter(addition => {
    if (addition.status === "pending" || addition.scope === "source") return true;
    const left = pool.get(addition.text) ?? 0;
    if (!left) return true;
    pool.set(addition.text, left - 1);
    return false;
  });
}

// F-0015, P-0014, P-0015, R-0055-judge-frame-hygiene
const MAX_PROSE_CACHE = 16;
const RES_PATH_RE = /^sealed\/judge\/\d{4}\/[A-Za-z0-9._-]+-\d+\/out\/comment-resolutions\.json$/;

export class ProseBudgetExceededError extends Error {
  constructor(reason) {
    super(reason);
    this.name = "ProseBudgetExceededError";
    this.code = "PROSE_BUDGET_EXCEEDED";
    this.deferred = true;
    this.reason = reason;
  }
}

function gitShowRaw(repo, spec) {
  const r = spawnSync("git", ["-C", repo, "--no-replace-objects", "show", spec],
    { encoding: "utf8", maxBuffer: 1 << 30, env: { GIT_TERMINAL_PROMPT: "0", ...process.env } });
  return r.status === 0 ? r.stdout : null;
}

function batchCatFiles(repo, specs) {
  if (!specs.length) return [];
  const out = run("git", ["-C", repo, "--no-replace-objects", "cat-file", "--batch"], { input: `${specs.join("\n")}\n` });
  const result = [];
  let at = 0;
  for (let i = 0; i < specs.length; i++) {
    const nl = out.indexOf(10, at), m = /^[0-9a-f]{40} (\S+) (\d+)$/.exec(out.subarray(at, nl).toString("utf8"));
    if (!m) { result.push(null); at = nl + 1; continue; }
    const size = Number(m[2]), start = nl + 1;
    result.push(m[1] === "blob" ? out.subarray(start, start + size) : null);
    at = start + size + 1;
  }
  return result;
}

export function proseCacheDir(repo) {
  try {
    const commonDir = realpathSync(git(repo, "--no-replace-objects", "rev-parse", "--path-format=absolute", "--git-common-dir"));
    const cacheRoot = process.env.SELF_LOOP_CACHE_DIR || join(tmpdir(), "self-loop-cache");
    const repoKey = createHash("sha256").update(commonDir).digest("hex").slice(0, 16);
    return join(cacheRoot, repoKey, "prose-cache");
  } catch { return null; }
}

function proseCachePaths(repo, treeish, resolutions) {
  try {
    const dir = proseCacheDir(repo);
    if (!dir) return null;
    const treeOid = git(repo, "--no-replace-objects", "rev-parse", `${treeish}^{tree}`);
    const resDigest = createHash("sha256").update(JSON.stringify(resolutions)).digest("hex");
    return { treeOid, resDigest, dir, file: join(dir, `prose-${treeOid}-${resDigest.slice(0, 16)}.json`) };
  } catch { return null; }
}

function writeProseCache(info, lines) {
  if (!info) return;
  const tmp = join(info.dir, `.prose-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`);
  try {
    mkdirSync(info.dir, { recursive: true });
    writeFileSync(tmp, `${JSON.stringify({ treeOid: info.treeOid, resDigest: info.resDigest, lines })}\n`);
    renameSync(tmp, info.file);
    const kept = readdirSync(info.dir).filter(n => n.startsWith("prose-") && n.endsWith(".json"))
      .map(n => { const p = join(info.dir, n); try { return { p, t: statSync(p).mtimeMs }; } catch { return null; } })
      .filter(Boolean).sort((a, b) => b.t - a.t || b.p.localeCompare(a.p));
    for (const old of kept.slice(MAX_PROSE_CACHE)) { try { unlinkSync(old.p); } catch {} }
  } catch { try { unlinkSync(tmp); } catch {} }
}

export function proseInTree(repo, treeish, { records, cache = false, maxFiles = null, maxMs = null, deferOnBudget = false } = {}) {
  const resolutions = records ? commentResolutions(records) : [];
  const cacheInfo = cache ? proseCachePaths(repo, treeish, resolutions) : null;
  if (cacheInfo) {
    try {
      const cached = JSON.parse(readFileSync(cacheInfo.file, "utf8"));
      if (cached && cached.treeOid === cacheInfo.treeOid && cached.resDigest === cacheInfo.resDigest && Array.isArray(cached.lines))
        return deferOnBudget ? { lines: cached.lines, deferred: false, reason: null, cached: true } : cached.lines;
    } catch {}
  }
  const defer = reason => { if (deferOnBudget) return { lines: null, deferred: true, reason }; throw new ProseBudgetExceededError(reason); };
  const startedAt = Date.now(), entries = regularFiles(repo, treeish).filter(entry => commentCandidate(entry.path));
  if (Number.isFinite(maxFiles) && maxFiles >= 0 && entries.length > maxFiles)
    return defer(`proseInTree deferred: ${entries.length} candidate files exceed budget (${maxFiles})`);
  const overTime = () => Number.isFinite(maxMs) && maxMs >= 0 && (maxMs === 0 ? true : Date.now() - startedAt > maxMs);
  if (entries.length && overTime()) return defer(`proseInTree deferred: elapsed ${Date.now() - startedAt}ms exceeded budget (${maxMs}ms)`);
  const contents = blobs(repo, entries.map(entry => entry.sha)), lines = [];
  for (let k = 0; k < entries.length; k++) {
    if (overTime()) return defer(`proseInTree deferred: elapsed ${Date.now() - startedAt}ms exceeded budget (${maxMs}ms)`);
    for (const line of proseLines(entries[k].path, contents[k].toString("utf8"), { resolutions })) lines.push({ path: entries[k].path, ...line });
  }
  const pending = lines.filter(line => line.status === "pending");
  if (pending.length) throw new Error(`pending independent comment resolution (D-0016): ${JSON.stringify(pending)}`);
  writeProseCache(cacheInfo, lines);
  return deferOnBudget ? { lines, deferred: false, reason: null, cached: false } : lines;
}

// R-0008-judge-frame, D-0016, F-0015, P-0014, P-0015, R-0055-judge-frame-hygiene
export function commentResolutions(records) {
  const rawHandoffs = gitShowRaw(records, `HEAD:${HANDOFFS}`);
  if (!rawHandoffs) return [];
  const handoffs = parseHandoffs(rawHandoffs);
  const authors = new Set(handoffs.filter(h => h.role !== "judge").map(h => h.agent?.session).filter(Boolean));
  const candidates = [];
  for (const h of handoffs) {
    if (h.role !== "judge" || !Array.isArray(h.files) || !h.files.some(f => RES_PATH_RE.test(f))) continue;
    if (h.audit.violations !== 0 || authors.has(h.agent?.session)) continue;
    const prefix = `sealed/judge/${String(h.round).padStart(4, "0")}/${h.step}-${h.attempt}`;
    const file = `${prefix}/out/comment-resolutions.json`, auditFile = `${prefix}-audit.json`;
    if (!h.files.includes(file) || !h.files.includes(auditFile)) continue;
    candidates.push({ h, key: `${h.id}:${h.attempt}`, file, auditFile });
  }
  if (!candidates.length) return [];
  const commits = git(records, "--no-replace-objects", "log", "--first-parent", "--reverse", "--format=%H", "HEAD", "--", HANDOFFS)
    .split("\n").filter(Boolean);
  const wanted = new Set(candidates.map(c => c.key)), publications = new Map();
  const handoffBlobs = batchCatFiles(records, commits.map(c => `${c}:${HANDOFFS}`));
  for (let i = 0; i < commits.length && publications.size < wanted.size; i++) {
    if (!handoffBlobs[i]) continue;
    for (const ph of parseHandoffs(handoffBlobs[i].toString("utf8"))) {
      const key = `${ph.id}:${ph.attempt}`;
      if (wanted.has(key) && !publications.has(key)) publications.set(key, { h: ph, commit: commits[i] });
    }
  }
  const matched = candidates.map(c => ({ ...c, pub: publications.get(c.key) })).filter(c => c.pub && isDeepStrictEqual(c.pub.h, c.h));
  if (!matched.length) return [];
  const fetched = batchCatFiles(records, matched.flatMap(c => [`${c.pub.commit}:${c.auditFile}`, `${c.pub.commit}:${c.file}`]));
  const resolutions = [];
  for (let i = 0; i < matched.length; i++) {
    const { h } = matched[i], auditBuf = fetched[i * 2], resBuf = fetched[i * 2 + 1];
    if (!auditBuf || !resBuf) continue;
    try {
      const audit = JSON.parse(auditBuf.toString("utf8"));
      if (audit.id !== h.id || audit.role !== "judge" || audit.attempt !== h.attempt || audit.exit !== 0 || audit.agent?.runner !== h.agent?.runner || audit.agent?.session !== h.agent?.session) continue;
      const rows = JSON.parse(resBuf.toString("utf8"));
      if (!Array.isArray(rows)) continue;
      for (const row of rows) {
        if (row.rule !== "D-0016" || !/^[a-f0-9]{64}$/.test(row.source ?? "") || typeof row.evidence !== "string" || !row.evidence.trim()
          || row.contract !== "comment-admission-v2" || !["comment", "source"].includes(row.scope)
          || !["literal", "directive", "pointer", "prose", "compliant"].includes(row.verdict)) continue;
        resolutions.push({ ...row, judge: h.id });
      }
    } catch {}
  }
  return resolutions;
}
