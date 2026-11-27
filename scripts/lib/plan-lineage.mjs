// P-0006, P-0012, P-0013, F-0012, D-0059, D-0060, D-0063, D-0064, D-0066, design/dispatch.md#ready-state, design/parallel-dispatch.md#3
import { resolve } from 'node:path';
import { node as nodeCommand } from './commands.mjs';
import { git, gitOk } from './git-plumbing.mjs';
import { isPreparedRunner } from './paseo.mjs';
import { fileOverlap } from './plan-globs.mjs';

const text = value => typeof value === 'string' && value.trim().length > 0;
export const HANDOFF_ID = /^R-(\d{4})-(reviewer|critic|actor|judge)((?:-[a-z]+)*)$/;

export function planPackageMap(plan) {
  const map = new Map(), pkgs = Array.isArray(plan?.packages) ? plan.packages : [];
  for (const p of pkgs) if (text(p?.handoff) && !map.has(p.handoff)) map.set(p.handoff, p);
  for (const p of pkgs) if (text(p?.id)) map.set(p.id, p);
  return map;
}

export function packageOrder(plan) {
  const byRef = planPackageMap(plan), deps = new Map();
  const ancestors = id => {
    if (deps.has(id)) return deps.get(id);
    const seen = new Set(), needs = byRef.get(id)?.needs;
    const stack = Array.isArray(needs) ? [...needs] : [];
    while (stack.length) {
      const dep = byRef.get(stack.pop());
      if (!dep || dep.id === id || seen.has(dep.id)) continue;
      seen.add(dep.id);
      if (Array.isArray(dep.needs)) stack.push(...dep.needs);
    }
    return deps.set(id, seen).get(id);
  };
  const reaches = (a, b) => ancestors(byRef.get(b)?.id ?? b).has(byRef.get(a)?.id ?? a);
  return { reaches, ordered: (a, b) => reaches(a, b) || reaches(b, a) };
}

export const isCodeJudge = pkg => pkg?.role === 'judge' && !/^R-\d{4}-judge-(?:frame|comments)(?:-|$)/.test(pkg.handoff ?? '');
const descends = (repo, anc, tip) => Boolean(anc && tip && (anc === tip || gitOk(repo, 'merge-base', '--is-ancestor', anc, tip)));

export function planCallCommand(cfg, planId, pkg, { base = null } = {}) {
  const [, round, role, suffix] = HANDOFF_ID.exec(pkg.handoff);
  const prepare = isPreparedRunner(cfg.agents?.[pkg.role]?.runner) ? ['--prepare'] : [];
  const baseArgs = base ? ['--base', base] : [];
  const task = resolve(cfg.workDir, pkg.task ?? `tasks/${pkg.handoff}.md`);
  return nodeCommand(
    'call.mjs', cfg.configFile, role, '--round', String(Number(round)), '--step', role + suffix,
    ...baseArgs, '--plan', planId, '--package', pkg.id, '--task', task, ...prepare,
  );
}

export function reviewCoverage(plan, { window = null } = {}) {
  const actors = plan.packages.filter(p => p.role === 'actor');
  const critics = plan.packages.filter(p => p.role === 'critic');
  const actorIds = new Set(actors.map(p => p.id));
  const byRef = planPackageMap(plan);
  const { reaches, ordered } = packageOrder(plan);
  const reachable = startId => actors.map(a => a.id).filter(id => reaches(id, startId));
  const criticRows = critics.map(c => {
    const explicit = Array.isArray(c.reviews) && c.reviews.length ? [...new Set(c.reviews.filter(id => actorIds.has(id)))] : null;
    const preActors = actors.filter(a => (Array.isArray(a.needs) ? a.needs : []).some(n => byRef.get(n)?.id === c.id)).map(a => a.id);
    return { id: c.id, handoff: c.handoff, files: c.files ?? [], targets: explicit ?? [...new Set([...reachable(c.id), ...preActors])] };
  });
  const criticPairsOverlap = [];
  for (let i = 0; i < critics.length; i++) {
    for (let j = i + 1; j < critics.length; j++) {
      if (ordered(critics[i].id, critics[j].id)) continue;
      const overlap = fileOverlap(critics[i].files ?? [], critics[j].files ?? []);
      if (overlap) criticPairsOverlap.push({ left: critics[i].id, right: critics[j].id, overlap });
    }
  }
  const coveredSet = new Set(criticRows.flatMap(c => c.targets));
  const actorList = actors.map(a => a.id);
  const coveredActors = actorList.filter(id => coveredSet.has(id));
  const uncoveredActors = actorList.filter(id => !coveredSet.has(id));
  const topology = !critics.length || !actors.length ? 'none'
    : uncoveredActors.length || criticPairsOverlap.length ? 'partial'
    : critics.length === 1 ? 'unified' : 'parallel';
  return { topology, required: window?.mode !== 'slack', actors: actorList, critics: criticRows, coveredActors, uncoveredActors, criticPairsOverlap };
}

export function criticCausalBase(plan, pkg, { repo, handoffs, base } = {}) {
  if (pkg?.role !== 'critic' || !repo) return { ok: true, base: base ?? null, pinned: false, missing: [] };
  const handoffById = new Map((handoffs ?? []).map(h => [h.id, h])), { reaches } = packageOrder(plan);
  const required = plan.packages.filter(a => a.role === 'actor' && reaches(a.id, pkg.id)).flatMap(a => {
    const ha = handoffById.get(a.handoff), sha = ha?.product?.commit;
    return sha ? [{ id: a.id, handoff: ha.id, sha }] : [];
  });
  if (!required.length) return { ok: true, base: base ?? null, pinned: false, missing: [] };
  const missing = required.filter(a => !descends(repo, a.sha, base));
  if (!missing.length) return { ok: true, base, pinned: Boolean(base), missing: [] };
  const shas = [...new Set(required.map(a => a.sha))];
  const independent = shas.length > 1 ? git(repo, 'merge-base', '--independent', ...shas).split('\n').filter(Boolean) : shas;
  const desc = items => items.map(a => `${a.id} (${a.handoff} @ ${a.sha.slice(0, 12)})`).join(', ');
  if (independent.length === 1) {
    const head = independent[0], release = `pass --base ${head} (or a commit descending from ${head.slice(0, 12)}) before dispatching critic ${pkg.id}`;
    return {
      ok: true, base: head, pinned: true, missing, target: desc(missing), release,
      detail: `post-actor critic ${pkg.id} base${base ? ` ${base.slice(0, 12)}` : ''} is missing landed actor commit(s): ${desc(missing)}; ${release}`,
    };
  }
  const release = `run dispatch.mjs integrate --plan ${plan.id} --apply before dispatching critic ${pkg.id}`;
  return {
    ok: false, base: null, pinned: false, missing, target: desc(missing), release,
    detail: `post-actor critic ${pkg.id} requires diverged actor commits (${desc(missing)}); ${release}`,
  };
}

export function judgeLineageProblems(plan, { repo, handoffs, base } = {}) {
  if (!repo) return [];
  const handoffById = new Map((handoffs ?? []).map(h => [h.id, h])), problems = [];
  if (typeof base === 'string' && base) {
    for (const p of plan.packages) {
      if (p.role !== 'actor' && p.role !== 'critic') continue;
      const h = handoffById.get(p.handoff), sha = h?.product?.commit;
      if (!sha || (p.role === 'critic' && sha === h.product.base) || descends(repo, sha, base)) continue;
      const short = sha.slice(0, 12), release = `pass --base descending from ${short} or run dispatch.mjs integrate --plan ${plan.id} --apply`;
      problems.push({
        kind: 'merge', id: p.id, role: p.role, handoff: h.id, sha, target: `${p.id} (${h.id} @ ${short})`, release,
        detail: `landed ${p.role} ${p.id} (${h.id} @ ${short}) is not an ancestor of --base ${base.slice(0, 12)}; ${release}`,
      });
    }
  }
  const actors = plan.packages.filter(p => p.role === 'actor'), { reaches } = packageOrder(plan);
  for (const c of plan.packages) {
    if (c.role !== 'critic') continue;
    const hc = handoffById.get(c.handoff), cBase = hc?.product?.base;
    if (!cBase) continue;
    for (const a of actors) {
      if (!reaches(a.id, c.id)) continue;
      const ha = handoffById.get(a.handoff), aSha = ha?.product?.commit;
      if (!aSha || descends(repo, aSha, cBase)) continue;
      const aShort = aSha.slice(0, 12), cShort = cBase.slice(0, 12);
      const release = `supersede ${plan.id} and re-run post-actor critic ${c.id} on --base descending from ${aShort}`;
      problems.push({
        kind: 'lineage', id: c.id, role: 'critic', handoff: hc.id, sha: aSha, actor: a.id, target: `${c.id} (${hc.id} @ ${cShort})`, release,
        detail: `post-actor critic ${c.id} (${hc.id}) ran on stale base ${cShort} missing actor ${a.id} (${ha.id} @ ${aShort}); ${release}`,
      });
    }
  }
  return problems;
}

export function judgeCoverageProblems(plan, { handoffs = [], window = null, coverage = null } = {}) {
  const cov = coverage ?? reviewCoverage(plan, { window });
  const completed = new Set((handoffs ?? []).map(h => h.id));
  const problems = [];
  for (const c of cov.critics) {
    if (c.targets.length === 0 || completed.has(c.handoff)) continue;
    const target = `${c.id} (${c.handoff}, covering ${c.targets.join(', ')})`;
    const release = `record successful handoff ${c.handoff}`;
    problems.push({
      kind: 'critic', id: c.id, role: 'critic', handoff: c.handoff, targets: c.targets, target, release,
      detail: `scheduled critic ${target} has no recorded handoff`,
    });
  }
  if (cov.required && cov.uncoveredActors.length > 0) {
    const missing = cov.uncoveredActors.join(', ');
    problems.push({
      kind: 'coverage', id: null, role: 'critic', handoff: null, actors: cov.uncoveredActors, target: missing,
      release: `supersede ${plan.id} with critic coverage for ${missing}`,
      detail: `actor package(s) lack critic coverage: ${missing}`,
    });
  }
  return problems;
}

export function judgeJoinProblems(plan, { repo = null, handoffs = [], base = null, window = null, coverage = null } = {}) {
  return [
    ...judgeLineageProblems(plan, { repo, handoffs, base }),
    ...judgeCoverageProblems(plan, { handoffs, window, coverage }),
  ];
}
