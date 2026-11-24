// P-0011, D-0058, design/two-loop-rhythm.md#6
import { posix } from "node:path";
import { commentLines, isPointer, languageOf } from "./comments.mjs";

export const ANTI_ROT_THRESHOLDS = Object.freeze({
  maxProseCommentLines: 12,
  maxCommentRatio: 0.25,
});

const STALE_BRIDGE_TOKENS = new Set(["legacy", "compat", "compatibility", "shim", "fallback", "deprecated"]);
const AUDIT_TERMS = new Set(["remnant", "remnants", "breach", "breaches"]);
const REGEX_AFTER = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await", "extends", "default"]);
const REGEX_PUNCT = new Set(["(", "[", "{", ",", ";", ":", "?", "!", "=", "&", "|", "^", "~", "+", "-", "*", "%", "<", ">"]);
const JS_TS_RE = /\.[cm]?[jt]sx?$/i;
const ENTRYPOINT_RE = /(^|\/)(index|main|cli)\.[cm]?[jt]sx?$/i;
const CONFIG_EXAMPLE_RE = /(?:^|\/)(?:config|examples?|fixtures?)\/|(?:^|\/)(?:[^/]*\.)?(?:config|defaults?|example|sample|template)\.[cm]?[jt]sx?$/i;
const HOST_HOME_RE = /(?:\/home\/[a-zA-Z0-9._-]+\/|\/Users\/[a-zA-Z0-9._-]+\/)/;
const LOOPBACK_PORT_RE = /\b(?:localhost|127\.0\.0\.1):\d{2,5}\b/;
const TEST_DOT_ROT_RE = /\b(?:test|it|describe)\.(skip|todo)\s*\(/;
const TEST_OPT_ROT_RE = /\{[^}\n]*\b(skip|todo)\s*:\s*(?:true|['"`])/;
const EXPORT_DECL_RE = /\bexport\s+(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g;
const EXPORT_LIST_RE = /\bexport\s+(?:type\s+)?\{([^}]+)\}/g;
const IMPORT_NAMED_RE = /\b(?:import|export)\s+(?:type\s+)?(?:[A-Za-z_$][A-Za-z0-9_$]*\s*,\s*)?\{([^}]+)\}\s+from\s+["']([^"']+)["']/g;
const IMPORT_NS_RE = /\b(?:import|export)\s+\*(?:\s+as\s+[A-Za-z_$][A-Za-z0-9_$]*)?\s+from\s+["']([^"']+)["']/g;
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*["'](\.\.?\/[^"']+)["']\s*\)/g;
const RESOLVE_EXTS = [".js", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"];
const DOC_POINTER_RE = /(?:^|[\s,;:()[\]])(?:self-loop[\s:]+)?(?:(?:D|P|F|L|I|B|T|PR)-\d{4,}|R-\d{4,}(?:-[a-z]+)*|SL-\d{2,}|W-[0-9a-f]{10}|(?:design|docs|purpose|decisions|interventions|lessons|plans)\/[\w./-]+\.md(?:#[\p{L}\p{N}_.-]+)?)(?=$|[\s,;:()[\]])/gu;
const POINTER_SEP_RE = /^[\s,;:./|·*=#~+_()[\]<>!&-]*$/u;
const LICENSE_RE = /^(?:SPDX-License-Identifier:|Copyright\b|Licensed under\b)/i;

const splitSubwords = token => token
  .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
  .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
  .split(/[^a-zA-Z0-9]+/)
  .filter(Boolean)
  .map(w => w.toLowerCase());

const blankInner = s => s.length >= 2 ? s[0] + s.slice(1, -1).replace(/[^\n]/g, " ") + s[s.length - 1] : s;

function scanRegexEnd(text, start) {
  let inClass = false;
  for (let i = start + 1, n = text.length; i < n; i++) {
    const ch = text[i];
    if (ch === "\n" || ch === "\r") return -1;
    if (ch === "\\") { i++; continue; }
    if (inClass) { if (ch === "]") inClass = false; continue; }
    if (ch === "[") { inClass = true; continue; }
    if (ch === "/") {
      let end = i + 1;
      while (end < n && /[a-z]/i.test(text[end])) end++;
      return end;
    }
  }
  return -1;
}

function stripSyntax(text, { strings = false, comments = false } = {}) {
  let out = "", regexOk = true, inTpl = false;
  const tplBraces = [];
  for (let i = 0, n = text.length; i < n;) {
    const ch = text[i], next = text[i + 1];
    if (inTpl) {
      if (ch === "\\" && i + 1 < n) { out += strings ? (next === "\n" ? " \n" : "  ") : text.slice(i, i + 2); i += 2; continue; }
      if (ch === "`") { out += "`"; i++; inTpl = false; regexOk = false; continue; }
      if (ch === "$" && next === "{") { out += "${"; i += 2; inTpl = false; tplBraces.push(0); regexOk = true; continue; }
      out += strings && ch !== "\n" ? " " : ch; i++; continue;
    }
    if (ch === "/" && next === "/") {
      const stop = text.indexOf("\n", i), end = stop < 0 ? n : stop;
      out += comments ? " ".repeat(end - i) : text.slice(i, end); i = end; continue;
    }
    if (ch === "/" && next === "*") {
      const stop = text.indexOf("*/", i + 2), end = stop < 0 ? n : stop + 2;
      out += comments ? text.slice(i, end).replace(/[^\n]/g, " ") : text.slice(i, end); i = end; continue;
    }
    if (ch === "/" && regexOk) {
      const end = scanRegexEnd(text, i);
      if (end > i) { const chunk = text.slice(i, end); out += strings ? blankInner(chunk) : chunk; i = end; regexOk = false; continue; }
    }
    if (ch === '"' || ch === "'") {
      const start = i++;
      while (i < n && text[i] !== ch && text[i] !== "\n") i += text[i] === "\\" && i + 1 < n ? 2 : 1;
      if (i < n && text[i] === ch) i++;
      const chunk = text.slice(start, i);
      out += strings ? blankInner(chunk) : chunk; regexOk = false; continue;
    }
    if (ch === "`") { out += "`"; i++; inTpl = true; continue; }
    if (ch === "{" && tplBraces.length) { tplBraces[tplBraces.length - 1]++; out += ch; i++; regexOk = true; continue; }
    if (ch === "}" && tplBraces.length) {
      if (tplBraces[tplBraces.length - 1] === 0) { tplBraces.pop(); out += ch; i++; inTpl = true; continue; }
      tplBraces[tplBraces.length - 1]--; out += ch; i++; regexOk = false; continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      const start = i++;
      while (i < n && /[A-Za-z0-9_$]/.test(text[i])) i++;
      const word = text.slice(start, i);
      out += word; regexOk = REGEX_AFTER.has(word); continue;
    }
    out += ch; i++;
    if (!/\s/.test(ch)) regexOk = REGEX_PUNCT.has(ch);
  }
  return out;
}

function resolveRelative(fromPath, spec, known) {
  if (!spec.startsWith("./") && !spec.startsWith("../")) return null;
  const base = posix.normalize(posix.join(posix.dirname(fromPath), spec));
  if (base.startsWith("..")) return null;
  if (known.has(base)) return base;
  for (const ext of RESOLVE_EXTS) {
    if (known.has(base + ext)) return base + ext;
    const idx = posix.join(base, `index${ext}`);
    if (known.has(idx)) return idx;
  }
  const stem = base.replace(/\.[cm]?js$/i, "");
  if (stem !== base) {
    for (const ext of [".ts", ".tsx", ".mts", ".cts"]) if (known.has(stem + ext)) return stem + ext;
  }
  return null;
}

function scanCompatRemnants(sourceFiles) {
  const hits = [], seen = new Set();
  for (const { path, text } of sourceFiles) {
    if (splitSubwords(path).some(t => STALE_BRIDGE_TOKENS.has(t))) {
      seen.add(`${path}\0filename`);
      hits.push({ path, line: 0, kind: "filename", marker: posix.basename(path) });
    }
    const lines = stripSyntax(text, { strings: true, comments: true }).split("\n");
    for (let i = 0; i < lines.length; i++) {
      for (const [ident] of lines[i].matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)) {
        const sub = splitSubwords(ident);
        if (!sub.some(t => STALE_BRIDGE_TOKENS.has(t)) || sub.some(t => AUDIT_TERMS.has(t))) continue;
        const key = `${path}\0${ident.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        hits.push({ path, line: i + 1, kind: "identifier", marker: ident });
      }
    }
  }
  return hits.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.marker.localeCompare(b.marker));
}

function scanDeadExports(sourceFiles, testFiles) {
  const allFiles = [...sourceFiles, ...testFiles];
  const known = new Set(allFiles.map(f => f.path));
  const targetSymbols = new Set(), nsTargets = new Set(), bareNames = new Set();

  for (const { path, text } of allFiles) {
    if (!JS_TS_RE.test(path)) continue;
    const code = stripSyntax(text, { comments: true });
    for (const m of code.matchAll(IMPORT_NAMED_RE)) {
      const target = resolveRelative(path, m[2], known);
      for (const raw of m[1].split(",")) {
        const name = raw.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim();
        if (!name || name === "default") continue;
        if (target && target !== path) targetSymbols.add(`${target}\0${name}`);
        else if (!m[2].startsWith("./") && !m[2].startsWith("../")) bareNames.add(name);
      }
    }
    for (const re of [IMPORT_NS_RE, DYNAMIC_IMPORT_RE]) {
      for (const m of code.matchAll(re)) {
        const target = resolveRelative(path, m[1], known);
        if (target && target !== path) nsTargets.add(target);
      }
    }
  }

  const dead = [];
  for (const { path, text } of sourceFiles) {
    if (!JS_TS_RE.test(path) || text.startsWith("#!") || ENTRYPOINT_RE.test(path) || nsTargets.has(path)) continue;
    const code = stripSyntax(text, { strings: true, comments: true });
    const exported = new Set();
    for (const m of code.matchAll(EXPORT_DECL_RE)) exported.add(m[1]);
    for (const m of code.matchAll(EXPORT_LIST_RE)) {
      for (const raw of m[1].split(",")) {
        const parts = raw.trim().replace(/^type\s+/, "").split(/\s+as\s+/);
        const name = (parts[1] ?? parts[0]).trim();
        if (name && name !== "default") exported.add(name);
      }
    }
    for (const symbol of [...exported].sort()) {
      if (!targetSymbols.has(`${path}\0${symbol}`) && !bareNames.has(symbol)) dead.push({ path, symbol });
    }
  }
  return dead.sort((a, b) => a.path.localeCompare(b.path) || a.symbol.localeCompare(b.symbol));
}

function scanHardcodedLiterals(sourceFiles) {
  const hits = [], seen = new Set();
  for (const { path, text } of sourceFiles) {
    if (CONFIG_EXAMPLE_RE.test(path)) continue;
    const lines = stripSyntax(text, { comments: true }).split("\n");
    for (let i = 0; i < lines.length; i++) {
      for (const [kind, re] of [["host-path", HOST_HOME_RE], ["loopback-port", LOOPBACK_PORT_RE]]) {
        const m = re.exec(lines[i]);
        if (!m) continue;
        const key = `${path}\0${kind}\0${m[0]}`;
        if (seen.has(key)) continue;
        seen.add(key);
        hits.push({ path, line: i + 1, kind, match: m[0] });
      }
    }
  }
  return hits.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.kind.localeCompare(b.kind));
}

function scanTestRot(testFiles) {
  const hits = [], seen = new Set();
  for (const { path, text } of testFiles) {
    const lines = stripSyntax(text, { strings: true, comments: true }).split("\n");
    for (let i = 0; i < lines.length; i++) {
      for (const re of [TEST_DOT_ROT_RE, TEST_OPT_ROT_RE]) {
        const m = re.exec(lines[i]);
        if (!m) continue;
        const key = `${path}\0${i + 1}\0${m[1]}`;
        if (seen.has(key)) continue;
        seen.add(key);
        hits.push({ path, line: i + 1, kind: m[1] });
      }
    }
  }
  return hits.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.kind.localeCompare(b.kind));
}

const isPointerText = words => !words || isPointer(words) || POINTER_SEP_RE.test(words.replace(DOC_POINTER_RE, " "));

function scanCommentBloat(sourceFiles, limits) {
  const hits = [];
  for (const { path, text } of sourceFiles) {
    const lang = languageOf(path, text) ?? (/\.(?:go|rs)$/i.test(path) ? "js" : null);
    if (!lang) continue;
    const rawLines = text.split("\n");
    let proseLines = 0, commentOnly = 0;
    for (const { line, pieces } of commentLines(text, lang, { path })) {
      let rest = rawLines[line - 1] ?? "";
      for (const p of pieces) rest = rest.replace(p.raw, "");
      if (!rest.trim()) commentOnly++;
      if (pieces.some(p => p.kind === "prose" && !isPointerText(p.text) && !LICENSE_RE.test(p.text))) proseLines++;
    }
    const codeLines = Math.max(1, rawLines.filter(l => l.trim().length > 0).length - commentOnly);
    const ratio = Math.round((proseLines / codeLines) * 1000) / 1000;
    if (proseLines > limits.maxProseCommentLines || (proseLines >= 6 && ratio >= limits.maxCommentRatio)) {
      hits.push({ path, proseLines, codeLines, ratio });
    }
  }
  return hits.sort((a, b) => b.proseLines - a.proseLines || a.path.localeCompare(b.path));
}

export function scanAntiRot({ sourceFiles = [], testFiles = [], thresholds = ANTI_ROT_THRESHOLDS } = {}) {
  const limits = { ...ANTI_ROT_THRESHOLDS, ...thresholds };
  return {
    compatRemnants: scanCompatRemnants(sourceFiles),
    deadExports: scanDeadExports(sourceFiles, testFiles),
    hardcodedLiterals: scanHardcodedLiterals(sourceFiles),
    testRot: scanTestRot(testFiles),
    commentBloat: scanCommentBloat(sourceFiles, limits),
  };
}

export function antiRotBreaches(antiRot, { includeDeadExports = false } = {}) {
  if (!antiRot) return [];
  return [
    ...(antiRot.compatRemnants ?? []).map(i => ({
      kind: "compat-remnant", path: i.path,
      detail: i.line > 0 ? `${i.kind} "${i.marker}" at line ${i.line}` : `${i.kind} "${i.marker}"`,
    })),
    ...(includeDeadExports ? (antiRot.deadExports ?? []).map(i => ({
      kind: "dead-export", path: i.path, detail: `exported symbol "${i.symbol}" has 0 internal importers`,
    })) : []),
    ...(antiRot.hardcodedLiterals ?? []).map(i => ({
      kind: "hardcoded-literal", path: i.path, detail: `${i.kind} "${i.match}" at line ${i.line}`,
    })),
    ...(antiRot.testRot ?? []).map(i => ({
      kind: "test-rot", path: i.path, detail: `${i.kind} test at line ${i.line}`,
    })),
    ...(antiRot.commentBloat ?? []).map(i => ({
      kind: "comment-bloat", path: i.path,
      detail: `${i.proseLines} prose comment lines (${Math.round(i.ratio * 100)}% of ${i.codeLines} code lines)`,
    })),
  ];
}
