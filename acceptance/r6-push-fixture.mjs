import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { closingWorld, serveChecks } from "./closing-fixture.mjs";
import { json, put, status, world } from "./fixture.mjs";
import { pushScenario } from "./r6-push-scenario.mjs";

function installTransport(w, destinations) {
  const repos = Object.fromEntries(destinations.map(({ slug }) => [slug, join(w.dir, ...slug.split("/")) + ".git"]));
  for (const bare of Object.values(repos)) {
    mkdirSync(bare, { recursive: true });
    w.git(bare, "init", "-q", "--bare");
  }
  const ssh = put(w.bin, "git-transport", `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
const request = /^(git-(?:receive|upload)-pack) '\\/?([^']+)\\.git'$/.exec(args.at(-1));
const repos = ${JSON.stringify(repos)};
if (!args.includes("git@github.com") || !request || !Object.hasOwn(repos, request[2])) {
  console.error("unexpected Git transport", args);
  process.exit(78);
}
const outcome = spawnSync(request[1], [repos[request[2]]], { stdio: "inherit" });
process.exit(outcome.status ?? 78);
`);
  chmodSync(ssh, 0o755);
  return {
    repos,
    env: { GIT_SSH: ssh, GIT_SSH_VARIANT: "simple", GIT_ALLOW_PROTOCOL: "file:ssh" },
  };
}

export function pushWorld(t, { releaseRemote = false, verdict = "CONVERGED", publishedRuling = true, edits } = {}) {
  const w = world(t);
  const { close, first, second } = pushScenario({ releaseRemote });
  const release = closingWorld(w, close, { verdict, edits });
  const { records, product, ruled, tip } = release;
  const config = join(records, "loop.json");
  const setup = JSON.parse(readFileSync(config, "utf8"));
  const configure = (remote, at = records, checkout = product) => {
    const gates = { require: close.requires };
    if (remote !== "origin") gates.remote = remote;
    put(at, "loop.json", json({ ...setup, records: at, product: checkout, protected: ["main"], gates }));
    w.commit(at, "Configure promotion");
  };
  configure(close.remote);
  const { repos, env } = installTransport(w, [first, second]);
  const version = w.git(product, "show", tip + ":VERSION");
  w.git(product, "tag", "v" + version, tip);
  for (const bare of Object.values(repos)) {
    w.git(product, "push", "-q", bare, `${tip}:refs/heads/loop/v1`, "refs/tags/v" + version);
  }
  const serve = (firstChecks = first.checks, secondChecks = second.checks) => serveChecks(w, {
    [first.slug]: { [ruled]: firstChecks, [tip]: firstChecks },
    [second.slug]: { [ruled]: secondChecks, [tip]: secondChecks },
  });
  serve();
  if (publishedRuling) {
    status(release.append({ verdict }), 0);
    w.commit(records, "Record round ruling");
  }

  const makeReceipt = (repo, sha = tip) => {
    const prefix = join(w.dir, "suite-" + w.git(repo, "rev-parse", "--short", "HEAD") + "-" + (repo === product ? "main" : "linked"));
    status(w.run([
      "--repo", repo, "--sha", sha, "--command",
      "node --input-type=module -e 'import assert from \"node:assert/strict\"; import { result } from \"./src/result.js\"; assert.equal(result, 1)'",
      "--out", prefix,
    ], { entry: "suite-green.mjs" }), 0);
    return prefix + ".json";
  };
  const receipt = makeReceipt(product);
  const promote = (flags = [], { repo = product, suiteReceipt = receipt, branch = "main", extraEnv = {} } = {}) =>
    w.run(["--repo", repo, "--branch", branch, "--suite-receipt", suiteReceipt, ...flags],
      { entry: "gated-push.mjs", extraEnv: { ...env, ...extraEnv } });
  const refs = ({ slug }) => w.git(repos[slug], "for-each-ref", "--format=%(objectname) %(refname)");
  const snapshot = () => [refs(first), refs(second)];
  const assertDelivered = (destination, branch = "main", sha = tip) =>
    assert.equal(w.git(repos[destination.slug], "rev-parse", "refs/heads/" + branch), sha);
  const addMirror = () => w.git(product, "remote", "set-url", "--add", "--push", close.remote, second.url);
  const diagnose = (remote = close.remote) => w.run(["--repo", product, "--sha", tip, "--remote", remote,
    "--require", close.requires.join(",")], { entry: "ci-green.mjs", extraEnv: env });
  const next = () => w.run(["next", "--config", config], { entry: "loop.mjs", cwd: product, extraEnv: env });
  return {
    ...release, w, close, first, second, configure, serve, promote, snapshot, assertDelivered, addMirror,
    diagnose, next, makeReceipt, receipt, env, config,
  };
}
