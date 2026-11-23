#!/usr/bin/env node
// F-0014, D-0057, design/ssot-authority.md: CLI for SSOT Rung-2/Rung-3 checks and sync attestations.
//
// node scripts/ssot-check.mjs [check] --config <loop.json> [--sha <sha>] [--strict] [--json] [--out <receipt.json>]
// node scripts/ssot-check.mjs attest  --config <loop.json> --id <entry-id> --sha <sha>
//   --disposition <updated|no-contract-change> --by <role> --reason <text> [--round <N>] [--json]
import "./lib/unbind-git.mjs";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cli, need, parseArgs, UsageError } from "./lib/args.mjs";
import { resolveConfig, resolveOwnerStore } from "./lib/registry.mjs";
import {
  attestSsot, checkSsot, defaultShaFor, loadSsotLoop, SHORT_SHA_LEN, SSOT_DISPOSITIONS, SsotConfigError, ssotCheckCommand,
} from "./lib/ssot.mjs";
import { DEFAULT_LAYOUT, indexOfTree } from "./records-check.mjs";

const CHECK_VALUE_FLAGS = new Set(["config", "sha", "out", "owner-store"]);
const CHECK_BOOL_FLAGS = new Set(["strict", "json"]);
const ATTEST_VALUE_FLAGS = new Set(["config", "id", "sha", "disposition", "by", "reason", "round", "owner-store"]);
const ATTEST_BOOL_FLAGS = new Set(["json"]);

const USAGE = [
  "ssot-check.mjs [check] --config <loop.json> [--sha <sha>] [--strict] [--json] [--out <receipt.json>] [--owner-store <dir>]",
  "ssot-check.mjs attest --config <loop.json> --id <entry-id> --sha <sha> --disposition <updated|no-contract-change> --by <role> --reason <text> [--round <N>] [--json] [--owner-store <dir>]",
].join("\n");

function validateFlags(args, valueFlags, boolFlags, sub) {
  for (const key of Object.keys(args)) {
    if (key === "_") continue;
    if (valueFlags.has(key)) {
      if (!args[key]) throw new UsageError(`missing value for --${key}`);
    } else if (boolFlags.has(key)) {
      if (args[key] !== "") throw new UsageError(`--${key} takes no value`);
    } else {
      throw new UsageError(`${sub} takes no --${key}`);
    }
  }
}

function resolveLoopPath(args, { env = process.env, cwd = process.cwd() } = {}) {
  if (args.config) return resolve(cwd, args.config);
  const store = () => resolveOwnerStore({ flag: args["owner-store"], env });
  return resolveConfig({ config: null, env, cwd, store }).config;
}

function formatCheckText(result, configFile) {
  if (!result.configured) return "ssot: not configured (ok)";
  const lines = [`ssot ${result.sha?.slice(0, SHORT_SHA_LEN) ?? "unknown"} (${result.strict ? "strict" : "screening"}): ${result.ok ? "ok" : "FAILED"}`];
  for (const f of result.failures) lines.push(`  FAIL [${f.kind}] ${f.entryId ?? "config"}: ${f.detail}`);
  for (const d of result.drift) {
    const paths = d.changedPaths.length ? d.changedPaths.join(", ") : d.reason ?? "unsynced";
    lines.push(`  DRIFT ssot-drift ${d.id} (${d.doc}, ${d.mode}, ${d.behindCommits} commit(s) behind): ${paths}`);
  }
  if (!result.ok || result.drift.length) lines.push(`  run: ${ssotCheckCommand(configFile, result.sha, { strict: true })}`);
  return lines.join("\n");
}

function runCheck(args, ctx) {
  validateFlags(args, CHECK_VALUE_FLAGS, CHECK_BOOL_FLAGS, "check");
  if (args.out && existsSync(resolve(ctx.cwd, args.out)))
    throw new UsageError(`${args.out} already exists; evidence receipts are never overwritten`);
  const configPath = resolveLoopPath(args, ctx);
  let loop, sha;
  try {
    loop = loadSsotLoop(configPath);
    sha = args.sha || (loop.ssot !== undefined ? defaultShaFor(loop) : null);
  } catch (e) {
    if (e instanceof SsotConfigError) {
      const payload = { configured: true, sha: args.sha ?? null, strict: "strict" in args, ok: false, rung2Ok: false, rung3Ok: true, failures: [{ entryId: null, kind: "config-error", detail: e.message }], drift: [], entries: [] };
      console.log("json" in args ? JSON.stringify(payload, null, 2) : `Refused: ${e.message}`);
      return 2;
    }
    throw e;
  }
  const result = checkSsot({
    product: loop.product,
    records: loop.records,
    configFile: loop.configFile,
    ssot: loop.ssot,
    sha,
    strict: "strict" in args,
    runChecks: true,
  });
  if (args.out) {
    const outPath = resolve(ctx.cwd, args.out);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);
  }
  console.log("json" in args ? JSON.stringify(result, null, 2) : formatCheckText(result, loop.configFile));
  return result.ok ? 0 : 2;
}

function runAttest(args, ctx) {
  validateFlags(args, ATTEST_VALUE_FLAGS, ATTEST_BOOL_FLAGS, "attest");
  need(args, "id", "sha", "disposition", "by", "reason");
  if (!SSOT_DISPOSITIONS.includes(args.disposition))
    throw new UsageError(`--disposition must be one of ${SSOT_DISPOSITIONS.join(", ")}, got ${JSON.stringify(args.disposition)}`);
  let round;
  if ("round" in args) {
    round = Number(args.round);
    if (!Number.isInteger(round) || round < 1) throw new UsageError("--round must be a positive integer");
  }
  const configPath = resolveLoopPath(args, ctx);
  try {
    const loop = loadSsotLoop(configPath);
    const layoutText = readFileSync(DEFAULT_LAYOUT, "utf8");
    const res = attestSsot({
      product: loop.product,
      records: loop.records,
      configFile: loop.configFile,
      ssot: loop.ssot,
      id: args.id,
      sha: args.sha,
      disposition: args.disposition,
      by: args.by,
      reason: args.reason,
      round,
      indexOfTree,
      layoutText,
    });
    if ("json" in args) console.log(JSON.stringify(res, null, 2));
    else console.log(`attested ${res.row.id} (${res.row.disposition}) at ${res.row.productSha.slice(0, SHORT_SHA_LEN)} -> ${res.commit.slice(0, SHORT_SHA_LEN)}`);
    return 0;
  } catch (e) {
    if (e instanceof SsotConfigError) {
      console.error(`Refused: ${e.message}`);
      return 2;
    }
    throw e;
  }
}

export function main(argv, ctx = { env: process.env, cwd: process.cwd() }) {
  const args = parseArgs(argv);
  const [sub, extra] = args._;
  if (extra !== undefined) throw new UsageError(`unexpected positional argument: ${extra}`);
  if (sub === undefined || sub === "check") return runCheck(args, ctx);
  if (sub === "attest") return runAttest(args, ctx);
  throw new UsageError(USAGE);
}

const invokedAsScript = () => {
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
};
if (invokedAsScript()) cli(() => main(process.argv.slice(2)));
