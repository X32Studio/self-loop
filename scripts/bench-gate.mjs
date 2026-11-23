#!/usr/bin/env node
// Gate: is the candidate commit at most `--max-ratio` times slower than the base commit on one benchmark? Both commits
// are checked out as fresh detached worktrees in a temporary folder (nothing uncommitted, untracked or ignored takes
// part), the install command runs in each, then the benchmark command runs in alternating pairs: warm-up pairs first
// (discarded), then measured pair k runs base-then-candidate when k is odd and candidate-then-base when k is even. Each
// run must exit 0 and print one JSON object whose `--metric` field (dotted path) is a positive number and which meets
// every `--require` condition; any other run stops the gate red. The statistic is the per-pair ratio candidate/base;
// the gate is the distribution-free one-sided upper confidence bound of its median (an order statistic chosen by the
// binomial distribution, no assumption on the shape of the timings): green only if that bound is at most --max-ratio.
//
// node bench-gate.mjs --repo <dir> --base <rev> --candidate <rev> --command "<benchmark>" --metric <field>
//   [--install "<command>"] [--require "f=v,g<=w,..."] [--pairs 24] [--warmup 1] [--max-ratio 1.10]
//   [--confidence 0.95] [--timeout-min 30] [--out <path prefix>]
// Prints the receipt { repository, base, candidate, command, install, metric, require, pairs, warmup, maxRatio,
// confidence, order, ratios, medianRatio, lower, upper, medianDiff, stats, host, durationMs, green, reasons, runs }.
// With --out it also writes <prefix>.json and <prefix>.runs.jsonl.gz (never overwriting) for the lead to commit as
// evidence. Exit 0 green, 2 not green, 64 usage.
import "./lib/unbind-git.mjs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, linkSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { arch, cpus, loadavg, platform, tmpdir, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { cli, need, parseArgs, UsageError } from "./lib/args.mjs";
import { fullSha } from "./lib/ci.mjs";

// Accumulate the binomial tail in log space, where 2**(-n) does not underflow at large n.
function* binomialHalfLogCdf(n) {
  let term = -n * Math.LN2, sum = -Infinity;
  for (let i = 0; i <= n; i++) {
    sum = Math.max(sum, term) + Math.log1p(Math.exp(-Math.abs(sum - term)));
    yield sum;
    term += Math.log(n - i) - Math.log(i + 1);
  }
}

/** P(X <= k) for X ~ Binomial(n, 1/2). */
export function binomialHalfCdf(k, n) {
  if (k < 0) return 0;
  if (k >= n) return 1;
  for (const logCdf of binomialHalfLogCdf(n)) if (k-- < 1) return Math.exp(logCdf);
}

/** One-sided ranks and their nominal coverage for independent paired values. */
export function medianBoundRanks(n, confidence) {
  const threshold = Math.log1p(-confidence);
  let lower = 0, coverage = null;
  for (const logCdf of binomialHalfLogCdf(n)) {
    if (lower >= Math.floor((n + 1) / 2) || !Number.isFinite(logCdf) || logCdf > threshold) break;
    lower++;
    coverage = -Math.expm1(logCdf);
  }
  return lower ? { lower, upper: n + 1 - lower, coverage } : null;
}

const median = xs => { const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const field = (obj, path) => path.split(".").reduce((o, k) => (o != null && typeof o === "object" ? o[k] : undefined), obj);

/** `f=v,g<=w,h>=x` → conditions; values compare as numbers when both sides are numeric, otherwise as strings. */
export function parseRequire(text) {
  if (!text) return [];
  return text.split(",").map(s => s.trim()).filter(Boolean).map(s => {
    const m = /^([A-Za-z_$][\w$.]*)\s*(<=|>=|=)\s*(.+)$/.exec(s);
    if (!m) throw new UsageError(`--require: cannot read "${s}" (field=value, field<=value or field>=value)`);
    return { field: m[1], op: m[2], value: m[3] };
  });
}

/** Every reason one run's result does not count: no JSON, no positive metric, a condition not met. */
export function runReasons(result, metric, conditions) {
  if (!result || typeof result !== "object") return ["the output is not one JSON object"];
  const reasons = [];
  const value = field(result, metric);
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) reasons.push(`${metric} is ${JSON.stringify(value)}, not a positive number`);
  for (const c of conditions) {
    const got = field(result, c.field);
    const numeric = typeof got === "number" && c.value.trim() !== "" && Number.isFinite(Number(c.value));
    const ok = c.op === "=" ? (numeric ? got === Number(c.value) : String(got) === c.value)
      : numeric && (c.op === "<=" ? got <= Number(c.value) : got >= Number(c.value));
    if (!ok) reasons.push(`${c.field} is ${JSON.stringify(got)}, required ${c.op} ${c.value}`);
  }
  return reasons;
}

/**
 * The verdict on recorded runs ({ version: "base" | "candidate", pair, metric }): measured pairs are those with
 * pair >= 1 (pair 0 and below are warm-up). Every measured pair must hold exactly one run of each version.
 */
export function judgeRuns(runs, { pairs, maxRatio, confidence }) {
  const reasons = [];
  const byPair = new Map();
  for (const r of runs.filter(r => r.pair >= 1)) {
    const p = byPair.get(r.pair) ?? {};
    if (p[r.version] !== undefined) reasons.push(`pair ${r.pair} has two ${r.version} runs`);
    p[r.version] = r.metric;
    byPair.set(r.pair, p);
  }
  const complete = [...byPair.entries()].filter(([, p]) => p.base !== undefined && p.candidate !== undefined).sort((a, b) => a[0] - b[0]);
  if (complete.length !== pairs) reasons.push(`${complete.length} complete pair(s), ${pairs} required`);
  const ranks = medianBoundRanks(complete.length, confidence);
  if (!ranks) reasons.push(`${complete.length} pair(s) cannot bound a median at ${confidence}`);
  const ratios = complete.map(([, p]) => p.candidate / p.base).sort((a, b) => a - b);
  const diffs = complete.map(([, p]) => p.candidate - p.base);
  const upper = ranks ? ratios[ranks.upper - 1] : null;
  const lower = ranks ? ratios[ranks.lower - 1] : null;
  if (upper !== null && upper > maxRatio) reasons.push(`the one-sided ${confidence} upper bound of the median ratio is ${upper.toFixed(4)}, above ${maxRatio}`);
  const stats = version => {
    const xs = complete.map(([, p]) => p[version]);
    return xs.length ? { min: Math.min(...xs), median: median(xs), max: Math.max(...xs) } : null;
  };
  return {
    green: reasons.length === 0, reasons, ranks, ratios, upper, lower,
    medianRatio: ratios.length ? median(ratios) : null, medianDiff: diffs.length ? median(diffs) : null,
    stats: { base: stats("base"), candidate: stats("candidate") },
  };
}

/** The benchmark's entire stdout is its result channel. */
export function parseResult(stdout) {
  try {
    const result = JSON.parse(stdout);
    return result && typeof result === "object" && !Array.isArray(result) ? result : null;
  } catch { return null; }
}

// NODE_TEST_CONTEXT, set when this runs inside a node --test process, would change an inner node --test's output.
const ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "NODE_TEST_CONTEXT"));
const sh = (command, cwd, timeoutMin) => {
  const r = spawnSync("sh", ["-c", command], { cwd, env: ENV, encoding: "utf8", maxBuffer: 1 << 30, timeout: timeoutMin * 60_000 });
  return { exit: r.status ?? -1, stdout: r.stdout ?? "", stderr: `${r.stderr ?? ""}${r.error ? `\n${r.error.message}` : ""}` };
};

/** Run the paired benchmark of `repo`: `base` against `candidate`, each in a clean detached worktree. */
export function benchGate({ repo, base, candidate, command, metric, install = null, require = "", pairs = 24, warmup = 1,
  maxRatio = 1.1, confidence = 0.95, timeoutMin = 30, onRun = () => {} }) {
  repo = resolve(repo);
  const conditions = parseRequire(require);
  if (!medianBoundRanks(pairs, confidence)) throw new UsageError(`--pairs ${pairs} cannot bound a median at confidence ${confidence}`);
  const shas = { base: fullSha(repo, base), candidate: fullSha(repo, candidate) };
  const dir = mkdtempSync(join(tmpdir(), "bench-gate-"));
  const trees = { base: join(dir, "base"), candidate: join(dir, "candidate") };
  const started = Date.now();
  const runs = [], reasons = [];
  try {
    for (const v of ["base", "candidate"]) {
      const add = spawnSync("git", ["-C", repo, "worktree", "add", "-q", "--detach", trees[v], shas[v]], { encoding: "utf8" });
      if (add.status !== 0) throw new UsageError(`git worktree add failed: ${add.stderr}`);
      if (install) {
        const r = sh(install, trees[v], timeoutMin);
        if (r.exit !== 0) { reasons.push(`install exited ${r.exit} in the ${v} worktree`); runs.push({ version: v, pair: "install", exit: r.exit, stderr: r.stderr.slice(-4000) }); }
      }
    }
    for (let pair = 1 - warmup; pair <= pairs && reasons.length === 0; pair++) {
      const order = pair >= 1 && pair % 2 === 0 ? ["candidate", "base"] : ["base", "candidate"];
      for (const version of order) {
        const t0 = Date.now(), load = loadavg();
        const r = sh(command, trees[version], timeoutMin);
        const result = parseResult(r.stdout);
        const why = r.exit !== 0 ? [`the command exited ${r.exit}`] : runReasons(result, metric, conditions);
        const row = { version, pair, warmup: pair < 1, exit: r.exit, ms: Date.now() - t0, load1m: load[0], metric: result ? field(result, metric) ?? null : null, result, reasons: why, ...(why.length ? { stdout: r.stdout.slice(-4000), stderr: r.stderr.slice(-4000) } : {}) };
        runs.push(row);
        onRun(row);
        if (why.length) { reasons.push(`${version} run of pair ${pair}: ${why.join("; ")}`); break; }
      }
    }
  } finally {
    for (const v of ["base", "candidate"]) spawnSync("git", ["-C", repo, "worktree", "remove", "--force", trees[v]], { stdio: "ignore" });
    rmSync(dir, { recursive: true, force: true });
  }
  const verdict = reasons.length ? { green: false, reasons: [], ranks: medianBoundRanks(pairs, confidence), ratios: [], upper: null, lower: null, medianRatio: null, medianDiff: null, stats: null }
    : judgeRuns(runs.filter(r => r.pair !== "install"), { pairs, maxRatio, confidence });
  const text = runs.map(r => JSON.stringify(r)).join("\n") + "\n";
  return {
    repository: repo, base: shas.base, candidate: shas.candidate, command, install, metric, require, pairs, warmup, maxRatio, confidence,
    order: "warm-up pairs base then candidate; measured pair k: base then candidate when k is odd, candidate then base when even",
    samplingAssumption: "Nominal coverage assumes independent paired ratios.",
    ranks: verdict.ranks, ratios: verdict.ratios, medianRatio: verdict.medianRatio, lower: verdict.lower, upper: verdict.upper,
    medianDiff: verdict.medianDiff, stats: verdict.stats,
    host: { platform: platform(), arch: arch(), node: process.version, cpus: cpus().length, memoryBytes: totalmem() },
    durationMs: Date.now() - started, green: reasons.length === 0 && verdict.green, reasons: [...reasons, ...verdict.reasons],
    runs: { count: runs.length, sha256: createHash("sha256").update(text).digest("hex"), bytes: Buffer.byteLength(text) }, text,
  };
}

function withEvidence(prefix, measure) {
  if (!prefix) return measure();
  prefix = resolve(prefix);
  const receipt = `${prefix}.json`, runs = `${prefix}.runs.jsonl.gz`, lock = `${prefix}.lock`;
  mkdirSync(dirname(prefix), { recursive: true });
  try { mkdirSync(lock, { mode: 0o700 }); }
  catch (error) {
    if (error.code === "EEXIST") throw new UsageError(`evidence prefix ${prefix} is already reserved`);
    throw error;
  }
  try {
    if (existsSync(receipt) || existsSync(runs)) throw new UsageError(`evidence prefix ${prefix} is already in use`);
    const result = measure(), { text, ...shown } = result;
    const preparedRuns = join(lock, "runs.gz"), preparedReceipt = join(lock, "receipt.json");
    writeFileSync(preparedRuns, gzipSync(text));
    writeFileSync(preparedReceipt, `${JSON.stringify(shown, null, 1)}\n`);
    // Publishing the receipt last makes it the marker of a complete pair. Links cannot overwrite either file.
    linkSync(preparedRuns, runs);
    try { linkSync(preparedReceipt, receipt); }
    catch (error) { rmSync(runs); throw error; }
    return result;
  } finally { rmSync(lock, { recursive: true, force: true }); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) cli(() => {
  const args = parseArgs(process.argv.slice(2));
  need(args, "repo", "base", "candidate", "command", "metric");
  const num = (key, fallback) => {
    if (args[key] === undefined || args[key] === "") return fallback;
    const n = Number(args[key]);
    if (!Number.isFinite(n)) throw new UsageError(`--${key} must be a number`);
    return n;
  };
  const opts = {
    repo: args.repo, base: args.base, candidate: args.candidate, command: args.command, metric: args.metric,
    install: args.install || null, require: args.require || "", pairs: num("pairs", 24), warmup: num("warmup", 1),
    maxRatio: num("max-ratio", 1.1), confidence: num("confidence", 0.95), timeoutMin: num("timeout-min", 30),
  };
  if (!Number.isInteger(opts.pairs) || opts.pairs < 1 || !Number.isInteger(opts.warmup) || opts.warmup < 0) throw new UsageError("--pairs must be a positive integer and --warmup a non-negative integer");
  if (!(opts.confidence > 0.5 && opts.confidence < 1)) throw new UsageError("--confidence must be between 0.5 and 1");
  let receipt;
  try {
    receipt = withEvidence(args.out, () => benchGate({ ...opts,
      onRun: r => process.stderr.write(`bench-gate: pair ${r.pair} ${r.version} ${opts.metric}=${r.metric} exit ${r.exit}\n`),
    }));
  } catch (error) { throw error instanceof UsageError ? error : new UsageError(error.message); }
  const { text, ...shown } = receipt;
  console.log(JSON.stringify(shown, null, 2));
  return receipt.green ? 0 : 2;
});
