import assert from "node:assert/strict";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { now } from "./scenario.mjs";

export const acceptance = dirname(fileURLToPath(import.meta.url));
export const skill = dirname(acceptance);
export const json = value => JSON.stringify(value, null, 2) + "\n";
export const jsonl = (...rows) => rows.map(row => JSON.stringify(row) + "\n").join("");
export const options = { encoding: "utf8", timeout: 20_000, maxBuffer: 8 * 1024 * 1024 };
const phaseBranch = "loop/acceptance";

export function put(root, file, contents) {
  const path = join(root, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
  return path;
}

export function world(t, { clock = now } = {}) {
  const dir = realpathSync(mkdtempSync(join(acceptance, ".round1-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, "home");
  const projects = join(home, ".t3", "projects");
  const owner = join(projects, "owner-records");
  const bin = join(dir, "bin");
  const tmp = join(dir, "tmp");
  const outside = join(dir, "outside");
  for (const path of [owner, bin, tmp, outside]) mkdirSync(path, { recursive: true });
  // No provider environment, auth, per-user Git config, live home, or network Git transport.
  const env = {
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"),
    TMPDIR: tmp,
    PATH: [bin, dirname(process.execPath), process.env.PATH].join(delimiter),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ALLOW_PROTOCOL: "file",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Acceptance",
    GIT_AUTHOR_EMAIL: "acceptance@example.invalid",
    GIT_COMMITTER_NAME: "Acceptance",
    GIT_COMMITTER_EMAIL: "acceptance@example.invalid",
    SELF_LOOP_ADAPTERS: "none",
    SELF_LOOP_OWNER_STORE: owner,
    LC_ALL: "C",
    TZ: "UTC",
  };
  // Refuse unexpected external commands even when the host happens to have them installed.
  const stop = "#!/bin/sh\nexit 78\n";
  for (const name of ["gh", "t3", "claude", "codex", "crontab", "launchctl"]) {
    chmodSync(put(bin, name, stop), 0o755);
  }
  const preload = put(dir, "clock.mjs", `
    const RealDate = Date;
    const timestamp = Number(process.env.SELF_LOOP_ACCEPTANCE_NOW);
    class TestDate extends RealDate {
      constructor(...args) { super(...(args.length ? args : [timestamp])); }
      static now() { return timestamp; }
    }
    globalThis.Date = TestDate;
  `);
  const childEnv = at => ({
    ...env,
    NODE_OPTIONS: "--import=" + pathToFileURL(preload).href,
    SELF_LOOP_ACCEPTANCE_NOW: String(Date.parse(at)),
  });
  const runGit = (repo, ...args) => spawnSync("git", ["-C", repo, ...args], { ...options, env });
  const git = (repo, ...args) => execFileSync("git", ["-C", repo, ...args], { ...options, env }).trimEnd();
  const commit = (repo, message, at = clock) => {
    git(repo, "add", "-A");
    execFileSync("git", ["-C", repo, "commit", "-qm", message], {
      ...options,
      env: { ...env, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at },
    });
    return git(repo, "rev-parse", "HEAD");
  };
  const repo = (path, files, at = clock) => {
    mkdirSync(path, { recursive: true });
    git(path, "init", "-q", "-b", "main");
    for (const [file, contents] of Object.entries(files)) put(path, file, contents);
    commit(path, "Fixture", at);
    return path;
  };

  repo(owner, { "README.md": "# Owner store\n", "products.json": json({ roots: [projects], products: [] }) });

  const command = (entry, args, settings = {}) => {
    const { cwd = outside, at = clock, extraEnv = {}, from = skill } = settings;
    const scripts = join(from, "scripts");
    // loop.mjs is the pre-v1 entry point. This fallback allows the identical suite to be run on the frozen base.
    const wrapper = join(scripts, "self-loop.mjs");
    const name = entry ?? (existsSync(wrapper) ? "self-loop.mjs" : "loop.mjs");
    return {
      argv: [join(scripts, name), ...args],
      opts: { ...options, cwd, env: { ...childEnv(at), ...extraEnv } },
    };
  };
  const run = (args, settings = {}) => {
    const { argv, opts } = command(settings.entry, args, settings);
    return spawnSync(process.execPath, argv, opts);
  };
  const runSuggested = (line, settings = {}) => {
    const { opts } = command(undefined, [], settings);
    return spawnSync("/bin/sh", ["-c", line], opts);
  };
  const runAsync = (args, settings = {}) => {
    const { argv, opts } = command(settings.entry, args, settings);
    return new Promise(resolve => execFile(process.execPath, argv, opts, (error, stdout, stderr) => {
      resolve({ status: error ? error.code : 0, error, stdout, stderr });
    }));
  };
  const register = (products, roots = [projects]) => {
    put(owner, "products.json", json({
      roots,
      products: products.map(({ name, records }) => ({ name, records, aliases: [name + "-alias"] })),
    }));
    commit(owner, "Register products");
  };

  const makeProduct = (spec, index = 1) => {
    const { name, project, phase, activityAt, onStall } = spec;
    const records = join(projects, "records", name);
    const path = join(projects, "project", project);
    const feature = "F-" + String(index).padStart(4, "0");
    repo(path, { "README.md": "# " + name + "\n", "VERSION": "0.0.1\n" });
    git(path, "branch", phaseBranch);
    const files = {
      "README.md": "# " + name + " records\n",
      "records.json": json({ ownerStore: owner }),
    };
    const config = join(records, "loop.json");
    if (activityAt) {
      Object.assign(files, {
        "loop.json": json({
          product: path, records, projects: [path], workDir: join(dir, "work", name),
          branch: phaseBranch, phase, briefs: {}, agents: {},
          ...(onStall ? { tick: { onStall } } : {}),
        }),
        "purpose/P-0001.md": "# P-0001 Maintain a working process\n\nstatus: active\n",
        [`blueprint/${feature}.md`]: `# ${feature} Build ${name}\n\nid: ${feature}\nphase: ${phase}\nrequirements: P-0001\n`,
        "metrics/blueprint.jsonl": jsonl({ feature, status: "building", time: activityAt, by: "lead", note: "Work started", evidence: {} }),
      });
    }
    repo(records, files, activityAt ?? clock);
    if (activityAt) {
      status(run(["--repo", records, "--write"], { entry: "records-check.mjs" }), 0);
      commit(records, "Generate views", activityAt);
    }
    return { ...spec, path, config, records, feature, head: git(records, "rev-parse", "HEAD") };
  };

  return { dir, home, owner, projects, outside, bin, repo, makeProduct, register, commit, git, runGit, run, runAsync, runSuggested };
}

export function output(result) {
  return [result.stdout, result.stderr].filter(Boolean).join("\n");
}

export function status(result, expected) {
  assert.equal(result.status, expected, output(result) || String(result.error ?? result.signal));
  return result.stdout;
}

export function has(text, expected) {
  assert.ok(text.includes(expected), `missing ${expected} in:\n${text}`);
}

export function lacks(text, unexpected) {
  assert.ok(!text.includes(unexpected), `found ${unexpected} in:\n${text}`);
}

export function jsonOutput(result, expected = 0) {
  return JSON.parse(status(result, expected));
}

// Read the published ledger at HEAD so stdout-only or uncommitted alarms cannot pass.
export function committedAlarms(w, p) {
  const path = "metrics/alarms.jsonl";
  const files = w.git(p.records, "ls-tree", "--name-only", "HEAD", "--", path);
  if (!files) return [];
  return w.git(p.records, "show", "HEAD:" + path).split("\n").filter(Boolean).map(line => JSON.parse(line));
}

export function writeGh(w, checksByCommit) {
  const data = put(w.bin, "ci-checks.json", json(checksByCommit));
  const script = `#!/usr/bin/env node
const { readFileSync, appendFileSync } = require("node:fs");
const endpoint = process.argv.find(arg => arg.startsWith("repos/"));
const match = /^repos\\/example\\/fixture\\/commits\\/([0-9a-f]{40})\\/check-runs\\?/.exec(endpoint || "");
if (!match) process.exit(78);
const runs = JSON.parse(readFileSync(${JSON.stringify(data)}, "utf8"));
appendFileSync(${JSON.stringify(join(w.bin, "ci-queries"))}, match[1] + "\\n");
for (const row of runs[match[1]] ?? []) console.log(JSON.stringify(row));
`;
  chmodSync(put(w.bin, "gh", script), 0o755);
}

export const readQueries = w => {
  const path = join(w.bin, "ci-queries");
  return existsSync(path) ? readFileSync(path, "utf8").trimEnd().split("\n") : [];
};
