#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
let seeds = ["101", "202", "303"];
if (args[0] === "--seeds") {
  args.shift();
  seeds = (args.shift() ?? "").split(",");
  assert.ok(seeds.length > 0 && seeds.every(value => /^-?\d+$/.test(value)), "expected --seeds n,n,n");
}
const file = args.shift() ?? fileURLToPath(new URL("./index.js", import.meta.url));
const runs = new Map();
let unsuccessful = false;
for (const seed of seeds) {
  const run = spawnSync(process.execPath, ["--test", "--test-reporter=tap", ...args, resolve(file)], {
    encoding: "utf8",
    env: { ...process.env, SELF_LOOP_ACCEPTANCE_SEED: seed },
  });
  if (run.error) throw run.error;
  if (run.status !== 0) {
    unsuccessful = true;
    console.log(`\nSeed ${seed} TAP:\n${run.stdout}${run.stderr}`);
  }
  // Per-case duration and status from Node's TAP reporter; failures are printed verbatim above.
  const cases = new Map();
  for (const match of run.stdout.matchAll(/^(ok|not ok) \d+ - (\S+).*?( # SKIP[^\n]*)?\n[ \t]+---\n[ \t]+duration_ms: ([\d.]+)/gm)) {
    const [, outcome, name, skipped, ms] = match;
    cases.set(name, { status: skipped ? "skip" : outcome === "ok" ? "pass" : "fail", ms: Number(ms) });
  }
  if (!cases.size) throw new Error(`No case results for seed ${seed}:\n${run.stdout}${run.stderr}`);
  runs.set(seed, cases);
}
const all = [...new Set([...runs.values()].flatMap(cases => [...cases.keys()]))].sort();
const columns = ["Case", ...seeds.map(seed => "Seed " + seed), "Stable"];
console.log("\n| " + columns.join(" | ") + " |\n|" + columns.map(() => "---").join("|") + "|");
for (const name of all) {
  const cases = seeds.map(seed => runs.get(seed).get(name));
  const stable = new Set(cases.map(result => result?.status ?? "absent")).size === 1;
  if (!stable) unsuccessful = true;
  const cells = cases.map(result => result ? `${result.status} ${result.ms.toFixed(1)} ms` : "absent");
  console.log("| " + [name, ...cells, stable ? "yes" : "no"].join(" | ") + " |");
}
process.exitCode = unsuccessful ? 1 : 0;
