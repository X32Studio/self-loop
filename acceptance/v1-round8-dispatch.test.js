import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { json, jsonl, jsonOutput, output, put, status } from "./fixture.mjs";
import { handoffs, phase, round6B } from "./round6-b-fixture.mjs";
import { hostMeasurement } from "./round7-b-fixture.mjs";
import { now, seed, seeded, shift } from "./scenario.mjs";

const actorFiles = {
  a: ["scripts/owner-words.mjs", "scripts/lib/owner-words.mjs", "scripts/lib/owner-metrics.mjs", "scripts/records-check.mjs"],
  b: ["scripts/decisions.mjs"],
  c: ["scripts/loop.mjs", "scripts/lib/cadence.mjs"],
  d: ["scripts/plan.mjs", "scripts/lib/plan.mjs", "SKILL.md", "RECORDS.md"],
};
const directions = { a: "D-0030", b: "D-0031", c: "D-0032", d: "R-0008-judge-frame-dispatch" };
const room = { cores: 20, load: 0.25, availableGB: 32 };
const roundSevenPaths = {
  "actor-a": ["scripts/lib/ci.mjs", "scripts/lib/check-runs.mjs", "scripts/lib/ci-receipt.mjs",
    "scripts/suite-green.mjs", "scripts/version-gate.mjs", "scripts/gated-push.mjs", "scripts/ci-green.mjs",
    "scripts/lib/version.mjs", ".githooks/*"],
  "actor-b": ["scripts/lib/comments.mjs", "scripts/loop.mjs", "scripts/self-loop.mjs", "scripts/call.mjs",
    "scripts/lib/registry.mjs", "scripts/lib/thresholds.mjs", "scripts/lib/start.mjs"],
  "actor-c": ["scripts/trajectory.mjs", "RECORDS.md", "assets/brief-judge.md", "DEBT.md"],
  "critic-a": ["acceptance/r7-a.test.mjs"],
  "critic-b": ["acceptance/round7-b-*.test.mjs"],
  "critic-c": ["acceptance/round7-c-trajectory.test.mjs"],
};
const launchClocks = {
  "actor-a": 0, "critic-b": 2_200, "critic-c": 10_400,
  "actor-c": 20_400, "critic-a": 20_800, "actor-b": 23_100,
};

function pkg(id, { round = 8, step = id, authority = "D-0030", files = [], needs = [],
  goal = `Deliver ${id}`, contract = "Use the recorded D1–D3 command lines", feature = "F-0011" } = {}) {
  return {
    id, authority, goal, files, interface: contract, needs, role: step.split("-")[0],
    acceptance: `Run the acceptance cases for ${id}`,
    handoff: `R-${String(round).padStart(4, "0")}-${step}`, feature,
  };
}

function planRecord(id, packages, { supersedes, round = 8 } = {}) {
  const header = [`# ${id} Planning and dispatch`, "", `scope: v1/round-${round}`, "phase: v1", `round: ${round}`];
  if (supersedes) header.push(`supersedes: ${supersedes}`);
  return [...header, ...packages.flatMap(({ feature, ...p }) => [
    "", `## ${p.id}`, "",
    ...Object.entries(p).filter(([key, value]) => key !== "id" && value != null)
      .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(", ") : value}`),
  ]), ""].join("\n");
}

function taskText(p) {
  return [p.goal, `features: ${p.feature}`, `Files: ${p.files.join(", ")}`,
    `Interface: ${p.interface}`, `Acceptance: ${p.acceptance}`, ""].join("\n");
}

function fixture(t) {
  const w = round6B(t);
  const codex = { runner: "t3", provider: "codex", model: "gpt-6.2-sol", effort: "xhigh" };
  const claude = { runner: "t3", provider: "claude", model: "claude-opus-5-5", effort: "xhigh" };
  const p = phase(w, "dispatch", { agents: { actor: claude, critic: codex, judge: codex }, files: {
    "scripts/lib/plan.mjs": "export const contract = 1;\n",
    "scripts/plan.mjs": "export const cli = 1;\n",
  } });
  w.register([p]);
  const config = JSON.parse(readFileSync(p.config, "utf8"));
  put(p.records, "records.json", json({
    extraKinds: [{ kind: "Plan", path: "plans/PL-NNNN.md", changes: "immutable", citedAs: "PL-NNNN" }],
  }));
  config.owns = { actor: ["scripts", "RECORDS.md", "SKILL.md"], critic: ["acceptance"] };
  put(p.records, "loop.json", json(config));
  for (const [id, title] of Object.entries({
    "D-0028": "Run the round-seven packages in parallel", "D-0030": "Build the generative engine now",
    "D-0031": "Grill by one dependency-ordered owner batch", "D-0032": "Continue settled work through cadence",
  })) {
    put(p.records, `decisions/${id}.md`, `# ${id} ${title}\n\nstatus: active\n`);
  }
  for (const [id, title] of Object.entries({
    "F-0011": "Generative engine", "F-0012": "Planning and dispatch",
  })) {
    put(p.records, `blueprint/${id}.md`, `# ${id} ${title}\n\nid: ${id}\nphase: v1\nrequirements: P-0001\n`);
  }
  function checkAndCommit(message, at = now) {
    w.git(p.records, "add", "-A");
    status(w.run("records-check.mjs", ["--repo", p.records, "--write"], { at }), 0);
    return w.commit(p.records, message, at);
  }
  checkAndCommit("Record authorized dispatch inputs", shift(now, -60_000));
  const plan = (packages, { id = "PL-0001", at = now, commit = true, ...options } = {}) => {
    for (const item of packages) put(p.workDir, `tasks/${item.handoff}.md`, taskText(item));
    const file = put(p.records, `plans/${id}.md`, planRecord(id, packages, options));
    if (commit) checkAndCommit(`Publish ${id}`, at);
    return { id, file };
  };
  const runPlan = (args, opts = {}) => w.run("plan.mjs", args, { cwd: p.records, ...opts });
  const validate = packages => runPlan(["validate", plan(packages, { commit: false }).file]);
  const ready = ({ id = "PL-0001", host = room, at = now } = {}) => {
    const data = jsonOutput(runPlan(["ready", "--records", p.records, "--plan", id, "--json"], {
      at, extraEnv: hostMeasurement(w, host),
    }));
    const packages = Array.isArray(data) ? data : data.packages;
    assert.ok(packages && typeof packages === "object", json(data));
    return new Map(Array.isArray(packages) ? packages.map(row => [row.id, row]) : Object.entries(packages));
  };
  const prepare = (item, { at = now, row = null } = {}) => {
    if (row) {
      const command = row.command ?? row.prepare;
      const args = Array.isArray(command) ? command.join(" ") : command;
      assert.equal(typeof args, "string", json(row));
      assert.match(args, /\bcall\.mjs\b.*(?:^|\s)--prepare(?:\s|$)/);
      assert.ok(args.includes(p.config), args);
      const options = { cwd: p.records, at, extraEnv: w.extraEnv };
      const result = Array.isArray(command) ? w.runSuggested(command.map(arg => "'" + arg.replaceAll("'", "'\\''") + "'").join(" "), options)
        : w.runSuggested(command, options);
      const prepared = jsonOutput(result);
      assert.equal(prepared.id, item.handoff);
      return prepared;
    }
    const [, round, step] = /^R-(\d+)-(.+)$/.exec(item.handoff);
    const task = put(p.workDir, `tasks/${item.handoff}.md`, taskText(item));
    return jsonOutput(w.run("call.mjs", [p.config, item.role, "--round", String(Number(round)), "--step", step,
      "--task", task, "--prepare"], { at }));
  };
  function record(item, prepared, { start = now, end = start, at = end, terminal = "complete", publicReport = null } = {}) {
    const { ws, wt, id, prompt } = prepared;
    put(ws, "out/report.md", "This role delivered the requested work.\n");
    if (publicReport) put(ws, "out/public.md", publicReport);
    const session = `${id}-${prepared.nonce}`;
    const rows = item.role === "actor" ? [
      { timestamp: start, type: "user", sessionId: session, cwd: wt, message: { content: prompt } },
      ...(terminal === "pending" ? [] : [{ timestamp: end, type: "result", subtype: terminal === "complete" ? "success" : "error" }]),
    ] : [
      { timestamp: start, type: "session_meta", payload: { cwd: wt, id: session } },
      { timestamp: start, type: "event_msg", payload: { type: "user_message", message: prompt } },
      ...(terminal === "pending" ? [] : [{ timestamp: end, type: "event_msg",
        payload: { type: terminal === "complete" ? "task_complete" : "task_failed" } }]),
    ];
    const transcript = put(w.dir, `${session}.jsonl`, jsonl(...rows));
    return w.run("call.mjs", [p.config, "record", "--ws", ws, "--session", session, "--transcript", transcript], { at });
  }
  jsonOutput(record(pkg("judge-frame-dispatch"), prepare(pkg("judge-frame-dispatch"), { at: shift(now, -45_000) }), {
    start: shift(now, -44_000), end: shift(now, -40_000), publicReport: "VERDICT: AMEND\n\nAdmit F-0012's planning and dispatch design.\n",
  }));
  function sendBatch(at) {
    const file = put(w.dir, "questions.json", json({ questions: [{
      question: "Ship the dispatch plan in v1?", options: ["Ship in v1", "Move to v2"], recommendation: "Ship in v1",
    }] }));
    status(w.run("decisions.mjs", ["send", "--records", p.records, "--file", file,
      "--phase", "v1", "--from", "R-0001-reviewer-frame"], { at }), 0);
    checkAndCommit("Send owner batch", at);
    return "B-0001";
  }
  const answer = at => jsonOutput(w.run("decisions.mjs", ["answer", "--records", p.records, "--batch", "B-0001",
    "--words", "Ship in v1"], { at }));
  return { w, p, plan, validate, runPlan, ready, prepare, record, sendBatch, answer, checkAndCommit };
}

function refusal(result, diagnostic) {
  assert.ok(Number.isInteger(result.status) && result.status > 0, output(result));
  assert.doesNotMatch(output(result), /MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND|SyntaxError/);
  assert.match(output(result), diagnostic);
}

function states(rows, expected) {
  assert.deepEqual(Object.fromEntries([...rows].map(([key, row]) => [key, row.status ?? row.state])), expected);
}

function waits(row, dependency) {
  assert.match(json(row), dependency);
  const hold = row.waiting ?? row.hold ?? row.holds ?? row.reason ?? row.waitsFor;
  const release = row.release ?? row.releases ?? row.releasedBy ?? row.unblocksWhen ?? row.until;
  assert.ok(hold || release, json(row));
  assert.ok(release || /release|unblock|until|when|after/i.test(json(hold)), json(row));
  assert.ok(!(row.command ?? row.prepare), json(row));
}

function tree(root) {
  const entries = {};
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const key = relative(root, path);
      if (entry.isSymbolicLink()) entries[key] = "link " + readlinkSync(path);
      else if (entry.isDirectory()) {
        entries[key] = "dir";
        walk(path);
      } else entries[key] = "file " + createHash("sha256").update(readFileSync(path)).digest("hex");
    }
  };
  if (existsSync(root)) walk(root);
  return entries;
}

function untouched(x) {
  return {
    work: tree(x.p.workDir),
    head: x.w.git(x.p.records, "rev-parse", "HEAD"),
    status: x.w.git(x.p.records, "status", "--porcelain=v1", "--untracked-files=all", "--ignored"),
    worktrees: x.w.git(x.p.product, "worktree", "list", "--porcelain"),
  };
}

function shuffled(items, salt) {
  const draw = seeded(seed + salt);
  return items.map(item => [draw(1_000_000), item]).sort(([a], [b]) => a - b).map(([, item]) => item);
}

test("R8-D1-01 ordered · flow: lead plans actor D and a read-only judge follow-up from settled direction · loss: false-verdict", t => {
  const w = fixture(t);
  const judge = pkg("judge-plan", { files: [], authority: "D-0030" });
  const actor = pkg("actor-d", { files: actorFiles.d, authority: directions.d });
  status(w.validate([actor, judge]), 0);
  refusal(w.validate([{ ...actor, authority: null }, judge]), /authority/i);
});

test("R8-D1-02 ordered · flow: lead carves two packages whose file globs include the same planner path · loss: wrong-result", t => {
  const w = fixture(t);
  const actor = pkg("actor-d", { files: ["scripts/lib/**/plan*.mjs"], authority: directions.d });
  const disjoint = pkg("actor-c", { files: ["scripts/lib/**/cadence*.mjs", "scripts/plan.mjs"], authority: directions.c });
  status(w.validate([actor, disjoint]), 0);
  for (const path of ["scripts/lib/plan.mjs", "scripts/lib/future/planning-*.mjs"]) {
    refusal(w.validate([actor, { ...disjoint, files: [...disjoint.files, path] }]), /overlap|conflict|share|both/i);
  }
});

test("R8-D1-03 fresh · flow: lead links a long join chain in shuffled package order then accidentally routes its root through the join · loss: stuck", t => {
  const w = fixture(t);
  const steps = Array.from({ length: 28 + seeded(seed)(17) }, (_, i) => `judge-chain-${String.fromCharCode(97 + Math.floor(i / 26))}${String.fromCharCode(97 + i % 26)}`);
  const packages = steps.map((id, i) => pkg(id, { needs: i ? [steps[i - 1]] : [] }));
  const join = pkg("judge-integration", { needs: [steps.at(-1), steps[0], "D-0030"] });
  status(w.validate(shuffled([join, ...packages], 101)), 0);
  packages[0].needs.push(join.id);
  refusal(w.validate(shuffled([join, ...packages], 101)), /cycle|circular/i);
});

test("R8-D1-04 fresh · flow: lead validates a plan referencing an authority still staged, then publishes the decision · loss: false-verdict", t => {
  const x = fixture(t);
  const actor = pkg("actor-b", { authority: "D-0099", needs: ["D-0031"], files: actorFiles.b });
  const decision = "decisions/D-0099.md";
  put(x.p.records, decision, "# D-0099 Settle the delegated owner decisions work\n\nstatus: active\n");
  x.w.git(x.p.records, "add", "--", decision);
  refusal(x.validate([actor]), /D-0099/);
  x.checkAndCommit("Publish owner decision D-0099");
  status(x.validate([actor]), 0);
  refusal(x.validate([{ ...actor, needs: ["D-0098"] }]), /D-0098/);
});

test("R8-D2-01 ordered · flow: lead runs the normal prepare commands for a round-seven six-call wave under measured headroom · loss: false-verdict", t => {
  const x = fixture(t);
  const wave = shuffled(Object.keys(launchClocks).map(id => pkg(id, {
    round: 7, authority: "D-0028",
    files: roundSevenPaths[id],
  })), 702);
  x.plan(wave, { round: 7 });
  const before = untouched(x);
  const ready = x.ready();
  states(ready, Object.fromEntries(wave.map(p => [p.id, "ready"])));
  assert.deepEqual(untouched(x), before, "ready started preparing calls itself");
  for (const item of wave) {
    x.prepare(item, { row: ready.get(item.id), at: shift(now, launchClocks[item.id]) });
  }
  states(x.ready({ at: shift(now, 30_000) }), Object.fromEntries(wave.map(p => [p.id, "running"])));
});

test("R8-D2-02 ordered · flow: lead checks dispatch across the load and memory boundary while the same package remains authorized · loss: false-verdict", t => {
  const x = fixture(t);
  const actor = pkg("actor-d", { authority: directions.d, files: actorFiles.d });
  x.plan([actor]);
  for (const [host, evidence] of [
    [{ ...room, load: 14.01 }, /load|capacity/i],
    [{ ...room, load: 14, availableGB: 15.75 }, /memory|capacity/i],
  ]) {
    const rows = x.ready({ host });
    states(rows, { "actor-d": "waiting" });
    waits(rows.get(actor.id), evidence);
  }
  states(x.ready({ host: { ...room, load: 14, availableGB: 16 } }), { "actor-d": "ready" });
});

test("R8-D2-03 ordered · flow: lead reconciles settled round-eight actors, a pending frame ruling, and deferred hardening · loss: false-verdict", t => {
  const x = fixture(t);
  const judge = pkg("judge-frame");
  const hardeningReview = pkg("judge-hardening", { needs: [judge.id] });
  const hardening = pkg("critic-hardening", { files: ["acceptance/round-close.test.mjs"], needs: [hardeningReview.id] });
  const actors = Object.keys(actorFiles).map(key => pkg(`actor-${key}`, { authority: directions[key], files: actorFiles[key] }));
  const critic = pkg("critic-d", { authority: directions.d, files: ["acceptance/v1-round8-dispatch.test.js"], feature: "F-0012" });
  const newInterface = pkg("actor-derived", { files: ["scripts/facts.mjs"], needs: [judge.id] });
  x.plan(shuffled([...actors, judge, hardeningReview, critic, newInterface, hardening], 8));
  const base = Object.fromEntries([...actors, critic].map(p => [p.id, "ready"]));
  const before = x.ready();
  states(before, { ...base, [judge.id]: "ready", [hardeningReview.id]: "waiting",
    [hardening.id]: "waiting", [newInterface.id]: "waiting" });
  waits(before.get(newInterface.id), /judge-frame/i);
  waits(before.get(hardening.id), /judge-hardening/i);
  const prepared = x.prepare(judge, { row: before.get(judge.id) });
  states(x.ready(), { ...base, [judge.id]: "running", [hardeningReview.id]: "waiting",
    [hardening.id]: "waiting", [newInterface.id]: "waiting" });
  jsonOutput(x.record(judge, prepared, { publicReport: "VERDICT: AMEND\n\nAdmit the derived interface. Round-close hardening remains deferred.\n" }));
  states(x.ready(), { ...base, [judge.id]: "done", [hardeningReview.id]: "ready",
    [hardening.id]: "waiting", [newInterface.id]: "ready" });
});

test("R8-D2-04 fresh · flow: lead restarts after a live preparation and a failed child, then records a successful retry · loss: stuck", t => {
  const x = fixture(t);
  const actor = pkg("actor-a", { files: actorFiles.a });
  const judge = pkg("judge-integration", { needs: [actor.id] });
  x.plan([actor, judge]);
  const initial = x.ready();
  const first = x.prepare(actor, { row: initial.get(actor.id) });
  const active = { [actor.id]: "running", [judge.id]: "waiting" };
  states(x.ready(), active);
  refusal(x.record(actor, first, { terminal: "pending" }), /no terminal event/i);
  states(x.ready(), active);
  const lost = x.record(actor, first, { terminal: "failed" });
  refusal(lost, /exited|failed/i);
  assert.ok(!x.w.git(x.p.records, "show", `HEAD:${handoffs}`).includes(actor.handoff), "a failed attempt became a completed hand-off");
  const retry = x.ready();
  states(retry, { [actor.id]: "ready", [judge.id]: "waiting" });
  const second = x.prepare(actor, { row: retry.get(actor.id) });
  assert.notEqual(first.ws, second.ws);
  jsonOutput(x.record(actor, second));
  states(x.ready(), { [actor.id]: "done", [judge.id]: "ready" });
});

test("R8-D2-05 ordered · flow: lead revises the derived interface after recording two independent actors · loss: wrong-result", t => {
  const x = fixture(t);
  const actor = pkg("actor-a", { files: actorFiles.a });
  const peer = pkg("actor-b", { authority: directions.b, files: actorFiles.b });
  const judge = pkg("judge-integration", { needs: [actor.id, peer.id] });
  x.plan([actor, peer, judge]);
  for (const item of [actor, peer]) jsonOutput(x.record(item, x.prepare(item)));
  states(x.ready(), { [actor.id]: "done", [peer.id]: "done", [judge.id]: "ready" });
  const redo = pkg(actor.id, { files: actor.files, step: "actor-aa", goal: "Rebuild the count",
    contract: "Count accepted directions rather than all captured messages" });
  x.plan([redo, peer, judge], { id: "PL-0002", supersedes: "PL-0001" });
  const revised = x.ready({ id: "PL-0002" });
  states(revised, { [actor.id]: "ready", [peer.id]: "done", [judge.id]: "waiting" });
  const prepared = x.prepare(redo, { row: revised.get(actor.id) });
  assert.match(readFileSync(join(prepared.ws, "task.md"), "utf8"), /Count accepted directions/);
  jsonOutput(x.record(redo, prepared));
  states(x.ready({ id: "PL-0002" }), { [actor.id]: "done", [peer.id]: "done", [judge.id]: "ready" });
});

test("R8-D2-06 fresh · flow: a lead receives an owner answer while requesting dispatch before and after committing it · loss: false-verdict", t => {
  const x = fixture(t);
  const batch = x.sendBatch(shift(now, -10_000));
  const review = pkg("actor-b", { authority: directions.b, files: actorFiles.b, needs: [batch] });
  const independent = pkg("actor-c", { authority: directions.c, files: actorFiles.c });
  x.plan([review, independent]);
  x.answer(shift(now, 1_000));
  x.w.git(x.p.records, "add", "owner/answers.jsonl");
  const before = x.ready({ at: shift(now, 2_000) });
  states(before, { [review.id]: "waiting", [independent.id]: "ready" });
  waits(before.get(review.id), /B-0001/);
  x.checkAndCommit("Record the delivered owner answer", shift(now, 3_000));
  states(x.ready({ at: shift(now, 4_000) }), { [review.id]: "ready", [independent.id]: "ready" });
});

test("R8-D2-07 fresh · flow: a lead replans a file already owned by an in-flight actor while unrelated work can start · loss: wrong-result", t => {
  const x = fixture(t);
  const old = pkg("actor-d", { authority: directions.d, files: actorFiles.d });
  const independent = pkg("actor-c", { authority: directions.c, files: actorFiles.c });
  x.plan([old, independent]);
  const active = x.prepare(old, { row: x.ready().get(old.id) });
  const next = pkg(old.id, { authority: directions.d, step: "actor-dd", files: old.files, contract: "Keep a revision's plan records immutable" });
  x.plan([next, independent], { id: "PL-0002", supersedes: "PL-0001" });
  const held = x.ready({ id: "PL-0002" });
  states(held, { [next.id]: "waiting", [independent.id]: "ready" });
  waits(held.get(next.id), /actor-d|plan\.mjs/);
  jsonOutput(x.record(old, active));
  states(x.ready({ id: "PL-0002" }), { [next.id]: "ready", [independent.id]: "ready" });
});

function measureLine(report, label) {
  const line = report.split("\n").find(line => label.test(line));
  assert.ok(line, report);
  return line;
}

test("R8-D3-01 ordered · flow: lead measures a completed timed fork and join with a delayed hand-off and an overlapping owner wait · loss: wrong-result", t => {
  const x = fixture(t);
  const at = seconds => shift(now, seconds * 1_000);
  const batch = x.sendBatch(at(5));
  const actor = pkg("actor-a", { files: actorFiles.a });
  const peer = pkg("actor-b", { files: actorFiles.b });
  const judge = pkg("judge-integration", { needs: [actor.id, peer.id, batch] });
  x.plan([actor, peer, judge], { at: at(10) });
  const a = x.prepare(actor, { at: at(10) });
  const b = x.prepare(peer, { at: at(10) });
  x.answer(at(28));
  x.checkAndCommit("Record the timed owner answer", at(29));
  for (const [item, prepared, start, end, recorded] of [[actor, a, 13, 43, 96], [peer, b, 14, 64, 100]]) {
    jsonOutput(x.record(item, prepared, { start: at(start), end: at(end), at: at(recorded) }));
  }
  const j = x.prepare(judge, { at: at(101) });
  jsonOutput(x.record(judge, j, { start: at(102), end: at(119), at: at(122),
    publicReport: "VERDICT: CONVERGED\n\nACCEPTANCE: pass\n" }));
  const report = status(x.runPlan(["measure", "--records", x.p.records, "--plan", "PL-0001"], { at: at(130) }), 0);
  assert.match(measureLine(report, /critical[- ]path/i), /\b67(?:\.0+)?\s*(?:s\b|sec|$)|\b67000\s*ms|\b0?0:01:07\b|\b1\s*m\s+7\s*s\b/i);
  assert.match(measureLine(report, /owner wait/i), /\b23(?:\.0+)?\s*(?:s\b|sec|$)|\b23000\s*ms|\b0?0:00:23\b/i);
  assert.match(measureLine(report, /idle dispatchable|dispatchable.*idle|runnable.*unstarted/i), /unknown|unavailable|missing|unverified/i);
});
