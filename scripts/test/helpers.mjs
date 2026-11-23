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
 * A stand-in `gh` for the CI gate (lib/ci.mjs `fetchCheckRuns`), first on `env.PATH`: `gh api
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
  return { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, serve, queries };
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
  for (const key of ["SELF_LOOP_OWNER_STORE", "SELF_LOOP_CONFIG", "NODE_TEST_CONTEXT"]) delete env[key];
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
