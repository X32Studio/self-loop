import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { json, jsonl, jsonOutput, output, put, status } from "./fixture.mjs";
import { hostMeasurement, loopWorld, phase } from "./loop-world-fixture.mjs";
import { now, seed, seeded, shift } from "./scenario.mjs";

export const room = { cores: 20, load: 0.25, availableGB: 32 };
export const crowded = { cores: 20, load: 15, availableGB: 32 };
export const handoffsPath = "metrics/handoffs.jsonl";
export const trajectoryPath = "metrics/trajectory.jsonl";
export const wordsPath = "owner/words.jsonl";
export const marksPath = "owner/word-marks.jsonl";
export const pad = n => String(n).padStart(4, "0");
export const at = seconds => shift(now, seconds * 1000);
export const t3 = (provider, model) => ({ runner: "t3", provider, model, effort: "xhigh" });
export const wordId = n => "W-" + (0xb0000000 + n).toString(16).padStart(10, "0");

export function shuffled(items, salt) {
  const draw = seeded(seed + salt);
  return items.map(item => [draw(1_000_000), item]).sort(([a], [b]) => a - b).map(([, item]) => item);
}

export function pkg(id, { role = "actor", round = 9, authority = "D-0031", files, needs = [], hold, release, step, goal, contract, feature, acceptance } = {}) {
  const name = step ?? `${role}-${id}`;
  return {
    id, authority, goal: goal ?? `Deliver ${id}`,
    files: files ?? (role === "judge" ? [] : [`src/${id}/**`]),
    interface: contract ?? "Use the recorded command lines", needs, role,
    acceptance: acceptance ?? `Run the ${id} acceptance cases`,
    handoff: `R-${pad(round)}-${name}`,
    ...(feature !== undefined ? { feature } : {}),
    ...(hold !== undefined ? { hold } : {}),
    ...(release !== undefined ? { release } : {}),
  };
}

export function dispatchPkg(id, { round = 8, step = id, authority = "D-0030", files = [], needs = [],
  goal = `Deliver ${id}`, contract = "Use the recorded D1–D3 command lines", feature = "F-0011" } = {}) {
  return {
    id, authority, goal, files, interface: contract, needs, role: step.split("-")[0],
    acceptance: `Run the acceptance cases for ${id}`,
    handoff: `R-${pad(round)}-${step}`, feature,
  };
}

export function planText(id, packages, { scope = "v1/round-9", phaseName = "v1", supersedes } = {}) {
  const head = [`# ${id} Planning and dispatch`, "", `scope: ${scope}`, `phase: ${phaseName}`];
  if (supersedes) head.push(`supersedes: ${supersedes}`);
  return [...head, ...packages.flatMap(({ feature, ...p }) => ["", `## ${p.id}`, "",
    ...Object.entries(p).filter(([key, value]) => key !== "id" && value != null)
      .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(", ") : value}`)]), ""].join("\n");
}

const taskText = p => [p.goal, `features: ${p.feature ?? "F-0012"}`, `Files: ${p.files.join(", ")}`, `Interface: ${p.interface}`, `Acceptance: ${p.acceptance}`, ""].join("\n");

export function ownerWord(id, time, text) {
  return { id, time, text, source: "codex", session: "fixture-owner", ordinal: 1 };
}

export function interventionText(id, words, { rung, carried, raised, extra = [] } = {}) {
  return [`# ${id}`, "", "Time: 2026-11-22, Asia/Dubai", `words: ${words.join(", ")}`,
    ...(raised !== undefined ? [`raised-first: ${raised}`] : []),
    ...(rung !== undefined ? [`rung: ${rung}`] : []), ...(carried !== undefined ? [`carried-by: ${carried}`] : []), "",
    "Frame: the lead kept hardening after the cadence called for an advancing round.",
    "Reframe: an advancing round follows each group of adversarial rounds.",
    ...extra,
    "General question: which recorded cadence is due, and what does the driver offer for it?", ""].join("\n");
}

export function judgeRow(round, { verdict = "CONTINUE", area = "-", time = now, ...fields } = {}) {
  return { time, round, phase: "v1", area, role: "judge", model: "-", verdict, opened: "-", closed: "-", suite: "12/0", owner: "0", commit: "-", ci: "-", ...fields };
}

export function mechanisms(t, { cadence, agents, owns } = {}) {
  const w = loopWorld(t);
  const p = phase(w, "mechanisms", { agents: agents ?? {
    actor: t3("claude", "claude-opus-4-6"), critic: t3("codex", "gpt-5.4"), judge: t3("codex", "gpt-5.4") } });
  w.register([p]);
  const config = JSON.parse(readFileSync(p.config, "utf8"));
  config.owns = owns ?? { actor: ["src", "scripts", "docs", "SKILL.md", "RECORDS.md"], critic: ["acceptance"] };
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
    goal: "v1 plan world fixture", invariants: ["acceptance passes"], openedAt: at(0), openedBy: "lead",
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
  const planByHandoff = new Map();
  const plan = (id, packages, { when = at(20), tasks = packages, ...options } = {}) => {
    for (const item of packages) planByHandoff.set(item.handoff, { planId: id, pkgId: item.id });
    for (const item of tasks) put(p.workDir, `tasks/${item.handoff}.md`, taskText(item));
    put(p.records, `plans/${id}.md`, planText(id, packages, options));
    return publish(`Publish ${id}`, when);
  };
  const prepare = (item, when = at(30)) => {
    const [, round, step] = /^R-(\d+)-(.+)$/.exec(item.handoff);
    let entry = planByHandoff.get(item.handoff);
    if (!entry) {
      plan("PL-0099", [item], { when });
      entry = planByHandoff.get(item.handoff);
    }
    const task = put(p.workDir, `tasks/${item.handoff}.md`, taskText(item));
    return jsonOutput(w.run("call.mjs", [p.config, item.role, "--round", String(Number(round)), "--step", step,
      "--plan", entry.planId, "--package", entry.pkgId, "--task", task, "--prepare"], { at: when }));
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
  const measure = (id, when = at(600)) =>
    jsonOutput(w.run("plan.mjs", ["measure", "--records", p.records, "--plan", id, "--json"], { at: when, cwd: p.records }));
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
  const metricsText = (when = at(900)) => status(w.run("owner-words.mjs", ["metrics", "--records", p.records], { at: when }), 0);
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
  return { w, p, publish, plan, prepare, record, next, start, tick, ready, measure, rows, handoffs, metrics, metricsText, sendBatch, answer };
}

export function dispatchWorld(t) {
  const w = loopWorld(t);
  const codex = t3("codex", "gpt-5.4");
  const claude = t3("claude", "claude-opus-4-6");
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
    put(p.records, `decisions/${id}.md`, `# ${id} ${title}\n\nid: ${id}\nby: owner\nstatus: active\n`);
  }
  for (const [id, title] of Object.entries({
    "F-0011": "Generative engine", "F-0012": "Planning and dispatch",
  })) {
    put(p.records, `blueprint/${id}.md`, `# ${id} ${title}\n\nid: ${id}\nphase: v1\nrequirements: P-0001\n`);
  }
  put(p.records, "metrics/windows.jsonl", jsonl({
    type: "open", id: "W-0001", phase: "v1", startRound: 1, horizon: 12,
    goal: "v1 dispatch world fixture", invariants: ["acceptance passes"], openedAt: shift(now, -60_000), openedBy: "lead",
  }));
  function checkAndCommit(message, atWhen = now) {
    w.git(p.records, "add", "-A");
    status(w.run("records-check.mjs", ["--repo", p.records, "--write"], { at: atWhen }), 0);
    return w.commit(p.records, message, atWhen);
  }
  checkAndCommit("Record authorized dispatch inputs", shift(now, -60_000));
  let lastPlanId = null;
  const plan = (packages, { id = "PL-0001", at: atWhen = now, commit = true, ...options } = {}) => {
    if (commit) lastPlanId = id;
    for (const item of packages) put(p.workDir, `tasks/${item.handoff}.md`, taskText(item));
    const file = put(p.records, `plans/${id}.md`, planText(id, packages, { scope: `v1/round-${options.round ?? 8}`, ...options }));
    if (commit) checkAndCommit(`Publish ${id}`, atWhen);
    return { id, file };
  };
  const runPlan = (args, opts = {}) => w.run("plan.mjs", args, { cwd: p.records, ...opts });
  const validate = packages => runPlan(["validate", plan(packages, { commit: false }).file]);
  const ready = ({ id = "PL-0001", host = room, at: atWhen = now } = {}) => {
    const data = jsonOutput(runPlan(["ready", "--records", p.records, "--plan", id, "--json"], {
      at: atWhen, extraEnv: hostMeasurement(w, host),
    }));
    const packages = Array.isArray(data) ? data : data.packages;
    assert.ok(packages && typeof packages === "object", json(data));
    return new Map(Array.isArray(packages) ? packages.map(row => [row.id, row]) : Object.entries(packages));
  };
  const prepare = (item, { at: atWhen = now, row = null, planId = lastPlanId } = {}) => {
    if (row) {
      const command = row.command ?? row.prepare;
      const args = Array.isArray(command) ? command.join(" ") : command;
      assert.equal(typeof args, "string", json(row));
      assert.match(args, /\bcall\.mjs\b.*(?:^|\s)--prepare(?:\s|$)/);
      assert.ok(args.includes(p.config), args);
      const extra = planId && !args.includes("--plan") ? ` --plan ${planId} --package ${item.id}` : "";
      const options = { cwd: p.records, at: atWhen, extraEnv: w.extraEnv };
      const result = Array.isArray(command)
        ? w.runSuggested([...command, ...(planId && !command.includes("--plan") ? ["--plan", planId, "--package", item.id] : [])].map(arg => "'" + arg.replaceAll("'", "'\\''") + "'").join(" "), options)
        : w.runSuggested(command + extra, options);
      const prepared = jsonOutput(result);
      assert.equal(prepared.id, item.handoff);
      return prepared;
    }
    const [, round, step] = /^R-(\d+)-(.+)$/.exec(item.handoff);
    const task = put(p.workDir, `tasks/${item.handoff}.md`, taskText(item));
    const planArgs = planId && !/^judge-frame(?:-[a-z]+)*$/.test(step) ? ["--plan", planId, "--package", item.id] : [];
    return jsonOutput(w.run("call.mjs", [p.config, item.role, "--round", String(Number(round)), "--step", step,
      ...planArgs, "--task", task, "--prepare"], { at: atWhen }));
  };
  function record(item, prepared, { start = now, end = start, at: atWhen = end, terminal = "complete", publicReport = null } = {}) {
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
    return w.run("call.mjs", [p.config, "record", "--ws", ws, "--session", session, "--transcript", transcript], { at: atWhen });
  }
  const frameItem = dispatchPkg("judge-frame-dispatch");
  jsonOutput(record(frameItem, prepare(frameItem, { at: shift(now, -45_000) }), {
    start: shift(now, -44_000), end: shift(now, -40_000), publicReport: "VERDICT: AMEND\n\nAdmit F-0012's planning and dispatch design.\n",
  }));
  function sendBatch(atWhen) {
    const file = put(w.dir, "questions.json", json({ questions: [{
      question: "Ship the dispatch plan in v1?", options: ["Ship in v1", "Move to v2"], recommendation: "Ship in v1",
    }] }));
    status(w.run("decisions.mjs", ["send", "--records", p.records, "--file", file,
      "--phase", "v1", "--from", "R-0001-reviewer-frame"], { at: atWhen }), 0);
    checkAndCommit("Send owner batch", atWhen);
    return "B-0001";
  }
  const answer = atWhen => jsonOutput(w.run("decisions.mjs", ["answer", "--records", p.records, "--batch", "B-0001",
    "--words", "Ship in v1"], { at: atWhen }));
  return { w, p, plan, validate, runPlan, ready, prepare, record, sendBatch, answer, checkAndCommit };
}

export function itemsOf(text) {
  const items = [];
  let current = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("- ")) items.push(current = { title: line, lines: [line] });
    else if (current && line.startsWith("  ")) current.lines.push(line);
    else current = null;
  }
  return items;
}

export const mentions = (body, ids) => ids.filter(id => new RegExp(`(?<![\\w-])${id}(?![\\w-])`).test(body));

export function idleInNext(text, ids) {
  const items = itemsOf(text).filter(item => /\b(start|hold|idle|unstarted|dispatch)/i.test(item.title) && !/prepared workspace/i.test(item.title));
  return mentions(items.map(item => item.lines.join("\n")).join("\n"), ids).sort();
}

export function headerOf(text) {
  const lines = text.split("\n");
  const first = lines.findIndex(line => line.startsWith("- "));
  return lines.slice(0, first < 0 ? lines.length : first).join("\n");
}

export function offered(text, item) {
  const step = item.handoff.replace(/^R-\d{4}-/, "");
  return text.split("\n").some(line => /\bcall\.mjs\b/.test(line) && new RegExp(`--step ${step}(?:\\s|$)`).test(line));
}

export function refusal(result, diagnostic) {
  assert.ok(Number.isInteger(result.status) && result.status > 0, output(result));
  assert.doesNotMatch(output(result), /MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND|SyntaxError/);
  if (diagnostic) assert.match(output(result), diagnostic);
}
