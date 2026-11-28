#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const listSuites = dir => existsSync(dir)
  ? readdirSync(dir).filter(name => name.endsWith(".test.mjs")).sort().map(name => join(dir, name))
  : [];

function resolveTargets(rawTargets) {
  if (!rawTargets.length) return [...listSuites(root), ...listSuites(join(root, "time-budget"))];
  return rawTargets.flatMap(target => {
    const abs = resolve(target);
    if (existsSync(abs) && statSync(abs).isDirectory()) {
      return [...listSuites(abs), ...listSuites(join(abs, "time-budget"))];
    }
    return [abs];
  });
}

const args = process.argv.slice(2);
let seeds = ["101", "202", "303"];
if (args[0] === "--seeds") {
  args.shift();
  seeds = (args.shift() ?? "").split(",");
  assert.ok(seeds.length > 0 && seeds.every(value => /^-?\d+$/.test(value)), "expected --seeds n,n,n");
}
const flags = [];
const rawTargets = [];
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg.startsWith("-")) {
    flags.push(arg);
    if (!arg.includes("=") && (arg === "--test-name-pattern" || arg === "--test-skip-pattern") && i + 1 < args.length) {
      flags.push(args[++i]);
    }
  } else {
    rawTargets.push(arg);
  }
}
const targets = resolveTargets(rawTargets);
assert.ok(targets.length > 0, "expected at least one acceptance test file");

const runs = new Map();
let unsuccessful = false;
for (const seed of seeds) {
  const run = spawnSync(process.execPath, ["--test", "--test-reporter=tap", ...flags, ...targets], {
    encoding: "utf8",
    env: { ...process.env, SELF_LOOP_ACCEPTANCE_SEED: seed },
  });
  if (run.error) throw run.error;
  if (run.status !== 0) {
    unsuccessful = true;
    console.log(`\nSeed ${seed} TAP:\n${run.stdout}${run.stderr}`);
  }
  const cases = new Map();
  for (const match of run.stdout.matchAll(/^(ok|not ok) \d+ - ([^\n]*?)( # SKIP[^\n]*)?\r?\n[ \t]+---\r?\n[ \t]+duration_ms: ([\d.]+)/gm)) {
    const [, state, name, skipped, ms] = match;
    cases.set(name.trim(), { status: skipped ? "skip" : state, ms: Number(ms) });
  }
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
  console.log("| " + [name.replaceAll("|", "\\|"), ...cells, stable ? "yes" : "no"].join(" | ") + " |");
}
process.exitCode = unsuccessful ? 1 : 0;
