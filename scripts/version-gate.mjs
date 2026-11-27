#!/usr/bin/env node
// D-0004, D-0015, D-0064
import "./lib/unbind-git.mjs";
import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { cli, need, parseArgs, UsageError } from "./lib/args.mjs";
import { DestinationError, ORIGINAL_OBJECTS, pushDestination, receiptProblem, shownTree } from "./lib/ci.mjs";
import { grcEndpointProblem } from "./lib/ci-destination.mjs";
import { closeReleaseFinding, observeReleaseTips, rememberGatedPush, rememberReleaseTips } from "./lib/release-receipts.mjs";
import { compareVersions, FORMS, parseVersion } from "./lib/version.mjs";
import { suiteGreen, withVersion } from "./suite-green.mjs";

const ZERO = /^0+$/;

// design/version-tip.md#the-tree-git-publishes
const gitEnv = () => ({ GIT_TERMINAL_PROMPT: "0", ...process.env });
const local = (repo, ...argv) => spawnSync("git", ["-C", repo, ...argv], { encoding: "utf8", maxBuffer: 1 << 26, env: gitEnv() });
const git = (repo, ...argv) => local(repo, ORIGINAL_OBJECTS, ...argv);
const SUITE_DIRS = ["scripts/test", "acceptance"];
const isFastPassPath = p => p === "VERSION" || /\.md$/i.test(p) || p.startsWith("docs/");
function suiteCommand(repo, sha) {
  const files = SUITE_DIRS.flatMap(dir => output(repo, "ls-tree", "-z", sha, "--", `${dir}/`).split("\0")
    .map(entry => entry.split("\t")).filter(([meta, path]) => path?.endsWith(".test.mjs") && meta.split(" ")[1] === "blob")
    .map(([, path]) => path));
  if (!files.length) throw new Refused(`${sha.slice(0, 7)} has no *.test.mjs in ${SUITE_DIRS.join(" or ")}`);
  return ["node --test", ...files].join(" ");
}
class Refused extends Error {}
const output = (repo, ...args) => git(repo, ...args).stdout?.trim() ?? "";
const versionAt = (repo, sha) => {
  const r = git(repo, "show", `${sha}:VERSION`);
  return r.status === 0 ? r.stdout.trim() : null;
};
const commitOf = (repo, sha) => output(repo, "rev-parse", "--verify", "--quiet", `${sha}^{commit}`);
const isReleaseTag = ref => ref.startsWith("refs/tags/v");
const isBranch = ref => ref.startsWith("refs/heads/");
const branchRef = branch => `refs/heads/${branch}`;

export function readRemoteRefs(repo, url, refs) {
  const r = spawnSync("git", ["-C", repo, "ls-remote", "--", url, ...refs],
    { encoding: "utf8", maxBuffer: 1 << 26, timeout: 30_000, env: gitEnv() });
  if (r.status !== 0) throw new Error("could not read refs from the push destination");
  return new Map(r.stdout.trim().split("\n").filter(Boolean).map(line => {
    const [sha, ref] = line.split("\t");
    return [ref, sha];
  }));
}

const isRemote = (repo, name) => output(repo, "remote").split("\n").includes(name);

const remoteTagCommit = (refs, ref) => refs.get(ref + "^{}") ?? refs.get(ref);
const runSuite = (repo, sha) => {
  const result = suiteGreen({ repo, sha, command: suiteCommand(repo, sha), format: "node-test" });
  if (result.reusedFrom) console.error(`version-gate: reused ${result.reusedFrom} for ${sha.slice(0, 7)}`);
  return result;
};

export function pushReasons(repo, updates, remoteRefs, { suite = runSuite } = {}) {
  const reasons = [], candidates = new Map(), pendingTags = new Map();
  for (const { ref, sha, before } of updates.filter(u => isReleaseTag(u.ref))) {
    const tag = ref.slice("refs/tags/".length);
    if (ZERO.test(sha)) { reasons.push(`${tag}: a released tag is never deleted`); continue; }
    if (!ZERO.test(before)) { reasons.push(`${tag}: a released tag never moves`); continue; }
    const commit = commitOf(repo, sha);
    const version = commit && versionAt(repo, commit);
    if (!parseVersion(version)) { reasons.push(`${tag}: commit VERSION "${version || "missing"}" is not ${FORMS}`); continue; }
    if (tag !== `v${version}`) { reasons.push(`${tag} tags a commit whose VERSION is ${version}`); continue; }
    pendingTags.set(ref, commit);
    candidates.set(commit, ref);
  }
  for (const { ref, sha, before } of updates.filter(u => isBranch(u.ref) && !ZERO.test(u.sha))) {
    const text = versionAt(repo, sha), version = parseVersion(text);
    if (!version) { reasons.push(`${ref}: VERSION "${text ?? "missing"}" is not ${FORMS}`); continue; }
    if (!ZERO.test(before)) {
      if (!commitOf(repo, before)) { reasons.push(`${ref}: the remote tip ${before.slice(0, 7)} is unknown here; fetch first`); continue; }
      const previous = parseVersion(versionAt(repo, before));
      if (previous && compareVersions(version, previous) <= 0) reasons.push(`${ref}: VERSION ${version.text} is not greater than the remote's ${previous.text}; raise it`);
    }
    const tag = `refs/tags/v${version.text}`;
    if ((pendingTags.get(tag) ?? remoteTagCommit(remoteRefs, tag)) !== sha)
      reasons.push(`${ref}: tag v${version.text} must point at the pushed commit ${sha.slice(0, 7)} on the destination after this push`);
    candidates.set(sha, ref);
  }
  if (!reasons.length) {
    for (const [sha, ref] of candidates) {
      const result = suite(repo, sha);
      const problem = result.green ? receiptProblem(result, repo, sha) : null;
      if (!result.green) reasons.push(`${ref}: the suite is not green on ${sha.slice(0, 7)} (${result.reasons.join(", ")}), measured on ${shownTree(repo, sha)}`);
      else if (problem) reasons.push(`${ref}: ${problem}`);
    }
  }
  return reasons;
}

const zeroFor = sha => "0".repeat(sha.length);
const gatedUpdates = updates => updates.filter(u => (isBranch(u.ref) || isReleaseTag(u.ref)) && !ZERO.test(u.sha));

function rememberBranchTipsBeforePush(repo, url, updates) {
  const tips = updates.filter(u => isBranch(u.ref) && !ZERO.test(u.before)).map(u => [u.ref, u.before]);
  if (tips.length) rememberReleaseTips(repo, url, tips);
}

function checkPush(repo, url, updates, remoteRefs) {
  const reasons = pushReasons(repo, updates, remoteRefs);
  if (reasons.length) throw new Refused(reasons.join("\nversion-gate: "));
  rememberBranchTipsBeforePush(repo, url, updates);
  rememberGatedPush(repo, url, gatedUpdates(updates));
}

function release(repo, remote, branch) {
  const ref = branchRef(branch);
  const sha = commitOf(repo, ref);
  if (!sha) throw new UsageError("select an existing local branch with --branch");
  const version = versionAt(repo, sha);
  if (!parseVersion(version)) throw new UsageError(`VERSION "${version ?? "missing"}" is not ${FORMS}`);
  const status = local(repo, "status", "--porcelain");
  if (status.status !== 0 || status.stdout.trim()) throw new UsageError("the working tree is not clean");
  const tag = `refs/tags/v${version}`, url = pushDestination(repo, remote);
  const refs = readRemoteRefs(repo, url, [ref, tag, tag + "^{}"]);
  const old = refs.get(ref), remoteTag = remoteTagCommit(refs, tag);
  if (old && !commitOf(repo, old) && git(repo, "fetch", "-q", "--no-tags", "--", url, ref).status !== 0)
    throw new Error(`could not fetch ${ref} from the push destination`);
  if (old && git(repo, "merge-base", "--is-ancestor", old, sha).status !== 0)
    throw new Refused(`${ref}: release would not fast-forward the destination`);
  if (remoteTag && remoteTag !== sha) throw new Refused(`${tag} already names another commit at the destination`);
  const localTag = output(repo, "rev-parse", "--verify", "--quiet", tag);
  if (localTag && commitOf(repo, localTag) !== sha) throw new Refused(`${tag} exists on another local commit; raise VERSION`);

  const updates = [];
  if (sha !== old) updates.push({ ref, sha, before: old ?? zeroFor(sha) });
  if (!remoteTag) updates.push({ ref: tag, sha, before: zeroFor(sha) });
  const reasons = pushReasons(repo, updates, refs);
  if (reasons.length) throw new Refused(reasons.join("\nversion-gate: "));
  if (!localTag && git(repo, "tag", "-a", `v${version}`, sha, "-m", `self-loop ${version}`).status !== 0)
    throw new Error(`could not create ${tag}`);
  if (!updates.length) return 0;

  const tagObject = output(repo, "rev-parse", "--verify", "--quiet", tag);
  if (commitOf(repo, tagObject) !== sha) throw new Error(`${tag} changed while preparing the release`);
  const leases = [`--force-with-lease=${ref}:${old ?? ""}`];
  const sources = [`${sha}:${ref}`];
  if (!remoteTag) {
    leases.push(`--force-with-lease=${tag}:`);
    sources.push(`${tagObject}:${tag}`);
  }
  rememberBranchTipsBeforePush(repo, url, updates);
  const push = spawnSync("git", ["-C", repo, "push", "--atomic", ...leases, "--", remote, ...sources], { stdio: "inherit", env: gitEnv() });
  if (push.status === 0) rememberGatedPush(repo, url, updates.map(u => u.ref === tag ? { ...u, sha: tagObject } : u));
  return push.status ?? 1;
}

export function reconcileReleases(repo, remote, branches) {
  const url = pushDestination(repo, remote), refs = branches.map(branchRef);
  return observeReleaseTips(repo, url, refs, readRemoteRefs(repo, url, refs));
}

function checkedOutIn(repo, ref) {
  const lines = output(repo, "worktree", "list", "--porcelain").split("\n");
  const paths = [];
  let path = null;
  for (const line of lines) {
    if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
    else if (line === `branch ${ref}`) paths.push(path);
  }
  return paths;
}

export function tip(repo, { version, on, branch }) {
  const wanted = parseVersion(version);
  if (!wanted) throw new UsageError(`--version "${version}" is not a VERSION: ${FORMS}`);
  const name = branch || output(repo, "symbolic-ref", "--short", "-q", "HEAD");
  if (!name) throw new UsageError("HEAD is detached: name the branch the VERSION commit goes on with --branch");
  if (git(repo, "check-ref-format", "--branch", name).status !== 0) throw new UsageError(`--branch ${name} is not a branch name`);
  const ref = branchRef(name), head = commitOf(repo, ref) || null;
  if (!on && !head) throw new UsageError(`${name} does not exist: give the commit the VERSION commit follows with --on`);
  const parent = commitOf(repo, on || ref);
  if (!parent) throw new UsageError(`--on ${on} is not a commit in ${repo}`);
  const text = versionAt(repo, parent), previous = parseVersion(text);
  if (!previous) return { refused: `${parent.slice(0, 7)} has VERSION "${text ?? "missing"}", not ${FORMS}, so no VERSION can be shown greater than it` };
  if (compareVersions(wanted, previous) <= 0)
    return { refused: `VERSION ${wanted.text} is not greater than ${previous.text}, the VERSION of ${parent.slice(0, 7)}; give a greater one (SemVer precedence)` };
  const tree = withVersion(repo, parent, wanted.text);
  const made = git(repo, "commit-tree", tree, "-p", parent, "-m", `${wanted.text}\n\nVERSION-only commit on ${parent} (version-gate.mjs tip).`);
  if (made.status !== 0) throw new Error(`git commit-tree: ${made.stderr.trim()}`);
  const sha = made.stdout.trim();
  if (head && git(repo, "merge-base", "--is-ancestor", head, sha).status !== 0)
    return { sha, refused: `${name} is at ${head.slice(0, 7)}, which ${sha.slice(0, 7)} does not follow; ${name} was not moved. Build the VERSION commit on its head with --on ${name}, or merge` };
  const moved = git(repo, "update-ref", "-m", `version-gate tip ${wanted.text}`, ref, sha, head ?? "0".repeat(sha.length));
  if (moved.status !== 0) return { sha, refused: `${name} changed while the VERSION commit was written; ${name} was not moved (${moved.stderr.trim()})` };
  return { sha, moved: name, checkedOut: checkedOutIn(repo, ref), version: wanted.text };
}

function prePush(repo, rest) {
  const [name, url] = rest;
  if (!url) throw new UsageError("pre-push needs the destination URL from Git");
  if (name !== url && isRemote(repo, name)) pushDestination(repo, name);
  const epProblem = grcEndpointProblem(url, process.env);
  if (epProblem) throw new DestinationError(epProblem);
  const updates = readFileSync(0, "utf8").trim().split("\n").filter(Boolean).map(line => {
    const [, sha, ref, before] = line.trim().split(/\s+/);
    return { sha, ref, before };
  });
  const refs = updates.some(u => isBranch(u.ref) && !ZERO.test(u.sha))
    ? readRemoteRefs(repo, url, ["refs/tags/v*"]) : new Map();
  checkPush(repo, url, updates, refs);
  return 0;
}

function preCommit(repo, tree) {
  const headTree = output(repo, "rev-parse", "--verify", "--quiet", "HEAD^{tree}");
  if (headTree) {
    const diff = git(repo, "diff-tree", "--no-renames", "--name-only", "-r", "-z", headTree, tree);
    if (diff.status === 0) {
      const changed = diff.stdout.split("\0").filter(Boolean);
      if (changed.length > 0 && changed.every(isFastPassPath)) {
        console.log("pre-commit: fast-pass (VERSION/docs-only)");
        return 0;
      }
    }
  }
  const snapshot = git(repo, "commit-tree", tree, "-m", "Test the staged tree");
  if (snapshot.status !== 0) throw new Error(snapshot.stderr.trim());
  const result = runSuite(repo, snapshot.stdout.trim());
  const summary = result.summary;
  if (summary) console.log(`pre-commit: ${summary.pass}/${summary.tests} passed, ${summary.fail} failed, ${summary.skipped} skipped`);
  if (!result.green) {
    console.error(result.text);
    console.error("pre-commit: staged skill tests failed");
  }
  return result.green ? 0 : 1;
}

function main(command, rest) {
  const repo = output(process.cwd(), "rev-parse", "--show-toplevel");
  if (command === "pre-commit") return preCommit(repo, rest[0]);
  if (command === "pre-push") return prePush(repo, rest);
  const args = parseArgs(rest);
  if (command === "tip") {
    need(args, "version");
    const result = tip(repo, { version: args.version, on: args.on, branch: args.branch });
    if (result.sha) console.log(result.sha);
    if (result.refused) {
      console.error(`version-gate: ${result.refused}`);
      return 2;
    }
    if (result.checkedOut.length)
      console.error(`version-gate: ${result.moved} now points at ${result.sha.slice(0, 7)} (VERSION ${result.version}); it is checked out in ${result.checkedOut.join(", ")}, whose index and working tree were left as they were, so git status there compares them with the new commit. To take the new VERSION there: git checkout HEAD -- VERSION`);
    return 0;
  }
  const remote = args.remote || "origin";
  const branch = args.branch || output(repo, "symbolic-ref", "--short", "HEAD");
  if (command === "release") return release(repo, remote, branch);
  if (command === "reconcile") {
    if (!branch) throw new UsageError("select the remote branch with --branch");
    const findings = reconcileReleases(repo, remote, [branch]);
    if ("close" in args || "cite" in args) {
      need(args, "close", "cite", "records");
      closeReleaseFinding(repo, args.records, args.close, args.cite, findings);
    }
    console.log(JSON.stringify(findings.filter(row => row.id !== args.close), null, 2));
    return 0;
  }
  throw new UsageError("usage: version-gate.mjs release|reconcile [--remote origin] [--branch <name>] | tip --version <V> [--on <commit>] [--branch <name>]");
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) cli(() => {
  const [command, ...rest] = process.argv.slice(2);
  try { return main(command, rest); }
  catch (e) {
    if (!(e instanceof DestinationError || e instanceof Refused)) throw e;
    console.error(`version-gate: ${e.message}`);
    return 2;
  }
});
