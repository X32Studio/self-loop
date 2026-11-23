import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { has, json, jsonOutput, put, status } from "./fixture.mjs";
import { rulingWorld } from "./ruling-fixture.mjs";
import { now, seed, seeded, shift } from "./scenario.mjs";

export const ledgerPath = "metrics/trajectory.jsonl";
export const noBytes = Buffer.alloc(0);
export const bytes = path => existsSync(path) ? readFileSync(path) : noBytes;
const upstream = "example/fixture";

/**
 * Git supplies the same history in independent loops. CI is a server snapshot by push destination
 * and exact SHA. A null snapshot means unreadable CI, while an empty array means no check runs.
 * @typedef {{remote: string, destination: string, requires: string[], initial: object[],
 *   failedCheck: string, failedRerun: object[], successfulRerun: object[]}} ClosingScenario
 */
/** @returns {ClosingScenario} */
export function closingScenario({ releaseRemote = false } = {}) {
  const draw = seeded(seed);
  const destination = "example/" + (releaseRemote ? "release-" : "fork-") + draw(10_000);
  const requires = ["github-actions/verify (Linux)"];
  const extraChecks = 1 + draw(5);
  for (let index = 0; index < extraChecks; index++) requires.push("github-actions/verify-shard-" + index);
  const firstId = 300 + draw(1000);
  const check = (id, name, conclusion = "success") => ({
    id, app: { slug: "github-actions" }, name, status: "completed", conclusion,
  });
  const initial = requires.map((name, index) => check(firstId + index, name.split("/")[1]));
  const failedIndex = draw(initial.length);
  const rerun = (offset, conclusion) => check(firstId + extraChecks + offset, initial[failedIndex].name, conclusion);
  const failed = rerun(1, "failure");
  return {
    remote: releaseRemote ? "release" : "origin", destination, requires, initial,
    failedCheck: requires[failedIndex],
    failedRerun: [failed, ...initial.toReversed()],
    successfulRerun: [...initial, rerun(2, "success"), failed],
  };
}

export function serveChecks(w, snapshot) {
  const data = put(w.bin, "closing-ci.json", json(snapshot));
  // gh --paginate --jq emits one projected object per check run.
  const script = `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require("node:fs");
const args = process.argv.slice(2);
const match = /^repos\\/([^/]+\\/[^/]+)\\/commits\\/([0-9a-f]{40})\\/check-runs\\?/.exec(args.find(arg => arg.startsWith("repos/")) ?? "");
if (args[0] !== "api" || !match) process.exit(78);
const [, repository, sha] = match;
appendFileSync(${JSON.stringify(join(w.bin, "closing-ci-queries.jsonl"))}, JSON.stringify({ repository, sha }) + "\\n");
const snapshot = JSON.parse(readFileSync(${JSON.stringify(data)}, "utf8"));
const runs = snapshot[repository]?.[sha];
if (!Array.isArray(runs)) {
  console.error("gh: check runs unavailable (HTTP 503)");
  process.exit(1);
}
for (const run of runs) console.log(JSON.stringify({ ...run, app: run.app.slug }));
`;
  chmodSync(put(w.bin, "gh", script), 0o755);
}

export const queriesIn = w => bytes(join(w.bin, "closing-ci-queries.jsonl"))
  .toString().split("\n").filter(Boolean).map(line => JSON.parse(line));

export function appendArgs({ file, ruled, tip = ruled }, { verdict = "CONVERGED", phase = "v1", round = 1 } = {}) {
  return [
    "append", "--file", file, "--round", String(round), "--phase", phase, "--role", "judge",
    "--area", "release", "--verdict", verdict, "--suite", "10/0", "--commit", ruled,
    ...(tip === ruled ? [] : ["--tip", tip]),
  ];
}

export function assertRow(records, { ruled, tip = ruled, verdict = "CONVERGED", ci = "success", destination, round = 1 }) {
  const line = readFileSync(join(records, ledgerPath), "utf8").trimEnd().split("\n").at(-1);
  const row = JSON.parse(line);
  assert.deepEqual([row.round, row.phase, row.role, row.verdict, row.commit, row.tip ?? row.commit, row.ci],
    [round, "v1", "judge", verdict, ruled, tip, ci]);
  if (destination) {
    assert.ok(typeof row.ciReceipt === "string" && !isAbsolute(row.ciReceipt), "records-relative receipt");
    const prefix = `evidence/${String(round).padStart(4, "0")}/ci-${tip.slice(0, 7)}`;
    assert.ok(row.ciReceipt.startsWith(prefix), row.ciReceipt);
    assert.ok(!row.ciReceipt.split("/").includes(".."), row.ciReceipt);
    const receipt = JSON.parse(readFileSync(join(records, row.ciReceipt), "utf8"));
    assert.deepEqual([receipt.repository, receipt.sha, receipt.ci], [destination, tip, ci]);
  } else {
    assert.equal(row.ciReceipt, undefined);
  }
  return row;
}

export function closingWorld(w, spec, { verdict = "CONVERGED", edits = { VERSION: "0.4.4\n" } } = {}) {
  const { product, records, tip, ruled } = rulingWorld(w, edits, { log: false, verdict });
  const file = join(records, ledgerPath);
  w.git(product, "remote", "add", "upstream", "https://github.com/" + upstream + ".git");
  if (spec.remote !== "origin") w.git(product, "remote", "add", spec.remote, "https://github.com/example/release-mirror.git");
  w.git(product, "remote", "set-url", "--push", spec.remote, "git@github.com:" + spec.destination + ".git");
  put(records, "records.json", "{}\n");
  put(records, "loop.json", json({
    product, records, workDir: join(w.dir, "work"), branch: "main", phase: "v1", briefs: {}, agents: {},
    gates: { remote: spec.remote, require: spec.requires },
  }));
  status(w.run(["--repo", records, "--write"], { entry: "records-check.mjs" }), 0);
  w.commit(records, "Configure release checks");
  w.register([{ name: "release-target", records }]);

  const setRuns = (runs, sha = tip) => serveChecks(w, {
    [upstream]: { [tip]: spec.initial, [ruled]: spec.initial },
    [spec.destination]: { [tip]: spec.initial, [ruled]: spec.initial, [sha]: runs },
  });
  setRuns(spec.initial);
  const extraEnv = {
    JUDGE_AREA: "release", JUDGE_VERDICT: verdict, JUDGE_SUITE: "10/0",
    BLOCKERS_OPENED: "-", BLOCKERS_CLOSED: "-",
  };
  const checkAt = shift(now, 3 * 60_000);
  const suggested = line => w.runSuggested(line, { at: checkAt, extraEnv });
  const next = () => {
    const text = status(w.run(["next", "--config", join(records, "loop.json")], { entry: "loop.mjs", cwd: product, at: checkAt }), 0);
    has(text, "R-0001-judge");
    const line = text.split("\n").map(line => line.trim()).find(line =>
      line.includes("trajectory.mjs append") && line.includes(file));
    assert.ok(line, text);
    has(line, "--commit " + ruled);
    if (tip !== ruled) has(line, "--tip " + tip);
    return line;
  };
  const append = (fields = {}, extra = [], settings = {}) => w.run([
    ...appendArgs({ file, ruled, tip }, fields), ...extra,
  ], { entry: "trajectory.mjs", at: checkAt, ...settings });
  const record = (name, { checks = spec.requires, remote = spec.remote, exit = 0, sha = tip,
    directory = "evidence/0001", commit = true } = {}) => {
    const prefix = join(records, directory, name);
    const evidence = jsonOutput(w.run([
      "--repo", product, "--remote", remote, "--sha", sha, "--require", checks.join(","), "--out", prefix,
    ], { entry: "ci-green.mjs" }), exit);
    assert.equal(evidence.sha, sha);
    assert.equal(evidence.repository, remote === spec.remote ? spec.destination : upstream);
    assert.deepEqual(Object.keys(evidence.conclusions).sort(), [...checks].sort());
    const path = prefix + ".json";
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), evidence);
    if (commit) w.commit(records, "Record CI observation " + name);
    return path;
  };
  const assertReading = (from, sha = tip) =>
    assert.deepEqual(queriesIn(w).slice(from), [{ repository: spec.destination, sha }]);
  const row = (options = {}) => assertRow(records, { ruled, tip, destination: spec.destination, ...options });
  return {
    records, product, file, ruled, tip, setRuns, next, record, suggested, append, row, assertReading,
    readTrajectory: () => bytes(file), readQueries: () => queriesIn(w),
  };
}
