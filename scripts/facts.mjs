#!/usr/bin/env node
// D-0016, D-0064, D-0067
import "./lib/unbind-git.mjs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cli, need, parseArgs, UsageError } from "./lib/args.mjs";
import { readRows } from "./trajectory.mjs";

const git = (repo, ...argv) => execFileSync("git", ["-C", repo, ...argv], { encoding: "utf8", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "pipe"] }).trim();
const ok = (repo, ...argv) => { try { git(repo, ...argv); return true; } catch { return false; } };

export function shipped(repo, { path, symbol, refs = ["refs/heads", "refs/remotes", "refs/tags"] }) {
  if (!path && !symbol) throw new UsageError("shipped needs --path or --symbol");
  const names = git(repo, "for-each-ref", "--format=%(refname)\t%(refname:short)", ...refs).split("\n")
    .map(line => line.split("\t")).filter(([full]) => full && !full.endsWith("/HEAD")).map(([, short]) => short);
  const containing = [];
  const missing = [];
  for (const ref of names) {
    let present;
    if (symbol) present = ok(repo, "grep", "-q", "-F", "-e", symbol, ref, "--", ...(path ? [path] : []));
    else present = ok(repo, "cat-file", "-e", `${ref}:${path}`);
    (present ? containing : missing).push(ref);
  }
  const logArgs = symbol ? ["-S", symbol] : [];
  const history = git(repo, "log", "--all", "--format=%H\t%cI\t%s", ...logArgs, "--", ...(path ? [path] : ["."])).split("\n").filter(Boolean)
    .map(line => { const [sha, date, subject] = line.split("\t"); return { sha, date, subject }; });
  const first = history.at(-1) ?? null;
  const last = history[0] ?? null;
  const branchesWithFirst = first ? git(repo, "branch", "-a", "--contains", first.sha, "--format=%(refname:short)").split("\n").filter(Boolean) : [];
  const tagsWithFirst = first ? git(repo, "tag", "--contains", first.sha).split("\n").filter(Boolean) : [];
  return { query: { path: path ?? null, symbol: symbol ?? null }, containing, notContaining: missing, firstChange: first, lastChange: last,
    changes: history.length, firstChangeReachableFrom: { branches: branchesWithFirst, tags: tagsWithFirst } };
}

export function area(rows, { area: only, phase } = {}) {
  const out = {};
  for (const r of rows) {
    if (phase && r.phase !== phase) continue;
    if (only && r.area !== only) continue;
    const key = r.area || "-";
    const a = out[key] ??= { rounds: new Set(), roles: {}, opened: [], closed: [], owner: 0, commits: [], verdicts: [] };
    a.rounds.add(r.round);
    a.roles[r.role] = (a.roles[r.role] ?? 0) + 1;
    for (const b of r.opened === "-" ? [] : r.opened.split(",")) a.opened.push(`${r.round}:${b}`);
    for (const b of r.closed === "-" ? [] : r.closed.split(",")) a.closed.push(`${r.round}:${b}`);
    a.owner += Number(r.owner) || 0;
    if (r.commit !== "-" && !a.commits.includes(r.commit)) a.commits.push(r.commit);
    if ((r.role === "judge" || r.role === "critic") && r.verdict !== "-") a.verdicts.push(`${r.round}:${r.verdict}:ci=${r.ci}`);
  }
  for (const a of Object.values(out)) a.rounds = [...a.rounds].sort((x, y) => x - y);
  return out;
}

export function sizes(repo, paths, commits) {
  const out = {};
  for (const path of paths) {
    out[path] = {};
    for (const commit of commits) {
      try { out[path][commit] = git(repo, "show", `${commit}:${path}`).split("\n").length; } catch {}
    }
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) cli(() => {
  const args = parseArgs(process.argv.slice(2));
  const [command] = args._;
  let result;
  if (command === "shipped") {
    need(args, "repo");
    result = shipped(args.repo, { path: args.path || undefined, symbol: args.symbol || undefined,
      ...(args.refs ? { refs: args.refs.split(",") } : {}) });
  } else if (command === "area") {
    need(args, "file");
    result = area(readRows(args.file), { area: args.area || undefined, phase: args.phase || undefined });
  } else if (command === "sizes") {
    need(args, "repo", "paths", "commits");
    result = sizes(args.repo, args.paths.split(","), args.commits.split(","));
  } else throw new UsageError("facts.mjs shipped|area|sizes ... (CI on a commit: ci-green.mjs)");
  console.log(JSON.stringify(result, null, 2));
  return 0;
});
