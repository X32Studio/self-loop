// F-0008, D-0060
import "../lib/unbind-git.mjs";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const here = dirname(fileURLToPath(import.meta.url));
export const fixtures = join(here, "fixtures");
export const scripts = join(here, "..");
export const skill = join(scripts, "..");
process.env.SELF_LOOP_TEST = "1";
export const temp = (name = "self-loop-test-") => realpathSync(mkdtempSync(join(tmpdir(), name)));
const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
process.env.GIT_AUTHOR_NAME ??= "t"; process.env.GIT_AUTHOR_EMAIL ??= "t@example.invalid";
process.env.GIT_COMMITTER_NAME ??= "t"; process.env.GIT_COMMITTER_EMAIL ??= "t@example.invalid";

export function git(repo, ...argv) {
  return execFileSync("git", ["-C", repo, ...argv], { encoding: "utf8", env: ENV }).trim();
}

export function repo(files, dir = temp()) {
  git(dir, "init", "-q", "-b", "main");
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  if (Object.keys(files).length) { git(dir, "add", "-A"); git(dir, "commit", "-q", "-m", "init"); }
  return dir;
}

export function s4History() {
  const product = repo({}), commits = new Map();
  for (const { sha, parent, refs, access } of JSON.parse(readFileSync(join(fixtures, "s4-history.json"), "utf8"))) {
    const path = join(product, "src/access.js");
    git(product, "read-tree", "--empty");
    if (access) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, access.join("\n") + "\n");
      git(product, "add", "src/access.js");
    }
    const tree = git(product, "write-tree");
    const replay = git(product, "commit-tree", tree, ...(parent ? ["-p", commits.get(parent)] : []), "-m", sha);
    commits.set(sha, replay);
    for (const ref of refs) git(product, "update-ref", ref, replay);
  }
  git(product, "remote", "add", "origin", "https://github.com/example-org/example-app.git");
  return { product, commits };
}

export function grepTree(dir, needle) {
  const hits = [];
  const walk = d => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else if (readFileSync(p, "utf8").includes(needle)) hits.push(p.slice(dir.length + 1)); } };
  if (existsSync(dir)) walk(dir);
  return hits;
}

export const BRIEFS = { shared: "engines/shared.md", critic: "engines/critic.md", actor: "engines/actor.md", judge: "engines/judge.md", reviewer: "engines/frame-reviewer.md" };
export const green = (name = "verify", app = "github-actions", conclusion = "success", started_at = "2026-11-20T00:00:00Z") => ({ app, name, status: "completed", conclusion, started_at });

export function fakeGh(served = {}) {
  const bin = temp("self-loop-gh-");
  const data = join(bin, "runs.json"), log = join(bin, "queries");
  const serve = runs => writeFileSync(data, JSON.stringify(runs));
  serve(served);
  writeFileSync(join(bin, "gh"), `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require("node:fs");
const match = /^repos\\/([^/]+\\/[^/]+)\\/commits\\/([0-9a-f]{40})\\/check-runs\\?/.exec(process.argv.find(arg => arg.startsWith("repos/")) ?? "");
if (process.argv[2] !== "api" || !match) process.exit(78);
appendFileSync(${JSON.stringify(log)}, match[1] + " " + match[2] + "\\n");
const runs = JSON.parse(readFileSync(${JSON.stringify(data)}, "utf8"))[match[1]]?.[match[2]];
if (!Array.isArray(runs)) process.exit(1);
for (const run of runs) console.log(JSON.stringify(run));
`, { mode: 0o755 });
  const queries = () => existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
  return { bin, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, serve, queries };
}

export function fakeAws(initialState = {}) {
  const bin = temp("self-loop-aws-");
  const data = join(bin, "state.json"), log = join(bin, "calls.jsonl");
  const serve = nextState => writeFileSync(data, JSON.stringify(nextState));
  serve(initialState);
  writeFileSync(join(bin, "aws"), `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require("node:fs");
const argv = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify({
  argv,
  env: {
    AWS_REGION: process.env.AWS_REGION,
    AWS_DEFAULT_REGION: process.env.AWS_DEFAULT_REGION,
    AWS_PROFILE: process.env.AWS_PROFILE,
    AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: process.env.AWS_IGNORE_CONFIGURED_ENDPOINT_URLS,
    AWS_CLI_AUTO_PROMPT: process.env.AWS_CLI_AUTO_PROMPT,
    AWS_PAGER: process.env.AWS_PAGER,
    endpointKeys: Object.keys(process.env).filter(k => /^AWS_ENDPOINT_URL/i.test(k)),
  },
}) + "\\n");
const state = JSON.parse(readFileSync(${JSON.stringify(data)}, "utf8"));
const fail = (status, msg) => { process.stderr.write(msg + "\\n"); process.exit(status); };
function parseFlags(tokens, allowed) {
  const flags = {};
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t.startsWith("--")) fail(252, "Unknown positional argument: " + t);
    const eq = t.indexOf("=");
    const name = eq >= 0 ? t.slice(0, eq) : t;
    if (!allowed.has(name)) fail(252, "Unknown options: " + name);
    if (name === "--no-paginate") {
      if (eq >= 0) fail(252, "Flag takes no value: " + name);
      flags[name] = true;
    } else if (eq >= 0) {
      flags[name] = t.slice(eq + 1);
    } else {
      if (i + 1 >= tokens.length) fail(252, "Missing value for " + name);
      flags[name] = tokens[++i];
    }
  }
  return flags;
}
function maybeFail(err) {
  if (!err) return;
  fail(err.status ?? 254, err.stderr ?? "ServiceException");
}
if (argv[0] === "configure" && argv[1] === "get" && argv[2] === "region") {
  const flags = parseFlags(argv.slice(3), new Set(["--profile"]));
  const profile = flags["--profile"] ?? process.env.AWS_PROFILE ?? "default";
  const region = state.profiles?.[profile]?.region;
  if (!region) process.exit(1);
  process.stdout.write(region + "\\n");
  process.exit(0);
}
if (argv[0] === "sts" && argv[1] === "get-caller-identity") {
  parseFlags(argv.slice(2), new Set(["--region", "--profile", "--output"]));
  maybeFail(state.stsError);
  if (state.stsRaw !== undefined) { process.stdout.write(String(state.stsRaw)); process.exit(0); }
  const account = state.account ?? "123456789012";
  process.stdout.write(JSON.stringify({ UserId: "AIDAEXAMPLE0000000000", Account: account, Arn: "arn:aws:iam::" + account + ":user/ci" }) + "\\n");
  process.exit(0);
}
if (argv[0] === "codebuild" && argv[1] === "list-builds-for-project") {
  const flags = parseFlags(argv.slice(2), new Set(["--project-name", "--max-items", "--starting-token", "--no-paginate", "--sort-order", "--region", "--profile", "--output"]));
  if (flags["--no-paginate"] && (flags["--max-items"] !== undefined || flags["--starting-token"] !== undefined)) {
    fail(252, "Cannot specify --no-paginate with --max-items or --starting-token");
  }
  const project = flags["--project-name"];
  if (!project) fail(252, "Missing --project-name");
  const proj = state.projects?.[project];
  maybeFail(state.listError);
  if (proj?.listRaw !== undefined) { process.stdout.write(String(proj.listRaw)); process.exit(0); }
  if (proj === null) fail(254, "An error occurred (ResourceNotFoundException) when calling the ListBuildsForProject operation");
  if (!proj) { process.stdout.write(JSON.stringify({ ids: [] }) + "\\n"); process.exit(0); }
  const totalCount = proj.pages ? proj.pages.reduce((n, p) => n + (p.ids?.length ?? 0), 0) : (proj.ids?.length ?? 0);
  if (flags["--sort-order"] !== undefined && totalCount > 100) {
    fail(254, "An error occurred (InvalidInputException) when calling the ListBuildsForProject operation: --sort-order is not supported for >100 builds");
  }
  if (proj.pages) {
    const idx = flags["--starting-token"] ? Number(String(flags["--starting-token"]).replace(/^page_/, "")) : 0;
    const page = proj.pages[idx] ?? { ids: [] };
    process.stdout.write(JSON.stringify(page) + "\\n");
    process.exit(0);
  }
  const allIds = proj.ids ?? [];
  if (flags["--max-items"] === undefined && !flags["--no-paginate"]) {
    process.stdout.write(JSON.stringify({ ids: allIds }) + "\\n");
    process.exit(0);
  }
  if (flags["--no-paginate"]) {
    const slice = allIds.slice(0, 100);
    const out = { ids: slice, ...(allIds.length > 100 ? { NextToken: "tok_100" } : {}) };
    process.stdout.write(JSON.stringify(out) + "\\n");
    process.exit(0);
  }
  const maxItems = Number(flags["--max-items"]);
  if (!Number.isInteger(maxItems) || maxItems <= 0) fail(252, "Invalid --max-items");
  const offset = flags["--starting-token"] ? Number(String(flags["--starting-token"]).replace(/^tok_/, "")) : 0;
  if (!Number.isInteger(offset) || offset < 0) fail(252, "Invalid --starting-token");
  const ids = allIds.slice(offset, offset + maxItems);
  const out = { ids, ...(offset + maxItems < allIds.length ? { NextToken: "tok_" + (offset + maxItems) } : {}) };
  process.stdout.write(JSON.stringify(out) + "\\n");
  process.exit(0);
}
if (argv[0] === "codebuild" && argv[1] === "batch-get-builds") {
  const flags = parseFlags(argv.slice(2), new Set(["--cli-input-json", "--region", "--profile", "--output"]));
  if (!flags["--cli-input-json"]) fail(252, "Missing --cli-input-json");
  let input;
  try { input = JSON.parse(flags["--cli-input-json"]); } catch { fail(252, "Invalid JSON for --cli-input-json"); }
  if (!Array.isArray(input?.ids) || input.ids.length === 0 || input.ids.length > 100) fail(252, "Invalid ids in --cli-input-json");
  const allBuilds = state.builds ?? {};
  const omit = new Set(state.omitIds ?? []);
  const builds = [], buildsNotFound = [];
  for (const id of input.ids) {
    if (omit.has(id)) continue;
    if (Object.prototype.hasOwnProperty.call(allBuilds, id)) builds.push(allBuilds[id]);
    else buildsNotFound.push(id);
  }
  if (Array.isArray(state.extraBuilds)) builds.push(...state.extraBuilds);
  process.stdout.write(JSON.stringify({ builds, buildsNotFound }) + "\\n");
  process.exit(0);
}
fail(252, "Unsupported aws command: " + argv.join(" "));
`, { mode: 0o755 });
  const calls = () => existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
  const clearCalls = () => writeFileSync(log, "");
  return { bin, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, serve, calls, clearCalls };
}

export const redOn = name => {
  const line = readFileSync(join(fixtures, "v0.2-red", "probes.log"), "utf8").split("\n").find(l => l.startsWith(`${name} `));
  if (!line) throw new Error(`no red evidence for ${name}`);
  return JSON.parse(line.slice(name.length + 1));
};

const pad4 = n => String(n).padStart(4, "0");
const globOf = list => (list ?? []).map(p => `${p.replace(/\/$/, "")}/**`).join(", ");
const renderPlan = (id, scope, phase, packages) => [
  `# ${id} Test plan`, `scope: ${scope}`, `phase: ${phase}`, "",
  ...packages.flatMap(p => [
    `## ${p.id}`, `role: ${p.role}`, `handoff: ${p.handoff}`, "authority: D-0001",
    `goal: Test ${p.id}`, `files: ${p.files ?? ""}`, "interface: fixed", "acceptance: pass",
    `needs: ${p.needs ?? ""}`, ...(p.reviews ? [`reviews: ${p.reviews}`] : []), "",
  ]),
].join("\n");

export async function setup(scenario = {}, overrides = {}) {
  const { call, normalize, preparedIn } = await import("../call.mjs");
  const { gitOk, regularFiles } = await import("../lib/git-plumbing.mjs");
  const { HANDOFFS, hasPhaseFrame, idOf, parseHandoffs } = await import("../lib/handoff.mjs");
  const { plansFrom, snapshot } = await import("../lib/plan.mjs");
  const { commitRecords } = await import("../lib/records-commit.mjs");
  const product = repo({ "src/a.js": "export const a = 1;\n", "test/a.test.js": "// cases\n", "docs/PURPOSE.md": "# Purpose\n\nBooks survive a restart.\n" });
  git(product, "branch", "loop/s5");
  git(product, "remote", "add", "origin", "https://github.com/example/product.git");
  const sealed = repo({ "case-07.mjs": "export default { expects: 'SEALED_CASE_07' }\n" });
  const { BLUEPRINT, inspectBlueprint, renderBlueprint } = await import("../lib/blueprint.mjs");
  const { ownerAlarms } = await import("../lib/blueprint-alarms.mjs");
  const initPhase = overrides.phase ?? "S5";
  const owns = overrides.owns ?? { critic: ["test"], actor: ["src"] };
  const extraRecords = overrides.recordFiles ?? {};
  const files = {
    "README.md": "# loop records\n",
    "purpose/P-0001.md": "# P-0001 Test purpose\n",
    "decisions/D-0001.md": "# D-0001 Test decision\n\nid: D-0001\nby: owner\nstatus: active\n",
    "blueprint/F-0001.md": `# F-0001 Test feature\n\nid: F-0001\nphase: ${initPhase}\nrequirements: P-0001\n`,
    ...Object.fromEntries(Object.values(BRIEFS).map(p => [p, `# ${p}\n\nBrief text.\n`])),
    ...(overrides.plans !== false && !Object.keys(extraRecords).some(k => k.startsWith("plans/")) ? {
      "plans/PL-0001.md": renderPlan("PL-0001", "helper/r1", initPhase, [
        { id: "critic", role: "critic", handoff: "R-0001-critic", files: globOf(owns.critic), reviews: "actor" },
        { id: "actor", role: "actor", handoff: "R-0001-actor", files: globOf(owns.actor) },
        { id: "judge-cov", role: "judge", handoff: "R-0001-judge-cov", files: "" },
      ]),
      "plans/PL-0002.md": renderPlan("PL-0002", "helper/r1-judge", initPhase, [
        { id: "judge", role: "judge", handoff: "R-0001-judge", files: "" },
      ]),
    } : {}),
    ...extraRecords,
  };
  if (overrides.frame !== false) {
    const record = "rounds/0001-reviewer-frame.md";
    files[record] = "# R-0001-reviewer-frame\n";
    files["metrics/handoffs.jsonl"] = JSON.stringify({
      id: "R-0001-reviewer-frame", time: "2026-11-20T00:00:00Z", phase: initPhase, round: 1, step: "reviewer-frame", role: "reviewer",
      record, files: [record], view: "f".repeat(40), attempt: 1, agent: { runner: "claude" }, product: null, audit: { violations: 0 },
    }) + "\n";
  }
  const blueprint = inspectBlueprint(product, { files: Object.keys(files).sort(), read: path => files[path] });
  files[BLUEPRINT] ??= renderBlueprint(blueprint, ownerAlarms(blueprint).map(alarm => alarm.detail));
  const records = repo(files);
  const dir = temp("self-loop-run-");
  const scenarioFile = join(dir, "scenario.json");
  writeFileSync(scenarioFile, JSON.stringify(scenario));
  const agent = () => ({ runner: "cmd", cmd: [process.execPath, join(here, "fake-agent.mjs"), scenarioFile] });
  const { recordFiles, frame, plans, ...rest } = overrides;
  const cfg = normalize({
    product, branch: "loop/s5", records, phase: initPhase, workDir: join(dir, "work"), briefs: BRIEFS, sealed: [sealed],
    purpose: ["docs/PURPOSE.md"], owns, protected: ["main"],
    agents: { critic: agent(), actor: agent(), judge: agent(), reviewer: agent() }, commitPrefix: "loop(s5)",
    ...rest,
  }, dir);
  const logs = [];
  const ensurePlan = (role, round, step) => {
    const metaJudge = role === "judge" && (/^judge-frame(?:-[a-z]+)*$/.test(step) || /^judge-comments(?:-[a-z]+)*$/.test(step));
    if (role === "reviewer" || metaJudge || process.env.SELF_LOOP_TEST !== "1") return {};
    if (!Number.isInteger(round) || round < 1) return {};
    if (step !== role && !new RegExp(`^${role}(-[a-z]+)+$`).test(step)) return {};
    if (gitOk(cfg.records, "cat-file", "-e", `HEAD:${HANDOFFS}`) && !gitOk(cfg.records, "diff", "--quiet", "HEAD", "--", HANDOFFS)) return {};
    const head = git(cfg.records, "rev-parse", "HEAD");
    const paths = new Set(regularFiles(cfg.records, head).map(f => f.path));
    const handoffs = paths.has(HANDOFFS) ? parseHandoffs(git(cfg.records, "show", `${head}:${HANDOFFS}`)) : [];
    if (!hasPhaseFrame(handoffs, cfg.phase, p => paths.has(p))) return {};
    const wanted = idOf(round, step);
    const st = snapshot(cfg.records, "HEAD");
    const all = plansFrom(st);
    const active = all.filter(p => p.phase === cfg.phase && !all.some(q => q.supersedes === p.id));
    for (const p of active) {
      const hit = p.packages.find(pkg => pkg.role === role && pkg.handoff === wanted);
      if (hit) return { plan: p.id, package: hit.id };
    }
    const maxNo = Math.max(9, ...all.map(p => Number(p.id.slice(3))).filter(Number.isFinite));
    const planId = `PL-${pad4(maxNo + 1)}`;
    const liveSame = preparedIn(cfg).some(w => w.liveWorkspace && w.role === role);
    const scopeFiles = liveSame ? "" : role === "actor" ? globOf(cfg.owns.actor) : role === "critic" ? globOf(cfg.owns.critic) : "";
    const pkgs = role === "actor"
      ? [
          { id: step, role: "actor", handoff: wanted, files: scopeFiles },
          { id: `${step}-cr`, role: "critic", handoff: `R-${pad4(round)}-critic-${step.replace(/[^a-z]/g, "")}cov`, files: "", reviews: step },
          { id: `${step}-jg`, role: "judge", handoff: `R-${pad4(round)}-judge-${step.replace(/[^a-z]/g, "")}cov`, files: "" },
        ]
      : [{ id: step, role, handoff: wanted, files: scopeFiles }];
    commitRecords(cfg.records, ({ files: fset, add }) => {
      if (!fset.has("decisions/D-0001.md")) add("decisions/D-0001.md", "# D-0001 Test decision\n\nid: D-0001\nby: owner\nstatus: active\n");
      add(`plans/${planId}.md`, renderPlan(planId, `helper/${cfg.phase}/${round}/${step}`, cfg.phase, pkgs));
      return { message: `helper plan ${planId}` };
    });
    return { plan: planId, package: step };
  };
  const run = (role, opts = {}) => {
    const round = opts.round ?? 1;
    const step = opts.step ?? role;
    const auto = opts.plan === undefined && opts.package === undefined && opts.pkg === undefined ? ensurePlan(role, round, step) : {};
    return call(cfg, role, { round, step, task: `Task for the ${role}.\nfeatures: ${role === "reviewer" ? "none" : "F-0001"}\n`, ...auto, ...opts }, { log: m => logs.push(m) });
  };
  const counts = () => (existsSync(`${scenarioFile}.counts.json`) ? JSON.parse(readFileSync(`${scenarioFile}.counts.json`, "utf8")) : {});
  const prompt = (role, n) => readFileSync(`${scenarioFile}.${role}.${n}.prompt`, "utf8");
  const scenarioSet = s => writeFileSync(scenarioFile, JSON.stringify(s));
  return { cfg, product, records, sealed, dir, scenarioFile, logs, run, counts, prompt, scenarioSet };
}

export function isolatedEnv(extra = {}) {
  const env = { ...process.env, HOME: temp("self-loop-home-") };
  for (const key of [
    "SELF_LOOP_OWNER_STORE", "SELF_LOOP_CONFIG", "NODE_TEST_CONTEXT",
    "GEMINI_HOME", "ANTIGRAVITY_APP_DATA_DIR", "T3CODE_HOME", "ANTIGRAVITY_LS_VERSION",
    "CLAUDE_CONFIG_DIR", "CODEX_HOME", "T3CODE_THREAD_ID",
  ]) delete env[key];
  return { ...env, ...extra };
}

export function selfLoop(args, { cwd = process.cwd(), env = isolatedEnv() } = {}) {
  return spawnSync(process.execPath, [join(scripts, "self-loop.mjs"), ...args], { cwd, env, encoding: "utf8" });
}

export function loopProduct({ phase = "v1", activity = null, loop = {}, loopJson = true, dir = temp("self-loop-product-") } = {}) {
  const product = join(dir, "product"), records = join(dir, "records");
  mkdirSync(product, { recursive: true });
  mkdirSync(records, { recursive: true });
  repo({ "src/a.js": "export const a = 1;\n" }, product);
  git(product, "branch", "loop/v1");
  const files = {
    "README.md": "# records\n", "records.json": "{}\n", "purpose/P-0001.md": "# P-0001 Purpose\n",
    "blueprint/F-0001.md": `# F-0001 Feature\n\nid: F-0001\nphase: ${phase}\nrequirements: P-0001\n`,
  };
  if (activity) files["metrics/blueprint.jsonl"] = JSON.stringify({ feature: "F-0001", phase, status: "building", time: activity, by: "lead", note: "Work started", evidence: {} }) + "\n";
  if (loopJson) files["loop.json"] = JSON.stringify({ product, branch: "loop/v1", records: ".", workDir: join(dir, "work"), phase,
    briefs: BRIEFS, agents: { critic: { runner: "codex" }, actor: { runner: "claude" }, judge: { runner: "codex" }, reviewer: { runner: "claude" } }, ...loop }, null, 2) + "\n";
  repo(files, records);
  return { dir, product, records };
}

export function ownerStore(products, { roots = [], dir = temp("self-loop-owner-"), bound = {} } = {}) {
  return repo({ "README.md": "# Owner store\n", "products.json": JSON.stringify({ products, roots, ...bound }, null, 2) + "\n" }, dir);
}

export const ROOMY = { maxLoadRatio: 1e9, minAvailableMemoryGB: 0 };
export const CROWDED = { minAvailableMemoryGB: 1e9 };
export const roomyStore = () => ownerStore([], { bound: ROOMY });
