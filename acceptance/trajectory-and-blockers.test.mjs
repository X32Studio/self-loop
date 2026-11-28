import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { appendArgs, ledgerPath, serveChecks } from "./closing-fixture.mjs";
import { has, json, jsonOutput, jsonl, lacks, put, status, world, writeGh } from "./fixture.mjs";
import { greenCheck, hostMeasurement, loopWorld, next, phase, trajectory } from "./loop-world-fixture.mjs";
import { at, judgeRow, mechanisms, pad } from "./plan-world-fixture.mjs";
import { now, seed, seeded } from "./scenario.mjs";

const split = x => (x ?? "").split(",").filter(v => v && v !== "-").sort();
const recurrence = (alarms, kind) => alarms.find(alarm => alarm.key === `blocker-recurring:${kind}`);
const partialClosures = alarms => alarms.filter(alarm => alarm.type === "partly-closed");
const DISPOSITIONS = ["none", "opened", "carried", "closed", "shelved", "carried+closed"];

class Ruling {
  constructor(round, phaseName, area, blockers = {}) {
    Object.assign(this, { round, phase: phaseName, area, role: "judge", verdict: "CONTINUE", ci: "success", ...blockers });
  }
}

function readAlarms(w, file, threshold = 2) {
  return jsonOutput(w.run(["alarms", "--file", file, "--recur", String(threshold), "--json"], { entry: "trajectory.mjs" }));
}

function historyAlarms(t) {
  const w = world(t);
  return (rulings, threshold) => readAlarms(w, put(w.dir, ledgerPath, jsonl(...rulings)), threshold);
}

function closing(t, priorRulings = []) {
  const w = world(t);
  const product = w.repo(join(w.dir, "product"), { "README.md": "# Fixture product\n" });
  const ruled = w.git(product, "rev-parse", "HEAD");
  const destination = "example/trajectory-fixture";
  w.git(product, "remote", "add", "origin", `https://github.com/${destination}.git`);
  const records = join(w.dir, "records");
  w.repo(records, {
    "README.md": "# Fixture records\n",
    "records.json": "{}\n",
    "loop.json": json({
      product, records, phase: "v1", branch: "main", workDir: join(w.dir, "work"), protected: [],
      gates: { remote: "origin", require: ["github-actions/verify"] },
    }),
    [ledgerPath]: jsonl(...priorRulings),
  });
  serveChecks(w, {
    [destination]: {
      [ruled]: [{ id: 17, app: { slug: "github-actions" }, name: "verify", status: "completed", conclusion: "success" }],
    },
  });
  const file = join(records, ledgerPath);
  const writeRuling = (round, keys, { suffix = "", repository = records } = {}) => {
    const name = `${pad(round)}-judge${suffix}`;
    const view = w.git(repository, "rev-parse", "HEAD");
    const blocks = keys.map(key => [
      `### ${key}`, "",
      "flow: The lead uses the reviewed command to publish a release.", "",
      "loss: false-verdict. The command can authorize an unverified release.",
    ].join("\n"));
    put(repository, `rounds/${name}.md`, [
      `# R-${name}`, "", "phase: v1", "role: judge", `view: records@${view}`, `product: ${ruled}`, "",
      "## Public report (verbatim, out/public.md)", "", blocks.join("\n\n"), "",
    ].join("\n"));
    w.commit(repository, `Record judge report ${name}`);
  };
  const append = (round, fields, settings = {}) => w.run([
    ...appendArgs({ file, ruled }, { round, verdict: "CONTINUE" }),
    ...Object.entries(fields).flatMap(([key, value]) => [`--${key}`, value]),
  ], { entry: "trajectory.mjs", ...settings });
  const ledger = () => readFileSync(file);
  const alarms = threshold => readAlarms(w, file, threshold);
  const refused = result => {
    const before = ledger();
    const revision = w.git(records, "rev-parse", "HEAD");
    const beforeStatus = w.git(records, "status", "--porcelain", "--untracked-files=all");
    status(result(), 2);
    assert.deepEqual(ledger(), before);
    assert.equal(existsSync(join(records, "evidence")), false);
    assert.equal(w.git(records, "rev-parse", "HEAD"), revision);
    assert.equal(w.git(records, "status", "--porcelain", "--untracked-files=all"), beforeStatus);
  };
  const accepted = (round, fields) => {
    const before = ledger().toString();
    const row = jsonOutput(append(round, fields));
    assert.equal(ledger().toString(), before + jsonl(row));
    assert.equal(row.ci, "success");
    assert.equal(typeof row.ciReceipt, "string");
    assert.ok(existsSync(join(records, row.ciReceipt)), row.ciReceipt);
    for (const [key, value] of Object.entries(fields)) assert.equal(row[key], value);
    return row;
  };
  return { w, writeRuling, append, accepted, refused, alarms };
}

function dispositionWorld(t) {
  const w = loopWorld(t), p = phase(w);
  writeGh(w, { [p.initial]: [greenCheck] });
  const file = join(p.records, trajectory);
  put(p.records, trajectory, "");
  const ruling = (n, body, suffix = "") => {
    const name = `${pad(n)}-judge${suffix}`;
    put(p.records, `rounds/${name}.md`, `# R-${name}\n\nphase: v1\nrole: judge\nproduct: ${p.initial}\n\n## Public report\n\nVERDICT: CONTINUE\n${body}\n`);
    w.commit(p.records, `Record ${name}`);
  };
  const append = (n, flags = []) => w.run("trajectory.mjs", ["append", "--file", file, "--round", String(n), "--phase", "v1", "--role", "judge", "--commit", p.initial, "--verdict", "CONTINUE", "--area", "delivery", ...flags]);
  const alarms = () => jsonOutput(w.run("trajectory.mjs", ["alarms", "--file", file, "--json"]));
  return { w, p, file, ruling, append, alarms };
}

function blockerOracle(sequence, { carriedClosed = "closed" } = {}) {
  let state = "none";
  for (const d of sequence) {
    if (d === "opened" || d === "carried") state = "open";
    else if (d === "closed") state = "closed";
    else if (d === "shelved") state = "shelved";
    else if (d === "carried+closed") state = carriedClosed === "closed" ? "closed" : "open";
  }
  return state;
}

function blockerKeys(line) {
  return line ? [...line.matchAll(/([^\s,()]+:[^\s,()]+) \(R-\d{4}\)/g)].map(m => m[1]).sort() : [];
}

test("R7-C01 the ExampleApp R33-1 replay counts four distinct IDs across five rounds", t => {
  const alarms = historyAlarms(t);
  const rulings = [31, 32, 33, 34, 35].map(round => new Ruling(round, round < 35 ? "S4" : "A1", "grants", {
    opened: `grant-store:R${round === 35 ? 33 : round}-1`,
  }));
  assert.equal(recurrence(alarms(rulings, 5), "grant-store"), undefined, "four distinct blockers fall below five");
  const found = recurrence(alarms(rulings, 4), "grant-store");
  assert.equal(found?.count, 4, "four distinct blockers reach four");
  const genuineNewOpening = new Ruling(36, "A1", "grants", { opened: "grant-store:R36-1" });
  assert.equal(recurrence(alarms([...rulings, genuineNewOpening], 5), "grant-store")?.count, 5);
});

test("R7-C02 a single ruling with many distinct openings reaches the recurrence threshold", t => {
  const alarms = historyAlarms(t);
  const draw = seeded(seed);
  const keys = Array.from({ length: 35 + draw(30) }, (_, index) => `queue:R7-${index + 1}`);
  const redundant = Array.from({ length: 4 + draw(19) }, () => keys[draw(keys.length)]);
  const ruling = new Ruling(7, "v1", "queue", { opened: [...redundant, ...keys].join(",") });
  assert.equal(recurrence(alarms([ruling], keys.length + 1), "queue"), undefined);
  const found = recurrence(alarms([ruling], keys.length), "queue");
  assert.equal(found?.count, keys.length);
  assert.deepEqual([...found.evidence.blockers].sort(), [...keys].sort(), "evidence also lists distinct blockers");
});

test("R7-C03 a repeated ID does not make an already diagnosed alarm fire again", t => {
  const alarms = historyAlarms(t);
  const original = [
    new Ruling(1, "S4", "envelope", { opened: "handoff:R1-1" }),
    new Ruling(2, "S4", "identity", { opened: "handoff:R2-1" }),
  ];
  const duplicate = new Ruling(3, "A1", "handoff", { opened: "handoff:R2-1" });
  const diagnosed = recurrence(alarms(original), "handoff");
  assert.equal(diagnosed?.count, 2);
  assert.deepEqual(recurrence(alarms([...original, duplicate]), "handoff"), diagnosed);
});

test("R7-C04 shelved, closed and still-open blockers retain distinct effects", t => {
  const shelved = "render:R1-1", closed = "render:R1-2", remaining = "render:R1-3";
  const fixture = closing(t, [new Ruling(1, "v1", "release", { opened: [shelved, closed, remaining].join(",") })]);
  fixture.accepted(2, { shelved, closed });
  const [alarm, ...extra] = partialClosures(fixture.alarms());
  assert.equal(alarm?.count, 1);
  assert.deepEqual(alarm.evidence.stillOpen, [remaining]);
  assert.deepEqual(alarm.evidence.closed, [closed]);
  assert.deepEqual(extra, []);
  assert.equal(recurrence(fixture.alarms(4), "render"), undefined);
  fixture.accepted(3, { shelved: remaining });
  assert.deepEqual(partialClosures(fixture.alarms()).map(finding => finding.at), [2]);
});

test("R7-C05 carried blockers are durable without contributing to either alarm", t => {
  const carried = "grant-store:R33-1", opened = "grant-store:R37-1";
  const fixture = closing(t, [new Ruling(33, "S4", "grants", { opened: carried })]);
  fixture.accepted(35, { carried });
  fixture.accepted(36, {});
  const afterCarry = fixture.alarms();
  assert.equal(recurrence(afterCarry, "grant-store"), undefined);
  assert.deepEqual(partialClosures(afterCarry), []);

  fixture.writeRuling(37, [opened]);
  fixture.accepted(37, { opened });
  assert.equal(recurrence(fixture.alarms(), "grant-store")?.count, 2);
  fixture.accepted(38, {});
  const [finding] = partialClosures(fixture.alarms());
  assert.equal(finding?.at, 38);
  assert.deepEqual(finding.evidence.stillOpen, [opened]);
});

test("R7-C06 a similar ID or another class cannot document an opening", t => {
  const fixture = closing(t);
  const genuine = "release:R70-10", mistyped = "release:R70-1";
  fixture.writeRuling(70, [genuine, "runtime:R70-1"]);
  fixture.refused(() => fixture.append(70, { opened: `${genuine},${mistyped}` }));
  fixture.accepted(70, { opened: genuine });
});

test("R7-C07 only the ledger repository's judge reports for that round can document an opening", t => {
  const fixture = closing(t);
  const { w } = fixture;
  const other = w.repo(join(w.dir, "other-records"), { "README.md": "# Peer records\n" });
  const key = "release:R71-1";
  fixture.writeRuling(70, [key]);
  fixture.writeRuling(71, [key], { repository: other });
  fixture.writeRuling(71, []);
  fixture.refused(() => fixture.append(71, { opened: key }, { cwd: other }));
  fixture.writeRuling(71, ["R71-1"], { suffix: "-followup" });
  fixture.accepted(71, { opened: key });
});

test("R7-C08 historical TSV and JSONL still parse without the new fields", t => {
  const w = world(t);
  const columns = ["time", "round", "phase", "area", "role", "model", "verdict", "opened", "closed", "suite", "owner", "commit", "ci"];
  const rows = [
    new Ruling(1, "legacy", "delivery", { opened: "delivery:R1-1", closed: "-" }),
    new Ruling(2, "legacy", "delivery", { opened: "delivery:R2-1", closed: "delivery:R1-1" }),
    new Ruling(3, "legacy", "delivery", { opened: "-", closed: "-" }),
  ];
  const tsv = [columns, ...rows.map(row => columns.map(key => row[key] ?? "-"))].map(cells => cells.join("\t")).join("\n") + "\n";
  const expectedRecurrence = "blocker-recurring:delivery";
  const expectedPartial = "partly-closed:legacy:delivery:3";
  for (const [extension, content] of [["tsv", tsv], ["jsonl", jsonl(...rows)]]) {
    const file = put(w.dir, `old/trajectory.${extension}`, content);
    const alarms = readAlarms(w, file);
    assert.deepEqual(alarms.map(finding => finding.key).sort(),
      [expectedRecurrence, expectedPartial, "area-rounds:legacy:delivery"].sort());
    assert.equal(recurrence(alarms, "delivery").count, 2);
    assert.deepEqual(partialClosures(alarms)[0].evidence.stillOpen, ["delivery:R2-1"]);
    assert.equal(readFileSync(file, "utf8"), content);
  }
});

test("R7-B8-01 convergence leaves shelved and closed blockers out while preserving an unrelated open blocker", t => {
  const w = loopWorld(t);
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
    put(p.records, `rounds/${pad(round)}-judge.md`, `# R-${pad(round)}-judge\n\nphase: v1\nrole: judge\n\n${report}`);
    entries.push({ time: now, round, phase: "v1", role: "judge", verdict: "CONTINUE", commit: p.initial,
      suite: "2/0", ci: "success", ...fields });
    put(p.records, trajectory, jsonl(...entries));
    status(w.run("records-check.mjs", ["--repo", p.records, "--write"]), 0);
    w.commit(p.records, "Record the fixture judge ruling");
    const text = status(w.run("self-loop.mjs", ["next", "--config", p.config], {
      cwd: p.product, extraEnv: hostMeasurement(w, { cores: 10, load: 0.25, availableGB: 32 }),
    }), 0);
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

test("R9-B1-01 ordered · flow: lead appends a structured ruling without transcribing its keys, then reads next and alarms · loss: wrong-result", t => {
  const f = dispositionWorld(t);
  const draw = seeded(seed + 901), total = 3 + draw(8);
  const keys = Array.from({ length: total }, (_, i) => `delivery:R2-${i + 1}`);
  f.ruling(2, `OPENED: ${keys.join(", ")}\nCLOSED: -\nSHELVED: -\nCARRIED: -\n` + keys.map(k => `\n### ${k}\nflow: Lead publishes the reviewed artifact.\nloss: wrong-result. Wrong artifact published.\n`).join(""));
  const row = jsonOutput(f.append(2));
  assert.deepEqual(split(row.opened), keys.sort());
  assert.equal(f.alarms().find(a => a.key === "blocker-recurring:delivery")?.count, total);
  f.w.commit(f.p.records, "Publish appended opened blockers");
  const shown = next(f.w, f.p);
  for (const k of keys) assert.ok(shown.includes(k), shown);
  f.ruling(3, `OPENED: -\nCLOSED: ${keys.join(", ")}\nSHELVED: -\nCARRIED: -`);
  assert.deepEqual(split(jsonOutput(f.append(3)).closed), keys.sort());
  assert.equal(f.alarms().filter(a => a.type === "partly-closed").length, 0);
  f.w.commit(f.p.records, "Publish appended closures");
  assert.doesNotMatch(next(f.w, f.p), /open blockers?:[^\n]*delivery:R2-/i);
});

test("R9-B1-02 ordered · flow: historical ruling flags preserve full identifiers and refuse a truncated key before writing · loss: wrong-result", t => {
  const f = dispositionWorld(t);
  const key = "release:R9-1:part";
  f.ruling(9, `### ${key}\nflow: Lead releases an artifact.\nloss: wrong-result. Wrong artifact.`);
  const before = readFileSync(f.file, "utf8");
  const refused = f.append(9, ["--opened", "release:R9-1"]);
  status(refused, 2);
  assert.equal(readFileSync(f.file, "utf8"), before);
  assert.deepEqual(split(jsonOutput(f.append(9, ["--opened", key])).opened), [key]);
});

test("R9-B1-03 ordered · flow: carried blockers stay visible until closed without generating recurrence or partly-closed counts · loss: false-verdict", t => {
  const f = dispositionWorld(t), draw = seeded(seed + 903);
  const keys = Array.from({ length: 2 + draw(7) }, (_, i) => `release:R1-${i + 1}`);
  put(f.p.records, trajectory, jsonl({ round: 1, phase: "v1", role: "judge", verdict: "CONTINUE", area: "delivery", opened: "-", closed: "-", carried: keys.join(","), ci: "success", commit: f.p.initial }));
  for (const round of [2, 3]) {
    jsonOutput(f.append(round));
    f.w.commit(f.p.records, `Publish carried blockers through round ${round}`);
    const shown = next(f.w, f.p);
    for (const key of keys) assert.ok(shown.includes(key), shown);
    assert.deepEqual(f.alarms().filter(a => ["partly-closed", "blocker-recurring"].includes(a.type)), []);
  }
  jsonOutput(f.append(4, ["--closed", keys.join(",")]));
  f.w.commit(f.p.records, "Publish explicit closure");
  assert.doesNotMatch(next(f.w, f.p), /open blockers?:[^\n]*release:R1-/i);
  assert.deepEqual(f.alarms().filter(a => ["partly-closed", "blocker-recurring"].includes(a.type)), []);
});

test("R9-B1-04 fresh · flow: a round has two structured judge reports and a retry must choose the same one without merging their keys · loss: wrong-result", t => {
  const f = dispositionWorld(t);
  for (const [suffix, key] of [["", "release:R4-main"], ["-followup", "release:R4-followup"]])
    f.ruling(4, `OPENED: ${key}\nCLOSED: -\nSHELVED: -\nCARRIED: -\n\n### ${key}\nflow: Lead publishes a release.\nloss: wrong-result. Wrong artifact.`, suffix);
  const first = jsonOutput(f.append(4));
  const keys = split(first.opened);
  assert.equal(keys.length, 1, json(first));
  assert.ok(["release:R4-main", "release:R4-followup"].includes(keys[0]));
  const again = jsonOutput(f.append(4));
  assert.deepEqual(split(again.opened), keys);
});

test("R9-B1-05 ordered · flow: a legacy carried and closed row stays closed in next and produces no partial-closure alarm · loss: false-verdict", t => {
  const f = dispositionWorld(t), key = "release:R1-1";
  put(f.p.records, trajectory, jsonl({ round: 1, phase: "v1", role: "judge", verdict: "CONTINUE", area: "delivery", opened: "-", closed: key, carried: key, ci: "success", commit: f.p.initial }));
  jsonOutput(f.append(2));
  assert.equal(f.alarms().filter(a => a.type === "partly-closed").length, 0);
  assert.doesNotMatch(next(f.w, f.p), /open blockers?:[^\n]*release:R1-1/i);
});

test("R9-B1-06 ordered · flow: repeated reviews with carried and newly opened blockers alarm only on new openings while next retains both · loss: false-verdict", t => {
  const f = dispositionWorld(t), carried = "release:R0-1";
  const draw = seeded(seed + 906);
  const opened = Array.from({ length: 2 + draw(7) }, (_, i) => `release:R1-${i + 1}`);
  f.ruling(1, `OPENED: ${opened.join(", ")}\nCLOSED: -\nSHELVED: -\nCARRIED: ${carried}\n` + opened.map(key => `\n### ${key}\nflow: Lead publishes the reviewed artifact.\nloss: wrong-result. Wrong artifact published.\n`).join(""));
  jsonOutput(f.append(1));
  for (const round of [2, 3]) {
    jsonOutput(f.append(round));
    f.w.commit(f.p.records, `Publish mixed blockers through round ${round}`);
    const shown = next(f.w, f.p);
    for (const key of [carried, ...opened]) assert.ok(shown.includes(key), shown);
    const alarms = f.alarms();
    const recurring = alarms.find(a => a.key === "blocker-recurring:release");
    assert.equal(recurring?.count, opened.length);
    assert.deepEqual(recurring.evidence.blockers.slice().sort(), opened.slice().sort());
    const partial = alarms.find(a => a.type === "partly-closed" && a.at === round);
    assert.equal(partial?.count, opened.length);
    assert.deepEqual(partial.evidence.stillOpen.slice().sort(), opened.slice().sort());
  }
  jsonOutput(f.append(4, ["--closed", opened.join(",")]));
  f.w.commit(f.p.records, "Close new openings while retaining carry");
  assert.ok(next(f.w, f.p).includes(carried));
  assert.doesNotMatch(next(f.w, f.p), /open blockers?:[^\n]*release:R1-/i);
  assert.equal(f.alarms().filter(a => a.type === "partly-closed" && a.at === 4).length, 0);
});

test("R8-A5-01 ordered · flow: four judge rulings dispose of every blocker through every sequence of open, carry, close, shelve and carry-and-close, bound 1 key x 4 rows · loss: stuck", t => {
  const f = mechanisms(t);
  const sequences = [];
  for (let n = 0; n < DISPOSITIONS.length ** 4; n++)
    sequences.push([0, 1, 2, 3].map(r => DISPOSITIONS[Math.floor(n / DISPOSITIONS.length ** r) % DISPOSITIONS.length]));
  const key = n => `s${pad(n)}:k`;
  const expected = { open: [], shelved: [] }, defective = { open: [] };
  sequences.forEach((sequence, n) => {
    const state = blockerOracle(sequence);
    if (state === "open") expected.open.push(key(n));
    if (state === "shelved") expected.shelved.push(key(n));
    if (blockerOracle(sequence, { carriedClosed: "open" }) === "open") defective.open.push(key(n));
  });
  assert.notDeepEqual(defective.open, expected.open, "the bound does not reach the carried-and-closed defect");
  const rows = [0, 1, 2, 3].map(r => {
    const field = name => sequences.flatMap((sequence, n) => sequence[r].split("+").includes(name) ? [key(n)] : []);
    const listed = name => field(name).join(",") || "-";
    const row = judgeRow(r + 1, { time: at(10 + r), opened: listed("opened"), closed: listed("closed") });
    for (const name of ["shelved", "carried"]) if (field(name).length) row[name] = listed(name);
    return row;
  });
  f.rows(...rows);
  f.w.git(f.p.records, "add", "-A");
  f.w.commit(f.p.records, "File four rulings", at(20));
  const text = f.next({ when: at(60) });
  const open = text.split("\n").find(line => /open blockers:/.test(line));
  const shelved = text.split("\n").find(line => /^Shelved blockers/.test(line));
  const differ = (label, actual, want) => {
    const extra = actual.filter(k => !want.includes(k)), missing = want.filter(k => !actual.includes(k));
    const show = keys => keys.slice(0, 6).map(k => `${k} ${sequences[Number(k.slice(1, 5))].join(" > ")}`).join("; ");
    assert.ok(!extra.length && !missing.length, `${label}: ${extra.length} listed against the documented transitions (${show(extra)}), ${missing.length} missing (${show(missing)})`);
  };
  differ("open blockers", blockerKeys(open), expected.open);
  differ("shelved blockers", blockerKeys(shelved), expected.shelved);
});
