#!/usr/bin/env node
// D-0016, D-0060, D-0064
import "./lib/unbind-git.mjs";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { load, Stop } from "./call.mjs";
import { cli, need, parseArgs, UsageError } from "./lib/args.mjs";
import { addedProse } from "./lib/comments.mjs";
import { git, gitOk } from "./lib/git-plumbing.mjs";
import { HANDOFFS } from "./lib/handoff.mjs";
import { parseProvenanceHandoffs, validateLeadPatchHandoff } from "./lib/provenance.mjs";
import { appendJsonLines, commitRecords, RecordsConflict } from "./lib/records-commit.mjs";

export const PATCH_LIMITS = Object.freeze({ maxLines: 20, maxFiles: 3, maxConsecutive: 2 });
const RESET_ROLES = new Set(["actor", "critic", "judge"]);
const USAGE = 'self-loop.mjs patch --records <dir> --reason "<why>" --verify "<cmd>" [--files <p1,p2>] [--dry-run] [--json]';
const cleanEnv = env => Object.fromEntries(Object.entries(env).filter(([k]) => k !== "NODE_TEST_CONTEXT"));
const pad = n => String(n).padStart(4, "0");

function normalizeRelPath(raw) {
  const p = raw.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!p || p.startsWith("/") || p.split("/").includes("..")) throw new UsageError(`invalid relative path: ${raw}`);
  return p;
}

function statusEntries(repo) {
  const out = spawnSync("git", ["-C", repo, "status", "--porcelain=v1", "-z", "--untracked-files=all"], { encoding: "utf8", maxBuffer: 1 << 28 });
  if (out.status !== 0) throw new Error(`git status failed: ${(out.stderr || "").trim()}`);
  const tracked = new Set(), untracked = new Set();
  for (let i = 0, tokens = out.stdout.split("\0").filter(Boolean); i < tokens.length; i++) {
    const code = tokens[i].slice(0, 2), path = tokens[i].slice(3);
    if (code === "??") untracked.add(path);
    else {
      tracked.add(path);
      if (/[RC]/.test(code)) tracked.add(tokens[++i]);
    }
  }
  return { tracked, untracked };
}

function countFileLines(filePath) {
  const buf = readFileSync(filePath);
  if (buf.includes(0)) return null;
  const text = buf.toString("utf8");
  if (!text.length) return 0;
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return text.charCodeAt(text.length - 1) === 10 ? n : n + 1;
}

function computeDiffStats(repo, selected, untrackedSet) {
  const tracked = selected.filter(p => !untrackedSet.has(p));
  const untracked = selected.filter(p => untrackedSet.has(p));
  let added = 0, deleted = 0;
  if (tracked.length) {
    const r = spawnSync("git", ["-C", repo, "diff", "--numstat", "-z", "HEAD", "--", ...tracked], { encoding: "utf8", maxBuffer: 1 << 28 });
    if (r.status !== 0) throw new Error(`git diff --numstat failed: ${(r.stderr || "").trim()}`);
    for (const part of r.stdout.split("\0").filter(Boolean)) {
      const m = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(part);
      if (!m) continue;
      if (m[1] === "-" || m[2] === "-") return { error: `binary file ${m[3] || tracked[0]} is not allowed in a lead micro-patch` };
      added += Number(m[1]);
      deleted += Number(m[2]);
    }
  }
  for (const path of untracked) {
    const full = join(repo, path), st = lstatSync(full, { throwIfNoEntry: false });
    if (!st || !st.isFile()) return { error: `untracked path ${path} is not a regular file` };
    const n = countFileLines(full);
    if (n === null) return { error: `binary file ${path} is not allowed in a lead micro-patch` };
    added += n;
  }
  return { added, deleted, total: added + deleted };
}

function checkProse(repo, selected) {
  return addedProse(selected.map(path => {
    const prev = spawnSync("git", ["-C", repo, "show", `HEAD:${path}`], { encoding: "utf8", maxBuffer: 1 << 26 });
    const full = join(repo, path), st = lstatSync(full, { throwIfNoEntry: false });
    return { path, before: prev.status === 0 ? prev.stdout : null, after: st?.isFile() ? readFileSync(full, "utf8") : null };
  }));
}

function consecutiveLeadPatches(handoffs, phase) {
  const scoped = phase ? handoffs.filter(h => h.phase === phase) : handoffs;
  let count = 0;
  for (let i = scoped.length - 1; i >= 0; i--) {
    if (scoped[i].role === "lead-patch") count++;
    else if (RESET_ROLES.has(scoped[i].role)) break;
  }
  return count;
}

export function leadPatch(cfg, { reason, verify, files = null, dryRun = false, env = process.env, now = () => new Date() } = {}) {
  const fail = message => ({ ok: false, code: 2, message });
  if (typeof reason !== "string" || !reason.trim()) throw new UsageError("--reason must be non-empty");
  if (typeof verify !== "string" || !verify.trim()) throw new UsageError("--verify must be non-empty");
  const cleanReason = reason.trim().replace(/\s+/g, " "), verifyCmd = verify.trim();
  const branchRes = spawnSync("git", ["-C", cfg.product, "symbolic-ref", "--short", "-q", "HEAD"], { encoding: "utf8" });
  const currentBranch = branchRes.status === 0 ? branchRes.stdout.trim() : "";
  if (!currentBranch) return fail("HEAD is detached; switch to the loop working branch before patching");
  if (!cfg.branch) return fail("loop.json has no working branch configured");
  if (cfg.protected.includes(currentBranch) || cfg.protected.includes(cfg.branch))
    return fail(`branch ${currentBranch} is protected; lead-patch is only allowed on the loop working branch`);
  if (currentBranch !== cfg.branch) return fail(`product is on ${currentBranch}, expected working branch ${cfg.branch}`);
  if (!dryRun && gitOk(cfg.records, "cat-file", "-e", `HEAD:${HANDOFFS}`) && !gitOk(cfg.records, "diff", "--quiet", "HEAD", "--", HANDOFFS))
    return fail(`${HANDOFFS} has uncommitted changes; commit or discard them first`);

  const rawHandoffs = gitOk(cfg.records, "cat-file", "-e", `HEAD:${HANDOFFS}`) ? git(cfg.records, "show", `HEAD:${HANDOFFS}`) : "";
  const streak = consecutiveLeadPatches(parseProvenanceHandoffs(rawHandoffs), cfg.phase);
  if (streak >= PATCH_LIMITS.maxConsecutive)
    return fail(`consecutive lead-patch limit reached (${streak}/${PATCH_LIMITS.maxConsecutive}); dispatch a planned actor instead`);

  const { tracked, untracked } = statusEntries(cfg.product);
  const allDirty = [...new Set([...tracked, ...untracked])].sort();
  let selected = allDirty;
  if (Array.isArray(files) && files.length) {
    const wanted = [...new Set(files.map(normalizeRelPath))].sort(), dirtySet = new Set(allDirty);
    const clean = wanted.filter(p => !dirtySet.has(p));
    if (clean.length) return fail(`requested file(s) have no uncommitted changes: ${clean.join(", ")}`);
    selected = wanted;
  }
  if (!selected.length) return fail("no changed files in product repository");
  if (selected.length > PATCH_LIMITS.maxFiles)
    return fail(`changed files (${selected.length}) exceeds hard cap (${PATCH_LIMITS.maxFiles}): ${selected.join(", ")}`);

  const stats = computeDiffStats(cfg.product, selected, untracked);
  if (stats.error) return fail(stats.error);
  if (stats.total <= 0) return fail("no changed lines in selected files");
  if (stats.total > PATCH_LIMITS.maxLines)
    return fail(`changed lines (${stats.total} = +${stats.added}/-${stats.deleted}) exceeds hard cap (${PATCH_LIMITS.maxLines})`);

  const prose = checkProse(cfg.product, selected);
  if (prose.length) return fail(`added prose or pending comment(s) refused (D-0016): ${prose.map(p => `${p.path}:${p.line}: ${p.text}`).join("; ")}`);

  const verified = spawnSync("sh", ["-c", verifyCmd], { cwd: cfg.product, encoding: "utf8", env: cleanEnv(env), maxBuffer: 1 << 26 });
  if (verified.status !== 0) {
    const tail = `${verified.stdout ?? ""}${verified.stderr ?? ""}`.trim().slice(-600);
    return fail(`--verify command exited ${verified.status ?? -1}: ${verifyCmd}${tail ? `\n${tail}` : ""}`);
  }

  const base = git(cfg.product, "rev-parse", "HEAD");
  if (dryRun) return { ok: true, code: 0, dryRun: true, branch: currentBranch, base, files: selected, lines: stats, verify: { command: verifyCmd, exit: 0 } };

  git(cfg.product, "add", "-A", "--", ...selected);
  git(cfg.product, "commit", "-q", "--no-verify", "-m", `loop(${cfg.phase}): lead-patch - ${cleanReason}`, "--", ...selected);
  const commit = git(cfg.product, "rev-parse", "HEAD");
  let committed;
  try {
    committed = commitRecords(cfg.records, ({ read, add }) => {
      const existing = parseProvenanceHandoffs(read(HANDOFFS));
      const curStreak = consecutiveLeadPatches(existing, cfg.phase);
      if (curStreak >= PATCH_LIMITS.maxConsecutive)
        throw new RecordsConflict(`consecutive lead-patch limit reached (${curStreak}/${PATCH_LIMITS.maxConsecutive})`);
      const entry = validateLeadPatchHandoff({
        id: `LP-${pad(existing.filter(h => h.role === "lead-patch").length + 1)}`,
        time: now().toISOString().slice(0, 19) + "Z",
        phase: cfg.phase, role: "lead-patch", product: { base, commit }, files: selected,
        lines: stats, reason: cleanReason, verify: { command: verifyCmd, exit: 0 }, audit: { violations: 0 },
      });
      add(HANDOFFS, appendJsonLines(read(HANDOFFS), [entry]));
      return { message: `${cfg.commitPrefix ?? "self-loop"}: ${entry.id} lead-patch`, value: entry };
    });
  } catch (e) {
    spawnSync("git", ["-C", cfg.product, "reset", "-q", "--soft", base], { stdio: "ignore" });
    return fail(`records commit failed (product commit rolled back): ${e.message}`);
  }
  return { ok: true, code: 0, dryRun: false, branch: currentBranch, handoff: committed.value, recordsCommit: committed.commit };
}

export function main(argv, { env = process.env } = {}) {
  const args = parseArgs(argv);
  if (args._.length) throw new UsageError(USAGE);
  need(args, "reason", "verify");
  const configPath = args.config ? resolve(args.config) : args.records ? join(resolve(args.records), "loop.json") : null;
  if (!configPath || !existsSync(configPath)) throw new UsageError(`--records or --config must name a loop.json (${USAGE})`);
  let cfg;
  try { cfg = load(configPath); } catch (e) { throw new UsageError(e instanceof Stop ? e.message : `${configPath}: ${e.message}`); }
  const files = args.files ? String(args.files).split(",").map(s => s.trim()).filter(Boolean) : null;
  const res = leadPatch(cfg, { reason: args.reason, verify: args.verify, files, dryRun: "dry-run" in args, env });
  if ("json" in args) console.log(JSON.stringify(res, null, 2));
  else if (!res.ok) console.error(`lead-patch: ${res.message}`);
  else if (res.dryRun) console.log(`lead-patch dry-run ok on ${res.branch} (${res.files.length} file(s), ${res.lines.total} line(s))`);
  else console.log(`${res.handoff.id} committed ${res.handoff.product.commit.slice(0, 7)} on ${res.branch} (records ${res.recordsCommit.slice(0, 7)})`);
  return res.code;
}

const invokedAsScript = () => {
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
};
if (invokedAsScript()) cli(() => main(process.argv.slice(2)));
