import { chmodSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { bytes } from "./closing-fixture.mjs";
import { json, put } from "./fixture.mjs";
import { seed, seeded } from "./scenario.mjs";

/** @type {() => {publicHost: string, mirrorHost: string, configuredRemote: string, unknownRemote: string, variedVersion: string}} */
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
  const data = put(w.bin, "r7-ci-hosts.json", json(destinations));
  const log = join(w.bin, "r7-ci-requests.jsonl");
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
