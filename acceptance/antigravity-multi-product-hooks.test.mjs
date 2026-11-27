// F-0008, F-0009, F-0010, D-0052, D-0060, D-0061, R-0032-reviewer-architecture
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { parseShellWords } from "../scripts/lib/hooks.mjs";
import { committedWords } from "../scripts/lib/owner-words.mjs";
import { git, isolatedEnv, loopProduct, ownerStore, repo, scripts, selfLoop, temp } from "../scripts/test/helpers.mjs";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
const realTemp = prefix => realpathSync(temp(prefix));

function wrapEnvelope(body) {
  return [
    "<USER_REQUEST>",
    "<t3_code_instructions>",
    "## Mode",
    "</t3_code_instructions>",
    "",
    `<user_request>\n${body}\n</user_request><runtime_info>info</runtime_info>`,
    "</USER_REQUEST>",
    "<ADDITIONAL_METADATA>",
    "2026-11-23",
    "</ADDITIONAL_METADATA>",
  ].join("\n");
}

function makeProduct(name) {
  const dir = realTemp(`ag-mp-${name}-`);
  const { product, records } = loopProduct({ activity: "2026-11-23T01:00:00.000Z", dir });
  mkdirSync(join(product, "docs"), { recursive: true });
  writeFileSync(join(product, "docs", "GUIDE.md"), `# ${name} guide\n`);
  git(product, "add", "docs/GUIDE.md");
  git(product, "commit", "-qm", "docs");
  git(product, "branch", "-f", "loop/v1");
  writeFileSync(join(product, ".git", "info", "exclude"), "/.agents/hooks.json\n/scratch.tmp\n");
  const workDir = join(dir, "work");
  mkdirSync(workDir, { recursive: true });
  return { dir, product, records, workDir };
}

function writeTranscript(appDir, id, rows) {
  const logs = join(appDir, "brain", id, ".system_generated", "logs");
  mkdirSync(logs, { recursive: true });
  const file = join(logs, "transcript_full.jsonl");
  writeFileSync(file, rows.map(r => JSON.stringify(r)).join("\n") + "\n");
  return file;
}

const userStep = (step_index, content, extra = {}) => ({
  step_index,
  source: "USER_EXPLICIT",
  type: "USER_INPUT",
  status: "DONE",
  created_at: new Date().toISOString(),
  content,
  ...extra,
});

function runCli(scriptName, cliArgs, payload, env) {
  return spawnSync(process.execPath, [join(scripts, scriptName), ...cliArgs], {
    input: JSON.stringify(payload),
    cwd: realTemp("ag-mp-hook-cwd-"),
    encoding: "utf8",
    env,
  });
}

function assertDeny(res, pattern, label) {
  assert.equal(res.status, 0, `${label}: exit ${res.status}, stderr=${res.stderr}`);
  let out;
  try { out = JSON.parse(res.stdout); }
  catch { assert.fail(`${label}: expected JSON deny on stdout, got ${JSON.stringify(res.stdout)} (stderr=${res.stderr})`); }
  assert.equal(out.decision, "deny", `${label}: ${res.stdout}`);
  assert.match(out.reason, /^lead-guard:/, `${label}: ${res.stdout}`);
  if (pattern) assert.match(out.reason, pattern, `${label}: ${res.stdout}`);
}

function assertAllow(res, label) {
  assert.equal(res.status, 0, `${label}: exit ${res.status}, stderr=${res.stderr}`);
  assert.equal(res.stdout, "", `${label}: expected empty pass-through, got ${JSON.stringify(res.stdout)}`);
  assert.doesNotMatch(res.stdout, /"decision"\s*:\s*"allow"/, label);
}

// R-0032-reviewer-architecture, design/mandatory-control-plane.md#2
test("AG-MP-01: multi-product lead-guard enforces code, linked worktree, role workspace, tasks, allowlist, unregistered repo, and git push", () => {
  const alpha = makeProduct("alpha");
  const beta = makeProduct("beta");
  const betaLeadWt = realTemp("ag-mp-beta-lead-wt-");
  git(beta.product, "worktree", "add", "-q", "--detach", betaLeadWt);

  const alphaActorWs = join(alpha.workDir, "0001-actor");
  const alphaActorWt = join(alphaActorWs, "wt");
  mkdirSync(alphaActorWs, { recursive: true });
  git(alpha.product, "worktree", "add", "-q", "--detach", alphaActorWt);

  const betaActorWs = join(beta.workDir, "0001-actor");
  const betaActorWt = join(betaActorWs, "wt");
  mkdirSync(betaActorWs, { recursive: true });
  git(beta.product, "worktree", "add", "-q", "--detach", betaActorWt);

  const gamma = repo({ "src/c.js": "export const c = 3;\n" }, realTemp("ag-mp-gamma-"));
  const store = ownerStore([
    { name: "alpha", records: alpha.records },
    { name: "beta", records: beta.records },
  ], { dir: realTemp("ag-mp-store-") });
  const env = isolatedEnv({ T3CODE_HOME: "" });
  const guardArgs = ["--harness", "antigravity", "--owner-store", store];

  for (const [label, cwd, toolCall] of [
    ["alpha tracked args", alpha.product, { name: "write_file", args: { Path: "src/a.js" } }],
    ["alpha untracked argumentsJson", alpha.product, { name: "write_to_file", argumentsJson: JSON.stringify({ TargetFile: "src/new.js" }) }],
    ["beta tracked args", beta.product, { name: "edit_file", args: { Path: "src/a.js" } }],
    ["beta untracked argumentsJson", beta.product, { name: "write_file", argumentsJson: JSON.stringify({ Path: join(beta.product, "src/new.js") }) }],
    ["beta linked wt relative args", betaLeadWt, { name: "replace_file_content", args: { Path: "src/a.js" } }],
    ["beta linked wt untracked argumentsJson", betaLeadWt, { name: "write_file", argumentsJson: JSON.stringify({ AbsolutePath: join(betaLeadWt, "src/new.js") }) }],
  ]) {
    const res = runCli("lead-guard.mjs", guardArgs, { hookEventName: "PreToolUse", conversationId: "c1", cwd, toolCall }, env);
    assertDeny(res, /product code/, label);
  }

  for (const [label, toolCall] of [
    ["alpha call.json args", { name: "write_file", args: { Path: join(alphaActorWs, "call.json") } }],
    ["alpha out/report.md argumentsJson", { name: "write_file", argumentsJson: JSON.stringify({ Path: join(alphaActorWs, "out", "report.md") }) }],
    ["alpha role wt args", { name: "edit_file", args: { Path: join(alphaActorWt, "src", "a.js") } }],
    ["beta call.json argumentsJson", { name: "write_file", argumentsJson: JSON.stringify({ Path: join(betaActorWs, "call.json") }) }],
    ["beta out/report.md args", { name: "write_file", args: { Path: join(betaActorWs, "out", "report.md") } }],
    ["beta role wt argumentsJson", { name: "write_file", argumentsJson: JSON.stringify({ Path: join(betaActorWt, "src", "a.js") }) }],
  ]) {
    const res = runCli("lead-guard.mjs", guardArgs, { hookEventName: "PreToolUse", conversationId: "c1", cwd: alpha.product, toolCall }, env);
    assertDeny(res, /tasks\//, label);
  }

  for (const [label, cwd, toolCall] of [
    ["alpha tasks", alpha.product, { name: "write_file", argumentsJson: JSON.stringify({ Path: join(alpha.workDir, "tasks", "R-0001-actor.md") }) }],
    ["beta tasks", beta.product, { name: "write_file", argumentsJson: JSON.stringify({ Path: join(beta.workDir, "tasks", "R-0001-actor.md") }) }],
    ["alpha docs", alpha.product, { name: "edit_file", args: { Path: "docs/GUIDE.md" } }],
    ["beta docs", beta.product, { name: "edit_file", argumentsJson: JSON.stringify({ Path: "docs/GUIDE.md" }) }],
    ["beta linked wt docs", betaLeadWt, { name: "edit_file", argumentsJson: JSON.stringify({ Path: "docs/GUIDE.md" }) }],
    ["alpha gitignored", alpha.product, { name: "write_file", args: { Path: ".agents/hooks.json" } }],
    ["beta linked wt gitignored", betaLeadWt, { name: "write_file", argumentsJson: JSON.stringify({ Path: "scratch.tmp" }) }],
    ["unregistered gamma relative", gamma, { name: "write_file", args: { Path: "src/c.js" } }],
    ["unregistered gamma abs", alpha.product, { name: "write_file", argumentsJson: JSON.stringify({ Path: join(gamma, "src/c.js") }) }],
    ["gated-push.mjs allowed", alpha.product, { name: "run_command", argumentsJson: JSON.stringify({ CommandLine: "node scripts/gated-push.mjs --repo . --branch loop/v1" }) }],
  ]) {
    const res = runCli("lead-guard.mjs", guardArgs, { hookEventName: "PreToolUse", conversationId: "c1", cwd, toolCall }, env);
    assertAllow(res, label);
  }

  for (const [label, toolCall] of [
    ["run_command args", { name: "run_command", args: { CommandLine: "git push origin loop/v1" } }],
    ["run_command argumentsJson", { name: "run_command", argumentsJson: JSON.stringify({ CommandLine: "git push --no-verify origin loop/v1" }) }],
    ["shell_exec args", { name: "shell_exec", args: { command: "git push origin main" } }],
    ["shell_exec argumentsJson", { name: "shell_exec", argumentsJson: JSON.stringify({ command: "git -c core.hooksPath=/dev/null push origin main" }) }],
  ]) {
    const res = runCli("lead-guard.mjs", guardArgs, { hookEventName: "PreToolUse", conversationId: "c1", cwd: beta.product, toolCall }, env);
    assertDeny(res, /gated-push\.mjs/, label);
  }
});

// R-0032-reviewer-architecture, design/mandatory-control-plane.md#2
test("AG-MP-02: cross-product call.json nonces admit delegation and registry add protects new product without hook reinstall", () => {
  const alpha = makeProduct("alpha");
  const beta = makeProduct("beta");
  const store = ownerStore([
    { name: "alpha", records: alpha.records },
    { name: "beta", records: beta.records },
  ], { dir: realTemp("ag-mp2-store-") });
  const gHome = realTemp("ag-mp2-g-");
  const env = isolatedEnv({ GEMINI_HOME: gHome, T3CODE_HOME: "" });

  const inst = selfLoop(["hooks", "install", "--harness", "antigravity", "--scope", "global", "--owner-store", store], { cwd: realTemp("ag-mp2-cwd-"), env });
  assert.equal(inst.status, 0, inst.stdout + inst.stderr);
  const hooksFile = join(gHome, "config", "hooks.json");
  const installedCmd = parseShellWords(JSON.parse(readFileSync(hooksFile, "utf8"))["self-loop"].PreToolUse[0].hooks[0].command);
  const runInstalledGuard = payload => spawnSync(installedCmd[0], installedCmd.slice(1), {
    input: JSON.stringify(payload),
    cwd: realTemp("ag-mp2-hook-cwd-"),
    encoding: "utf8",
    env,
  });

  const makeManifest = (product, name, meta) => {
    const ws = join(product.workDir, name);
    mkdirSync(ws, { recursive: true });
    let wt = meta.wt;
    if (wt === "make") {
      wt = join(ws, "wt");
      git(product.product, "worktree", "add", "-q", "--detach", wt);
    }
    writeFileSync(join(ws, "call.json"), JSON.stringify({ ws, ...meta, wt }));
    return { ws, wt, nonce: meta.nonce };
  };

  const alphaLive = makeManifest(alpha, "0001-actor", { nonce: "aaaa1111bbbb2222", wt: "make" });
  const betaLive = makeManifest(beta, "0001-critic", { nonce: "cccc3333dddd4444", wt: "make" });
  const alphaRec = makeManifest(alpha, "0001-recorded", { nonce: "1111222233334444", wt: "make", recorded: true });
  const betaCan = makeManifest(beta, "0001-cancelled", { nonce: "5555666677778888", wt: "make", cancelled: true });

  for (const [label, nonce] of [["alpha live", alphaLive.nonce], ["beta live", betaLive.nonce]]) {
    const res = runInstalledGuard({
      hookEventName: "PreToolUse",
      conversationId: "c1",
      cwd: alpha.product,
      toolCall: { name: "mcp_t3-code_delegate_task", argumentsJson: JSON.stringify({ task: `self-loop call · nonce ${nonce}` }) },
    });
    assertAllow(res, label);
  }

  for (const [label, task] of [
    ["alpha recorded", `self-loop call · nonce ${alphaRec.nonce}`],
    ["beta cancelled", `self-loop call · nonce ${betaCan.nonce}`],
    ["missing nonce", "self-loop call without nonce"],
  ]) {
    const res = runInstalledGuard({
      hookEventName: "PreToolUse",
      conversationId: "c1",
      cwd: beta.product,
      toolCall: { name: "mcp_t3-code_delegate_task", argumentsJson: JSON.stringify({ task }) },
    });
    assertDeny(res, /nonce/, label);
  }

  const gamma = makeProduct("gamma");
  const regAdd = selfLoop(["registry", "add", "--owner-store", store, "--name", "gamma", "--records", gamma.records], { env });
  assert.equal(regAdd.status, 0, regAdd.stdout + regAdd.stderr);
  const gammaLive = makeManifest(gamma, "0001-actor", { nonce: "eeee9999ffff0000", wt: "make" });

  assertDeny(runInstalledGuard({
    hookEventName: "PreToolUse",
    conversationId: "c1",
    cwd: gamma.product,
    toolCall: { name: "write_file", argumentsJson: JSON.stringify({ Path: "src/a.js" }) },
  }), /product code/, "gamma product write without reinstall");

  assertDeny(runInstalledGuard({
    hookEventName: "PreToolUse",
    conversationId: "c1",
    cwd: gamma.product,
    toolCall: { name: "write_file", argumentsJson: JSON.stringify({ Path: join(gammaLive.ws, "out", "report.md") }) },
  }), /tasks\//, "gamma workspace write without reinstall");

  assertAllow(runInstalledGuard({
    hookEventName: "PreToolUse",
    conversationId: "c1",
    cwd: gamma.product,
    toolCall: { name: "write_file", argumentsJson: JSON.stringify({ Path: join(gamma.workDir, "tasks", "R-0001-actor.md") }) },
  }), "gamma tasks write without reinstall");

  assertAllow(runInstalledGuard({
    hookEventName: "PreToolUse",
    conversationId: "c1",
    cwd: gamma.product,
    toolCall: { name: "mcp_t3-code_delegate_task", argumentsJson: JSON.stringify({ task: `self-loop call R-0001-actor · nonce ${gammaLive.nonce}` }) },
  }), "gamma live nonce without reinstall");
});

// R-0032-reviewer-architecture, design/mandatory-control-plane.md#2
test("AG-MP-03: lead-guard fails closed with deny across all 8 --owner-store corruption states", () => {
  const env = isolatedEnv({ T3CODE_HOME: "" });
  const benignPayload = cwd => ({
    hookEventName: "PreToolUse",
    conversationId: "c1",
    cwd,
    toolCall: { name: "read_file", argumentsJson: JSON.stringify({ Path: "src/a.js" }) },
  });

  assertDeny(runCli("lead-guard.mjs", ["--harness", "antigravity", "--owner-store", ""], benignPayload(realTemp("ag-c-a-")), env), /owner-store/, "a: empty --owner-store");

  const missingStore = realTemp("ag-c-b-");
  assertDeny(runCli("lead-guard.mjs", ["--harness", "antigravity", "--owner-store", missingStore], benignPayload(missingStore), env), /products\.json|registry/, "b: missing products.json");

  const malformedStore = ownerStore([], { dir: realTemp("ag-c-c-") });
  writeFileSync(join(malformedStore, "products.json"), "{not-valid-json");
  assertDeny(runCli("lead-guard.mjs", ["--harness", "antigravity", "--owner-store", malformedStore], benignPayload(malformedStore), env), /JSON|products\.json/, "c: malformed products.json");

  const prodD = makeProduct("alpha");
  const storeD = ownerStore([{ name: "alpha", records: prodD.records }], { dir: realTemp("ag-c-d-") });
  rmSync(prodD.records, { recursive: true, force: true });
  assertDeny(runCli("lead-guard.mjs", ["--harness", "antigravity", "--owner-store", storeD], benignPayload(prodD.product), env), /records directory|does not exist/, "d: missing records dir");

  const prodE = makeProduct("alpha");
  const storeE = ownerStore([{ name: "alpha", records: prodE.records }], { dir: realTemp("ag-c-e-") });
  rmSync(join(prodE.records, "loop.json"));
  assertDeny(runCli("lead-guard.mjs", ["--harness", "antigravity", "--owner-store", storeE], benignPayload(prodE.product), env), /loop\.json/, "e: missing loop.json");

  const prodF = makeProduct("alpha");
  const storeF = ownerStore([{ name: "alpha", records: prodF.records }], { dir: realTemp("ag-c-f-") });
  writeFileSync(join(prodF.records, "loop.json"), "{bad-json");
  assertDeny(runCli("lead-guard.mjs", ["--harness", "antigravity", "--owner-store", storeF], benignPayload(prodF.product), env), /loop\.json/, "f: malformed loop.json");

  const prodG = makeProduct("alpha");
  const storeG = ownerStore([{ name: "alpha", records: prodG.records }], { dir: realTemp("ag-c-g-") });
  const nonGitDir = realTemp("ag-c-nongit-");
  const loopG = JSON.parse(readFileSync(join(prodG.records, "loop.json"), "utf8"));
  loopG.product = nonGitDir;
  writeFileSync(join(prodG.records, "loop.json"), JSON.stringify(loopG, null, 2) + "\n");
  assertDeny(runCli("lead-guard.mjs", ["--harness", "antigravity", "--owner-store", storeG], benignPayload(nonGitDir), env), /Git repository/, "g: non-git product");

  const strayParent = realTemp("ag-c-stray-");
  mkdirSync(join(strayParent, ".git", "info"), { recursive: true });
  const nonGitUnderStray = join(strayParent, "non-git-child");
  mkdirSync(nonGitUnderStray, { recursive: true });
  loopG.product = nonGitUnderStray;
  writeFileSync(join(prodG.records, "loop.json"), JSON.stringify(loopG, null, 2) + "\n");
  assertDeny(runCli("lead-guard.mjs", ["--harness", "antigravity", "--owner-store", storeG], benignPayload(nonGitUnderStray), env), /Git repository/, "h: non-git product under stray ancestor .git dir");
});

// R-0032-reviewer-architecture, design/antigravity-harness.md#lifecycle-hooks-adapter
test("AG-MP-04: multi-product PreInvocation and Stop route alpha, beta, linked worktree, skip scratch/child, and bound store corruption", () => {
  const alpha = makeProduct("alpha");
  const beta = makeProduct("beta");
  const betaLeadWt = realTemp("ag-mp4-beta-wt-");
  git(beta.product, "worktree", "add", "-q", "--detach", betaLeadWt);

  const alphaChildWs = join(alpha.workDir, "0001-actor");
  const alphaChildWt = join(alphaChildWs, "wt");
  mkdirSync(alphaChildWs, { recursive: true });
  git(alpha.product, "worktree", "add", "-q", "--detach", alphaChildWt);

  const scratch = realTemp("ag-mp4-scratch-");
  const store = ownerStore([
    { name: "alpha", records: alpha.records },
    { name: "beta", records: beta.records },
  ], { dir: realTemp("ag-mp4-store-") });
  const appDir = realTemp("ag-mp4-app-");
  const tmpGate = realTemp("ag-mp4-tmp-");
  const env = isolatedEnv({
    ANTIGRAVITY_APP_DATA_DIR: appDir,
    GEMINI_HOME: realTemp("ag-mp4-g-"),
    T3CODE_HOME: "",
    T3CODE_THREAD_ID: "",
    TMPDIR: tmpGate,
  });

  const alphaTx = writeTranscript(appDir, "conv-alpha", [userStep(0, wrapEnvelope("Alpha owner directive"))]);
  const capAlpha = runCli("owner-words.mjs", ["capture", "--harness", "antigravity", "--owner-store", store], {
    hookEventName: "PreInvocation",
    conversationId: "conv-alpha",
    cwd: alpha.product,
    invocationNum: 0,
    initialNumSteps: 1,
    lastUserInput: wrapEnvelope("Alpha owner directive"),
    transcriptPath: alphaTx,
  }, env);
  assert.equal(capAlpha.status, 0, capAlpha.stderr);
  assert.deepEqual(JSON.parse(capAlpha.stdout), {});
  assert.deepEqual(committedWords(alpha.records).map(w => w.text), ["Alpha owner directive"]);
  assert.deepEqual(committedWords(beta.records), []);

  const stopAlpha = runCli("word-gate.mjs", ["--harness", "antigravity", "--owner-store", store, "--max-blocks", "2"], {
    hookEventName: "Stop",
    conversationId: "conv-alpha",
    cwd: alpha.product,
    transcriptPath: alphaTx,
    terminationReason: "NO_TOOL_CALL",
    fullyIdle: true,
    continuationActive: false,
  }, env);
  assert.equal(stopAlpha.status, 0, stopAlpha.stderr);
  const alphaId = committedWords(alpha.records)[0].id;
  const stopAlphaJson = JSON.parse(stopAlpha.stdout);
  assert.equal(stopAlphaJson.decision, "continue");
  assert.ok(stopAlphaJson.reason.includes(alphaId), stopAlphaJson.reason);

  const betaMainTx = writeTranscript(appDir, "conv-beta-main", [userStep(0, wrapEnvelope("Beta primary directive"))]);
  const capBetaMain = runCli("owner-words.mjs", ["capture", "--harness", "antigravity", "--owner-store", store], {
    hookEventName: "PreInvocation",
    conversationId: "conv-beta-main",
    cwd: beta.product,
    invocationNum: 0,
    initialNumSteps: 1,
    lastUserInput: wrapEnvelope("Beta primary directive"),
    transcriptPath: betaMainTx,
  }, env);
  assert.equal(capBetaMain.status, 0, capBetaMain.stderr);
  assert.deepEqual(JSON.parse(capBetaMain.stdout), {});
  assert.deepEqual(committedWords(beta.records).map(w => w.text), ["Beta primary directive"]);
  assert.equal(committedWords(alpha.records).length, 1);

  const stopBetaMain = runCli("word-gate.mjs", ["--harness", "antigravity", "--owner-store", store, "--max-blocks", "2"], {
    hookEventName: "Stop",
    conversationId: "conv-beta-main",
    cwd: beta.product,
    transcriptPath: betaMainTx,
    terminationReason: "NO_TOOL_CALL",
    fullyIdle: true,
    continuationActive: false,
  }, env);
  const betaMainId = committedWords(beta.records)[0].id;
  const stopBetaMainJson = JSON.parse(stopBetaMain.stdout);
  assert.equal(stopBetaMainJson.decision, "continue");
  assert.ok(stopBetaMainJson.reason.includes(betaMainId), stopBetaMainJson.reason);
  assert.equal(stopBetaMainJson.reason.includes(alphaId), false);

  const betaWtTx = writeTranscript(appDir, "conv-beta-wt", [userStep(0, wrapEnvelope("Beta worktree directive"))]);
  const capBetaWt = runCli("owner-words.mjs", ["capture", "--harness", "antigravity", "--owner-store", store], {
    hookEventName: "PreInvocation",
    conversationId: "conv-beta-wt",
    workspacePaths: [pathToFileURL(betaLeadWt).href],
    invocationNum: 0,
    initialNumSteps: 1,
    lastUserInput: wrapEnvelope("Beta worktree directive"),
    transcriptPath: betaWtTx,
  }, env);
  assert.equal(capBetaWt.status, 0, capBetaWt.stderr);
  assert.deepEqual(JSON.parse(capBetaWt.stdout), {});
  assert.deepEqual(committedWords(beta.records).map(w => w.text), ["Beta primary directive", "Beta worktree directive"]);
  assert.equal(committedWords(alpha.records).length, 1);

  const stopBetaWt = runCli("word-gate.mjs", ["--harness", "antigravity", "--owner-store", store, "--max-blocks", "2"], {
    hookEventName: "Stop",
    conversationId: "conv-beta-wt",
    workspacePaths: [pathToFileURL(betaLeadWt).href],
    transcriptPath: betaWtTx,
    terminationReason: "NO_TOOL_CALL",
    fullyIdle: true,
    continuationActive: false,
  }, env);
  const betaWtId = committedWords(beta.records)[1].id;
  const stopBetaWtJson = JSON.parse(stopBetaWt.stdout);
  assert.equal(stopBetaWtJson.decision, "continue");
  assert.ok(stopBetaWtJson.reason.includes(betaWtId), stopBetaWtJson.reason);

  const scratchTx = writeTranscript(appDir, "conv-scratch", [userStep(0, wrapEnvelope("Unregistered scratch prompt"))]);
  const childTx = writeTranscript(appDir, "conv-child", [userStep(0, wrapEnvelope("Role child prompt"))]);
  for (const [label, convId, loc, tx] of [
    ["unregistered scratch", "conv-scratch", { cwd: scratch }, scratchTx],
    ["alpha role child cwd", "conv-child", { cwd: alphaChildWt }, childTx],
    ["alpha role child file URI", "conv-child", { workspacePaths: [pathToFileURL(alphaChildWt).href] }, childTx],
  ]) {
    const capSkip = runCli("owner-words.mjs", ["capture", "--harness", "antigravity", "--owner-store", store], {
      hookEventName: "PreInvocation",
      conversationId: convId,
      ...loc,
      invocationNum: 0,
      initialNumSteps: 1,
      lastUserInput: wrapEnvelope("Should be skipped"),
      transcriptPath: tx,
    }, env);
    assert.equal(capSkip.status, 0, `${label}: ${capSkip.stderr}`);
    assert.deepEqual(JSON.parse(capSkip.stdout), {}, label);

    const stopSkip = runCli("word-gate.mjs", ["--harness", "antigravity", "--owner-store", store, "--max-blocks", "2"], {
      hookEventName: "Stop",
      conversationId: convId,
      ...loc,
      transcriptPath: tx,
      terminationReason: "NO_TOOL_CALL",
      fullyIdle: true,
      continuationActive: false,
    }, env);
    assert.equal(stopSkip.status, 0, `${label}: ${stopSkip.stderr}`);
    assert.deepEqual(JSON.parse(stopSkip.stdout), {}, label);
  }
  assert.equal(committedWords(alpha.records).length, 1);
  assert.equal(committedWords(beta.records).length, 2);

  writeFileSync(join(store, "products.json"), "{corrupt-registry");
  const capBad = runCli("owner-words.mjs", ["capture", "--harness", "antigravity", "--owner-store", store], {
    hookEventName: "PreInvocation",
    conversationId: "conv-corrupt",
    cwd: alpha.product,
    invocationNum: 0,
    initialNumSteps: 1,
    lastUserInput: wrapEnvelope("Unsaved during corruption"),
  }, env);
  assert.equal(capBad.status, 0, capBad.stderr);
  assert.match(JSON.parse(capBad.stdout).injectSteps[0].systemMessage.systemMessage, /NOT recorded/);

  const stopCorrupt = () => runCli("word-gate.mjs", ["--harness", "antigravity", "--owner-store", store, "--max-blocks", "2"], {
    hookEventName: "Stop",
    conversationId: "conv-corrupt",
    cwd: alpha.product,
    terminationReason: "NO_TOOL_CALL",
    fullyIdle: true,
    continuationActive: false,
  }, env);
  for (const round of [1, 2]) {
    const r = stopCorrupt();
    assert.equal(r.status, 0, `round ${round}: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.decision, "continue", `round ${round}: ${r.stdout}`);
    assert.match(out.reason, /^word-gate:/, `round ${round}: ${r.stdout}`);
  }
  const third = stopCorrupt();
  assert.equal(third.status, 0, third.stderr);
  assert.deepEqual(JSON.parse(third.stdout), {});
});

// R-0032-reviewer-architecture, design/antigravity-harness.md#hooks-cli
test("AG-MP-05: self-loop hooks install, check, start advisory, and uninstall support global --owner-store while preserving --scope workspace and --config", () => {
  const alpha = makeProduct("alpha");
  const beta = makeProduct("beta");
  const store = ownerStore([
    { name: "alpha", records: alpha.records },
    { name: "beta", records: beta.records },
  ], { dir: realTemp("ag-mp5-store-") });
  const gHome = realTemp("ag-mp5-g-");
  const t3Dir = realTemp("ag-mp5-t3-");
  const instDir = join(t3Dir, "userdata", "providers", "antigravity", "aaaa1111");
  mkdirSync(join(instDir, "config"), { recursive: true });
  mkdirSync(join(gHome, "config", "skills", "self-loop"), { recursive: true });
  writeFileSync(join(gHome, "config", "skills", "self-loop", "SKILL.md"), "# self-loop\n");
  const globalHooksFile = join(gHome, "config", "hooks.json");
  writeFileSync(globalHooksFile, JSON.stringify({ "sibling-hook": { enabled: true } }, null, 2) + "\n");

  const env = isolatedEnv({ GEMINI_HOME: gHome, T3CODE_HOME: t3Dir });
  const unrelatedCwd = realTemp("ag-mp5-anywhere-");

  const assertGlobalStoreHooks = file => {
    const data = JSON.parse(readFileSync(file, "utf8"));
    const sl = data["self-loop"];
    assert.ok(sl, file);
    for (const [ev, script, tokens] of [
      ["SessionStart", "self-loop.mjs", parseShellWords(sl.SessionStart[0].command)],
      ["PreInvocation", "owner-words.mjs", parseShellWords(sl.PreInvocation[0].command)],
      ["PreToolUse", "lead-guard.mjs", parseShellWords(sl.PreToolUse[0].hooks[0].command)],
      ["Stop", "word-gate.mjs", parseShellWords(sl.Stop[0].command)],
    ]) {
      assert.ok(tokens[1].endsWith(script), `${ev}: ${tokens.join(" ")}`);
      const idx = tokens.indexOf("--owner-store");
      assert.notEqual(idx, -1, `${ev} missing --owner-store: ${tokens.join(" ")}`);
      assert.equal(resolve(tokens[idx + 1]), resolve(store), `${ev} wrong store: ${tokens[idx + 1]}`);
    }
    assert.equal(sl.PreToolUse[0].matcher, "*");
  };

  const instGlobal = selfLoop(["hooks", "install", "--harness", "antigravity", "--scope", "global", "--owner-store", store], { cwd: unrelatedCwd, env });
  assert.equal(instGlobal.status, 0, instGlobal.stdout + instGlobal.stderr);
  assertGlobalStoreHooks(globalHooksFile);
  assert.deepEqual(JSON.parse(readFileSync(globalHooksFile, "utf8"))["sibling-hook"], { enabled: true });

  const instT3 = selfLoop(["hooks", "install", "--harness", "antigravity", "--target", join(instDir, "config", "hooks.json"), "--owner-store", store], { cwd: unrelatedCwd, env });
  assert.equal(instT3.status, 0, instT3.stdout + instT3.stderr);
  assertGlobalStoreHooks(join(instDir, "config", "hooks.json"));

  const checkExplicit = selfLoop(["hooks", "check", "--harness", "antigravity", "--scope", "global", "--owner-store", store], { cwd: unrelatedCwd, env });
  assert.equal(checkExplicit.status, 0, checkExplicit.stdout + checkExplicit.stderr);

  const instAll = selfLoop(["hooks", "install", "--harness", "antigravity", "--scope", "global", "--all", "--owner-store", store], { cwd: unrelatedCwd, env });
  assert.equal(instAll.status, 0, instAll.stdout + instAll.stderr);
  assertGlobalStoreHooks(globalHooksFile);
  const checkImplicit = selfLoop(["hooks", "check", "--harness", "antigravity", "--scope", "global"], { cwd: unrelatedCwd, env });
  assert.equal(checkImplicit.status, 0, checkImplicit.stdout + checkImplicit.stderr);

  const instEnvStore = selfLoop(["hooks", "install", "--harness", "antigravity", "--scope", "global"], {
    cwd: unrelatedCwd,
    env: { ...env, SELF_LOOP_OWNER_STORE: store },
  });
  assert.equal(instEnvStore.status, 0, instEnvStore.stdout + instEnvStore.stderr);
  assertGlobalStoreHooks(globalHooksFile);

  const allWithConfig = selfLoop(["hooks", "install", "--harness", "antigravity", "--scope", "global", "--all", "--config", join(alpha.records, "loop.json")], { env });
  assert.equal(allWithConfig.status, 64);

  const origProducts = readFileSync(join(store, "products.json"), "utf8");
  writeFileSync(join(store, "products.json"), "{broken");
  const checkBrokenProducts = selfLoop(["hooks", "check", "--harness", "antigravity", "--scope", "global", "--json"], { cwd: unrelatedCwd, env });
  assert.equal(checkBrokenProducts.status, 2);
  assert.ok(JSON.parse(checkBrokenProducts.stdout).findings.some(f => f.includes("products.json")));
  const startBrokenProducts = selfLoop(["start", "--now", "2026-11-23T02:00:00.000Z"], { cwd: alpha.product, env: { ...env, SELF_LOOP_OWNER_STORE: store } });
  assert.equal(startBrokenProducts.status, 0, startBrokenProducts.stderr);
  assert.match(startBrokenProducts.stdout, /hooks \(antigravity\):/);

  writeFileSync(join(store, "products.json"), origProducts);
  const alphaLoopFile = join(alpha.records, "loop.json");
  const origAlphaLoop = readFileSync(alphaLoopFile, "utf8");
  writeFileSync(alphaLoopFile, "{broken-loop");
  const checkBrokenLoop = selfLoop(["hooks", "check", "--harness", "antigravity", "--scope", "global", "--json"], { cwd: unrelatedCwd, env });
  assert.equal(checkBrokenLoop.status, 2);
  assert.ok(JSON.parse(checkBrokenLoop.stdout).findings.some(f => f.includes("alpha") || f.includes("loop.json")));
  const startBrokenLoop = selfLoop(["start", "--now", "2026-11-23T02:00:00.000Z"], { cwd: beta.product, env: { ...env, SELF_LOOP_OWNER_STORE: store } });
  assert.equal(startBrokenLoop.status, 0, startBrokenLoop.stderr);
  assert.match(startBrokenLoop.stdout, /hooks \(antigravity\):.*(?:alpha|loop\.json)/);

  writeFileSync(alphaLoopFile, origAlphaLoop);
  assert.equal(selfLoop(["hooks", "check", "--harness", "antigravity", "--scope", "global"], { cwd: unrelatedCwd, env }).status, 0);

  const uninstGlobal = selfLoop(["hooks", "uninstall", "--harness", "antigravity", "--scope", "global"], { cwd: unrelatedCwd, env });
  assert.equal(uninstGlobal.status, 0, uninstGlobal.stdout + uninstGlobal.stderr);
  const afterGlobal = JSON.parse(readFileSync(globalHooksFile, "utf8"));
  assert.equal("self-loop" in afterGlobal, false);
  assert.deepEqual(afterGlobal["sibling-hook"], { enabled: true });

  const assertSingleProductHooks = (file, prod) => {
    const sl = JSON.parse(readFileSync(file, "utf8"))["self-loop"];
    const startWords = parseShellWords(sl.SessionStart[0].command);
    const invWords = parseShellWords(sl.PreInvocation[0].command);
    const guardWords = parseShellWords(sl.PreToolUse[0].hooks[0].command);
    const stopWords = parseShellWords(sl.Stop[0].command);
    assert.equal(startWords.includes("--owner-store"), false);
    assert.equal(invWords.includes("--owner-store"), false);
    assert.equal(guardWords.includes("--owner-store"), false);
    assert.equal(stopWords.includes("--owner-store"), false);
    assert.equal(resolve(invWords[invWords.indexOf("--records") + 1]), resolve(prod.records));
    assert.ok(invWords.includes("--project"));
    assert.equal(resolve(guardWords[guardWords.indexOf("--product") + 1]), resolve(prod.product));
    assert.equal(resolve(guardWords[guardWords.indexOf("--workspaces") + 1]), resolve(prod.workDir));
    assert.equal(resolve(stopWords[stopWords.indexOf("--records") + 1]), resolve(prod.records));
    assert.ok(stopWords.includes("--project"));
  };

  assert.equal(selfLoop(["hooks", "install", "--harness", "antigravity", "--scope", "workspace", "--config", alphaLoopFile], { env }).status, 0);
  assertSingleProductHooks(join(alpha.product, ".agents", "hooks.json"), alpha);

  assert.equal(selfLoop(["hooks", "install", "--harness", "antigravity", "--scope", "global", "--config", alphaLoopFile], { env }).status, 0);
  assertSingleProductHooks(globalHooksFile, alpha);
});

// R-0033-judge-hooks, D-0052, D-0060
test("AG-MP-06: installed global SessionStart routes primary, linked worktree, workspacePaths, skips unregistered/child, and surfaces ambiguous workspaces", () => {
  const alpha = makeProduct("alpha");
  const beta = makeProduct("beta");
  const betaLeadWt = realTemp("ag-mp6-beta-wt-");
  git(beta.product, "worktree", "add", "-q", "--detach", betaLeadWt);
  const betaHead = git(beta.product, "rev-parse", "HEAD");

  const alphaChildWs = join(alpha.workDir, "0001-actor");
  const alphaChildWt = join(alphaChildWs, "wt");
  mkdirSync(alphaChildWs, { recursive: true });
  git(alpha.product, "worktree", "add", "-q", "--detach", alphaChildWt);

  const unregistered = realTemp("ag-mp6-unreg-");
  const store = ownerStore([
    { name: "alpha", records: alpha.records },
    { name: "beta", records: beta.records },
  ], { dir: realTemp("ag-mp6-store-") });
  const gHome = realTemp("ag-mp6-g-");
  mkdirSync(join(gHome, "config", "skills", "self-loop"), { recursive: true });
  writeFileSync(join(gHome, "config", "skills", "self-loop", "SKILL.md"), "# self-loop\n");
  const env = isolatedEnv({ GEMINI_HOME: gHome, T3CODE_HOME: "", T3CODE_THREAD_ID: "" });

  const inst = selfLoop(["hooks", "install", "--harness", "antigravity", "--scope", "global", "--owner-store", store], { cwd: realTemp("ag-mp6-cwd-"), env });
  assert.equal(inst.status, 0, inst.stdout + inst.stderr);
  const hooksFile = join(gHome, "config", "hooks.json");
  const startCmd = parseShellWords(JSON.parse(readFileSync(hooksFile, "utf8"))["self-loop"].SessionStart[0].command);
  const runStart = payload => spawnSync(startCmd[0], startCmd.slice(1), {
    input: JSON.stringify(payload),
    cwd: realTemp("ag-mp6-hook-cwd-"),
    encoding: "utf8",
    env,
  });

  const assertBetaMatched = (res, label) => {
    assert.equal(res.status, 0, `${label}: exit ${res.status}, stderr=${res.stderr}`);
    const out = JSON.parse(res.stdout);
    const msg = out?.injectSteps?.[0]?.systemMessage?.systemMessage;
    assert.equal(typeof msg, "string", `${label}: expected injectSteps systemMessage, got ${res.stdout}`);
    assert.ok(msg.includes(`This session: beta · ${beta.records}`), `${label}: expected beta session header, got:\n${msg}`);
    assert.ok(msg.includes(`Phase v1 · loop/v1 at ${betaHead}`), `${label}: expected beta next action, got:\n${msg}`);
    assert.doesNotMatch(msg, /This session:\s*(?:alpha|no registered product contains)\b/, `${label}: ${msg}`);
    assert.doesNotMatch(msg, /next failed:/, `${label}: ${msg}`);
  };

  assertBetaMatched(
    runStart({ hookEventName: "SessionStart", conversationId: "s-beta-wt", cwd: betaLeadWt }),
    "a: linked worktree cwd"
  );

  assertBetaMatched(
    runStart({
      hookEventName: "SessionStart",
      conversationId: "s-unreg-cwd-beta-wt-uri",
      cwd: unregistered,
      workspacePaths: [pathToFileURL(betaLeadWt).href],
    }),
    "b1: unregistered cwd + file:// beta linked worktree"
  );

  assertBetaMatched(
    runStart({
      hookEventName: "SessionStart",
      conversationId: "s-mixed-uris",
      cwd: unregistered,
      workspacePaths: [pathToFileURL(unregistered).href, pathToFileURL(beta.product).href],
    }),
    "b2: unregistered + beta primary workspacePaths"
  );

  for (const [label, payload] of [
    ["b3: truly unregistered cwd", { hookEventName: "SessionStart", conversationId: "s-unreg", cwd: unregistered }],
    ["b4: truly unregistered workspacePaths", { hookEventName: "SessionStart", conversationId: "s-unreg-ws", workspacePaths: [pathToFileURL(unregistered).href] }],
    ["b5: role child cwd", { hookEventName: "SessionStart", conversationId: "s-child-cwd", cwd: alphaChildWt }],
    ["b6: role child workspacePaths", { hookEventName: "SessionStart", conversationId: "s-child-ws", workspacePaths: [pathToFileURL(alphaChildWt).href] }],
  ]) {
    const res = runStart(payload);
    assert.equal(res.status, 0, `${label}: ${res.stderr}`);
    assert.deepEqual(JSON.parse(res.stdout), {}, label);
  }

  for (const [label, payload] of [
    ["c1: multi-product workspacePaths", { hookEventName: "SessionStart", conversationId: "s-ambig-ws", workspacePaths: [pathToFileURL(alpha.product).href, pathToFileURL(beta.product).href] }],
    ["c2: alpha cwd + beta workspacePaths", { hookEventName: "SessionStart", conversationId: "s-ambig-cwd", cwd: alpha.product, workspacePaths: [pathToFileURL(beta.product).href] }],
  ]) {
    const res = runStart(payload);
    assert.equal(res.status, 0, `${label}: ${res.stderr}`);
    const out = JSON.parse(res.stdout);
    const msg = out?.injectSteps?.[0]?.systemMessage?.systemMessage;
    assert.equal(typeof msg, "string", `${label}: expected injectSteps diagnostic, got ${res.stdout}`);
    assert.doesNotMatch(msg, /This session:\s*(?:alpha|beta)\b/, `${label}: must not pick sole product:\n${msg}`);
    assert.doesNotMatch(msg, /Phase v1 · loop\/v1/, `${label}: must not fabricate single-product next:\n${msg}`);
    const diagLine = msg.split("\n").find(l => /multiple.*products|ambiguous/i.test(l)) ?? "";
    assert.ok(diagLine, `${label}: expected ambiguous-product diagnostic, got:\n${msg}`);
    assert.match(diagLine, /\balpha\b/, `${label}: ${diagLine}`);
    assert.match(diagLine, /\bbeta\b/, `${label}: ${diagLine}`);
  }
});

// R-0033-judge-hooks, D-0052, D-0060
test("AG-MP-07: store-wide owner-words sync attributes linked worktrees, skips role/unregistered, and fails non-zero without double-attributing ambiguous sessions", () => {
  const alpha = makeProduct("alpha");
  const beta = makeProduct("beta");
  const betaLeadWt = realTemp("ag-mp7-beta-wt-");
  git(beta.product, "worktree", "add", "-q", "--detach", betaLeadWt);

  const alphaChildWs = join(alpha.workDir, "0001-actor");
  const alphaChildWt = join(alphaChildWs, "wt");
  mkdirSync(alphaChildWs, { recursive: true });
  git(alpha.product, "worktree", "add", "-q", "--detach", alphaChildWt);

  const unregistered = realTemp("ag-mp7-unreg-");
  const store = ownerStore([
    { name: "alpha", records: alpha.records },
    { name: "beta", records: beta.records },
  ], { dir: realTemp("ag-mp7-store-") });

  const appDir = realTemp("ag-mp7-app-");
  const writeSummaryDb = rows => {
    mkdirSync(appDir, { recursive: true });
    const db = new DatabaseSync(join(appDir, "conversation_summaries.db"));
    db.exec(`CREATE TABLE IF NOT EXISTS conversation_summaries (
      conversation_id TEXT PRIMARY KEY,
      workspace_uris TEXT,
      status TEXT,
      parent_conversation_id TEXT DEFAULT '',
      nesting_depth INTEGER DEFAULT 0,
      killed INTEGER DEFAULT 0,
      not_fully_idle INTEGER DEFAULT 0
    )`);
    const stmt = db.prepare(`INSERT OR REPLACE INTO conversation_summaries
      (conversation_id, workspace_uris, status, parent_conversation_id, nesting_depth, killed, not_fully_idle)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
    for (const r of rows) {
      stmt.run(r.id, JSON.stringify(r.workspaces.map(w => pathToFileURL(w).href)), "CASCADE_RUN_STATUS_IDLE", "", 0, 0, 0);
    }
    db.close();
  };

  writeTranscript(appDir, "conv-alpha-primary", [userStep(0, wrapEnvelope("Alpha primary sync directive"))]);
  writeTranscript(appDir, "conv-beta-wt", [userStep(0, wrapEnvelope("Beta linked worktree sync directive"))]);
  writeTranscript(appDir, "conv-child-wt", [userStep(0, wrapEnvelope("Role child sync prompt"))]);
  writeTranscript(appDir, "conv-unreg", [userStep(0, wrapEnvelope("Unregistered sync prompt"))]);
  writeSummaryDb([
    { id: "conv-alpha-primary", workspaces: [alpha.product] },
    { id: "conv-beta-wt", workspaces: [betaLeadWt] },
    { id: "conv-child-wt", workspaces: [alphaChildWt] },
    { id: "conv-unreg", workspaces: [unregistered] },
  ]);

  const env = isolatedEnv({
    ANTIGRAVITY_APP_DATA_DIR: appDir,
    GEMINI_HOME: realTemp("ag-mp7-g-"),
    T3CODE_HOME: "",
    T3CODE_THREAD_ID: "",
    CLAUDE_CONFIG_DIR: realTemp("ag-mp7-cl-"),
    CODEX_HOME: realTemp("ag-mp7-cx-"),
  });

  const syncUnique = spawnSync(process.execPath, [join(scripts, "owner-words.mjs"), "sync", "--owner-store", store], {
    cwd: realTemp("ag-mp7-cwd-"),
    encoding: "utf8",
    env,
  });
  assert.equal(syncUnique.status, 0, `expected exit 0 for unique/skip sync, stderr=${syncUnique.stderr}`);
  assert.deepEqual(committedWords(alpha.records).map(w => w.text), ["Alpha primary sync directive"]);
  assert.deepEqual(committedWords(beta.records).map(w => w.text), ["Beta linked worktree sync directive"]);

  writeTranscript(appDir, "conv-ambig", [userStep(0, wrapEnvelope("Ambiguous multi-product sync directive"))]);
  writeSummaryDb([
    { id: "conv-alpha-primary", workspaces: [alpha.product] },
    { id: "conv-beta-wt", workspaces: [betaLeadWt] },
    { id: "conv-child-wt", workspaces: [alphaChildWt] },
    { id: "conv-unreg", workspaces: [unregistered] },
    { id: "conv-ambig", workspaces: [alpha.product, beta.product] },
  ]);

  const syncAmbig = spawnSync(process.execPath, [join(scripts, "owner-words.mjs"), "sync", "--owner-store", store], {
    cwd: realTemp("ag-mp7-cwd2-"),
    encoding: "utf8",
    env,
  });
  assert.equal(syncAmbig.status, 1, `expected exit 1 on ambiguous session, stdout=${syncAmbig.stdout}, stderr=${syncAmbig.stderr}`);
  assert.deepEqual(committedWords(alpha.records).map(w => w.text), ["Alpha primary sync directive"]);
  assert.deepEqual(committedWords(beta.records).map(w => w.text), ["Beta linked worktree sync directive"]);
  const diag = `${syncAmbig.stderr}\n${syncAmbig.stdout}`;
  assert.match(diag, /ambiguous|multiple.*products|unresolved/i, `expected ambiguous diagnostic, got:\n${diag}`);
  assert.match(diag, /\balpha\b/, diag);
  assert.match(diag, /\bbeta\b/, diag);
});

test("AG-MP-08: installed global SessionStart fails closed on tracked .self-loop/loop.json inside registered product without falling back to registry", () => {
  const alpha = makeProduct("alpha");
  const store = ownerStore([{ name: "alpha", records: alpha.records }], { dir: realTemp("ag-mp8-store-") });
  const gHome = realTemp("ag-mp8-g-");
  mkdirSync(join(gHome, "config", "skills", "self-loop"), { recursive: true });
  writeFileSync(join(gHome, "config", "skills", "self-loop", "SKILL.md"), "# self-loop\n");
  const env = isolatedEnv({ GEMINI_HOME: gHome, T3CODE_HOME: "", T3CODE_THREAD_ID: "" });

  const inst = selfLoop(["hooks", "install", "--harness", "antigravity", "--scope", "global", "--owner-store", store], { cwd: realTemp("ag-mp8-cwd-"), env });
  assert.equal(inst.status, 0, inst.stdout + inst.stderr);
  const hooksFile = join(gHome, "config", "hooks.json");
  const startCmd = parseShellWords(JSON.parse(readFileSync(hooksFile, "utf8"))["self-loop"].SessionStart[0].command);

  mkdirSync(join(alpha.product, ".self-loop"), { recursive: true });
  writeFileSync(join(alpha.product, ".self-loop", "loop.json"), JSON.stringify({ product: alpha.product, records: alpha.records }, null, 2) + "\n");
  git(alpha.product, "add", ".self-loop/loop.json");
  git(alpha.product, "commit", "-qm", "untrusted local loop.json");

  const res = spawnSync(startCmd[0], startCmd.slice(1), {
    input: JSON.stringify({ hookEventName: "SessionStart", conversationId: "s-untrusted-local", cwd: alpha.product }),
    cwd: alpha.product,
    encoding: "utf8",
    env,
  });
  assert.equal(res.status, 0, `exit ${res.status}, stderr=${res.stderr}`);
  assert.equal(res.stdout.trim(), "{}", `expected fail-closed "{}" without falling back to registry alpha, got:\n${res.stdout}`);
});

test("AG-MP-09: installed global SessionStart resolves trusted in-repo .self-loop and registered workspaces order-independently while failing closed on untrusted local", () => {
  const alpha = makeProduct("alpha");
  const beta = makeProduct("beta");
  const localOnly = repo({ "src/l.js": "export const l = 1;\n" }, realTemp("ag-mp9-local-"));
  const store = ownerStore([
    { name: "alpha", records: alpha.records },
    { name: "beta", records: beta.records },
  ], { dir: realTemp("ag-mp9-store-") });
  const gHome = realTemp("ag-mp9-g-");
  mkdirSync(join(gHome, "config", "skills", "self-loop"), { recursive: true });
  writeFileSync(join(gHome, "config", "skills", "self-loop", "SKILL.md"), "# self-loop\n");
  const env = isolatedEnv({ GEMINI_HOME: gHome, T3CODE_HOME: "", T3CODE_THREAD_ID: "" });

  assert.equal(selfLoop(["init", "--local-exclude"], { cwd: alpha.product, env }).status, 0);
  assert.equal(selfLoop(["init", "--local-exclude", "--name", "local-only"], { cwd: localOnly, env }).status, 0);

  const inst = selfLoop(["hooks", "install", "--harness", "antigravity", "--scope", "global", "--owner-store", store], { cwd: realTemp("ag-mp9-cwd-"), env });
  assert.equal(inst.status, 0, inst.stdout + inst.stderr);
  const hooksFile = join(gHome, "config", "hooks.json");
  const startCmd = parseShellWords(JSON.parse(readFileSync(hooksFile, "utf8"))["self-loop"].SessionStart[0].command);
  const runStart = payload => spawnSync(startCmd[0], startCmd.slice(1), {
    input: JSON.stringify(payload),
    cwd: realTemp("ag-mp9-hook-cwd-"),
    encoding: "utf8",
    env,
  });

  const assertAmbiguous = (res, label, checkNames) => {
    assert.equal(res.status, 0, `${label}: exit ${res.status}, stderr=${res.stderr}`);
    const out = JSON.parse(res.stdout);
    const msg = out?.injectSteps?.[0]?.systemMessage?.systemMessage;
    assert.equal(typeof msg, "string", `${label}: expected injectSteps diagnostic, got ${res.stdout}`);
    assert.doesNotMatch(msg, /This session:\s*(?:alpha|beta|configured product)\b/, `${label}: must not select a single product:\n${msg}`);
    assert.doesNotMatch(msg, /Phase v1 ·/, `${label}: must not emit single-product next:\n${msg}`);
    const sessionLine = msg.split("\n").find(l => l.startsWith("This session:")) ?? "";
    assert.match(sessionLine, /multiple|ambiguous|conflict/i, `${label}: expected ambiguity diagnostic, got:\n${msg}`);
    checkNames(sessionLine, msg);
  };

  for (const [label, payload] of [
    ["a1: [alpha, beta]", { hookEventName: "SessionStart", conversationId: "s-mp9-a1", workspacePaths: [pathToFileURL(alpha.product).href, pathToFileURL(beta.product).href] }],
    ["a2: [beta, alpha]", { hookEventName: "SessionStart", conversationId: "s-mp9-a2", workspacePaths: [pathToFileURL(beta.product).href, pathToFileURL(alpha.product).href] }],
    ["a3: cwd alpha + [alpha, beta]", { hookEventName: "SessionStart", conversationId: "s-mp9-a3", cwd: alpha.product, workspacePaths: [pathToFileURL(alpha.product).href, pathToFileURL(beta.product).href] }],
    ["a4: cwd beta + [beta, alpha]", { hookEventName: "SessionStart", conversationId: "s-mp9-a4", cwd: beta.product, workspacePaths: [pathToFileURL(beta.product).href, pathToFileURL(alpha.product).href] }],
  ]) {
    assertAmbiguous(runStart(payload), label, line => {
      assert.match(line, /\balpha\b/, `${label}: ${line}`);
      assert.match(line, /\bbeta\b/, `${label}: ${line}`);
    });
  }

  for (const [label, payload] of [
    ["b1: [localOnly, beta]", { hookEventName: "SessionStart", conversationId: "s-mp9-b1", workspacePaths: [pathToFileURL(localOnly).href, pathToFileURL(beta.product).href] }],
    ["b2: [beta, localOnly]", { hookEventName: "SessionStart", conversationId: "s-mp9-b2", workspacePaths: [pathToFileURL(beta.product).href, pathToFileURL(localOnly).href] }],
    ["b3: cwd localOnly + [localOnly, beta]", { hookEventName: "SessionStart", conversationId: "s-mp9-b3", cwd: localOnly, workspacePaths: [pathToFileURL(localOnly).href, pathToFileURL(beta.product).href] }],
    ["b4: cwd beta + [beta, localOnly]", { hookEventName: "SessionStart", conversationId: "s-mp9-b4", cwd: beta.product, workspacePaths: [pathToFileURL(beta.product).href, pathToFileURL(localOnly).href] }],
  ]) {
    assertAmbiguous(runStart(payload), label, line => {
      assert.match(line, /\bbeta\b/, `${label}: ${line}`);
      assert.ok(line.includes(localOnly) || /in-repo|\.self-loop|local/i.test(line), `${label}: ${line}`);
    });
  }

  rmSync(join(alpha.product, ".self-loop"), { recursive: true, force: true });
  mkdirSync(join(alpha.product, ".self-loop"), { recursive: true });
  writeFileSync(join(alpha.product, ".self-loop", "loop.json"), JSON.stringify({ product: alpha.product, records: alpha.records }, null, 2) + "\n");
  git(alpha.product, "add", "-f", ".self-loop/loop.json");
  git(alpha.product, "commit", "-qm", "untrusted local loop.json");

  for (const [label, payload] of [
    ["c1: untrusted alpha + beta", { hookEventName: "SessionStart", conversationId: "s-mp9-c1", workspacePaths: [pathToFileURL(alpha.product).href, pathToFileURL(beta.product).href] }],
    ["c2: beta + untrusted alpha", { hookEventName: "SessionStart", conversationId: "s-mp9-c2", workspacePaths: [pathToFileURL(beta.product).href, pathToFileURL(alpha.product).href] }],
  ]) {
    const res = runStart(payload);
    assert.equal(res.status, 0, `${label}: exit ${res.status}, stderr=${res.stderr}`);
    assert.equal(res.stdout.trim(), "{}", `${label}: expected fail-closed "{}" on untrusted local, got:\n${res.stdout}`);
  }
});

test("AG-MP-10: store-wide owner-words sync fails closed with zero ledger writes when authoritative transcript or lead identity is unresolved, then retries cleanly", () => {
  const alpha = makeProduct("alpha");
  const store = ownerStore([{ name: "alpha", records: alpha.records }], { dir: realTemp("ag-mp10-store-") });
  const appDir = realTemp("ag-mp10-app-");

  const writeSummaryDb = rows => {
    mkdirSync(appDir, { recursive: true });
    const db = new DatabaseSync(join(appDir, "conversation_summaries.db"));
    db.exec(`CREATE TABLE IF NOT EXISTS conversation_summaries (
      conversation_id TEXT PRIMARY KEY,
      workspace_uris TEXT,
      status TEXT,
      parent_conversation_id TEXT DEFAULT '',
      nesting_depth INTEGER DEFAULT 0,
      killed INTEGER DEFAULT 0,
      not_fully_idle INTEGER DEFAULT 0
    )`);
    const stmt = db.prepare(`INSERT OR REPLACE INTO conversation_summaries
      (conversation_id, workspace_uris, status, parent_conversation_id, nesting_depth, killed, not_fully_idle)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
    for (const r of rows) {
      stmt.run(r.id, JSON.stringify(r.workspaces.map(w => pathToFileURL(w).href)), "CASCADE_RUN_STATUS_IDLE", "", 0, 0, 0);
    }
    db.close();
  };

  const writeCompactTranscript = (id, rows) => {
    const logs = join(appDir, "brain", id, ".system_generated", "logs");
    mkdirSync(logs, { recursive: true });
    const file = join(logs, "transcript.jsonl");
    writeFileSync(file, rows.map(r => JSON.stringify(r)).join("\n") + "\n");
    return file;
  };

  const env = isolatedEnv({
    ANTIGRAVITY_APP_DATA_DIR: appDir,
    GEMINI_HOME: realTemp("ag-mp10-g-"),
    T3CODE_HOME: "",
    T3CODE_THREAD_ID: "",
    CLAUDE_CONFIG_DIR: realTemp("ag-mp10-cl-"),
    CODEX_HOME: realTemp("ag-mp10-cx-"),
  });

  const runStoreSync = () => spawnSync(process.execPath, [join(scripts, "owner-words.mjs"), "sync", "--owner-store", store], {
    cwd: realTemp("ag-mp10-cwd-"),
    encoding: "utf8",
    env,
  });

  const childFollowUp = "Child follow-up message that must NOT enter owner ledger";
  writeCompactTranscript("conv-child-unresolved", [
    userStep(0, wrapEnvelope("<truncated 1200 bytes>"), { created_at: "2026-11-23T01:00:00.000Z", truncated_fields: ["content"] }),
    userStep(1, wrapEnvelope(childFollowUp), { created_at: "2026-11-23T01:00:05.000Z" }),
  ]);
  writeSummaryDb([{ id: "conv-child-unresolved", workspaces: [alpha.product] }]);

  const syncChildPending = runStoreSync();
  assert.equal(syncChildPending.status, 1, `expected exit 1 for unresolved compact child session, stdout=${syncChildPending.stdout}, stderr=${syncChildPending.stderr}`);
  assert.match(`${syncChildPending.stderr}\n${syncChildPending.stdout}`, /unresolved|truncated|skipped/i);
  assert.deepEqual(committedWords(alpha.records), [], "must commit 0 words while step-0 lead identity is unresolved");

  writeTranscript(appDir, "conv-child-unresolved", [
    userStep(0, wrapEnvelope("Act as the test sub-agent for this task.\n\nself-loop call R-0001-actor · nonce aaaa1111bbbb2222"), { created_at: "2026-11-23T01:00:00.000Z" }),
    userStep(1, wrapEnvelope(childFollowUp), { created_at: "2026-11-23T01:00:05.000Z" }),
  ]);

  const syncChildResolved = runStoreSync();
  assert.equal(syncChildResolved.status, 0, `expected exit 0 after authoritative child transcript materialized, stderr=${syncChildResolved.stderr}`);
  assert.deepEqual(committedWords(alpha.records), [], "child session must leave 0 words in owner ledger after full transcript resolution");

  const ownerDirective = "Genuine owner directive committed after full transcript materialization";
  writeCompactTranscript("conv-owner-retry", [
    userStep(0, wrapEnvelope("Genuine..."), { created_at: "2026-11-23T01:02:00.000Z", truncated_fields: ["content"] }),
  ]);
  writeSummaryDb([
    { id: "conv-child-unresolved", workspaces: [alpha.product] },
    { id: "conv-owner-retry", workspaces: [alpha.product] },
  ]);

  const syncOwnerPending = runStoreSync();
  assert.equal(syncOwnerPending.status, 1, `expected exit 1 while owner transcript_full.jsonl is absent, stdout=${syncOwnerPending.stdout}, stderr=${syncOwnerPending.stderr}`);
  assert.match(`${syncOwnerPending.stderr}\n${syncOwnerPending.stdout}`, /unresolved|truncated|skipped/i);
  assert.deepEqual(committedWords(alpha.records), [], "must commit 0 words while owner transcript_full.jsonl is absent");

  writeTranscript(appDir, "conv-owner-retry", [
    userStep(0, wrapEnvelope(ownerDirective), { created_at: "2026-11-23T01:02:00.000Z" }),
  ]);

  const syncOwnerResolved = runStoreSync();
  assert.equal(syncOwnerResolved.status, 0, `expected exit 0 after owner transcript_full.jsonl materialized, stderr=${syncOwnerResolved.stderr}`);
  assert.deepEqual(committedWords(alpha.records).map(w => w.text), [ownerDirective]);

  const syncOwnerIdempotent = runStoreSync();
  assert.equal(syncOwnerIdempotent.status, 0, syncOwnerIdempotent.stderr);
  assert.deepEqual(committedWords(alpha.records).map(w => w.text), [ownerDirective]);
});
