// Supervision alarms on the real S4 trajectory (rounds 24–30). Alarms are screening, so no admission is needed; the
// test records what they would have raised and when, against what actually happened.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { alarms, alarmsAfter, parse, parseRows, readRows, validateRow } from "../trajectory.mjs";
import { fakeGh, fixtures, isolatedEnv, redOn, repo, scripts, temp } from "./helpers.mjs";

const rows = parse(readFileSync(join(fixtures, "s4-trajectory.tsv"), "utf8"));
const sizes = JSON.parse(readFileSync(join(fixtures, "s4-access-sizes.json"), "utf8"));
/** The first round after which supervision would have seen an alarm of this type. */
const firstAfter = type => [...new Set(rows.map(r => r.round))].find(n => alarmsAfter(rows, n, { sizes }).some(a => a.type === type));

test("S4 rounds 24–27: no alarm (green CI, distinct blockers, module under the threshold)", () => {
  assert.deepEqual(alarmsAfter(rows, 27, { sizes }), []);
});

test("S4 key-file problem: the alarms fire after round 28 and 29, before the lead's premise test after round 31", () => {
  const found = alarms(rows, { sizes });
  assert.equal(firstAfter("blocker-recurring"), 28, "keyfile-migration opened in rounds 27 and 28");
  assert.equal(firstAfter("area-rounds"), 29, "keyfile in rounds 27, 28, 29");
  assert.equal(firstAfter("growth"), 28, "src/access.js 114 -> 321 lines within four judged rounds");
  assert.equal(firstAfter("ci-not-green"), 28);
  assert.deepEqual(found.filter(a => a.type === "ci-not-green").map(a => a.at), [28, 29, 30], "Linux verify failed on 7da50ab, c6dff19, 6506fa8");
  const growth = found.find(a => a.type === "growth");
  assert.equal(growth.evidence.from.size, 114);
  assert.equal(growth.evidence.to.size, 321);
  assert.ok(found.every(a => a.message && a.evidence && a.key), "every alarm carries its evidence");
  assert.equal(found.filter(a => a.type === "blocker-recurring").length, 1, "receipt-truth and the round-26 classes do not recur");
});

test("L-0002: an area ruled on twice with its earlier blockers still open raises partly-closed", () => {
  assert.deepEqual(redOn("partly-closed-alarm"), { alarms: [] }); // red on a4db050: no alarm for the self-loop reviews
  const row = (round, opened, closed, area = "orchestrator") => ({ time: "-", round, phase: "skill", area, role: "judge", model: "-", verdict: "CONTINUE", opened, closed, suite: "-", owner: "0", commit: "-", ci: "-" });
  const review = [row(1, "convergence:B1,ci:B2,isolation:B3,audit:B4,handoff:B5,resume:B6,owner:B7", "-"), row(2, "-", "-")];
  const [a] = alarms(review).filter(x => x.type === "partly-closed");
  assert.equal(a.at, 2);
  assert.equal(a.evidence.stillOpen.length, 7);
  const partly = alarms([row(1, "a:1,a:2", "-"), row(2, "-", "a:1")]).filter(x => x.type === "partly-closed");
  assert.deepEqual(partly.map(x => x.evidence), [{ round: 2, stillOpen: ["a:2"], closed: ["a:1"] }]);
  assert.deepEqual(alarms([row(1, "a:1", "-"), row(2, "a:2", "a:1")]).filter(x => x.type === "partly-closed"), [], "all earlier blockers closed");
  assert.deepEqual(alarms([row(1, "a:1", "-"), row(2, "-", "-", "other")]).filter(x => x.type === "partly-closed"), [], "another area");
  assert.deepEqual(alarms(rows, { sizes }).filter(x => x.type === "partly-closed"), [], "S4: every key-file blocker was closed by the next ruling");
});

test("trajectory rows are validated before they are appended", () => {
  assert.equal(validateRow({ round: 1, phase: "一", role: "judge", opened: "收据:丢失" }).opened, "收据:丢失");
  assert.throws(() => validateRow({ round: 0, phase: "P", role: "judge" }), /round/);
  assert.throws(() => validateRow({ round: 1, phase: "P", role: "judge", verdict: "MAYBE" }), /verdict/);
  assert.throws(() => validateRow({ round: 1, phase: "P", role: "judge", ci: "green" }), /ci/);
  assert.throws(() => validateRow({ round: 1, phase: "P", role: "judge", opened: "no-class" }), /class:id/);
  assert.throws(() => validateRow({ round: 1, phase: "P", role: "judge", commit: "abc1234" }), /full 40-character/);
  assert.throws(() => validateRow({ round: 1, phase: "P", role: "judge", owner: "-1" }), /owner/);
  const file = join(temp(), "trajectory.jsonl");
  writeFileSync(file, "{not json\n");
  assert.throws(() => readRows(file), /not a valid row/);
});

test("the historical TSV form must have every column in every row", () => {
  const header = "time\tround\tphase\tarea\trole\tmodel\tverdict\topened\tclosed\tsuite\towner\tcommit\tci";
  assert.throws(() => parse(`${header}\nbroken\n`), /columns/);
  assert.throws(() => parse("other\theader\n"), /header/);
});

test("CLI: alarms exit 0 whatever they find (screening never blocks)", () => {
  const sizesFile = join(fixtures, "s4-access-sizes.json");
  const r = spawnSync(process.execPath, [join(scripts, "trajectory.mjs"), "alarms", "--file", join(fixtures, "s4-trajectory.tsv"), "--sizes", sizesFile], { encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /ALARM ci-not-green/);
  const file = join(temp(), "handoffs.jsonl");
  const commit = "c".repeat(40);
  const append = (...extra) => spawnSync(process.execPath, [join(scripts, "trajectory.mjs"), "append", "--file", file, "--round", "3", "--phase", "S5", "--role", "judge", "--verdict", "CONTINUE", "--suite", "4/0", "--commit", commit, ...extra], { encoding: "utf8" });
  const opened = append("--opened", "收据:丢失");
  assert.equal(opened.status, 2, opened.stderr);
  assert.match(opened.stderr, /an opened key must be named by the round's judge record, and the ledger is not metrics\/trajectory\.jsonl/);
  assert.equal(existsSync(file), false, "a refused row writes nothing");
  const a = append();
  assert.equal(a.status, 0, a.stderr);
  const bad = spawnSync(process.execPath, [join(scripts, "trajectory.mjs"), "append", "--file", file, "--round", "3", "--phase", "S5", "--role", "actor", "--commit", commit, "--opened", "no-class"], { encoding: "utf8" });
  assert.equal(bad.status, 64);
  assert.equal(spawnSync(process.execPath, [join(scripts, "trajectory.mjs"), "append", "--file", file, "--round", "3", "--phase", "S5", "--role", "judge"], { encoding: "utf8" }).status, 64, "the commit is required");
  assert.equal(readRows(file).length, 1);
  assert.deepEqual([readRows(file)[0].opened, readRows(file)[0].ci], ["-", "absent"], "a ledger outside a records repository has no loop to read CI in");
});

const ruling = (round, fields = {}) => ({ time: "-", round, phase: "v1", area: "core", role: "judge", model: "-", verdict: "CONTINUE", opened: "-", closed: "-", suite: "-", owner: "0", commit: "-", ci: "-", ...fields });
const recurring = (rows, options) => alarms(rows, options).filter(a => a.type === "blocker-recurring");
const partly = rows => alarms(rows).filter(a => a.type === "partly-closed");
const v1Rulings = join(fixtures, "v1-rulings");
const v1Rows = () => parseRows(readFileSync(join(v1Rulings, "trajectory.jsonl"), "utf8"));

test("D-0024: a blocker listed again after a phase change is not a new blocker (flow: supervision across ExampleApp S4 to A1; loss: stuck, a false count gates role calls)", () => {
  const grants = (round, phase, fields) => ruling(round, { phase, area: phase === "S4" ? "grant-store" : "records", ...fields });
  const exampleApp = [
    grants(25, "S4", { opened: "grant-store:R25-2" }), grants(32, "S4", { opened: "grant-store:R32-1" }),
    grants(33, "S4", { opened: "grant-store:R33-1" }), grants(35, "A1", { opened: "grant-store:R33-1" }),
    grants(39, "A1", { opened: "grant-store:R39-5", closed: "grant-store:R33-1" }),
  ];
  const [found] = recurring(exampleApp);
  assert.deepEqual([found.count, found.at, found.evidence], [4, 39, { rounds: [25, 32, 33, 39], blockers: ["grant-store:R25-2", "grant-store:R32-1", "grant-store:R33-1", "grant-store:R39-5"] }]);
  assert.deepEqual(recurring(exampleApp, { recur: 5 }), [], "four blockers, not the five rows that list them");
  const carried = exampleApp.map(r => r.round === 35 ? { ...r, opened: "-", carried: "grant-store:R33-1" } : r);
  assert.deepEqual(recurring(carried), [found], "the carry-over field reads as the old re-listing did");
  assert.deepEqual(recurring([ruling(1, { carried: "bug:A" }), ruling(2, { opened: "bug:A" }), ruling(3, { opened: "bug:B" })]), [],
    "a blocker first seen as carried is not an opening when it is listed again");
  const own = recurring(v1Rows());
  assert.deepEqual(own.map(a => [a.key, a.count, a.at, a.evidence.rounds]), [
    ["blocker-recurring:tip-ci-evidence", 3, 5, [1, 2, 5]],
    ["blocker-recurring:suite-evidence", 2, 6, [6]],
    ["blocker-recurring:comment-admission", 2, 6, [6]],
  ], "this loop: R1-5, reopened in round 4, counts once; distinct blockers of one ruling count (D-0024 item 1)");
});

test("C4: shelving and carry-over (flow: a ruling shelves a known limit, a new phase inherits a blocker; loss: false-verdict, a partial-closure alarm that misstates what is open)", () => {
  const rows = [ruling(1, { opened: "a:1,a:2,a:3" }), ruling(2, { closed: "a:2", shelved: "a:1" })];
  assert.deepEqual(partly(rows).map(a => [a.at, a.count, a.evidence]), [[2, 1, { round: 2, stillOpen: ["a:3"], closed: ["a:2"], shelved: ["a:1"] }]]);
  assert.deepEqual(partly([...rows, ruling(3, { shelved: "a:3" })]).map(a => a.at), [2], "nothing is open after the last shelving");
  const inherited = [ruling(1, { phase: "S4", opened: "a:1" }), ruling(2, { carried: "a:1" }), ruling(3, {}), ruling(4, {})];
  assert.deepEqual(alarms(inherited).filter(a => a.type !== "area-rounds"), [], "a carried blocker raises neither alarm");
  assert.deepEqual(partly([...inherited, ruling(5, { opened: "a:5" }), ruling(6, {})]).map(a => a.evidence.stillOpen), [["a:5"]]);
});

test("C4: the row's blocker fields (flow: the lead transcribes a ruling; loss: wrong-result, a contradictory row)", () => {
  const row = validateRow({ round: 2, phase: "v1", role: "judge", shelved: "a:1", carried: "b:2", closed: "b:2" });
  assert.deepEqual([row.shelved, row.carried], ["a:1", "b:2"]);
  assert.throws(() => validateRow({ round: 2, phase: "v1", role: "judge", carried: "no-class" }), /carried items must be class:id/);
  assert.throws(() => validateRow({ round: 2, phase: "v1", role: "judge", opened: "a:1", carried: "a:1" }), /a:1 cannot be both opened and carried/);
  assert.throws(() => validateRow({ round: 2, phase: "v1", role: "judge", opened: "a:1", shelved: "a:1" }), /both opened and shelved/);
  assert.throws(() => validateRow({ round: 2, phase: "v1", role: "judge", closed: "a:1", shelved: "a:1" }), /both closed and shelved/);
  assert.throws(() => validateRow({ round: 2, phase: "v1", role: "judge", shelved: 3 }), /shelved must be a list/);
  const migrated = { round: 12, phase: "S4", role: "judge", verdict: "CONTINUE", opened: "errata-revision:R12-1", closed: "-", shelved: "S12-1,S12-2", record: "R-0012-judge" };
  assert.deepEqual(parseRows(JSON.stringify(migrated)), [{ time: "-", area: "-", model: "-", suite: "-", owner: "0", commit: "-", ci: "-", ...migrated }],
    "ExampleApp's migrated S4 rows name shelved findings by bare ID and parse as they are");
  assert.deepEqual(Object.keys(validateRow({ round: 1, phase: "v1", role: "judge" })).sort(), ["area", "ci", "closed", "commit", "model", "opened", "owner", "phase", "role", "round", "suite", "time", "verdict"],
    "a row without the new fields has the old shape");
});

const judgeRecords = (names = readdirSync(join(v1Rulings, "rounds"))) => Object.fromEntries(names.map(name => [`rounds/${name}`, readFileSync(join(v1Rulings, "rounds", name), "utf8")]));
const appendTo = (file, row, extra = [], env = isolatedEnv()) => spawnSync(process.execPath, [join(scripts, "trajectory.mjs"), "append", "--file", file,
  "--round", String(row.round), "--phase", row.phase, "--role", row.role, "--area", row.area, "--verdict", row.verdict, "--suite", row.suite, "--commit", row.commit,
  ...["opened", "closed"].flatMap(k => row[k] === "-" ? [] : [`--${k}`, row[k]]), ...extra], { encoding: "utf8", env });

test("D-0026 item 2 admission: an opened key needs its round's judge record; this loop's six rulings and 16 opened keys stay green", () => {
  const records = repo({ "README.md": "# records\n", "records.json": "{}\n", "metrics/.keep": "", ...judgeRecords() });
  const file = join(records, "metrics", "trajectory.jsonl");
  const real = v1Rows();
  assert.equal(real.flatMap(r => r.opened === "-" ? [] : r.opened.split(",")).length, 16);
  for (const row of real) {
    const r = appendTo(file, row);
    assert.equal(r.status, 0, `round ${row.round}: ${r.stderr}`);
  }
  assert.deepEqual(readRows(file).map(r => [r.round, r.opened, r.closed]), real.map(r => [r.round, r.opened, r.closed]));
  const six = real.at(-1);
  const before = readFileSync(file, "utf8");
  const red = [
    [{ ...six, opened: "ci-host-binding:R6-8" }, /--opened ci-host-binding:R6-8: not named \(by class:id, or by its id\) in rounds\/0006-judge\.md/],
    [{ ...six, opened: "suite-evidence:R6-1,suite-evidence:R6-2" }, /--opened suite-evidence:R6-1: not named/],
    [{ ...real[4], opened: "ci-host-binding:R6-1" }, /--opened ci-host-binding:R6-1: not named .* rounds\/0005-judge\.md/],
    [{ ...six, round: 7, opened: "ci-host-binding:R7-1" }, /holds no judge record of round 7, phase v1 \(rounds\/0007-judge\*\.md\)/],
    [{ ...six, phase: "v2" }, /holds no judge record of round 6, phase v2/],
  ];
  for (const [row, message] of red) {
    const r = appendTo(file, row);
    assert.equal(r.status, 2, `${row.opened}: ${r.stderr}`);
    assert.match(r.stderr, message);
    assert.match(r.stderr, /a further judge call of the round|no ruling names/);
  }
  assert.equal(readFileSync(file, "utf8"), before, "a refused row writes nothing");
  assert.deepEqual(readdirSync(records).sort(), [".git", "README.md", "metrics", "records.json", "rounds"]);
});

test("C4 at the command line: a refused opening reads no CI and saves no receipt; shelved and carried rows are written as given", () => {
  const product = repo({ "README.md": "# product\n" });
  const commit = spawnSync("git", ["-C", product, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  spawnSync("git", ["-C", product, "remote", "add", "origin", "https://github.com/example/c4.git"]);
  const gh = fakeGh({ "example/c4": { [commit]: [{ id: 1, app: "github-actions", name: "verify", status: "completed", conclusion: "success" }] } });
  const record = "# R-0002-judge\n\nphase: v1\n\n## Public report (verbatim, out/public.md)\n\n**OPEN — 收据:丢失.**\nflow: x\nloss: data\n";
  const records = repo({ "records.json": "{}\n", "metrics/.keep": "", "rounds/0002-judge.md": record,
    "loop.json": JSON.stringify({ product, phase: "v1", gates: { require: ["github-actions/verify"] } }) });
  const file = join(records, "metrics", "trajectory.jsonl");
  const row = ruling(2, { suite: "4/0", commit });
  const env = isolatedEnv({ PATH: gh.env.PATH });
  const refused = appendTo(file, { ...row, opened: "收据:丢失-2" }, [], env);
  assert.equal(refused.status, 2, refused.stderr);
  assert.deepEqual([existsSync(file), existsSync(join(records, "evidence")), gh.queries()], [false, false, []]);
  for (const extra of [["--shelved", "S12-1"], ["--carried", "a:1", "--opened", "a:1"]]) assert.equal(appendTo(file, row, extra, env).status, 64, extra.join(" "));
  assert.equal(appendTo(file, { ...row, opened: "收据:丢失" }, ["--shelved", "a:1", "--carried", "b:2"], env).status, 0);
  assert.equal(appendTo(file, row, ["--shelved", "-", "--carried", "-"], env).status, 0);
  const [written, plain] = readRows(file);
  assert.deepEqual([written.opened, written.shelved, written.carried, written.ci], ["收据:丢失", "a:1", "b:2", "success"]);
  assert.equal(gh.queries().length, 2);
  assert.ok(!("shelved" in plain) && !("carried" in plain), "an empty list writes no field");
});
