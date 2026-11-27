// D-0039, D-0069
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { gunzipSync } from "node:zlib";
import { benchGate, binomialHalfCdf, judgeRuns, medianBoundRanks, parseRequire, parseResult, runReasons } from "../bench-gate.mjs";
import { fixtures, git, repo, scripts, temp } from "./helpers.mjs";

test("admission: the R-0041 judge's 24 recorded pairs re-judge to its own bounds and are red at 1.10", () => {
  const runs = readFileSync(join(fixtures, "bench-gate", "r41-judge.jsonl"), "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l));
  assert.equal(runs.length, 50);
  assert.ok(runs.every(r => r.delivered === 24));
  const v = judgeRuns(runs, { pairs: 24, maxRatio: 1.1, confidence: 0.95 });
  assert.deepEqual(v.ranks.lower, 8);
  assert.deepEqual(v.ranks.upper, 17);
  assert.equal(v.medianRatio, 1.6887863733144073);
  assert.equal(v.lower, 1.6782670454545454);
  assert.equal(v.upper, 1.698140200286123);
  assert.equal(v.medianDiff, 970.5);
  assert.equal(v.stats.base.median, 1404.5);
  assert.equal(v.stats.candidate.median, 2378.5);
  assert.equal(v.green, false);
  assert.match(v.reasons[0], /upper bound of the median ratio is 1\.6981, above 1\.1/);
  assert.equal(judgeRuns(runs, { pairs: 24, maxRatio: 1.7, confidence: 0.95 }).green, true, "the same runs pass a looser bar");
});

test("order statistics: binomial ranks for the median bound; too few pairs bound nothing", () => {
  assert.ok(Math.abs(binomialHalfCdf(7, 24) - 0.0320) < 1e-4);
  assert.ok(Math.abs(binomialHalfCdf(8, 24) - 0.0758) < 1e-4);
  assert.deepEqual([medianBoundRanks(24, 0.95).lower, medianBoundRanks(24, 0.95).upper], [8, 17]);
  assert.ok(medianBoundRanks(24, 0.95).coverage >= 0.95);
  assert.deepEqual([medianBoundRanks(5, 0.95).lower, medianBoundRanks(5, 0.95).upper], [1, 5]);
  assert.equal(medianBoundRanks(4, 0.95), null);
  for (let n = 5; n <= 60; n++) {
    const r = medianBoundRanks(n, 0.95);
    assert.ok(binomialHalfCdf(r.lower - 1, n) <= 0.05 && binomialHalfCdf(r.lower, n) > 0.05, `n=${n}: the largest rank that still holds`);
  }
});

test("judging: a missing, duplicated or incomplete pair is red; warm-up pairs never count", () => {
  const pairs = n => Array.from({ length: n }, (_, i) => [{ version: "base", pair: i + 1, metric: 100 }, { version: "candidate", pair: i + 1, metric: 101 }]).flat();
  assert.equal(judgeRuns([...pairs(6), { version: "base", pair: 0, metric: 1 }, { version: "candidate", pair: 0, metric: 1000 }], { pairs: 6, maxRatio: 1.1, confidence: 0.95 }).green, true);
  assert.deepEqual(judgeRuns(pairs(6).slice(0, -1), { pairs: 6, maxRatio: 1.1, confidence: 0.95 }).reasons, ["5 complete pair(s), 6 required"]);
  const dup = judgeRuns([...pairs(6), { version: "base", pair: 3, metric: 100 }], { pairs: 6, maxRatio: 1.1, confidence: 0.95 });
  assert.ok(dup.reasons.includes("pair 3 has two base runs"));
});

test("a run counts only with a positive metric and every condition met; output is one JSON object", () => {
  const conds = parseRequire("delivered=24, workload=local text combination,peakHeldAttempts<=2,result.ok>=1");
  assert.deepEqual(conds.map(c => c.op), ["=", "=", "<=", ">="]);
  const good = { ms: 5, delivered: 24, workload: "local text combination", peakHeldAttempts: 2, result: { ok: 1 } };
  assert.deepEqual(runReasons(good, "ms", conds), []);
  assert.deepEqual(runReasons({ ...good, ms: 0 }, "ms", conds), ["ms is 0, not a positive number"]);
  assert.deepEqual(runReasons({ ...good, delivered: 23, peakHeldAttempts: 3 }, "ms", conds),
    ["delivered is 23, required = 24", "peakHeldAttempts is 3, required <= 2"]);
  assert.deepEqual(runReasons({ ...good, delivered: "24" }, "ms", conds), [], "a numeric string equals its number as text");
  assert.deepEqual(runReasons(null, "ms", []), ["the output is not one JSON object"]);
  assert.throws(() => parseRequire("delivered"), /cannot read/);
  assert.deepEqual(parseResult('{\n "a": 1\n}\n'), { a: 1 });
  assert.equal(parseResult('progress\n{"a":2}\n'), null);
  assert.equal(parseResult("no json\n"), null);
});

function project(baseMs, candidateMs, { extra = "" } = {}) {
  const dir = repo({ "ms.txt": `${baseMs}\n`, "bench.mjs": `import { readFileSync, appendFileSync } from "node:fs";\n${extra}\nconsole.log(JSON.stringify({ ms: Number(readFileSync("ms.txt", "utf8")), delivered: 24 }));\n` });
  const base = git(dir, "rev-parse", "HEAD");
  writeFileSync(join(dir, "ms.txt"), `${candidateMs}\n`);
  git(dir, "commit", "-q", "-am", "candidate");
  return { dir, base, candidate: git(dir, "rev-parse", "HEAD") };
}

test("live: a candidate within the bar is green, measured in alternating pairs, worktrees removed", () => {
  const p = project(100, 105);
  writeFileSync(join(p.dir, "ms.txt"), "9999\n");
  const r = benchGate({ repo: p.dir, base: p.base, candidate: "HEAD", command: "node bench.mjs", metric: "ms", require: "delivered=24", pairs: 6, warmup: 1 });
  assert.equal(r.green, true, r.reasons.join("; "));
  assert.deepEqual([r.base, r.candidate], [p.base, p.candidate]);
  assert.equal(r.upper, 1.05);
  const runs = r.text.trim().split("\n").map(l => JSON.parse(l));
  assert.deepEqual(runs.map(x => `${x.pair}${x.version[0]}`), ["0b", "0c", "1b", "1c", "2c", "2b", "3b", "3c", "4c", "4b", "5b", "5c", "6c", "6b"]);
  assert.equal(git(p.dir, "worktree", "list").split("\n").length, 1);
});

test("live: a candidate above the bar is red; a run that misses a condition stops the gate red", () => {
  const slow = project(100, 120);
  const red = benchGate({ repo: slow.dir, base: slow.base, candidate: slow.candidate, command: "node bench.mjs", metric: "ms", pairs: 6 });
  assert.equal(red.green, false);
  assert.match(red.reasons[0], /upper bound of the median ratio is 1\.2000, above 1\.1/);
  const bad = benchGate({ repo: slow.dir, base: slow.base, candidate: slow.candidate, command: "node bench.mjs", metric: "ms", require: "delivered=25", pairs: 6 });
  assert.equal(bad.green, false);
  assert.deepEqual(bad.reasons, ["base run of pair 0: delivered is 24, required = 25"]);
  assert.equal(bad.runs.count, 1, "the first failing run stops the gate");
  const install = benchGate({ repo: slow.dir, base: slow.base, candidate: slow.candidate, install: "exit 3", command: "node bench.mjs", metric: "ms", pairs: 6 });
  assert.deepEqual(install.reasons, ["install exited 3 in the base worktree", "install exited 3 in the candidate worktree"]);
});

test("CLI: exit 0 green, 2 red, 64 usage; --out writes the receipt and the runs once and never overwrites", () => {
  const p = project(100, 101);
  const out = join(temp(), "evidence", "bench-1");
  const run = (...a) => spawnSync(process.execPath, [join(scripts, "bench-gate.mjs"), "--repo", p.dir, "--base", p.base, "--candidate", p.candidate, "--command", "node bench.mjs", ...a], { encoding: "utf8" });
  const ok = run("--metric", "ms", "--pairs", "6", "--out", out);
  assert.equal(ok.status, 0, ok.stderr);
  const receipt = JSON.parse(readFileSync(`${out}.json`, "utf8"));
  assert.equal(receipt.candidate, p.candidate);
  assert.equal(createHash("sha256").update(gunzipSync(readFileSync(`${out}.runs.jsonl.gz`))).digest("hex"), receipt.runs.sha256);
  assert.equal(run("--metric", "ms", "--pairs", "6", "--out", out).status, 64, "never overwrites evidence");
  assert.equal(run("--metric", "ms", "--pairs", "6", "--max-ratio", "1.005").status, 2);
  assert.equal(run("--metric", "ms", "--pairs", "4").status, 64, "4 pairs cannot bound a median at 0.95");
  assert.equal(run("--pairs", "6").status, 64, "--metric is required");
});

test("B17: the binomial median bound stays ordered past floating-point underflow", () => {
  const pairs = 1_075;
  const runs = Array.from({ length: pairs }, (_, i) => [
    { pair: i + 1, version: "base", metric: 1 },
    { pair: i + 1, version: "candidate", metric: i === 0 ? 1 : 1.5 },
  ]).flat();
  const result = judgeRuns(runs, { pairs, maxRatio: 1.1, confidence: 0.95 });
  assert.deepEqual([result.ranks.lower, result.ranks.upper], [511, 565]);
  assert.ok(result.ranks.coverage >= 0.95 && result.ranks.coverage < 0.96);
  assert.equal(result.upper, 1.5);
  assert.equal(result.green, false);
});

test("B19: a progress JSON cannot stand in for missing final benchmark output", () => {
  const p = project(100, 101);
  const result = benchGate({ repo: p.dir, base: p.base, candidate: p.candidate,
    command: `node bench.mjs; echo "final result unavailable"`, metric: "ms", pairs: 5, warmup: 0 });
  assert.equal(result.green, false);
  assert.match(result.reasons[0], /not one JSON object/);
  assert.equal(result.runs.count, 1);
});

test("B20: an in-flight bench run reserves its evidence prefix before the first measurement", async t => {
  const p = project(100, 101), dir = temp(), out = join(dir, "bench");
  const started = join(dir, "started"), release = join(dir, "release"), other = join(dir, "other");
  const run = command => {
    const child = spawn(process.execPath, [join(scripts, "bench-gate.mjs"), "--repo", p.dir, "--base", p.base,
      "--candidate", p.candidate, "--metric", "ms", "--pairs", "5", "--warmup", "0", "--command", command, "--out", out], { stdio: "ignore" });
    return new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  };
  t.after(() => writeFileSync(release, ""));
  const a = run(`touch "${started}"; while [ ! -f "${release}" ]; do sleep 0.02; done; node bench.mjs`);
  for (let i = 0; !existsSync(started) && i < 300; i++) await delay(10);
  assert.ok(existsSync(started), "the first benchmark started");
  const b = await run(`touch "${other}"; node bench.mjs`);
  writeFileSync(release, "");
  assert.equal(await a, 0);
  assert.equal(b, 64);
  assert.equal(existsSync(other), false, "the second benchmark never ran");
  const receipt = JSON.parse(readFileSync(`${out}.json`, "utf8"));
  const runs = gunzipSync(readFileSync(`${out}.runs.jsonl.gz`));
  assert.equal(createHash("sha256").update(runs).digest("hex"), receipt.runs.sha256);
  assert.match(receipt.samplingAssumption, /independent/);
});
