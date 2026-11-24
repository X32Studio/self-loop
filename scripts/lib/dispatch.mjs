// SKILL.md#2b-planning-and-dispatch-f-0012-p-0006
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { batchesFrom } from "../decisions.mjs";
import { parseRows, TRAJECTORY } from "../trajectory.mjs";
import { buildImportGraph } from "./arch-facts.mjs";
import { node as nodeCommand } from "./commands.mjs";
import { git, gitOk, regularFiles } from "./git-plumbing.mjs";
import { HANDOFFS, idOf, parseHandoffs } from "./handoff.mjs";
import { HANDOFF_ID, loadPlan, PLAN_ID, planContext, plansFrom, readyPlan, recordPath } from "./plan.mjs";
import { fileOverlap, globMatch } from "./plan-globs.mjs";
import { hostLoad, resolveOwnerStore } from "./registry.mjs";
import { parseWindows, WINDOWS, windowState } from "./window.mjs";

const CONTRACT_PTR_RE = /(?:D|F|P)-\d{4}|R-\d{4}-judge(?:-[a-z]+)*|design\/[a-z0-9._-]+\.md(?:#\S+)?/gi;

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

function computeWaves(plan) {
  const byId = new Map(plan.packages.map(p => [p.id, p])), memo = new Map(), visiting = new Set();
  const depth = id => {
    if (memo.has(id)) return memo.get(id);
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const deps = (byId.get(id)?.needs ?? []).filter(d => byId.has(d));
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
  return fromPlan ? (fromPlan.files ?? []) : (w.owns ?? []).flatMap(f => [f, `${f.replace(/\/$/, "")}/**`]);
}

function pairLookup(pairs) {
  const map = new Map();
  for (const pair of pairs) { map.set(`${pair.left}\0${pair.right}`, pair); map.set(`${pair.right}\0${pair.left}`, pair); }
  return (a, b) => map.get(`${a}\0${b}`) ?? null;
}

function dispatchCommand(cfg, planId, pkg, { base = null } = {}) {
  const [, round, role, suffix] = HANDOFF_ID.exec(pkg.handoff);
  const prepare = cfg.agents[pkg.role]?.runner === "t3" ? ["--prepare"] : [];
  const baseArgs = base ? ["--base", base] : [];
  const task = resolve(cfg.workDir, pkg.task ?? `tasks/${pkg.handoff}.md`);
  return nodeCommand("call.mjs", cfg.configFile, role, "--round", String(Number(round)), "--step", role + suffix,
    ...baseArgs, "--plan", planId, "--package", pkg.id, "--task", task, ...prepare);
}

// SKILL.md#2b-planning-and-dispatch-f-0012-p-0006
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

// SKILL.md#2b-planning-and-dispatch-f-0012-p-0006
export function reviewCoverage(plan, { window = null } = {}) {
  const actors = plan.packages.filter(p => p.role === "actor");
  const critics = plan.packages.filter(p => p.role === "critic");
  const actorIds = new Set(actors.map(p => p.id));
  const byId = new Map(plan.packages.map(p => [p.id, p]));
  const reachable = startId => {
    const found = new Set(), seen = new Set(), stack = [...(byId.get(startId)?.needs ?? [])];
    while (stack.length) {
      const id = stack.pop();
      if (seen.has(id) || !byId.has(id)) continue;
      seen.add(id);
      if (actorIds.has(id)) found.add(id);
      for (const dep of byId.get(id).needs ?? []) stack.push(dep);
    }
    return actors.map(a => a.id).filter(id => found.has(id));
  };
  const criticRows = critics.map(c => ({
    id: c.id, handoff: c.handoff, files: c.files ?? [],
    targets: Array.isArray(c.reviews) && c.reviews.length ? [...new Set(c.reviews.filter(id => actorIds.has(id)))] : reachable(c.id),
  }));
  const criticPairsOverlap = [];
  for (let i = 0; i < critics.length; i++) {
    for (let j = i + 1; j < critics.length; j++) {
      const overlap = fileOverlap(critics[i].files ?? [], critics[j].files ?? []);
      if (overlap) criticPairsOverlap.push({ left: critics[i].id, right: critics[j].id, overlap });
    }
  }
  const coveredSet = new Set(criticRows.flatMap(c => c.targets));
  const actorList = actors.map(a => a.id);
  const coveredActors = actorList.filter(id => coveredSet.has(id));
  const uncoveredActors = actorList.filter(id => !coveredSet.has(id));
  const topology = !critics.length || !actors.length ? "none"
    : uncoveredActors.length || criticPairsOverlap.length ? "partial"
    : critics.length === 1 ? "unified" : "parallel";
  return { topology, required: window?.mode !== "slack", actors: actorList, critics: criticRows, coveredActors, uncoveredActors, criticPairsOverlap };
}

// SKILL.md#2b-planning-and-dispatch-f-0012-p-0006
export function readPlanWindow(state, phase, nextRound = 1) {
  if (!state.files.has(WINDOWS)) return { mode: "normal", active: null, actorBlocked: false };
  const windows = parseWindows(state.read(WINDOWS), WINDOWS);
  const rows = state.files.has(TRAJECTORY) ? parseRows(state.read(TRAJECTORY)).filter(r => r.phase === phase) : [];
  return windowState({ windows, handoffs: handoffsOf(state, phase), rows, phase, nextRound });
}

// SKILL.md#2b-planning-and-dispatch-f-0012-p-0006
export function computeDispatchPlan({ state, plan, context, ready = null, product, base, host, window = null, now = Date.now() }) {
  const ctx = context ?? planContext(state, plan);
  const repo = product ?? ctx.cfg.product;
  const resolvedHost = host ?? hostLoad({ cfg: ctx.cfg, store: resolveOwnerStore() });
  const win = window ?? readPlanWindow(state, plan.phase);
  const analysisBase = base ?? (gitOk(repo, "rev-parse", "--verify", "--quiet", `${ctx.cfg.branch ?? "HEAD"}^{commit}`)
    ? git(repo, "rev-parse", `${ctx.cfg.branch ?? "HEAD"}^{commit}`)
    : git(repo, "rev-parse", "HEAD"));
  const resolvedReady = ready ?? readyPlan(state, plan, { context: ctx, host: resolvedHost, base, now });
  const decoupling = analyzeDecoupling({ plan, product: repo, base: analysisBase, state });
  const coverage = reviewCoverage(plan, { window: win });
  const waveMap = computeWaves(plan);
  const pkgById = new Map(plan.packages.map(p => [p.id, p]));
  const pairOf = pairLookup(decoupling.pairs);
  const handoffById = new Map(handoffsOf(state, plan.phase).map(h => [h.id, h]));

  const landedActors = plan.packages.filter(p => p.role === "actor").flatMap(p => {
    const h = handoffById.get(p.handoff);
    return h?.product?.commit ? [{ id: p.id, handoff: h.id, wave: waveMap.get(p.id), base: h.product.base, commit: h.product.commit, changed: h.product.commit !== h.product.base }] : [];
  });
  const isMergedInto = (sha, target) => Boolean(target && gitOk(repo, "merge-base", "--is-ancestor", sha, target));
  const unmergedActors = landedActors.filter(a => a.changed && !isMergedInto(a.commit, base));
  const needsIntegration = unmergedActors.length > 0;
  const landedById = new Map(landedActors.map(a => [a.id, a]));
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
    batchActors.push({ id: row.id, handoff: row.handoff, role: "actor", wave: waveMap.get(row.id), files: pkg.files ?? [], command: dispatchCommand(ctx.cfg, plan.id, pkg) });
  }

  for (const row of sortedReady("critic")) {
    const pkg = pkgById.get(row.id);
    const targets = criticTargetsById.get(row.id) ?? [];
    const coveredChanged = targets.map(id => landedById.get(id)).filter(a => a?.changed);
    if (coveredChanged.length >= 2 && coveredChanged.some(a => !isMergedInto(a.commit, base))) continue;
    const peers = [...liveCritics, ...batchCritics.map(c => c.id)];
    if (peers.some(peerId => fileOverlap(pkg.files ?? [], pkgById.get(peerId)?.files ?? []) !== null)) continue;
    const pinnedBase = coveredChanged.length === 1 && !isMergedInto(coveredChanged[0].commit, base) ? coveredChanged[0].commit : null;
    batchCritics.push({ id: row.id, handoff: row.handoff, role: "critic", wave: waveMap.get(row.id), targets, files: pkg.files ?? [], command: dispatchCommand(ctx.cfg, plan.id, pkg, { base: pinnedBase }) });
  }

  const judgeBlockedReasons = [];
  if (plan.packages.some(p => p.role === "judge")) {
    for (const a of unmergedActors) judgeBlockedReasons.push(`landed actor ${a.id} (${a.handoff} @ ${a.commit.slice(0, 12)}) is not merged into integration base`);
    for (const c of coverage.critics) if (c.targets.length > 0 && !handoffById.has(c.handoff)) judgeBlockedReasons.push(`critic ${c.id} (${c.handoff}, covering ${c.targets.join(", ")}) has not recorded its handoff`);
    if (coverage.required && coverage.uncoveredActors.length > 0) judgeBlockedReasons.push(`uncovered actor package(s): ${coverage.uncoveredActors.join(", ")}`);
  }

  const waveBuckets = new Map();
  const packages = resolvedReady.packages.map(row => {
    const wave = waveMap.get(row.id), pkg = pkgById.get(row.id);
    const entry = { ...row, wave, files: pkg.files ?? [], ...(row.status === "ready" ? { dispatchCommand: dispatchCommand(ctx.cfg, plan.id, pkg, { base: row.role === "judge" ? base : null }) } : {}) };
    if (!waveBuckets.has(wave)) waveBuckets.set(wave, []);
    waveBuckets.get(wave).push(entry);
    return entry;
  });
  const waves = [...waveBuckets.entries()].sort((a, b) => a[0] - b[0]).map(([wave, list]) => ({ wave, packages: list }));

  return {
    plan: plan.id, scope: plan.scope, phase: plan.phase, revision: state.revision, base, analysisBase,
    decoupling, coverage, waves, packages,
    parallelBatch: { actors: batchActors, critics: batchCritics, blockedCoupling },
    landedActors, unmergedActors, needsIntegration,
    integrateCommand: needsIntegration ? nodeCommand("dispatch.mjs", "integrate", "--records", state.records, "--plan", plan.id, "--apply") : null,
    judgeBlockedReasons, host: resolvedHost,
  };
}

// SKILL.md#2b-planning-and-dispatch-f-0012-p-0006
export function checkLiveDispatchedOverlap({ cfg, state, role, round, step, owns, prepared }) {
  if (!["actor", "critic"].includes(role)) return null;
  const ownGlobs = (owns ?? []).flatMap(f => [f, `${f.replace(/\/$/, "")}/**`]);
  if (!ownGlobs.length) return null;
  for (const w of activePreparedFor(prepared, cfg.phase, handoffsOf(state, cfg.phase), idOf(round, step))) {
    const liveFiles = Array.isArray(w.dispatch?.files) ? w.dispatch.files : [];
    const overlap = liveFiles.length ? fileOverlap(ownGlobs, liveFiles) : null;
    if (overlap) return `G3 live writer overlap with dispatched ${w.id} (${w.dispatch.plan}/${w.dispatch.package}): ${overlap.left} overlaps ${overlap.right}`;
  }
  return null;
}

// SKILL.md#2b-planning-and-dispatch-f-0012-p-0006
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
  const byId = new Map(plan.packages.map(p => [p.id, p]));
  const batches = batchesFrom([...state.files], state.read);
  for (const need of pkg.needs ?? []) {
    if (byId.has(need)) {
      const dep = byId.get(need);
      if (!completed.has(dep.handoff)) errors.push(`G2 unmet dependency ${need} (${dep.handoff}) has no recorded handoff`);
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
        const peerPkg = (w.dispatch?.plan === plan.id && byId.get(w.dispatch.package)) || plan.packages.find(q => q.handoff === w.id) || null;
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

  if (role === "judge") {
    const handoffById = new Map(phaseHandoffs.map(h => [h.id, h]));
    for (const p of plan.packages) {
      if (p.role !== "actor") continue;
      const h = handoffById.get(p.handoff);
      if (h?.product?.commit && !gitOk(cfg.product, "merge-base", "--is-ancestor", h.product.commit, base)) {
        errors.push(`G7 judge join barrier: landed actor ${p.id} (${h.id} @ ${h.product.commit.slice(0, 12)}) is not an ancestor of --base ${base.slice(0, 12)}`);
      }
    }
    const cov = reviewCoverage(plan, { window: window ?? readPlanWindow(state, cfg.phase, round) });
    for (const c of cov.critics) if (c.targets.length > 0 && !completed.has(c.handoff)) errors.push(`G7 judge join barrier: scheduled critic ${c.id} (${c.handoff}) has no recorded handoff`);
    if (cov.required && cov.uncoveredActors.length > 0) errors.push(`G7 judge join barrier: actor package(s) lack critic coverage: ${cov.uncoveredActors.join(", ")}`);
  }

  const peerFiles = plan.packages.filter(p => p.id !== pkg.id).flatMap(p => p.files ?? []);
  return { ok: errors.length === 0, errors, plan, pkg, peerFiles, scopeFiles };
}

// SKILL.md#2b-planning-and-dispatch-f-0012-p-0006
export function integrateWave({ cfg, state, plan, wave = null, apply = false }) {
  const waveMap = computeWaves(plan);
  const planActors = plan.packages.filter(p => p.role === "actor" && (wave === null || waveMap.get(p.id) === wave));
  if (!planActors.length) return { ok: false, conflicts: [], message: `no actor packages in ${plan.id}${wave !== null ? ` wave ${wave}` : ""}` };
  const handoffById = new Map(handoffsOf(state, plan.phase).map(h => [h.id, h]));
  if (wave !== null) {
    const missing = planActors.filter(p => !handoffById.has(p.handoff)).map(p => `${p.id} (${p.handoff})`);
    if (missing.length) return { ok: false, conflicts: [], message: `wave ${wave} is incomplete; missing handoff(s): ${missing.join(", ")}` };
  }
  const landed = planActors.flatMap(p => {
    const h = handoffById.get(p.handoff);
    if (!h?.product?.commit || h.product.commit === h.product.base) return [];
    const files = git(cfg.product, "diff", "--name-only", `${h.product.base}..${h.product.commit}`).split("\n").filter(Boolean);
    return [{ id: p.id, handoff: h.id, wave: waveMap.get(p.id), base: h.product.base, commit: h.product.commit, files }];
  });
  if (!landed.length) return { ok: false, conflicts: [], message: `no landed actor commits to integrate for ${plan.id}${wave !== null ? ` wave ${wave}` : ""}` };
  const conflicts = [];
  for (let i = 0; i < landed.length; i++) {
    const aSet = new Set(landed[i].files);
    for (let j = i + 1; j < landed.length; j++) {
      const shared = landed[j].files.filter(f => aSet.has(f));
      if (shared.length) conflicts.push({ left: landed[i].id, right: landed[j].id, files: shared });
    }
  }
  if (conflicts.length) {
    return { ok: false, disjoint: false, conflicts, commits: landed, message: `overlapping modified files across wave actors: ${conflicts.map(c => `${c.left}/${c.right}: ${c.files.join(", ")}`).join("; ")}` };
  }

  const branchRef = cfg.branch && !(cfg.protected ?? []).includes(cfg.branch)
    && gitOk(cfg.product, "show-ref", "--verify", "--quiet", `refs/heads/${cfg.branch}`) ? cfg.branch : null;
  const branchHead = branchRef ? git(cfg.product, "rev-parse", `refs/heads/${branchRef}`) : null;
  const candidates = [...new Set([...(branchHead ? [branchHead] : []), ...landed.map(a => a.commit)])];
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

// SKILL.md#2b-planning-and-dispatch-f-0012-p-0006
export function renderDispatchLines(dp) {
  const lines = [`Plan ${dp.plan} (${dp.scope}) · review topology: ${dp.coverage.topology} · decoupled pairs: ${dp.decoupling.decoupledCount}, undeclared-coupled: ${dp.decoupling.undeclaredCoupled.length}, write-coupled: ${dp.decoupling.writeCoupled.length}`];
  if (dp.parallelBatch.actors.length) {
    lines.push(`Parallel actor batch (${dp.parallelBatch.actors.length}): ${dp.parallelBatch.actors.map(a => `${a.id}[w${a.wave}]`).join(", ")}`, ...dp.parallelBatch.actors.map(a => `  ${a.command}`));
  }
  for (const b of dp.parallelBatch.blockedCoupling) lines.push(`Coupling guard blocked ${b.id} against ${b.peer}: ${b.edges.map(e => `${e.from} -> ${e.to}`).join(", ")}`);
  if (dp.needsIntegration && dp.integrateCommand) lines.push(`Wave integration needed (${dp.unmergedActors.map(a => `${a.id}@${a.commit.slice(0, 12)}`).join(", ")}):`, `  ${dp.integrateCommand}`);
  if (dp.parallelBatch.critics.length) {
    lines.push(`Parallel critic batch (${dp.parallelBatch.critics.length}, topology ${dp.coverage.topology}): ${dp.parallelBatch.critics.map(c => `${c.id}[w${c.wave}]`).join(", ")}`, ...dp.parallelBatch.critics.map(c => `  ${c.command}`));
  }
  if (dp.judgeBlockedReasons.length) lines.push(`Judge join barrier: ${dp.judgeBlockedReasons.join("; ")}`);
  return lines;
}
