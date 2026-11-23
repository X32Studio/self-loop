import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { has, json, jsonl, jsonOutput, lacks, put, status, writeGh } from "./fixture.mjs";
import { batchDraw, greenCheck, phase, prepare, round6B, trajectory } from "./round6-b-fixture.mjs";
import { hostMeasurement, suggestedHeavy } from "./round7-b-fixture.mjs";
import { now } from "./scenario.mjs";

const draw = batchDraw(570);
const cores = 10 * (1 + draw(3));
const headroom = (1 + draw(5)) / 8;
const belowBothMemoryUnits = 1.25 + headroom;
const defaultLimit = cores * 0.7;
const defaultMemory = 16;
const measurements = [
  ["01", "just below the default one-minute load limit", { cores, load: defaultLimit - 0.01, availableGB: 20 }, true],
  ["02", "exactly at the default load limit with 16 GiB available", { cores, load: defaultLimit, availableGB: defaultMemory }, true],
  ["03", "just above the default one-minute load limit", { cores, load: defaultLimit + 0.01, availableGB: 20 }, false],
  ["04", "below the default available memory floor", { cores, load: 0.25, availableGB: defaultMemory - belowBothMemoryUnits }, false],
  ["05", "just above the default available memory floor", { cores, load: 0.25, availableGB: defaultMemory + headroom }, true],
  ["06", "available memory above the floor with only 8 GiB immediately free",
    { cores, load: 0.25, availableGB: defaultMemory + headroom, freeGB: 8 }, true],
  ["10", "available memory below the floor with only 8 GiB immediately free",
    { cores, load: 0.25, availableGB: defaultMemory - headroom, freeGB: 8 }, false],
];

function configure(w, store, products, thresholds) {
  const path = "products.json";
  const registry = JSON.parse(readFileSync(join(store, path), "utf8"));
  put(store, path, json({
    ...registry,
    products: products.map(({ name, records }) => ({ name, records })),
    ...thresholds,
  }));
  w.commit(store, "Configure capacity for the registered products");
}

function launch(w, p, measurement, flags = ["--config", p.config]) {
  return status(w.run("self-loop.mjs", ["next", ...flags], {
    cwd: p.product, extraEnv: hostMeasurement(w, measurement),
  }), 0);
}

function assertsCapacity(text, allowed) {
  const commands = suggestedHeavy(text);
  assert.equal(commands.length > 0, allowed, text);
  if (allowed) {
    for (const required of [/call\.mjs.* critic --round /, /suite-green\.mjs.* --command /]) {
      assert.ok(commands.some(line => required.test(line)), text);
    }
  }
}

for (const [id, label, measurement, allowed] of measurements) {
  test(`R7-B6-${id} next bases heavy work on ${label}`, t => {
    const w = round6B(t);
    const p = phase(w);
    w.register([p]);
    assertsCapacity(launch(w, p, measurement), allowed);
  });
}

test("R7-B6-07 a roomy host still suggests heavy work when the live call count exceeds the legacy limit", t => {
  const w = round6B(t);
  const current = phase(w, "current");
  const other = phase(w, "other");
  configure(w, w.owner, [current, other], { heavyBudget: 1 });
  const active = prepare(w, other, "actor");
  put(w.load, `suite-${process.pid}-0.json`, json({
    kind: "suite", pid: process.pid, repo: current.product, sha: current.initial, started: now,
  }));
  const text = launch(w, current, { cores: 10, load: 0.25, availableGB: 32 }, []);
  assertsCapacity(text, true);
  has(text, active.id);
  assert.match(text, /\bsuite\b[^\n]*\bpid\b/i);
  assert.match(text, /(?:\b2\s+heavy\s+calls\b|\bheavy\s+calls\b[^\n]*\b2\b|\bload\s+2\s*[:/])/i);
});

test("R7-B6-08 owner registry thresholds each override the defaults", t => {
  const w = round6B(t);
  const p = phase(w);
  configure(w, w.owner, [p], { maxLoadRatio: 0.5, minAvailableMemoryGB: 8 });
  const scenarios = [
    [{ cores: 8, load: 4, availableGB: 8 }, true],
    [{ cores: 8, load: 4.01, availableGB: 16 }, false],
    [{ cores: 8, load: 0.25, availableGB: 8 - belowBothMemoryUnits }, false],
  ];
  for (const [measurement, allowed] of scenarios) assertsCapacity(launch(w, p, measurement, []), allowed);
});

test("R7-B6-09 busy host still offers record and live CI while new heavy work waits", t => {
  const w = round6B(t);
  const p = phase(w);
  w.register([p]);
  const active = prepare(w, p, "actor");
  writeGh(w, { [p.initial]: [{ ...greenCheck, status: "in_progress", conclusion: null }] });
  const text = launch(w, p, { cores: 10, load: 7.25, availableGB: 32 });
  assert.deepEqual(suggestedHeavy(text), [], text);
  has(text, active.id);
  assert.match(text, /call\.mjs.* record --ws /);
  assert.match(text, /ci-green\.mjs.* --sha /);
});

test("R7-B7-01 start and direct next see the same explicit owner store despite a different environment store", t => {
  const w = round6B(t);
  const current = phase(w, "current");
  const other = phase(w, "other");
  w.register([current]);
  const explicit = w.repo(join(w.dir, "alternate-owner"), {
    "README.md": "# Other owner store\n",
    "products.json": json({ products: [], roots: [w.projects] }),
  });
  configure(w, explicit, [current, other], {});
  const active = prepare(w, other, "actor");
  const measurement = { cores: 8, load: 4, availableGB: 20 };
  const flags = ["--config", current.config, "--owner-store", explicit];
  const report = jsonOutput(w.run("self-loop.mjs", ["start", "--json", ...flags], {
    cwd: current.product, extraEnv: hostMeasurement(w, measurement),
  }));
  const direct = launch(w, current, measurement, flags);
  assert.equal(report.ownerStore, explicit);
  assert.equal(report.products, 2);
  assert.equal(report.session.error, null);
  for (const text of [direct, report.session.next]) {
    has(text, active.id);
    assertsCapacity(text, true);
  }
  const ambient = launch(w, current, measurement);
  lacks(ambient, active.id);
  assertsCapacity(ambient, true);
});

test("R7-B8-01 convergence leaves shelved and closed blockers out while preserving an unrelated open blocker", t => {
  const w = round6B(t);
  const p = phase(w);
  const keys = { shelf: "comment-admission:R7-1", closed: "store-selection:R7-2", open: "host-capacity:R7-3" };
  const history = [
    { round: 2, area: "classification", opened: Object.values(keys).join(",") },
    { round: 3, area: "follow-up", shelved: keys.shelf, closed: keys.closed },
  ];
  const entries = [];
  for (const { round, ...fields } of history) {
    const report = round === 2 ? Object.values(keys).map(key =>
      `### Opened ${key}\n\nflow: The lead resumes the loop from a newly prepared workspace.\nloss: false-verdict\n`).join("\n") :
      `Shelved ${keys.shelf}\nClosed ${keys.closed}\n`;
    put(p.records, `rounds/${String(round).padStart(4, "0")}-judge.md`, `# R-000${round}-judge\n\nphase: v1\nrole: judge\n\n${report}`);
    entries.push({ time: now, round, phase: "v1", role: "judge", verdict: "CONTINUE", commit: p.initial,
      suite: "2/0", ci: "success", ...fields });
    put(p.records, trajectory, jsonl(...entries));
    status(w.run("records-check.mjs", ["--repo", p.records, "--write"]), 0);
    w.commit(p.records, "Record the fixture judge ruling");
    const text = launch(w, p, { cores: 10, load: 0.25, availableGB: 32 });
    const open = text.split("\n").find(line => /open blockers:/i.test(line));
    assert.ok(open, text);
    has(open, keys.open);
    if (round === 2) {
      has(open, keys.shelf);
      has(open, keys.closed);
    } else {
      lacks(open, keys.shelf);
      lacks(open, keys.closed);
    }
  }
});
