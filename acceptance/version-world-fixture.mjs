import { chmodSync, cpSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { bytes } from "./closing-fixture.mjs";
import { json, put, skill, world } from "./fixture.mjs";
import { seed, seeded } from "./scenario.mjs";

const fullSuite = "node --test scripts/test/*.test.mjs && if [ -d acceptance ]; then node --test acceptance; fi";

export function versionScenario() {
  const draw = seeded(seed);
  const core = `2.${draw(100)}.${draw(100)}`;
  return {
    parent: core + "-rc.9", higher: core + "-rc.10", lower: core + "-rc.8",
    invalid: [core + "-rc.01", core + "+build"],
  };
}

export function versionWorld(t, { failTip = false, pause = false } = {}) {
  const w = world(t);
  const versions = versionScenario();
  const log = join(w.dir, "suite-runs");
  const load = join(w.dir, "suite-load");
  const go = join(w.dir, "continue-suite");
  const testBody = `import assert from "node:assert/strict";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { setTimeout } from "node:timers/promises";
import test from "node:test";

test("measure the version suite", async () => {
  const version = readFileSync("VERSION", "utf8").trim();
  appendFileSync(${JSON.stringify(log)}, version + "\\n");
  ${pause ? `while (!existsSync(${JSON.stringify(go)})) await setTimeout(20);` : ""}
  ${failTip ? `assert.notEqual(version, ${JSON.stringify(versions.higher)}, "VERSION is rejected by the suite");` : ""}
});
`;
  const product = w.repo(join(w.dir, "version-product"), {
    VERSION: versions.parent + "\n", "README.md": "# Version example\n", "scripts/test/probe.test.mjs": testBody,
  });
  const source = join(skill, "scripts");
  cpSync(source, join(product, "scripts"), {
    recursive: true,
    filter: file => file !== join(source, "test"),
  });
  cpSync(join(skill, ".githooks"), join(product, ".githooks"), { recursive: true });
  const parent = w.commit(product, "Install release hooks");
  const hook = () => w.git(product, "config", "core.hooksPath", ".githooks");
  const addRemote = name => {
    const bare = join(w.dir, name + ".git");
    mkdirSync(bare);
    w.git(bare, "init", "-q", "--bare");
    return bare;
  };
  const bare = addRemote("origin");
  w.git(product, "remote", "add", "origin", bare);
  const refs = (repo = bare) => w.git(repo, "for-each-ref", "--format=%(objectname) %(refname)");
  const runs = () => bytes(log).toString().split("\n").filter(Boolean);
  const version = (args, cwd = product) => w.run(args,
    { entry: "version-gate.mjs", cwd, extraEnv: { SELF_LOOP_LOAD_DIR: load } });
  const suiteSettings = { entry: "suite-green.mjs", extraEnv: { SELF_LOOP_LOAD_DIR: load } };
  const suiteArgs = (sha, args) =>
    ["--repo", product, "--sha", sha, "--command", fullSuite, "--format", "node-test", ...args];
  const suite = (sha = parent, args = []) => w.run(suiteArgs(sha, args), suiteSettings);
  const suiteAsync = (sha = parent, args = []) => w.runAsync(suiteArgs(sha, args), suiteSettings);
  const editTip = () => {
    put(product, "VERSION", versions.higher + "\n");
    return w.commit(product, "Prepare the higher VERSION");
  };
  const state = () => ({
    head: w.git(product, "rev-parse", "HEAD"),
    index: readFileSync(join(product, ".git", "index")),
    readme: readFileSync(join(product, "README.md")),
    version: readFileSync(join(product, "VERSION")),
  });
  return { w, product, parent, versions, hook, addRemote, bare, refs, runs, log, load, go, version, suite, suiteAsync, editTip, state };
}

export const publicationScenario = () => {
  const draw = seeded(seed);
  const mirrorHost = "github.enterprise-" + draw(10_000) + ".example";
  const remoteName = "team." + draw(10_000) + "/release." + draw(10_000);
  return {
    publicHost: "github.com",
    mirrorHost,
    configuredRemote: remoteName,
    unknownRemote: remoteName + ".retired",
    variedVersion: "1." + draw(100) + "." + draw(100),
  };
};

export const readJson = path => JSON.parse(readFileSync(path, "utf8"));
export const treeOf = (p, sha) => p.w.git(p.product, "rev-parse", sha + "^{tree}");

export function serveHosts(p, scenario, githubRuns, mirrorRuns) {
  const { w, tip, first } = p;
  const { publicHost, mirrorHost } = scenario;
  const destinations = {
    [publicHost]: { [first.slug]: { [tip]: githubRuns } },
    [mirrorHost]: { [first.slug]: { [tip]: mirrorRuns } },
  };
  const data = put(w.bin, "ci-hosts.json", json(destinations));
  const log = join(w.bin, "ci-requests.jsonl");
  const script = `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require("node:fs");
const args = process.argv.slice(2);
const route = /^repos\\/([^/]+\\/[^/]+)\\/commits\\/([0-9a-f]+)\\/check-runs(?:\\?|$)/;
const match = route.exec(args.find(arg => route.test(arg)) ?? "");
if (args[0] !== "api" || !match) process.exit(78);
const hostArg = args.find(arg => arg.startsWith("--hostname="));
const hostIndex = args.indexOf("--hostname");
const host = (hostArg ? hostArg.split("=")[1] : hostIndex >= 0 ? args[hostIndex + 1] : process.env.GH_HOST) || "github.com";
const [, repository, sha] = match;
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ host, repository, sha }) + "\\n");
const snapshot = JSON.parse(readFileSync(${JSON.stringify(data)}, "utf8"));
const runs = snapshot[host]?.[repository]?.[sha];
if (!Array.isArray(runs)) process.exit(1);
for (const run of runs) console.log(JSON.stringify({ ...run, app: run.app.slug }));
`;
  chmodSync(put(w.bin, "gh", script), 0o755);
  return {
    env: { GH_HOST: mirrorHost },
    requests: () => bytes(log).toString().split("\n").filter(Boolean).map(line => JSON.parse(line)),
  };
}

export function runtimeChange(w, dimension) {
  const original = { node: process.versions.node, platform: process.platform, arch: process.arch };
  const draw = seeded(seed);
  const [major, minor, patch] = original.node.split(".").map(Number);
  const alternate = {
    node: `${major}.${minor}.${patch + 1 + draw(8)}`,
    platform: original.platform === "darwin" ? "linux" : "darwin",
    arch: original.arch === "x64" ? "arm64" : "x64",
  };
  const changed = { ...original, [dimension]: alternate[dimension] };
  const preload = put(w.dir, "suite-runtime.mjs", `
const runtime = ${JSON.stringify(changed)};
Object.defineProperty(process, "version", { value: "v" + runtime.node });
Object.defineProperty(process.versions, "node", { value: runtime.node });
Object.defineProperty(process, "platform", { value: runtime.platform });
Object.defineProperty(process, "arch", { value: runtime.arch });
`);
  return {
    original,
    changed,
    env: { NODE_OPTIONS: "--import=" + pathToFileURL(preload).href },
  };
}
