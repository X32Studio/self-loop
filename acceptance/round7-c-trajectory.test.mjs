import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { appendArgs, ledgerPath, serveChecks } from "./closing-fixture.mjs";
import { json, jsonl, jsonOutput, put, status, world } from "./fixture.mjs";
import { seed, seeded } from "./scenario.mjs";

class Ruling {
  constructor(round, phase, area, blockers = {}) {
    Object.assign(this, { round, phase, area, role: "judge", verdict: "CONTINUE", ci: "success", ...blockers });
  }
}

const recurrence = (alarms, kind) => alarms.find(alarm => alarm.key === `blocker-recurring:${kind}`);
const partialClosures = alarms => alarms.filter(alarm => alarm.type === "partly-closed");

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
    const name = `${String(round).padStart(4, "0")}-judge${suffix}`;
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
