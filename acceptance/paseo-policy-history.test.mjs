// D-0016, D-0060, D-0062, D-0063, design/paseo-and-judge-policy.md#1
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import test from "node:test";
import { evaluateCertifiedWaveCoverage, verifyProvenance } from "../scripts/lib/provenance.mjs";
import { openWindow } from "../scripts/lib/window.mjs";
import { git, isolatedEnv, ownerStore, repo, scripts, temp } from "../scripts/test/helpers.mjs";

const realTemp = prefix => realpathSync(temp(prefix));
const json = v => JSON.stringify(v, null, 2) + "\n";
const jsonl = (...rows) => rows.map(r => JSON.stringify(r)).join("\n") + "\n";
const mkRepo = (files, dir) => { mkdirSync(dir, { recursive: true }); return repo(files, dir); };
const obs = (runner, model) => ({ runner, model, observedModel: model, observedModels: [model] });
const agObs = model => obs("t3:antigravity", model);
const codexObs = model => obs("t3:codex", model);
const openaiObs = model => obs("openai", model);
const codexNoObs = () => ({ runner: "codex", model: "gpt-5.4", observedModel: null });
const runNode = (script, args, { env = process.env } = {}) =>
  spawnSync(process.execPath, [join(scripts, script), ...args], { encoding: "utf8", env });
const pad = n => String(n).padStart(4, "0");

function put(root, rel, content) {
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  return file;
}

function appendFile(root, rel, text) {
  const file = join(root, rel);
  writeFileSync(file, readFileSync(file, "utf8") + text);
}

function commitProduct(product, path, content, message, base = null) {
  if (base) git(product, "checkout", "-q", "--detach", base);
  put(product, path, content);
  git(product, "add", path);
  git(product, "commit", "-qm", message);
  const commit = git(product, "rev-parse", "HEAD");
  return { commit, tree: git(product, "rev-parse", `${commit}^{tree}`) };
}

function setupGhAndStore(dir, name, records) {
  const bin = join(dir, "bin"), storeDir = join(dir, "store"), loadDir = join(dir, "load");
  mkdirSync(storeDir, { recursive: true });
  mkdirSync(loadDir, { recursive: true });
  chmodSync(put(bin, "gh", "#!/bin/sh\nprintf '%s\\n' '{\"app\":\"github-actions\",\"name\":\"verify\",\"status\":\"completed\",\"conclusion\":\"success\"}'\n"), 0o755);
  const store = ownerStore([{ name, records }], { dir: storeDir, bound: { maxLoadRatio: 1e9, minAvailableMemoryGB: 0 } });
  const env = isolatedEnv({ SELF_LOOP_OWNER_STORE: store, SELF_LOOP_LOAD_DIR: loadDir, PATH: `${bin}${delimiter}${process.env.PATH}` });
  return { store, env };
}

function makeHistoryWorld(t, { initialPolicy, owns, commitLoopJson = true, cadenceAdversarial = 5 } = {}) {
  const dir = realTemp("r47-history-");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const product = mkRepo({
    "README.md": "# History\n",
    "VERSION": "0.1.0\n",
    "scripts/test/smoke.test.mjs": "import test from 'node:test';\ntest('ok', () => {});\n",
  }, join(dir, "product"));
  git(product, "branch", "-M", "master");
  const baseline = git(product, "rev-parse", "HEAD");
  git(product, "remote", "add", "origin", "https://github.com/example/history.git");
  git(product, "branch", "-f", "loop/v1", baseline);

  const records = join(dir, "records"), workDir = join(dir, "work"), extCfgPath = join(dir, "ext-loop.json");
  mkdirSync(workDir, { recursive: true });
  const cfgPath = join(records, "loop.json");
  let provBaseline = baseline;
  const baseCfg = policy => ({
    product, records, workDir, branch: "loop/v1", phase: "v1", briefs: {},
    agents: { actor: agObs("gemini-2.5-flash"), critic: codexObs("gpt-5.4"), judge: agObs("gemini-2.5-pro") },
    protected: ["master"],
    gates: { remote: "origin", require: ["github-actions/verify"], suite: "node --test scripts/test/smoke.test.mjs" },
    cadence: { adversarial: cadenceAdversarial },
    provenanceBaseline: provBaseline,
    ...(owns ? { owns } : {}),
    ...(policy !== undefined ? { judgeIndependence: policy } : {}),
  });

  const planHeader = "# PL-0001 Plan\nscope: history/v1\nphase: v1\n";
  mkRepo({
    "README.md": "# History records\n",
    "records.json": "{}\n",
    ...(commitLoopJson ? { "loop.json": json(baseCfg(initialPolicy)) } : {}),
    "purpose/P-0001.md": "# P-0001 Purpose\n\nstatus: active\n",
    "decisions/D-0062.md": "# D-0062 Policy\n\nid: D-0062\nby: owner\nstatus: active\n",
    "blueprint/F-0009.md": "# F-0009 Policy\n\nid: F-0009\nphase: v1\nrequirements: P-0001\n",
    "metrics/blueprint.jsonl": jsonl({ feature: "F-0009", phase: "v1", status: "building", time: "2026-11-26T00:00:00Z", by: "lead", note: "start", evidence: {} }),
    "rounds/0001-reviewer-frame.md": "# R-0001-reviewer-frame\n\nphase: v1\nrole: reviewer\n",
    "metrics/handoffs.jsonl": jsonl({
      id: "R-0001-reviewer-frame", time: "2026-11-26T00:00:00Z", phase: "v1", round: 1, step: "reviewer-frame",
      role: "reviewer", attempt: 1, agent: obs("t3:claude", "claude-opus-4-6"), view: "a".repeat(40), product: null,
      audit: { violations: 0 }, record: "rounds/0001-reviewer-frame.md", files: ["rounds/0001-reviewer-frame.md"],
    }),
    "metrics/trajectory.jsonl": "",
    "plans/PL-0001.md": planHeader,
  }, records);
  assert.equal(runNode("records-check.mjs", ["--repo", records, "--write"]).status, 0);
  git(records, "add", "-A");
  git(records, "commit", "-qm", "Init history records");

  const { store, env } = setupGhAndStore(dir, "history", records);
  let prevCommit = baseline, planPkgs = [], minHour = 1;

  const commitRecords = (msg, { raw = false } = {}) => {
    git(records, "add", "-A");
    if (!raw) {
      const rc = runNode("records-check.mjs", ["--repo", records, "--write"]);
      assert.equal(rc.status, 0, rc.stderr + rc.stdout);
      git(records, "add", "-A");
    }
    git(records, "commit", "-qm", msg);
    return git(records, "rev-parse", "HEAD");
  };

  const setRawLoop = text => { writeFileSync(cfgPath, text); return commitRecords("Update loop.json", { raw: true }); };
  const setPolicy = policy => setRawLoop(json(baseCfg(policy)));
  const setBaseline = (sha, policy = initialPolicy) => {
    provBaseline = sha;
    writeFileSync(cfgPath, json(baseCfg(policy)));
    return commitRecords(`Set provenanceBaseline=${sha.slice(0, 8)}`);
  };
  const writeExtCfg = policy => { writeFileSync(extCfgPath, json(baseCfg(policy))); return baseCfg(policy); };

  const addActor = ({ round, base = prevCommit, file, content = null, actorAgent, step = "actor", criticAgent = codexObs("gpt-5.4") }) => {
    const prod = commitProduct(product, file, content ?? `export const r${round} = ${round};\n`, `Actor ${round}`, base);
    git(product, "branch", "-f", "loop/v1", prod.commit);
    const view = git(records, "rev-parse", "HEAD"), rPad = pad(round), ts = `2026-11-26T0${minHour++}:10:00Z`;
    const aId = `R-${rPad}-${step}`, cId = `R-${rPad}-critic-${step}`;
    const aRec = `rounds/${rPad}-${step}.md`, cRec = `rounds/${rPad}-critic-${step}.md`;
    put(records, aRec, `# ${aId}\n`);
    put(records, cRec, `# ${cId}\n`);
    const aPkg = `${step}-${round}`, cPkg = `critic-${step}-${round}`;
    planPkgs.push(
      `## ${aPkg}\nrole: actor\nhandoff: ${aId}\nauthority: D-0062\ngoal: ${aId}\nfiles: ${file}\ninterface: D-0062\nacceptance: pass\nneeds: `,
      `## ${cPkg}\nrole: critic\nhandoff: ${cId}\nauthority: D-0062\ngoal: ${cId}\nfiles: \ninterface: D-0062\nacceptance: pass\nneeds: ${aPkg}\nreviews: ${aPkg}`,
    );
    put(records, "plans/PL-0001.md", [planHeader, ...planPkgs].join("\n") + "\n");
    appendFile(records, "metrics/handoffs.jsonl", jsonl(
      { id: aId, time: ts, phase: "v1", round, step, role: "actor", attempt: 1, agent: actorAgent, view, product: { base, commit: prod.commit }, audit: { violations: 0 }, record: aRec, files: [aRec], dispatch: { plan: "PL-0001", package: aPkg, files: [file] } },
      { id: cId, time: ts, phase: "v1", round, step: `critic-${step}`, role: "critic", attempt: 1, agent: criticAgent, view, product: { base: prod.commit, commit: prod.commit }, audit: { violations: 0 }, record: cRec, files: [cRec], dispatch: { plan: "PL-0001", package: cPkg, files: [] } },
    ));
    commitRecords(`Record actor ${aId}`);
    prevCommit = prod.commit;
    return { ...prod, pkg: cPkg };
  };

  const addJudge = ({ round, commit, tip = null, tipTree = null, judgeAgent, needsPkg, step = "judge", area = "policy", viewOverride = null, between = null, markDone = false, rawJudge = false }) => {
    const view = viewOverride ?? git(records, "rev-parse", "HEAD");
    const rPad = pad(round), ts = `2026-11-26T0${minHour++}:30:00Z`;
    const jId = `R-${rPad}-${step}`, jRec = `rounds/${rPad}-${step}.md`, jSealed = `sealed/judge/${rPad}/${step}-1.md`;
    const jSuite = `evidence/${rPad}/suite-1.json`, jTipSuite = `evidence/${rPad}/suite-tip.json`, jCi = `evidence/${rPad}/ci.json`;
    put(records, jRec, `# ${jId}\n`);
    put(records, jSealed, `# ${jId}\n\nVERDICT: CONVERGED\nACCEPTANCE: pass\n`);
    put(records, jSuite, JSON.stringify({ repository: product, sha: commit, tree: git(product, "rev-parse", `${commit}^{tree}`), green: true }));
    if (tip && tipTree) put(records, jTipSuite, JSON.stringify({ repository: product, sha: tip, tree: tipTree, green: true }));
    put(records, jCi, JSON.stringify({ repository: "example/history", sha: tip ?? commit, ci: "success", ok: true, missing: [], conclusions: { "github-actions/verify": "success" } }));
    const jPkg = `${step}-${round}`;
    planPkgs.push(`## ${jPkg}\nrole: judge\nhandoff: ${jId}\nauthority: D-0062\ngoal: ${jId}\nfiles: \ninterface: D-0062\nacceptance: pass\nneeds: ${needsPkg}`);
    put(records, "plans/PL-0001.md", [planHeader, ...planPkgs].join("\n") + "\n");
    appendFile(records, "metrics/handoffs.jsonl", jsonl({
      id: jId, time: ts, phase: "v1", round, step, role: "judge", attempt: 1, agent: judgeAgent, view,
      product: { base: commit, commit }, audit: { violations: 0 }, record: jRec, files: [jRec, jSealed],
      dispatch: { plan: "PL-0001", package: jPkg, files: [] },
    }));
    commitRecords(`Record judge handoff ${jId}`, { raw: Boolean(rawJudge) });
    if (between) between();
    appendFile(records, "metrics/trajectory.jsonl", jsonl({
      round, phase: "v1", role: "judge", area, verdict: "CONVERGED", commit, ...(tip ? { tip } : {}),
      suite: "1/0", ci: "success", ciReceipt: jCi, time: ts,
    }));
    if (markDone) {
      appendFile(records, "metrics/blueprint.jsonl", jsonl({
        feature: "F-0009", phase: "v1", status: "done", time: ts, by: "lead", note: "done", evidence: { round: jId, commit, ...(tip ? { tip } : {}), ci: jCi },
      }));
    }
    commitRecords(`Record judge row ${jId}`, { raw: Boolean(rawJudge) });
  };

  const addWave = ({ round, actorAgent, criticAgent = codexObs("gpt-5.4"), judgeAgent = null, file, content = null, area = "policy", markDone = false, step = "actor" }) => {
    const act = addActor({ round, file, content, actorAgent, criticAgent, step });
    if (judgeAgent) addJudge({ round, commit: act.commit, judgeAgent, needsPkg: act.pkg, area, markDone });
    return act;
  };

  const defaultCfg = () => (existsSync(cfgPath) ? cfgPath : extCfgPath);
  const openWin = (startRound, horizon = 3) => openWindow(records, { phase: "v1", startRound, horizon, goal: "Policy wave", invariants: ["Suite green"] }).event.id;
  const verifyProv = (sha, branch = "master", cfg = null) => verifyProvenance({ repo: product, records, sha, branch, cfg });
  const verifyPush = (sha, branch = "master") => runNode("gated-push.mjs", ["--verify-only", "--repo", product, "--branch", branch, "--sha", sha, "--owner-store", store], { env });
  const closeWin = (winId, sha, cfgArg = defaultCfg()) => runNode("window.mjs", ["close", "--records", records, "--id", winId, "--verdict", "verified", "--commit", sha, "--config", cfgArg], { env });
  const loopNext = (cfgArg = defaultCfg()) => runNode("loop.mjs", ["next", "--config", cfgArg], { env });

  return { dir, product, records, baseline, commitRecords, setRawLoop, setPolicy, setBaseline, writeExtCfg, addActor, addJudge, addWave, openWin, verifyProv, verifyPush, closeWin, loopNext };
}

function assertAllFourAccept(w, sha, winId, cfgArg) {
  const prov = w.verifyProv(sha, "master");
  assert.equal(prov.ok, true, prov.reasons.join("; "));
  const push = w.verifyPush(sha, "master");
  assert.equal(push.status, 0, push.stderr);
  const win = w.closeWin(winId, sha, cfgArg);
  assert.equal(win.status, 0, win.stderr);
  const next = w.loopNext(cfgArg);
  assert.equal(next.status, 0, next.stderr);
  assert.match(next.stdout, /The recorded convergence checks are satisfied/);
  assert.doesNotMatch(next.stdout, /judge\/actor independence needs confirmation/);
}

function assertAllFourRefuse(w, sha, winId, cfgArg) {
  assert.equal(w.verifyProv(sha, "master").ok, false, "verifyProvenance must refuse");
  assert.notEqual(w.verifyPush(sha, "master").status, 0, "gated-push --verify-only must refuse");
  assert.notEqual(w.closeWin(winId, sha, cfgArg).status, 0, "window close must refuse");
  const next = w.loopNext(cfgArg);
  assert.equal(next.status, 0, next.stderr);
  assert.match(next.stdout, /judge\/actor independence needs confirmation/);
  assert.doesNotMatch(next.stdout, /The recorded convergence checks are satisfied/);
}

test("[R46-1] uncertified model-mode Wave 1 cannot retire Actor 1 after Wave 2 lands across all four gates, while independent Judge 3 recovers [loss: false-verdict]", t => {
  const w = makeHistoryWorld(t, { initialPolicy: "model" });
  const wave1 = w.addWave({ round: 2, file: "scripts/w1.mjs", actorAgent: agObs("gemini-2.5-pro"), judgeAgent: codexNoObs() });
  assert.equal(w.verifyProv(wave1.commit, "master").ok, false);
  assert.notEqual(w.verifyPush(wave1.commit, "master").status, 0);

  const wave2 = w.addWave({ round: 3, file: "scripts/w2.mjs", actorAgent: agObs("gemini-2.5-flash"), judgeAgent: agObs("gemini-2.5-pro"), markDone: true });
  const winId = w.openWin(3, 2);
  assertAllFourRefuse(w, wave2.commit, winId);

  w.addJudge({ round: 4, area: "recovery", commit: wave2.commit, judgeAgent: openaiObs("gpt-5.4"), needsPkg: "critic-actor-3" });
  assertAllFourAccept(w, wave2.commit, winId);
});

test("[R46-1-adopt] vendor-to-model mid-phase adoption and adopted provenanceBaseline certify historical vendor waves while checking current waves across all gates [loss: false-verdict]", t => {
  const w = makeHistoryWorld(t, { initialPolicy: undefined });
  w.addWave({ round: 2, file: "scripts/w1.mjs", actorAgent: agObs("gemini-2.5-pro"), judgeAgent: codexNoObs() });
  w.setPolicy("model");
  const wave2 = w.addWave({ round: 3, file: "scripts/w2.mjs", actorAgent: agObs("gemini-2.5-flash"), judgeAgent: agObs("gemini-2.5-pro"), markDone: true });
  assertAllFourAccept(w, wave2.commit, w.openWin(3, 2));

  const wBasePass = makeHistoryWorld(t, { initialPolicy: "model" });
  const histPass = wBasePass.addWave({ round: 2, file: "scripts/f1.mjs", actorAgent: agObs("gemini-2.5-pro"), judgeAgent: { runner: "codex", model: "gpt-5.4" } });
  wBasePass.setBaseline(histPass.commit, "model");
  const curPass = wBasePass.addWave({ round: 3, file: "scripts/c1.mjs", actorAgent: agObs("gemini-2.5-flash"), judgeAgent: agObs("gemini-2.5-pro"), markDone: true });
  assert.equal(wBasePass.verifyPush(curPass.commit, "loop/v1").status, 0);
  assertAllFourAccept(wBasePass, curPass.commit, wBasePass.openWin(3, 2));

  const wBaseFail = makeHistoryWorld(t, { initialPolicy: "model" });
  const histFail = wBaseFail.addWave({ round: 2, file: "scripts/f1.mjs", actorAgent: agObs("gemini-2.5-pro"), judgeAgent: { runner: "codex", model: "gpt-5.4" } });
  wBaseFail.setBaseline(histFail.commit, "model");
  wBaseFail.addActor({ round: 3, file: "scripts/c1.mjs", actorAgent: agObs("gemini-2.5-pro"), step: "actor-a" });
  const curFail = wBaseFail.addWave({ round: 4, file: "scripts/c2.mjs", actorAgent: agObs("gemini-2.5-flash"), judgeAgent: agObs("gemini-2.5-pro"), step: "actor-b", markDone: true });
  assertAllFourRefuse(wBaseFail, curFail.commit, wBaseFail.openWin(3, 3));
});

test("[R46-1-model-waves] two successive valid model-policy waves are accepted across all four gates [loss: false-verdict]", t => {
  const w = makeHistoryWorld(t, { initialPolicy: "model" });
  w.addWave({ round: 2, file: "scripts/w1.mjs", actorAgent: agObs("gemini-2.5-pro"), judgeAgent: agObs("gemini-2.5-flash") });
  const wave2 = w.addWave({ round: 3, file: "scripts/w2.mjs", actorAgent: agObs("gemini-2.5-flash"), judgeAgent: agObs("gemini-2.5-pro"), markDone: true });
  assertAllFourAccept(w, wave2.commit, w.openWin(3, 2));
});

test("[R47-1] actor-attested documentation deliverable on leadPaths is accepted on its exact judged commit across all four gates, while unjudged Wave 2 doc commit is refused [loss: false-verdict]", t => {
  const w = makeHistoryWorld(t, { initialPolicy: "model", owns: { critic: ["acceptance"], actor: ["docs", "README.md"] } });
  const wave1 = w.addWave({ round: 2, file: "docs/guide.md", content: "# Guide\n\nWave 1\n", actorAgent: agObs("gemini-2.5-flash"), judgeAgent: agObs("gemini-2.5-pro"), markDone: true });
  assertAllFourAccept(w, wave1.commit, w.openWin(2, 2));

  const wave2 = w.addWave({ round: 3, file: "docs/guide.md", content: "# Guide\n\nWave 2 unjudged\n", actorAgent: agObs("gemini-2.5-flash") });
  const win2 = w.openWin(3, 2);
  assert.equal(w.verifyProv(wave2.commit, "master").ok, false);
  assert.notEqual(w.verifyPush(wave2.commit, "master").status, 0);
  assert.notEqual(w.closeWin(win2, wave2.commit).status, 0);
  const next2 = w.loopNext();
  assert.equal(next2.status, 0, next2.stderr);
  assert.doesNotMatch(next2.stdout, /The recorded convergence checks are satisfied/);
});

test("[R47-ATK-01] missing or corrupted historical loop.json at C_jh or C_row fails closed across all four gates [loss: false-verdict]", t => {
  for (const mode of ["missing-loop", "invalid-policy-at-row", "corrupt-json-at-jh"]) {
    const w = makeHistoryWorld(t, { initialPolicy: mode === "invalid-policy-at-row" ? "vendor" : undefined, commitLoopJson: mode !== "missing-loop" });
    const w1 = w.addActor({ round: 2, base: w.baseline, file: "scripts/w1.mjs", actorAgent: agObs("gemini-2.5-pro") });
    if (mode === "corrupt-json-at-jh") w.setRawLoop("{corrupt");
    w.addJudge({
      round: 2, commit: w1.commit, judgeAgent: codexNoObs(), needsPkg: w1.pkg, rawJudge: mode === "corrupt-json-at-jh",
      between: mode === "invalid-policy-at-row" ? () => w.setPolicy("bogus") : null,
    });
    w.setPolicy("model");
    const w2 = w.addActor({ round: 3, base: w1.commit, file: "scripts/w2.mjs", actorAgent: agObs("gemini-2.5-flash") });
    w.addJudge({ round: 3, commit: w2.commit, judgeAgent: agObs("gemini-2.5-pro"), needsPkg: w2.pkg, markDone: true });
    assertAllFourRefuse(w, w2.commit, w.openWin(3, 3));
  }
});

test("[R47-ATK-02] mid-round policy switches between jh.view, C_jh, and C_row enforce every governing policy across all four gates [loss: false-verdict]", t => {
  const wA = makeHistoryWorld(t, { initialPolicy: "vendor" });
  const w1A = wA.addActor({ round: 2, base: wA.baseline, file: "scripts/w1.mjs", actorAgent: agObs("gemini-2.5-pro") });
  const viewVendor = git(wA.records, "rev-parse", "HEAD");
  wA.setPolicy("model");
  wA.addJudge({ round: 2, commit: w1A.commit, judgeAgent: codexNoObs(), needsPkg: w1A.pkg, viewOverride: viewVendor });
  const w2A = wA.addActor({ round: 3, base: w1A.commit, file: "scripts/w2.mjs", actorAgent: agObs("gemini-2.5-flash") });
  wA.addJudge({ round: 3, commit: w2A.commit, judgeAgent: agObs("gemini-2.5-pro"), needsPkg: w2A.pkg, markDone: true });
  assertAllFourRefuse(wA, w2A.commit, wA.openWin(3, 3));

  const wB = makeHistoryWorld(t, { initialPolicy: "model" });
  const w1B = wB.addActor({ round: 2, base: wB.baseline, file: "scripts/w1.mjs", actorAgent: agObs("gemini-2.5-pro") });
  const viewModel = git(wB.records, "rev-parse", "HEAD");
  wB.setPolicy("vendor");
  wB.addJudge({ round: 2, commit: w1B.commit, judgeAgent: codexNoObs(), needsPkg: w1B.pkg, viewOverride: viewModel });
  const w2B = wB.addActor({ round: 3, base: w1B.commit, file: "scripts/w2.mjs", actorAgent: obs("t3:codex", "gpt-5.4-mini") });
  wB.addJudge({ round: 3, commit: w2B.commit, judgeAgent: agObs("gemini-2.5-pro"), needsPkg: w2B.pkg, markDone: true });
  assertAllFourRefuse(wB, w2B.commit, wB.openWin(3, 3));

  const wC = makeHistoryWorld(t, { initialPolicy: "vendor" });
  const w1C = wC.addActor({ round: 2, base: wC.baseline, file: "scripts/w1.mjs", actorAgent: agObs("gemini-2.5-pro") });
  const viewC = git(wC.records, "rev-parse", "HEAD");
  wC.setPolicy("model");
  wC.addJudge({ round: 2, commit: w1C.commit, judgeAgent: openaiObs("gpt-5.4"), needsPkg: w1C.pkg, viewOverride: viewC });
  const w2C = wC.addActor({ round: 3, base: w1C.commit, file: "scripts/w2.mjs", actorAgent: agObs("gemini-2.5-flash") });
  wC.addJudge({ round: 3, commit: w2C.commit, judgeAgent: agObs("gemini-2.5-pro"), needsPkg: w2C.pkg, markDone: true });
  assertAllFourAccept(wC, w2C.commit, wC.openWin(3, 3));
});

test("[R47-ATK-03] non-ancestor side-branch judge and same-commit prior ruling cannot retire actors on target lineage [loss: false-verdict]", t => {
  const w = makeHistoryWorld(t, { initialPolicy: "model" });
  const w1 = w.addActor({ round: 2, base: w.baseline, file: "scripts/w1.mjs", actorAgent: agObs("gemini-2.5-pro") });
  const side = w.addActor({ round: 2, base: w1.commit, file: "scripts/side.mjs", actorAgent: agObs("gemini-2.5-pro-exp"), step: "actor-side" });
  w.addJudge({ round: 2, commit: side.commit, judgeAgent: agObs("gemini-2.5-flash"), needsPkg: side.pkg, step: "judge-side" });
  const w2 = w.addActor({ round: 3, base: w1.commit, file: "scripts/w2.mjs", actorAgent: agObs("gemini-2.5-flash") });
  w.addJudge({ round: 3, commit: w2.commit, judgeAgent: agObs("gemini-2.5-pro"), needsPkg: w2.pkg, markDone: true });
  git(w.product, "branch", "-f", "loop/v1", w2.commit);
  assertAllFourRefuse(w, w2.commit, w.openWin(3, 3));

  const wSelf = makeHistoryWorld(t, { initialPolicy: "model" });
  const s1 = wSelf.addActor({ round: 2, base: wSelf.baseline, file: "scripts/s1.mjs", actorAgent: agObs("gemini-2.5-pro") });
  wSelf.addJudge({ round: 2, commit: s1.commit, judgeAgent: openaiObs("gpt-5.4"), needsPkg: s1.pkg });
  wSelf.addJudge({ round: 3, commit: s1.commit, judgeAgent: agObs("gemini-2.5-pro"), needsPkg: s1.pkg, markDone: true });
  assert.notEqual(wSelf.closeWin(wSelf.openWin(2, 3), s1.commit).status, 0);
  assert.match(wSelf.loopNext().stdout, /judge\/actor independence needs confirmation/);
});

test("[R47-ATK-05] external-config fixture without committed loop.json fails closed to currentPolicy and never downgrades model to vendor [loss: false-verdict]", t => {
  const w = makeHistoryWorld(t, { commitLoopJson: false });
  const extCfg = w.writeExtCfg("model");
  const w1 = w.addActor({ round: 2, base: w.baseline, file: "scripts/w1.mjs", actorAgent: agObs("gemini-2.5-pro") });
  w.addJudge({ round: 2, commit: w1.commit, judgeAgent: codexNoObs(), needsPkg: w1.pkg });
  const w2 = w.addActor({ round: 3, base: w1.commit, file: "scripts/w2.mjs", actorAgent: agObs("gemini-2.5-flash") });
  w.addJudge({ round: 3, commit: w2.commit, judgeAgent: agObs("gemini-2.5-pro"), needsPkg: w2.pkg, markDone: true });
  const winId = w.openWin(3, 3);
  const extPath = join(w.dir, "ext-loop.json");

  const cov = evaluateCertifiedWaveCoverage({
    repo: w.product, records: w.records, cfg: extCfg, targetCommit: w2.commit,
    judge: { id: "R-0003-judge", role: "judge", round: 3, agent: agObs("gemini-2.5-pro"), product: { base: w2.commit, commit: w2.commit } },
  });
  assert.equal(cov.ok, false);
  assert.deepEqual(cov.priorConverged, []);
  assert.equal(w.verifyProv(w2.commit, "master", extCfg).ok, false);
  assert.notEqual(w.closeWin(winId, w2.commit, extPath).status, 0);
  const next = w.loopNext(extPath);
  assert.equal(next.status, 0, next.stderr);
  assert.match(next.stdout, /judge\/actor independence needs confirmation/);
});

test("[R48-ATK-01] certified doc commit rewinds VERSION tip cleanly past read-only tip handoffs and refuses trailing unattested code commits [loss: false-verdict]", t => {
  const w = makeHistoryWorld(t, { initialPolicy: "model" });
  const doc1 = w.addActor({ round: 2, base: w.baseline, file: "docs/guide.md", actorAgent: agObs("gemini-2.5-flash") });
  const tip1 = commitProduct(w.product, "VERSION", "0.2.0\n", "Bump 0.2.0", doc1.commit);
  git(w.product, "branch", "-f", "loop/v1", tip1.commit);
  w.addJudge({ round: 2, commit: doc1.commit, tip: tip1.commit, tipTree: tip1.tree, judgeAgent: agObs("gemini-2.5-pro"), needsPkg: doc1.pkg, markDone: true });
  const view = git(w.records, "rev-parse", "HEAD");
  for (const [id, step, role, agent, dispatch] of [
    ["R-0002-reviewer-tip", "reviewer-tip", "reviewer", obs("t3:claude", "claude-opus-4-6"), undefined],
    ["R-0002-judge-frame", "judge-frame", "judge", agObs("gemini-2.5-pro"), undefined],
    ["R-0002-critic-tip", "critic-tip", "critic", codexObs("gpt-5.4"), { plan: "PL-0001", package: doc1.pkg, files: [] }],
  ]) {
    const rec = `rounds/0002-${step}.md`;
    put(w.records, rec, `# ${id}\n`);
    appendFile(w.records, "metrics/handoffs.jsonl", jsonl({
      id, time: "2026-11-26T04:00:00Z", phase: "v1", round: 2, step, role, attempt: 1, agent, view,
      product: { base: tip1.commit, commit: tip1.commit }, audit: { violations: 0 }, record: rec, files: [rec], ...(dispatch ? { dispatch } : {}),
    }));
  }
  w.commitRecords("Record read-only tip handoffs");
  const cov = evaluateCertifiedWaveCoverage({ repo: w.product, records: w.records, targetCommit: tip1.commit, evaluateJudge: false });
  assert.equal(cov.judgedCommit, doc1.commit);
  assert.deepEqual(cov.actors.map(a => a.id), ["R-0002-actor"]);
  assertAllFourAccept(w, tip1.commit, w.openWin(2, 3));

  const bad = commitProduct(w.product, "scripts/foo.mjs", "export const bad = 1;\n", "Unattested code", tip1.commit);
  git(w.product, "branch", "-f", "loop/v1", bad.commit);
  assert.equal(w.verifyProv(bad.commit, "master").ok, false);
  assert.notEqual(w.verifyPush(bad.commit, "master").status, 0);
  const winBad = w.openWin(3, 3);
  assert.notEqual(w.closeWin(winBad, bad.commit).status, 0);
  assert.match(w.loopNext().stdout, /is ahead of the integration SHA .* by commits no hand-off records/);
  put(w.records, "rounds/0003-actor-unplanned.md", "# R-0003-actor-unplanned\n");
  appendFile(w.records, "metrics/handoffs.jsonl", jsonl({
    id: "R-0003-actor-unplanned", time: "2026-11-26T05:00:00Z", phase: "v1", round: 3, step: "actor-unplanned", role: "actor", attempt: 1,
    agent: agObs("gemini-2.5-flash"), view, product: { base: tip1.commit, commit: bad.commit }, audit: { violations: 0 },
    record: "rounds/0003-actor-unplanned.md", files: ["rounds/0003-actor-unplanned.md"],
  }));
  w.commitRecords("Record unplanned bad actor");
  assert.equal(w.verifyProv(bad.commit, "master").ok, false);
  assert.notEqual(w.verifyPush(bad.commit, "master").status, 0);
  assert.notEqual(w.closeWin(winBad, bad.commit).status, 0);
  assert.doesNotMatch(w.loopNext().stdout, /The recorded convergence checks are satisfied/);
});

test("[R47-ATK-04+R48-ATK-02] multi-wave attested doc commits with VERSION tips retire Wave 1, accept Wave 2, and refuse uncertified or overlapping Wave 3 [loss: false-verdict]", t => {
  const w = makeHistoryWorld(t, { initialPolicy: "model" });
  const doc1 = w.addActor({ round: 2, base: w.baseline, file: "docs/guide.md", actorAgent: agObs("gemini-2.5-pro") });
  w.addJudge({ round: 2, commit: doc1.commit, judgeAgent: agObs("gemini-2.5-flash"), needsPkg: doc1.pkg });
  const doc2 = w.addActor({ round: 3, base: doc1.commit, file: "docs/guide.md", actorAgent: agObs("gemini-2.5-flash") });
  const tip2 = commitProduct(w.product, "VERSION", "0.2.0\n", "Bump 0.2.0", doc2.commit);
  git(w.product, "branch", "-f", "loop/v1", tip2.commit);
  w.addJudge({ round: 3, commit: doc2.commit, tip: tip2.commit, tipTree: tip2.tree, judgeAgent: agObs("gemini-2.5-pro"), needsPkg: doc2.pkg, markDone: true });
  assertAllFourAccept(w, tip2.commit, w.openWin(3, 3));

  const doc3 = w.addActor({ round: 4, base: tip2.commit, file: "docs/guide.md", actorAgent: agObs("gemini-2.5-pro-exp") });
  const tip3 = commitProduct(w.product, "VERSION", "0.3.0\n", "Bump 0.3.0", doc3.commit);
  git(w.product, "branch", "-f", "loop/v1", tip3.commit);
  assert.equal(w.verifyProv(tip3.commit, "master").ok, false);
  assert.notEqual(w.verifyPush(tip3.commit, "master").status, 0);

  w.addJudge({ round: 4, commit: doc3.commit, tip: tip3.commit, tipTree: tip3.tree, judgeAgent: agObs("gemini-2.5-pro-exp"), needsPkg: doc3.pkg });
  const cov3 = evaluateCertifiedWaveCoverage({ repo: w.product, records: w.records, targetCommit: tip3.commit, evaluateJudge: false });
  assert.equal(cov3.judgedCommit, doc3.commit);
  assert.deepEqual(cov3.priorConverged, [doc1.commit, doc2.commit]);
  assertAllFourRefuse(w, tip3.commit, w.openWin(4, 3));
});
