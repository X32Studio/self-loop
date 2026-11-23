// F-0014, D-0057, design/ssot-authority.md: Single Source of Truth (SSOT) authority doc verification and drift gating.
// Pure Node ESM with zero external dependencies. Every Git read uses --no-replace-objects on an explicit commit SHA.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { node } from "./commands.mjs";
import { validateGlob } from "./plan-globs.mjs";
import { appendJsonLines, commitRecords } from "./records-commit.mjs";
import {
  assertCleanDocInWorktree, assertNoDiskSymlinkEscape, changedWatchWindow, DISPLAY_SHA_LEN, fullShaNoReplace, gitRaw,
  isAncestor, readCommittedRegularFile, resolveExternalRepo, runEntryCheck, SHORT_SHA_LEN, SsotConfigError,
} from "./ssot-git.mjs";

export { DISPLAY_SHA_LEN, fullShaNoReplace, SHORT_SHA_LEN, SsotConfigError };
export const SSOT_SYNC = "metrics/ssot-sync.jsonl";
export const SSOT_MODES = Object.freeze(["same-batch", "phase-close"]);
export const SSOT_DISPOSITIONS = Object.freeze(["updated", "no-contract-change"]);

const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const DIGEST_RE = /^[0-9a-f]{64}$/;
const MAX_SUMMARY_PATHS = 5;
const SSOT_KEYS = new Set(["entries", "repos"]);
const ENTRY_KEYS = new Set(["id", "doc", "repo", "watch", "ignore", "mode", "check", "anchors"]);
const ANCHOR_KEYS = new Set(["name", "docPattern", "source", "jsonPointer", "sourcePattern"]);
const isObj = v => v !== null && typeof v === "object" && !Array.isArray(v);
const oneLine = v => typeof v === "string" && v.trim().length > 0 && !/[\n\r\0]/.test(v);

export const isSafeRepoPath = p => typeof p === "string" && p.length > 0 && !p.startsWith("/") && !p.endsWith("/")
  && !p.includes("\\") && !p.includes("\0") && !/[\n\r]/.test(p) && !p.includes("//")
  && p.split("/").every(s => s !== "" && s !== "." && s !== "..");

export function entryDigest(entry) {
  const payload = JSON.stringify({ doc: entry.doc, repo: entry.repo, watch: entry.watch, ignore: entry.ignore });
  return createHash("sha256").update(payload).digest("hex");
}

function compileRegex(pattern, label) {
  if (typeof pattern !== "string" || !pattern || pattern.includes("\0")) throw new SsotConfigError(`${label} must be a non-empty RegExp string`);
  try { return new RegExp(pattern, "gm"); } catch (e) { throw new SsotConfigError(`${label} is not a valid RegExp: ${e.message}`); }
}

function validateAnchors(rawAnchors, at, fail) {
  if (rawAnchors === undefined) return [];
  if (!Array.isArray(rawAnchors)) fail(`${at}.anchors must be an array`);
  const seen = new Set();
  return rawAnchors.map((a, j) => {
    const aAt = `${at}.anchors[${j}]`;
    if (!isObj(a)) fail(`${aAt} must be an object`);
    for (const k of Object.keys(a)) if (!ANCHOR_KEYS.has(k)) fail(`${aAt} has unknown field "${k}"`);
    if (!oneLine(a.name)) fail(`${aAt}.name must be a non-empty one-line string`);
    if (seen.has(a.name)) fail(`${at} has duplicate anchor name "${a.name}"`);
    seen.add(a.name);
    compileRegex(a.docPattern, `${aAt}.docPattern`);
    if (!isSafeRepoPath(a.source)) fail(`${aAt}.source must be a safe product-relative path, got ${JSON.stringify(a.source)}`);
    const hasPtr = a.jsonPointer !== undefined, hasPat = a.sourcePattern !== undefined;
    if (hasPtr === hasPat) fail(`${aAt} must define exactly one of jsonPointer or sourcePattern`);
    if (hasPtr) {
      if (typeof a.jsonPointer !== "string" || (a.jsonPointer !== "" && !a.jsonPointer.startsWith("/")) || /~(?![01])/.test(a.jsonPointer))
        fail(`${aAt}.jsonPointer must be a valid RFC 6901 pointer, got ${JSON.stringify(a.jsonPointer)}`);
    } else compileRegex(a.sourcePattern, `${aAt}.sourcePattern`);
    return { name: a.name, docPattern: a.docPattern, source: a.source, ...(hasPtr ? { jsonPointer: a.jsonPointer } : { sourcePattern: a.sourcePattern }) };
  });
}

function validateGlobs(list, label, required, fail) {
  if (!Array.isArray(list) || (required && !list.length)) fail(`${label} must be ${required ? "a non-empty " : "an "}array of globs`);
  for (const g of list) { try { validateGlob(g); } catch (err) { fail(`${label} invalid glob ${JSON.stringify(g)}: ${err.message}`); } }
  return [...list];
}

export function validateSsotSchema(raw, source = "loop.json") {
  if (raw === undefined) return null;
  const fail = msg => { throw new SsotConfigError(`${source}: ssot ${msg}`); };
  if (!isObj(raw)) fail("must be an object");
  for (const k of Object.keys(raw)) if (!SSOT_KEYS.has(k)) fail(`has unknown field "${k}"`);
  const repos = {};
  if (raw.repos !== undefined) {
    if (!isObj(raw.repos)) fail("repos must be an object mapping repo keys to paths");
    for (const [k, v] of Object.entries(raw.repos)) {
      if (!ID_RE.test(k) || k === "product") fail(`repos key "${k}" must match ${ID_RE} and cannot be "product"`);
      if (!oneLine(v)) fail(`repos.${k} must be a non-empty path string`);
      repos[k] = v;
    }
  }
  if (!Array.isArray(raw.entries) || !raw.entries.length) fail("entries must be a non-empty array");
  const seenIds = new Set();
  const entries = raw.entries.map((e, i) => {
    const at = `entries[${i}]`;
    if (!isObj(e)) fail(`${at} must be an object`);
    for (const k of Object.keys(e)) if (!ENTRY_KEYS.has(k)) fail(`${at} has unknown field "${k}"`);
    if (typeof e.id !== "string" || !ID_RE.test(e.id)) fail(`${at}.id must match ${ID_RE}, got ${JSON.stringify(e.id)}`);
    if (seenIds.has(e.id)) fail(`duplicate entry id "${e.id}"`);
    seenIds.add(e.id);
    const repo = e.repo ?? "product";
    if (typeof repo !== "string" || (repo !== "product" && !Object.hasOwn(repos, repo))) fail(`${at}.repo "${repo}" must be "product" or a key declared in ssot.repos`);
    if (!isSafeRepoPath(e.doc)) fail(`${at}.doc must be a safe repo-relative path, got ${JSON.stringify(e.doc)}`);
    const watch = validateGlobs(e.watch, `${at}.watch`, true, fail);
    const ignore = validateGlobs(e.ignore ?? [], `${at}.ignore`, false, fail);
    const mode = e.mode ?? "same-batch";
    if (!SSOT_MODES.includes(mode)) fail(`${at}.mode must be one of ${SSOT_MODES.join(", ")}, got ${JSON.stringify(mode)}`);
    if (e.check !== undefined && !oneLine(e.check)) fail(`${at}.check must be a non-empty command string`);
    return { id: e.id, doc: e.doc, repo, watch, ignore, mode, check: e.check ?? null, anchors: validateAnchors(e.anchors, at, fail) };
  });
  return { entries, repos };
}

export function resolveJsonPointer(doc, pointer) {
  let cur = doc;
  if (pointer !== "") {
    for (const rawTok of pointer.slice(1).split("/")) {
      const tok = rawTok.replace(/~1/g, "/").replace(/~0/g, "~");
      if (Array.isArray(cur)) {
        if (!/^(?:0|[1-9]\d*)$/.test(tok) || Number(tok) >= cur.length)
          return { ok: false, error: `invalid or out-of-bounds array index "${tok}" in ${pointer}` };
        cur = cur[Number(tok)];
      } else if (isObj(cur) && Object.hasOwn(cur, tok)) cur = cur[tok];
      else return { ok: false, error: `missing key "${tok}" in ${pointer}` };
    }
  }
  if (typeof cur === "string") return { ok: true, value: cur };
  if (typeof cur === "number" && Number.isFinite(cur)) return { ok: true, value: String(cur) };
  if (typeof cur === "boolean") return { ok: true, value: String(cur) };
  return { ok: false, error: `${pointer || "/"} resolved to unsupported JSON value (${cur === null ? "null" : Array.isArray(cur) ? "array" : typeof cur})` };
}

function matchOnce(text, pattern, label) {
  const hits = [...text.matchAll(new RegExp(pattern, "gm"))];
  if (hits.length !== 1) return { ok: false, error: `${label} matched ${hits.length} time(s); expected exactly 1` };
  if (hits[0][1] === undefined) return { ok: false, error: `${label} matched without capture group 1` };
  return { ok: true, value: hits[0][1] };
}

function checkAnchors(entry, docText, product, sha) {
  const out = [];
  for (const a of entry.anchors) {
    const err = detail => out.push({ entryId: entry.id, kind: "anchor-error", anchor: a.name, doc: entry.doc, source: a.source, detail });
    const docHit = matchOnce(docText, a.docPattern, `docPattern for anchor "${a.name}" in ${entry.doc}`);
    if (!docHit.ok) { err(docHit.error); continue; }
    const src = readCommittedRegularFile(product, sha, a.source);
    if (!src.ok) { err(src.error); continue; }
    let expected;
    if (a.jsonPointer !== undefined) {
      let parsed;
      try { parsed = JSON.parse(src.content); } catch (e) { err(`${a.source} is not valid JSON: ${e.message}`); continue; }
      const ptr = resolveJsonPointer(parsed, a.jsonPointer);
      if (!ptr.ok) { err(`${a.source}: ${ptr.error}`); continue; }
      expected = ptr.value;
    } else {
      const srcHit = matchOnce(src.content, a.sourcePattern, `sourcePattern for anchor "${a.name}" in ${a.source}`);
      if (!srcHit.ok) { err(srcHit.error); continue; }
      expected = srcHit.value;
    }
    if (docHit.value !== expected) {
      out.push({ entryId: entry.id, kind: "anchor-mismatch", anchor: a.name, doc: entry.doc, source: a.source, expected, actual: docHit.value,
        detail: `anchor "${a.name}" mismatch in ${entry.doc}: expected ${JSON.stringify(expected)} from ${a.source}, got ${JSON.stringify(docHit.value)}` });
    }
  }
  return out;
}

function parseSyncRow(line, lineNo, source) {
  let row;
  try { row = JSON.parse(line); } catch (e) { return { error: `${source}:${lineNo}: invalid JSON (${e.message})` }; }
  if (!isObj(row) || typeof row.id !== "string" || !ID_RE.test(row.id)
      || typeof row.productSha !== "string" || !SHA_RE.test(row.productSha)
      || typeof row.docRepoSha !== "string" || !SHA_RE.test(row.docRepoSha)
      || !SSOT_DISPOSITIONS.includes(row.disposition) || !oneLine(row.reason) || !oneLine(row.by) || !oneLine(row.time))
    return { error: `${source}:${lineNo}: malformed ssot-sync row` };
  if (row.round !== undefined && (!Number.isInteger(row.round) || row.round < 1))
    return { error: `${source}:${lineNo}: round must be a positive integer` };
  if (row.entryDigest !== undefined && (typeof row.entryDigest !== "string" || !DIGEST_RE.test(row.entryDigest)))
    return { error: `${source}:${lineNo}: entryDigest must be a 64-char hex digest` };
  if (row.docBlobSha !== undefined && (typeof row.docBlobSha !== "string" || !SHA_RE.test(row.docBlobSha)))
    return { error: `${source}:${lineNo}: docBlobSha must be a 40-char hex SHA` };
  return { row };
}

export function validateSyncLines(text, source = SSOT_SYNC) {
  const errors = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]) continue;
    const parsed = parseSyncRow(lines[i], i + 1, source);
    if (parsed.error) errors.push({ line: i + 1, detail: parsed.error });
  }
  return errors;
}

export function parseSyncRows(text, source = SSOT_SYNC) {
  const rows = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]) continue;
    const parsed = parseSyncRow(lines[i], i + 1, source);
    if (parsed.error) throw new SsotConfigError(parsed.error);
    rows.push(parsed.row);
  }
  return rows;
}

export function readSyncRows(records) {
  if (!records || gitRaw(records, ["cat-file", "-e", `HEAD:${SSOT_SYNC}`]).status !== 0) return [];
  const show = gitRaw(records, ["show", `HEAD:${SSOT_SYNC}`]);
  if (show.status !== 0) throw new SsotConfigError(`cannot read HEAD:${SSOT_SYNC} from ${records}: ${show.stderr.trim()}`);
  return parseSyncRows(show.stdout, `${records}:${SSOT_SYNC}`);
}

export function loadSsotLoop(configPath) {
  const abs = resolve(configPath);
  let raw;
  try { raw = JSON.parse(readFileSync(abs, "utf8")); } catch (e) { throw new SsotConfigError(`${abs}: ${e.message}`); }
  if (!isObj(raw) || typeof raw.product !== "string" || !raw.product.trim()) throw new SsotConfigError(`${abs}: loop.json must name "product"`);
  const base = dirname(abs);
  return { configFile: abs, product: resolve(base, raw.product), records: raw.records ? resolve(base, raw.records) : base,
    branch: typeof raw.branch === "string" && raw.branch.trim() ? raw.branch.trim() : null, ssot: raw.ssot };
}

export function defaultShaFor(loop) {
  if (loop.branch && gitRaw(loop.product, ["rev-parse", "--verify", "--quiet", `${loop.branch}^{commit}`]).status === 0)
    return fullShaNoReplace(loop.product, loop.branch);
  return fullShaNoReplace(loop.product, "HEAD");
}

function detectDrift(entry, { product, fullSha, docGitTop, docTreePath, syncRows }) {
  const digest = entryDigest(entry);
  const myRows = syncRows.filter(r => r.id === entry.id && r.entryDigest === digest);
  if (entry.repo === "product") {
    const rev = gitRaw(product, ["rev-list", "-n", "1", fullSha, "--", entry.doc]);
    const lastDocSha = rev.status === 0 ? rev.stdout.trim() : null;
    const win = changedWatchWindow(product, lastDocSha, fullSha, entry.watch, entry.ignore);
    if (!win.changedPaths.length) return null;
    const waiver = myRows.findLast(r => r.disposition === "no-contract-change"
      && isAncestor(product, r.productSha, fullSha)
      && changedWatchWindow(product, r.productSha, fullSha, entry.watch, entry.ignore).changedPaths.length === 0);
    return waiver ? null : { id: entry.id, doc: entry.doc, repo: entry.repo, mode: entry.mode, lastDocSha, behindCommits: win.behindCommits, changedPaths: win.changedPaths };
  }
  const latest = myRows.findLast(r => {
    if (!isAncestor(product, r.productSha, fullSha)) return false;
    if (r.disposition === "updated") {
      if (gitRaw(docGitTop, ["rev-parse", "--verify", "--quiet", `${r.docRepoSha}^{commit}`]).status !== 0) return false;
      return readCommittedRegularFile(docGitTop, r.docRepoSha, docTreePath).ok;
    }
    return true;
  });
  if (!latest) {
    const win = changedWatchWindow(product, null, fullSha, entry.watch, entry.ignore);
    return { id: entry.id, doc: entry.doc, repo: entry.repo, mode: entry.mode, lastDocSha: null, behindCommits: win.behindCommits, changedPaths: win.changedPaths, reason: `no sync receipt in ${SSOT_SYNC}` };
  }
  const win = changedWatchWindow(product, latest.productSha, fullSha, entry.watch, entry.ignore);
  return win.changedPaths.length
    ? { id: entry.id, doc: entry.doc, repo: entry.repo, mode: entry.mode, lastDocSha: latest.docRepoSha, lastSyncedProductSha: latest.productSha, behindCommits: win.behindCommits, changedPaths: win.changedPaths }
    : null;
}

function requireConfigFile(configFile) {
  if (typeof configFile !== "string" || !configFile.trim() || !isAbsolute(configFile))
    throw new SsotConfigError(`configFile must be an absolute path to loop.json, got ${JSON.stringify(configFile)}`);
  return configFile;
}

export function checkSsot({ product, records = null, configFile, ssot, sha, strict = false, runChecks = true }) {
  if (ssot === undefined)
    return { configured: false, sha: sha ?? null, strict: Boolean(strict), ok: true, rung2Ok: true, rung3Ok: true, failures: [], drift: [], entries: [] };
  const absConfig = requireConfigFile(configFile);
  const failures = [], drift = [], entries = [];
  let parsed, fullSha, syncRows;
  try {
    parsed = validateSsotSchema(ssot, absConfig);
    fullSha = fullShaNoReplace(product, sha || "HEAD");
    syncRows = readSyncRows(records);
  } catch (e) {
    failures.push({ entryId: null, kind: "config-error", detail: e.message });
    return { configured: true, sha: fullSha ?? sha ?? null, strict: Boolean(strict), ok: false, rung2Ok: false, rung3Ok: true, failures, drift, entries };
  }
  const baseDir = dirname(absConfig);
  const extRepos = new Map();
  for (const [name, rawPath] of Object.entries(parsed.repos)) {
    try { extRepos.set(name, resolveExternalRepo(name, rawPath, baseDir)); }
    catch (e) { failures.push({ entryId: null, kind: "repo-error", repo: name, detail: e.message }); }
  }
  for (const entry of parsed.entries) {
    const ef = [];
    let docText = null, docGitTop = product, docTreePath = entry.doc, docHeadSha = fullSha, docPrefix = "";
    if (entry.repo !== "product") {
      const ext = extRepos.get(entry.repo);
      if (!ext) { entries.push({ id: entry.id, doc: entry.doc, repo: entry.repo, mode: entry.mode, status: "failed" }); continue; }
      docGitTop = ext.gitTop; docPrefix = ext.prefix; docTreePath = ext.prefix ? `${ext.prefix}/${entry.doc}` : entry.doc;
      try { assertNoDiskSymlinkEscape(ext.root, entry.doc); docHeadSha = fullShaNoReplace(docGitTop, "HEAD"); }
      catch (e) { ef.push({ entryId: entry.id, kind: "repo-error", doc: entry.doc, repo: entry.repo, detail: e.message }); }
    }
    if (!ef.length) {
      const readDoc = readCommittedRegularFile(docGitTop, docHeadSha, docTreePath);
      if (!readDoc.ok) ef.push({ entryId: entry.id, kind: "missing-doc", doc: entry.doc, repo: entry.repo, detail: readDoc.error });
      else docText = readDoc.content;
    }
    if (docText !== null && entry.anchors.length) ef.push(...checkAnchors(entry, docText, product, fullSha));
    if (docText !== null && runChecks && entry.check) {
      const ce = runEntryCheck(entry, { product, sha: fullSha, docGitTop, docHeadSha, docPrefix });
      if (ce) ef.push(ce);
    }
    failures.push(...ef);
    const driftItem = ef.length ? null : detectDrift(entry, { product, fullSha, docGitTop, docTreePath, syncRows });
    if (driftItem) drift.push(driftItem);
    entries.push({ id: entry.id, doc: entry.doc, repo: entry.repo, mode: entry.mode, status: ef.length ? "failed" : driftItem ? "drift" : "ok" });
  }
  const rung2Ok = !failures.length, rung3Ok = !drift.length;
  return { configured: true, sha: fullSha, strict: Boolean(strict), ok: rung2Ok && (!strict || rung3Ok), rung2Ok, rung3Ok, failures, drift, entries };
}

export function attestSsot({ product, records, configFile, ssot, id, sha, disposition, by, reason, round, indexOfTree, layoutText }) {
  const absConfig = requireConfigFile(configFile);
  if (ssot === undefined) throw new SsotConfigError(`${absConfig}: no ssot configuration`);
  if (!SSOT_DISPOSITIONS.includes(disposition)) throw new SsotConfigError(`disposition must be one of ${SSOT_DISPOSITIONS.join(", ")}`);
  if (!oneLine(by)) throw new SsotConfigError("by must be a non-empty one-line string");
  if (!oneLine(reason)) throw new SsotConfigError("reason must be a non-empty one-line string");
  if (round !== undefined && (!Number.isInteger(round) || round < 1)) throw new SsotConfigError("round must be a positive integer");
  const parsed = validateSsotSchema(ssot, absConfig);
  const entry = parsed.entries.find(e => e.id === id);
  if (!entry) throw new SsotConfigError(`unknown ssot entry id "${id}"`);
  if (entry.repo === "product" && disposition === "updated")
    throw new SsotConfigError(`cannot attest "updated" for product-repo entry "${entry.id}": commit the document update in the product repo directly, or use --disposition no-contract-change`);
  const productSha = fullShaNoReplace(product, sha);
  let docRepoSha = productSha, docGitTop = product, docTreePath = entry.doc;
  if (entry.repo !== "product") {
    const ext = resolveExternalRepo(entry.repo, parsed.repos[entry.repo], dirname(absConfig));
    assertNoDiskSymlinkEscape(ext.root, entry.doc);
    docGitTop = ext.gitTop; docTreePath = ext.prefix ? `${ext.prefix}/${entry.doc}` : entry.doc;
    if (disposition === "updated") assertCleanDocInWorktree(docGitTop, docTreePath, entry.id);
    docRepoSha = fullShaNoReplace(docGitTop, "HEAD");
  }
  const docCheck = readCommittedRegularFile(docGitTop, docRepoSha, docTreePath);
  if (!docCheck.ok) throw new SsotConfigError(`cannot attest ${entry.id}: ${docCheck.error}`);
  const row = { id: entry.id, productSha, docRepoSha, disposition, entryDigest: entryDigest(entry),
    ...(disposition === "updated" ? { docBlobSha: docCheck.blobSha } : {}),
    reason: reason.trim(), by: by.trim(), ...(round !== undefined ? { round } : {}),
    time: new Date().toISOString().replace(/\.\d{3}Z$/, "Z") };
  const { commit } = commitRecords(records, ({ files, read, add, tree }) => {
    const old = read(SSOT_SYNC);
    const existing = old ? parseSyncRows(old) : [];
    if (disposition === "updated") {
      const prev = existing.findLast(r => r.id === entry.id && r.disposition === "updated");
      if (prev) {
        const prevBlob = prev.docBlobSha ?? readCommittedRegularFile(docGitTop, prev.docRepoSha, docTreePath).blobSha ?? null;
        if (prevBlob === docCheck.blobSha)
          throw new SsotConfigError(`cannot attest "updated" for "${entry.id}": ${entry.doc} at ${docRepoSha.slice(0, SHORT_SHA_LEN)} is unchanged from previous updated receipt (${prev.docRepoSha.slice(0, SHORT_SHA_LEN)}); commit a document update or use --disposition no-contract-change`);
      }
    }
    add(SSOT_SYNC, appendJsonLines(old, [row]));
    if (files.has("INDEX.md") && typeof indexOfTree === "function") {
      const index = indexOfTree(records, tree(), { layoutText });
      if (index !== read("INDEX.md")) add("INDEX.md", index);
    }
    return { message: `ssot: ${disposition} ${entry.id} at ${productSha.slice(0, SHORT_SHA_LEN)}`, value: row };
  });
  return { commit, row };
}

export const ssotCheckCommand = (configFile, sha, { strict = false } = {}) =>
  node("ssot-check.mjs", "check", "--config", configFile, ...(sha ? ["--sha", sha] : []), ...(strict ? ["--strict"] : []));

const samplePaths = d => d.changedPaths.slice(0, MAX_SUMMARY_PATHS).join(", ") || d.reason || "no sync receipt";

export function formatSsotRefusal(result) {
  const parts = [];
  if (result.failures.length) parts.push(`SSOT Rung-2 failed: ${result.failures.map(f => f.detail).join("; ")}`);
  if (result.strict && result.drift.length)
    parts.push(`SSOT Rung-3 ssot-drift (${result.drift.length}): ${result.drift.map(d => `${d.id} (${d.doc}, ${d.mode}, ${d.behindCommits} commit(s): ${samplePaths(d)})`).join("; ")}`);
  return parts.join(" | ");
}

export const ssotDriftWarnings = result => result.drift.map(d =>
  `Warning: ssot-drift ${d.id} (${d.doc}, ${d.mode}) behind by ${d.behindCommits} commit(s): ${samplePaths(d)}`);

export function ssotDriftAlarms({ product, records, configFile, ssot, sha, at = 0 }) {
  if (ssot === undefined) return [];
  const res = checkSsot({ product, records, configFile, ssot, sha: sha || "HEAD", strict: false, runChecks: false });
  const cmd = ssotCheckCommand(configFile, res.sha, { strict: true });
  return [
    ...res.failures.map(f => ({ type: "ssot-drift", key: `ssot-gate:${f.entryId ?? "config"}`, count: 1, at,
      message: `SSOT Rung-2 failure (${f.entryId ?? "config"}): ${f.detail}`, evidence: { ...f, command: cmd } })),
    ...res.drift.map(d => ({ type: "ssot-drift", key: `ssot-drift:${d.id}`, count: d.behindCommits, at,
      message: `SSOT ${d.id} (${d.doc}, ${d.mode}) drifted behind by ${d.behindCommits} commit(s): ${samplePaths(d)}`, evidence: { ...d, command: cmd } })),
  ];
}

export function ssotNextSummary(cfg, configFile, sha) {
  if (cfg?.ssot === undefined || !sha) return null;
  const res = checkSsot({ product: cfg.product, records: cfg.records, configFile, ssot: cfg.ssot, sha, strict: true, runChecks: false });
  if (res.ok) return { ok: true, action: null, convergenceReason: null };
  const cmd = ssotCheckCommand(configFile, res.sha, { strict: true });
  const ids = [...res.failures.map(f => f.entryId ?? "config"), ...res.drift.map(d => d.id)];
  return {
    ok: false,
    action: { title: `ssot-drift / SSOT sync required (${ids.join(", ")})`, steps: [
      ...res.failures.map(f => `Rung-2 failure (${f.entryId ?? "config"}): ${f.detail}`),
      ...res.drift.map(d => `ssot-drift ${d.id} (${d.doc}, ${d.mode}): ${d.behindCommits} commit(s) behind — ${samplePaths(d)}`),
      "Update the governing authority doc or record a one-shot no-contract-change attestation for this exact SHA:", cmd] },
    convergenceReason: `unresolved ssot-drift or Rung-2 failure on ${res.sha.slice(0, DISPLAY_SHA_LEN)}: ${ids.join(", ")} (ssot-check.mjs --strict)`,
  };
}

export function renderSsotStatusMarkdown(cfg, { configFile, sha }) {
  if (!cfg || !Object.hasOwn(cfg, "ssot")) return null;
  let res;
  try {
    res = checkSsot({ product: cfg.product, records: cfg.records, configFile, ssot: cfg.ssot, sha, strict: false, runChecks: false });
  } catch (e) {
    const msg = String(e?.message ?? e).split("\n")[0];
    return {
      ok: false,
      summary: `evaluation error: ${msg}`,
      markdown: [
        "# SSOT Status", "",
        `- Commit: \`${sha ?? "unknown"}\``,
        "- Status: error", "",
        "## Evaluation Error", "",
        `- ${e?.message ?? e}`, "",
      ].join("\n"),
    };
  }
  if (!res.configured) return null;
  const clean = res.entries.filter(e => e.status === "ok");
  const parts = [];
  if (res.failures.length) parts.push(`${res.failures.length} rung-2 failure(s): ${[...new Set(res.failures.map(f => f.entryId ?? "config"))].join(", ")}`);
  if (res.drift.length) parts.push(`${res.drift.length} ssot-drift: ${res.drift.map(d => d.id).join(", ")}`);
  parts.push(`${clean.length} clean`);
  const lines = [
    "# SSOT Status", "",
    `- Commit: \`${res.sha ?? sha ?? "unknown"}\``,
    `- Entries: ${res.entries.length} total (${clean.length} clean, ${res.failures.length} rung-2 failure(s), ${res.drift.length} drift)`,
    "- Scope: read-only snapshot (`runChecks: false`; custom `check` commands are verified by `ssot-check.mjs` and `gated-push.mjs`).",
  ];
  if (res.failures.length) {
    lines.push("", "## Rung-2 Failures", "");
    for (const f of res.failures) lines.push(`- [${f.kind}] \`${f.entryId ?? "config"}\`${f.doc ? ` (\`${f.doc}\`)` : ""}: ${f.detail}`);
  }
  if (res.drift.length) {
    lines.push("", "## Rung-3 Drift (`ssot-drift`)", "");
    for (const d of res.drift) lines.push(`- \`${d.id}\` (\`${d.doc}\`, repo: \`${d.repo}\`, mode: \`${d.mode}\`, ${d.behindCommits} commit(s) behind): ${d.changedPaths.length ? d.changedPaths.join(", ") : d.reason ?? "no sync receipt"}`);
  }
  if (clean.length) {
    lines.push("", `## Clean Entries (${clean.length})`, "");
    for (const e of clean) lines.push(`- \`${e.id}\` (\`${e.doc}\`, repo: \`${e.repo}\`, mode: \`${e.mode}\`)`);
  }
  if (!res.ok || res.drift.length) lines.push("", "## Verify", "", `\`${ssotCheckCommand(configFile, res.sha, { strict: true })}\``);
  return { ok: res.ok && !res.drift.length, summary: parts.join("; "), markdown: `${lines.join("\n")}\n` };
}

export function ssotRecordsFindings(repo, { has, read, given }) {
  const failures = [], screening = [];
  if (has.has(SSOT_SYNC)) {
    for (const err of validateSyncLines(read(SSOT_SYNC), SSOT_SYNC))
      failures.push({ rule: "ssot-sync", path: SSOT_SYNC, line: err.line, detail: err.detail });
  }
  if (!given && has.has("loop.json")) {
    let raw;
    try { raw = JSON.parse(read("loop.json")); } catch { raw = null; }
    if (isObj(raw) && Object.hasOwn(raw, "ssot")) {
      const configFile = resolve(repo, "loop.json");
      try {
        const loop = loadSsotLoop(configFile);
        const sha = defaultShaFor(loop);
        for (const a of ssotDriftAlarms({ product: loop.product, records: repo, configFile, ssot: loop.ssot, sha }))
          screening.push({ rule: a.type, path: "loop.json", detail: a.message });
      } catch (e) {
        screening.push({ rule: "ssot-drift", path: "loop.json", detail: `SSOT screening failed: ${e.message}` });
      }
    }
  }
  return { failures, screening };
}
