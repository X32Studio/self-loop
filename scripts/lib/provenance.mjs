// D-0060, D-0062, D-0064, D-0068, design/mandatory-control-plane.md#1, design/paseo-and-judge-policy.md#1
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseRows, TRAJECTORY } from "../trajectory.mjs";
import { JUDGE_FRAME_STEP } from "./cadence.mjs";
import { criticContradictedByTrajectory, criticConvergedAccepted, judgeAccepted } from "./ci.mjs";
import { HANDOFFS, validateHandoff } from "./handoff.mjs";
import { recordsSnapshot } from "./records-commit.mjs";
import { priorConvergedCommits, unjudgedCoveringActors, validateJudgeIndependence, validateModelVendors, waveIndependenceProblem } from "./vendor.mjs";
import { parseWindows, WINDOWS, windowState } from "./window-state.mjs";

export const DEFAULT_LEAD_PATHS = Object.freeze(["VERSION", "docs/", "AGENTS.md", "CLAUDE.md", "README.md"]);

const ORIGINAL = "--no-replace-objects";
const SHA = /^[0-9a-f]{40}$/;
const ZERO_SHA = /^0+$/;
const SHA_IN_TEXT = /\b[0-9a-f]{40}\b/g;
const PLAN_ID = /^PL-\d{4}$/;
const CI_BRANCH = /^ci\/(R-\d{4}-[a-z0-9-]+)$/;
const PASSING_SUITE = /^[1-9]\d*\/0$/;

const gitRun = (repo, ...argv) => spawnSync("git", ["-C", repo, ORIGINAL, ...argv], { encoding: "utf8", maxBuffer: 1 << 26 });
const gitOut = (repo, ...argv) => { const r = gitRun(repo, ...argv); return r.status === 0 ? r.stdout.trim() : null; };
const gitLines = (repo, ...argv) => { const r = gitRun(repo, ...argv); return r.status === 0 ? r.stdout.split("\n").filter(Boolean) : null; };
const treeOf = (repo, rev) => gitOut(repo, "rev-parse", "--verify", "--quiet", `${rev}^{tree}`);
const commitOf = (repo, rev) => gitOut(repo, "rev-parse", "--verify", "--quiet", `${rev}^{commit}`);
const parentsOf = (repo, sha) => { const raw = gitOut(repo, "show", "-s", "--format=%P", sha); return raw === null ? null : raw.split(/\s+/).filter(Boolean); };
const isAncestor = (repo, anc, desc) => anc === desc || gitRun(repo, "merge-base", "--is-ancestor", anc, desc).status === 0;
const matchesLeadPath = (path, leadPaths) => leadPaths.some(rule => (rule.endsWith("/") ? path.startsWith(rule) : path === rule));
const toSet = items => (items instanceof Set ? items : new Set(items ?? []));
const hasValidPlan = (h, files) => Boolean(h.dispatch?.plan && PLAN_ID.test(h.dispatch.plan) && files.has(`plans/${h.dispatch.plan}.md`));
const relPath = p => typeof p === "string" && p.length > 0 && !p.startsWith("/") && !p.split("/").includes("..");

export function validateLeadPatchHandoff(h) {
  const fail = m => { throw new Error(m); };
  if (!h || typeof h !== "object" || Array.isArray(h)) fail("not an object");
  if (h.role !== "lead-patch") fail("role must be lead-patch");
  if (typeof h.id !== "string" || !h.id.trim()) fail("id is missing");
  if (typeof h.phase !== "string" || !h.phase.trim() || /[\n\t]/.test(h.phase)) fail("phase must be a one-line name");
  if (!h.product || !SHA.test(h.product.base ?? "") || !SHA.test(h.product.commit ?? "") || h.product.commit === h.product.base)
    fail("product must carry distinct base and commit full SHAs");
  if (!Array.isArray(h.files) || !h.files.length || h.files.length > 3 || !h.files.every(relPath))
    fail("files must be 1..3 relative paths");
  if (typeof h.reason !== "string" || !h.reason.trim()) fail("reason is missing");
  if (!h.verify || typeof h.verify.command !== "string" || !h.verify.command.trim() || h.verify.exit !== 0)
    fail("verify must record command and exit 0");
  if (!h.audit || h.audit.violations !== 0) fail("audit.violations must be 0");
  return h;
}

export function parseProvenanceHandoffs(text) {
  return text.split("\n").filter(Boolean).map((line, i) => {
    try {
      const obj = JSON.parse(line);
      return obj?.role === "lead-patch" ? validateLeadPatchHandoff(obj) : validateHandoff(obj);
    } catch (e) {
      throw new Error(`${HANDOFFS}:${i + 1}: not a valid hand-off (${e.message})`);
    }
  });
}

const isAttestedLeadPatch = h => h?.role === "lead-patch"
  && h.audit?.violations === 0
  && h.verify?.exit === 0
  && SHA.test(h.product?.base ?? "")
  && SHA.test(h.product?.commit ?? "")
  && h.product.commit !== h.product.base;

const sharedSessionActor = (reviewer, actors) => (
  reviewer?.agent?.session
    ? (actors ?? []).find(a => a?.agent?.session && a.agent.session === reviewer.agent.session) ?? null
    : null
);
const attestedRoleCommits = (handoffs, files) => new Set(handoffs.filter(h => (
  ((h.role === "actor" || h.role === "critic") && h.product?.commit && h.product.commit !== h.product.base && files.has(h.record) && h.audit?.violations === 0 && hasValidPlan(h, files))
  || isAttestedLeadPatch(h)
)).map(h => h.product.commit));

function readLoopConfig({ cfg = null, records = null, snap = null } = {}) {
  let fromRecords = null;
  if (records) {
    try {
      const committed = (snap ?? recordsSnapshot(records)).read("loop.json");
      if (committed) fromRecords = JSON.parse(committed);
      else if (existsSync(join(records, "loop.json"))) fromRecords = JSON.parse(readFileSync(join(records, "loop.json"), "utf8"));
    } catch { fromRecords = null; }
  }
  return fromRecords || cfg ? { ...(fromRecords ?? {}), ...(cfg ?? {}) } : {};
}

export function readProvenanceBaseline({ cfg = null, records = null } = {}) {
  const merged = readLoopConfig({ cfg, records });
  return SHA.test(merged.provenanceBaseline ?? "") ? merged.provenanceBaseline : null;
}

export function isLeadOnlyCommit(repo, sha, leadPaths = DEFAULT_LEAD_PATHS) {
  const full = commitOf(repo, sha);
  if (!full || !Array.isArray(leadPaths) || !leadPaths.length) return false;
  const parents = parentsOf(repo, full);
  if (!parents || parents.length > 1) return false;
  const r = gitRun(repo, "diff-tree", "--no-commit-id", "--no-renames", "--name-only", "-r", "--root", "-z", full);
  if (r.status !== 0) return false;
  const changed = r.stdout.split("\0").filter(Boolean);
  return changed.length > 0 && changed.every(path => matchesLeadPath(path, leadPaths));
}

export function isCleanWaveMerge(repo, sha, attestedShas) {
  const full = commitOf(repo, sha);
  const parents = full ? parentsOf(repo, full) : null;
  const allowed = toSet(attestedShas);
  const actualTree = full ? treeOf(repo, full) : null;
  if (!parents || parents.length < 2 || !actualTree || !parents.every(p => allowed.has(p))) return false;
  let acc = parents[0];
  for (let i = 1; i < parents.length; i++) {
    const merged = gitRun(repo, "merge-tree", "--write-tree", acc, parents[i]);
    if (merged.status !== 0) return false;
    const tree = merged.stdout.split("\n")[0].trim();
    if (i + 1 === parents.length) return tree === actualTree;
    const fold = gitRun(repo, "commit-tree", tree, "-p", acc, "-p", parents[i], "-m", "self-loop: provenance merge-tree fold");
    if (fold.status !== 0) return false;
    acc = fold.stdout.trim();
  }
  return false;
}

export function isExactRevertOfAttested(repo, sha, attestedShas) {
  const full = commitOf(repo, sha);
  const parents = full ? parentsOf(repo, full) : null;
  if (!parents || parents.length !== 1) return false;
  const [parent] = parents;
  const actualTree = treeOf(repo, full), parentTree = treeOf(repo, parent);
  const allowed = toSet(attestedShas);
  if (!actualTree || !parentTree || actualTree === parentTree || !allowed.size) return false;
  const body = gitOut(repo, "show", "-s", "--format=%B", full) ?? "";
  const hinted = [...new Set(body.match(SHA_IN_TEXT) ?? [])].filter(id => id !== full && allowed.has(id));
  const candidates = [...hinted, ...[...allowed].filter(id => id !== full && !hinted.includes(id))];
  for (const target of candidates) {
    if (!isAncestor(repo, target, parent)) continue;
    for (const tp of parentsOf(repo, target) ?? []) {
      if (target === parent) {
        if (treeOf(repo, tp) === actualTree) return true;
      } else {
        const rev = gitRun(repo, "merge-tree", "--write-tree", `--merge-base=${target}`, parent, tp);
        if (rev.status === 0 && rev.stdout.split("\n")[0].trim() === actualTree) return true;
      }
    }
  }
  return false;
}

function readGitBlobs(repo, specs) {
  if (!specs.length) return [];
  const r = spawnSync("git", ["-C", repo, ORIGINAL, "cat-file", "--batch"], { input: `${specs.join("\n")}\n`, maxBuffer: 1 << 26 });
  if (r.status !== 0 || !Buffer.isBuffer(r.stdout)) return specs.map(() => null);
  const out = r.stdout, res = [];
  for (let i = 0, at = 0; i < specs.length; i++) {
    const nl = out.indexOf(10, at);
    if (nl < 0) { res.push(null); continue; }
    const header = out.subarray(at, nl).toString("utf8");
    if (header.endsWith(" missing") || header.endsWith(" ambiguous")) { res.push(null); at = nl + 1; continue; }
    const [, type, size] = header.split(" "), n = Number(size), start = nl + 1;
    res.push(type === "blob" ? out.subarray(start, start + n).toString("utf8") : null);
    at = start + n + 1;
  }
  return res;
}

function blamedCommits(repo, revision, path) {
  const r = gitRun(repo, "blame", "--porcelain", revision, "--", path);
  if (r.status !== 0) return null;
  const res = [];
  for (let sha = null, lines = r.stdout.split("\n"), i = 0; i < lines.length; i++) {
    const m = /^([0-9a-f]{40}) \d+ \d+/.exec(lines[i]);
    if (m) sha = m[1]; else if (lines[i].startsWith("\t") && lines[i].length > 1) res.push(sha);
  }
  return res;
}

function effectiveJudgedCommit(repo, sha, baseline, leadPaths, stopCommits = null) {
  let cur = commitOf(repo, sha) ?? sha;
  while (cur && cur !== baseline && !stopCommits?.has(cur) && isLeadOnlyCommit(repo, cur, leadPaths)) {
    const parents = parentsOf(repo, cur);
    if (!parents || parents.length !== 1) break;
    cur = parents[0];
  }
  return cur;
}

function makeHistoricalPolicyResolver({ records, revision, files, allHandoffs, allRows, currentPolicy }) {
  const handoffIdx = new Map((allHandoffs ?? []).map((h, i) => [h, i])), rowIdx = new Map((allRows ?? []).map((r, i) => [r, i]));
  const hasRevLoop = files ? files.has("loop.json") : Boolean(records && revision && gitRun(records, "cat-file", "-e", `${revision}:loop.json`).status === 0);
  const policyCache = new Map(), real = c => (c && SHA.test(c) && !ZERO_SHA.test(c) ? c : null);
  let handoffCommits, rowCommits;
  const parsePolicy = text => {
    if (text === null) return { present: false, ok: false, policy: null };
    try {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { present: true, ok: false, policy: null };
      const v = validateJudgeIndependence(parsed.judgeIndependence);
      return { present: true, ok: v.ok, policy: v.policy };
    } catch { return { present: true, ok: false, policy: null }; }
  };
  const prime = () => {
    if (handoffCommits !== undefined) return;
    handoffCommits = files && !files.has(HANDOFFS) ? null : blamedCommits(records, revision, HANDOFFS);
    rowCommits = files && !files.has(TRAJECTORY) ? null : blamedCommits(records, revision, TRAJECTORY);
    const list = [...new Set([
      ...(allHandoffs ?? []).flatMap((h, i) => (h.role === "judge" || h.role === "critic") ? [real(handoffCommits?.[i]), real(h.view)] : []),
      ...(allRows ?? []).map((r, i) => (r.role === "judge" || r.role === "critic") ? real(rowCommits?.[i]) : null),
    ].filter(Boolean))];
    readGitBlobs(records, list.map(s => `${s}:loop.json`)).forEach((t, i) => policyCache.set(list[i], parsePolicy(t)));
  };
  return (pr, pj) => {
    if (!records || !revision) return [currentPolicy];
    prime();
    const jIdx = pj ? handoffIdx.get(pj) : undefined, rIdx = pr ? rowIdx.get(pr) : undefined;
    if ((jIdx !== undefined && files?.has(HANDOFFS) && !handoffCommits) || (rIdx !== undefined && files?.has(TRAJECTORY) && !rowCommits)) return null;
    const required = [...new Set([real(handoffCommits?.[jIdx]), real(rowCommits?.[rIdx])].filter(Boolean))];
    if (!required.length) return [currentPolicy];
    const reqEntries = required.map(s => policyCache.get(s) ?? { present: false, ok: false, policy: null });
    if (reqEntries.every(e => !e.present)) return hasRevLoop ? null : [currentPolicy];
    if (reqEntries.some(e => !e.present || !e.ok)) return null;
    const policies = [...new Set(reqEntries.map(e => e.policy))], viewSha = real(pj?.view);
    const ve = viewSha && !required.includes(viewSha) ? policyCache.get(viewSha) : null;
    if (ve?.present) { if (!ve.ok) return null; if (!policies.includes(ve.policy)) policies.push(ve.policy); }
    return policies;
  };
}

export function evaluateCertifiedWaveCoverage({
  repo, records = null, revision = "HEAD", snap = null, files = null, read = null, cfg = null, phase = null,
  targetCommit, targetRuling = null, judge = null, judges = null, critics = null, actors = null, rows = null, allHandoffs = null,
  allRows = null, isAncestor: ancFn = null, requireActor = true, leadPaths = null, allowPreTrajectoryPriors = false,
  criticAllows = null, evaluateJudge = true,
}) {
  const resolvedSnap = snap ?? (!files && records ? recordsSnapshot(records, revision) : null);
  const fileSet = files ?? resolvedSnap?.files ?? new Set(), readFile = read ?? resolvedSnap?.read ?? (() => "");
  const merged = readLoopConfig({ cfg, records, snap: { read: readFile } }), pol = validateJudgeIndependence(merged.judgeIndependence);
  if (!pol.ok) return { ok: false, policy: null, baseline: null, judgedCommit: targetCommit, priorConverged: [], actors: [], problem: pol.error };
  const mv = validateModelVendors(merged.modelVendors);
  if (!mv.ok) return { ok: false, policy: null, baseline: null, judgedCommit: targetCommit, priorConverged: [], actors: [], problem: mv.error };
  const modelVendors = mv.vendors;
  const baseline = SHA.test(merged.provenanceBaseline ?? "") && commitOf(repo, merged.provenanceBaseline) ? merged.provenanceBaseline : null;
  const effLeadPaths = Array.isArray(leadPaths) ? leadPaths : (Array.isArray(merged.leadPaths) ? merged.leadPaths : DEFAULT_LEAD_PATHS);
  const isAnc = typeof ancFn === "function" ? ancFn : ((a, b) => isAncestor(repo, a, b)), effPhase = phase ?? merged.phase ?? null;
  const fullHandoffs = allHandoffs ?? (fileSet.has(HANDOFFS) ? parseProvenanceHandoffs(readFile(HANDOFFS)) : []);
  const fullRows = allRows ?? (fileSet.has(TRAJECTORY) ? parseRows(readFile(TRAJECTORY)) : []);
  const scopedJudges = judges ?? fullHandoffs.filter(h => (!effPhase || h.phase === effPhase) && h.role === "judge" && !JUDGE_FRAME_STEP.test(h.step) && fileSet.has(h.record));
  const scopedCritics = critics ?? fullHandoffs.filter(h => (!effPhase || h.phase === effPhase) && h.role === "critic" && fileSet.has(h.record) && (!baseline || hasValidPlan(h, fileSet)));
  const scopedActors = actors ?? fullHandoffs.filter(h => (!effPhase || h.phase === effPhase) && h.role === "actor" && h.product?.commit && fileSet.has(h.record));
  const scopedRows = rows ?? (effPhase ? fullRows.filter(r => r.phase === effPhase) : fullRows);
  const accept = j => judgeAccepted(j, { has: p => fileSet.has(p), read: readFile });
  const acceptCritic = c => criticConvergedAccepted(c, { has: p => fileSet.has(p), read: readFile });
  const stopCommits = new Set([
    ...fullHandoffs.filter(h => (!effPhase || h.phase === effPhase) && (h.role === "actor" || h.role === "critic") && h.product?.commit && h.product.commit !== h.product.base && (!fileSet.size || fileSet.has(h.record))).map(h => h.product.commit),
    ...fullHandoffs.filter(h => (!effPhase || h.phase === effPhase) && isAttestedLeadPatch(h)).map(h => h.product.commit),
    ...scopedActors.filter(a => a.product?.commit && a.product.commit !== a.product.base).map(a => a.product.commit),
    ...scopedJudges.filter(accept).map(j => j.product?.commit ?? j.product?.base).filter(Boolean),
    ...scopedCritics.filter(acceptCritic).map(c => c.product?.commit ?? c.product?.base).filter(Boolean),
    ...scopedRows.filter(r => ((r.role === "judge" && r.verdict === "CONVERGED") || (r.role === "critic" && (r.verdict === "CONVERGED" || r.verdict === "PASS"))) && SHA.test(r.commit ?? "")).map(r => r.commit),
  ]);
  const judgedCommit = effectiveJudgedCommit(repo, targetCommit, baseline, effLeadPaths, stopCommits);
  const resolvePolicies = makeHistoricalPolicyResolver({ records, revision: resolvedSnap?.head ?? revision, files: fileSet, allHandoffs: fullHandoffs, allRows: fullRows, currentPolicy: pol.policy });
  const priorCritics = scopedCritics.filter(ch => {
    if (!acceptCritic(ch)) return false;
    const c = ch.product?.commit ?? ch.product?.base;
    return Boolean(c && c !== judgedCommit && isAnc(c, judgedCommit) && !criticContradictedByTrajectory(scopedRows, ch, [c]));
  });
  const criticRows = priorCritics.map(ch => ({
    round: ch.round, role: "judge", verdict: "CONVERGED", commit: ch.product?.commit ?? ch.product?.base, suite: "1/0", criticCertId: ch.id,
  }));
  const judgeRows = allowPreTrajectoryPriors ? [...scopedRows, ...scopedJudges.flatMap(jh => {
    const c = jh.product?.commit ?? jh.product?.base;
    return c && c !== judgedCommit && isAnc(c, judgedCommit) && !scopedRows.some(r => r.role === "judge" && r.round === jh.round && r.commit === c)
      ? [{ round: jh.round, role: "judge", verdict: "CONVERGED", commit: c, suite: "1/0", preTrajectory: true }] : [];
  })] : scopedRows;
  const priorAccepted = (pj, pr, priors) => {
    if (pr.criticCertId) {
      if (pj.role !== "critic" || pj.id !== pr.criticCertId || !acceptCritic(pj)) return false;
      const waveActors = unjudgedCoveringActors({ actors: scopedActors, targetCommit: pr.commit, priorConvergedCommits: priors, isAncestor: isAnc, baseline });
      if (sharedSessionActor(pj, waveActors)) return false;
      if (waveActors.some(a => !pj.product?.base || !isAnc(a.product.commit, pj.product.base))) return false;
      return !criticAllows || criticAllows(pr.commit, priors);
    }
    return pj.role === "judge" && accept(pj) && (!criticAllows || criticAllows(pr.commit, priors));
  };
  const priorConverged = priorConvergedCommits({
    rows: [...judgeRows, ...criticRows], judges: [...scopedJudges, ...priorCritics], actors: scopedActors, targetCommit: judgedCommit, targetRuling, targetJudge: judge,
    isAncestor: isAnc, policy: pol.policy, baseline, modelVendors,
    judgeAccepted: priorAccepted,
    rulingPolicies: (pr, pj) => resolvePolicies(pr?.preTrajectory || pr?.criticCertId ? null : pr, pj),
  });
  const covering = unjudgedCoveringActors({ actors: scopedActors, targetCommit: judgedCommit, priorConvergedCommits: priorConverged, isAncestor: isAnc, baseline });
  const shared = evaluateJudge ? sharedSessionActor(judge, covering) : null;
  const problem = !evaluateJudge ? null
    : shared ? `${judge.role ?? "judge"} ${judge.id} shares session with actor ${shared.id}`
    : waveIndependenceProblem({ judge, actors: covering, policy: pol.policy, requireActor, modelVendors });
  return { ok: problem === null, policy: pol.policy, baseline, judgedCommit, priorConverged, actors: covering, problem };
}

function criticCoversActor(repo, critic, actor, targetSha, unjudgedSet) {
  if (!critic.product?.base || !critic.product?.commit) return false;
  if (isAncestor(repo, actor.product.commit, critic.product.base) && isAncestor(repo, critic.product.commit, targetSha)) return true;
  return Boolean(critic.dispatch?.plan && critic.dispatch.plan === actor.dispatch?.plan && critic.product.commit !== critic.product.base
    && unjudgedSet.has(critic.product.commit) && isAncestor(repo, critic.product.commit, actor.product.commit));
}

function evaluateWaveGate({ repo, records, snap, handoffs, rows, windows, commits, leadOnlySet, baseline, full, branch, cfg, leadPaths }) {
  const pol = validateJudgeIndependence(cfg?.judgeIndependence);
  if (!pol.ok) return { required: true, ok: false, missing: ["judgeIndependence"], reasons: [pol.error] };
  const mv = validateModelVendors(cfg?.modelVendors);
  if (!mv.ok) return { required: true, ok: false, missing: ["modelVendors"], reasons: [mv.error] };
  const modelVendors = mv.vendors;
  const ciMatch = typeof branch === "string" ? CI_BRANCH.exec(branch) : null;
  const isProtected = Boolean(branch && Array.isArray(cfg?.protected) && cfg.protected.includes(branch));
  const isWorking = Boolean(branch && cfg?.branch && branch === cfg.branch);
  if (!ciMatch && !isProtected && !isWorking) return { required: false, ok: true, missing: [], reasons: [] };

  const phase = cfg?.phase ?? null, commitSet = new Set(commits);
  const scopedHandoffs = handoffs.filter(h => (!phase || h.phase === phase) && snap.files.has(h.record) && h.audit?.violations === 0);
  const scopedRows = phase ? rows.filter(r => r.phase === phase) : rows;
  const actorsInRange = scopedHandoffs.filter(h => h.role === "actor" && h.product?.commit && commitSet.has(h.product.commit) && hasValidPlan(h, snap.files));
  const critics = scopedHandoffs.filter(h => h.role === "critic" && hasValidPlan(h, snap.files));
  const judges = scopedHandoffs.filter(h => h.role === "judge" && !JUDGE_FRAME_STEP.test(h.step));
  const criticAllows = (c, priors) => {
    const unjudgedAtC = new Set(commits.filter(x => isAncestor(repo, x, c) && !priors.some(j => isAncestor(repo, x, j))));
    return actorsInRange.filter(a => unjudgedAtC.has(a.product.commit)).every(a => critics.some(cr => criticCoversActor(repo, cr, a, c, unjudgedAtC)));
  };
  const cov = evaluateCertifiedWaveCoverage({
    repo, records, snap, cfg, phase, targetCommit: full, judges, critics, actors: actorsInRange, rows: scopedRows,
    allHandoffs: handoffs, allRows: rows, leadPaths, allowPreTrajectoryPriors: !isProtected, criticAllows, evaluateJudge: false,
  });
  const { judgedCommit, priorConverged } = cov;
  const judgeErrors = [], unjudgedAtTip = new Set(commits.filter(x => isAncestor(repo, x, judgedCommit) && !priorConverged.some(j => isAncestor(repo, x, j))));
  let tipJudged = false;
  for (const jh of judges.filter(j => j.product?.base === judgedCommit || j.product?.commit === judgedCommit || (judgedCommit !== full && (j.product?.base === full || j.product?.commit === full)))) {
    if (!judgeAccepted(jh, { has: p => snap.files.has(p), read: snap.read })) { judgeErrors.push(`judge ${jh.id} lacks sealed CONVERGED/pass ruling on ${judgedCommit.slice(0, 12)}`); continue; }
    if (scopedRows.some(r => r.role === "judge" && r.round === jh.round && (r.commit === judgedCommit || r.commit === full) && (r.verdict !== "CONVERGED" || !PASSING_SUITE.test(r.suite ?? "")))) {
      judgeErrors.push(`trajectory row for judge ${jh.id} on ${judgedCommit.slice(0, 12)} is not CONVERGED`);
      continue;
    }
    const shared = sharedSessionActor(jh, cov.actors);
    if (shared) { judgeErrors.push(`judge ${jh.id} shares session with actor ${shared.id}`); continue; }
    const vErr = waveIndependenceProblem({ judge: jh, actors: cov.actors, policy: pol.policy, requireActor: false, modelVendors });
    if (vErr) { judgeErrors.push(vErr); continue; }
    const uncovered = actorsInRange.filter(a => unjudgedAtTip.has(a.product.commit) && !critics.some(cr => criticCoversActor(repo, cr, a, judgedCommit, unjudgedAtTip)));
    if (uncovered.length) { judgeErrors.push(`missing critic covering ${uncovered.map(a => a.id).join(", ")}`); continue; }
    tipJudged = true;
    break;
  }
  if (!tipJudged) {
    const tipCritics = critics.filter(c =>
      c.product?.base === judgedCommit || c.product?.commit === judgedCommit
      || (judgedCommit !== full && (c.product?.base === full || c.product?.commit === full)));
    for (const ch of tipCritics) {
      if (!criticConvergedAccepted(ch, { has: p => snap.files.has(p), read: snap.read })) continue;
      if (criticContradictedByTrajectory(scopedRows, ch, [judgedCommit, full])) {
        judgeErrors.push(`trajectory row contradicts critic ${ch.id} on ${judgedCommit.slice(0, 12)}`);
        continue;
      }
      const shared = sharedSessionActor(ch, cov.actors);
      if (shared) { judgeErrors.push(`critic ${ch.id} shares session with actor ${shared.id}`); continue; }
      const vErr = waveIndependenceProblem({ judge: ch, actors: cov.actors, policy: pol.policy, requireActor: false, modelVendors });
      if (vErr) { judgeErrors.push(vErr); continue; }
      const unjudgedActors = actorsInRange.filter(a => unjudgedAtTip.has(a.product.commit));
      const stale = unjudgedActors.filter(a => !ch.product?.base || !isAncestor(repo, a.product.commit, ch.product.base));
      if (stale.length) { judgeErrors.push(`critic ${ch.id} base misses actor(s) ${stale.map(a => a.id).join(", ")}`); continue; }
      const coverTarget = ch.product?.base === full || ch.product?.commit === full ? full : judgedCommit;
      const uncovered = unjudgedActors.filter(a => !critics.some(cr => criticCoversActor(repo, cr, a, coverTarget, unjudgedAtTip)));
      if (uncovered.length) { judgeErrors.push(`missing critic covering ${uncovered.map(a => a.id).join(", ")}`); continue; }
      tipJudged = true;
      break;
    }
  }

  const validJudged = tipJudged ? [...priorConverged, judgedCommit] : priorConverged;
  const unjudgedCommits = commits.filter(c => !validJudged.some(j => isAncestor(repo, c, j)));
  const unjudgedNonLead = unjudgedCommits.filter(c => !leadOnlySet.has(c)), unjudgedSet = new Set(unjudgedCommits);
  const waveActors = actorsInRange.filter(a => unjudgedSet.has(a.product.commit));
  const uncoveredActors = waveActors.filter(a => !critics.some(cr => criticCoversActor(repo, cr, a, full, unjudgedSet)));
  const hasAnyCritic = critics.some(cr => cr.product?.commit && isAncestor(repo, cr.product.commit, full));

  if (ciMatch) {
    const refId = ciMatch[1], missing = [], reasons = [], refHandoff = scopedHandoffs.find(h => h.id === refId);
    if (!refHandoff) { missing.push(`handoff:${refId}`); reasons.push(`wave gate on ${branch}: referenced handoff ${refId} is not recorded in ${HANDOFFS}`); }
    else if (refHandoff.product?.commit && !isAncestor(repo, refHandoff.product.commit, full)) {
      missing.push(`ancestor:${refId}`);
      reasons.push(`wave gate on ${branch}: ${full.slice(0, 12)} does not descend from ${refId} (${refHandoff.product.commit.slice(0, 12)})`);
    }
    if (unjudgedNonLead.length) {
      if (!waveActors.length && refHandoff?.role !== "critic") { missing.push("actor"); reasons.push(`wave gate on ${branch}: missing covering PL-NNNN actor handoff for ${full.slice(0, 12)}`); }
      if (uncoveredActors.length || (!waveActors.length && !hasAnyCritic)) { missing.push("critic"); reasons.push(`wave gate on ${branch}: missing covering critic handoff for ${uncoveredActors.map(a => a.id).join(", ") || full.slice(0, 12)}`); }
    }
    return { required: true, ok: missing.length === 0, missing, reasons };
  }
  if (!unjudgedNonLead.length) return { required: true, ok: true, missing: [], reasons: [] };
  const win = phase && windows.length ? windowState({ windows, handoffs: scopedHandoffs, rows: scopedRows, phase }) : null;
  if (!isProtected && win?.active && (win.mode === "slack" || win.mode === "converging")) {
    return { required: true, ok: true, deferredByWindow: win.active.id, windowMode: win.mode, missing: [], reasons: [] };
  }
  const missing = [], reasons = [];
  if (win?.active && win.gateDue) reasons.push(`window ${win.active.id} is gate-due (horizon ${win.active.horizon} reached)`);
  if (uncoveredActors.length || (!waveActors.length && !hasAnyCritic)) {
    missing.push("critic");
    reasons.push(`wave gate on ${branch}: missing covering critic handoff for ${uncoveredActors.map(a => a.id).join(", ") || full.slice(0, 12)}`);
  }
  missing.push("judge");
  const modeLabel = pol.policy === "session" ? "independent-session" : pol.policy === "model" ? "independent-model" : "cross-vendor";
  reasons.push(judgeErrors.length ? `wave gate on ${branch}: ${judgeErrors.join("; ")}`
    : `wave gate on ${branch}: missing ${modeLabel} judge (CONVERGED/pass) or independent no-dispute critic (PASS/CONVERGED) covering ${full.slice(0, 12)} above ${baseline.slice(0, 12)}`);
  return { required: true, ok: false, missing, reasons };
}

export function verifyWaveGate({ repo, records, sha, branch, cfg = null }) {
  const full = commitOf(repo, sha);
  if (!full) return { required: true, ok: false, missing: ["commit"], reasons: [`${sha} is not a commit in ${repo}`] };
  const snap = records ? recordsSnapshot(records) : null, merged = readLoopConfig({ cfg, records, snap });
  const pol = validateJudgeIndependence(merged.judgeIndependence);
  if (!pol.ok) return { required: true, ok: false, missing: ["judgeIndependence"], reasons: [pol.error] };
  const mv = validateModelVendors(merged.modelVendors);
  if (!mv.ok) return { required: true, ok: false, missing: ["modelVendors"], reasons: [mv.error] };
  const baseline = SHA.test(merged.provenanceBaseline ?? "") ? merged.provenanceBaseline : null;
  if (!baseline || full === baseline || isAncestor(repo, full, baseline)) return { required: false, ok: true, missing: [], reasons: [] };
  if (!snap) return { required: true, ok: false, missing: ["records"], reasons: ["provenance wave gate requires records repository"] };
  const commits = gitLines(repo, "rev-list", "--topo-order", "--reverse", `${baseline}..${full}`) ?? [];
  const leadPaths = Array.isArray(merged.leadPaths) ? merged.leadPaths : DEFAULT_LEAD_PATHS;
  const handoffs = snap.files.has(HANDOFFS) ? parseProvenanceHandoffs(snap.read(HANDOFFS)) : [];
  const attested = attestedRoleCommits(handoffs, snap.files);
  const leadOnlySet = new Set(commits.filter(c => !attested.has(c) && isLeadOnlyCommit(repo, c, leadPaths)));
  return evaluateWaveGate({
    repo, records, snap, commits, leadOnlySet, baseline, full, branch, cfg: merged, leadPaths, handoffs,
    rows: snap.files.has(TRAJECTORY) ? parseRows(snap.read(TRAJECTORY)) : [],
    windows: snap.files.has(WINDOWS) ? parseWindows(snap.read(WINDOWS), WINDOWS) : [],
  });
}

export function verifyProvenance({ repo, records, sha, branch = null, cfg = null, mode = "push" }) {
  const emptyWave = { required: false, ok: true, missing: [] };
  const result = (ok, fields) => ({ ok, enforced: true, mode, sha: String(sha), baseline: null, unattested: [], waveGate: emptyWave, reasons: [], ...fields });
  const full = commitOf(repo, sha);
  if (!full) return result(false, { reasons: [`${sha} is not a commit in ${repo}`] });
  let snap = null;
  if (records) {
    try { snap = recordsSnapshot(records); }
    catch (e) { return result(false, { sha: full, reasons: [`cannot read records ${records}: ${e.message}`] }); }
  }
  const merged = readLoopConfig({ cfg, records, snap }), pol = validateJudgeIndependence(merged.judgeIndependence);
  if (!pol.ok) return result(false, { sha: full, reasons: [pol.error] });
  const mv = validateModelVendors(merged.modelVendors);
  if (!mv.ok) return result(false, { sha: full, reasons: [mv.error] });
  if (merged.provenanceBaseline === undefined || merged.provenanceBaseline === null) return result(true, { enforced: false, sha: full });
  if (!SHA.test(merged.provenanceBaseline)) return result(false, { sha: full, reasons: [`invalid provenanceBaseline ${JSON.stringify(merged.provenanceBaseline)}`] });
  const baseline = merged.provenanceBaseline;
  if (!commitOf(repo, baseline)) return result(false, { sha: full, baseline, reasons: [`provenanceBaseline ${baseline} is not a commit in ${repo}`] });
  if (full === baseline || isAncestor(repo, full, baseline)) return result(true, { sha: full, baseline });
  if (!isAncestor(repo, baseline, full)) return result(false, { sha: full, baseline, unattested: [full], reasons: [`${full.slice(0, 12)} does not descend from provenanceBaseline ${baseline.slice(0, 12)}`] });
  if (!snap) return result(false, { sha: full, baseline, unattested: [full], reasons: ["provenance verification requires a records repository"] });

  let handoffs, rows, windows;
  try {
    handoffs = snap.files.has(HANDOFFS) ? parseProvenanceHandoffs(snap.read(HANDOFFS)) : [];
    rows = snap.files.has(TRAJECTORY) ? parseRows(snap.read(TRAJECTORY)) : [];
    windows = snap.files.has(WINDOWS) ? parseWindows(snap.read(WINDOWS), WINDOWS) : [];
  } catch (e) { return result(false, { sha: full, baseline, reasons: [`invalid records state: ${e.message}`] }); }

  const leadPaths = Array.isArray(merged.leadPaths) ? merged.leadPaths : DEFAULT_LEAD_PATHS;
  const commits = gitLines(repo, "rev-list", "--topo-order", "--reverse", `${baseline}..${full}`);
  if (!commits) return result(false, { sha: full, baseline, unattested: [full], reasons: [`could not walk ${baseline.slice(0, 12)}..${full.slice(0, 12)}`] });
  const attestedHandoffs = attestedRoleCommits(handoffs, snap.files);
  const verified = new Set([baseline]), revertable = new Set(attestedHandoffs), leadOnlySet = new Set(), unattested = [];
  for (const c of commits) {
    const parents = parentsOf(repo, c) ?? [];
    for (const p of parents) if (!verified.has(p) && isAncestor(repo, p, baseline)) verified.add(p);
    if (attestedHandoffs.has(c)) { verified.add(c); revertable.add(c); }
    else if (parents.length >= 2 && isCleanWaveMerge(repo, c, verified)) { verified.add(c); revertable.add(c); }
    else if (isLeadOnlyCommit(repo, c, leadPaths)) { verified.add(c); leadOnlySet.add(c); }
    else if (isExactRevertOfAttested(repo, c, revertable)) { verified.add(c); }
    else unattested.push(c);
  }
  const reasons = unattested.length ? [`unattested commit(s) above provenanceBaseline ${baseline.slice(0, 12)}: ${unattested.map(c => c.slice(0, 12)).join(", ")}`] : [];
  const waveGate = unattested.length ? { required: false, ok: false, missing: ["provenance"] }
    : evaluateWaveGate({ repo, records, snap, handoffs, rows, windows, commits, leadOnlySet, baseline, full, branch, cfg: merged, leadPaths });
  if (waveGate.reasons?.length) reasons.push(...waveGate.reasons);
  const cleanWave = { required: waveGate.required, ok: waveGate.ok, missing: waveGate.missing, ...(waveGate.deferredByWindow ? { deferredByWindow: waveGate.deferredByWindow } : {}) };
  return result(unattested.length === 0 && waveGate.ok, { sha: full, baseline, unattested, waveGate: cleanWave, reasons });
}
