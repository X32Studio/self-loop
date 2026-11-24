// D-0060, design/mandatory-control-plane.md#1
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseRows, TRAJECTORY } from "../trajectory.mjs";
import { JUDGE_FRAME_STEP } from "./cadence.mjs";
import { judgeAccepted } from "./ci.mjs";
import { HANDOFFS, parseHandoffs } from "./handoff.mjs";
import { recordsSnapshot } from "./records-commit.mjs";
import { independenceModel, modelVendor } from "./vendor.mjs";
import { parseWindows, WINDOWS, windowState } from "./window.mjs";

export const DEFAULT_LEAD_PATHS = Object.freeze(["VERSION", "docs/", "AGENTS.md", "CLAUDE.md", "README.md"]);

const ORIGINAL = "--no-replace-objects";
const SHA = /^[0-9a-f]{40}$/;
const SHA_IN_TEXT = /\b[0-9a-f]{40}\b/g;
const PLAN_ID = /^PL-\d{4}$/;
const CI_BRANCH = /^ci\/(R-\d{4}-[a-z0-9-]+)$/;

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

function criticCoversActor(repo, critic, actor, targetSha, unjudgedSet) {
  if (!critic.product?.base || !critic.product?.commit) return false;
  if (isAncestor(repo, actor.product.commit, critic.product.base) && isAncestor(repo, critic.product.commit, targetSha)) return true;
  return Boolean(
    critic.dispatch?.plan && critic.dispatch.plan === actor.dispatch?.plan
    && critic.product.commit !== critic.product.base
    && unjudgedSet.has(critic.product.commit)
    && isAncestor(repo, critic.product.commit, actor.product.commit),
  );
}

function vendorFailure(judge, actors) {
  const jv = modelVendor(judge.agent), jm = independenceModel(judge.agent);
  if (!jv || !jm) return `judge ${judge.id} has unknown vendor/model`;
  for (const actor of actors) {
    const av = modelVendor(actor.agent), am = independenceModel(actor.agent);
    if (!av || !am) return `actor ${actor.id} has unknown vendor/model`;
    if (jv === av || jm === am) return `same-vendor judge ${judge.id} (${jv}/${jm}) cannot certify actor ${actor.id} (${av}/${am})`;
  }
  return null;
}

function evaluateWaveGate({ repo, snap, handoffs, rows, windows, commits, leadOnlySet, baseline, full, branch, cfg }) {
  const ciMatch = typeof branch === "string" ? CI_BRANCH.exec(branch) : null;
  const isProtected = Boolean(branch && Array.isArray(cfg?.protected) && cfg.protected.includes(branch));
  const isWorking = Boolean(branch && cfg?.branch && branch === cfg.branch);
  if (!ciMatch && !isProtected && !isWorking) return { required: false, ok: true, missing: [], reasons: [] };

  const phase = cfg?.phase ?? null;
  const scopedHandoffs = handoffs.filter(h => (!phase || h.phase === phase) && snap.files.has(h.record) && h.audit?.violations === 0);
  const scopedRows = phase ? rows.filter(r => r.phase === phase) : rows;
  const commitSet = new Set(commits);
  const actorsInRange = scopedHandoffs.filter(h => h.role === "actor" && h.product?.commit && commitSet.has(h.product.commit) && hasValidPlan(h, snap.files));
  const critics = scopedHandoffs.filter(h => h.role === "critic" && hasValidPlan(h, snap.files));
  const judges = scopedHandoffs.filter(h => h.role === "judge" && !JUDGE_FRAME_STEP.test(h.step));
  const validJudged = new Set(), judgeErrors = [];

  for (const c of commits) {
    const matching = judges.filter(j => j.product?.base === c || j.product?.commit === c);
    if (!matching.length) continue;
    const unjudgedAtC = new Set(commits.filter(x => isAncestor(repo, x, c) && ![...validJudged].some(j => isAncestor(repo, x, j))));
    const waveActors = actorsInRange.filter(a => unjudgedAtC.has(a.product.commit));
    for (const jh of matching) {
      if (!judgeAccepted(jh, { has: p => snap.files.has(p), read: snap.read })) {
        judgeErrors.push(`judge ${jh.id} lacks sealed CONVERGED/pass ruling on ${c.slice(0, 12)}`);
        continue;
      }
      if (scopedRows.some(r => r.role === "judge" && r.round === jh.round && r.commit === c && r.verdict !== "CONVERGED")) {
        judgeErrors.push(`trajectory row for judge ${jh.id} on ${c.slice(0, 12)} is not CONVERGED`);
        continue;
      }
      const vErr = vendorFailure(jh, waveActors);
      if (vErr) { judgeErrors.push(vErr); continue; }
      const uncovered = waveActors.filter(a => !critics.some(cr => criticCoversActor(repo, cr, a, c, unjudgedAtC)));
      if (uncovered.length) { judgeErrors.push(`missing critic covering ${uncovered.map(a => a.id).join(", ")}`); continue; }
      validJudged.add(c);
      break;
    }
  }

  const unjudgedCommits = commits.filter(c => ![...validJudged].some(j => isAncestor(repo, c, j)));
  const unjudgedNonLead = unjudgedCommits.filter(c => !leadOnlySet.has(c));
  const unjudgedSet = new Set(unjudgedCommits);
  const waveActors = actorsInRange.filter(a => unjudgedSet.has(a.product.commit));
  const uncoveredActors = waveActors.filter(a => !critics.some(cr => criticCoversActor(repo, cr, a, full, unjudgedSet)));
  const hasAnyCritic = critics.some(cr => cr.product?.commit && isAncestor(repo, cr.product.commit, full));

  if (ciMatch) {
    const refId = ciMatch[1], missing = [], reasons = [];
    const refHandoff = scopedHandoffs.find(h => h.id === refId);
    if (!refHandoff) {
      missing.push(`handoff:${refId}`);
      reasons.push(`wave gate on ${branch}: referenced handoff ${refId} is not recorded in ${HANDOFFS}`);
    } else if (refHandoff.product?.commit && !isAncestor(repo, refHandoff.product.commit, full)) {
      missing.push(`ancestor:${refId}`);
      reasons.push(`wave gate on ${branch}: ${full.slice(0, 12)} does not descend from ${refId} (${refHandoff.product.commit.slice(0, 12)})`);
    }
    if (unjudgedNonLead.length) {
      if (!waveActors.length && refHandoff?.role !== "critic") {
        missing.push("actor");
        reasons.push(`wave gate on ${branch}: missing covering PL-NNNN actor handoff for ${full.slice(0, 12)}`);
      }
      if (uncoveredActors.length || (!waveActors.length && !hasAnyCritic)) {
        missing.push("critic");
        reasons.push(`wave gate on ${branch}: missing covering critic handoff for ${uncoveredActors.map(a => a.id).join(", ") || full.slice(0, 12)}`);
      }
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
  reasons.push(judgeErrors.length
    ? `wave gate on ${branch}: ${judgeErrors.join("; ")}`
    : `wave gate on ${branch}: missing cross-vendor judge (CONVERGED/pass) covering ${full.slice(0, 12)} above ${baseline.slice(0, 12)}`);
  return { required: true, ok: false, missing, reasons };
}

export function verifyWaveGate({ repo, records, sha, branch, cfg = null }) {
  const full = commitOf(repo, sha);
  if (!full) return { required: true, ok: false, missing: ["commit"], reasons: [`${sha} is not a commit in ${repo}`] };
  const snap = records ? recordsSnapshot(records) : null;
  const merged = readLoopConfig({ cfg, records, snap });
  const baseline = SHA.test(merged.provenanceBaseline ?? "") ? merged.provenanceBaseline : null;
  if (!baseline || full === baseline || isAncestor(repo, full, baseline)) return { required: false, ok: true, missing: [], reasons: [] };
  if (!snap) return { required: true, ok: false, missing: ["records"], reasons: ["provenance wave gate requires records repository"] };
  const commits = gitLines(repo, "rev-list", "--topo-order", "--reverse", `${baseline}..${full}`) ?? [];
  const leadPaths = Array.isArray(merged.leadPaths) ? merged.leadPaths : DEFAULT_LEAD_PATHS;
  const leadOnlySet = new Set(commits.filter(c => isLeadOnlyCommit(repo, c, leadPaths)));
  return evaluateWaveGate({
    repo, snap, commits, leadOnlySet, baseline, full, branch, cfg: merged,
    handoffs: snap.files.has(HANDOFFS) ? parseHandoffs(snap.read(HANDOFFS)) : [],
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
  const merged = readLoopConfig({ cfg, records, snap });
  if (merged.provenanceBaseline === undefined || merged.provenanceBaseline === null) return result(true, { enforced: false, sha: full });
  if (!SHA.test(merged.provenanceBaseline)) return result(false, { sha: full, reasons: [`invalid provenanceBaseline ${JSON.stringify(merged.provenanceBaseline)}`] });
  const baseline = merged.provenanceBaseline;
  if (!commitOf(repo, baseline)) return result(false, { sha: full, baseline, reasons: [`provenanceBaseline ${baseline} is not a commit in ${repo}`] });
  if (full === baseline || isAncestor(repo, full, baseline)) return result(true, { sha: full, baseline });
  if (!isAncestor(repo, baseline, full)) {
    return result(false, { sha: full, baseline, unattested: [full], reasons: [`${full.slice(0, 12)} does not descend from provenanceBaseline ${baseline.slice(0, 12)}`] });
  }
  if (!snap) return result(false, { sha: full, baseline, unattested: [full], reasons: ["provenance verification requires a records repository"] });

  let handoffs, rows, windows;
  try {
    handoffs = snap.files.has(HANDOFFS) ? parseHandoffs(snap.read(HANDOFFS)) : [];
    rows = snap.files.has(TRAJECTORY) ? parseRows(snap.read(TRAJECTORY)) : [];
    windows = snap.files.has(WINDOWS) ? parseWindows(snap.read(WINDOWS), WINDOWS) : [];
  } catch (e) { return result(false, { sha: full, baseline, reasons: [`invalid records state: ${e.message}`] }); }

  const leadPaths = Array.isArray(merged.leadPaths) ? merged.leadPaths : DEFAULT_LEAD_PATHS;
  const commits = gitLines(repo, "rev-list", "--topo-order", "--reverse", `${baseline}..${full}`);
  if (!commits) return result(false, { sha: full, baseline, unattested: [full], reasons: [`could not walk ${baseline.slice(0, 12)}..${full.slice(0, 12)}`] });

  const attestedHandoffs = new Set(
    handoffs
      .filter(h => (h.role === "actor" || h.role === "critic") && h.product?.commit && h.product.commit !== h.product.base
        && snap.files.has(h.record) && h.audit?.violations === 0 && hasValidPlan(h, snap.files))
      .map(h => h.product.commit),
  );
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

  const reasons = unattested.length
    ? [`unattested commit(s) above provenanceBaseline ${baseline.slice(0, 12)}: ${unattested.map(c => c.slice(0, 12)).join(", ")}`]
    : [];
  const waveGate = unattested.length
    ? { required: false, ok: false, missing: ["provenance"] }
    : evaluateWaveGate({ repo, snap, handoffs, rows, windows, commits, leadOnlySet, baseline, full, branch, cfg: merged });
  if (waveGate.reasons?.length) reasons.push(...waveGate.reasons);
  const cleanWave = { required: waveGate.required, ok: waveGate.ok, missing: waveGate.missing, ...(waveGate.deferredByWindow ? { deferredByWindow: waveGate.deferredByWindow } : {}) };
  return result(unattested.length === 0 && waveGate.ok, { sha: full, baseline, unattested, waveGate: cleanWave, reasons });
}
