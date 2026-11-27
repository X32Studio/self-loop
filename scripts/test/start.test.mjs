// F-0003, F-0009, D-0016, D-0065, D-0066, D-0067, R-0001-judge
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { argv, load } from "../call.mjs";
import { UsageError } from "../lib/args.mjs";
import { git as plumbingGit, gitOk as plumbingGitOk, run as plumbingRun } from "../lib/git-plumbing.mjs";
import { initLoop } from "../lib/init.mjs";
import { CROWDED, git, isolatedEnv, loopProduct, ownerStore, repo, ROOMY, selfLoop, temp } from "./helpers.mjs";

const NOW = "2026-11-21T12:00:00.000Z";
const hoursBefore = h => new Date(Date.parse(NOW) - h * 3600_000).toISOString();
const entry = (name, records) => ({ name, records });
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const snapshot = (...products) => products.map(p => `${git(p.records, "rev-parse", "HEAD")} ${git(p.records, "status", "--porcelain")}`);
const ledger = records => {
  try { return git(records, "show", "HEAD:metrics/alarms.jsonl").split("\n").filter(Boolean).map(line => JSON.parse(line)); }
  catch { return []; }
};
function activity(p, time) {
  const file = join(p.records, "metrics/blueprint.jsonl");
  writeFileSync(file, readFileSync(file, "utf8") + JSON.stringify({ feature: "F-0001", phase: "v1", status: "designing", time, by: "lead",
    note: "Resumed", evidence: {} }) + "\n");
  git(p.records, "commit", "-qam", "activity");
}

test("start from any registered product shows every product's live committed stall alarm, with show and resume unavailable, and writes nothing", () => {
  const lead = loopProduct({ activity: hoursBefore(1) });
  const idle = loopProduct({ activity: hoursBefore(30) });
  const unattended = loopProduct({ activity: hoursBefore(40), loop: { tick: { onStall: "resume" } } });
  const store = ownerStore([entry("lead", lead.records), entry("idle", idle.records), entry("unattended", unattended.records)]);
  const env = isolatedEnv({ SELF_LOOP_OWNER_STORE: store });
  assert.equal(selfLoop(["tick", "--now", NOW], { env }).status, 2);
  assert.equal(ledger(idle.records).length, 1);
  const before = snapshot(lead, idle, unattended);

  for (const cwd of [lead.product, join(lead.records, "blueprint"), idle.product]) {
    const start = selfLoop(["start", "--now", NOW], { cwd, env });
    assert.equal(start.status, 0, `${cwd}: ${start.stderr}`);
    assert.match(start.stdout, new RegExp(`STALL idle \\(${escape(idle.records)}\\).*since ${escape(hoursBefore(30))}.*alarm raised ${escape(NOW)}.*onStall show`));
    assert.match(start.stdout, new RegExp(`STALL unattended \\(${escape(unattended.records)}\\).*onStall resume: resume unavailable`));
    assert.doesNotMatch(start.stdout, /STALL lead/);
    assert.match(start.stdout, /1 registered product\(s\) quiet/);
  }
  const fromLead = selfLoop(["start", "--now", NOW], { cwd: lead.product, env }).stdout;
  assert.match(fromLead, new RegExp(`This session: lead · ${escape(lead.records)}`));
  assert.match(fromLead, /Phase v1 · loop\/v1 at [0-9a-f]{40}/, "the session's own next steps follow");
  assert.deepEqual(snapshot(lead, idle, unattended), before, "start commits nothing, appends no alarm and leaves every working tree as it was");

  const json = selfLoop(["start", "--now", NOW, "--json"], { cwd: lead.product, env });
  assert.equal(json.status, 0, json.stderr);
  const report = JSON.parse(json.stdout);
  const stalls = Object.fromEntries(report.findings.filter(f => f.kind === "stall").map(f => [f.product, f]));
  assert.deepEqual(Object.keys(stalls).sort(), ["idle", "unattended"]);
  assert.equal(stalls.idle.raised, NOW);
  assert.equal(stalls.idle.alarm, ledger(idle.records)[0].key, "the alarm shown is the committed one, by its key");
  assert.match(stalls.unattended.action, /resume unavailable/);
  assert.equal(report.session.product, "lead");
  assert.deepEqual(snapshot(lead, idle, unattended), before);
});

test("start shows a committed alarm while its idle period lasts, whatever threshold raised it, and drops it when activity resumes", () => {
  const lead = loopProduct({ activity: hoursBefore(1) });
  const short = loopProduct({ activity: hoursBefore(3) });
  const store = ownerStore([entry("lead", lead.records), entry("short", short.records)]);
  const env = isolatedEnv({ SELF_LOOP_OWNER_STORE: store });
  assert.equal(selfLoop(["tick", "--now", NOW, "--hours", "2"], { env }).status, 2);
  assert.equal(ledger(short.records).length, 1);
  const live = selfLoop(["start", "--now", NOW], { cwd: lead.product, env });
  assert.equal(live.status, 0, live.stderr);
  assert.match(live.stdout, new RegExp(`STALL short .*since ${escape(hoursBefore(3))}.*alarm raised ${escape(NOW)}`));
  activity(short, hoursBefore(0.5));
  const resumed = selfLoop(["start", "--now", NOW], { cwd: lead.product, env });
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.doesNotMatch(resumed.stdout, /STALL short/, "an alarm of an idle period that ended is not live");
  assert.match(resumed.stdout, /2 registered product\(s\) quiet/);
});

test("start shows a stall no tick has recorded, says so, and still records nothing", () => {
  const lead = loopProduct({ activity: hoursBefore(1) });
  const idle = loopProduct({ activity: hoursBefore(30) });
  const store = ownerStore([entry("lead", lead.records), entry("idle", idle.records)]);
  const env = isolatedEnv({ SELF_LOOP_OWNER_STORE: store });
  const before = snapshot(lead, idle);
  const start = selfLoop(["start", "--now", NOW], { cwd: lead.product, env });
  assert.equal(start.status, 0, start.stderr);
  assert.match(start.stdout, /STALL idle .*no alarm recorded/);
  assert.match(start.stdout, /heartbeat/);
  assert.deepEqual(snapshot(lead, idle), before);
  assert.deepEqual(ledger(idle.records), []);
});

test("start outside every registered product, or with no registry, shows what it can and exits 0", () => {
  const idle = loopProduct({ activity: hoursBefore(30) });
  const old = loopProduct({ loopJson: false });
  const store = ownerStore([entry("idle", idle.records), entry("old", old.records), entry("gone", join(temp(), "deleted"))]);
  const env = isolatedEnv({ SELF_LOOP_OWNER_STORE: store });
  assert.equal(selfLoop(["tick", "--now", NOW], { env }).status, 2);
  const outside = selfLoop(["start", "--now", NOW], { cwd: temp(), env });
  assert.equal(outside.status, 0, outside.stderr);
  assert.match(outside.stdout, /STALL idle .*alarm raised/);
  assert.match(outside.stdout, /NO LOOP old/);
  assert.match(outside.stdout, /MISSING gone/);
  assert.match(outside.stdout, /no registered product contains/);

  const noStore = isolatedEnv({ SELF_LOOP_OWNER_STORE: join(temp(), "nowhere") });
  const alone = selfLoop(["start", "--now", NOW, "--config", join(idle.records, "loop.json")], { cwd: temp(), env: noStore });
  assert.equal(alone.status, 0, alone.stderr);
  assert.match(alone.stdout, /no product registry/);
  assert.match(alone.stdout, /Phase v1 · loop\/v1/);
  assert.match(alone.stdout, /stall alarm raised/, "the configured product's own next shows its alarm");

  assert.equal(selfLoop(["start", "--now", "yesterday"], { env }).status, 64);
});

test("start keeps a product's live alarm visible when its next steps cannot be computed", () => {
  const lead = loopProduct({ activity: hoursBefore(1) });
  const idle = loopProduct({ activity: hoursBefore(30) });
  const store = ownerStore([entry("lead", lead.records), entry("idle", idle.records)]);
  const env = isolatedEnv({ SELF_LOOP_OWNER_STORE: store });
  assert.equal(selfLoop(["tick", "--now", NOW], { env }).status, 2);
  rmSync(idle.product, { recursive: true, force: true });
  for (const cwd of [lead.product, idle.records]) {
    const start = selfLoop(["start", "--now", NOW], { cwd, env });
    assert.equal(start.status, 0, start.stderr);
    assert.match(start.stdout, /STALL idle .*alarm raised/);
  }
  const own = selfLoop(["start", "--now", NOW], { cwd: idle.records, env });
  assert.match(own.stdout, /This session: idle[\s\S]*next failed: /);
});

test("start --owner-store runs the session's next with that store, whatever SELF_LOOP_OWNER_STORE names", () => {
  const lead = loopProduct({ activity: hoursBefore(1) });
  const crowded = ownerStore([entry("lead", lead.records)], { bound: CROWDED });
  const roomy = ownerStore([entry("lead", lead.records)], { bound: ROOMY });
  const host = line => line.split("\n").find(l => l.startsWith("Host "));
  const flagged = selfLoop(["start", "--now", NOW, "--owner-store", crowded], { cwd: lead.product, env: isolatedEnv({ SELF_LOOP_OWNER_STORE: roomy }) });
  assert.equal(flagged.status, 0, flagged.stderr);
  assert.match(flagged.stdout, new RegExp(`owner store ${escape(crowded)}`));
  assert.match(host(flagged.stdout), new RegExp(`^Host over the bound: .*bound from ${escape(join(crowded, "products.json"))} minAvailableMemoryGB`));
  const reversed = selfLoop(["start", "--now", NOW, "--owner-store", roomy], { cwd: lead.product, env: isolatedEnv({ SELF_LOOP_OWNER_STORE: crowded }) });
  assert.match(host(reversed.stdout), new RegExp(`^Host within the bound: .*bound from ${escape(join(roomy, "products.json"))} maxLoadRatio, minAvailableMemoryGB`));
});

test("D-0065/D-0066/D-0067: initLoop supports Paseo, better-paseo-antigravity, and T3 Antigravity presets while preserving defaults", () => {
  const env = isolatedEnv();
  const expectedModels = {
    actor: { model: "gemini-2.5-flash", effort: "high" },
    critic: { model: "gemini-2.5-pro", effort: "xhigh" },
    judge: { model: "gemini-2.5-pro-exp", effort: "high" },
    reviewer: { model: "gemini-2.5-pro-exp", effort: "high" },
  };

  for (const opts of [{ harness: "paseo" }, { provider: "better-paseo-antigravity" }, { harness: "paseo", provider: "better-paseo-antigravity" }]) {
    const product = repo({ "src/a.js": "export const a = 1;\n" });
    const res = initLoop({ cwd: product, env, ...opts });
    const raw = JSON.parse(readFileSync(res.config, "utf8"));
    assert.equal(raw.judgeIndependence, "model", JSON.stringify(opts));
    for (const [role, spec] of Object.entries(expectedModels)) {
      assert.deepEqual(raw.agents[role], { runner: "paseo", provider: "better-paseo-antigravity", ...spec }, `${role} ${JSON.stringify(opts)}`);
      assert.equal(argv(raw.agents[role], { confined: role === "reviewer", cwd: product, addDirs: [] }), null);
    }
    const loaded = load(res.config);
    assert.equal(loaded.judgeIndependence, "model");
  }

  for (const opts of [{ harness: "t3", provider: "antigravity" }, { provider: "antigravity" }]) {
    const product = repo({ "src/a.js": "export const a = 1;\n" });
    const res = initLoop({ cwd: product, env, ...opts });
    const raw = JSON.parse(readFileSync(res.config, "utf8"));
    assert.equal(raw.judgeIndependence, "model", JSON.stringify(opts));
    for (const [role, spec] of Object.entries(expectedModels)) {
      assert.deepEqual(raw.agents[role], { runner: "t3", provider: "antigravity", ...spec }, `${role} ${JSON.stringify(opts)}`);
      assert.equal(argv(raw.agents[role], { confined: role === "reviewer", cwd: product, addDirs: [] }), null);
    }
  }

  const t3DefaultProd = repo({ "src/a.js": "export const a = 1;\n" });
  const t3Default = JSON.parse(readFileSync(initLoop({ cwd: t3DefaultProd, env, harness: "t3" }).config, "utf8"));
  assert.equal("judgeIndependence" in t3Default, false);
  assert.deepEqual(t3Default.agents, {
    critic: { runner: "t3", provider: "codex" },
    actor: { runner: "t3", provider: "claude" },
    judge: { runner: "t3", provider: "codex" },
    reviewer: { runner: "t3", provider: "claude" },
  });

  const baseProd = repo({ "src/a.js": "export const a = 1;\n" });
  const baseCfg = JSON.parse(readFileSync(initLoop({ cwd: baseProd, env }).config, "utf8"));
  assert.equal("judgeIndependence" in baseCfg, false);
  assert.deepEqual(baseCfg.agents, {
    critic: { runner: "codex" },
    actor: { runner: "claude" },
    judge: { runner: "codex" },
    reviewer: { runner: "claude" },
  });

  const invalidProd = repo({ "src/a.js": "export const a = 1;\n" });
  for (const bad of [
    { harness: "unknown" },
    { runner: "unknown" },
    { harness: "t3", runner: "paseo" },
    { provider: "   " },
    { adapter: "bogus" },
    { independence: "none" },
    { runner: "claude", provider: "pi" },
    { harness: "t3", provider: "better-paseo-antigravity" },
  ]) {
    assert.throws(() => initLoop({ cwd: invalidProd, env, ...bad }), UsageError, JSON.stringify(bad));
  }
  assert.equal(existsSync(join(invalidProd, ".self-loop")), false);
  assert.equal(existsSync(join(invalidProd, ".gitignore")), false);
});

test("D-0068: initLoop and self-loop.mjs init accept arbitrary providers, adapters, per-role models, and independence policies", () => {
  const env = isolatedEnv();
  const prodPi = repo({ "src/a.js": "export const a = 1;\n" });
  const resPi = initLoop({
    cwd: prodPi,
    env,
    harness: "t3",
    provider: "pi",
    model: "openrouter/gemini-2.5-pro-exp",
  });
  const cfgPi = JSON.parse(readFileSync(resPi.config, "utf8"));
  assert.equal("judgeIndependence" in cfgPi, false);
  for (const role of ["critic", "actor", "judge", "reviewer"]) {
    assert.deepEqual(cfgPi.agents[role], { runner: "t3", provider: "pi", model: "openrouter/gemini-2.5-pro-exp" }, role);
    assert.equal(argv(cfgPi.agents[role], { confined: role === "reviewer", cwd: prodPi, addDirs: [] }), null);
  }

  const prodCli = repo({ "src/a.js": "export const a = 1;\n" });
  const cliInit = selfLoop([
    "init",
    "--harness", "paseo",
    "--provider", "opencode",
    "--adapter", "generic",
    "--actor-model", "openrouter/gemini-2.5-flash",
    "--critic-model", "xai/grok-4",
    "--judge-model", "anthropic/claude-opus-4-6",
    "--reviewer-model", "deepseek-r1",
    "--independence", "session",
    "--json",
  ], { cwd: prodCli, env });
  assert.equal(cliInit.status, 0, cliInit.stderr);
  const parsed = JSON.parse(cliInit.stdout);
  const cfgCli = JSON.parse(readFileSync(parsed.config, "utf8"));
  assert.equal(cfgCli.judgeIndependence, "session");
  assert.deepEqual(cfgCli.agents, {
    critic: { runner: "paseo", provider: "opencode", adapter: "generic", model: "xai/grok-4" },
    actor: { runner: "paseo", provider: "opencode", adapter: "generic", model: "openrouter/gemini-2.5-flash" },
    judge: { runner: "paseo", provider: "opencode", adapter: "generic", model: "anthropic/claude-opus-4-6" },
    reviewer: { runner: "paseo", provider: "opencode", adapter: "generic", model: "deepseek-r1" },
  });
  assert.equal(load(parsed.config).judgeIndependence, "session");

  const prodRunner = repo({ "src/a.js": "export const a = 1;\n" });
  const cliRunner = selfLoop(["init", "--runner", "claude", "--model", "claude-opus-4-6", "--independence", "model"], { cwd: prodRunner, env });
  assert.equal(cliRunner.status, 0, cliRunner.stderr);
  const cfgRunner = JSON.parse(readFileSync(join(prodRunner, ".self-loop", "loop.json"), "utf8"));
  assert.equal(cfgRunner.judgeIndependence, "model");
  for (const role of ["critic", "actor", "judge", "reviewer"]) {
    assert.deepEqual(cfgRunner.agents[role], { runner: "claude", model: "claude-opus-4-6" }, role);
  }
});

test("D-0067: git-plumbing defaults GIT_TERMINAL_PROMPT=0 across run, git, and gitOk while allowing explicit override", () => {
  const saved = process.env.GIT_TERMINAL_PROMPT;
  delete process.env.GIT_TERMINAL_PROMPT;
  try {
    const outDefault = plumbingRun(process.execPath, ["-e", "process.stdout.write(process.env.GIT_TERMINAL_PROMPT ?? '')"], { encoding: "utf8" });
    assert.equal(outDefault, "0");

    const outCustomBase = plumbingRun(process.execPath, ["-e", "process.stdout.write(JSON.stringify([process.env.GIT_TERMINAL_PROMPT, process.env.ONLY_TEST]))"], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, ONLY_TEST: "yes" },
    });
    assert.deepEqual(JSON.parse(outCustomBase), ["0", "yes"]);

    const outOverride = plumbingRun(process.execPath, ["-e", "process.stdout.write(process.env.GIT_TERMINAL_PROMPT ?? '')"], {
      encoding: "utf8",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "1" },
    });
    assert.equal(outOverride, "1");

    const r = repo({ "a.txt": "1\n" });
    assert.equal(plumbingGit(r, "-c", 'alias.promptcheck=!printf "%s" "$GIT_TERMINAL_PROMPT"', "promptcheck"), "0");
    assert.equal(plumbingGitOk(r, "-c", 'alias.promptok=!test "$GIT_TERMINAL_PROMPT" = "0"', "promptok"), true);
  } finally {
    if (saved === undefined) delete process.env.GIT_TERMINAL_PROMPT;
    else process.env.GIT_TERMINAL_PROMPT = saved;
  }
});

test("F-0015: self-loop clean/prune/records gc/compact, hooks install --records, next --full, and read-only start hygiene screening", () => {
  const lead = loopProduct({ activity: hoursBefore(1) });
  const env = isolatedEnv();
  const cfgPath = join(lead.records, "loop.json");
  const loadedCfg = load(cfgPath);
  const staleWs = join(loadedCfg.workDir, "0001-actor-done");
  const staleManifest = join(staleWs, "call.json");
  mkdirSync(staleWs, { recursive: true });
  writeFileSync(staleManifest, JSON.stringify({
    version: 2, id: "R-0001-actor", phase: "v1", role: "actor", round: 1, step: "actor",
    record: "rounds/0001-actor.md", nonce: "0123456789abcdef", ws: staleWs, wt: join(staleWs, "wt"), recorded: true,
  }) + "\n");
  mkdirSync(join(lead.records, "evidence", "0001", "actor-1", "out"), { recursive: true });
  writeFileSync(join(lead.records, "evidence", "0001", "actor-1", "out", "old.txt"), "old-evidence\n");
  mkdirSync(join(lead.records, "rounds"), { recursive: true });
  writeFileSync(join(lead.records, "rounds", "0010-actor.md"), "# R-0010-actor\n");
  git(lead.records, "add", "-A");
  git(lead.records, "commit", "-qm", "seed old evidence and round 10");

  const startBefore = snapshot(lead);
  const startJson = selfLoop(["start", "--now", NOW, "--config", cfgPath, "--json"], { cwd: lead.product, env });
  assert.equal(startJson.status, 0, startJson.stderr);
  const parsedStart = JSON.parse(startJson.stdout);
  assert.equal(parsedStart.session.error, null);
  assert.equal(typeof parsedStart.session.next, "string");
  assert.equal(parsedStart.session.hygiene.healthy, false);
  assert.ok(parsedStart.session.hygiene.findings.some(f => f.includes("hooks install --records")));
  assert.equal(existsSync(join(lead.records, ".githooks", "pre-commit")), false, "start never writes pre-commit hook");
  assert.equal(existsSync(staleWs), true, "start never deletes stale workspaces");
  assert.deepEqual(snapshot(lead), startBefore, "start mutates nothing");

  const hookDry = selfLoop(["hooks", "install", "--records", lead.records, "--dry-run", "--json"], { cwd: lead.product, env });
  assert.equal(hookDry.status, 0, hookDry.stderr);
  assert.equal(JSON.parse(hookDry.stdout).dryRun, true);
  assert.equal(existsSync(join(lead.records, ".githooks", "pre-commit")), false);

  const hookInstall = selfLoop(["hooks", "install", "--records", lead.records, "--json"], { cwd: lead.product, env });
  assert.equal(hookInstall.status, 0, hookInstall.stderr);
  assert.equal(JSON.parse(hookInstall.stdout).changed, true);
  assert.equal(existsSync(join(lead.records, ".githooks", "pre-commit")), true);
  assert.equal(git(lead.records, "config", "--local", "--get", "core.hooksPath"), ".githooks");

  for (const argv of [
    ["clean", "--config", cfgPath, "--json"],
    ["prune", "--config", cfgPath, "--json"],
    ["records", "gc", "--config", cfgPath, "--json"],
    ["records", "compact", "--config", cfgPath, "--json"],
  ]) {
    const dry = selfLoop(argv, { cwd: lead.product, env });
    assert.equal(dry.status, 0, `${argv.join(" ")}: ${dry.stderr}`);
    const out = JSON.parse(dry.stdout);
    assert.equal(out.apply, false, `${argv.join(" ")} defaults to dry-run`);
    assert.equal(out.recordsResult.prunedFiles.length, 1);
    assert.equal(out.work.candidates.length, 1);
    assert.equal(existsSync(staleWs), true);
  }

  const applied = selfLoop(["clean", "--config", cfgPath, "--apply", "--json"], { cwd: lead.product, env });
  assert.equal(applied.status, 0, applied.stderr);
  const res = JSON.parse(applied.stdout);
  assert.equal(res.apply, true);
  assert.equal(res.recordsResult.prunedFiles.length, 1);
  assert.match(res.recordsResult.tombstonePath, /^prune\/PR-0001\.md$/);
  assert.equal(res.work.removed.length, 1);
  assert.equal(existsSync(staleWs), false);
  assert.equal(existsSync(join(lead.records, "evidence", "0001", "actor-1", "out", "old.txt")), false);

  const nextFull = selfLoop(["next", "--config", cfgPath, "--full"], { cwd: lead.product, env });
  assert.equal(nextFull.status, 0, nextFull.stderr);
  assert.match(nextFull.stdout, /Prose comments at [0-9a-f]{40}: 0/);
});
