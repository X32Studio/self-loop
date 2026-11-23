#!/usr/bin/env node
// Gate: is the remote CI green on one exact commit, in the repository a push to --remote reaches? The lead runs it
// before claiming a round closed or a phase converged. Rule: lib/check-runs.mjs (checks by app/name, the latest run of
// each wins, a failed re-run is a failure, a queued re-run is pending).
//
// node ci-green.mjs --repo <product> --sha <commit> --require app/name,... [--remote origin] [--from-json <check-runs>] [--out <prefix>]
// Prints { repository, sha, ci, ok, missing, conclusions, runs }: `runs` names the run (id, status, conclusion,
// started_at) that decided each required check.
// Exit 0 green, 2 not green (failure, pending, absent, unreadable), 64 usage. With --out write the same receipt to
// <prefix>.json, never replacing a file. GH_TOKEN from the caller's environment.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { cli, need, parseArgs, UsageError } from "./lib/args.mjs";
import { ciGreen } from "./lib/ci.mjs";

cli(() => {
  const args = parseArgs(process.argv.slice(2));
  need(args, "repo", "sha", "require");
  if ("out" in args) need(args, "out");
  let fetchRuns;
  if (args["from-json"]) {
    const raw = JSON.parse(readFileSync(args["from-json"], "utf8"));
    fetchRuns = () => (Array.isArray(raw) ? raw : raw.check_runs);
  }
  let result;
  try { result = ciGreen({ repo: args.repo, remote: args.remote || "origin", sha: args.sha, require: args.require.split(","), ...(fetchRuns ? { fetchRuns } : {}) }); }
  catch (e) { throw new UsageError(e.message); }
  const receipt = `${JSON.stringify(result, null, 2)}\n`;
  if (args.out) {
    const file = `${args.out}.json`;
    mkdirSync(dirname(file), { recursive: true });
    try { writeFileSync(file, receipt, { flag: "wx" }); }
    catch (e) {
      if (e.code === "EEXIST") throw new UsageError(`${file} exists; evidence is never overwritten`);
      throw e;
    }
  }
  process.stdout.write(receipt);
  return result.ok ? 0 : 2;
});
