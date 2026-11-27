// F-0015, D-0016, D-0069, R-0055-judge-frame-hygiene, R-0055-judge-frame-alphax
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { MAX_AUDIT_JSON_BYTES, serializeBoundedAudit } from "../audit-access.mjs";
import { indexOfTree } from "../records-check.mjs";
import { parseRows, TRAJECTORY } from "../trajectory.mjs";
import { FEATURE_EVENTS } from "./blueprint.mjs";
import { blobs, git, gitOk, run } from "./git-plumbing.mjs";
import { HANDOFFS, parseHandoffs } from "./handoff.mjs";
import { installRecordsPreCommitHook } from "./init.mjs";
import { commitRecords } from "./records-commit.mjs";
import { parseWindows, WINDOWS } from "./window-state.mjs";

const PRUNE_FILE_RE = /^prune\/(PR-\d{4})\.md$/;
const PRUNABLE_EVIDENCE_RE = /^evidence\/\d{4}\/(?!time-binding\/).+/;
const PRUNABLE_SEALED_LOG_RE = /^sealed\/judge\/\d{4}\/[^/]+(?:\.log\.gz|-log\.jsonl)$/;
const AUDIT_JSON_RE = /^(?:evidence|sealed\/judge)\/\d{4}\/[^/]+-audit\.json$/;
const P2_PROTECTED_RE = /^(?:evidence\/\d{4}\/time-binding\/|evidence\/normal-entry\/|evidence\/blueprint\/)/;
const P4_PROTECTED_RE = /^sealed\/(?:judge\/\d{4}\/(?:[^/]+\.md|[^/]+-audit\.json|[^/]+\/out\/.+)|critic\/\d{4}\/[^/]+\.md)$/;
const ACTIVE_CITE_RECORD_RE = /^(?:purpose|decisions|blueprint|design|forecasts|rounds|reviews|interventions|lessons)\/.+|evidence\/\d{4}\/time-binding\/TB-[0-9a-f]{64}\.json$/;
const PLAN_FILE_RE = /^plans\/(PL-\d{4})\.md$/;
const EVIDENCE_CITE_RE = /\bevidence\/[^\s`'")\]}>,;]+/g;
const SHA256_RE = /^[0-9a-f]{64}$/;
const SHA40_RE = /^[0-9a-f]{40}$/;
const pad4 = n => String(n).padStart(4, "0");
const sha256Of = buf => createHash("sha256").update(buf).digest("hex");
const cleanCell = cell => cell.trim().replace(/^`([^`]*)`$/, "$1").replace(/\\\|/g, "|");
const escCell = value => String(value).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
const gitEnv = () => ({ GIT_TERMINAL_PROMPT: "0", ...process.env });

export const isPrunablePath = relPath => typeof relPath === "string" && (PRUNABLE_EVIDENCE_RE.test(relPath) || PRUNABLE_SEALED_LOG_RE.test(relPath));

export function parsePruneManifests(files, read) {
  const map = new Map();
  for (const path of [...files].filter(p => PRUNE_FILE_RE.test(p)).sort()) {
    const prId = PRUNE_FILE_RE.exec(path)[1];
    for (const line of (read(path) ?? "").split(/\r?\n/)) {
      if (!line.startsWith("|")) continue;
      const cells = line.split(/(?<!\\)\|/).slice(1, -1).map(cleanCell);
      if (cells.length < 5 || /^-+$/.test(cells[0]) || /^path$/i.test(cells[0])) continue;
      if (cells.length >= 7 && (cells[1] === "pruned" || cells[1] === "compacted")) {
        const [entryPath, action, sha256, bytesStr, originCommit, newSha, newBytesStr] = cells;
        if (!entryPath || !SHA256_RE.test(sha256) || !/^\d+$/.test(bytesStr) || !SHA40_RE.test(originCommit)) continue;
        map.set(entryPath, {
          prId, action, sha256, bytes: Number(bytesStr), originCommit,
          ...(SHA256_RE.test(newSha) ? { newSha256: newSha } : {}),
          ...(/^\d+$/.test(newBytesStr) ? { newBytes: Number(newBytesStr) } : {}),
        });
      } else {
        const [entryPath, sha256, bytesStr, originCommit] = cells;
        if (!entryPath || !SHA256_RE.test(sha256) || !/^\d+$/.test(bytesStr) || !SHA40_RE.test(originCommit)) continue;
        map.set(entryPath, { prId, action: "pruned", sha256, bytes: Number(bytesStr), originCommit });
      }
    }
  }
  return map;
}

export function verifyPruneTombstones(repo, checks, failures, screening) {
  if (!checks.length) return;
  if (!existsSync(join(repo, ".git"))) {
    screening.push({ rule: "prune-shallow", path: HANDOFFS, detail: `no Git history to verify ${checks.length} pruned hand-off tombstone(s)` });
    return;
  }
  let shallow = false;
  try {
    shallow = execFileSync("git", ["-C", repo, "rev-parse", "--is-shallow-repository"],
      { encoding: "utf8", env: gitEnv(), stdio: ["ignore", "pipe", "ignore"] }).trim() === "true";
  } catch { shallow = true; }
  if (shallow) {
    screening.push({ rule: "prune-shallow", path: HANDOFFS, detail: `shallow checkout: skipped Git verification for ${checks.length} pruned hand-off tombstone(s)` });
    return;
  }
  const ancestorCache = new Map();
  const isAncestor = c => {
    if (!ancestorCache.has(c)) ancestorCache.set(c, gitOk(repo, "--no-replace-objects", "merge-base", "--is-ancestor", c, "HEAD"));
    return ancestorCache.get(c);
  };
  const validChecks = [];
  for (const item of checks) {
    if (!isAncestor(item.entry.originCommit)) {
      failures.push({ rule: "handoff", path: HANDOFFS, detail: `${item.h.id} names ${item.f}, whose prune tombstone ${item.entry.prId} originCommit ${item.entry.originCommit} is not an ancestor of HEAD` });
    } else validChecks.push(item);
  }
  if (!validChecks.length) return;
  const specs = [...new Set(validChecks.map(c => `${c.entry.originCommit}:${c.f}`))];
  const out = run("git", ["-C", repo, "--no-replace-objects", "cat-file", "--batch"], { input: `${specs.join("\n")}\n` });
  const verified = new Map();
  let at = 0;
  for (const spec of specs) {
    const nl = out.indexOf(10, at);
    const header = out.subarray(at, nl).toString("utf8");
    at = nl + 1;
    if (header.endsWith(" missing")) { verified.set(spec, null); continue; }
    const [, type, sizeStr] = header.split(" ");
    const size = Number(sizeStr);
    const buf = out.subarray(at, at + size);
    at += size + 1;
    verified.set(spec, type === "blob" ? { bytes: size, sha256: sha256Of(buf) } : null);
  }
  for (const { h, f, entry } of validChecks) {
    const actual = verified.get(`${entry.originCommit}:${f}`);
    if (!actual || actual.bytes !== entry.bytes || actual.sha256 !== entry.sha256) {
      failures.push({ rule: "handoff", path: HANDOFFS, detail: `${h.id} names ${f}, whose prune tombstone ${entry.prId} does not match ${entry.originCommit}:${f}` });
    }
  }
}

function treeEntriesWithSize(repo, treeish) {
  const out = run("git", ["-C", repo, "--no-replace-objects", "ls-tree", "-r", "-l", "-z", "--full-tree", treeish], { encoding: "utf8" });
  const entries = [];
  for (const raw of out.split("\0")) {
    const tab = raw.indexOf("\t");
    if (tab < 0) continue;
    const [mode, type, sha, sizeStr] = raw.slice(0, tab).trim().split(/\s+/);
    if (type === "blob" && (mode === "100644" || mode === "100755")) entries.push({ path: raw.slice(tab + 1), sha, size: Number(sizeStr) });
  }
  return entries;
}

export function liveEvidenceStats(state, { maxAuditBytes = MAX_AUDIT_JSON_BYTES } = {}) {
  const paths = state?.files instanceof Map ? [...state.files.keys()] : Array.isArray(state?.files) ? state.files : [];
  const sizesFromGit = new Map();
  if (state?.repo && existsSync(join(state.repo, ".git"))) {
    try { for (const e of treeEntriesWithSize(state.repo, state.head ?? "HEAD")) sizesFromGit.set(e.path, e.size); } catch {}
  }
  let fileCount = 0, totalBytes = 0;
  const oversizedAudits = [];
  for (const p of paths) {
    const isEv = p.startsWith("evidence/"), isAudit = AUDIT_JSON_RE.test(p);
    if (!isEv && !isAudit) continue;
    let size = 0;
    if (state?.repo && existsSync(join(state.repo, p))) {
      try { size = statSync(join(state.repo, p)).size; } catch { size = sizesFromGit.get(p) ?? 0; }
    } else if (sizesFromGit.has(p)) size = sizesFromGit.get(p);
    else if (typeof state?.read === "function") size = Buffer.byteLength(state.read(p) ?? "", "utf8");
    if (isEv) { fileCount++; totalBytes += size; }
    if (isAudit && size > maxAuditBytes) oversizedAudits.push({ path: p, bytes: size });
  }
  oversizedAudits.sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path));
  return { fileCount, totalBytes, oversizedAudits };
}

const readBlobsByPath = (repo, entries) => !entries.length ? new Map()
  : new Map(blobs(repo, entries.map(e => e.sha)).map((b, i) => [entries[i].path, b]));

function buildProtectionSet(repo, entries, retainRounds) {
  const byPath = new Map(entries.map(e => [e.path, e]));
  const metaPaths = new Set([TRAJECTORY, FEATURE_EVENTS, WINDOWS, HANDOFFS, "records.json"]);
  const planEntries = [], activeCiteEntries = [];
  for (const e of entries) {
    if (metaPaths.has(e.path) || ACTIVE_CITE_RECORD_RE.test(e.path)) activeCiteEntries.push(e);
    else if (PLAN_FILE_RE.test(e.path)) planEntries.push(e);
  }
  const textMap = new Map([...readBlobsByPath(repo, [...activeCiteEntries, ...planEntries])].map(([p, b]) => [p, b.toString("utf8")]));
  const readText = p => textMap.get(p) ?? "";
  const protectedExact = new Set(), protectedPrefixes = [];
  const protectPathOrDir = raw => {
    const cleaned = typeof raw === "string" ? raw.replace(/[.,:;!?]+$/, "") : "";
    if (!cleaned) return;
    if (cleaned.endsWith("/")) protectedPrefixes.push(cleaned);
    else { protectedExact.add(cleaned); protectedPrefixes.push(`${cleaned}/`); }
  };

  let handoffs = [], trajRows = [];
  if (byPath.has(HANDOFFS)) try { handoffs = parseHandoffs(readText(HANDOFFS)); } catch {}
  if (byPath.has(TRAJECTORY)) try { trajRows = parseRows(readText(TRAJECTORY)); } catch {}

  let maxRound = 0;
  for (const e of entries) { const m = /^(?:rounds|evidence|sealed\/judge)\/(\d{4})/.exec(e.path); if (m) maxRound = Math.max(maxRound, Number(m[1])); }
  for (const h of handoffs) if (Number.isInteger(h.round)) maxRound = Math.max(maxRound, h.round);
  for (const r of trajRows) {
    if (Number.isInteger(r.round)) maxRound = Math.max(maxRound, r.round);
    if (r.ciReceipt) protectedExact.add(r.ciReceipt);
    if (r.suiteReceipt) protectedExact.add(r.suiteReceipt);
  }
  if (byPath.has(FEATURE_EVENTS)) {
    for (const line of readText(FEATURE_EVENTS).split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line);
        if (ev?.evidence?.ci) protectedExact.add(ev.evidence.ci);
        if (ev?.evidence?.suiteReceipt) protectedExact.add(ev.evidence.suiteReceipt);
      } catch {}
    }
  }
  let activeWindowStart = null;
  if (byPath.has(WINDOWS)) {
    try {
      const openById = new Map();
      for (const w of parseWindows(readText(WINDOWS), WINDOWS)) {
        if (w.ciReceipt) protectedExact.add(w.ciReceipt);
        if (w.suiteReceipt) protectedExact.add(w.suiteReceipt);
        if (w.type === "open") openById.set(w.id, w);
        else if (w.type === "close") openById.delete(w.id);
      }
      for (const open of openById.values()) activeWindowStart = activeWindowStart === null ? open.startRound : Math.min(activeWindowStart, open.startRound);
    } catch {}
  }

  const latestArch = handoffs.findLast(h => h.role === "reviewer" && /^reviewer-architecture(?:-[a-z-]+)*$/.test(h.step));
  for (const f of latestArch?.files ?? []) if (f.endsWith("-arch-facts.json")) protectedExact.add(f);
  for (const h of handoffs) {
    if (h.role !== "judge" || !(h.files ?? []).some(f => f.endsWith("/out/comment-resolutions.json"))) continue;
    for (const f of h.files ?? []) if (f.endsWith("/out/comment-resolutions.json") || f.endsWith("-audit.json")) protectedExact.add(f);
    if (h.audit?.file) protectedExact.add(h.audit.file);
  }

  const supersededPlans = new Set();
  const parsedPlans = planEntries.map(e => {
    const text = readText(e.path);
    const supersedes = [...text.matchAll(/^supersedes:\s*(.+)$/gmi)].flatMap(m => m[1].split(/[,\s]+/).filter(Boolean));
    const planHandoffs = [...text.matchAll(/^handoff:\s*(R-\d{4}-[a-z-]+)\s*$/gmi)].map(m => m[1]);
    for (const s of supersedes) supersededPlans.add(s);
    return { id: PLAN_FILE_RE.exec(e.path)[1], path: e.path, handoffs: planHandoffs };
  });
  const currentPlans = parsedPlans.filter(p => !supersededPlans.has(p.id));
  const handoffIds = new Set(handoffs.map(h => h.id));
  const convergedRounds = new Set(trajRows.filter(r => r.verdict === "CONVERGED" || r.verdict === "PASS").map(r => r.round));
  const protectedRounds = new Set();
  for (const plan of currentPlans) {
    const planHandoffs = handoffs.filter(h => h.dispatch?.plan === plan.id || plan.handoffs.includes(h.id));
    const maxPlanRound = Math.max(0, ...planHandoffs.map(h => h.round ?? 0), ...plan.handoffs.map(id => Number(/^R-(\d{4})-/.exec(id)?.[1] ?? 0)));
    const converged = !plan.handoffs.some(id => !handoffIds.has(id)) && maxPlanRound > 0 && [...convergedRounds].some(r => r >= maxPlanRound);
    if (!converged) {
      for (const h of planHandoffs) { if (Number.isInteger(h.round)) protectedRounds.add(h.round); for (const f of h.files ?? []) protectedExact.add(f); }
      for (const id of plan.handoffs) { const rm = /^R-(\d{4})-/.exec(id); if (rm) protectedRounds.add(Number(rm[1])); }
    }
  }

  const decisionText = activeCiteEntries.filter(e => e.path.startsWith("decisions/")).map(e => readText(e.path)).join("\n");
  const latestActorWrite = new Map();
  for (const [i, h] of handoffs.entries()) if (h.role === "actor") for (const f of h.files ?? []) latestActorWrite.set(f, i);
  for (const [i, h] of handoffs.entries()) {
    if (h.id && new RegExp(`(?<![\\w-])${h.id}(?![\\w-])`).test(decisionText)) continue;
    for (const c of h.designConflicts ?? []) if (!(latestActorWrite.get(c.path) > i) && c.proposal) protectedExact.add(c.proposal);
  }
  if (byPath.has("records.json")) try { for (const p of JSON.parse(readText("records.json"))?.publicImports ?? []) protectPathOrDir(p); } catch {}
  for (const e of [...activeCiteEntries.filter(x => ACTIVE_CITE_RECORD_RE.test(x.path)), ...currentPlans.map(p => byPath.get(p.path))]) {
    if (e) for (const m of readText(e.path).matchAll(EVIDENCE_CITE_RE)) protectPathOrDir(m[0]);
  }

  return (relPath, round) => P2_PROTECTED_RE.test(relPath) || P4_PROTECTED_RE.test(relPath)
    || protectedExact.has(relPath) || protectedPrefixes.some(pre => relPath.startsWith(pre))
    || (Number.isInteger(round) && (round > maxRound - retainRounds || protectedRounds.has(round) || (activeWindowStart !== null && round >= activeWindowStart)));
}

function renderPruneManifest({ prId, dateIso, baseCommit, retainRounds, prunedFiles, compactedAudits, bytesSaved }) {
  const lines = [
    `# ${prId} Records evidence prune and compaction`, "",
    `id: ${prId}`, `date: ${dateIso}`, `baseCommit: ${baseCommit}`, `retainRounds: ${retainRounds}`,
    `prunedFiles: ${prunedFiles.length}`, `compactedAudits: ${compactedAudits.length}`, `bytesSaved: ${bytesSaved}`, "",
    "## Manifest", "",
    "| Path | Action | SHA-256 | Bytes | Origin commit | New SHA-256 | New bytes | Reason |",
    "|---|---|---|---:|---|---|---:|---|",
    ...prunedFiles.map(p => `| \`${escCell(p.path)}\` | pruned | \`${p.sha256}\` | \`${p.bytes}\` | \`${p.originCommit}\` | — | — | ${escCell(p.reason)} |`),
    ...compactedAudits.map(c => `| \`${escCell(c.path)}\` | compacted | \`${c.preSha256}\` | \`${c.preBytes}\` | \`${c.originCommit}\` | \`${c.postSha256}\` | \`${c.postBytes}\` | ${escCell(c.reason)} |`),
  ];
  return `${lines.join("\n")}\n`;
}

function planOnHead(repo, head, { retainRounds, maxAuditBytes, maxSealedLogBytes }) {
  const entries = treeEntriesWithSize(repo, head);
  const isProtected = buildProtectionSet(repo, entries, retainRounds);
  const pruneEntries = [], compactEntries = [];
  for (const e of entries) {
    const rm = /^(?:evidence|sealed\/judge)\/(\d{4})\//.exec(e.path);
    const round = rm ? Number(rm[1]) : null;
    if (!isProtected(e.path, round) && isPrunablePath(e.path)) {
      if (e.path.startsWith("sealed/judge/") && e.size <= maxSealedLogBytes) continue;
      pruneEntries.push(e);
    } else if (AUDIT_JSON_RE.test(e.path) && e.size > maxAuditBytes) {
      compactEntries.push(e);
    }
  }
  const pruneBlobs = readBlobsByPath(repo, pruneEntries);
  const prunedFiles = pruneEntries.map(e => ({
    path: e.path, sha256: sha256Of(pruneBlobs.get(e.path)), bytes: e.size, originCommit: head,
    reason: e.path.startsWith("sealed/judge/") ? `sealed log exceeded ${maxSealedLogBytes} bytes` : `uncited evidence outside retainRounds=${retainRounds}`,
  }));
  const compactBlobs = readBlobsByPath(repo, compactEntries);
  const compactedAudits = [];
  for (const e of compactEntries) {
    const raw = compactBlobs.get(e.path);
    let parsed;
    try { parsed = JSON.parse(raw.toString("utf8")); } catch { continue; }
    const nextBuf = Buffer.from(serializeBoundedAudit(parsed, maxAuditBytes), "utf8");
    if (nextBuf.length >= e.size) continue;
    compactedAudits.push({
      path: e.path, preSha256: sha256Of(raw), preBytes: e.size, postSha256: sha256Of(nextBuf), postBytes: nextBuf.length,
      originCommit: head, reason: `audit exceeded ${maxAuditBytes} bytes`, compactedBytes: nextBuf,
    });
  }
  let maxPr = 0;
  for (const e of entries) { const m = PRUNE_FILE_RE.exec(e.path); if (m) maxPr = Math.max(maxPr, Number(m[1].slice(3))); }
  const prId = `PR-${pad4(maxPr + 1)}`;
  const tombstonePath = prunedFiles.length || compactedAudits.length ? `prune/${prId}.md` : null;
  const bytesSaved = prunedFiles.reduce((n, f) => n + f.bytes, 0) + compactedAudits.reduce((n, c) => n + (c.preBytes - c.postBytes), 0);
  return { prId, tombstonePath, prunedFiles, compactedAudits, bytesSaved };
}

const stripInternal = list => list.map(({ compactedBytes: _, ...rest }) => rest);

export function pruneAndCompactRecords(recordsDir, {
  retainRounds = 5, maxAuditBytes = MAX_AUDIT_JSON_BYTES, maxSealedLogBytes = MAX_AUDIT_JSON_BYTES,
  apply = false, installHooks = false, now = () => new Date(),
} = {}) {
  const repo = resolve(recordsDir);
  if (!apply) {
    const plan = planOnHead(repo, git(repo, "rev-parse", "HEAD"), { retainRounds, maxAuditBytes, maxSealedLogBytes });
    return { apply: false, tombstonePath: plan.tombstonePath, prunedFiles: plan.prunedFiles, compactedAudits: stripInternal(plan.compactedAudits), bytesSaved: plan.bytesSaved, commit: null };
  }
  let resultPlan = null;
  const { commit } = commitRecords(repo, ctx => {
    const plan = planOnHead(repo, ctx.head, { retainRounds, maxAuditBytes, maxSealedLogBytes });
    resultPlan = plan;
    if (!plan.tombstonePath) return { message: "", value: null };
    for (const p of plan.prunedFiles) ctx.remove(p.path);
    for (const c of plan.compactedAudits) ctx.add(c.path, c.compactedBytes);
    const dateIso = (now() instanceof Date ? now() : new Date(now())).toISOString().slice(0, 19) + "Z";
    ctx.add(plan.tombstonePath, renderPruneManifest({ ...plan, dateIso, baseCommit: ctx.head, retainRounds }));
    if (ctx.files.has("INDEX.md")) {
      const index = indexOfTree(repo, ctx.tree());
      if (index !== ctx.read("INDEX.md")) ctx.add("INDEX.md", index);
    }
    return { message: `prune: ${plan.prId} (${plan.prunedFiles.length} pruned, ${plan.compactedAudits.length} compacted)`, value: plan.prId };
  });
  if (installHooks) installRecordsPreCommitHook(repo);
  return {
    apply: true,
    tombstonePath: resultPlan?.tombstonePath ?? null,
    prunedFiles: resultPlan?.prunedFiles ?? [],
    compactedAudits: stripInternal(resultPlan?.compactedAudits ?? []),
    bytesSaved: resultPlan?.bytesSaved ?? 0,
    commit: resultPlan?.tombstonePath ? commit : null,
  };
}
