// Remote CI facts for one exact commit in one exact repository, read from the push destination's own forge
// (GitHub check runs or AWS CodeBuild builds — never from an agent's report), and the protected-branch push built on
// them. One rule for `ci-green.mjs` and `gated-push.mjs`: lib/check-runs.mjs (checks by app/name, latest run wins).
// design/codecommit-forge-ci.md
import "./unbind-git.mjs";
import { execFileSync, spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { parseRows, TRAJECTORY } from "../trajectory.mjs";
import { ciWord, parseRequired, requiredChecks } from "./check-runs.mjs";
import { fetchCodeBuildRuns, resolveAwsRegion } from "./ci-codebuild.mjs";
import {
  checkAppProblem, CODEBUILD_APP, codecommitHost, DestinationError, grcEndpointProblem, isGrcUrl,
  parseDestination, redactDestinationOutput, shownUrl, validateCodeBuildSpec,
} from "./ci-destination.mjs";
import { gitOk } from "./git-plumbing.mjs";
import { HANDOFFS, parseHandoffs } from "./handoff.mjs";
import { recordsSnapshot } from "./records-commit.mjs";
import { checkSsot, formatSsotRefusal, ssotDriftWarnings } from "./ssot.mjs";
import { tipCovers, tipProblem } from "./tip.mjs";

export { DestinationError, parseDestination, shownUrl };

/**
 * Every check run of one commit through `gh api` (all runs, every page; GH_TOKEN from the caller's environment).
 * Returns { runs: null } when they cannot be read (network, auth, unknown commit): "could not read" is not "never ran".
 */
function fetchGitHubRuns(destination, sha) {
  try {
    const out = execFileSync("gh", ["api", "--hostname", destination.host, "--paginate",
      `repos/${destination.repository}/commits/${sha}/check-runs?per_page=100&filter=all`,
      "--jq", ".check_runs[] | {id, app: .app.slug, name, status, conclusion, started_at}"],
    { encoding: "utf8", env: { ...process.env, GH_HOST: destination.host }, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 26 });
    return { runs: out.split("\n").filter(Boolean).map(line => JSON.parse(line)) };
  } catch { return { runs: null }; }
}

// design/codecommit-forge-ci.md#forges-registry-contract
export const FORGES = Object.freeze({
  github: Object.freeze({
    id: "github",
    label: "GitHub (github.com)",
    apps: null,
    fetchRuns: fetchGitHubRuns,
  }),
  codecommit: Object.freeze({
    id: "codecommit",
    label: "AWS CodeCommit",
    apps: Object.freeze([CODEBUILD_APP]),
    validateSpec: validateCodeBuildSpec,
    fetchRuns: fetchCodeBuildRuns,
  }),
});

// design/version-tip.md#git-names-the-remote
function pushUrls(repo, remote) {
  let out;
  try { out = execFileSync("git", ["-C", repo, "remote", "get-url", "--push", "--all", "--", String(remote)], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
  catch (e) { throw new DestinationError(`${repo} has no push remote ${remote}: Git knows no remote of that name (${String(e.stderr ?? e.message).trim()})`); }
  return out.split("\n").map(url => url.trim()).filter(Boolean);
}

export function pushDestination(repo, remote = "origin") {
  const urls = pushUrls(repo, remote);
  if (urls.length === 1) {
    const epProblem = grcEndpointProblem(urls[0], process.env);
    if (epProblem) throw new DestinationError(epProblem);
    return urls[0];
  }
  if (!urls.length) throw new DestinationError(`${remote} of ${repo} has no push URL`);
  throw new DestinationError(`${remote} of ${repo} has ${urls.length} push URLs: ${urls.map(shownUrl).join(", ")}. A gate reads CI in one destination and publishes to that one only, so none of them is read. `
    + `Give each destination its own remote and promote through each one separately (git remote add <name> <url>; gates.remote names the remote a loop promotes through), `
    + `or remove the extra push URL (git remote set-url --delete --push ${remote} <url>).`);
}

function parsePushDestination(repo, remote = "origin") {
  const url = pushDestination(repo, remote);
  const parsed = parseDestination(url);
  if (!parsed || !parsed.forge) {
    throw new DestinationError(`a push to ${remote} of ${repo} goes to ${shownUrl(url)}, not a supported CI forge repository (github.com or AWS CodeCommit)${parsed?.host ? ` (its host is ${parsed.host})` : ""}: `
      + `check runs are read only from the destination's own forge, so no checks can be read for it`);
  }
  return { url, parsed };
}

function finalizeDestination(url, parsed) {
  let { host, region } = parsed;
  if (parsed.forge === "codecommit" && !region) {
    region = resolveAwsRegion(parsed.profile, url);
    host = codecommitHost(region);
  }
  return {
    url,
    forge: parsed.forge,
    host,
    ...(region ? { region } : {}),
    repository: parsed.repository,
    ...(parsed.profile ? { profile: parsed.profile } : {}),
  };
}

export function ciDestination(repo, remote = "origin") {
  const { url, parsed } = parsePushDestination(repo, remote);
  return finalizeDestination(url, parsed);
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

const RUN_FIELDS = ["id", "build_id", "status", "conclusion", "started_at"];
/** The fields of a run a receipt keeps: enough to order it against any other run of the same check. */
const kept = run => Object.fromEntries(RUN_FIELDS.filter(key => run[key] !== undefined).map(key => [key, run[key]]));
const allUnknown = require => Object.fromEntries(require.map(spec => [spec, "unknown"]));

// design/codecommit-forge-ci.md#unified-cigreen-and-pushcommit-execution-flow
export function ciGreen({ repo, remote = "origin", sha, require, fetchRuns }) {
  if (!require?.length) throw new Error("no required checks: with no app/name list there is no verdict");
  const parsed = require.map(parseRequired);
  const full = fullSha(repo, sha);
  const source = fetchRuns ? "injected" : "live";
  let url, parsedDest;
  try { ({ url, parsed: parsedDest } = parsePushDestination(repo, remote)); }
  catch (e) {
    if (!(e instanceof DestinationError)) throw e;
    return { forge: null, host: null, repository: null, sha: full, ci: "unknown", ok: false, missing: [e.message], conclusions: allUnknown(require), runs: null, error: e.message, source };
  }
  const problem = checkAppProblem(parsedDest, parsed, FORGES);
  if (problem) {
    return {
      forge: parsedDest.forge,
      host: parsedDest.host,
      ...(parsedDest.region ? { region: parsedDest.region } : {}),
      ...(parsedDest.forge === "codecommit" ? { account: null } : {}),
      repository: parsedDest.repository,
      sha: full,
      ci: "unknown",
      ok: false,
      missing: [problem],
      conclusions: allUnknown(require),
      runs: null,
      error: problem,
      source,
    };
  }
  let destination;
  try { destination = finalizeDestination(url, parsedDest); }
  catch (e) {
    if (!(e instanceof DestinationError)) throw e;
    return { forge: null, host: null, repository: null, sha: full, ci: "unknown", ok: false, missing: [e.message], conclusions: allUnknown(require), runs: null, error: e.message, source };
  }
  const reader = fetchRuns ?? FORGES[destination.forge].fetchRuns;
  const raw = reader(destination, full, parsed);
  const { runs: rawRuns, error: readError = null, account = null } = (raw === null || Array.isArray(raw)) ? { runs: raw } : raw;
  const verdict = requiredChecks(rawRuns, require, full);
  if (rawRuns === null && readError) {
    verdict.missing = require.map(spec => `${spec}: check runs could not be read (${readError})`);
  }
  const runs = verdict.runs && Object.fromEntries(Object.entries(verdict.runs).map(([spec, run]) => [spec, kept(run)]));
  return {
    forge: destination.forge,
    host: destination.host,
    ...(destination.region ? { region: destination.region } : {}),
    ...(destination.forge === "codecommit" ? { account } : {}),
    repository: destination.repository,
    sha: full,
    ci: ciWord(verdict),
    ...verdict,
    ...(readError ? { error: readError } : {}),
    runs,
    source,
  };
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
export function pushCommit({ repo, records, remote = "origin", sha, branch, suite, protectedBranches = [], require = null, fetchRuns, dry = false, ssot, configFile }) {
  const full = fullSha(repo, sha);
  const problem = receiptProblem(suite, repo, full);
  if (problem) return { pushed: false, refused: problem };
  let destination;
  try { destination = pushDestination(repo, remote); }
  catch (e) {
    if (e instanceof DestinationError) return { pushed: false, refused: e.message };
    throw e;
  }
  const isProtected = protectedBranches.includes(branch);
  let ssotResult, warnings;
  if (ssot !== undefined) {
    ssotResult = checkSsot({ product: repo, records, configFile, ssot, sha: full, strict: isProtected, runChecks: true });
    if (!ssotResult.ok) return { pushed: false, ssot: ssotResult, refused: formatSsotRefusal(ssotResult) };
    if (!isProtected && ssotResult.drift.length) warnings = ssotDriftWarnings(ssotResult);
  }
  let verdict;
  if (isProtected) {
    if (!Array.isArray(require)) return { pushed: false, refused: `${branch} is protected and the loop does not configure gates.require (a list of app/name checks; [] requires none)` };
    if (!records) return { pushed: false, refused: `${branch} is protected and no records repository holds the judge's ruling` };
    try {
      if (!originalObjects(() => hasConvergence(repo, records, full)))
        return { pushed: false, refused: `${branch} is protected: no judge CONVERGED ruling and acceptance in ${records} HEAD matching a hand-off and ${TRAJECTORY} row for ${full} or its same-tree second parent` };
      if (require.length) verdict = ciGreen({ repo, remote, sha: full, require, ...(fetchRuns ? { fetchRuns } : {}) });
    }
    catch (e) { return { pushed: false, refused: `${branch} is protected: ${e.message}` }; }
    if (verdict?.error) return { pushed: false, verdict, refused: `${branch} is protected and the CI of ${full.slice(0, 7)} cannot be read: ${verdict.error}` };
    if (verdict && !verdict.ok) return { pushed: false, verdict, refused: `${branch} is protected and ${full.slice(0, 7)} has not passed every required check in ${verdict.host}/${verdict.repository}:\n  ${verdict.missing.join("\n  ")}` };
  }
  if (dry) return { pushed: false, sha: full, destination, verdict, ...(ssotResult ? { ssot: ssotResult } : {}), ...(warnings ? { warnings } : {}) };
  const pushEnv = { ...process.env };
  if (isGrcUrl(destination)) delete pushEnv.CODE_COMMIT_ENDPOINT;
  const pushed = spawnSync("git", ["-C", repo, "push", "-q", "--", remote, `${full}:refs/heads/${branch}`], {
    encoding: "utf8",
    env: pushEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const out = redactDestinationOutput(pushed.stdout ?? "", destination);
  const err = redactDestinationOutput(pushed.stderr ?? "", destination);
  if (out) process.stdout.write(out);
  if (pushed.error || pushed.status !== 0) {
    const detail = err.trim() || redactDestinationOutput(pushed.error?.message ?? "", destination);
    throw new Error(`git push to ${shownUrl(destination)} failed${pushed.status !== null ? ` (exit ${pushed.status})` : ""}${detail ? `: ${detail}` : ""}`);
  }
  if (err) process.stderr.write(err);
  return { pushed: true, sha: full, destination, verdict, ...(ssotResult ? { ssot: ssotResult } : {}), ...(warnings ? { warnings } : {}) };
}
