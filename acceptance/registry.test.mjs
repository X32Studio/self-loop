import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { has, lacks, output, status, world } from "./fixture.mjs";
import { groups, product, seed } from "./scenario.mjs";

const opts = cmd => cmd === "stall" ? ["--hours", "1"] : [];
const commands = ["next", "stall"];

test("REG-01 resolves both commands from a nested project directory", t => {
  const w = world(t);
  const active = w.makeProduct(product("alder", 0.15));
  const neighbor = w.makeProduct(product("birch", 5));
  w.register([neighbor, active]);
  const cwd = join(active.path, "src", "nested");
  mkdirSync(cwd, { recursive: true });
  for (const cmd of commands) {
    const text = status(w.run([cmd, ...opts(cmd)], { cwd }), 0);
    has(text, active.phase);
    lacks(text, neighbor.phase);
  }
});

test("REG-02 exits 64 and explains that no registered project owns the directory", t => {
  const w = world(t);
  const active = w.makeProduct(product("needle", 0.2));
  w.register([active]);
  const cwd = active.path + "-notes";
  mkdirSync(cwd);
  for (const cmd of commands) {
    const result = w.run([cmd, ...opts(cmd)], { cwd });
    status(result, 64);
    assert.match(output(result), /no (?:matching |registered )?(?:configuration|product|candidate|loop)|0 candidates|no registered project/i);
    lacks(output(result), active.phase);
  }
});

test("REG-03 exits 64 with both names for genuinely overlapping projects", t => {
  const w = world(t);
  const parent = w.makeProduct(product("cedar", 0.1, { project: "shared-root" }));
  const nested = w.makeProduct(product("dogwood", 0.2, { project: "shared-root/packages/tools" }));
  w.register([nested, parent]);
  for (const cmd of commands) {
    const result = w.run([cmd, ...opts(cmd)], { cwd: nested.path });
    status(result, 64);
    has(output(result), parent.name);
    has(output(result), nested.name);
  }
});

test("REG-04 --all visits every product from outside the registered projects", t => {
  const w = world(t);
  const batch = groups(seed, 6).map(({ spec, isIdle }, i) => ({ item: w.makeProduct(spec, i + 1), isIdle }));
  w.register(batch.map(({ item }) => item));
  const next = status(w.run(["next", "--all"]), 0);
  const stall = w.run(["stall", "--all", "--hours", "1"]);
  // The single-product stall exit is fixed by SKILL.md. All-product exit aggregation is unspecified.
  assert.ok([0, 2].includes(stall.status), output(stall));
  for (const { item, isIdle } of batch) {
    has(next, item.phase);
    has(next, item.config);
    const line = stall.stdout.split("\n").find(line => line.includes(item.phase));
    assert.match(line ?? "", isIdle ? /\bSTALL\b/i : /\bactive\b/i, output(stall));
  }
});

test("REG-05 explicit configuration wins over the environment, which wins over the registry", t => {
  const w = world(t);
  const products = ["elm", "fir", "ginkgo"].map((name, index) => w.makeProduct(product(name, 0.2), index + 1));
  const [registered, fromEnv, fromFlag] = products;
  w.register(products);
  for (const cmd of commands) {
    const cwd = registered.path, extraEnv = { SELF_LOOP_CONFIG: fromEnv.config };
    const envResult = status(w.run([cmd, ...opts(cmd)], { cwd, extraEnv }), 0);
    has(envResult, fromEnv.phase);
    lacks(envResult, registered.phase);
    const flagResult = status(w.run([cmd, ...opts(cmd), "--config", fromFlag.config], { cwd, extraEnv }), 0);
    has(flagResult, fromFlag.phase);
    lacks(flagResult, fromEnv.phase);
  }
});
