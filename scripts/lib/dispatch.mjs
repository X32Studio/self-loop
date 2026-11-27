// P-0012, D-0059, D-0060, D-0063, D-0064, D-0066, design/parallel-dispatch.md#1, design/mandatory-control-plane.md#4, design/dispatch.md#file-ownership
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { call, preparedIn, recordCall } from "../call.mjs";
import { batchesFrom } from "../decisions.mjs";
import { buildImportGraph } from "./arch-facts.mjs";
import { node as nodeCommand } from "./commands.mjs";
import { git, gitOk, regularFiles } from "./git-plumbing.mjs";
import { HANDOFFS, idOf, parseHandoffs } from "./handoff.mjs";
import { isPreparedRunner } from "./paseo.mjs";
import {
  criticCausalBase, HANDOFF_ID, isCodeJudge, judgeCoverageProblems, judgeJoinProblems,
  loadPlan, packageOrder, PLAN_ID, planCallCommand, planContext, planPackageMap, plansFrom,
  readPlanWindow, readyPlan, recordPath, reviewCoverage, snapshot,
} from "./plan.mjs";
import { fileOverlap, globMatch } from "./plan-globs.mjs";
import { hostLoad, resolveOwnerStore } from "./registry.mjs";
import { findTranscripts, transcriptEvents } from "./t3-child.mjs";

export { judgeCoverageProblems, judgeJoinProblems, readPlanWindow, reviewCoverage };

const CONTRACT_PTR_RE = /(?:D|F|P)-\d{4}|R-\d{4}-judge(?:-[a-z]+)*|design\/[a-z0-9._-]+\.md(?:#\S+)?/gi;
const isWriterPkg = p => Boolean(p && (p.role === "actor" || (p.role === "critic" && (p.files ?? []).length > 0)));

const extractContractPointers = text =>
  typeof text === "string" && text.trim() ? [...new Set([...text.matchAll(CONTRACT_PTR_RE)].map(m => m[0]))] : [];

const pointerPath = ptr => /^design\//i.test(ptr)
  ? ptr.split("#")[0]
  : recordPath(ptr.replace(/^([dfpr])-/i, (_, c) => `${c.toUpperCase()}-`));

function hasValidContract(text, state) {
  const ptrs = extractContractPointers(text);
  if (!ptrs.length) return false;
  return !state || ptrs.every(ptr => { const p = pointerPath(ptr); return Boolean(p && state.files.has(p)); });
}

const matchPackageFiles = (allFiles, patterns) =>
  Array.isArray(patterns) && patterns.length ? allFiles.filter(fp => patterns.some(pat => globMatch(pat, fp))).sort() : [];

export function computeWaves(plan) {
  const byRef = planPackageMap(plan), memo = new Map(), visiting = new Set();
  const depth = id => {
    if (memo.has(id)) return memo.get(id);
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const deps = [...new Set((byRef.get(id)?.needs ?? []).map(d => byRef.get(d)?.id).filter(Boolean))];
    const wave = deps.length ? 1 + Math.max(...deps.map(depth)) : 0;
    visiting.delete(id);
    memo.set(id, wave);
    return wave;
  };
  for (const p of plan.packages) depth(p.id);
  return memo;
}

const handoffsOf = (state, phase) => state.files.has(HANDOFFS)
  ? parseHandoffs(state.read(HANDOFFS)).filter(h => h.phase === phase && state.files.has(h.record))
  : [];

function activePreparedFor(prepared, phase, handoffs, excludeId = null) {
  const done = new Set(handoffs.map(h => h.id));
  return (prepared ?? []).filter(w => (!w.phase || w.phase === phase) && w.liveWorkspace && !done.has(w.id) && w.id !== excludeId);
}

function liveWriteGlobs(w, allPlans) {
  if (Array.isArray(w.dispatch?.files)) return w.dispatch.files;
  const fromPlan = allPlans.flatMap(q => q.packages).find(q => q.handoff === w.id);
  return fromPlan ? (fromPlan.files ?? []) : [];
}

function pairLookup(pairs) {
  const map = new Map();
  for (const pair of pairs) { map.set(`${pair.left}\0${pair.right}`, pair); map.set(`${pair.right}\0${pair.left}`, pair); }
  return (a, b) => map.get(`${a}\0${b}`) ?? null;
}

// P-0012, D-0059, design/parallel-dispatch.md#2
export function analyzeDecoupling({ plan, product, base, state = null }) {
  const allFiles = regularFiles(product, base).map(f => f.path);
  const matchedFiles = Object.fromEntries(plan.packages.map(p => [p.id, matchPackageFiles(allFiles, p.files)]));
  const graph = buildImportGraph(product, base);
  const sets = new Map(plan.packages.map(p => [p.id, new Set(matchedFiles[p.id])]));
  const pairs = [];
  for (let i = 0; i < plan.packages.length; i++) {
    for (let j = i + 1; j < plan.packages.length; j++) {
      const a = plan.packages[i], b = plan.packages[j];
      const overlap = fileOverlap(a.files ?? [], b.files ?? []);
      const aSet = sets.get(a.id), bSet = sets.get(b.id);
      const edges = graph.edges.filter(e => (aSet.has(e.from) && bSet.has(e.to)) || (bSet.has(e.from) && aSet.has(e.to)));
      const kind = overlap !== null ? "write-coupled"
        : edges.length === 0 ? "decoupled"
        : hasValidContract(a.interface, state) && hasValidContract(b.interface, state) ? "interface-coupled" : "undeclared-coupled";
      pairs.push({
        left: a.id, right: b.id, kind, overlap, edges,
        contracts: { [a.id]: extractContractPointers(a.interface), [b.id]: extractContractPointers(b.interface) },
      });
    }
  }
  return {
    base, matchedFiles, pairs,
    undeclaredCoupled: pairs.filter(p => p.kind === "undeclared-coupled"),
    writeCoupled: pairs.filter(p => p.kind === "write-coupled"),
    decoupledCount: pairs.filter(p => p.kind === "decoupled").length,
  };
}

// P-0012, D-0059, design/parallel-dispatch.md#3
export function computeDispatchPlan({ state, plan, context, ready = null, product, base, host, window = null, now = Date.now() }) {
  const ctx = context ?? planContext(state, plan);
  const repo = product ?? ctx.cfg.product;
  const resolvedHost = host ?? hostLoad({ cfg: ctx.cfg, store: resolveOwnerStore() });
  const phaseHandoffs = handoffsOf(state, plan.phase);
  const win = window ?? readPlanWindow(state, plan.phase, 1, { handoffs: phaseHandoffs, rows: ctx.trajectory });
  const analysisBase = base ?? (gitOk(repo, "rev-parse", "--verify", "--quiet", `${ctx.cfg.branch ?? "HEAD"}^{commit}`)
    ? git(repo, "rev-parse", `${ctx.cfg.branch ?? "HEAD"}^{commit}`)
    : git(repo, "rev-parse", "HEAD"));
  const resolvedReady = ready ?? readyPlan(state, plan, { context: ctx, host: resolvedHost, base, window: win, now });
  const decoupling = analyzeDecoupling({ plan, product: repo, base: analysisBase, state });
  const coverage = reviewCoverage(plan, { window: win });
  const waveMap = computeWaves(plan);
  const pkgById = new Map(plan.packages.map(p => [p.id, p]));
  const pairOf = pairLookup(decoupling.pairs);
  const handoffById = new Map(phaseHandoffs.map(h => [h.id, h]));

  const landedWriters = plan.packages.filter(p => p.role === "actor" || p.role === "critic").flatMap(p => {
    const h = handoffById.get(p.handoff);
    return h?.product?.commit && (p.role === "actor" || h.product.commit !== h.product.base)
      ? [{ id: p.id, role: p.role, handoff: h.id, wave: waveMap.get(p.id), base: h.product.base, commit: h.product.commit, changed: h.product.commit !== h.product.base }] : [];
  });
  const landedActors = landedWriters.filter(w => w.role === "actor");
  const isMergedInto = (sha, target) => Boolean(target && gitOk(repo, "merge-base", "--is-ancestor", sha, target));
  const unmergedWriters = landedWriters.filter(w => (w.role === "actor" || w.changed) && !isMergedInto(w.commit, base));
  const unmergedActors = unmergedWriters.filter(w => w.role === "actor");
  const needsIntegration = unmergedWriters.length > 0;
  const criticTargetsById = new Map(coverage.critics.map(c => [c.id, c.targets]));

  const liveActors = resolvedReady.packages.filter(r => r.role === "actor" && r.status === "running").map(r => r.id);
  const liveCritics = resolvedReady.packages.filter(r => r.role === "critic" && r.status === "running").map(r => r.id);
  const batchActors = [], blockedCoupling = [], batchCritics = [];
  const sortedReady = role => resolvedReady.packages.filter(r => r.role === role && r.status === "ready").sort((a, b) => waveMap.get(a.id) - waveMap.get(b.id));

  for (const row of sortedReady("actor")) {
    const peers = [...liveActors, ...batchActors.map(a => a.id)];
    const bad = peers.map(peerId => ({ peerId, pair: pairOf(row.id, peerId) }))
      .find(({ pair }) => pair && (pair.kind === "write-coupled" || pair.kind === "undeclared-coupled"));
    if (bad) {
      if (bad.pair.kind === "undeclared-coupled") blockedCoupling.push({ id: row.id, peer: bad.peerId, edges: bad.pair.edges });
      continue;
    }
    const pkg = pkgById.get(row.id);
    batchActors.push({ id: row.id, handoff: row.handoff, role: "actor", wave: waveMap.get(row.id), files: pkg.files ?? [], command: planCallCommand(ctx.cfg, plan.id, pkg) });
  }

  for (const row of sortedReady("critic")) {
    const pkg = pkgById.get(row.id), targets = criticTargetsById.get(row.id) ?? [];
    const cb = criticCausalBase(plan, pkg, { repo, handoffs: phaseHandoffs, base });
    if (!cb.ok) continue;
    const peers = [...liveCritics, ...batchCritics.map(c => c.id)];
    if (peers.some(peerId => fileOverlap(pkg.files ?? [], pkgById.get(peerId)?.files ?? []) !== null)) continue;
    batchCritics.push({ id: row.id, handoff: row.handoff, role: "critic", wave: waveMap.get(row.id), targets, files: pkg.files ?? [], command: planCallCommand(ctx.cfg, plan.id, pkg, { base: cb.pinned ? cb.base : null }) });
  }

  const judgeBlockedReasons = [];
  if (plan.packages.some(isCodeJudge)) {
    for (const jp of judgeJoinProblems(plan, { repo, handoffs: phaseHandoffs, base, window: win, coverage })) {
      judgeBlockedReasons.push(jp.detail);
    }
    if (!base) {
      for (const w of unmergedWriters) judgeBlockedReasons.push(`landed ${w.role} ${w.id} (${w.handoff} @ ${w.commit.slice(0, 12)}) is not merged into integration base`);
    }
  }

  const waveBuckets = new Map();
  const packages = resolvedReady.packages.map(row => {
    const wave = waveMap.get(row.id), pkg = pkgById.get(row.id);
    const cb = row.status === "ready" && row.role === "critic" ? criticCausalBase(plan, pkg, { repo, handoffs: phaseHandoffs, base }) : null;
    const rowBase = row.role === "judge" ? base : cb?.ok && cb.pinned ? cb.base : null;
    const entry = { ...row, wave, files: pkg.files ?? [], ...(row.status === "ready" ? { dispatchCommand: planCallCommand(ctx.cfg, plan.id, pkg, { base: rowBase }) } : {}) };
    if (!waveBuckets.has(wave)) waveBuckets.set(wave, []);
    waveBuckets.get(wave).push(entry);
    return entry;
  });
  const waves = [...waveBuckets.entries()].sort((a, b) => a[0] - b[0]).map(([wave, list]) => ({ wave, packages: list }));

  return {
    plan: plan.id, scope: plan.scope, phase: plan.phase, revision: state.revision, base, analysisBase,
    decoupling, coverage, waves, packages,
    parallelBatch: { actors: batchActors, critics: batchCritics, blockedCoupling },
    landedActors, unmergedActors, unmergedWriters, needsIntegration,
    integrateCommand: needsIntegration ? nodeCommand("dispatch.mjs", "integrate", "--records", state.records, "--plan", plan.id, "--apply") : null,
    judgeBlockedReasons, host: resolvedHost,
  };
}

// P-0012, D-0059, design/parallel-dispatch.md#4
export function validateDispatchCall({ cfg, state, planId, packageId, role, step, round, base, prepared, window = null }) {
  const failEarly = msg => ({ ok: false, errors: [msg], plan: null, pkg: null, peerFiles: [], scopeFiles: [] });
  if (!PLAN_ID.test(planId ?? "") || !state.files.has(`plans/${planId}.md`)) return failEarly(`G1 missing committed plan ${planId}`);
  let plan, allPlans;
  try { plan = loadPlan(state, planId); allPlans = plansFrom(state); } catch (e) { return failEarly(`G1 invalid plan ${planId}: ${e.message}`); }
  const errors = [];
  if (plan.phase !== cfg.phase) errors.push(`G1 plan ${plan.id} phase ${plan.phase} does not match config phase ${cfg.phase}`);
  if (allPlans.some(p => p.supersedes === plan.id)) errors.push(`G1 plan ${plan.id} is superseded; use the current plan`);
  const pkg = plan.packages.find(p => p.id === packageId) ?? null;
  if (!pkg) return { ok: false, errors: [...errors, `G1 package ${packageId} does not exist in ${plan.id}`], plan, pkg: null, peerFiles: [], scopeFiles: [] };
  const expectedId = idOf(round, step);
  if (pkg.role !== role) errors.push(`G1 package ${pkg.id} role is ${pkg.role}, not ${role}`);
  if (pkg.handoff !== expectedId) errors.push(`G1 package ${pkg.id} expects handoff ${pkg.handoff}, not ${expectedId}`);

  const phaseHandoffs = handoffsOf(state, cfg.phase);
  const completed = new Set(phaseHandoffs.map(h => h.id));
  const byRef = planPackageMap(plan);
  const batches = batchesFrom([...state.files], state.read);
  for (const need of pkg.needs ?? []) {
    const dep = byRef.get(need);
    if (dep) {
      if (!completed.has(dep.handoff)) errors.push(`G2 unmet dependency ${dep.id} (${dep.handoff}) has no recorded handoff`);
    } else if (/^B-\d{4}$/.test(need) && !batches.find(b => b.id === need)?.answered) {
      errors.push(`G2 unmet owner batch ${need} is not answered`);
    }
  }

  const active = activePreparedFor(prepared, cfg.phase, phaseHandoffs, expectedId);
  const scopeFiles = pkg.files ?? [];
  if (["actor", "critic"].includes(role) && scopeFiles.length > 0) {
    for (const w of active) {
      if (!["actor", "critic"].includes(w.role)) continue;
      const liveFiles = liveWriteGlobs(w, allPlans);
      const overlap = liveFiles.length ? fileOverlap(scopeFiles, liveFiles) : null;
      if (overlap) errors.push(`G3 live writer overlap with ${w.id}: ${overlap.left} overlaps ${overlap.right}`);
    }
  }

  if (role === "actor") {
    const peerActors = active.filter(w => w.role === "actor");
    if (peerActors.length > 0) {
      const decoupling = analyzeDecoupling({ plan, product: cfg.product, base, state });
      const pairOf = pairLookup(decoupling.pairs);
      const graph = buildImportGraph(cfg.product, base);
      const allRepoFiles = regularFiles(cfg.product, base).map(f => f.path);
      const ownSet = new Set(decoupling.matchedFiles[pkg.id] ?? []);
      for (const w of peerActors) {
        const peerPkg = (w.dispatch?.plan === plan.id && byRef.get(w.dispatch.package)) || byRef.get(w.id) || null;
        if (peerPkg && peerPkg.id !== pkg.id) {
          const pair = pairOf(pkg.id, peerPkg.id);
          if (pair?.kind === "undeclared-coupled") {
            errors.push(`G4 undeclared import coupling between ${pkg.id} and live peer ${peerPkg.id} (${w.id}): ${pair.edges.map(e => `${e.from} -> ${e.to}`).join(", ")}; add committed contract pointers in both interface: fields`);
          }
        } else if (!peerPkg) {
          const peerSet = new Set(matchPackageFiles(allRepoFiles, liveWriteGlobs(w, allPlans)));
          const cross = graph.edges.filter(e => (ownSet.has(e.from) && peerSet.has(e.to)) || (peerSet.has(e.from) && ownSet.has(e.to)));
          if (cross.length > 0 && !hasValidContract(pkg.interface, state)) {
            errors.push(`G4 undeclared import coupling between ${pkg.id} and live actor ${w.id}: ${cross.map(e => `${e.from} -> ${e.to}`).join(", ")}; add a committed contract pointer in interface:`);
          }
        }
      }
    }
  }

  if (role === "critic" && base) {
    const cb = criticCausalBase(plan, pkg, { repo: cfg.product, handoffs: phaseHandoffs, base });
    if (cb.missing.length > 0) errors.push(`G2 critic causal base: ${cb.detail}`);
  }

  if (isCodeJudge(pkg)) {
    const win = window ?? readPlanWindow(state, cfg.phase, round, { handoffs: phaseHandoffs });
    for (const jp of judgeJoinProblems(plan, { repo: cfg.product, handoffs: phaseHandoffs, base, window: win })) {
      errors.push(`G7 judge join barrier: ${jp.detail}`);
    }
  }

  const peerFiles = [...new Set(plan.packages.filter(p => p.id !== pkg.id).flatMap(p => p.files ?? []))];
  return { ok: errors.length === 0, errors, plan, pkg, peerFiles, scopeFiles };
}

function writerBranch(cfg) {
  const hasBranch = Boolean(cfg.branch && gitOk(cfg.product, "show-ref", "--verify", "--quiet", `refs/heads/${cfg.branch}`));
  const branchRef = hasBranch && !(cfg.protected ?? []).includes(cfg.branch) ? cfg.branch : null;
  const branchHead = branchRef ? git(cfg.product, "rev-parse", `refs/heads/${branchRef}`) : null;
  const refHead = branchHead ?? (hasBranch ? git(cfg.product, "rev-parse", `refs/heads/${cfg.branch}`)
    : gitOk(cfg.product, "rev-parse", "--verify", "--quiet", "HEAD^{commit}") ? git(cfg.product, "rev-parse", "HEAD^{commit}") : null);
  return { branchRef, branchHead, refHead };
}
const integratesHandoff = (repo, pkg, h, refHead) => Boolean(h?.product?.commit
  && (h.product.commit !== h.product.base || (pkg.role === "actor" && refHead && !gitOk(repo, "merge-base", "--is-ancestor", h.product.commit, refHead))));

// P-0012, D-0059, design/parallel-dispatch.md#4
export function integrateWave({ cfg, state, plan, wave = null, apply = false }) {
  const waveMap = computeWaves(plan);
  const planWriters = plan.packages.filter(p => isWriterPkg(p) && (wave === null || waveMap.get(p.id) === wave));
  if (!planWriters.length) return { ok: false, conflicts: [], message: `no writer packages in ${plan.id}${wave !== null ? ` wave ${wave}` : ""}` };
  const handoffById = new Map(handoffsOf(state, plan.phase).map(h => [h.id, h]));
  if (wave !== null) {
    const missing = planWriters.filter(p => !handoffById.has(p.handoff)).map(p => `${p.id} (${p.handoff})`);
    if (missing.length) return { ok: false, conflicts: [], message: `wave ${wave} is incomplete; missing handoff(s): ${missing.join(", ")}` };
  }
  const { branchRef, branchHead, refHead } = writerBranch(cfg);
  const landed = planWriters.flatMap(p => {
    const h = handoffById.get(p.handoff);
    if (!integratesHandoff(cfg.product, p, h, refHead)) return [];
    const files = h.product.commit === h.product.base ? [] : git(cfg.product, "diff", "--name-only", `${h.product.base}..${h.product.commit}`).split("\n").filter(Boolean);
    return [{ id: p.id, role: p.role, handoff: h.id, wave: waveMap.get(p.id), base: h.product.base, commit: h.product.commit, files }];
  });
  if (!landed.length) return { ok: false, conflicts: [], message: `no landed writer commits to integrate for ${plan.id}${wave !== null ? ` wave ${wave}` : ""}` };
  const { ordered } = packageOrder(plan);
  const conflicts = [];
  for (let i = 0; i < landed.length; i++) {
    const aSet = new Set(landed[i].files);
    for (let j = i + 1; j < landed.length; j++) {
      if (ordered(landed[i].id, landed[j].id) && (
        gitOk(cfg.product, "merge-base", "--is-ancestor", landed[i].commit, landed[j].commit)
        || gitOk(cfg.product, "merge-base", "--is-ancestor", landed[j].commit, landed[i].commit)
      )) continue;
      const shared = landed[j].files.filter(f => aSet.has(f));
      if (shared.length) conflicts.push({ left: landed[i].id, right: landed[j].id, files: shared });
    }
  }
  if (conflicts.length) {
    return { ok: false, disjoint: false, conflicts, commits: landed, message: `overlapping modified files across wave actors: ${conflicts.map(c => `${c.left}/${c.right}: ${c.files.join(", ")}`).join("; ")}` };
  }
  const actorCommits = branchHead ? [] : planWriters.filter(p => p.role === "actor").map(p => handoffById.get(p.handoff)?.product?.commit).filter(Boolean);
  const candidates = [...new Set([...(branchHead ? [branchHead] : []), ...landed.map(a => a.commit), ...actorCommits])];
  const independent = candidates.length > 1 ? git(cfg.product, "merge-base", "--independent", ...candidates).split("\n").filter(Boolean) : candidates;
  const parents = branchHead && independent.includes(branchHead) ? [branchHead, ...independent.filter(sha => sha !== branchHead)] : independent;

  let acc = parents[0], mergedTree = git(cfg.product, "rev-parse", `${acc}^{tree}`);
  for (let i = 1; i < parents.length; i++) {
    const res = spawnSync("git", ["-C", cfg.product, "merge-tree", "--write-tree", "--name-only", acc, parents[i]], { encoding: "utf8" });
    if (res.status !== 0) {
      const lines = (res.stdout ?? "").split("\n");
      const conflictFiles = lines.slice(1, lines.indexOf("") > 0 ? lines.indexOf("") : lines.length).filter(Boolean);
      return { ok: false, disjoint: true, conflicts: conflictFiles.map(file => ({ file })), commits: landed, message: `git merge-tree conflict integrating ${parents[i].slice(0, 12)}: ${(res.stderr || res.stdout || "merge conflict").trim()}` };
    }
    mergedTree = res.stdout.trim().split("\n")[0];
    if (i + 1 < parents.length) acc = git(cfg.product, "commit-tree", mergedTree, "-p", acc, "-p", parents[i], "-m", "self-loop: merge-tree fold");
  }

  const base = branchHead ?? landed[0].base;
  if (!apply) return { ok: true, dryRun: true, base, commits: landed, parents, mergedTree, disjoint: true };
  const commit = parents.length === 1 ? parents[0]
    : git(cfg.product, "commit-tree", mergedTree, ...parents.flatMap(p => ["-p", p]), "-m", `self-loop: integrate ${plan.id}${wave !== null ? ` wave ${wave}` : ""} (${landed.map(a => a.id).join(", ")})`);
  if (branchRef && branchHead !== commit && !gitOk(cfg.product, "update-ref", `refs/heads/${branchRef}`, commit, branchHead)) {
    return { ok: false, conflicts: [], message: `branch ${branchRef} moved concurrently while integrating ${plan.id}` };
  }
  return { ok: true, dryRun: false, base, commit, parents, mergedTree, branch: branchRef, commits: landed, disjoint: true };
}

// P-0012, D-0059, design/parallel-dispatch.md#5
export function renderDispatchLines(dp) {
  const lines = [`Plan ${dp.plan} (${dp.scope}) · review topology: ${dp.coverage.topology} · decoupled pairs: ${dp.decoupling.decoupledCount}, undeclared-coupled: ${dp.decoupling.undeclaredCoupled.length}, write-coupled: ${dp.decoupling.writeCoupled.length}`];
  if (dp.parallelBatch.actors.length) {
    lines.push(`Parallel actor batch (${dp.parallelBatch.actors.length}): ${dp.parallelBatch.actors.map(a => `${a.id}[w${a.wave}]`).join(", ")}`, ...dp.parallelBatch.actors.map(a => `  ${a.command}`));
  }
  for (const b of dp.parallelBatch.blockedCoupling) lines.push(`Coupling guard blocked ${b.id} against ${b.peer}: ${b.edges.map(e => `${e.from} -> ${e.to}`).join(", ")}`);
  if (dp.needsIntegration && dp.integrateCommand) lines.push(`Wave integration needed (${(dp.unmergedWriters ?? dp.unmergedActors).map(a => `${a.id}@${a.commit.slice(0, 12)}`).join(", ")}):`, `  ${dp.integrateCommand}`);
  if (dp.parallelBatch.critics.length) {
    lines.push(`Parallel critic batch (${dp.parallelBatch.critics.length}, topology ${dp.coverage.topology}): ${dp.parallelBatch.critics.map(c => `${c.id}[w${c.wave}]`).join(", ")}`, ...dp.parallelBatch.critics.map(c => `  ${c.command}`));
  }
  if (dp.judgeBlockedReasons.length) lines.push(`Judge join barrier: ${dp.judgeBlockedReasons.join("; ")}`);
  return lines;
}

// D-0060, design/mandatory-control-plane.md#4
function materializeTask(cfg, state, plan, pkg) {
  const taskFile = resolve(cfg.workDir, pkg.task ?? `tasks/${pkg.handoff}.md`);
  if (existsSync(taskFile)) return taskFile;
  const raw = [pkg.features, plan.features, pkg.goal, pkg.interface, pkg.acceptance].filter(Boolean).join(" ");
  const cited = [...new Set([...raw.matchAll(/(?<![\w-])F-\d{4}(?![\w-])/g)].map(m => m[0]))].filter(id => state.files.has(`blueprint/${id}.md`));
  const bp = cited.length ? [] : [...state.files].filter(f => /^blueprint\/F-\d{4}\.md$/.test(f)).sort();
  const phaseRe = new RegExp(`^phase:\\s*${plan.phase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "m");
  const samePhase = bp.filter(f => phaseRe.test(state.read(f)));
  const inferred = (samePhase.length ? samePhase : bp).map(f => f.slice(10, 16));
  const features = cited.length ? cited : inferred.length ? inferred : (pkg.role === "reviewer" ? ["none"] : []);
  mkdirSync(dirname(taskFile), { recursive: true });
  writeFileSync(taskFile, [
    `features: ${features.join(", ")}`, "", `# ${pkg.handoff} (${plan.id} :: ${pkg.id})`, "",
    `goal: ${pkg.goal}`, `files: ${(pkg.files ?? []).join(", ")}`, `interface: ${pkg.interface}`, `acceptance: ${pkg.acceptance}`, "",
  ].join("\n"));
  return taskFile;
}

// D-0060, design/mandatory-control-plane.md#4
export function prepareWave({ cfg, state, plan, context = null, wave = null, base = null, readyBase = undefined, host = null, window = null, now = Date.now(), log = () => {} }) {
  const ctx = context ?? { ...planContext(state, plan), cfg };
  const resolvedBase = readyBase !== undefined ? readyBase : base;
  const phaseHandoffs = handoffsOf(state, plan.phase);
  const win = window ?? readPlanWindow(state, plan.phase, 1, { handoffs: phaseHandoffs, rows: ctx.trajectory });
  const ready = readyPlan(state, plan, { context: ctx, host: host ?? hostLoad({ cfg, store: resolveOwnerStore() }), base: resolvedBase, window: win, now });
  const waveMap = computeWaves(plan), pkgById = new Map(plan.packages.map(p => [p.id, p]));
  const eligible = ready.packages
    .filter(r => r.status === "ready" || (r.status === "waiting" && r.holds.length > 0 && r.holds.every(h => h.kind === "task")))
    .filter(r => wave === null || waveMap.get(r.id) === wave)
    .sort((a, b) => waveMap.get(a.id) - waveMap.get(b.id));
  const prepared = [], errors = [];
  for (const row of eligible) {
    const pkg = pkgById.get(row.id), [, round, role, suffix] = HANDOFF_ID.exec(pkg.handoff);
    let callBase = base ?? (role === "judge" ? resolvedBase : null) ?? undefined;
    if (role === "critic") {
      const cb = criticCausalBase(plan, pkg, { repo: cfg.product, handoffs: phaseHandoffs, base: base ?? resolvedBase });
      if (!base && !cb.ok) { errors.push({ id: pkg.id, handoff: pkg.handoff, role, code: 1, message: cb.detail }); continue; }
      callBase = base ?? (cb.pinned ? cb.base : null) ?? undefined;
    }
    const taskFile = materializeTask(cfg, state, plan, pkg);
    const res = call(cfg, role, {
      round: Number(round), step: role + suffix, task: readFileSync(taskFile, "utf8"),
      base: callBase, prepare: isPreparedRunner(cfg.agents[role]?.runner), plan: plan.id, package: pkg.id,
    }, { log });
    if (res.code !== 0) errors.push({ id: pkg.id, handoff: pkg.handoff, role, code: res.code, message: res.message });
    else if (res.prepared) prepared.push({ ...res.prepared, id: pkg.id, handoff: pkg.handoff, role, wave: waveMap.get(pkg.id), taskFile });
    else prepared.push({ id: pkg.id, handoff: pkg.handoff, role, wave: waveMap.get(pkg.id), ws: res.ws ?? null, handoffRecord: res.handoff ?? null, taskFile });
  }
  return { ok: errors.length === 0, plan: plan.id, wave, prepared, errors };
}

// D-0060, R-0019-reviewer-architecture, design/mandatory-control-plane.md#4
export function recordWave({ cfg, state, plan, wave = null, integrate = false, log = () => {} }) {
  const waveMap = computeWaves(plan), byRef = planPackageMap(plan);
  const done = new Set(handoffsOf(state, plan.phase).map(h => h.id));
  const candidates = preparedIn(cfg).filter(w => {
    if (!w.liveWorkspace || done.has(w.id)) return false;
    const pkg = (w.dispatch?.plan === plan.id && byRef.get(w.dispatch.package)) || (!w.dispatch && byRef.get(w.id)) || null;
    return Boolean(pkg && (wave === null || waveMap.get(pkg.id) === wave));
  });
  const recorded = [], pending = [], errors = [];
  for (const w of candidates) {
    const pkg = byRef.get(w.dispatch?.package) ?? byRef.get(w.id), provider = w.agent?.provider;
    if (!provider) { errors.push({ id: pkg.id, handoff: w.id, ws: w.ws, code: 1, message: "prepared call has no t3/paseo provider" }); continue; }
    const matches = findTranscripts(w.agent, w.nonce, w.preparedAt);
    if (!matches.length) { pending.push({ id: pkg.id, handoff: w.id, ws: w.ws, reason: "no matching transcript" }); continue; }
    if (matches.length > 1) { errors.push({ id: pkg.id, handoff: w.id, ws: w.ws, code: 1, message: `ambiguous: ${matches.length} transcripts match nonce ${w.nonce}` }); continue; }
    if (transcriptEvents(w.id, matches[0]).status === "pending") { pending.push({ id: pkg.id, handoff: w.id, ws: w.ws, session: matches[0].session, reason: "transcript pending" }); continue; }
    const res = recordCall(cfg, w.ws, { session: matches[0].session, transcript: matches[0].file, log });
    if (res.code === 0) recorded.push({ id: pkg.id, handoff: w.id, role: pkg.role, wave: waveMap.get(pkg.id), ws: w.ws, session: matches[0].session, handoffRecord: res.handoff });
    else errors.push({ id: pkg.id, handoff: w.id, ws: w.ws, session: matches[0].session, code: res.code, message: res.message });
  }
  let integration = null;
  if (integrate && !errors.length) {
    const fresh = snapshot(cfg.records), freshHandoffs = handoffsOf(fresh, plan.phase);
    const doneAfter = new Map(freshHandoffs.map(h => [h.id, h]));
    const writerWaves = [...new Set(recorded.filter(r => isWriterPkg(byRef.get(r.id))).map(r => r.wave))];
    const targetWave = wave ?? (writerWaves.length === 1 ? writerWaves[0] : null);
    const writers = plan.packages.filter(p => isWriterPkg(p) && (targetWave === null || waveMap.get(p.id) === targetWave));
    const { refHead } = writerBranch(cfg);
    if (writers.length && writers.every(p => doneAfter.has(p.handoff)) && writers.some(p => integratesHandoff(cfg.product, p, doneAfter.get(p.handoff), refHead))) {
      integration = integrateWave({ cfg, state: fresh, plan, wave: targetWave, apply: true });
      if (!integration.ok) errors.push({ id: "integrate", handoff: null, code: 1, message: integration.message });
    }
  }
  return { ok: errors.length === 0, plan: plan.id, wave, recorded, pending, errors, ...(integration ? { integration } : {}) };
}
