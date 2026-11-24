#!/usr/bin/env node
// design/version-tip.md#the-protected-push
import "./lib/unbind-git.mjs";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cli, need, parseArgs, UsageError } from "./lib/args.mjs";
import { fullSha, pushCommit, shownUrl } from "./lib/ci.mjs";
import { verifyProvenance } from "./lib/provenance.mjs";
import { discoverLocalLoop, LOOP, loadRegistry, productState, REGISTRY, resolveOwnerStore } from "./lib/registry.mjs";
import { lookupSuiteReceipt } from "./suite-green.mjs";

const REMOVED = ["protected", "require", "remote", "records"];
const TAKES = ["repo", "branch", "suite-receipt", "sha", "dry-run", "owner-store", "verify-only"];
const ZERO = /^0+$/;

const commonDir = dir => {
  const r = spawnSync("git", ["-C", dir, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" });
  if (r.status !== 0) return null;
  try { return realpathSync(r.stdout.trim()); } catch { return null; }
};

function claimedProduct(state) {
  if (state.cfg) return state.cfg.product;
  try {
    const product = JSON.parse(readFileSync(state.loop, "utf8"))?.product;
    return typeof product === "string" && product.trim() ? resolve(state.records, product) : null;
  } catch { return null; }
}

const isProductOf = (state, common) => {
  const product = state.loop && claimedProduct(state);
  return Boolean(product) && commonDir(product) === common;
};

function provenanceFields(raw) {
  return {
    branch: raw?.branch ?? null,
    phase: raw?.phase ?? null,
    ...(Object.hasOwn(raw ?? {}, "provenanceBaseline") ? { provenanceBaseline: raw.provenanceBaseline } : {}),
    ...(Object.hasOwn(raw ?? {}, "leadPaths") ? { leadPaths: raw.leadPaths } : {}),
  };
}

function loopOf(repo, store) {
  const common = commonDir(repo);
  if (!common) throw new UsageError(`--repo ${repo} is not a Git repository`);
  if (!existsSync(join(store.path, REGISTRY)))
    return { notRegistered: true, refused: `no product registry at ${join(store.path, REGISTRY)} (owner store from ${store.source}), so no loop names ${repo}; register the product's records with \`self-loop.mjs registry add\`, or pass --owner-store` };
  const states = loadRegistry(store).products.map(productState);
  const matches = states.filter(s => isProductOf(s, common));
  const named = list => list.map(s => `${s.name} (${s.records})`).join(", ") || "none";
  if (!matches.length)
    return { notRegistered: true, refused: `no registered product's ${LOOP} names ${repo} (Git common directory ${common}) in the owner store ${store.path} (from ${store.source}); registered: ${named(states)}. Register the product's records once with \`self-loop.mjs registry add\`, or pass --owner-store` };
  if (matches.length > 1)
    return { refused: `${repo} (Git common directory ${common}) is the product of ${matches.length} registered loops: ${named(matches)}. Register it once` };
  const [state] = matches;
  if (state.error) return { refused: `${state.name} (${state.records}): ${state.error}` };
  const raw = JSON.parse(readFileSync(state.loop, "utf8"));
  const policy = policyOf(raw);
  if (policy.refused) return { refused: `${state.name} (${state.loop}): ${policy.refused}` };
  return { loop: { name: state.name, records: state.records, configFile: resolve(state.loop), ...(Object.hasOwn(raw, "ssot") ? { ssot: raw.ssot } : {}), ...provenanceFields(raw), ...policy } };
}

function loopForVerify(repo, store) {
  const found = loopOf(repo, store);
  if (found.loop || !found.notRegistered) return found;
  const local = discoverLocalLoop(repo);
  if (!local) return { notRegistered: true };
  try {
    const raw = JSON.parse(readFileSync(local, "utf8"));
    return { loop: { name: "in-repo", records: dirname(local), protected: Array.isArray(raw.protected) ? raw.protected : [], ...provenanceFields(raw) } };
  } catch (e) {
    return { refused: `${local}: ${e.message}` };
  }
}

function verifyOnly(args) {
  need(args, "repo");
  const found = loopForVerify(args.repo, resolveOwnerStore({ flag: args["owner-store"] }));
  if (found.notRegistered) return 0;
  if (found.refused) {
    console.error(`Refused: ${found.refused}`);
    return 2;
  }
  const { loop } = found;
  const cfg = { protected: loop.protected, ...provenanceFields(loop) };
  const targets = [];
  if (args.branch) {
    targets.push({ sha: args.sha || "HEAD", branch: args.branch });
  } else {
    const lines = readFileSync(0, "utf8").trim().split("\n").filter(Boolean);
    for (const line of lines) {
      const [, sha, ref] = line.trim().split(/\s+/);
      if (!sha || ZERO.test(sha) || !ref) continue;
      if (ref.startsWith("refs/heads/")) targets.push({ sha, branch: ref.slice("refs/heads/".length) });
      else if (ref.startsWith("refs/tags/")) {
        try { targets.push({ sha: fullSha(args.repo, sha), branch: null }); } catch {}
      }
    }
  }
  const failures = [];
  for (const { sha, branch } of targets) {
    const res = verifyProvenance({ repo: args.repo, records: loop.records, sha, branch, cfg, mode: "push" });
    if (!res.ok) failures.push(...res.reasons);
  }
  if (failures.length) {
    for (const reason of failures) console.error(`Refused: ${reason}`);
    return 2;
  }
  return 0;
}

// design/version-tip.md#protection-is-never-retired-by-omission
const MIGRATION = `add both keys to the loop.json: "protected": the branches only a judged, CI-green commit may reach, and "gates": { "require": the app/name checks they need }, `
  + `for example "protected": ["main"] and "gates": { "require": ["github-actions/verify"] } (or ["codebuild/verify"] for AWS CodeCommit); an explicit [] is allowed ("protected": [] protects no branch, "require": [] requires no check). `
  + `gated-push.mjs no longer takes --protected or --require, so a loop that left them out is unconfigured, not unprotected`;

export function policyOf(raw) {
  const gates = raw?.gates !== null && typeof raw?.gates === "object" ? raw.gates : {};
  const missing = [...(Object.hasOwn(raw ?? {}, "protected") ? [] : ["\"protected\""]), ...(Object.hasOwn(gates, "require") ? [] : ["\"gates.require\""])];
  if (missing.length) return { refused: `the loop is unconfigured: it has no ${missing.join(" and no ")}. ${MIGRATION}` };
  const branches = raw.protected;
  if (!Array.isArray(branches) || !branches.every(b => typeof b === "string" && b.trim()))
    return { refused: `"protected" must be a list of branch names, got ${JSON.stringify(branches)}. ${MIGRATION}` };
  const listed = typeof gates.require === "string" ? gates.require.split(",") : gates.require;
  if (!Array.isArray(listed) || !listed.every(spec => typeof spec === "string"))
    return { refused: `"gates.require" must be a list of app/name checks, got ${JSON.stringify(gates.require)}. ${MIGRATION}` };
  const remote = gates.remote ?? "origin";
  if (typeof remote !== "string" || !remote) return { refused: `"gates.remote" must name a Git remote, got ${JSON.stringify(gates.remote)}` };
  return {
    remote,
    require: listed.map(spec => spec.trim()).filter(Boolean),
    protected: branches,
    ...(typeof gates.suite === "string" && gates.suite.trim() ? { suite: gates.suite } : {}),
    ...(typeof gates.install === "string" ? { install: gates.install } : {}),
  };
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) cli(() => {
  const args = parseArgs(process.argv.slice(2));
  const removed = REMOVED.find(key => key in args);
  if (removed) throw new UsageError(`--${removed} was removed: the protected branches, the push remote, the required checks and the records come from the loop.json of the registered product whose repository --repo is`);
  const unknown = Object.keys(args).find(key => key !== "_" && !TAKES.includes(key));
  if (unknown) throw new UsageError(`gated-push takes no --${unknown}`);
  if (args._.length) throw new UsageError(`gated-push takes no positional argument, got ${args._[0]}`);
  if ("verify-only" in args) return verifyOnly(args);
  need(args, "repo", "branch");
  let explicitSuite = null;
  if ("suite-receipt" in args) {
    if (!args["suite-receipt"] || typeof args["suite-receipt"] !== "string") throw new UsageError("missing --suite-receipt");
    try { explicitSuite = JSON.parse(readFileSync(args["suite-receipt"], "utf8")); } catch (e) { throw new UsageError(`--suite-receipt: ${e.message}`); }
  }
  const store = resolveOwnerStore({ flag: args["owner-store"] });
  const found = loopOf(args.repo, store);
  if (found.refused) {
    console.error(`Refused: ${found.refused}`);
    return 2;
  }
  const { loop } = found;
  const sha = args.sha || "HEAD";
  let suite = explicitSuite;
  if (!suite) {
    if (!loop.suite) {
      console.error(`Refused: --suite-receipt omitted and ${loop.name} loop.json has no gates.suite; pass --suite-receipt or configure gates.suite and run suite-green.mjs.`);
      return 2;
    }
    const hit = lookupSuiteReceipt({ repo: args.repo, sha, command: loop.suite, install: loop.install ?? "" });
    if (!hit) {
      console.error(`Refused: no verified cached green suite receipt for ${sha} (${loop.suite}); run suite-green.mjs or pass --suite-receipt.`);
      return 2;
    }
    suite = hit.receipt;
  }
  const result = pushCommit({ repo: args.repo, records: loop.records, remote: loop.remote, sha, branch: args.branch, suite,
    protectedBranches: loop.protected, require: loop.require, dry: "dry-run" in args,
    cfg: { protected: loop.protected, ...provenanceFields(loop) },
    ...(Object.hasOwn(loop, "ssot") ? { ssot: loop.ssot, configFile: loop.configFile } : {}) });
  if (result.refused) {
    console.error(`Refused: ${result.refused}\nRun suite-green.mjs on the commit; for a protected branch of ${loop.name}, record the judge convergence, push the candidate to a working branch and wait for its checks to pass.`);
    return 2;
  }
  for (const warning of result.warnings ?? []) console.error(warning);
  const checks = result.verdict ? `, checks green in ${result.verdict.host}/${result.verdict.repository}` : loop.protected.includes(args.branch) ? ", no check required" : "";
  console.log(`${result.pushed ? "pushed" : "would push"} ${result.sha.slice(0, 7)} to ${loop.remote}/${args.branch} (${shownUrl(result.destination)}${checks})`);
  return 0;
});
