import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { json, jsonl, jsonOutput, output, put, status, world } from "./fixture.mjs";
import { now, seed, seeded } from "./scenario.mjs";

export const handoffs = "metrics/handoffs.jsonl";
export const trajectory = "metrics/trajectory.jsonl";
export const integration = "loop/v1";
export const greenCheck = { id: 1, app: "github-actions", name: "verify", status: "completed", conclusion: "success" };

export function round6B(t) {
  const w = world(t);
  const load = join(w.dir, "host-load");
  const extraEnv = { SELF_LOOP_LOAD_DIR: load };
  const run = (entry, args, opts = {}) => w.run(args, { entry, ...opts, extraEnv: { ...extraEnv, ...opts.extraEnv } });
  return { ...w, load, extraEnv, run };
}

export function phase(w, name = "work", { files = {}, agents = {} } = {}) {
  const product = w.repo(join(w.projects, name), { VERSION: "1.0.0\n", ...files });
  w.git(product, "branch", integration);
  w.git(product, "remote", "add", "origin", "https://github.com/example/fixture.git");
  const records = join(w.projects, name + "-records");
  const workDir = join(w.dir, "roles", name);
  const config = join(records, "loop.json");
  const initial = w.git(product, "rev-parse", integration);
  const roles = ["reviewer", "critic", "actor", "judge"];
  const t3 = { runner: "t3", provider: "codex", model: "fixture-codex" };
  w.repo(records, {
    "records.json": "{}\n",
    "loop.json": json({
      product, records, workDir, phase: "v1", branch: integration, protected: ["main"],
      owns: { critic: ["acceptance"], actor: ["src", ".githooks"] },
      briefs: Object.fromEntries(roles.map(role => [role, `engines/${role}.md`])),
      agents: { reviewer: { runner: "claude" }, critic: t3, actor: t3, judge: { ...t3, provider: "claude" }, ...agents },
      gates: { suite: "node --test", require: ["github-actions/verify"] },
    }),
    "purpose/P-0001.md": "# P-0001 Build the phase\n\nstatus: active\n",
    "blueprint/F-0003.md": "# F-0003 Deliver the feature\n\nid: F-0003\nphase: v1\nrequirements: P-0001\n",
    "metrics/blueprint.jsonl": jsonl({ feature: "F-0003", status: "building", time: now, by: "lead", note: "Work started", evidence: {} }),
    ...Object.fromEntries(roles.map(role => [`engines/${role}.md`, `# Fixture ${role}\n`])),
  });
  const frame = "rounds/0001-reviewer-frame.md";
  put(records, frame, "# R-0001-reviewer-frame\n");
  put(records, handoffs, jsonl({
    id: "R-0001-reviewer-frame", round: 1, phase: "v1", role: "reviewer", step: "reviewer-frame", time: now,
    view: w.git(records, "rev-parse", "HEAD"), attempt: 1, record: frame, files: [frame], product: { base: initial, commit: initial },
    agent: { runner: "claude", model: "fixture-reviewer" }, audit: { violations: 0 },
  }));
  status(w.run("records-check.mjs", ["--repo", records, "--write"]), 0);
  w.commit(records, "Record the frame");
  return { name, product, records, workDir, config, initial };
}

export function argsFor(w, p, role, { round = 2, step = role, base } = {}) {
  const task = put(w.dir, `${p.name}-${round}-${step}-task.md`, `Deliver the ${step} work.\nfeatures: ${role === "reviewer" ? "none" : "F-0003"}\n`);
  return [p.config, role, "--round", String(round), "--step", step, "--task", task, ...(base ? ["--base", base] : [])];
}

export function prepare(w, p, role, opts) {
  return jsonOutput(w.run("call.mjs", [...argsFor(w, p, role, opts), "--prepare"]));
}

export function edit(prepared, files) {
  for (const [file, content] of Object.entries(files)) {
    if (content === null) rmSync(join(prepared.wt, file));
    else put(prepared.wt, file, content);
  }
}

export function record(w, p, prepared, report = "The role completed its work.\n") {
  put(prepared.ws, "out/report.md", report);
  put(prepared.ws, "out/attempt.json", json({ id: prepared.id }));
  const session = `${p.name}-${prepared.id}-fixture-child`;
  const provider = JSON.parse(readFileSync(p.config, "utf8")).agents[prepared.role ?? (prepared.id.includes("judge") ? "judge" : "actor")]?.provider;
  const transcript = put(w.dir, session + ".jsonl", provider === "claude" ? jsonl(
    {timestamp:now, type:"user", sessionId:session, cwd:prepared.wt, message:{role:"user",content:prepared.prompt}},
    {timestamp:now, type:"assistant", sessionId:session, message:{role:"assistant",content:[{type:"text",text:report}],stop_reason:"end_turn"}},
  ) : jsonl(
    { timestamp: now, type: "session_meta", payload: { cwd: prepared.wt, id: session } },
    { timestamp: now, type: "response_item", payload: { type: "message", role: "user",
      content: [{ type: "input_text", text: prepared.prompt }] } },
    { timestamp: now, type: "event_msg", payload: { type: "task_complete" } },
  ));
  return w.run("call.mjs", [p.config, "record", "--ws", prepared.ws, "--session", session, "--transcript", transcript]);
}

export function append(w, p, commit, { round = 1, verdict = "CONTINUE", suite = "12/0", tip } = {}) {
  status(w.run("trajectory.mjs", ["append", "--file", join(p.records, trajectory),
    "--round", String(round), "--phase", "v1", "--role", "judge", "--area", "driver",
    "--verdict", verdict, "--suite", suite, "--commit", commit, ...(tip ? ["--tip", tip] : [])]), 0);
  w.git(p.records, "add", "-A");
  status(w.run("records-check.mjs", ["--repo", p.records, "--write"]), 0);
  w.commit(p.records, "File the ruling");
}

export const head = (w, p) => w.git(p.product, "rev-parse", integration);

export function next(w, p, entry = "self-loop.mjs", args = []) {
  return status(w.run(entry, ["next", "--config", p.config, ...args]), 0);
}

export function assertRefused(w, p, prepared, result, diagnostics) {
  status(result, 7);
  for (const [file, line, phrase] of diagnostics) {
    assert.ok(output(result).includes(`${file}:${line}`), output(result));
    assert.ok(output(result).includes(phrase), output(result));
  }
  const rows = w.git(p.records, "show", "HEAD:" + handoffs).split("\n").map(line => JSON.parse(line));
  assert.ok(!rows.some(row => row.id === prepared.id), output(result));
  assert.equal(w.git(p.records, "ls-tree", "--name-only", "HEAD", "--", `rounds/${prepared.id.slice(2)}.md`), "");
  assert.ok(existsSync(prepared.wt), "retained worktree for a retry");
  assert.ok(existsSync(join(prepared.ws, "out", "attempt.json")), "retained attempt evidence");
  assert.equal(w.git(prepared.wt, "rev-parse", "HEAD"), head(w, p), "the rejected patch was not committed");
}

export function registerBudget(w, products, heavyBudget) {
  w.register(products);
  if (heavyBudget === undefined) return;
  const path = join(w.owner, "products.json");
  put(w.owner, "products.json", json({ ...JSON.parse(readFileSync(path, "utf8")), heavyBudget }));
  w.commit(w.owner, "Size heavy work to the host");
}

export const batchDraw = (salt = 0) => seeded(seed + salt);
