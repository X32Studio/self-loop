#!/usr/bin/env node
// P-0006, F-0012, design/dispatch.md#ready-state
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cli, need, parseArgs, UsageError } from './lib/args.mjs';
import { git } from './lib/git-plumbing.mjs';
import { loadPlan, parsePlan, planContext, readyPlan, snapshot, validatePlan } from './lib/plan.mjs';
import { hostLoad, resolveOwnerStore } from './lib/registry.mjs';
import { cliClock, integrationTarget, reconcilePlans } from './loop.mjs';
import { measurePlan, renderMeasures } from './lib/plan-measures.mjs';

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv), [operation, file] = args._;
  if (!['validate', 'ready', 'measure'].includes(operation)) throw new UsageError('plan.mjs validate <file> [--records R] | ready|measure --records R --plan PL-NNNN [--json]');
  if (operation === 'validate') {
    if (!file) throw new UsageError('validate needs a plan file');
    const records = args.records ?? git(dirname(resolve(file)), 'rev-parse', '--show-toplevel');
    const state = snapshot(records);
    const errors = validatePlan(parsePlan(readFileSync(file, 'utf8')), state);
    if (errors.length) { console.error(errors.join('\n')); return 1; }
    console.log(`Valid plan (${state.revision})`);
    return 0;
  }
  const clock = cliClock(args);
  need(args, 'records', 'plan');
  const state = snapshot(args.records), plan = loadPlan(state, args.plan);
  let result;
  if (operation === 'ready') {
    const context = planContext(state, plan);
    let base, unread = null;
    try { base = integrationTarget(context.cfg); } catch (error) { unread = `The integration SHA cannot be read (${error.message}): a judge package's command names no --base.`; }
    const host = hostLoad({ cfg: context.cfg, store: resolveOwnerStore() });
    const current = reconcilePlans(state.records, state.revision, plan.phase, { host, base, now: clock.now }).plans.find(p => p.plan.id === plan.id);
    if (current?.problem) throw new Error(current.problem);
    result = current?.result ?? readyPlan(state, plan, { context, host, base, now: clock.now });
    if (unread) result.unknowns.push(unread);
  } else result = measurePlan(state, plan, clock);
  if ('json' in args) console.log(JSON.stringify(result, null, 2));
  else if (operation === 'measure') console.log(renderMeasures(result));
  else console.log([`Plan ${plan.id} · records ${state.revision}`,
    ...result.packages.map(p => `${p.id}: ${p.status}${p.command ? `\n  ${p.command}` : ''}${p.holds.length ? '\n  ' + p.holds.map(h => `${h.kind}: ${h.target}; release: ${h.release}${h.computed === false ? ` (${p.unchecked.review})` : ''}`).join('\n  ') : ''}`),
    ...result.unknowns].join('\n'));
  return 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) cli(() => main());
