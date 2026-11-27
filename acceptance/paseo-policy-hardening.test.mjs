// F-0008, F-0009, F-0010, D-0016, D-0062, D-0063, design/paseo-and-judge-policy.md#1
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { EXIT } from "../scripts/call.mjs";
import { antigravitySessionState, antigravityTranscript } from "../scripts/lib/antigravity-words.mjs";
import { parseHandoffs } from "../scripts/lib/handoff.mjs";
import { verifyProvenance } from "../scripts/lib/provenance.mjs";
import { t3Prompt } from "../scripts/lib/t3-child.mjs";
import { openWindow } from "../scripts/lib/window.mjs";
import { BRIEFS, git, isolatedEnv, loopProduct, ownerStore, repo, scripts, temp } from "../scripts/test/helpers.mjs";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
const realTemp = prefix => realpathSync(temp(prefix));
const json = v => JSON.stringify(v, null, 2) + "\n";
const jsonl = (...rows) => rows.map(r => JSON.stringify(r)).join("\n") + "\n";
const mkRepo = (files, dir) => { mkdirSync(dir, { recursive: true }); return repo(files, dir); };
const obs = (runner, model) => ({ runner, model, observedModel: model, observedModels: [model] });
const t3Ag = (model = "gemini-2.5-flash") => ({ runner: "t3", provider: "antigravity", model, effort: "high" });
const agObs = model => obs("t3:antigravity", model);
const codexObs = model => obs("t3:codex", model);
const claudeObs = model => obs("t3:claude", model);
const userStep = (step_index, content) => ({
  step_index, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: "2026-11-26T01:00:00.000Z", content,
});
const wrapUserReq = inner => `<USER_REQUEST>\n${inner}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\n2026-11-26\n</ADDITIONAL_METADATA>`;
const wrapPaseo = (body, kind = "agent-message") => `<paseo-system version="1" kind="${kind}" source-agent-id="lead-1" message-id="msg-1">\n${body}\n</paseo-system>`;
const runNode = (script, args, { env = process.env, input = undefined, cwd = undefined } = {}) =>
  spawnSync(process.execPath, [join(scripts, script), ...args], { encoding: "utf8", env, input, cwd });

function put(root, rel, content) {
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  return file;
}

function writeSummaryDb(appDir, rows) {
  mkdirSync(appDir, { recursive: true });
  const db = new DatabaseSync(join(appDir, "conversation_summaries.db"));
  db.exec(`CREATE TABLE IF NOT EXISTS conversation_summaries (
    conversation_id TEXT PRIMARY KEY, workspace_uris TEXT, status TEXT,
    parent_conversation_id TEXT DEFAULT '', nesting_depth INTEGER DEFAULT 0, killed INTEGER DEFAULT 0, not_fully_idle INTEGER DEFAULT 0
  )`);
  const stmt = db.prepare(`INSERT OR REPLACE INTO conversation_summaries
    (conversation_id, workspace_uris, status, parent_conversation_id, nesting_depth, killed, not_fully_idle) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  for (const r of rows) {
    stmt.run(r.id, JSON.stringify((r.workspaces ?? []).map(w => pathToFileURL(w).href)), "CASCADE_RUN_STATUS_IDLE", r.parent ?? "", r.depth ?? 0, 0, 0);
  }
  db.close();
}

function writeTranscript(appDir, id, rows) {
  const file = join(appDir, "brain", id, ".system_generated", "logs", "transcript_full.jsonl");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, rows.map(r => JSON.stringify(r)).join("\n") + "\n");
  return file;
}

function makeCallWorld(t) {
  const dir = realTemp("r45-call-");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const product = mkRepo({ "src/a.js": "export const a = 1;\n", "test/a.test.js": "import test from 'node:test';\n" }, join(dir, "product"));
  git(product, "branch", "loop/v1");
  const sealed = mkRepo({ "case-01.mjs": "export default 1;\n" }, join(dir, "sealed"));
  const briefFiles = Object.fromEntries(Object.values(BRIEFS).map(p => [p, `# ${p}\n\nBrief.\n`]));
  const plan = [
    "# PL-0001 Plan", "scope: paseo/r45", "phase: v1", "",
    "## actor", "role: actor", "handoff: R-0001-actor", "authority: D-0062", "goal: Actor", "files: src/**", "interface: D-0062", "acceptance: pass", "needs: ", "",
    "## critic", "role: critic", "handoff: R-0001-critic", "authority: D-0062", "goal: Critic", "files: test/**", "interface: D-0062", "acceptance: pass", "needs: ", "reviews: actor", "",
    "## judge", "role: judge", "handoff: R-0001-judge", "authority: D-0062", "goal: Judge", "files: ", "interface: D-0062", "acceptance: pass", "needs: critic", "",
  ].join("\n");
  const records = mkRepo({
    "README.md": "# records\n", "records.json": "{}\n",
    "purpose/P-0001.md": "# P-0001 Purpose\n",
    "decisions/D-0062.md": "# D-0062 Policy\n\nid: D-0062\nby: owner\nstatus: active\n",
    "blueprint/F-0008.md": "# F-0008 Paseo\n\nid: F-0008\nphase: v1\nrequirements: P-0001\n",
    "metrics/blueprint.jsonl": jsonl({ feature: "F-0008", phase: "v1", status: "building", time: "2026-11-26T00:00:00Z", by: "lead", note: "start", evidence: {} }),
    "rounds/0001-reviewer-frame.md": "# R-0001-reviewer-frame\n",
    "metrics/handoffs.jsonl": jsonl({
      id: "R-0001-reviewer-frame", time: "2026-11-26T00:00:00Z", phase: "v1", round: 1, step: "reviewer-frame",
      role: "reviewer", record: "rounds/0001-reviewer-frame.md", files: ["rounds/0001-reviewer-frame.md"],
      view: "f".repeat(40), attempt: 1, agent: { runner: "antigravity" }, product: null, audit: { violations: 0 },
    }),
    "plans/PL-0001.md": plan, ...briefFiles,
  }, join(dir, "records"));
  const workDir = join(dir, "work"), appDir = join(dir, "ag-app"), gHome = join(dir, "ag-gemini"), loadDir = join(dir, "load");
  for (const d of [workDir, appDir, gHome, loadDir]) mkdirSync(d, { recursive: true });
  const cfgPath = join(dir, "loop.json");
  writeFileSync(cfgPath, json({
    product, branch: "loop/v1", records, phase: "v1", workDir, briefs: BRIEFS, sealed: [sealed],
    purpose: ["src/a.js"], owns: { critic: ["test"], actor: ["src"] }, protected: ["main"],
    agents: { critic: t3Ag(), actor: t3Ag(), judge: t3Ag("gemini-2.5-pro"), reviewer: t3Ag("gemini-2.5-pro") },
  }));
  const env = isolatedEnv({ ANTIGRAVITY_APP_DATA_DIR: appDir, GEMINI_HOME: gHome, T3CODE_HOME: "", SELF_LOOP_LOAD_DIR: loadDir });
  const prepare = (role, taskBody, extra = []) => {
    const taskFile = join(dir, `task-${role}-${Math.random().toString(16).slice(2)}.md`);
    writeFileSync(taskFile, taskBody);
    const res = runNode("call.mjs", [cfgPath, role, "--round", "1", "--task", taskFile, ...extra, "--prepare"], { env });
    assert.equal(res.status, 0, res.stderr + res.stdout);
    return JSON.parse(res.stdout);
  };
  const recordAuto = ws => runNode("call.mjs", [cfgPath, "record", "--ws", ws], { env });
  const recordTx = (ws, tx) => runNode("call.mjs", [cfgPath, "record", "--ws", ws, "--transcript", tx], { env });
  const handoffs = () => parseHandoffs(git(records, "show", "HEAD:metrics/handoffs.jsonl")).filter(h => h.step !== "reviewer-frame");
  return { cfgPath, appDir, env, prepare, recordAuto, recordTx, handoffs };
}

test("[R44-1] plain local Antigravity launch mentioning </paseo-system> passes record auto-discovery and --transcript while invalid Paseo envelopes still fail closed [loss: wrong-result / disclosure]", t => {
  const w = makeCallWorld(t);
  const prepAuto = w.prepare("actor", "features: F-0008\nHandle closing tags safely.\n", ["--plan", "PL-0001", "--package", "actor"]);
  writeFileSync(join(prepAuto.ws, "out", "report.md"), "Actor done.\n");
  const summaryRows = [{ id: "conv-plain-prefix", workspaces: [prepAuto.wt] }];
  writeSummaryDb(w.appDir, summaryRows);
  writeTranscript(w.appDir, "conv-plain-prefix", [
    userStep(0, wrapUserReq(`Context note: handle </paseo-system> closing tags safely.\n\n${prepAuto.prompt}`)),
    { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-26T01:00:05Z", model: "gemini-2.5-flash" },
  ]);
  assert.equal(w.recordAuto(prepAuto.ws).status, 0);

  const prepTx = w.prepare("critic", "features: F-0008\nVerify suffix tag mention.\n", ["--plan", "PL-0001", "--package", "critic"]);
  writeFileSync(join(prepTx.ws, "out", "report.md"), "Critic done.\n");
  summaryRows.push({ id: "conv-plain-suffix", workspaces: [prepTx.wt] });
  writeSummaryDb(w.appDir, summaryRows);
  const txPlain = writeTranscript(w.appDir, "conv-plain-suffix", [
    userStep(0, wrapUserReq(`${prepTx.prompt}\nNote about </paseo-system>.`)),
    { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-26T01:00:05Z", model: "gemini-2.5-flash" },
  ]);
  assert.equal(w.recordTx(prepTx.ws, txPlain).status, 0);
  assert.equal(w.handoffs().length, 2);
  assert.equal(w.handoffs()[0].audit.violations, 0);
  assert.equal(w.handoffs()[1].audit.violations, 0);

  const prepRev = w.prepare("reviewer", "Review Paseo rejection.\nfeatures: none\n");
  writeFileSync(join(prepRev.ws, "out", "report.md"), "VERDICT: CONTINUE\n");
  for (const [label, step0] of [
    ["notif", wrapUserReq(wrapPaseo(prepRev.prompt, "agent-notification"))],
    ["unclosed", wrapUserReq(`<paseo-system version="1" kind="agent-message">\n${prepRev.prompt}`)],
    ["concat", wrapUserReq(`${wrapPaseo("A")}${wrapPaseo(prepRev.prompt)}`)],
    ["trailing", wrapUserReq(`${wrapPaseo(prepRev.prompt)} trailing`)],
  ]) {
    const cid = `conv-bad-${label}`;
    summaryRows.push({ id: cid, workspaces: [prepRev.ws] });
    writeSummaryDb(w.appDir, summaryRows);
    const txBad = writeTranscript(w.appDir, cid, [
      userStep(0, step0),
      { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-26T01:00:05Z", model: "gemini-2.5-pro" },
    ]);
    assert.equal(w.recordAuto(prepRev.ws).status, EXIT.failure, `${label} auto-discovery must fail`);
    assert.equal(w.recordTx(prepRev.ws, txBad).status, EXIT.records, `${label} --transcript must fail`);
  }
  assert.equal(w.handoffs().length, 2);
});

function makeWaveWorld(t, { judgeIndependence = "model", rounds } = {}) {
  const dir = realTemp("r45-wave-");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const product = mkRepo({ "README.md": "# Wave\n", "VERSION": "0.1.0\n", "scripts/test/smoke.test.mjs": "import test from 'node:test';\ntest('ok', () => {});\n" }, join(dir, "product"));
  const baseline = git(product, "rev-parse", "HEAD");
  git(product, "branch", "-f", "loop/v1", baseline);
  git(product, "remote", "add", "origin", "https://github.com/example/wave.git");

  const commits = [];
  let prev = baseline;
  for (let i = 0; i < rounds.actors.length; i++) {
    put(product, `scripts/f${i + 1}.mjs`, `export const f${i + 1} = ${i + 1};\n`);
    git(product, "add", `scripts/f${i + 1}.mjs`);
    git(product, "commit", "-qm", `Feature ${i + 1}`);
    const sha = git(product, "rev-parse", "HEAD");
    commits.push({ base: prev, commit: sha, tree: git(product, "rev-parse", `${sha}^{tree}`) });
    prev = sha;
  }
  const headCommit = prev;
  git(product, "branch", "-f", "loop/v1", headCommit);

  const records = join(dir, "records"), workDir = join(dir, "work"), loadDir = join(dir, "load");
  const codexHome = join(dir, "codex-home"), claudeHome = join(dir, "claude-home"), bin = join(dir, "bin"), storeDir = join(dir, "store");
  for (const d of [workDir, loadDir, codexHome, claudeHome, storeDir]) mkdirSync(d, { recursive: true });
  const criticAgent = { runner: "t3:codex", model: "gpt-5.4", observedModel: "gpt-5.4" };
  const makeLoop = ji => ({
    product, records, workDir, branch: "loop/v1", phase: "v1", briefs: BRIEFS,
    agents: { actor: rounds.actors.at(-1).agent, critic: criticAgent, judge: rounds.judges.at(-1).agent, reviewer: claudeObs("claude-opus-4-6") },
    protected: ["main"], gates: { remote: "origin", require: ["github-actions/verify"], suite: "node --test scripts/test/smoke.test.mjs" },
    provenanceBaseline: baseline, ...(ji !== undefined ? { judgeIndependence: ji } : {}),
  });

  const recFiles = {
    "README.md": "# Wave records\n", "records.json": "{}\n", "loop.json": json(makeLoop(judgeIndependence)),
    "purpose/P-0001.md": "# P-0001 Purpose\n\nstatus: active\n",
    "decisions/D-0062.md": "# D-0062 Policy\n\nid: D-0062\nby: owner\nstatus: active\n",
    "blueprint/F-0009.md": "# F-0009 Policy\n\nid: F-0009\nphase: v1\nrequirements: P-0001\n",
    "rounds/0001-reviewer-frame.md": "# R-0001-reviewer-frame\n\nphase: v1\nrole: reviewer\n",
    ...Object.fromEntries(Object.values(BRIEFS).map(p => [p, `# ${p}\n\nBrief.\n`])),
  };
  const handoffs = [{
    id: "R-0001-reviewer-frame", time: "2026-11-26T00:00:00Z", phase: "v1", round: 1, step: "reviewer-frame", role: "reviewer",
    attempt: 1, agent: { runner: "t3:codex" }, view: "a".repeat(40), product: null, audit: { violations: 0 },
    record: "rounds/0001-reviewer-frame.md", files: ["rounds/0001-reviewer-frame.md"],
  }];
  const planPkgs = [], rows = [];

  rounds.actors.forEach((a, i) => {
    const step = a.step ?? `actor-${i + 1}`, id = `R-000${a.round}-${step}`, record = `rounds/000${a.round}-${step}.md`;
    recFiles[record] = `# ${id}\n`;
    handoffs.push({
      id, time: `2026-11-26T01:0${i}:00Z`, phase: "v1", round: a.round, step, role: "actor", attempt: 1,
      agent: a.agent, view: "a".repeat(40), product: { base: commits[i].base, commit: commits[i].commit }, audit: { violations: 0 },
      record, files: [record], dispatch: { plan: "PL-0001", package: step, files: [`scripts/f${i + 1}.mjs`] },
    });
    planPkgs.push(`## ${step}\nrole: actor\nhandoff: ${id}\nauthority: D-0062\ngoal: ${id}\nfiles: scripts/f${i + 1}.mjs\ninterface: D-0062\nacceptance: pass\nneeds: `);
  });
  rounds.critics.forEach((c, i) => {
    const id = `R-000${c.round}-${c.step}`, record = `rounds/000${c.round}-${c.step}.md`, cSha = commits[c.commitIndex].commit;
    recFiles[record] = `# ${id}\n`;
    handoffs.push({
      id, time: `2026-11-26T01:2${i}:00Z`, phase: "v1", round: c.round, step: c.step, role: "critic", attempt: 1,
      agent: criticAgent, view: "a".repeat(40), product: { base: cSha, commit: cSha }, audit: { violations: 0 },
      record, files: [record], dispatch: { plan: "PL-0001", package: c.step, files: [] },
    });
    planPkgs.push(`## ${c.step}\nrole: critic\nhandoff: ${id}\nauthority: D-0062\ngoal: ${id}\nfiles: \ninterface: D-0062\nacceptance: pass\nneeds: ${c.needs}\nreviews: ${c.reviews}`);
  });
  rounds.judges.forEach((j, i) => {
    const id = `R-000${j.round}-judge`, record = `rounds/000${j.round}-judge.md`, sealed = `sealed/judge/000${j.round}/judge-1.md`;
    const jSha = commits[j.commitIndex].commit, jTree = commits[j.commitIndex].tree;
    const ciPath = `evidence/000${j.round}/ci.json`, suitePath = `evidence/000${j.round}/suite-1.json`;
    recFiles[suitePath] = JSON.stringify({ repository: product, sha: jSha, tree: jTree, green: true });
    recFiles[ciPath] = JSON.stringify({ repository: "example/wave", sha: jSha, ci: "success", ok: true, missing: [], conclusions: { "github-actions/verify": "success" } });
    planPkgs.push(`## judge-${i + 1}\nrole: judge\nhandoff: ${id}\nauthority: D-0062\ngoal: ${id}\nfiles: \ninterface: D-0062\nacceptance: pass\nneeds: ${j.needs}`);
    if (!j.prepare) {
      recFiles[record] = `# ${id}\n`;
      recFiles[sealed] = `# ${id}\n\nVERDICT: CONVERGED\nACCEPTANCE: pass\n`;
      handoffs.push({
        id, time: `2026-11-26T02:0${i}:00Z`, phase: "v1", round: j.round, step: "judge", role: "judge", attempt: 1,
        agent: j.agent, view: "a".repeat(40), product: { base: jSha, commit: jSha }, audit: { violations: 0 },
        record, files: [record, sealed], dispatch: { plan: "PL-0001", package: `judge-${i + 1}`, files: [] },
      });
      rows.push({ round: j.round, phase: "v1", role: "judge", area: "policy", verdict: "CONVERGED", commit: jSha, suite: "1/0", ci: "success", ciReceipt: ciPath, time: `2026-11-26T02:0${i}:00Z` });
    }
  });

  const lastJ = rounds.judges.at(-1);
  if (!lastJ.prepare) {
    recFiles["metrics/blueprint.jsonl"] = jsonl({ feature: "F-0009", phase: "v1", status: "done", time: "2026-11-26T02:30:00Z", by: "lead", note: "done", evidence: { round: `R-000${lastJ.round}-judge`, commit: headCommit, ci: `evidence/000${lastJ.round}/ci.json` } });
  } else {
    recFiles["metrics/blueprint.jsonl"] = jsonl({ feature: "F-0009", phase: "v1", status: "building", time: "2026-11-26T00:00:00Z", by: "lead", note: "start", evidence: {} });
  }
  recFiles["plans/PL-0001.md"] = ["# PL-0001 Plan", "scope: policy/v1", "phase: v1", "", ...planPkgs].join("\n") + "\n";
  recFiles["metrics/handoffs.jsonl"] = jsonl(...handoffs);
  recFiles["metrics/trajectory.jsonl"] = jsonl(...rows);

  mkRepo(recFiles, records);
  assert.equal(runNode("records-check.mjs", ["--repo", records, "--write"]).status, 0);
  git(records, "add", "-A");
  git(records, "commit", "-qm", "Init records");
  const { event: win } = openWindow(records, { phase: "v1", startRound: 2, horizon: rounds.horizon ?? 2, goal: "Wave check", invariants: ["Suite green"] });
  chmodSync(put(bin, "gh", "#!/bin/sh\nprintf '%s\\n' '{\"app\":\"github-actions\",\"name\":\"verify\",\"status\":\"completed\",\"conclusion\":\"success\"}'\n"), 0o755);
  const store = ownerStore([{ name: "wave", records }], { dir: storeDir, bound: { maxLoadRatio: 1e9, minAvailableMemoryGB: 0 } });
  const env = isolatedEnv({ SELF_LOOP_OWNER_STORE: store, SELF_LOOP_LOAD_DIR: loadDir, CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: claudeHome, PATH: `${bin}${delimiter}${process.env.PATH}` });
  const cfgPath = join(records, "loop.json");

  return {
    dir, product, records, commit: headCommit, cfgPath, codexHome, claudeHome, env,
    setPolicy: ji => { writeFileSync(cfgPath, json(makeLoop(ji))); git(records, "add", "loop.json"); git(records, "commit", "-qm", `Set ji=${ji}`); },
    verifyProv: (branch = "loop/v1") => verifyProvenance({ repo: product, records, sha: headCommit, branch }),
    verifyPush: (branch = "loop/v1") => runNode("gated-push.mjs", ["--verify-only", "--repo", product, "--branch", branch, "--sha", headCommit, "--owner-store", store], { env }),
    closeWin: () => runNode("window.mjs", ["close", "--records", records, "--id", win.id, "--verdict", "verified", "--commit", headCommit, "--config", cfgPath], { env }),
    loopNext: () => runNode("loop.mjs", ["next", "--config", cfgPath], { env }),
  };
}

test("[R44-2] judgeIndependence model requires observed telemetry across all four gates and refuses unrecognized observedModel under both vendor and model [loss: false-verdict]", t => {
  const neon = agObs("gemini-2.5-flash");
  const singleWave = judgeAgent => ({
    actors: [{ round: 2, step: "actor-a", agent: neon }],
    critics: [{ round: 2, step: "critic", commitIndex: 0, needs: "actor-a", reviews: "actor-a" }],
    judges: [{ round: 3, commitIndex: 0, needs: "critic", agent: judgeAgent }],
  });

  const wNull = makeWaveWorld(t, { judgeIndependence: "model", rounds: singleWave({ runner: "t3:codex", model: "gpt-5.4", observedModel: null }) });
  assert.equal(wNull.verifyProv("main").ok, false);
  assert.equal(wNull.verifyPush("main").status, 2);
  assert.equal(wNull.closeWin().status, 2);
  assert.match(wNull.loopNext().stdout, /judge\/actor independence needs confirmation/);

  const wMystery = makeWaveWorld(t, { judgeIndependence: "vendor", rounds: singleWave({ runner: "codex", observedModel: "mystery-model-xyz" }) });
  for (const pol of ["vendor", "model"]) {
    if (pol === "model") wMystery.setPolicy("model");
    assert.equal(wMystery.verifyProv("main").ok, false, `${pol}: provenance`);
    assert.equal(wMystery.verifyPush("main").status, 2, `${pol}: gated-push`);
    assert.equal(wMystery.closeWin().status, 2, `${pol}: window close`);
    assert.match(wMystery.loopNext().stdout, /judge\/actor independence needs confirmation/, `${pol}: loop next`);
  }

  const wOk = makeWaveWorld(t, { judgeIndependence: "model", rounds: singleWave(codexObs("gpt-5.4")) });
  assert.equal(wOk.verifyProv("main").ok, true);
  assert.equal(wOk.verifyPush("main").status, 0);
  assert.equal(wOk.closeWin().status, 0);
  const nextOk = wOk.loopNext();
  assert.equal(nextOk.status, 0);
  assert.match(nextOk.stdout, /The recorded convergence checks are satisfied/);
});

test("[R44-3] unjudged multi-actor wave overlap is refused identically across gated-push, window close, and loop next while distinct judge and sequential rounds pass [loss: false-verdict]", t => {
  const carbon = agObs("gemini-2.5-pro"), neon = agObs("gemini-2.5-flash"), argon = agObs("gemini-2.5-pro-exp");
  const twoActorWave = judgeAgent => ({
    actors: [{ round: 2, step: "actor-a", agent: carbon }, { round: 3, step: "actor-b", agent: neon }],
    critics: [{ round: 3, step: "critic", commitIndex: 1, needs: "actor-b", reviews: "actor-a, actor-b" }],
    judges: [{ round: 4, commitIndex: 1, needs: "critic", agent: judgeAgent }],
  });

  const wOverlap = makeWaveWorld(t, { judgeIndependence: "model", rounds: twoActorWave(carbon) });
  assert.equal(wOverlap.verifyPush().status, 2);
  assert.equal(wOverlap.closeWin().status, 2);
  assert.match(wOverlap.loopNext().stdout, /judge\/actor independence needs confirmation/);

  const wDistinct = makeWaveWorld(t, { judgeIndependence: "model", rounds: twoActorWave(argon) });
  assert.equal(wDistinct.verifyPush().status, 0);
  assert.equal(wDistinct.closeWin().status, 0);
  assert.match(wDistinct.loopNext().stdout, /The recorded convergence checks are satisfied/);

  const wSeq = makeWaveWorld(t, {
    judgeIndependence: "model",
    rounds: {
      horizon: 2,
      actors: [{ round: 2, step: "actor-a", agent: carbon }, { round: 3, step: "actor-b", agent: neon }],
      critics: [
        { round: 2, step: "critic-a", commitIndex: 0, needs: "actor-a", reviews: "actor-a" },
        { round: 3, step: "critic-b", commitIndex: 1, needs: "actor-b", reviews: "actor-b" },
      ],
      judges: [
        { round: 2, commitIndex: 0, needs: "critic-a", agent: neon },
        { round: 3, commitIndex: 1, needs: "critic-b", agent: carbon },
      ],
    },
  });
  assert.equal(wSeq.verifyPush().status, 0);
  assert.equal(wSeq.closeWin().status, 0);
  assert.match(wSeq.loopNext().stdout, /The recorded convergence checks are satisfied/);
});

function writeJudgeRollout(kind, home, prep, models) {
  const { preparedAt } = JSON.parse(readFileSync(join(prep.ws, "call.json"), "utf8"));
  const ts1 = new Date(preparedAt + 1000).toISOString(), ts2 = new Date(preparedAt + 2000).toISOString(), d = new Date(preparedAt + 1000);
  const dir = kind === "codex"
    ? join(home, "sessions", String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0"))
    : join(home, "projects", "judge-proj");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, kind === "codex" ? `rollout-${Math.random().toString(16).slice(2)}.jsonl` : "claude-judge-sess.jsonl");
  const rows = kind === "codex" ? [
    { timestamp: ts1, type: "session_meta", payload: { cwd: prep.wt, id: "codex-judge-sess" } },
    { timestamp: ts1, type: "turn_context", payload: { cwd: prep.wt, model: models[0] } },
    { timestamp: ts1, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: prep.prompt }] } },
    { timestamp: ts2, type: "turn_context", payload: { cwd: prep.wt, model: models[1] } },
    { timestamp: ts2, type: "event_msg", payload: { type: "task_complete" } },
  ] : [
    { type: "user", cwd: prep.wt, sessionId: "claude-judge-sess", timestamp: ts1, message: { role: "user", content: prep.prompt } },
    { type: "assistant", cwd: prep.wt, sessionId: "claude-judge-sess", timestamp: ts1, message: { model: models[0], stop_reason: "end_turn", content: [{ type: "text", text: "Turn 1." }] } },
    { type: "user", cwd: prep.wt, sessionId: "claude-judge-sess", timestamp: ts2, message: { role: "user", content: "Resume turn 2." } },
    { type: "assistant", cwd: prep.wt, sessionId: "claude-judge-sess", timestamp: ts2, message: { model: models[1], stop_reason: "end_turn", content: [{ type: "text", text: "Turn 2." }] } },
    { type: "result", subtype: "success", sessionId: "claude-judge-sess", is_error: false, timestamp: ts2 },
  ];
  writeFileSync(file, jsonl(...rows));
  const sec = Math.ceil((preparedAt + 2000) / 1000);
  utimesSync(file, sec, sec);
}

function runJudgeSwitchCase(t, { judgeConfig, actorAgent, kind, models, expectPass }) {
  const w = makeWaveWorld(t, {
    judgeIndependence: "model",
    rounds: {
      actors: [{ round: 2, step: "actor", agent: actorAgent }],
      critics: [{ round: 2, step: "critic", commitIndex: 0, needs: "actor", reviews: "actor" }],
      judges: [{ round: 3, commitIndex: 0, needs: "critic", agent: judgeConfig, prepare: true }],
    },
  });
  const taskFile = put(w.dir, "judge-task.md", "features: F-0009\nJudge wave.\n");
  const prepRes = runNode("call.mjs", [w.cfgPath, "judge", "--round", "3", "--plan", "PL-0001", "--package", "judge-1", "--base", w.commit, "--task", taskFile, "--prepare"], { env: w.env });
  assert.equal(prepRes.status, 0, prepRes.stderr + prepRes.stdout);
  const prep = JSON.parse(prepRes.stdout);
  put(prep.ws, "out/report.md", "VERDICT: CONVERGED\nACCEPTANCE: pass\n");
  put(prep.ws, "out/public.md", "Judge public ruling.\n");
  writeJudgeRollout(kind, kind === "codex" ? w.codexHome : w.claudeHome, prep, models);

  const recRes = runNode("call.mjs", [w.cfgPath, "record", "--ws", prep.ws], { env: w.env });
  assert.equal(recRes.status, 0, recRes.stderr + recRes.stdout);
  const handoff = parseHandoffs(git(w.records, "show", "HEAD:metrics/handoffs.jsonl")).find(h => h.id === "R-0003-judge");
  put(w.records, "metrics/trajectory.jsonl", jsonl({ round: 3, phase: "v1", role: "judge", area: "policy", verdict: "CONVERGED", commit: w.commit, suite: "1/0", ci: "success", ciReceipt: "evidence/0003/ci.json", time: "2026-11-26T02:00:00Z" }));
  put(w.records, "metrics/blueprint.jsonl", jsonl({ feature: "F-0009", phase: "v1", status: "done", time: "2026-11-26T02:05:00Z", by: "lead", note: "done", evidence: { round: "R-0003-judge", commit: w.commit, ci: "evidence/0003/ci.json" } }));
  assert.equal(runNode("records-check.mjs", ["--repo", w.records, "--write"]).status, 0);
  git(w.records, "add", "-A");
  git(w.records, "commit", "-qm", "Record judge ruling");

  assert.equal(w.verifyProv("main").ok, expectPass);
  assert.equal(w.verifyPush("main").status, expectPass ? 0 : 2);
  assert.equal(w.closeWin().status, expectPass ? 0 : 2);
  const next = w.loopNext();
  assert.equal(next.status, 0, next.stderr);
  assert.match(next.stdout, expectPass ? /The recorded convergence checks are satisfied/ : /judge\/actor independence needs confirmation/);
  return handoff;
}

test("[R45-1-multimodel] resumed Codex and Claude judges switching models preserve full observedModels and fail closed across all four gates while single-model Codex passes [loss: false-verdict]", t => {
  const codexSwitch = runJudgeSwitchCase(t, { judgeConfig: { runner: "t3", provider: "codex", model: "gpt-5.4", effort: "high" }, actorAgent: codexObs("gpt-5.4-mini"), kind: "codex", models: ["gpt-5.4", "gpt-5.4-mini"], expectPass: false });
  assert.deepEqual(codexSwitch.agent.observedModels, ["gpt-5.4", "gpt-5.4-mini"]);

  const claudeSwitch = runJudgeSwitchCase(t, { judgeConfig: { runner: "t3", provider: "claude", model: "claude-opus-4-6", effort: "high" }, actorAgent: claudeObs("claude-sonnet-4-6"), kind: "claude", models: ["claude-opus-4-6", "claude-sonnet-4-6"], expectPass: false });
  assert.deepEqual(claudeSwitch.agent.observedModels, ["claude-opus-4-6", "claude-sonnet-4-6"]);

  const codexSingle = runJudgeSwitchCase(t, { judgeConfig: { runner: "t3", provider: "codex", model: "gpt-5.4", effort: "high" }, actorAgent: codexObs("gpt-5.4-mini"), kind: "codex", models: ["gpt-5.4", "gpt-5.4"], expectPass: true });
  assert.deepEqual(codexSingle.agent.observedModels, ["gpt-5.4"]);
});

test("[R44-4] Paseo peer Lead message citing a call line preserves owner state and Step 1+ human words while index-0 t3Prompt child stays confirmed-child [loss: data / disclosure]", t => {
  const dir = realTemp("r45-words-");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const prod = loopProduct({ activity: "2026-11-26T00:00:00Z", dir: join(dir, "prod") });
  const storeDir = join(dir, "store");
  mkdirSync(storeDir, { recursive: true });
  const store = ownerStore([{ name: "prod", records: prod.records }], { dir: storeDir });
  const appDir = join(dir, "ag-app"), env = isolatedEnv({ ANTIGRAVITY_APP_DATA_DIR: appDir, GEMINI_HOME: join(dir, "g"), T3CODE_HOME: "", SELF_LOOP_LOAD_DIR: join(dir, "load") });

  const ws = join(prod.dir, "work", "0044-actor"), wt = join(ws, "wt"), nonce = "0123456789abcdef";
  mkdirSync(join(ws, "out"), { recursive: true });
  git(prod.product, "worktree", "add", "-q", "--detach", wt);
  writeFileSync(join(ws, "call.json"), json({ version: 2, role: "actor", round: 44, step: "actor", phase: "v1", id: "R-0044-actor", record: "rounds/0044-actor.md", ws, wt, nonce }));
  const childPrompt = t3Prompt({ id: "R-0044-actor", nonce, wt, ws, text: "Fix blockers." });

  const ownerWord = "Ship v0.9.3 after fixing all 4 blockers.";
  const leadTx = writeTranscript(appDir, "lead-peer-conv", [
    userStep(0, wrapUserReq(wrapPaseo(`Lead coordination update:\nself-loop call R-0044-actor · nonce ${nonce}\nPlease review status.`))),
    userStep(1, wrapUserReq(ownerWord)),
  ]);
  const childTx = writeTranscript(appDir, "child-paseo-conv", [
    userStep(0, wrapUserReq(wrapPaseo(childPrompt))),
    userStep(1, wrapUserReq("Do not capture child turn.")),
  ]);
  writeSummaryDb(appDir, [{ id: "lead-peer-conv", workspaces: [prod.product] }, { id: "child-paseo-conv", workspaces: [wt] }]);

  const leadState = antigravitySessionState(leadTx, { conversationId: "lead-peer-conv" });
  assert.equal(leadState.state, "owner");
  assert.equal(leadState.agent, false);
  assert.deepEqual(antigravityTranscript(leadTx).words.map(w => w.text), [ownerWord]);

  assert.equal(runNode("owner-words.mjs", ["sync", "--owner-store", store], { env, cwd: dir }).status, 0);
  const wordsJsonl = readFileSync(join(prod.records, "owner", "words.jsonl"), "utf8");
  assert.match(wordsJsonl, /Ship v0\.9\.3 after fixing all 4 blockers\./);
  assert.doesNotMatch(wordsJsonl, /Lead coordination update|Do not capture child turn/);

  const guard = payload => runNode("lead-guard.mjs", ["--harness", "antigravity", "--owner-store", store], { env, cwd: dir, input: JSON.stringify(payload) });
  const leadProdDeny = JSON.parse(guard({ hookEventName: "PreToolUse", conversationId: "lead-peer-conv", transcriptPath: leadTx, cwd: prod.product, toolCall: { name: "write_to_file", argumentsJson: JSON.stringify({ TargetFile: join(prod.product, "src", "a.js"), CodeContent: "x" }) } }).stdout || "{}");
  assert.equal(leadProdDeny.decision, "deny");
  assert.match(leadProdDeny.reason, /The lead does not write product code/);
  assert.doesNotMatch(leadProdDeny.reason, /outside delegated child workspace scope/);

  const leadWtDeny = JSON.parse(guard({ hookEventName: "PreToolUse", conversationId: "lead-peer-conv", transcriptPath: leadTx, cwd: wt, toolCall: { name: "write_to_file", argumentsJson: JSON.stringify({ TargetFile: join(wt, "src", "a.js"), CodeContent: "x" }) } }).stdout || "{}");
  assert.equal(leadWtDeny.decision, "deny");
  assert.match(leadWtDeny.reason, /inside workspace root/);

  const childState = antigravitySessionState(childTx, { conversationId: "child-paseo-conv" });
  assert.equal(childState.state, "confirmed-child");
  assert.equal(childState.agent, true);
  assert.equal(antigravityTranscript(childTx).words.length, 0);

  assert.equal(guard({ hookEventName: "PreToolUse", conversationId: "child-paseo-conv", transcriptPath: childTx, cwd: wt, toolCall: { name: "write_to_file", argumentsJson: JSON.stringify({ TargetFile: join(ws, "out", "report.md"), CodeContent: "ok" }) } }).stdout.trim(), "");
  assert.equal(guard({ hookEventName: "PreToolUse", conversationId: "child-paseo-conv", transcriptPath: childTx, cwd: wt, toolCall: { name: "write_to_file", argumentsJson: JSON.stringify({ TargetFile: join(wt, "src", "a.js"), CodeContent: "ok" }) } }).stdout.trim(), "");
  const childProdDeny = JSON.parse(guard({ hookEventName: "PreToolUse", conversationId: "child-paseo-conv", transcriptPath: childTx, cwd: wt, toolCall: { name: "write_to_file", argumentsJson: JSON.stringify({ TargetFile: join(prod.product, "src", "a.js"), CodeContent: "bad" }) } }).stdout || "{}");
  assert.equal(childProdDeny.decision, "deny");
  assert.match(childProdDeny.reason, /outside delegated child workspace scope/);
});
