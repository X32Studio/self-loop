#!/usr/bin/env node
// SKILL.md#2b-planning-and-dispatch-f-0012-p-0006
import "./lib/unbind-git.mjs";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { cli, need, parseArgs, UsageError } from "./lib/args.mjs";
import { analyzeDecoupling, computeDispatchPlan, integrateWave, readPlanWindow, renderDispatchLines, reviewCoverage } from "./lib/dispatch.mjs";
import { git, gitOk } from "./lib/git-plumbing.mjs";
import { loadPlan, planContext, snapshot } from "./lib/plan.mjs";
import { hostLoad, resolveOwnerStore } from "./lib/registry.mjs";
import { integrationTarget } from "./loop.mjs";

const USAGE = [
  "dispatch.mjs analyze --records R --plan PL-NNNN [--base rev] [--json]",
  "dispatch.mjs waves --records R --plan PL-NNNN [--base rev] [--json]",
  "dispatch.mjs integrate --records R --plan PL-NNNN [--wave N] [--dry-run | --apply] [--json]",
].join("\n");

function resolveBase(product, rev) {
  if (!gitOk(product, "rev-parse", "--verify", "--quiet", `${rev}^{commit}`)) {
    throw new UsageError(`--base ${rev} is not a product commit`);
  }
  return git(product, "rev-parse", `${rev}^{commit}`);
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const [operation] = args._;
  if (!["analyze", "waves", "integrate"].includes(operation)) throw new UsageError(USAGE);
  need(args, "records", "plan");
  let state, plan, context;
  try {
    state = snapshot(args.records);
    plan = loadPlan(state, args.plan);
    context = planContext(state, plan);
  } catch (e) {
    console.error(e.message);
    return 1;
  }
  const json = "json" in args;
  const win = readPlanWindow(state, plan.phase);

  if (operation === "analyze") {
    const base = args.base
      ? resolveBase(context.cfg.product, args.base)
      : (integrationTarget(context.cfg) ?? resolveBase(context.cfg.product, context.cfg.branch ?? "HEAD"));
    const decoupling = analyzeDecoupling({ plan, product: context.cfg.product, base, state });
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
    const base = args.base ? resolveBase(context.cfg.product, args.base) : integrationTarget(context.cfg);
    const host = hostLoad({ cfg: context.cfg, store: resolveOwnerStore() });
    const dp = computeDispatchPlan({ state, plan, context, product: context.cfg.product, base, host, window: win });
    if (json) console.log(JSON.stringify(dp, null, 2));
    else console.log(renderDispatchLines(dp).join("\n"));
    return 0;
  }

  if ("dry-run" in args && "apply" in args) throw new UsageError("--dry-run and --apply exclude each other");
  let wave = null;
  if ("wave" in args) {
    if (!/^\d+$/.test(String(args.wave))) throw new UsageError(`--wave must be a non-negative integer, got ${JSON.stringify(args.wave)}`);
    wave = Number(args.wave);
  }
  const apply = "apply" in args;
  const res = integrateWave({ cfg: context.cfg, state, plan, wave, apply });
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
