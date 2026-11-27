// F-0003, F-0015, D-0064, D-0067, R-0054-reviewer-architecture
import { criticContradictedByTrajectory, criticConvergedAccepted, fullSha } from "./ci.mjs";
import { git, gitOk, run } from "./git-plumbing.mjs";
import { HANDOFFS } from "./handoff.mjs";
import { evaluateCertifiedWaveCoverage } from "./provenance.mjs";
import { tipCovers } from "./tip.mjs";
import { TRAJECTORY } from "../trajectory.mjs";

const HEAVY_ROLES = ["critic", "actor", "judge"];

export function recordedAfter(cfg, state, row) {
  const index = state.rows.indexOf(row);
  const lines = state.read(TRAJECTORY).split("\n");
  let line = 0;
  for (let seen = -1; line < lines.length; line++) if (lines[line] && ++seen === index) break;
  const commit = git(cfg.records, "blame", "--porcelain", "-L", `${line + 1},${line + 1}`, state.revision, "--", TRAJECTORY).slice(0, 40);
  const before = gitOk(cfg.records, "cat-file", "-e", `${commit}:${HANDOFFS}`)
    ? git(cfg.records, "show", `${commit}:${HANDOFFS}`).split("\n").filter(Boolean).length : 0;
  return new Set(state.handoffs.slice(before).map(h => h.id));
}

export function checkouts(product) {
  const found = new Map();
  let path = null;
  for (const line of git(product, "worktree", "list", "--porcelain").split("\n")) {
    if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
    else if (line.startsWith("branch refs/heads/") && path) found.set(line.slice("branch refs/heads/".length), path);
  }
  return found;
}

export function integrationOf(cfg, state, handoffs, rows) {
  const { product } = cfg;
  const known = new Map();
  const ancestor = (a, b) => {
    if (a === b) return true;
    const key = `${a} ${b}`;
    if (!known.has(key)) known.set(key, gitOk(product, "merge-base", "--is-ancestor", a, b));
    return known.get(key);
  };
  const named = [...new Set([...rows.map(r => r.commit), ...handoffs.map(h => h.product?.commit)].filter(sha => /^[0-9a-f]{40}$/.test(sha ?? "")))];
  const found = new Set(named.length ? run("git", ["-C", product, "cat-file", "--batch-check=%(objectname) %(objecttype)"], { encoding: "utf8", input: named.join("\n") + "\n" })
    .split("\n").filter(line => line.endsWith(" commit")).map(line => line.split(" ")[0]) : []);
  const exists = sha => found.has(sha);
  const branch = cfg.branch ?? null;
  const branchHead = fullSha(product, branch ?? "HEAD");
  const row = rows.findLast(r => (r.role === "judge" || (r.role === "critic" && r.verdict !== "-")) && r.commit !== "-") ?? null;
  const problems = [];
  let judged = row?.commit ?? null;
  if (judged && !exists(judged)) {
    problems.push(`the last judged commit ${judged} (round ${row.round}) is not a commit in ${product}`);
    judged = null;
  }
  let after = null;
  if (row) {
    try { after = recordedAfter(cfg, state, row); }
    catch (error) {
      after = new Set();
      problems.push(`the hand-offs recorded after the ruling of round ${row.round} cannot be read: ${error.message}`);
    }
  }
  const recorded = handoffs.filter(h => HEAVY_ROLES.includes(h.role) && h.product && (!after || after.has(h.id)) && exists(h.product.commit));
  const line = recorded.filter(h => !judged || ancestor(judged, h.product.commit));
  const points = [...new Set([...(judged ? [judged] : []), ...line.map(h => h.product.commit)])];
  const independent = new Set(points.length > 1 ? git(product, "merge-base", "--independent", ...points).split("\n").filter(Boolean) : points);
  const heads = points.filter(sha => independent.has(sha));
  const by = sha => sha === judged ? `the last judged commit, round ${row.round}` : line.findLast(h => h.product.commit === sha)?.id;
  const refs = [...new Set([branch, ...cfg.protected].filter(Boolean))]
    .filter(name => gitOk(product, "show-ref", "--verify", "--quiet", `refs/heads/${name}`))
    .map(name => ({ name, sha: fullSha(product, `refs/heads/${name}`) }));
  const tipsOf = base => refs.filter(ref => ref.sha !== base && ancestor(base, ref.sha) && tipCovers(product, base, ref.sha));
  const judgedTips = judged ? tipsOf(judged) : [];
  const result = { branch, branchHead, judged, row, problems, ancestor, heads: heads.map(sha => ({ sha, by: by(sha) })), judgedTips,
    recordedTip: judged && row.tip ? row.tip : null, tips: [] };
  if (!heads.length) return { ...result, sha: branchHead, source: `${branch ?? "HEAD"}: no judged commit or hand-off commit of the phase yet`, heads: [{ sha: branchHead, by: branch ?? "HEAD" }], relation: "at" };
  if (heads.length > 1) {
    const merge = branch && heads.every(head => ancestor(head, branchHead)) ? branchHead : null;
    return { ...result, sha: null, merge, relation: "heads" };
  }
  const sha = heads[0];
  const source = sha === judged ? `the last judged commit, round ${row.round}` : `${by(sha)}, recorded after ${row ? `the ruling of round ${row.round}` : "the phase began"}`;
  const tips = sha === judged ? judgedTips : tipsOf(sha);
  const relation = branchHead === sha ? "at" : tips.some(t => t.name === branch) ? "tip"
    : ancestor(branchHead, sha) ? "lags" : ancestor(sha, branchHead) ? "ahead" : "diverged";
  return { ...result, sha, source, tips, relation };
}

// D-0064, D-0067
export function certifiedCriticOn({ cfg, state, rows, actors, judges, critics, target, integration, covers }) {
  if (!target) return null;
  const files = new Set(state.files);
  const SHA = /^[0-9a-f]{40}$/;
  const PLAN_ID = /^PL-\d{4}$/;
  let committedBaseline = null;
  const rawLoop = state.read("loop.json");
  if (rawLoop) {
    try { committedBaseline = JSON.parse(rawLoop)?.provenanceBaseline ?? null; } catch { return null; }
  }
  const hasBaseline = SHA.test(cfg?.provenanceBaseline ?? committedBaseline ?? "");
  for (let i = critics.length - 1; i >= 0; i--) {
    const ch = critics[i];
    if (hasBaseline && !(ch.dispatch?.plan && PLAN_ID.test(ch.dispatch.plan) && files.has(`plans/${ch.dispatch.plan}.md`))) continue;
    const certSha = ch.product?.commit || ch.product?.base || null;
    if (!certSha || !SHA.test(certSha) || !covers(certSha)) continue;
    if (ch.product?.base && ch.product?.commit && ch.product.base !== ch.product.commit
      && !integration.ancestor(ch.product.base, ch.product.commit)) continue;
    if (!criticConvergedAccepted(ch, { has: path => files.has(path), read: state.read })) continue;
    if (criticContradictedByTrajectory(rows, ch, [certSha, target])) continue;
    const cov = evaluateCertifiedWaveCoverage({
      repo: cfg.product, records: cfg.records, revision: state.revision, files, read: state.read,
      cfg, phase: cfg.phase, targetCommit: certSha, judge: ch, judges, critics, actors, rows,
      allHandoffs: state.handoffs, allRows: state.rows, isAncestor: integration.ancestor, requireActor: false,
    });
    if (!cov.ok) continue;
    if (cov.actors.some(a => !ch.product?.base || !integration.ancestor(a.product.commit, ch.product.base))) continue;
    return { handoff: ch, sha: certSha, coverage: cov };
  }
  return null;
}
