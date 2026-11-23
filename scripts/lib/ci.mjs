// Remote CI facts for one exact commit in one exact repository, read from GitHub's structured check runs (never from an
// agent's report), and the protected-branch push built on them. One rule for `ci-green.mjs` and `gated-push.mjs`:
// lib/check-runs.mjs (checks by app/name, the latest run of each wins).
// design/version-tip.md#one-push-destination
import "./unbind-git.mjs";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { parseRows, TRAJECTORY } from "../trajectory.mjs";
import { ciWord, parseRequired, requiredChecks } from "./check-runs.mjs";
import { gitOk } from "./git-plumbing.mjs";
import { HANDOFFS, parseHandoffs } from "./handoff.mjs";
import { recordsSnapshot } from "./records-commit.mjs";
import { tipCovers, tipProblem } from "./tip.mjs";

// design/version-tip.md#ci-identity
export const CI_HOSTS = ["github.com"];

export function destinationIdentity(url) {
  const text = String(url).trim();
  let host, pathname;
  try {
    if (text.includes("://")) {
      const parsed = new URL(text);
      if (!["https:", "ssh:"].includes(parsed.protocol) || parsed.search || parsed.hash) return null;
      const port = parsed.port === ({ "https:": "443", "ssh:": "22" })[parsed.protocol] ? "" : parsed.port;
      host = parsed.hostname.toLowerCase().replace(/\.$/, "") + (port ? `:${port}` : "");
      pathname = decodeURIComponent(parsed.pathname).replace(/^\//, "");
    } else {
      const m = /^(?:[^@/:]+@)?([^/:@]+):(?!\/)(.+)$/.exec(text);
      if (!m) return null;
      host = m[1].toLowerCase().replace(/\.$/, "");
      pathname = m[2];
    }
  } catch { return null; }
  const path = /^([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(pathname);
  return path ? { host, repository: `${path[1]}/${path[2]}`.toLowerCase() } : null;
}

/** "https://github.com/o/r.git" or "git@github.com:o/r.git" -> "o/r"; null for other hosts. */
export function repoSlug(url) {
  const identity = destinationIdentity(url);
  return identity && CI_HOSTS.includes(identity.host) ? identity.repository : null;
}

export const shownUrl = url => String(url).replace(/^(https?:\/\/)[^@/]*@/i, "$1***@");

export class DestinationError extends Error {}

// design/version-tip.md#git-names-the-remote
function pushUrls(repo, remote) {
  let out;
  try { out = execFileSync("git", ["-C", repo, "remote", "get-url", "--push", "--all", "--", String(remote)], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
  catch (e) { throw new DestinationError(`${repo} has no push remote ${remote}: Git knows no remote of that name (${String(e.stderr ?? e.message).trim()})`); }
  return out.split("\n").map(url => url.trim()).filter(Boolean);
}

export function pushDestination(repo, remote = "origin") {
  const urls = pushUrls(repo, remote);
  if (urls.length === 1) return urls[0];
  if (!urls.length) throw new DestinationError(`${remote} of ${repo} has no push URL`);
  throw new DestinationError(`${remote} of ${repo} has ${urls.length} push URLs: ${urls.map(shownUrl).join(", ")}. A gate reads CI in one destination and publishes to that one only, so none of them is read. `
    + `Give each destination its own remote and promote through each one separately (git remote add <name> <url>; gates.remote names the remote a loop promotes through), `
    + `or remove the extra push URL (git remote set-url --delete --push ${remote} <url>).`);
}

export function ciDestination(repo, remote = "origin") {
  const url = pushDestination(repo, remote);
  const identity = destinationIdentity(url);
  if (!identity || !CI_HOSTS.includes(identity.host))
    throw new DestinationError(`a push to ${remote} of ${repo} goes to ${shownUrl(url)}, not a GitHub repository on ${CI_HOSTS.join(" or ")}${identity ? ` (its host is ${identity.host})` : ""}: `
      + `check runs are read only from the destination's own host, so no checks can be read for it`);
  return { url, ...identity };
}

/**
 * Every check run of one commit through `gh api` (all runs, every page; GH_TOKEN from the caller's environment).
 * Returns null when they cannot be read (network, auth, unknown commit): "could not read" is not "never ran".
 */
export function fetchCheckRuns(slug, sha, host = CI_HOSTS[0]) {
  try {
    const out = execFileSync("gh", ["api", "--hostname", host, "--paginate", `repos/${slug}/commits/${sha}/check-runs?per_page=100&filter=all`,
      "--jq", ".check_runs[] | {id, app: .app.slug, name, status, conclusion, started_at}"],
    { encoding: "utf8", env: { ...process.env, GH_HOST: host }, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 26 });
    return out.split("\n").filter(Boolean).map(line => JSON.parse(line));
  } catch { return null; }
}

// design/version-tip.md#the-tree-git-publishes
export const ORIGINAL_OBJECTS = "--no-replace-objects";
const local = (repo, ...argv) => execFileSync("git", ["-C", repo, ...argv], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const git = (repo, ...argv) => local(repo, ORIGINAL_OBJECTS, ...argv);

function originalObjects(read) {
  const before = process.env.GIT_NO_REPLACE_OBJECTS;
  process.env.GIT_NO_REPLACE_OBJECTS = "1";
  try { return read(); }
  finally {
    if (before === undefined) delete process.env.GIT_NO_REPLACE_OBJECTS;
    else process.env.GIT_NO_REPLACE_OBJECTS = before;
  }
}

/** The full SHA of a commit; throws when it does not name exactly one commit. */
export function fullSha(repo, rev) {
  try { return git(repo, "rev-parse", "--verify", "--quiet", `${rev}^{commit}`); }
  catch { throw new Error(`${rev} does not name one commit in ${repo}`); }
}

const RUN_FIELDS = ["id", "status", "conclusion", "started_at"];
/** The fields of a run a receipt keeps: enough to order it against any other run of the same check. */
const kept = run => Object.fromEntries(RUN_FIELDS.filter(key => run[key] !== undefined).map(key => [key, run[key]]));

// design/version-tip.md#ci-identity
export function ciGreen({ repo, remote = "origin", sha, require, fetchRuns = fetchCheckRuns }) {
  if (!require?.length) throw new Error("no required checks: with no app/name list there is no verdict");
  require.forEach(parseRequired);
  const full = fullSha(repo, sha);
  let destination;
  try { destination = ciDestination(repo, remote); }
  catch (e) {
    if (!(e instanceof DestinationError)) throw e;
    const conclusions = Object.fromEntries(require.map(spec => [spec, "unknown"]));
    return { host: null, repository: null, sha: full, ci: "unknown", ok: false, missing: [e.message], conclusions, runs: null, error: e.message };
  }
  const { host, repository } = destination;
  const verdict = requiredChecks(fetchRuns(repository, full, host), require, full);
  const runs = verdict.runs && Object.fromEntries(Object.entries(verdict.runs).map(([spec, run]) => [spec, kept(run)]));
  return { host, repository, sha: full, ci: ciWord(verdict), ...verdict, runs };
}

const real = p => { try { return realpathSync(p); } catch { return null; } };

const trees = new Map();
function treeOf(repo, sha) {
  const key = `${repo}\0${sha}`;
  if (!trees.has(key)) {
    try { trees.set(key, git(repo, "rev-parse", "--verify", "--quiet", `${sha}^{tree}`)); } catch { return null; }
  }
  return trees.get(key);
}

export function shownTree(repo, sha) {
  const tree = treeOf(repo, sha);
  let view = null;
  try { view = local(repo, "rev-parse", "--verify", "--quiet", `${sha}^{tree}`); } catch { }
  return view && view !== tree ? `tree ${tree}, the tree Git publishes (a local replacement shows tree ${view} for it)` : `tree ${tree}`;
}

const isVaried = receipt => receipt.versionVaried !== undefined && receipt.versionVaried !== null;

// design/version-tip.md#suite-evidence-at-the-point-of-use
export function receiptProblem(receipt, repo, full) {
  if (!receipt || typeof receipt !== "object") return "no suite receipt; run suite-green.mjs on this commit first";
  const varied = isVaried(receipt);
  const named = typeof receipt.tree === "string" ? receipt.tree : null;
  const how = named ? ` (tree ${named}${varied ? `, VERSION varied to ${receipt.versionVaried}` : ""})` : "";
  const ofSha = typeof receipt.sha === "string" && /^[0-9a-f]{40}$/.test(receipt.sha) ? receipt.sha : null;
  if (receipt.sha !== full && !(varied && ofSha && originalObjects(() => tipProblem(repo, ofSha, full)) === null))
    return `the suite receipt is for ${String(receipt.sha).slice(0, 7)}${how}, not ${full.slice(0, 7)} (${shownTree(repo, full)}); run suite-green.mjs --sha ${full.slice(0, 7)}`;
  if (!receipt.repository || real(receipt.repository) !== real(repo)) return `the suite receipt is for ${receipt.repository}, not ${repo}`;
  if (receipt.green !== true) return `the suite is not green on ${full.slice(0, 7)}: ${(receipt.reasons ?? []).join("; ") || "no verdict"}`;
  const tree = treeOf(repo, full);
  const measured = named;
  if (!measured || !tree || measured !== tree)
    return `the suite receipt measured tree ${measured ?? "(none named)"}${varied ? ` (${String(receipt.sha).slice(0, 7)} with VERSION ${receipt.versionVaried})` : ""}, `
      + `but ${full.slice(0, 7)}, the commit published, has ${shownTree(repo, full)}: the suite never ran on what this publishes; run suite-green.mjs --sha ${full.slice(0, 7)}`;
  return null;
}

/** The full ruling is sealed. The public digest and copied trajectory fields cannot establish acceptance. */
export function judgeAccepted(handoff, { read, has }) {
  const round = String(handoff.round).padStart(4, "0");
  const file = `sealed/judge/${round}/${handoff.step}-${handoff.attempt}.md`;
  if (!has(handoff.record) || !handoff.files.includes(file) || !has(file)) return false;
  const full = read(file);
  const delimiter = "\n```\n\n## Report (verbatim)\n\n";
  const boundary = full.indexOf(delimiter);
  const report = boundary < 0 ? full : full.slice(boundary + delimiter.length);
  const fields = name => [...report.matchAll(new RegExp(`^${name}:[ \t]*(.*)$`, "gm"))].map(m => m[1].trim());
  const verdict = fields("VERDICT"), acceptance = fields("ACCEPTANCE");
  return verdict.length === 1 && verdict[0] === "CONVERGED" && acceptance.length === 1 && acceptance[0] === "pass";
}

/**
 * A protected push needs a committed judge verdict for its SHA, for an earlier SHA it follows with only VERSION changed
 * (D-0009 item 2), or for a same-tree second parent.
 */
function hasConvergence(repo, records, full) {
  const { files, read } = recordsSnapshot(records);
  const handoffs = parseHandoffs(read(HANDOFFS));
  const rows = parseRows(read(TRAJECTORY));
  const judged = sha => {
    const row = rows.findLast(r => r.role === "judge" && r.commit === sha);
    return row?.verdict === "CONVERGED" && handoffs.some(h => h.role === "judge" && h.product?.base === sha
      && h.round === row.round && h.phase === row.phase && judgeAccepted(h, { has: path => files.has(path), read }));
  };
  const ruled = [...new Set(rows.filter(r => r.role === "judge" && r.verdict === "CONVERGED" && r.commit !== "-").map(r => r.commit))];
  const accepted = sha => judged(sha) || ruled.some(r => r !== sha && tipCovers(repo, r, sha) && judged(r));
  if (accepted(full)) return true;
  if (!gitOk(repo, "rev-parse", "--verify", "--quiet", `${full}^2`)) return false;
  const second = git(repo, "rev-parse", `${full}^2`);
  return accepted(second) && git(repo, "rev-parse", `${full}^{tree}`) === git(repo, "rev-parse", `${second}^{tree}`);
}

// design/version-tip.md#the-protected-push
export function pushCommit({ repo, records, remote = "origin", sha, branch, suite, protectedBranches = [], require = null, fetchRuns = fetchCheckRuns, dry = false }) {
  const full = fullSha(repo, sha);
  const problem = receiptProblem(suite, repo, full);
  if (problem) return { pushed: false, refused: problem };
  let destination;
  try { destination = pushDestination(repo, remote); }
  catch (e) {
    if (e instanceof DestinationError) return { pushed: false, refused: e.message };
    throw e;
  }
  let verdict;
  if (protectedBranches.includes(branch)) {
    if (!Array.isArray(require)) return { pushed: false, refused: `${branch} is protected and the loop does not configure gates.require (a list of app/name checks; [] requires none)` };
    if (!records) return { pushed: false, refused: `${branch} is protected and no records repository holds the judge's ruling` };
    try {
      if (!originalObjects(() => hasConvergence(repo, records, full)))
        return { pushed: false, refused: `${branch} is protected: no judge CONVERGED ruling and acceptance in ${records} HEAD matching a hand-off and ${TRAJECTORY} row for ${full} or its same-tree second parent` };
      if (require.length) verdict = ciGreen({ repo, remote, sha: full, require, fetchRuns });
    }
    catch (e) { return { pushed: false, refused: `${branch} is protected: ${e.message}` }; }
    if (verdict?.error) return { pushed: false, verdict, refused: `${branch} is protected and the CI of ${full.slice(0, 7)} cannot be read: ${verdict.error}` };
    if (verdict && !verdict.ok) return { pushed: false, verdict, refused: `${branch} is protected and ${full.slice(0, 7)} has not passed every required check in ${verdict.host}/${verdict.repository}:\n  ${verdict.missing.join("\n  ")}` };
  }
  if (dry) return { pushed: false, sha: full, destination, verdict };
  execFileSync("git", ["-C", repo, "push", "-q", "--", remote, `${full}:refs/heads/${branch}`], { stdio: ["ignore", "inherit", "inherit"] });
  return { pushed: true, sha: full, destination, verdict };
}
