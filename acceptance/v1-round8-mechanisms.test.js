import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { json, jsonl, jsonOutput, output, put, status } from "./fixture.mjs";
import { phase, round6B } from "./round6-b-fixture.mjs";
import { hostMeasurement } from "./round7-b-fixture.mjs";
import { now, seed, seeded, shift } from "./scenario.mjs";

const room = { cores: 20, load: 0.25, availableGB: 32 };
const crowded = { cores: 20, load: 15, availableGB: 32 };
const handoffsPath = "metrics/handoffs.jsonl";
const trajectoryPath = "metrics/trajectory.jsonl";
const wordsPath = "owner/words.jsonl";
const marksPath = "owner/word-marks.jsonl";
const RUNGS = ["construction", "hard gate", "screening predicate", "question bank", "owner-only"];
const cadencePredicate = "predicate advancing-round-due (next: \"advancing round due\", scripts/lib/cadence.mjs; F-0011 item 2)";
const pad = n => String(n).padStart(4, "0");
const at = seconds => shift(now, seconds * 1000);
const t3 = (provider, model) => ({ runner: "t3", provider, model, effort: "xhigh" });
const wordId = n => "W-" + (0xa0000000 + n).toString(16).padStart(10, "0");
const letters = (n, width) => Array.from({ length: width }, (_, i) => String.fromCharCode(97 + Math.floor(n / 26 ** (width - 1 - i)) % 26)).join("");

function shuffled(items, salt) {
  const draw = seeded(seed + salt);
  return items.map(item => [draw(1_000_000), item]).sort(([a], [b]) => a - b).map(([, item]) => item);
}

function pkg(id, { role = "actor", round = 8, authority = "D-0031", files, needs = [], hold, release, step } = {}) {
  const name = step ?? `${role}-${id}`;
  return {
    id, authority, goal: `Deliver ${id}`, files: files ?? (role === "judge" ? [] : [`src/${id}/**`]),
    interface: "Use the recorded command lines", needs, role, acceptance: `Run the ${id} acceptance cases`,
    handoff: `R-${pad(round)}-${name}`, ...(hold !== undefined ? { hold } : {}), ...(release !== undefined ? { release } : {}),
  };
}

function planText(id, packages, { scope = "v1/round-8", phaseName = "v1", supersedes } = {}) {
  const head = [`# ${id} Planning and dispatch`, "", `scope: ${scope}`, `phase: ${phaseName}`];
  if (supersedes) head.push(`supersedes: ${supersedes}`);
  return [...head, ...packages.flatMap(p => ["", `## ${p.id}`, "",
    ...Object.entries(p).filter(([key]) => key !== "id").map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(", ") : value}`)]), ""].join("\n");
}

const taskText = p => [p.goal, "features: F-0012", `Files: ${p.files.join(", ")}`, `Interface: ${p.interface}`, `Acceptance: ${p.acceptance}`, ""].join("\n");

function ownerWord(id, time, text) {
  return { id, time, text, source: "codex", session: "fixture-owner", ordinal: 1 };
}

function interventionText(id, words, { rung, carried, raised, extra = [] } = {}) {
  return [`# ${id}`, "", "Time: 2026-11-22, Asia/Dubai", `words: ${words.join(", ")}`,
    ...(raised !== undefined ? [`raised-first: ${raised}`] : []),
    ...(rung !== undefined ? [`rung: ${rung}`] : []), ...(carried !== undefined ? [`carried-by: ${carried}`] : []), "",
    "Frame: the lead held settled work behind an unrelated ruling.", "Reframe: every package without a real dependency starts now.",
    ...extra, "General question: which dispatchable work is idle, and what real dependency holds each piece back?", ""].join("\n");
}

function judgeRow(round, { verdict = "CONTINUE", area = "-", time = now, ...fields } = {}) {
  return { time, round, phase: "v1", area, role: "judge", model: "-", verdict, opened: "-", closed: "-", suite: "12/0", owner: "0", commit: "-", ci: "-", ...fields };
}

function mechanisms(t, { cadence, agents } = {}) {
  const w = round6B(t);
  const p = phase(w, "mechanisms", { agents: agents ?? {
    actor: t3("claude", "claude-opus-5-5"), critic: t3("codex", "gpt-6.2-sol"), judge: t3("codex", "gpt-6.2-sol") } });
  w.register([p]);
  const config = JSON.parse(readFileSync(p.config, "utf8"));
  config.owns = { actor: ["src", "scripts"], critic: ["acceptance"] };
  if (cadence !== undefined) config.cadence = { adversarial: cadence };
  put(p.records, "loop.json", json(config));
  put(p.records, "records.json", json({
    extraKinds: [{ kind: "Plan", path: "plans/PL-NNNN.md", changes: "immutable", citedAs: "PL-NNNN" }],
  }));
  for (const [id, title] of Object.entries({
    "D-0030": "Build the generative engine now", "D-0031": "Grill by one dependency-ordered owner batch",
    "D-0032": "Run settled work in parallel with the advancing round",
  })) put(p.records, `decisions/${id}.md`, `# ${id} ${title}\n\nid: ${id}\nby: owner\nstatus: active\n`);
  for (const [id, title] of Object.entries({ "F-0011": "Generative engine", "F-0012": "Planning and dispatch" }))
    put(p.records, `blueprint/${id}.md`, `# ${id} ${title}\n\nid: ${id}\nphase: v1\nrequirements: P-0001\n`);
  put(p.records, "metrics/windows.jsonl", jsonl({
    type: "open", id: "W-0001", phase: "v1", startRound: 1, horizon: 12,
    goal: "v1 round-8 mechanisms fixture", invariants: ["acceptance passes"], openedAt: at(0), openedBy: "lead",
  }));
  put(p.records, "metrics/blueprint.jsonl", readFileSync(join(p.records, "metrics/blueprint.jsonl"), "utf8")
    + jsonl(...["F-0011", "F-0012"].map(feature => ({ feature, status: "building", time: at(1), by: "lead", note: "Work started", evidence: {} }))));

  const publish = (message, when) => {
    w.git(p.records, "add", "-A");
    status(w.run("records-check.mjs", ["--repo", p.records, "--write"], { at: when }), 0);
    return w.commit(p.records, message, when);
  };
  publish("Record the authorized inputs", at(1));
  const host = value => hostMeasurement(w, value);
  let lastPlanId = null;
  let lastPackages = [];
  const plan = (id, packages, { when = at(20), tasks = packages, ...options } = {}) => {
    lastPlanId = id;
    lastPackages = packages;
    for (const item of tasks) put(p.workDir, `tasks/${item.handoff}.md`, taskText(item));
    put(p.records, `plans/${id}.md`, planText(id, packages, options));
    return publish(`Publish ${id}`, when);
  };
  const prepare = (item, when = at(30)) => {
    const [, round, step] = /^R-(\d+)-(.+)$/.exec(item.handoff);
    let planId = lastPackages.some(q => q.id === item.id && q.handoff === item.handoff) ? lastPlanId : null;
    if (!planId) {
      planId = "PL-0099";
      plan(planId, [item], { when });
    }
    const task = put(p.workDir, `tasks/${item.handoff}.md`, taskText(item));
    return jsonOutput(w.run("call.mjs", [p.config, item.role, "--round", String(Number(round)), "--step", step,
      "--plan", planId, "--package", item.id, "--task", task, "--prepare"], { at: when }));
  };
  const record = (item, prepared, { start = at(40), end = start, when = end, terminal = "complete" } = {}) => {
    const { ws, wt, id, prompt } = prepared;
    put(ws, "out/report.md", "This role delivered the requested work.\n");
    const session = `${id}-${prepared.nonce}`;
    const rows = item.role === "actor" ? [
      { timestamp: start, type: "user", sessionId: session, cwd: wt, message: { content: prompt } },
      { timestamp: end, type: "result", subtype: terminal === "complete" ? "success" : "error" },
    ] : [
      { timestamp: start, type: "session_meta", payload: { cwd: wt, id: session } },
      { timestamp: start, type: "event_msg", payload: { type: "user_message", message: prompt } },
      { timestamp: end, type: "event_msg", payload: { type: terminal === "complete" ? "task_complete" : "task_failed" } },
    ];
    const transcript = put(w.dir, `${session}.jsonl`, jsonl(...rows));
    return w.run("call.mjs", [p.config, "record", "--ws", ws, "--session", session, "--transcript", transcript], { at: when });
  };
  const next = ({ when = at(600), load = room } = {}) =>
    status(w.run("self-loop.mjs", ["next", "--config", p.config], { at: when, extraEnv: host(load) }), 0);
  const start = ({ when = at(600), load = room } = {}) =>
    status(w.run("self-loop.mjs", ["start", "--config", p.config], { at: when, extraEnv: host(load) }), 0);
  const tick = ({ when = at(600), load = room } = {}) => {
    const result = w.run("self-loop.mjs", ["tick", "--json"], { at: when, extraEnv: host(load) });
    assert.ok([0, 2].includes(result.status), output(result));
    return { code: result.status, report: JSON.parse(result.stdout) };
  };
  const ready = (id, { when = at(600), load = room } = {}) => {
    const data = jsonOutput(w.run("plan.mjs", ["ready", "--records", p.records, "--plan", id, "--json"], { at: when, extraEnv: host(load), cwd: p.records }));
    return new Map(data.packages.map(row => [row.id, row]));
  };
  const rows = (...entries) => {
    const path = join(p.records, trajectoryPath);
    let before = "";
    try { before = readFileSync(path, "utf8"); } catch { before = ""; }
    put(p.records, trajectoryPath, before + jsonl(...entries));
  };
  const handoffs = (...entries) => {
    const before = readFileSync(join(p.records, handoffsPath), "utf8");
    put(p.records, handoffsPath, before + jsonl(...entries.map(({ round, step, time }) => {
      const id = `R-${pad(round)}-${step}`, record = `rounds/${pad(round)}-${step}.md`, role = step.split("-")[0];
      put(p.records, record, `# ${id}\n\nphase: v1\nrole: ${role}\n`);
      return { id, round, phase: "v1", role, step, time, product: null, record, attempt: 1, files: [record],
        view: w.git(p.records, "rev-parse", "HEAD"), audit: { violations: 0 }, agent: { runner: "claude", model: `fixture-${role}` } };
    })));
  };
  const metrics = (when = at(900)) => jsonOutput(w.run("owner-words.mjs", ["metrics", "--records", p.records, "--json"], { at: when }));
  const sendBatch = (number, when) => {
    const file = put(w.dir, `questions-${number}.json`, json({ questions: [{
      question: `Ship dispatch part ${number} in v1?`, options: ["Ship in v1", "Move to v2"], recommendation: "Ship in v1",
    }] }));
    status(w.run("decisions.mjs", ["send", "--records", p.records, "--file", file, "--phase", "v1", "--from", "R-0001-reviewer-frame"], { at: when }), 0);
    publish(`Send owner batch ${number}`, when);
    return `B-${pad(number)}`;
  };
  const answer = (batch, when, outcome) => jsonOutput(w.run("decisions.mjs", ["answer", "--records", p.records, "--batch", batch,
    "--words", "Ship in v1", ...(outcome ? ["--outcome", outcome] : [])], { at: when }));
  return { w, p, publish, plan, prepare, record, next, start, tick, ready, rows, handoffs, metrics, sendBatch, answer };
}

function itemsOf(text) {
  const items = [];
  let current = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("- ")) items.push(current = { title: line, lines: [line] });
    else if (current && line.startsWith("  ")) current.lines.push(line);
    else current = null;
  }
  return items;
}

const mentions = (body, ids) => ids.filter(id => new RegExp(`\\b${id}\\b`).test(body));

function idleInNext(text, ids) {
  const items = itemsOf(text).filter(item => /\b(start|hold|idle|unstarted|dispatch)/i.test(item.title) && !/prepared workspace/i.test(item.title));
  return mentions(items.map(item => item.lines.join("\n")).join("\n"), ids).sort();
}

function idleInTick(report, p, ids) {
  const findings = report.findings.filter(f => f.product === p.name || f.records === p.records);
  assert.ok(!findings.some(f => f.kind === "error"), json(report));
  return mentions(JSON.stringify(findings.filter(f => f.kind === "idle")), ids).sort();
}

function flagged(f, ids, expected, options = {}) {
  const want = [...expected].sort();
  const text = f.next(options);
  assert.deepEqual(idleInNext(text, ids), want, text);
  const { code, report } = f.tick(options);
  assert.deepEqual(idleInTick(report, f.p, ids), want, json(report));
  if (want.length) assert.equal(code, 2, json(report));
  return text;
}

function headerOf(text) {
  const lines = text.split("\n");
  const first = lines.findIndex(line => line.startsWith("- "));
  return lines.slice(0, first < 0 ? lines.length : first).join("\n");
}

function sessionPart(text) {
  const index = text.indexOf("This session:");
  assert.ok(index >= 0, text);
  return text.slice(index);
}

const LABELS = {
  directions: /owner[ -]?directions?/gi,
  raised: /raised[ -]?first(?:[ -]?count)?/gi,
  precision: /precision(?: of (?:the )?(?:batch )?answers)?/gi,
  critical: /critical[ -]?path(?:[ -]?(?:work|time|duration))?/gi,
  idle: /idle(?:[ -]?dispatchable)?(?:[ -]?(?:time|work|seconds|package-seconds))?/gi,
  waiting: /owner[ -]?wait(?:ing)?(?:[ -]?time)?/gi,
};
const TOKEN = "unknown|n\\/a|-?\\d+(?:\\.\\d+)?%?";

function tokens(header, label) {
  const found = [];
  for (const match of header.matchAll(LABELS[label])) {
    const after = new RegExp(`^[\\s:=]*(${TOKEN})`, "i").exec(header.slice(match.index + match[0].length));
    if (after) found.push(after[1].toLowerCase());
    const before = new RegExp(`(?:^|[\\s(])(${TOKEN})[\\s:]*$`, "i").exec(header.slice(0, match.index));
    if (before) found.push(before[1].toLowerCase());
  }
  return found;
}

function shows(header, label, accepted) {
  const found = tokens(header, label);
  assert.ok(found.some(token => accepted.includes(token)), `${label}: expected one of ${accepted.join(" | ")}, found ${found.join(" | ") || "nothing"} in:\n${header}`);
}

function unknownOnly(header, label) {
  const found = tokens(header, label);
  assert.ok(found.length > 0, `${label}: no figure in:\n${header}`);
  assert.ok(found.every(token => token === "unknown" || token === "n/a"), `${label}: an unknown measure printed as ${found.join(" | ")} in:\n${header}`);
}

function ratioForms(part, whole) {
  if (!whole) return ["unknown", "n/a"];
  const value = part / whole;
  return [`${Math.round(value * 1000) / 10}%`, `${Math.round(value * 100)}%`, String(Math.round(value * 100) / 100), String(Math.round(value * 1000) / 1000)];
}

function interventionItems(text) {
  return itemsOf(text).filter(item => /intervention/i.test(item.title) && /disposition|rung|mechanism|carri/i.test(item.title));
}

function listedInterventions(text) {
  return [...new Set(interventionItems(text).flatMap(item => item.lines.join("\n").match(/I-\d{4}/g) ?? []))].sort();
}

test("R8-A1-01 ordered · flow: lead records three interventions, two without a disposition, then marks a word, prepares a critic and reads next · loss: stuck", t => {
  const f = mechanisms(t);
  const words = [1, 2, 3, 4].map(n => ownerWord(wordId(n), at(100 + n), `Owner correction ${n}: start the decided work now.`));
  put(f.p.records, wordsPath, jsonl(...words));
  put(f.p.records, marksPath, jsonl(...words.slice(0, 3).map((word, i) => ({ id: word.id, as: "direction", intervention: `I-000${i + 1}`, time: at(120) }))));
  put(f.p.records, "interventions/I-0001.md", interventionText("I-0001", [words[0].id], { raised: "no" }));
  put(f.p.records, "interventions/I-0002.md", interventionText("I-0002", [words[1].id], { raised: "no" }));
  put(f.p.records, "interventions/I-0003.md", interventionText("I-0003", [words[2].id], { raised: "no",
    rung: "construction", carried: "the registry and the 12 h stall check (F-0003, scripts/lib/tick.mjs)" }));
  f.publish("Record three interventions", at(130));
  status(f.w.run("owner-words.mjs", ["mark", "--records", f.p.records, "--id", words[3].id, "--as", "direction", "--intervention", "I-0001"], { at: at(140) }), 0);
  status(f.w.run("records-check.mjs", ["--repo", f.p.records], { at: at(150) }), 0);
  const critic = pkg("alpha", { role: "critic", files: ["acceptance/alpha/**"] });
  f.prepare(critic, at(160));
  const text = f.next();
  assert.deepEqual(listedInterventions(text), ["I-0001", "I-0002"], text);
  const convergence = itemsOf(text).find(item => /convergence conditions not met/.test(item.title));
  assert.ok(convergence, text);
  assert.doesNotMatch(convergence.lines.join("\n"), /I-000\d|disposition|rung|carried-by/i);
});

test("R8-A1-02 fresh · flow: lead files interventions with partial dispositions, prose that names a rung, and an appended correction · loss: false-verdict", t => {
  const f = mechanisms(t);
  const words = [1, 2, 3, 4, 5, 6].map(n => ownerWord(wordId(n), at(100 + n), `Owner correction ${n}.`));
  put(f.p.records, wordsPath, jsonl(...words));
  put(f.p.records, marksPath, jsonl(...words.map((word, i) => ({ id: word.id, as: "direction", intervention: `I-000${i + 1}`, time: at(120) }))));
  const texts = {
    "I-0001": interventionText("I-0001", [words[0].id], { raised: "no", rung: "screening predicate" }),
    "I-0002": interventionText("I-0002", [words[1].id], { raised: "no", carried: "F-0012 A3" }),
    "I-0003": interventionText("I-0003", [words[2].id], { raised: "no", rung: "owner-only", carried: "none: the owner's taste in naming has no record to compute from" }),
    "I-0004": interventionText("I-0004", [words[3].id], { raised: "no", extra: [
      "Which rung carries it: a screening predicate, carried-by F-0012 once the plan records holds.",
      "rung of the ladder and carried-by pointer are still to be written."] }),
    "I-0005": interventionText("I-0005", [words[4].id], { raised: "no" }),
    "I-0006": interventionText("I-0006", [words[5].id], { raised: "no", rung: "", carried: "F-0011 item 2" }),
  };
  for (const [id, text] of Object.entries(texts)) put(f.p.records, `interventions/${id}.md`, text);
  f.publish("Record six interventions", at(130));
  const before = f.next({ when: at(200) });
  assert.deepEqual(listedInterventions(before), ["I-0001", "I-0002", "I-0004", "I-0005", "I-0006"], before);
  put(f.p.records, "interventions/I-0005.md", texts["I-0005"] + "rung: hard gate\ncarried-by: records-check.mjs raised-first (RECORDS.md, The owner's words)\n");
  f.publish("Append the disposition of I-0005", at(300));
  const after = f.next({ when: at(400) });
  assert.deepEqual(listedInterventions(after), ["I-0001", "I-0002", "I-0004", "I-0006"], after);
});

test("R8-A1-03 fresh · flow: lead backfills a long intervention log in which about half carry a disposition · loss: false-verdict", t => {
  const f = mechanisms(t);
  const draw = seeded(seed + 13);
  const count = 48 + draw(17);
  const words = Array.from({ length: count }, (_, i) => ownerWord(wordId(100 + i), at(100 + i), `Owner correction ${i}.`));
  put(f.p.records, wordsPath, jsonl(...words));
  put(f.p.records, marksPath, jsonl(...words.map((word, i) => ({ id: word.id, as: "direction", intervention: `I-${pad(i + 1)}`, time: at(200) }))));
  const pointers = ["F-0012 A3", "F-0011 item 2", "the registry and stall check", "none: a one-off preference of the owner", "D-0032 cadence"];
  const undisposed = [];
  for (let i = 0; i < count; i++) {
    const id = `I-${pad(i + 1)}`;
    const disposed = draw(2) === 0;
    if (!disposed) undisposed.push(id);
    put(f.p.records, `interventions/${id}.md`, interventionText(id, [words[i].id], disposed
      ? { raised: "no", rung: RUNGS[draw(RUNGS.length)], carried: pointers[draw(pointers.length)] } : { raised: "no" }));
  }
  f.publish("Backfill the intervention log", at(300));
  const text = f.next({ when: at(400) });
  assert.deepEqual(listedInterventions(text), undisposed.sort(), text);
});

function cadenceSnapshots(f, words) {
  const steps = [
    [60, () => f.rows(judgeRow(2, { time: at(60) })), false],
    [120, () => f.rows(judgeRow(3, { time: at(120) })), true],
    [180, () => f.handoffs({ round: 4, step: "reviewer-frame", time: at(170) }, { round: 4, step: "judge-frame", time: at(175) }), false],
    [240, () => f.rows(judgeRow(5, { time: at(240) })), false],
    [300, () => f.rows(judgeRow(6, { time: at(300) })), true],
    [390, () => f.handoffs({ round: 7, step: "reviewer-frame", time: at(380) }, { round: 7, step: "judge-frame", time: at(385) }), false],
  ];
  const fired = steps.map(([when, event], i) => {
    event();
    f.publish(`Snapshot ${i + 1}`, at(when));
    return due(f.next({ when: at(when + 1) }));
  });
  assert.deepEqual(fired, steps.map(([, , expected]) => expected), "the cited predicate does not fire on the snapshots the scenario states");
  put(f.p.records, wordsPath, jsonl(...words.map(([word]) => word)));
  put(f.p.records, marksPath, jsonl(...words.map(([word, id]) => ({ id: word.id, as: "direction", intervention: id, time: at(410) }))));
  for (const [word, id] of words)
    put(f.p.records, `interventions/${id}.md`, interventionText(id, [word.id], { rung: "screening predicate", carried: cadencePredicate }));
  f.publish("Record the owner's corrections and their interventions", at(420));
}

function falseAlarmCounts(value, found = []) {
  if (Array.isArray(value)) value.forEach(item => falseAlarmCounts(item, found));
  else if (value && typeof value === "object") for (const [key, inner] of Object.entries(value)) {
    if (/false.?alarm/i.test(key)) {
      if (typeof inner === "number") found.push(inner);
      else if (Array.isArray(inner)) found.push(inner.length);
      else if (inner && typeof inner === "object") for (const leaf of Object.values(inner))
        found.push(typeof leaf === "number" ? leaf : Array.isArray(leaf) ? leaf.length : NaN);
    } else falseAlarmCounts(inner, found);
  }
  return found;
}

test("R8-A2-01 ordered · flow: the cadence predicate an intervention cites fires on the snapshot before the owner's word and once on an earlier snapshot nobody corrected · loss: wrong-result", t => {
  const f = mechanisms(t, { cadence: 2 });
  const word = ownerWord(wordId(1), at(330), "三轮对抗之后要有推进，为什么还在加固？");
  cadenceSnapshots(f, [[word, "I-0001"]]);
  const m = f.metrics();
  assert.equal(m.ownerDirections, 1, json(m));
  assert.equal(m.raisedFirst, 0, json(m));
  const counts = falseAlarmCounts(m);
  assert.ok(counts.length > 0, `no false-alarm count in ${json(m)}`);
  assert.ok(counts.every(n => n === 1), `false alarms ${counts.join(", ")} in ${json(m)}`);
});

test("R8-A2-02 ordered · flow: two corrections cite the same predicate, one arriving after it fired and one in the quiet snapshot between fires · loss: wrong-result", t => {
  const f = mechanisms(t, { cadence: 2 });
  const quiet = ownerWord(wordId(1), at(270), "为什么不推进新功能？");
  const firing = ownerWord(wordId(2), at(330), "三轮对抗之后要有推进，为什么还在加固？");
  cadenceSnapshots(f, [[quiet, "I-0002"], [firing, "I-0001"]]);
  const m = f.metrics();
  assert.equal(m.ownerDirections, 2, json(m));
  assert.equal(m.raisedFirst, 0, json(m));
  const entry = id => m.directions.find(d => d.id === id);
  assert.notEqual(entry(firing.id)?.verified, true, json(m));
  assert.ok(entry(firing.id)?.predicates?.some(p => p.fires === true), json(m));
  assert.notEqual(entry(quiet.id)?.verified, true, json(m));
});

test("R8-A3-01 ordered · flow: lead reconciles a published plan of three authorized packages and starts none of them · loss: stuck", t => {
  const f = mechanisms(t);
  const packages = [pkg("alpha"), pkg("bravo", { role: "critic", authority: "D-0030", files: ["acceptance/bravo/**"] }), pkg("charlie", { role: "judge", authority: "D-0030" })];
  f.plan("PL-0001", shuffled(packages, 31));
  flagged(f, ["alpha", "bravo", "charlie"], ["alpha", "bravo", "charlie"]);
});

test("R8-A3-02 ordered · flow: lead records a hold with its release condition, a hold without one, then revises the plan to move the holds · loss: wrong-result", t => {
  const f = mechanisms(t);
  const ids = ["alpha", "bravo", "charlie"];
  const pending = { hold: "R-0008-judge-frame has not ruled on the derived interface", release: "the R-0008-judge-frame ruling is committed" };
  f.plan("PL-0001", [pkg("alpha", pending), pkg("bravo", { hold: "waiting for the frame judge", release: "" }), pkg("charlie")]);
  flagged(f, ids, ["bravo", "charlie"], { when: at(100) });
  f.plan("PL-0002", [pkg("alpha"), pkg("bravo", pending), pkg("charlie", { hold: "the owner batch on scope is open", release: "the owner's answer to the scope batch is committed" })],
    { supersedes: "PL-0001", when: at(200) });
  flagged(f, ids, ["alpha"], { when: at(300) });
});

test("R8-A3-03 ordered · flow: lead prepares one package, records another and leaves a third unstarted · loss: wrong-result", t => {
  const f = mechanisms(t);
  const alpha = pkg("alpha"), bravo = pkg("bravo"), charlie = pkg("charlie"), delta = pkg("delta", { role: "judge", authority: "D-0030" });
  f.plan("PL-0001", [alpha, bravo, charlie, delta]);
  f.prepare(alpha, at(30));
  f.prepare(delta, at(31));
  jsonOutput(f.record(bravo, f.prepare(bravo, at(32)), { start: at(40), when: at(45) }));
  assert.deepEqual(Object.fromEntries([...f.ready("PL-0001", { when: at(50) })].map(([id, row]) => [id, row.status])),
    { alpha: "running", bravo: "done", charlie: "ready", delta: "running" });
  flagged(f, ["alpha", "bravo", "charlie", "delta"], ["charlie"]);
});

test("R8-A3-04 ordered · flow: lead plans packages behind a package dependency and an owner batch, then the host fills and empties and the owner answers · loss: wrong-result", t => {
  const f = mechanisms(t);
  const ids = ["alpha", "bravo", "charlie", "delta"];
  const batch = f.sendBatch(1, at(10));
  f.plan("PL-0001", [pkg("alpha"), pkg("bravo", { needs: ["alpha"] }), pkg("charlie", { needs: [batch] }), pkg("delta", { role: "judge", authority: "D-0030" })]);
  flagged(f, ids, ["alpha", "delta"], { when: at(100) });
  flagged(f, ids, [], { when: at(110), load: crowded });
  flagged(f, ids, ["alpha", "delta"], { when: at(120) });
  f.answer(batch, at(130), "as-recommended");
  f.publish("Record the owner's answer", at(140));
  flagged(f, ids, ["alpha", "charlie", "delta"], { when: at(150) });
});

function ownerDecidedBehindFrame(f) {
  f.rows(judgeRow(2, { time: at(10), area: "frame" }));
  f.publish("Rule round 2", at(12));
  const frame = pkg("frame", { role: "judge", authority: "D-0030", step: "judge-frame" });
  const alpha = pkg("alpha", { authority: "D-0031" });
  const bravo = pkg("bravo", { role: "critic", authority: "D-0031", files: ["acceptance/bravo/**"] });
  const charlie = pkg("charlie", { authority: "D-0030", needs: ["frame"] });
  f.plan("PL-0001", [frame, alpha, bravo, charlie]);
  f.prepare(frame, at(30));
  return ["frame", "alpha", "bravo", "charlie"];
}

test("R8-A3-05 ordered · flow: the advancing round is due and its frame judge is running while two owner-decided packages wait unstarted with no recorded hold · loss: stuck", t => {
  const f = mechanisms(t, { cadence: 1 });
  const ids = ownerDecidedBehindFrame(f);
  const text = flagged(f, ids, ["alpha", "bravo"]);
  assert.match(text, /advancing round due/i);
});

test("R8-A3-06 fresh · flow: lead reads next during a due advancing round while owner-decided packages are ready · loss: stuck", t => {
  const f = mechanisms(t, { cadence: 1 });
  ownerDecidedBehindFrame(f);
  const text = f.next();
  const advancing = itemsOf(text).find(item => /advancing (?:round|review) due/i.test(item.title));
  assert.ok(advancing, text);
  const body = advancing.lines.join("\n");
  assert.doesNotMatch(body, /no critic or actor call runs in it\./i);
  assert.match(body, /parallel|alongside|meanwhile|concurrent/i);
});

test("R8-A3-07 fresh · flow: lead keeps a superseded plan, a second scope and a plan of the previous phase in the records · loss: wrong-result", t => {
  const f = mechanisms(t);
  const ids = ["alpha", "bravo", "charlie", "delta", "echo"];
  f.plan("PL-0001", [pkg("alpha"), pkg("bravo")], { when: at(10) });
  f.plan("PL-0002", [pkg("alpha"), pkg("charlie")], { supersedes: "PL-0001", when: at(20) });
  f.plan("PL-0003", [pkg("delta", { files: ["docs/delta/**"] })], { scope: "v1/docs", when: at(30) });
  f.plan("PL-0004", [pkg("echo", { round: 3 })], { scope: "v0/round-3", phaseName: "v0", when: at(40) });
  flagged(f, ids, ["alpha", "charlie", "delta"]);
});

test("R8-A3-08 fresh · flow: lead publishes a plan for an owner-decided package and never writes its task · loss: stuck", t => {
  const f = mechanisms(t);
  const alpha = pkg("alpha"), bravo = pkg("bravo"), charlie = pkg("charlie", { hold: "the derived interface waits for its ruling", release: "R-0008-judge-frame is committed" });
  f.plan("PL-0001", [alpha, bravo, charlie], { tasks: [bravo, charlie] });
  flagged(f, ["alpha", "bravo", "charlie"], ["alpha", "bravo"]);
});

function headerFixture(t) {
  const f = mechanisms(t);
  put(f.p.records, "decisions/D-0040.md", "# D-0040 Propose dispatch of every independent package\n\nid: D-0040\nby: lead\nstatus: active\n");
  f.publish("Record the proposal", at(5));
  const b1 = f.sendBatch(1, at(10)), b2 = f.sendBatch(2, at(15)), b3 = f.sendBatch(3, at(18));
  f.answer(b1, at(70), "as-recommended");
  f.answer(b2, at(72), "as-recommended");
  f.answer(b3, at(74), "amended");
  f.publish("Record the owner's answers", at(80));
  const words = [1, 2, 3, 4].map(n => ownerWord(wordId(n), at(100 + n * 10), `Owner direction ${n}.`));
  const routine = ownerWord(wordId(9), at(160), "继续");
  put(f.p.records, wordsPath, jsonl(...words, routine));
  put(f.p.records, marksPath, jsonl(...words.map((word, i) => ({ id: word.id, as: "direction", intervention: `I-000${i + 1}`, time: at(170) })),
    { id: routine.id, as: "routine", note: "Go-ahead", time: at(170) }));
  words.forEach((word, i) => put(f.p.records, `interventions/I-000${i + 1}.md`, interventionText(`I-000${i + 1}`, [word.id], {
    raised: i === 0 ? "D-0040" : "no", rung: "screening predicate", carried: "F-0012 A3" })));
  f.publish("Record the directions", at(180));
  f.rows(judgeRow(2, { time: at(190), area: "dispatch", opened: "dispatch:slow-start" }));
  f.publish("Rule round 2", at(195));
  f.plan("PL-0001", [pkg("alpha", { needs: [b1] }), pkg("bravo")], { when: at(200) });
  return f;
}

test("R8-A4-01 ordered · flow: lead reads next and start after a phase with four directions, three labelled answers and a plan behind an answered batch · loss: wrong-result", t => {
  const f = headerFixture(t);
  const m = f.metrics(at(600));
  const measured = jsonOutput(f.w.run("plan.mjs", ["measure", "--records", f.p.records, "--plan", "PL-0001", "--json"], { at: at(600), cwd: f.p.records }));
  assert.equal(m.ownerDirections, 4, json(m));
  assert.equal(m.raisedFirst, 1, json(m));
  assert.equal(measured.criticalPath.seconds, null, json(measured));
  assert.ok(Number.isFinite(measured.ownerWaiting.seconds) && measured.ownerWaiting.seconds > 0, json(measured));
  for (const text of [f.next(), sessionPart(f.start())]) {
    const header = headerOf(text);
    shows(header, "directions", [String(m.ownerDirections)]);
    shows(header, "raised", [String(m.raisedFirst)]);
    shows(header, "precision", ratioForms(m.answersByOutcome["as-recommended"], m.answeredWithOutcome));
    unknownOnly(header, "critical");
    unknownOnly(header, "idle");
    shows(header, "waiting", [String(measured.ownerWaiting.seconds)]);
    assert.match(header, /returns per area[^\n]*\n[^\n]*dispatch: round 2 opened 1/i);
  }
});

test("R8-A4-02 ordered · flow: lead starts a session on a phase with a frame but no direction, no labelled answer and no plan · loss: wrong-result", t => {
  const f = mechanisms(t);
  const batch = f.sendBatch(1, at(10));
  f.answer(batch, at(20));
  f.publish("Record an unlabelled answer", at(30));
  const m = f.metrics(at(600));
  assert.equal(m.ownerDirections, 0, json(m));
  assert.equal(m.precision, null, json(m));
  for (const text of [f.next(), sessionPart(f.start())]) {
    const header = headerOf(text);
    shows(header, "directions", ["0"]);
    shows(header, "raised", ["0"]);
    unknownOnly(header, "precision");
    shows(header, "waiting", ["10"]);
    for (const label of ["critical", "idle"]) {
      const found = tokens(header, label);
      assert.ok(found.length > 0 && found.every(token => token === "unknown"), `${label}: ${found.join(" | ") || "nothing"} in:\n${header}`);
    }
  }
});

const DISPOSITIONS = ["none", "opened", "carried", "closed", "shelved", "carried+closed"];

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

function graphs() {
  const edges = [];
  for (const a of [0, 1, 2]) for (const b of [0, 1, 2]) if (a !== b) edges.push([a, b]);
  const all = [];
  for (let mask = 0; mask < 1 << edges.length; mask++) all.push(edges.filter((_, i) => mask & 1 << i));
  for (const node of [0, 1, 2]) all.push([[node, node], ...edges.filter(([a, b]) => a < b)]);
  return all;
}

function cyclic(graph) {
  const out = [0, 1, 2].map(n => graph.filter(([a]) => a === n).map(([, b]) => b));
  const state = [0, 0, 0];
  const visit = n => {
    if (state[n] === 1) return true;
    if (state[n] === 2) return false;
    state[n] = 1;
    const found = out[n].some(visit);
    state[n] = 2;
    return found;
  };
  return [0, 1, 2].some(visit);
}

async function inBatches(jobs, size = 6) {
  const results = [];
  for (let i = 0; i < jobs.length; i += size) results.push(...await Promise.all(jobs.slice(i, i + size).map(job => job())));
  return results;
}

function validateLater(f, name, packages) {
  const file = put(f.w.dir, `drafts/${name}.md`, planText("PL-0009", packages));
  return () => f.w.runAsync(["validate", file, "--records", f.p.records], { entry: "plan.mjs", cwd: f.p.records, at: at(60) });
}

test("R8-A5-02 ordered · flow: lead links three read-only packages in every possible dependency graph beside every acyclic one, bound 3 packages x 9 edges · loss: stuck", async t => {
  const f = mechanisms(t);
  const all = graphs();
  const acyclic = all.filter(g => !cyclic(g)), loops = all.filter(cyclic);
  const rooted = g => [0, 1, 2].some(n => !g.some(([, b]) => b === n));
  assert.ok(loops.some(g => !rooted(g)) && loops.some(g => !g.some(([a, b]) => g.some(([c, d]) => c === b && d === a)) && g.every(([a, b]) => a !== b)),
    "the bound does not reach a rootless or three-package cycle");
  const nodes = ["x", "y", "z"];
  const packagesOf = (graph, tag) => nodes.map((node, i) => pkg(`${tag}${node}`, { role: "judge", authority: "D-0030",
    needs: graph.filter(([a]) => a === i).map(([, b]) => `${tag}${nodes[b]}`) }));
  const base = acyclic.flatMap((g, i) => packagesOf(g, `a${letters(i, 2)}`));
  const jobs = [validateLater(f, "acyclic", shuffled(base, 52)),
    ...loops.map((g, i) => validateLater(f, `loop-${i}`, shuffled([...base, ...packagesOf(g, `c${letters(i, 2)}`)], 53 + i)))];
  const results = await inBatches(jobs);
  assert.equal(results[0].status, 0, output(results[0]));
  results.slice(1).forEach((result, i) => {
    assert.ok(result.status > 0, `cycle ${JSON.stringify(loops[i])} accepted: ${output(result)}`);
    assert.match(output(result), /cycle|circular/i, JSON.stringify(loops[i]));
  });
});

const GLOBS = ["a/b", "a/*", "*/b", "a/a*", "a/*b", "a/?", "a/[ab]", "a/{x,ab}", "b/*", "a/**/b", "**/ab", "b/", "a/x/*", "*/x/?", "*/[a-b]x", "{a,b}/x/a"];

function globRegex(pattern, { zero }) {
  if (pattern.endsWith("/")) return new RegExp(`^${segmentsOf(pattern.slice(0, -1), zero)}/.+$`);
  return new RegExp(`^${segmentsOf(pattern, zero)}$`);
}

function segmentsOf(pattern, zero) {
  const parts = pattern.split("/");
  let source = "";
  parts.forEach((part, i) => {
    const last = i === parts.length - 1;
    if (part === "**") { source += zero ? "(?:[^/]+/)*" : "(?:[^/]+/)+"; return; }
    let segment = "", inClass = false;
    for (const c of part) {
      if (inClass) { segment += c; inClass = c !== "]"; }
      else if (c === "[") { segment += c; inClass = true; }
      else if (c === "*") segment += "[^/]*";
      else if (c === "?") segment += "[^/]";
      else if (c === "{") segment += "(?:";
      else if (c === "}") segment += ")";
      else if (c === ",") segment += "|";
      else segment += c.replace(/[.+^$()|\\]/g, "\\$&");
    }
    source += segment + (last ? "" : "/");
  });
  return source;
}

function universe() {
  const names = [];
  const grow = (prefix, depth) => { if (prefix) names.push(prefix); if (depth) for (const c of "abx") grow(prefix + c, depth - 1); };
  grow("", 3);
  const short = names.filter(n => n.length <= 2);
  const paths = [...names];
  for (const a of names) for (const b of names) paths.push(`${a}/${b}`);
  for (const a of names) for (const b of names) for (const c of names) paths.push(`${a}/${b}/${c}`);
  for (const a of short) for (const b of short) for (const c of short) for (const d of short) paths.push(`${a}/${b}/${c}/${d}`);
  return paths;
}

test("R8-A5-03 fresh · flow: lead carves two writers for every pair of sixteen globs that meet only at paths no file has yet, bound 3 segments of 3 letters and 4 segments of 2 · loss: wrong-result", async t => {
  const f = mechanisms(t);
  const paths = universe();
  const matches = zero => GLOBS.map(g => { const re = globRegex(g, { zero }); return new Set(paths.filter(p => re.test(p))); });
  const withZero = matches(true), withoutZero = matches(false);
  const meets = (sets, i, j) => [...sets[i]].some(path => sets[j].has(path));
  const pairs = [];
  for (let i = 0; i < GLOBS.length; i++) for (let j = i + 1; j < GLOBS.length; j++) {
    const a = meets(withZero, i, j), b = meets(withoutZero, i, j);
    if (a === b) pairs.push({ left: GLOBS[i], right: GLOBS[j], overlap: a });
  }
  const prefix = g => g.split(/[*?[{]/)[0];
  const literalPrefix = pair => prefix(pair.left).startsWith(prefix(pair.right)) || prefix(pair.right).startsWith(prefix(pair.left));
  assert.ok(pairs.some(pair => pair.overlap) && pairs.some(pair => !pair.overlap), "the bound holds no overlap or no disjoint pair");
  assert.ok(pairs.some(pair => literalPrefix(pair) !== pair.overlap), "the bound does not separate a literal-prefix comparison");
  assert.ok(pairs.some(pair => pair.overlap && pair.left !== pair.right), "the bound does not separate string equality");
  const jobs = pairs.map((pair, n) => validateLater(f, `pair-${n}`, [
    pkg("left", { files: [pair.left] }), pkg("right", { files: [pair.right] })]));
  const results = await inBatches(jobs);
  const wrong = pairs.filter((pair, n) => pair.overlap ? results[n].status === 0 : results[n].status !== 0)
    .map(pair => `${pair.left} / ${pair.right}: ${pair.overlap ? "overlap accepted" : "disjoint refused"}`);
  assert.deepEqual(wrong, []);
  pairs.forEach((pair, n) => { if (pair.overlap) assert.match(output(results[n]), /overlap|share|conflict/i, `${pair.left} / ${pair.right}`); });
});

function startable(rows) {
  return Object.fromEntries([...rows].map(([id, row]) => [id, row.command ? "command" : row.status]));
}

test("R8-A5-04 ordered · flow: lead prepares, revises the plan around a live attempt, loses the attempt, retries and records it, bound 3 packages x 4 events · loss: wrong-result", t => {
  const f = mechanisms(t);
  const alpha = pkg("alpha"), bravo = pkg("bravo"), charlie = pkg("charlie");
  f.plan("PL-0001", [alpha, bravo], { when: at(10) });
  assert.deepEqual(startable(f.ready("PL-0001", { when: at(20) })), { alpha: "command", bravo: "command" });
  const first = f.prepare(alpha, at(30));
  assert.deepEqual(startable(f.ready("PL-0001", { when: at(40) })), { alpha: "running", bravo: "command" });
  f.plan("PL-0002", [alpha, bravo, charlie], { supersedes: "PL-0001", when: at(50) });
  assert.deepEqual(startable(f.ready("PL-0002", { when: at(60) })), { alpha: "running", bravo: "command", charlie: "command" });
  const lost = f.record(alpha, first, { start: at(70), when: at(80), terminal: "failed" });
  assert.ok(lost.status > 0, output(lost));
  assert.deepEqual(startable(f.ready("PL-0002", { when: at(90) })), { alpha: "command", bravo: "command", charlie: "command" });
  const second = f.prepare(alpha, at(100));
  assert.notEqual(second.ws, first.ws);
  assert.deepEqual(startable(f.ready("PL-0002", { when: at(110) })), { alpha: "running", bravo: "command", charlie: "command" });
  jsonOutput(f.record(alpha, second, { start: at(120), when: at(130) }));
  assert.deepEqual(startable(f.ready("PL-0002", { when: at(140) })), { alpha: "done", bravo: "command", charlie: "command" });
});

const A_STATES = ["unstarted", "started", "done", "held"];
const B_STATES = ["unstarted", "held"];

function progressOracle(cases, { holds = true, satisfied = ["done"] } = {}) {
  return cases.flatMap(c => [
    ...(c.a === "unstarted" || (!holds && c.a === "held") ? [c.ids[0]] : []),
    ...((c.b === "unstarted" || (!holds && c.b === "held")) && (!c.needs || satisfied.includes(c.a)) ? [c.ids[1]] : []),
  ]).sort();
}

test("R8-A5-05 ordered · flow: lead reconciles every state pair of a package and its dependant, bound 2 packages x 4 states x 2 holds x 2 edges · loss: stuck", t => {
  const f = mechanisms(t);
  const cases = [];
  for (const a of A_STATES) for (const b of B_STATES) for (const needs of [false, true]) {
    const tag = letters(cases.length, 2);
    cases.push({ a, b, needs, ids: [`q${tag}a`, `q${tag}b`] });
  }
  const correct = progressOracle(cases);
  for (const defect of [{ holds: false }, { satisfied: [] }, { satisfied: ["done", "started"] }])
    assert.notDeepEqual(progressOracle(cases, defect), correct, `the bound does not reach ${JSON.stringify(defect)}`);
  const hold = { hold: "an unrelated owner-only choice is open", release: "the owner's answer is committed" };
  const packages = cases.flatMap(c => [
    pkg(c.ids[0], c.a === "held" ? hold : {}),
    pkg(c.ids[1], { needs: c.needs ? [c.ids[0]] : [], ...(c.b === "held" ? hold : {}) }),
  ]);
  f.plan("PL-0001", shuffled(packages, 55));
  let second = 60;
  for (const c of cases) {
    if (c.a === "started") f.prepare(packages.find(p => p.id === c.ids[0]), at(second++));
    if (c.a === "done") {
      const item = packages.find(p => p.id === c.ids[0]);
      jsonOutput(f.record(item, f.prepare(item, at(second++)), { start: at(second), when: at(second++) }));
    }
  }
  const statuses = f.ready("PL-0001", { when: at(890) });
  for (const c of cases) {
    const want = { unstarted: "ready", started: "running", done: "done" }[c.a];
    if (want) assert.equal(statuses.get(c.ids[0]).status, want, json(statuses.get(c.ids[0])));
    if (c.b === "unstarted") assert.equal(statuses.get(c.ids[1]).status, c.needs && c.a !== "done" ? "waiting" : "ready", json(statuses.get(c.ids[1])));
  }
  flagged(f, cases.flatMap(c => c.ids), correct, { when: at(900) });
});

function due(text) {
  return /advancing (?:round|review) due(?!\s+at\b)/i.test(text);
}

test("R8-A5-06 ordered · flow: judge rulings, a repeated ruling, an unruled row, an advancing round and a lowered cadence arrive one by one, bound 7 events · loss: stuck", t => {
  const f = mechanisms(t, { cadence: 2 });
  const events = [
    [() => f.rows(judgeRow(2, { time: at(60) })), false],
    [() => f.rows(judgeRow(2, { time: at(120) })), false],
    [() => f.rows(judgeRow(3, { time: at(180), verdict: "-" })), false],
    [() => f.rows(judgeRow(3, { time: at(240) })), true],
    [() => { f.handoffs({ round: 4, step: "reviewer-frame", time: at(290) }, { round: 4, step: "judge-frame", time: at(295) }); f.rows(judgeRow(4, { time: at(298) })); }, false],
    [() => { const path = join(f.p.records, "loop.json"); put(f.p.records, "loop.json", json({ ...JSON.parse(readFileSync(path, "utf8")), cadence: { adversarial: 1 } })); }, false],
    [() => f.rows(judgeRow(5, { time: at(420) })), true],
  ];
  const seen = [due(f.next({ when: at(30) }))];
  events.forEach(([event], i) => {
    event();
    f.publish(`Event ${i + 1}`, at(60 * (i + 1) + 5));
    seen.push(due(f.next({ when: at(60 * (i + 1) + 10) })));
  });
  assert.deepEqual(seen, [false, ...events.map(([, expected]) => expected)]);
});

test("R8-A5-07 fresh · flow: lead gives the documents package the top-level glob [A-Z]*.md beside a package that owns SKILL.md · loss: stuck", async t => {
  const f = mechanisms(t);
  const docs = pkg("docs", { files: ["[A-Z]*.md"] }), code = pkg("code", { files: ["scripts/**"] }), skill = pkg("skill", { files: ["SKILL.md"] });
  const [alone, clash] = await inBatches([validateLater(f, "docs", [docs, code]), validateLater(f, "clash", [docs, skill])]);
  assert.equal(alone.status, 0, output(alone));
  assert.ok(clash.status > 0, output(clash));
  assert.match(output(clash), /overlap|share|conflict/i);
  assert.doesNotMatch(output(clash), /JSON/);
});
