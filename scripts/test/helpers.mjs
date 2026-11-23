import "../lib/unbind-git.mjs";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const here = dirname(fileURLToPath(import.meta.url));
export const fixtures = join(here, "fixtures");
export const scripts = join(here, "..");
export const skill = join(scripts, "..");
process.env.SELF_LOOP_TEST = "1"; // the scripted stand-in agent (fake-agent.mjs) runs on the `cmd` runner
export const temp = (name = "self-loop-test-") => mkdtempSync(join(tmpdir(), name));
const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
process.env.GIT_AUTHOR_NAME ??= "t"; process.env.GIT_AUTHOR_EMAIL ??= "t@example.invalid";
process.env.GIT_COMMITTER_NAME ??= "t"; process.env.GIT_COMMITTER_EMAIL ??= "t@example.invalid";

export function git(repo, ...argv) {
  return execFileSync("git", ["-C", repo, ...argv], { encoding: "utf8", env: ENV }).trim();
}

/** A git repository with the given files committed. */
export function repo(files, dir = temp()) {
  git(dir, "init", "-q", "-b", "main");
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  if (Object.keys(files).length) { git(dir, "add", "-A"); git(dir, "commit", "-q", "-m", "init"); }
  return dir;
}

/** Replay the frozen S4 ancestry and access.js excerpts as an isolated Git repository. */
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
  git(product, "remote", "add", "origin", "https://github.com/example/app.git");
  return { product, commits };
}

/** Every file under a folder whose text contains `needle`. */
export function grepTree(dir, needle) {
  const hits = [];
  const walk = d => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else if (readFileSync(p, "utf8").includes(needle)) hits.push(p.slice(dir.length + 1)); } };
  if (existsSync(dir)) walk(dir);
  return hits;
}

export const BRIEFS = { shared: "engines/shared.md", critic: "engines/critic.md", actor: "engines/actor.md", judge: "engines/judge.md", reviewer: "engines/frame-reviewer.md" };
export const green = (name = "verify", app = "github-actions", conclusion = "success", started_at = "2026-11-20T00:00:00Z") => ({ app, name, status: "completed", conclusion, started_at });

/**
 * A stand-in `gh` for the CI gate (lib/ci.mjs `FORGES.github.fetchRuns`), first on `env.PATH`: `gh api
 * repos/<owner/name>/commits/<sha>/check-runs…` logs the query and prints the runs `serve` holds for that repository
 * and commit, one JSON object per line as `--jq` does. A repository and commit it holds nothing for exits 1: the checks
 * cannot be read. No network.
 * @param served { "owner/name": { [sha]: runs } }
 * @returns {{ env, serve(served), queries(): string[] }} `queries()` lists "owner/name sha" per read, in order
 */
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

/**
 * A stand-in `aws` CLI v2 on `env.PATH` for AWS CodeCommit/CodeBuild tests (single AWS test seam mirroring `fakeGh`).
 * Enforces real AWS CLI v2 semantics: auto-pagination without `--max-items`/`--no-paginate`, error on `--sort-order`
 * when holding >100 builds, strict unknown-flag rejection (including `--next-token`), mutual exclusion of
 * `--no-paginate` with `--max-items`/`--starting-token`, and `--cli-input-json` support. Logs exact argv and AWS env.
 */
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

/** Red evidence: the line of fixtures/v0.2-red/probes.log for a case, run on a4db050 (probes.mjs.txt there). */
export const redOn = name => {
  const line = readFileSync(join(fixtures, "v0.2-red", "probes.log"), "utf8").split("\n").find(l => l.startsWith(`${name} `));
  if (!line) throw new Error(`no red evidence for ${name}`);
  return JSON.parse(line.slice(name.length + 1));
};

/**
 * A product repository (branch loop/s5, a GitHub-looking origin), a sealed repository, a records repository with
 * committed briefs, and a config whose agents are the scripted stand-in (fake-agent.mjs). `run(role, opts)` makes one
 * call through call.mjs's module entry.
 */
export async function setup(scenario = {}, overrides = {}) {
  const { call, normalize } = await import("../call.mjs");
  const product = repo({ "src/a.js": "export const a = 1;\n", "test/a.test.js": "// cases\n", "docs/PURPOSE.md": "# Purpose\n\nBooks survive a restart.\n" });
  git(product, "branch", "loop/s5");
  git(product, "remote", "add", "origin", "https://github.com/example/product.git");
  const sealed = repo({ "case-07.mjs": "export default { expects: 'SEALED_CASE_07' }\n" });
  const { BLUEPRINT, inspectBlueprint, renderBlueprint } = await import("../lib/blueprint.mjs");
  const { ownerAlarms } = await import("../lib/blueprint-alarms.mjs");
  const files = {
    "README.md": "# loop records\n",
    "purpose/P-0001.md": "# P-0001 Test purpose\n",
    "blueprint/F-0001.md": "# F-0001 Test feature\n\nid: F-0001\nphase: S5\nrequirements: P-0001\n",
    ...Object.fromEntries(Object.values(BRIEFS).map(p => [p, `# ${p}\n\nBrief text.\n`])),
    ...overrides.recordFiles,
  };
  if (overrides.frame !== false) {
    const record = "rounds/0001-reviewer-frame.md";
    files[record] = "# R-0001-reviewer-frame\n";
    files["metrics/handoffs.jsonl"] = JSON.stringify({
      id: "R-0001-reviewer-frame", time: "2026-11-20T00:00:00Z", phase: "S5", round: 1, step: "reviewer-frame", role: "reviewer",
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
  const { recordFiles, frame, ...rest } = overrides;
  const cfg = normalize({
    product, branch: "loop/s5", records, phase: "S5", workDir: join(dir, "work"), briefs: BRIEFS, sealed: [sealed],
    purpose: ["docs/PURPOSE.md"], owns: { critic: ["test"], actor: ["src"] }, protected: ["main"],
    agents: { critic: agent(), actor: agent(), judge: agent(), reviewer: agent() }, commitPrefix: "loop(s5)",
    ...rest,
  }, dir);
  const logs = [];
  const run = (role, opts = {}) => call(cfg, role, { round: 1, task: `Task for the ${role}.\nfeatures: ${role === "reviewer" ? "none" : "F-0001"}\n`, ...opts }, { log: m => logs.push(m) });
  const counts = () => (existsSync(`${scenarioFile}.counts.json`) ? JSON.parse(readFileSync(`${scenarioFile}.counts.json`, "utf8")) : {});
  const prompt = (role, n) => readFileSync(`${scenarioFile}.${role}.${n}.prompt`, "utf8");
  const scenarioSet = s => writeFileSync(scenarioFile, JSON.stringify(s));
  return { cfg, product, records, sealed, dir, scenarioFile, logs, run, counts, prompt, scenarioSet };
}

/** Environment for a child self-loop command: a private HOME and no inherited owner store or configuration. */
export function isolatedEnv(extra = {}) {
  const env = { ...process.env, HOME: temp("self-loop-home-") };
  for (const key of [
    "SELF_LOOP_OWNER_STORE", "SELF_LOOP_CONFIG", "NODE_TEST_CONTEXT",
    "GEMINI_HOME", "ANTIGRAVITY_APP_DATA_DIR", "T3CODE_HOME", "ANTIGRAVITY_LS_VERSION",
    "CLAUDE_CONFIG_DIR", "CODEX_HOME", "T3CODE_THREAD_ID",
  ]) delete env[key];
  return { ...env, ...extra };
}

/** Run scripts/self-loop.mjs. */
export function selfLoop(args, { cwd = process.cwd(), env = isolatedEnv() } = {}) {
  return spawnSync(process.execPath, [join(scripts, "self-loop.mjs"), ...args], { cwd, env, encoding: "utf8" });
}

/**
 * A product loop: a product repository (branch loop/v1) and its records repository holding loop.json. `activity` is
 * the time of one `building` feature event (none when null); `loop` overrides loop.json fields.
 */
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

/** An owner store with its registry committed. */
export function ownerStore(products, { roots = [], dir = temp("self-loop-owner-"), bound = {} } = {}) {
  return repo({ "README.md": "# Owner store\n", "products.json": JSON.stringify({ products, roots, ...bound }, null, 2) + "\n" }, dir);
}

export const ROOMY = { maxLoadRatio: 1e9, minAvailableMemoryGB: 0 };
export const CROWDED = { minAvailableMemoryGB: 1e9 };
export const roomyStore = () => ownerStore([], { bound: ROOMY });
