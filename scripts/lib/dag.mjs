// F-0016, F-0017, P-0018
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";

const ORIGINAL = "--no-replace-objects";
const SHA = /^[0-9a-f]{40}$/;
const DAG_MAX_REPOS = 16;
const DAG_MAX_ANCESTORS = 512;
const DAG_CACHE = new Map();

const gitRun = (repo, ...argv) => spawnSync("git", ["-C", repo, ORIGINAL, ...argv], { encoding: "utf8", maxBuffer: 1 << 26 });
const gitOut = (repo, ...argv) => { const r = gitRun(repo, ...argv); return r.status === 0 ? r.stdout.trim() : null; };
const repoKey = repo => { try { return realpathSync(repo); } catch { return repo; } };
const touchLru = (m, k, v, max) => { m.delete(k); if (m.size >= max) m.delete(m.keys().next().value); m.set(k, v); return v; };
const refSignature = repo => `${gitOut(repo, "for-each-ref", "--format=%(objectname)") ?? ""}\nHEAD:${gitOut(repo, "rev-parse", "--verify", "--quiet", "HEAD") ?? ""}`;

function loadDag(repo, sig = null) {
  const parentsBySha = new Map(), r = gitRun(repo, "rev-list", "--parents", "--all", "HEAD");
  const raw = r.status === 0 ? r.stdout : (gitOut(repo, "rev-list", "--parents", "--all") ?? "");
  for (const line of raw.split("\n")) {
    if (!line) continue;
    const [sha, ...parents] = line.split(" ");
    parentsBySha.set(sha, parents);
  }
  return { refSignature: sig, parentsBySha, ancestors: new Map() };
}

function getDag(repo, needed = []) {
  const key = repoKey(repo);
  let dag = touchLru(DAG_CACHE, key, DAG_CACHE.get(key) ?? loadDag(repo), DAG_MAX_REPOS);
  if (needed.some(sha => !dag.parentsBySha.has(sha))) {
    const sig = refSignature(repo);
    if (sig !== dag.refSignature) dag = touchLru(DAG_CACHE, key, loadDag(repo, sig), DAG_MAX_REPOS);
  }
  return dag;
}

function ancestorsOf(dag, sha) {
  let seen = dag.ancestors.get(sha);
  if (seen) return touchLru(dag.ancestors, sha, seen, DAG_MAX_ANCESTORS);
  seen = new Set();
  for (const stack = [sha]; stack.length;) {
    const cur = stack.pop();
    if (seen.has(cur)) continue;
    seen.add(cur);
    const cached = cur !== sha && dag.ancestors.get(cur);
    if (cached) for (const a of cached) seen.add(a);
    else for (const p of dag.parentsBySha.get(cur) ?? []) if (!seen.has(p)) stack.push(p);
  }
  return touchLru(dag.ancestors, sha, seen, DAG_MAX_ANCESTORS);
}

export function hasCommitFast(repo, rev) {
  if (typeof rev !== "string" || !rev) return null;
  if (SHA.test(rev)) {
    const dag = getDag(repo, [rev]);
    if (dag.parentsBySha.has(rev)) return rev;
  }
  return gitOut(repo, "rev-parse", "--verify", "--quiet", `${rev}^{commit}`);
}

export function parentsOfFast(repo, sha) {
  if (SHA.test(sha ?? "")) {
    const dag = getDag(repo, [sha]);
    if (dag.parentsBySha.has(sha)) return dag.parentsBySha.get(sha);
  }
  const raw = gitOut(repo, "show", "-s", "--format=%P", sha);
  return raw === null ? null : raw.split(/\s+/).filter(Boolean);
}

export function isAncestorFast(repo, anc, desc) {
  if (!anc || !desc) return false;
  if (!SHA.test(anc) || !SHA.test(desc)) return gitRun(repo, "merge-base", "--is-ancestor", anc, desc).status === 0;
  const dag = getDag(repo, anc === desc ? [anc] : [anc, desc]);
  if (anc === desc) return dag.parentsBySha.has(anc) || Boolean(gitOut(repo, "rev-parse", "--verify", "--quiet", `${anc}^{commit}`));
  return dag.parentsBySha.has(anc) && dag.parentsBySha.has(desc)
    ? ancestorsOf(dag, desc).has(anc)
    : gitRun(repo, "merge-base", "--is-ancestor", anc, desc).status === 0;
}

export function firstMergeBetweenFast(repo, from, to) {
  if (!from || !to || from === to) return null;
  if (SHA.test(from) && SHA.test(to)) {
    const dag = getDag(repo, [from, to]);
    if (dag.parentsBySha.has(from) && dag.parentsBySha.has(to)) {
      if (ancestorsOf(dag, to).has(from)) {
        for (let cur = to; cur && cur !== from;) {
          const parents = dag.parentsBySha.get(cur) ?? [];
          if (parents.length >= 2) return cur;
          cur = parents[0];
        }
        return null;
      }
      const fromAnc = ancestorsOf(dag, from);
      if (fromAnc.has(to)) return null;
      const seen = new Set();
      for (let i = 0, q = [to]; i < q.length; i++) {
        const cur = q[i];
        if (seen.has(cur) || fromAnc.has(cur)) continue;
        seen.add(cur);
        const parents = dag.parentsBySha.get(cur) ?? [];
        if (parents.length >= 2) return cur;
        for (const p of parents) if (!seen.has(p) && !fromAnc.has(p)) q.push(p);
      }
      return null;
    }
  }
  const out = gitOut(repo, "rev-list", "--min-parents=2", `${from}..${to}`);
  return out ? out.split("\n")[0] : null;
}
