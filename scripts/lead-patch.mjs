#!/usr/bin/env node
// D-0016, D-0060, D-0064, F-0016
import "./lib/unbind-git.mjs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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
const ALLOWED_MODES = new Set(["000000", "100644", "100755"]);
const USAGE = 'self-loop.mjs patch --records <dir> --reason "<why>" --verify "<cmd>" [--diff <file|-> | --files <p1,p2>] [--dry-run] [--json]';
const cleanEnv = env => Object.fromEntries(Object.entries(env).filter(([k]) => k !== "NODE_TEST_CONTEXT"));
const pad = n => String(n).padStart(4, "0");
const gitRun = (repo, argv, env, opts = {}) =>
  spawnSync("git", ["-C", repo, ...argv], { encoding: "utf8", maxBuffer: 1 << 28, env: { GIT_TERMINAL_PROMPT: "0", ...env }, ...opts });

function withNoGitMaintenance(env) {
  const out = cleanEnv(env), cur = Number(out.GIT_CONFIG_COUNT ?? 0), base = Number.isInteger(cur) && cur > 0 ? cur : 0;
  return {
    ...out,
    [`GIT_CONFIG_KEY_${base}`]: "gc.auto", [`GIT_CONFIG_VALUE_${base}`]: "0",
    [`GIT_CONFIG_KEY_${base + 1}`]: "maintenance.auto", [`GIT_CONFIG_VALUE_${base + 1}`]: "false",
    GIT_CONFIG_COUNT: String(base + 2),
  };
}

function normalizeRelPath(raw) {
  const p = raw.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!p || p.startsWith("/") || p.split("/").includes("..")) throw new UsageError(`invalid relative path: ${raw}`);
  return p;
}

function validatePatchPath(raw) {
  if (typeof raw !== "string" || !raw || raw.startsWith("/") || raw.includes("\\")) return `invalid patch path: ${raw}`;
  const parts = raw.split("/");
  if (parts.some(p => !p || p === "." || p === "..")) return `invalid patch path: ${raw}`;
  if (parts.some(p => p.toLowerCase() === ".git")) return `disallowed .git path in patch: ${raw}`;
  if (parts[0].toLowerCase() === "sealed" || (parts[0] === ".self-loop" && parts[1]?.toLowerCase() === "sealed"))
    return `disallowed sealed path in patch: ${raw}`;
  return null;
}

function readDiffInput({ diff, diffText, stdin, cwd }) {
  let raw;
  if (diffText !== null && diffText !== undefined) {
    if (typeof diffText !== "string") throw new UsageError("diffText must be a string");
    raw = diffText;
  } else if (diff === "-") {
    raw = stdin !== null && stdin !== undefined ? (Buffer.isBuffer(stdin) ? stdin.toString("utf8") : String(stdin)) : readFileSync(0, "utf8");
  } else if (typeof diff === "string" && diff.trim()) {
    try { raw = readFileSync(resolve(cwd, diff), "utf8"); } catch (e) { throw new UsageError(`cannot read --diff ${diff}: ${e.message}`); }
  } else throw new UsageError("--diff requires a file path or -");
  if (!raw.trim()) throw new UsageError("--diff input is empty");
  return raw;
}

function statusEntries(repo) {
  const out = spawnSync("git", ["-C", repo, "status", "--porcelain=v1", "-z", "--untracked-files=all"], { encoding: "utf8", maxBuffer: 1 << 28 });
  if (out.status !== 0) throw new Error(`git status failed: ${(out.stderr || "").trim()}`);
  const tracked = new Set(), untracked = new Set();
  for (let i = 0, tokens = out.stdout.split("\0").filter(Boolean); i < tokens.length; i++) {
    const code = tokens[i].slice(0, 2), path = tokens[i].slice(3);
    if (code === "??") untracked.add(path); else { tracked.add(path); if (/[RC]/.test(code)) tracked.add(tokens[++i]); }
  }
  return { tracked, untracked };
}

function countFileLines(filePath) {
  const buf = readFileSync(filePath);
  if (buf.includes(0)) return null;
  const text = buf.toString("utf8");
  return text ? text.split("\n").length - (text.endsWith("\n") ? 1 : 0) : 0;
}

function computeDiffStats(repo, selected, untrackedSet) {
  const tracked = selected.filter(p => !untrackedSet.has(p)), untracked = selected.filter(p => untrackedSet.has(p));
  let added = 0, deleted = 0;
  if (tracked.length) {
    const r = spawnSync("git", ["-C", repo, "diff", "--numstat", "-z", "HEAD", "--", ...tracked], { encoding: "utf8", maxBuffer: 1 << 28 });
    if (r.status !== 0) throw new Error(`git diff --numstat failed: ${(r.stderr || "").trim()}`);
    for (const part of r.stdout.split("\0").filter(Boolean)) {
      const m = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(part);
      if (!m) continue;
      if (m[1] === "-" || m[2] === "-") return { error: `binary file ${m[3] || tracked[0]} is not allowed in a lead micro-patch` };
      added += Number(m[1]); deleted += Number(m[2]);
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

function runVerify(verifyCmd, cwd, env) {
  const r = spawnSync("sh", ["-c", verifyCmd], { cwd, encoding: "utf8", env, maxBuffer: 1 << 26 });
  if (r.status === 0) return null;
  const tail = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim().slice(-600);
  return `--verify command exited ${r.status ?? -1}: ${verifyCmd}${tail ? `\n${tail}` : ""}`;
}

function inspectStagedDiff(wt, base, product, gitEnv) {
  const rawRes = gitRun(wt, ["diff", "--cached", "--raw", "-z", base], gitEnv);
  if (rawRes.status !== 0) return { error: `git diff --cached --raw failed: ${(rawRes.stderr || "").trim()}` };
  const entries = [], pathSet = new Set();
  for (let i = 0, tokens = rawRes.stdout.split("\0"); i < tokens.length && tokens[i] !== "";) {
    const m = /^:(\d{6}) (\d{6}) [0-9a-f]+ [0-9a-f]+ ([A-Z]\d*)$/.exec(tokens[i]);
    if (!m) return { error: `unexpected git diff --raw entry: ${tokens[i]}` };
    const [, oldMode, newMode, status] = m, isRC = status[0] === "R" || status[0] === "C";
    const entry = isRC ? { oldMode, newMode, srcPath: tokens[i + 1], path: tokens[i + 2], isNew: true }
      : { oldMode, newMode, srcPath: null, path: tokens[i + 1], isNew: oldMode === "000000" };
    i += isRC ? 3 : 2;
    if (!ALLOWED_MODES.has(oldMode) || !ALLOWED_MODES.has(newMode))
      return { error: `disallowed file mode (${oldMode} -> ${newMode}) for ${entry.path}; only regular files (100644/100755) are allowed` };
    for (const p of entry.srcPath ? [entry.srcPath, entry.path] : [entry.path]) {
      const bad = validatePatchPath(p);
      if (bad) return { error: bad };
      pathSet.add(p);
    }
    entries.push(entry);
  }
  const files = [...pathSet].sort();
  if (!files.length) return { error: "diff produces no file changes" };
  if (files.length > PATCH_LIMITS.maxFiles)
    return { error: `changed files (${files.length}) exceeds hard cap (${PATCH_LIMITS.maxFiles}): ${files.join(", ")}` };

  const numRes = gitRun(wt, ["diff", "--cached", "--numstat", "-z", base], gitEnv);
  if (numRes.status !== 0) return { error: `git diff --cached --numstat failed: ${(numRes.stderr || "").trim()}` };
  let added = 0, deleted = 0;
  for (let i = 0, tokens = numRes.stdout.split("\0"); i < tokens.length && tokens[i] !== "";) {
    const m = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(tokens[i]);
    if (!m) { i++; continue; }
    const label = m[3] === "" ? (tokens[i + 2] || tokens[i + 1] || "") : m[3];
    i += m[3] === "" ? 3 : 1;
    if (m[1] === "-" || m[2] === "-") return { error: `binary file ${label} is not allowed in a lead micro-patch` };
    added += Number(m[1]); deleted += Number(m[2]);
  }
  const stats = { added, deleted, total: added + deleted };
  if (stats.total <= 0) return { error: "no changed lines in diff" };
  if (stats.total > PATCH_LIMITS.maxLines) return { error: `changed lines (${stats.total} = +${stats.added}/-${stats.deleted}) exceeds hard cap (${PATCH_LIMITS.maxLines})` };
  for (const e of entries) {
    if (!e.isNew || gitOk(product, "cat-file", "-e", `${base}:${e.path}`)) continue;
    if (lstatSync(join(product, e.path), { throwIfNoEntry: false })) return { error: `untracked file collision in product repository: ${e.path}` };
    for (let parts = e.path.split("/"), k = 1; k < parts.length; k++) {
      const prefix = parts.slice(0, k).join("/"), st = lstatSync(join(product, prefix), { throwIfNoEntry: false });
      if (st && !st.isDirectory()) return { error: `untracked file collision in product repository: ${prefix}` };
    }
  }
  const proseInput = [];
  for (const path of files) {
    const prev = gitRun(wt, ["show", `${base}:${path}`], gitEnv, { encoding: null });
    const next = gitRun(wt, ["show", `:${path}`], gitEnv, { encoding: null });
    if (next.status === 0 && next.stdout.includes(0)) return { error: `binary file ${path} is not allowed in a lead micro-patch` };
    proseInput.push({ path, before: prev.status === 0 ? prev.stdout.toString("utf8") : null, after: next.status === 0 ? next.stdout.toString("utf8") : null });
  }
  const prose = addedProse(proseInput);
  if (prose.length) return { error: `added prose or pending comment(s) refused (D-0016): ${prose.map(p => `${p.path}:${p.line}: ${p.text}`).join("; ")}` };
  return { files, stats };
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

function recordLeadPatch(cfg, { base, commit, files, stats, cleanReason, verifyCmd, diffMode, diffSha256, now }) {
  return commitRecords(cfg.records, ({ read, add }) => {
    const existing = parseProvenanceHandoffs(read(HANDOFFS));
    const curStreak = consecutiveLeadPatches(existing, cfg.phase);
    if (curStreak >= PATCH_LIMITS.maxConsecutive)
      throw new RecordsConflict(`consecutive lead-patch limit reached (${curStreak}/${PATCH_LIMITS.maxConsecutive})`);
    const entry = validateLeadPatchHandoff({
      id: `LP-${pad(existing.filter(h => h.role === "lead-patch").length + 1)}`,
      time: now().toISOString().slice(0, 19) + "Z",
      phase: cfg.phase, role: "lead-patch", product: { base, commit }, files,
      lines: stats, reason: cleanReason, verify: { command: verifyCmd, exit: 0 }, audit: { violations: 0 },
      ...(diffMode ? { diffMode: true, diffSha256 } : {}),
    });
    add(HANDOFFS, appendJsonLines(read(HANDOFFS), [entry]));
    return { message: `${cfg.commitPrefix ?? "self-loop"}: ${entry.id} lead-patch`, value: entry };
  });
}

function leadPatchFromDiff(cfg, { rawDiff, cleanReason, verifyCmd, currentBranch, dryRun, env, now, fail }) {
  const diffSha256 = createHash("sha256").update(rawDiff, "utf8").digest("hex");
  const base = git(cfg.product, "rev-parse", "HEAD"), gitEnv = withNoGitMaintenance(env);
  const tmpParent = mkdtempSync(join(tmpdir(), "self-loop-lead-patch-")), tmpWt = join(tmpParent, "wt");
  let wtAdded = false;
  try {
    const addedWt = gitRun(cfg.product, ["worktree", "add", "-q", "--detach", tmpWt, base], gitEnv);
    if (addedWt.status !== 0) return fail(`git worktree add failed: ${(addedWt.stderr || "").trim()}`);
    wtAdded = true;
    const applied = gitRun(tmpWt, ["apply", "--index", "--whitespace=nowarn", "-"], gitEnv, { input: rawDiff });
    if (applied.status !== 0) return fail(`git apply failed: ${(applied.stderr || applied.stdout || `exit ${applied.status}`).trim()}`);
    const checked = inspectStagedDiff(tmpWt, base, cfg.product, gitEnv);
    if (checked.error) return fail(checked.error);
    const stagedTree = gitRun(tmpWt, ["write-tree"], gitEnv);
    if (stagedTree.status !== 0) return fail(`git write-tree failed: ${(stagedTree.stderr || "").trim()}`);
    const verifyErr = runVerify(verifyCmd, tmpWt, gitEnv);
    if (verifyErr) return fail(verifyErr);
    if (dryRun) return { ok: true, code: 0, dryRun: true, diffMode: true, diffSha256, branch: currentBranch, base, files: checked.files, lines: checked.stats, verify: { command: verifyCmd, exit: 0 } };
    const restored = gitRun(tmpWt, ["read-tree", stagedTree.stdout.trim()], gitEnv);
    if (restored.status !== 0) return fail(`git read-tree failed: ${(restored.stderr || "").trim()}`);
    const committedWt = gitRun(tmpWt, ["commit", "-q", "--no-verify", "-m", `loop(${cfg.phase}): lead-patch - ${cleanReason}`], gitEnv);
    if (committedWt.status !== 0) return fail(`git commit failed: ${(committedWt.stderr || "").trim()}`);
    const commit = gitRun(tmpWt, ["rev-parse", "HEAD"], gitEnv).stdout.trim();
    const merged = gitRun(cfg.product, ["merge", "--ff-only", "-q", commit], gitEnv);
    if (merged.status !== 0) return fail(`git merge --ff-only failed: ${(merged.stderr || merged.stdout || `exit ${merged.status}`).trim()}`);
    try {
      const committed = recordLeadPatch(cfg, { base, commit, files: checked.files, stats: checked.stats, cleanReason, verifyCmd, diffMode: true, diffSha256, now });
      return { ok: true, code: 0, dryRun: false, diffMode: true, diffSha256, branch: currentBranch, handoff: committed.value, recordsCommit: committed.commit };
    } catch (e) {
      spawnSync("git", ["-C", cfg.product, "reset", "-q", "--hard", base], { stdio: "ignore", env: gitEnv });
      return fail(`records commit failed (product commit rolled back): ${e.message}`);
    }
  } finally {
    if (wtAdded) {
      spawnSync("git", ["-C", cfg.product, "worktree", "remove", "--force", tmpWt], { stdio: "ignore", env: gitEnv });
      spawnSync("git", ["-C", cfg.product, "worktree", "prune"], { stdio: "ignore", env: gitEnv });
    }
    rmSync(tmpParent, { recursive: true, force: true });
  }
}

export function leadPatch(cfg, { reason, verify, files = null, diff = null, diffText = null, stdin = null, dryRun = false, cwd = process.cwd(), env = process.env, now = () => new Date() } = {}) {
  const fail = message => ({ ok: false, code: 2, message });
  if (typeof reason !== "string" || !reason.trim()) throw new UsageError("--reason must be non-empty");
  if (typeof verify !== "string" || !verify.trim()) throw new UsageError("--verify must be non-empty");
  const diffMode = (diff !== null && diff !== undefined) || (diffText !== null && diffText !== undefined);
  if (diffMode && files !== null && files !== undefined) throw new UsageError("--diff and --files cannot be combined");
  const rawDiff = diffMode ? readDiffInput({ diff, diffText, stdin, cwd }) : null;
  const cleanReason = reason.trim().replace(/\s+/g, " "), verifyCmd = verify.trim();
  const branchRes = spawnSync("git", ["-C", cfg.product, "symbolic-ref", "--short", "-q", "HEAD"], { encoding: "utf8" });
  const currentBranch = branchRes.status === 0 ? branchRes.stdout.trim() : "";
  if (!currentBranch) return fail("HEAD is detached; switch to the loop working branch before patching");
  if (!cfg.branch) return fail("loop.json has no working branch configured");
  if (cfg.protected.includes(currentBranch) || cfg.protected.includes(cfg.branch))
    return fail(`branch ${currentBranch} is protected; lead-patch is only allowed on the loop working branch`);
  if (currentBranch !== cfg.branch) return fail(`product is on ${currentBranch}, expected working branch ${cfg.branch}`);
  const handoffsDirty = spawnSync("git", ["-C", cfg.records, "status", "--porcelain=v1", "--", HANDOFFS], { encoding: "utf8" });
  if (!dryRun && handoffsDirty.status === 0 && handoffsDirty.stdout.trim())
    return fail(`${HANDOFFS} has uncommitted changes; commit or discard them first`);

  const rawHandoffs = gitOk(cfg.records, "cat-file", "-e", `HEAD:${HANDOFFS}`) ? git(cfg.records, "show", `HEAD:${HANDOFFS}`) : "";
  const streak = consecutiveLeadPatches(parseProvenanceHandoffs(rawHandoffs), cfg.phase);
  if (streak >= PATCH_LIMITS.maxConsecutive)
    return fail(`consecutive lead-patch limit reached (${streak}/${PATCH_LIMITS.maxConsecutive}); dispatch a planned actor instead`);

  const { tracked, untracked } = statusEntries(cfg.product);
  if (diffMode) {
    if (tracked.size > 0)
      return fail(`product repository has uncommitted tracked changes (${[...tracked].sort().join(", ")}); commit or discard them before using --diff`);
    return leadPatchFromDiff(cfg, { rawDiff, cleanReason, verifyCmd, currentBranch, dryRun, env, now, fail });
  }

  const allDirty = [...new Set([...tracked, ...untracked])].sort();
  let selected = allDirty;
  if (Array.isArray(files) && files.length) {
    const wanted = [...new Set(files.map(normalizeRelPath))].sort(), dirtySet = new Set(allDirty);
    const clean = wanted.filter(p => !dirtySet.has(p));
    if (clean.length) return fail(`requested file(s) have no uncommitted changes: ${clean.join(", ")}`);
    selected = wanted;
  }
  if (!selected.length) return fail("no changed files in product repository");
  if (selected.length > PATCH_LIMITS.maxFiles) return fail(`changed files (${selected.length}) exceeds hard cap (${PATCH_LIMITS.maxFiles}): ${selected.join(", ")}`);
  const stats = computeDiffStats(cfg.product, selected, untracked);
  if (stats.error) return fail(stats.error);
  if (stats.total <= 0) return fail("no changed lines in selected files");
  if (stats.total > PATCH_LIMITS.maxLines) return fail(`changed lines (${stats.total} = +${stats.added}/-${stats.deleted}) exceeds hard cap (${PATCH_LIMITS.maxLines})`);
  const prose = checkProse(cfg.product, selected);
  if (prose.length) return fail(`added prose or pending comment(s) refused (D-0016): ${prose.map(p => `${p.path}:${p.line}: ${p.text}`).join("; ")}`);
  const verifyErr = runVerify(verifyCmd, cfg.product, cleanEnv(env));
  if (verifyErr) return fail(verifyErr);

  const base = git(cfg.product, "rev-parse", "HEAD");
  if (dryRun) return { ok: true, code: 0, dryRun: true, branch: currentBranch, base, files: selected, lines: stats, verify: { command: verifyCmd, exit: 0 } };
  git(cfg.product, "add", "-A", "--", ...selected);
  git(cfg.product, "commit", "-q", "--no-verify", "-m", `loop(${cfg.phase}): lead-patch - ${cleanReason}`, "--", ...selected);
  const commit = git(cfg.product, "rev-parse", "HEAD");
  try {
    const committed = recordLeadPatch(cfg, { base, commit, files: selected, stats, cleanReason, verifyCmd, diffMode: false, diffSha256: null, now });
    return { ok: true, code: 0, dryRun: false, branch: currentBranch, handoff: committed.value, recordsCommit: committed.commit };
  } catch (e) {
    spawnSync("git", ["-C", cfg.product, "reset", "-q", "--soft", base], { stdio: "ignore" });
    return fail(`records commit failed (product commit rolled back): ${e.message}`);
  }
}

export function main(argv, { env = process.env, cwd = process.cwd(), stdin = null } = {}) {
  const args = parseArgs(argv);
  if (args._.length) throw new UsageError(USAGE);
  if ("diff" in args && "files" in args) throw new UsageError("--diff and --files cannot be combined");
  if ("diff" in args && !args.diff) throw new UsageError("--diff requires a file path or -");
  if ("dry-run" in args && args["dry-run"] !== "") throw new UsageError("--dry-run takes no value");
  if ("json" in args && args.json !== "") throw new UsageError("--json takes no value");
  need(args, "reason", "verify");
  const configPath = args.config ? resolve(cwd, args.config) : args.records ? join(resolve(cwd, args.records), "loop.json") : null;
  if (!configPath || !existsSync(configPath)) throw new UsageError(`--records or --config must name a loop.json (${USAGE})`);
  let cfg;
  try { cfg = load(configPath); } catch (e) { throw new UsageError(e instanceof Stop ? e.message : `${configPath}: ${e.message}`); }
  const files = args.files ? String(args.files).split(",").map(s => s.trim()).filter(Boolean) : null;
  const res = leadPatch(cfg, { reason: args.reason, verify: args.verify, files, diff: "diff" in args ? args.diff : null, stdin, dryRun: "dry-run" in args, cwd, env });
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
