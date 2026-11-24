#!/usr/bin/env node
// P-0012, D-0059, D-0060, design/parallel-dispatch.md#5, design/mandatory-control-plane.md#4
import "./lib/unbind-git.mjs";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { load } from "./call.mjs";
import { cli, need, parseArgs, UsageError } from "./lib/args.mjs";
import {
  analyzeDecoupling, computeDispatchPlan, integrateWave, prepareWave,
  readPlanWindow, recordWave, renderDispatchLines, reviewCoverage,
} from "./lib/dispatch.mjs";
import { git, gitOk } from "./lib/git-plumbing.mjs";
import { loadPlan, planContext, snapshot } from "./lib/plan.mjs";
import { hostLoad, resolveOwnerStore } from "./lib/registry.mjs";
import { integrationTarget } from "./loop.mjs";

const USAGE = [
  "dispatch.mjs analyze --records R --plan PL-NNNN [--base rev] [--json]",
  "dispatch.mjs waves --records R --plan PL-NNNN [--base rev] [--json]",
  "dispatch.mjs integrate --records R --plan PL-NNNN [--wave N] [--dry-run | --apply] [--json]",
  "dispatch.mjs prepare --config C --plan PL-NNNN [--wave N] [--base rev] [--json]",
  "dispatch.mjs record --config C --plan PL-NNNN [--wave N] [--integrate] [--json]",
].join("\n");

function resolveBase(product, rev) {
  if (!gitOk(product, "rev-parse", "--verify", "--quiet", `${rev}^{commit}`)) {
    throw new UsageError(`--base ${rev} is not a product commit`);
  }
  return git(product, "rev-parse", `${rev}^{commit}`);
}

function parseWaveArg(args) {
  if (!("wave" in args)) return null;
  if (!/^\d+$/.test(String(args.wave))) throw new UsageError(`--wave must be a non-negative integer, got ${JSON.stringify(args.wave)}`);
  return Number(args.wave);
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const [operation] = args._;
  if (!["analyze", "waves", "integrate", "prepare", "record"].includes(operation)) throw new UsageError(USAGE);
  need(args, "plan");
  if (!args.config && !args.records) throw new UsageError("missing required --config or --records");
  let cfg = null, state, plan, context;
  try {
    if (args.config) cfg = load(args.config);
    state = snapshot(args.records ?? cfg.records);
    plan = loadPlan(state, args.plan);
    context = planContext(state, plan);
    if (cfg) context = { ...context, cfg };
    else cfg = context.cfg;
  } catch (e) {
    console.error(e.message);
    return 1;
  }
  const json = "json" in args;
  const win = readPlanWindow(state, plan.phase);

  if (operation === "prepare") {
    const wave = parseWaveArg(args);
    const base = args.base ? resolveBase(cfg.product, args.base) : null;
    const readyBase = base ?? integrationTarget(cfg);
    const host = hostLoad({ cfg, store: resolveOwnerStore() });
    const res = prepareWave({ cfg, state, plan, context, wave, base, readyBase, host, log: m => console.error(m) });
    if (json) console.log(JSON.stringify(res, null, 2));
    else {
      for (const p of res.prepared) console.log(`prepared ${p.id} (${p.handoff}) -> ${p.ws} [nonce ${p.nonce}]`);
      for (const e of res.errors) console.error(`failed ${e.id} (${e.handoff}): ${e.message}`);
    }
    return res.ok ? 0 : 1;
  }

  if (operation === "record") {
    const wave = parseWaveArg(args);
    const res = recordWave({ cfg, state, plan, wave, integrate: "integrate" in args, log: m => console.error(m) });
    if (json) console.log(JSON.stringify(res, null, 2));
    else {
      for (const r of res.recorded) console.log(`recorded ${r.id} (${r.handoff}) [session ${r.session}]`);
      for (const p of res.pending) console.log(`pending ${p.id} (${p.handoff}): ${p.reason}`);
      if (res.integration?.ok) console.log(`integrated ${plan.id} -> ${res.integration.commit}`);
      for (const e of res.errors) console.error(`failed ${e.id}: ${e.message}`);
    }
    return res.ok ? 0 : 1;
  }

  if (operation === "analyze") {
    const base = args.base
      ? resolveBase(cfg.product, args.base)
      : (integrationTarget(cfg) ?? resolveBase(cfg.product, cfg.branch ?? "HEAD"));
    const decoupling = analyzeDecoupling({ plan, product: cfg.product, base, state });
    const coverage = reviewCoverage(plan, { window: win });
    const out = { plan: plan.id, scope: plan.scope, phase: plan.phase, revision: state.revision, base, decoupling, coverage };
    if (json) console.log(JSON.stringify(out, null, 2));
    else {
      console.log([
        `Analyze ${plan.id} (${plan.scope}) @ ${base.slice(0, 12)} · review topology: ${coverage.topology}`,
        ...decoupling.pairs.map(p => `  ${p.left} <-> ${p.right}: ${p.kind}${p.edges.length ? ` (${p.edges.map(e => `${e.from}->${e.to}`).join(", ")})` : ""}`),
        `  coverage: ${coverage.coveredActors.length}/${coverage.actors.length} actors covered${coverage.uncoveredActors.length ? ` (uncovered: ${coverage.uncoveredActors.join(", ")})` : ""}`,
      ].join("\n"));
    }
    return 0;
  }

  if (operation === "waves") {
    const base = args.base ? resolveBase(cfg.product, args.base) : integrationTarget(cfg);
    const host = hostLoad({ cfg, store: resolveOwnerStore() });
    const dp = computeDispatchPlan({ state, plan, context, product: cfg.product, base, host, window: win });
    if (json) console.log(JSON.stringify(dp, null, 2));
    else console.log(renderDispatchLines(dp).join("\n"));
    return 0;
  }

  if ("dry-run" in args && "apply" in args) throw new UsageError("--dry-run and --apply exclude each other");
  const wave = parseWaveArg(args);
  const apply = "apply" in args;
  const res = integrateWave({ cfg, state, plan, wave, apply });
  if (json) console.log(JSON.stringify(res, null, 2));
  else if (!res.ok) console.error(res.message);
  else if (res.dryRun) {
    console.log(`dry-run ok: ${plan.id}${wave !== null ? ` wave ${wave}` : ""} (${res.commits.length} actor commit(s), tree ${res.mergedTree.slice(0, 12)})`);
  } else {
    console.log(`integrated ${plan.id}${wave !== null ? ` wave ${wave}` : ""} -> ${res.commit}${res.branch ? ` (${res.branch})` : ""}`);
  }
  return res.ok ? 0 : 1;
}

const invokedAsScript = () => {
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
};
if (invokedAsScript()) cli(() => main());
