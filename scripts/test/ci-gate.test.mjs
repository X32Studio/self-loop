// Admission of the CI gate (round close and protected-branch push): the same rule turns the recorded S4 defects red and
// keeps every commit whose workflow succeeded green. Labels come from the workflow runs, the gate reads the check runs.
// The recorded check runs predate matching by source: every one of them came from the repository's GitHub Actions
// workflow (the corpus was read from actions/runs and those runs' check runs), so each gets app `github-actions`.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { ciWord, requiredChecks } from "../lib/check-runs.mjs";
import { ciDestination, ciGreen, DestinationError, parseDestination, pushCommit, pushDestination } from "../lib/ci.mjs";
import { readCi } from "../lib/ci-receipt.mjs";
import { policyOf } from "../gated-push.mjs";
import { fixtures, git, green, redOn, repo, s4History, scripts, temp } from "./helpers.mjs";

process.env.SELF_LOOP_LOAD_DIR = temp("self-loop-load-");

function registeredLoop(product, { files = {}, protectedBranches = ["main"], require = ["github-actions/verify"], remote, name = "product" } = {}) {
  const records = repo({ "records.json": "{}\n", ...files });
  writeFileSync(join(records, "loop.json"), JSON.stringify({ product, records, workDir: temp("work-"), phase: "S5", briefs: {}, agents: {},
    protected: protectedBranches, gates: { require, ...(remote ? { remote } : {}) } }, null, 2) + "\n");
  git(records, "add", "-A");
  git(records, "commit", "-qm", "loop");
  const store = temp("owner-store-");
  writeFileSync(join(store, "products.json"), JSON.stringify({ products: [{ name, records }] }));
  return { records, store };
}

const gatedPush = (args, env = process.env) => spawnSync(process.execPath, [join(scripts, "gated-push.mjs"), ...args], { encoding: "utf8", env });

const samples = JSON.parse(readFileSync(join(fixtures, "s4-check-runs.json"), "utf8")).samples
  .map(s => ({ ...s, check_runs: s.check_runs.map(r => ({ app: "github-actions", ...r })) }));
const NAMES = ["verify", "linux-host", "sandbox"];
const CURRENT = NAMES.map(n => `github-actions/${n}`);
const RED_S4 = ["7da50ab", "c6dff19", "6506fa8", "c7d752c"];

// The checks the workflow defined at a time: each check counts from its first appearance in the corpus. This is
// independent of any sample's own result.
const firstSeen = {};
for (const s of samples) for (const r of s.check_runs) if (!firstSeen[r.name] || r.started_at < firstSeen[r.name]) firstSeen[r.name] = r.started_at;
const requiredAt = sample => {
  const t = sample.check_runs.map(r => r.started_at).sort()[0];
  return t ? NAMES.filter(name => firstSeen[name] <= t).map(n => `github-actions/${n}`) : CURRENT;
};

test("red: the four S4 pushes whose Linux verify failed are refused", () => {
  for (const short of RED_S4) {
    const s = samples.find(x => x.sha.startsWith(short));
    const v = requiredChecks(s.check_runs, CURRENT, s.sha);
    assert.equal(v.ok, false, short);
    assert.match(v.missing.join(), /github-actions\/verify: completed\/failure/);
    assert.equal(ciWord(v), "failure");
  }
});

test("red: a commit with no check runs at all is refused (never ran)", () => {
  const s = samples.find(x => x.sha.startsWith("9fc7a06"));
  const v = requiredChecks(s.check_runs, CURRENT, s.sha);
  assert.equal(v.ok, false);
  assert.equal(ciWord(v), "absent");
});

test("green and red agree with the workflow's own conclusion on every recorded commit (zero false kills)", () => {
  let green = 0, red = 0;
  for (const s of samples) {
    const v = requiredChecks(s.check_runs, requiredAt(s), s.sha);
    assert.equal(v.ok, s.workflow === "success", `${s.sha.slice(0, 7)} workflow=${s.workflow} gate=${v.ok} ${v.missing.join("; ")}`);
    v.ok ? green++ : red++;
  }
  assert.equal(green, 54);
  assert.equal(red, 14);
});

test("a re-run that passed replaces the earlier result; the latest run per name counts", () => {
  const runs = [
    { name: "verify", status: "completed", conclusion: "failure", started_at: "2026-11-20T01:00:00Z" },
    { name: "verify", status: "completed", conclusion: "success", started_at: "2026-11-20T02:00:00Z" },
  ];
  const req = ["github-actions/verify"];
  const app = runs.map(r => ({ app: "github-actions", ...r }));
  assert.equal(requiredChecks(app, req).ok, true);
  assert.equal(requiredChecks(app.slice().reverse().map((r, i) => ({ ...r, started_at: i ? "2026-11-20T03:00:00Z" : r.started_at })), req).ok, false);
  assert.equal(ciWord(requiredChecks([{ app: "github-actions", name: "verify", status: "in_progress", conclusion: null, started_at: "x" }], req)), "pending");
  assert.equal(requiredChecks([], []).ok, false, "no required checks is no verdict, never success");
});

test("parseDestination identifies GitHub remotes and rejects unsupported/local paths", () => {
  assert.deepEqual(parseDestination("https://github.com/example/app.git\n"), { forge: "github", host: "github.com", region: null, repository: "example/app", profile: null });
  assert.deepEqual(parseDestination("git@github.com:example/app.git"), { forge: "github", host: "github.com", region: null, repository: "example/app", profile: null });
  assert.equal(parseDestination("https://gitlab.com/a/b.git").forge, null);
  assert.equal(parseDestination("https://github.com.evil.example/a/b.git").forge, null);
  assert.equal(parseDestination("/srv/git/github.com/a/b.git"), null, "a local path is not a remote forge");
});

// ---------- review v0.2 B2: the latest run, the destination repository ----------

test("a queued re-run is pending, not the earlier success; a failed re-run fails; check-run ids order runs", () => {
  assert.deepEqual(redOn("ci-reruns"), { queuedRerunOk: true, failedRerunOk: false }); // red on a4db050: the queued re-run case
  const req = ["github-actions/verify"];
  const ok = green("verify", "github-actions", "success", "2026-11-20T01:00:00Z");
  const queued = { app: "github-actions", name: "verify", status: "queued", conclusion: null, started_at: null };
  const failed = green("verify", "github-actions", "failure", "2026-11-20T02:00:00Z");
  assert.equal(ciWord(requiredChecks([ok, queued], req)), "pending");
  assert.equal(ciWord(requiredChecks([queued, ok], req)), "pending", "order of the list does not matter");
  assert.equal(ciWord(requiredChecks([ok, failed], req)), "failure");
  assert.equal(requiredChecks([{ ...failed, id: 7 }, { ...ok, id: 9, started_at: "2026-11-19T00:00:00Z" }], req).ok, true, "the higher id is the later run");
  assert.equal(requiredChecks([{ ...ok, id: 9 }, { ...failed, id: 9 }], req).ok, false, "a tie is not a success");
});

test("CI is read in the repository the push goes to, never the fetch repository", () => {
  assert.deepEqual(redOn("push-destination"), { queried: ["example/fetch"], pushed: false, refused: null }); // red on a4db050
  const product = repo({ "a.txt": "1\n" });
  git(product, "remote", "add", "origin", "https://github.com/example/fetch.git");
  git(product, "remote", "set-url", "--push", "origin", "https://github.com/example/push.git");
  const sha = git(product, "rev-parse", "HEAD");
  const records = repo({ "metrics/trajectory.jsonl": convergence(sha), ...judgeEvidence(sha) });
  const queried = [];
  const fetchRuns = dest => { queried.push(dest.repository); return dest.repository === "example/push" ? [green()] : [green("verify", "github-actions", "failure")]; };
  const req = ["github-actions/verify"];
  const suite = { repository: product, sha, tree: git(product, "--no-replace-objects", "rev-parse", `${sha}^{tree}`), green: true, reasons: [] };
  const r = pushCommit({ repo: product, records, sha, suite, branch: "main", protectedBranches: ["main"], require: req, fetchRuns, dry: true });
  assert.deepEqual(queried, ["example/push"]);
  assert.equal(r.refused, undefined);
  assert.deepEqual([ciGreen({ repo: product, sha: sha.slice(0, 7), require: req, fetchRuns }).repository, ciGreen({ repo: product, sha, require: req, fetchRuns }).sha], ["example/push", sha]);
  // pushInsteadOf sends the push to a local bare repository: no supported forge checks exist there, so a protected push is refused
  const bare = temp("bare-"); git(bare, "init", "-q", "--bare");
  git(product, "config", "--unset", "remote.origin.pushurl");
  git(product, "config", `url.${bare}.pushInsteadOf`, "https://github.com/example/fetch.git");
  assert.throws(() => ciDestination(product), /not a supported CI forge repository/);
  assert.match(pushCommit({ repo: product, records, sha, suite, branch: "main", protectedBranches: ["main"], require: req, fetchRuns: () => [green()] }).refused, /not a supported CI forge repository/);
  assert.equal(spawnSync("git", ["-C", bare, "rev-parse", "--verify", "-q", "refs/heads/main"]).status, 1, "nothing was pushed");
  assert.equal(pushCommit({ repo: product, sha, suite, branch: "work", protectedBranches: ["main"] }).pushed, true, "a working branch is not gated");
  assert.equal(git(bare, "rev-parse", "refs/heads/work"), sha);
});

test("ci-green CLI: exit 0 green, 2 not green, 64 without a required list; the full SHA and repository are printed", () => {
  const product = repo({ "a.txt": "1\n" });
  git(product, "remote", "add", "origin", "https://github.com/example/product.git");
  const sha = git(product, "rev-parse", "HEAD");
  const dir = temp();
  const cli = (runs, ...extra) => {
    writeFileSync(join(dir, "runs.json"), JSON.stringify({ check_runs: runs }));
    return spawnSync(process.execPath, [join(scripts, "ci-green.mjs"), "--repo", product, "--sha", "HEAD", "--from-json", join(dir, "runs.json"), ...extra], { encoding: "utf8" });
  };
  const ok = cli([green()], "--require", "github-actions/verify");
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual([JSON.parse(ok.stdout).sha, JSON.parse(ok.stdout).repository], [sha, "example/product"]);
  assert.equal(cli([green("verify", "github-actions", "failure")], "--require", "github-actions/verify").status, 2);
  assert.equal(cli([], "--require", "github-actions/verify").status, 2, "never ran is not green");
  assert.equal(cli([green()]).status, 64);
});

test("ci-green writes the same green or red receipt as stdout and never overwrites a receipt", () => {
  const product = repo({ "a.txt": "1\n" });
  git(product, "remote", "add", "origin", "https://github.com/example/product.git");
  const dir = temp();
  const runs = join(dir, "runs.json");
  const run = (checks, ...args) => {
    writeFileSync(runs, JSON.stringify({ check_runs: checks }));
    return spawnSync(process.execPath, [join(scripts, "ci-green.mjs"), "--repo", product, "--sha", "HEAD", "--from-json", runs,
      "--require", "github-actions/verify", ...args], { encoding: "utf8" });
  };
  const good = join(dir, "evidence", "0001", "ci-green");
  const bad = join(dir, "evidence", "0001", "ci-red");
  const greenRun = run([green()], "--out", good);
  assert.equal(greenRun.status, 0, greenRun.stderr);
  assert.equal(readFileSync(good + ".json", "utf8"), greenRun.stdout);
  const redRun = run([], "--out", bad);
  assert.equal(redRun.status, 2, redRun.stderr);
  assert.equal(readFileSync(bad + ".json", "utf8"), redRun.stdout);
  assert.equal(JSON.parse(redRun.stdout).ci, "absent");
  const collision = run([], "--out", good);
  assert.equal(collision.status, 64, collision.stderr);
  assert.match(collision.stderr, /never overwritten/);
  assert.equal(readFileSync(good + ".json", "utf8"), greenRun.stdout);
  assert.equal(run([green()], "--out").status, 64);
});

// End to end through the real command, offline: a stand-in `gh` serves the recorded check runs the way
// `gh api --paginate --jq` prints them (one object per line); the history fixture maps the source SHAs to the replayed Git commits.
test("gated-push refuses the S4 failure and passes the recorded rewrite head", () => {
  const { product, commits } = s4History();
  const failed = [...commits].find(([sha]) => sha.startsWith("c7d752c"))[1];
  const rewrite = commits.get("a69e4eb083d505cd413bd2a7e62032e77f2a624c");
  const bin = temp("fake-gh-");
  const served = join(bin, "runs.json");
  writeFileSync(served, JSON.stringify(Object.fromEntries(samples.filter(s => commits.has(s.sha)).map(s => [commits.get(s.sha), s.check_runs]))));
  writeFileSync(join(bin, "gh"), `#!/usr/bin/env node
const runs = JSON.parse(require("fs").readFileSync(${JSON.stringify(served)}, "utf8"));
const sha = /commits\\/([0-9a-f]{40})\\//.exec(process.argv.slice(2).join(" "))?.[1];
if (!runs[sha]) { process.stderr.write("Not Found"); process.exit(1); }
for (const r of runs[sha]) process.stdout.write(JSON.stringify({ app: "github-actions", name: r.name, status: r.status, conclusion: r.conclusion, started_at: r.started_at }) + "\\n");
`);
  chmodSync(join(bin, "gh"), 0o755);
  // a green suite receipt for each SHA (synthetic: this test is about the CI half of the gate)
  const receipt = sha => { const f = join(bin, `${sha}.json`); writeFileSync(f, JSON.stringify({ repository: product, sha: git(product, "rev-parse", sha), tree: git(product, "rev-parse", `${sha}^{tree}`), green: true })); return f; };
  const { store } = registeredLoop(product, { protectedBranches: ["rewrite", "main"], require: CURRENT, files: {
    "metrics/trajectory.jsonl": convergence(failed) + convergence(rewrite, { round: 2 }),
    ...judgeEvidence(failed), ...judgeEvidence(rewrite, { round: 2 }),
    "metrics/handoffs.jsonl": judgeEvidence(failed)["metrics/handoffs.jsonl"] + judgeEvidence(rewrite, { round: 2 })["metrics/handoffs.jsonl"] } });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  const push = (sha, branch = "rewrite") => gatedPush(["--repo", product, "--owner-store", store, "--branch", branch, "--sha", sha, "--suite-receipt", receipt(sha), "--dry-run"], env);
  const red = push(failed);
  assert.equal(red.status, 2, red.stderr);
  assert.match(red.stderr, /github-actions\/verify: completed\/failure/);
  const green = push(rewrite);
  assert.equal(green.status, 0, green.stderr);
  assert.match(green.stdout, new RegExp(`would push ${rewrite.slice(0, 7)}`));
  const working = push(failed, "loop/work");
  assert.equal(working.status, 0, "a working branch is not gated by CI or a ruling");
});

test("every push needs a green suite-green receipt for that exact commit of that repository, checked before pushing", () => {
  const product = repo({ "a.txt": "1\n" });
  const bare = temp("bare-"); git(bare, "init", "-q", "--bare");
  git(product, "remote", "add", "origin", bare);
  const sha = git(product, "rev-parse", "HEAD");
  const other = repo({ "b.txt": "2\n" });
  const push = suite => pushCommit({ repo: product, sha, suite, branch: "work" });
  assert.match(push(undefined).refused, /no suite receipt/);
  assert.match(push({ repository: product, sha, green: false, reasons: ["2 test(s) failed"] }).refused, /not green .*2 test\(s\) failed/);
  assert.match(push({ repository: product, sha: "f".repeat(40), green: true }).refused, /receipt is for fffffff/);
  assert.match(push({ repository: other, sha, green: true }).refused, /receipt is for/);
  assert.equal(spawnSync("git", ["-C", bare, "rev-parse", "--verify", "-q", "refs/heads/work"]).status, 1, "nothing was pushed");
  // the receipt suite-green.mjs writes is accepted as is
  const out = join(temp(), "suite");
  writeFileSync(join(product, "t.test.mjs"), "import test from 'node:test';\ntest('ok', () => {});\n");
  git(product, "add", "t.test.mjs"); git(product, "commit", "-qm", "test");
  const head = git(product, "rev-parse", "HEAD");
  assert.equal(spawnSync(process.execPath, [join(scripts, "suite-green.mjs"), "--repo", product, "--sha", head, "--command", "node --test", "--out", out]).status, 0);
  const { store } = registeredLoop(product);
  const cli = gatedPush(["--repo", product, "--owner-store", store, "--branch", "work", "--suite-receipt", `${out}.json`]);
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(git(bare, "rev-parse", "refs/heads/work"), head);
  const stale = gatedPush(["--repo", product, "--owner-store", store, "--branch", "work", "--suite-receipt", `${out}.json`, "--sha", sha]);
  assert.equal(stale.status, 2, "a receipt of another commit is refused");
});

const convergence = (commit, fields = {}) => JSON.stringify({ round: 1, phase: "S5", role: "judge", verdict: "CONVERGED", commit, ...fields }) + "\n";

function judgeEvidence(commit, { round = 1, phase = "S5", report = "VERDICT: CONVERGED\nACCEPTANCE: pass" } = {}) {
  const n = String(round).padStart(4, "0");
  const record = `rounds/${n}-judge.md`, sealed = `sealed/judge/${n}/judge-1.md`;
  const handoff = { id: `R-${n}-judge`, role: "judge", step: "judge", phase, round, record, files: [record, sealed],
    product: { base: commit, commit }, view: "a".repeat(40), attempt: 1, agent: { runner: "claude" }, audit: { violations: 0 } };
  return {
    "metrics/handoffs.jsonl": JSON.stringify(handoff) + "\n", [record]: "# Public report\n",
    [sealed]: "# Judge\n\n## Task (verbatim)\n\n```text\nVERDICT: CONVERGED\nACCEPTANCE: pass\n```\n\n## Report (verbatim)\n\n" + report + "\n",
  };
}

test("protected push requires a committed judge convergence for its SHA and current green CI", () => {
  const product = repo({ "product.txt": "work\n" });
  const sha = git(product, "rev-parse", "HEAD");
  git(product, "remote", "add", "origin", "https://github.com/example/product.git");
  const records = repo({ "metrics/trajectory.jsonl": convergence(sha, { verdict: "CONTINUE" }) });
  const push = (overrides = {}) => pushCommit({ repo: product, records, sha, branch: "main", protectedBranches: ["main"],
    require: ["github-actions/verify"], suite: { repository: product, sha, tree: git(product, "--no-replace-objects", "rev-parse", `${sha}^{tree}`), green: true }, fetchRuns: () => [green()], dry: true, ...overrides });
  assert.match(push().refused, /judge.*CONVERGED/);
  assert.match(push({ records: undefined }).refused, /no records repository/);
  assert.match(push({ require: null }).refused, /does not configure gates\.require/);
  const trajectory = join(records, "metrics/trajectory.jsonl");
  writeFileSync(trajectory, convergence(sha));
  assert.match(push().refused, /judge.*CONVERGED/, "an uncommitted ruling cannot authorize promotion");
  writeFileSync(trajectory, convergence(sha, { role: "reviewer" }) + convergence("a".repeat(40)));
  git(records, "commit", "-qam", "other rulings");
  assert.match(push().refused, /judge.*CONVERGED/, "only a judge's ruling on this SHA counts");
  writeFileSync(trajectory, convergence(sha));
  git(records, "commit", "-qam", "lead transcribes convergence");
  assert.match(push().refused, /judge.*CONVERGED/, "a committed trajectory row needs the judge's own ruling");
  const publish = (fields, message) => {
    for (const [path, text] of Object.entries(judgeEvidence(sha, fields))) {
      mkdirSync(join(records, path, ".."), { recursive: true });
      writeFileSync(join(records, path), text);
    }
    git(records, "add", "-A");
    git(records, "commit", "-qm", message);
  };
  publish({ phase: "S4" }, "wrong phase");
  assert.match(push().refused, /judge.*CONVERGED/);
  publish({ report: "VERDICT: CONTINUE\nACCEPTANCE: pass" }, "judge continues");
  assert.match(push().refused, /judge.*CONVERGED/);
  publish({ report: "VERDICT: CONVERGED\nACCEPTANCE: fail" }, "acceptance failed");
  assert.match(push().refused, /judge.*CONVERGED/);
  publish({ report: "VERDICT: CONVERGED\nVERDICT: CONTINUE\nACCEPTANCE: pass" }, "conflicting ruling");
  assert.match(push().refused, /judge.*CONVERGED/);
  publish({}, "committed judge convergence and acceptance");
  assert.equal(push().refused, undefined);
  assert.deepEqual(push({ require: [], fetchRuns: () => assert.fail("no check is read") }).verdict, undefined);
  assert.match(push({ fetchRuns: () => [] }).refused, /has not passed every required check/);
});

test("protected push inherits second-parent convergence only for a same-tree merge, with CI on the merge SHA", () => {
  const product = repo({ "product.txt": "work\n" });
  const judged = git(product, "rev-parse", "HEAD");
  git(product, "remote", "add", "origin", "https://github.com/example/product.git");
  const records = repo({ "metrics/trajectory.jsonl": convergence(judged), ...judgeEvidence(judged) });
  const tree = git(product, "rev-parse", "HEAD^{tree}");
  const other = git(product, "commit-tree", tree, "-m", "other parent");
  const merge = git(product, "commit-tree", tree, "-p", other, "-p", judged, "-m", "same-tree integration");
  const reversed = git(product, "commit-tree", tree, "-p", judged, "-p", other, "-m", "reversed parents");
  writeFileSync(join(product, "product.txt"), "changed\n");
  git(product, "add", "product.txt");
  const changed = git(product, "commit-tree", git(product, "write-tree"), "-p", other, "-p", judged, "-m", "changed integration");
  const queried = [];
  const push = sha => pushCommit({ repo: product, records, sha, branch: "main", protectedBranches: ["main"], require: ["github-actions/verify"],
    suite: { repository: product, sha, tree: git(product, "--no-replace-objects", "rev-parse", `${sha}^{tree}`), green: true }, fetchRuns: (_, commit) => { queried.push(commit); return [green()]; }, dry: true });
  assert.equal(push(merge).refused, undefined);
  assert.match(push(reversed).refused, /judge.*CONVERGED/);
  assert.match(push(changed).refused, /judge.*CONVERGED/);
  assert.deepEqual(queried, [merge]);
});

test("one push destination: several push URLs are refused by every reader, naming each URL and both ways out", () => {
  const product = repo({ "a.txt": "1\n" });
  const sha = git(product, "rev-parse", "HEAD");
  const [first, second] = [temp("first-"), temp("second-")];
  for (const bare of [first, second]) git(bare, "init", "-q", "--bare");
  git(product, "remote", "add", "origin", "https://github.com/example/fetch.git");
  git(product, "remote", "set-url", "--push", "origin", "https://github.com/example/push.git");
  git(product, "remote", "set-url", "--add", "--push", "origin", "git@github.com:example/mirror.git");
  assert.throws(() => pushDestination(product), e => e instanceof DestinationError
    && /https:\/\/github\.com\/example\/push\.git, git@github\.com:example\/mirror\.git/.test(e.message)
    && /its own remote/.test(e.message) && /remove the extra push URL/.test(e.message));
  const queried = [];
  const reading = ciGreen({ repo: product, sha, require: ["github-actions/verify"], fetchRuns: dest => { queried.push(dest.repository); return [green()]; } });
  assert.deepEqual([reading.ci, reading.ok, reading.repository, reading.sha, queried], ["unknown", false, null, sha, []]);
  assert.match(reading.error, /example\/mirror\.git/);
  assert.deepEqual(reading.missing, [reading.error]);
  const suite = { repository: product, sha, tree: git(product, "--no-replace-objects", "rev-parse", `${sha}^{tree}`), green: true };
  assert.match(pushCommit({ repo: product, sha, suite, branch: "work" }).refused, /2 push URLs/, "a working branch too");
  git(product, "config", "--unset-all", "remote.origin.pushurl");
  git(product, "remote", "set-url", "--push", "origin", first);
  git(product, "remote", "set-url", "--add", "--push", "origin", second);
  assert.match(pushCommit({ repo: product, sha, suite, branch: "work" }).refused, /2 push URLs/);
  for (const bare of [first, second]) assert.equal(git(bare, "for-each-ref"), "", "nothing was pushed");
  git(product, "remote", "set-url", "--delete", "--push", "origin", second);
  assert.equal(pushDestination(product), first);
  assert.equal(pushCommit({ repo: product, sha, suite, branch: "work" }).pushed, true);
  assert.deepEqual([git(first, "rev-parse", "work"), git(second, "for-each-ref")], [sha, ""]);
  assert.throws(() => pushDestination(product, "absent"), DestinationError);
  assert.throws(() => pushDestination(product, "--all"), DestinationError);
});

test("gated-push takes its remote, protected branches, checks and records from the one registered loop of the product", () => {
  const product = repo({ "a.txt": "1\n" });
  const sha = git(product, "rev-parse", "HEAD");
  const [origin, mirror] = [temp("origin-"), temp("mirror-")];
  for (const bare of [origin, mirror]) git(bare, "init", "-q", "--bare");
  git(product, "remote", "add", "origin", origin);
  git(product, "remote", "add", "mirror", mirror);
  const receipt = join(temp(), "suite.json");
  writeFileSync(receipt, JSON.stringify({ repository: product, sha, tree: git(product, "--no-replace-objects", "rev-parse", `${sha}^{tree}`), green: true }));
  const { store, records } = registeredLoop(product, { remote: "mirror" });
  const push = (...extra) => gatedPush(["--repo", product, "--branch", "work", "--suite-receipt", receipt, "--owner-store", store, ...extra]);
  const refs = () => [git(origin, "for-each-ref"), git(mirror, "for-each-ref")];
  for (const [flag, value] of [["--protected", "release"], ["--require", "github-actions/other"], ["--remote", "origin"], ["--records", records]]) {
    const r = push(flag, value);
    assert.equal(r.status, 64, r.stderr);
    assert.match(r.stderr, new RegExp(`${flag} was removed`));
  }
  assert.equal(push("--force").status, 64);
  assert.deepEqual(refs(), ["", ""]);
  const main = gatedPush(["--repo", product, "--branch", "main", "--suite-receipt", receipt, "--owner-store", store]);
  assert.equal(main.status, 2, main.stderr);
  assert.match(main.stderr, /main is protected: no judge CONVERGED ruling/);
  const ok = push();
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual([git(origin, "for-each-ref"), git(mirror, "rev-parse", "work")], ["", sha], "the loop's gates.remote, not origin");

  const empty = temp("owner-store-");
  writeFileSync(join(empty, "products.json"), JSON.stringify({ products: [] }));
  const none = gatedPush(["--repo", product, "--branch", "work", "--suite-receipt", receipt, "--owner-store", empty]);
  assert.equal(none.status, 2);
  assert.match(none.stderr, /no registered product's loop\.json names/);
  const missing = gatedPush(["--repo", product, "--branch", "work", "--suite-receipt", receipt, "--owner-store", temp("no-store-")]);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /no product registry/);

  const linked = join(temp(), "linked");
  git(product, "worktree", "add", "-q", "--detach", linked, sha);
  const second = registeredLoop(linked, { name: "second" });
  writeFileSync(join(store, "products.json"), JSON.stringify({ products: [{ name: "product", records }, { name: "second", records: second.records }] }));
  const twice = push();
  assert.equal(twice.status, 2);
  assert.match(twice.stderr, /2 registered loops: product \(.*\), second \(/);

  writeFileSync(join(second.records, "loop.json"), JSON.stringify({ product: linked }));
  writeFileSync(join(store, "products.json"), JSON.stringify({ products: [{ name: "second", records: second.records }] }));
  const broken = push();
  assert.equal(broken.status, 2);
  assert.match(broken.stderr, /second \(.*\): .*config needs "records"/);
});

function hostGh(served) {
  const bin = temp("gh-hosts-");
  const log = join(bin, "log");
  writeFileSync(join(bin, "runs.json"), JSON.stringify(served));
  writeFileSync(join(bin, "gh"), `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require("node:fs");
const args = process.argv.slice(2);
const flag = args.indexOf("--hostname");
const host = flag >= 0 ? args[flag + 1] : process.env.GH_HOST || "github.com";
const m = /^repos\\/([^/]+\\/[^/]+)\\/commits\\/([0-9a-f]{40})\\/check-runs\\?/.exec(args.find(a => a.startsWith("repos/")) ?? "");
if (args[0] !== "api" || !m) process.exit(78);
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ host, repository: m[1], sha: m[2] }) + "\\n");
const runs = JSON.parse(readFileSync(${JSON.stringify(join(bin, "runs.json"))}, "utf8"))[host]?.[m[1]]?.[m[2]];
if (!Array.isArray(runs)) process.exit(1);
for (const run of runs) console.log(JSON.stringify(run));
`, { mode: 0o755 });
  const reads = () => { try { return readFileSync(log, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)); } catch { return []; } };
  return { env: extra => ({ ...process.env, PATH: `${bin}:${process.env.PATH}`, ...extra }), reads };
}

const ciGreenCli = (args, env) => spawnSync(process.execPath, [join(scripts, "ci-green.mjs"), ...args], { encoding: "utf8", env });

test("R6-1: the identity of a push URL is its forge, host and repository; unsupported hosts have forge: null", () => {
  const cases = [
    ["https://github.com/example/product.git", { forge: "github", host: "github.com", region: null, repository: "example/product", profile: null }],
    ["https://x-access-token:secret@GitHub.com/example/product", { forge: "github", host: "github.com", region: null, repository: "example/product", profile: null }],
    ["ssh://git@github.com/example/product.git", { forge: "github", host: "github.com", region: null, repository: "example/product", profile: null }],
    ["git@github.com:example/product.git", { forge: "github", host: "github.com", region: null, repository: "example/product", profile: null }],
    ["https://ghe.example.com/example/product.git", { forge: null, host: "ghe.example.com", region: null, repository: "example/product", profile: null }],
    ["git@ghe.example.com:example/product.git", { forge: null, host: "ghe.example.com", region: null, repository: "example/product", profile: null }],
    ["https://github.com:8443/example/product.git", { forge: null, host: "github.com:8443", region: null, repository: "example/product", profile: null }],
    ["/srv/git/github.com/example/product.git", null],
    ["file:///srv/git/example/product.git", null],
    ["https://github.com/example/product/extra", null],
  ];
  for (const [url, identity] of cases) assert.deepEqual(parseDestination(url), identity, url);
  assert.deepEqual(cases.map(([url]) => { const d = parseDestination(url); return d?.forge ? d.repository : null; }), ["example/product", "example/product", "example/product", "example/product", null, null, null, null, null, null]);
});

test("R6-1: CI is read only from the API of the destination's host, whatever host gh would choose, and every reading names host and repository", () => {
  const product = repo({ "a.txt": "1\n" });
  const sha = git(product, "rev-parse", "HEAD");
  git(product, "remote", "add", "origin", "https://github.com/example/product.git");
  const gh = hostGh({
    "github.com": { "example/product": { [sha]: [green("verify", "github-actions", "failure")] } },
    "ghe.example.com": { "example/product": { [sha]: [green()] } },
  });
  const require = ["--repo", product, "--sha", sha, "--require", "github-actions/verify"];
  for (const extra of [{ GH_HOST: "ghe.example.com" }, {}]) {
    const r = ciGreenCli(require, gh.env(extra));
    assert.equal(r.status, 2, r.stderr);
    const reading = JSON.parse(r.stdout);
    assert.deepEqual([reading.host, reading.repository, reading.ci], ["github.com", "example/product", "failure"], JSON.stringify(extra));
  }
  assert.deepEqual(gh.reads().map(r => r.host), ["github.com", "github.com"], "the mirror's green check on another host is never read");
  const records = repo({ "metrics/trajectory.jsonl": convergence(sha), ...judgeEvidence(sha) });
  const { store } = registeredLoop(product, { files: { "metrics/trajectory.jsonl": convergence(sha), ...judgeEvidence(sha) } });
  const suite = join(temp(), "suite.json");
  writeFileSync(suite, JSON.stringify({ repository: product, sha, tree: git(product, "--no-replace-objects", "rev-parse", `${sha}^{tree}`), green: true }));
  const promote = env => gatedPush(["--repo", product, "--owner-store", store, "--branch", "main", "--suite-receipt", suite, "--dry-run"], env);
  const refused = promote(gh.env({ GH_HOST: "ghe.example.com" }));
  assert.equal(refused.status, 2, refused.stderr);
  assert.match(refused.stderr, /github\.com\/example\/product/);

  git(product, "remote", "set-url", "origin", "https://ghe.example.com/example/product.git");
  const before = gh.reads().length;
  const other = ciGreenCli(require, gh.env({ GH_HOST: "ghe.example.com" }));
  assert.equal(other.status, 2);
  const unread = JSON.parse(other.stdout);
  assert.deepEqual([unread.ci, unread.host, unread.repository], ["unknown", null, null]);
  assert.match(unread.error, /its host is ghe\.example\.com/);
  assert.equal(gh.reads().length, before, "nothing is read on a host that is not the destination's CI host");
  const blocked = promote(gh.env({ GH_HOST: "ghe.example.com" }));
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /cannot be read: .*ghe\.example\.com/);
  assert.equal(pushCommit({ repo: product, records, sha, suite: { repository: product, sha, tree: git(product, "--no-replace-objects", "rev-parse", `${sha}^{tree}`), green: true }, branch: "work", protectedBranches: ["main"], require: ["github-actions/verify"], dry: true }).refused,
    undefined, "a working branch to another host needs no CI and is still published");
  assert.deepEqual(readCi({ product, remote: "origin", require: ["github-actions/verify"] }, sha).ci, "unknown");
  git(product, "remote", "set-url", "origin", "https://ops:secret@ghe.example.com/example/product.git");
  assert.doesNotMatch(JSON.parse(ciGreenCli(require, gh.env()).stdout).error, /secret/, "a credential in the URL never reaches a receipt");
});

function versioned() {
  const product = repo({ VERSION: "1.0.0\n", "a.txt": "1\n" });
  const bare = temp("bare-"); git(bare, "init", "-q", "--bare");
  git(product, "remote", "add", "origin", bare);
  const parent = git(product, "rev-parse", "HEAD");
  const child = (files, base = parent) => {
    git(product, "read-tree", base);
    for (const [path, text] of Object.entries(files)) { writeFileSync(join(product, path), text); git(product, "add", path); }
    const sha = git(product, "commit-tree", git(product, "write-tree"), "-p", base, "-m", Object.values(files).join(" ").trim());
    git(product, "read-tree", "HEAD");
    git(product, "checkout", "-q", "--", ".");
    return sha;
  };
  const suite = (sha, ...extra) => {
    const out = join(temp(), "suite");
    const r = spawnSync(process.execPath, [join(scripts, "suite-green.mjs"), "--repo", product, "--sha", sha, "--command", "test -f a.txt", "--out", out, ...extra], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return `${out}.json`;
  };
  return { product, bare, parent, child, suite, tree: sha => git(product, "rev-parse", `${sha}^{tree}`) };
}

test("R6-2: gated-push compares the receipt's measured tree with the tree of the commit it publishes; a VERSION-only commit only by a varied run of its exact VERSION", () => {
  const p = versioned();
  const { store } = registeredLoop(p.product);
  const push = (sha, receipt) => gatedPush(["--repo", p.product, "--owner-store", store, "--branch", "work", "--sha", sha, "--suite-receipt", receipt]);
  const pushed = () => spawnSync("git", ["-C", p.bare, "rev-parse", "--verify", "-q", "refs/heads/work"], { encoding: "utf8" }).stdout.trim();
  const varied = p.suite(p.parent, "--vary-version", "1.0.1-rc.1");
  const variedTree = JSON.parse(readFileSync(varied, "utf8")).tree;
  const own = push(p.parent, varied);
  assert.equal(own.status, 2, own.stderr);
  assert.ok(own.stderr.includes(variedTree) && own.stderr.includes(p.tree(p.parent)), own.stderr);
  assert.equal(pushed(), "", "nothing was pushed");
  const other = p.child({ VERSION: "1.0.1-rc.2\n" });
  const wrongVersion = push(other, varied);
  assert.equal(wrongVersion.status, 2);
  assert.ok(wrongVersion.stderr.includes(variedTree) && wrongVersion.stderr.includes(p.tree(other)), wrongVersion.stderr);
  const more = p.child({ VERSION: "1.0.1-rc.1\n", "a.txt": "2\n" });
  assert.equal(push(more, varied).status, 2, "a child that changes more than VERSION is not covered");
  const plain = p.suite(p.parent);
  const tip = p.child({ VERSION: "1.0.1-rc.1\n" });
  const stale = push(tip, plain);
  assert.equal(stale.status, 2);
  assert.ok(stale.stderr.includes(p.tree(p.parent)) && stale.stderr.includes(p.tree(tip)), stale.stderr);
  const edited = join(temp(), "edited.json");
  writeFileSync(edited, JSON.stringify({ ...JSON.parse(readFileSync(plain, "utf8")), tree: p.tree(tip) }));
  const forged = push(p.parent, edited);
  assert.equal(forged.status, 2);
  assert.ok(forged.stderr.includes(p.tree(tip)) && forged.stderr.includes(p.tree(p.parent)), forged.stderr);
  assert.equal(pushed(), "");
  const ok = push(tip, varied);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(pushed(), tip, "the VERSION-only child is published on the varied run of its exact VERSION");
  const own2 = push(tip, p.suite(tip));
  assert.equal(own2.status, 0, own2.stderr);
});

test("flow: publication after upgrading old evidence; loss: false-verdict; unknown measured trees require a fresh suite", () => {
  const p = versioned();
  const sha = p.parent;
  assert.match(pushCommit({ repo: p.product, sha, suite: { repository: p.product, sha, green: true }, branch: "work", dry: true }).refused, /measured tree \(none named\)/);
  assert.match(pushCommit({ repo: p.product, sha, suite: { repository: p.product, sha, green: true, versionVaried: "1.0.0" }, branch: "work", dry: true }).refused, /measured tree \(none named\)/);
});

test("a local replacement neither satisfies nor changes a gated push: the receipt is checked against the tree Git publishes, both trees named", () => {
  const p = versioned();
  const { store } = registeredLoop(p.product);
  const push = (sha, receipt) => gatedPush(["--repo", p.product, "--owner-store", store, "--branch", "work", "--sha", sha, "--suite-receipt", receipt]);
  const tip = p.child({ VERSION: "1.0.1-rc.1\n" });
  const more = p.child({ VERSION: "1.0.1-rc.1\n", "a.txt": "2\n" });
  const [tipTree, moreTree] = [p.tree(tip), p.tree(more)];
  const varied = p.suite(p.parent, "--vary-version", "1.0.1-rc.1");
  git(p.product, "replace", more, tip);
  const satisfied = push(more, varied);
  assert.equal(satisfied.status, 2, satisfied.stderr);
  assert.ok(satisfied.stderr.includes(moreTree) && satisfied.stderr.includes(tipTree), satisfied.stderr);
  git(p.product, "replace", "-d", more);
  git(p.product, "replace", tip, more);
  const measured = JSON.parse(readFileSync(p.suite(tip), "utf8"));
  assert.equal(measured.tree, tipTree);
  const viewed = join(temp(), "viewed.json");
  writeFileSync(viewed, JSON.stringify({ ...measured, tree: moreTree }));
  const stale = push(tip, viewed);
  assert.equal(stale.status, 2, stale.stderr);
  assert.ok(stale.stderr.includes(moreTree) && stale.stderr.includes(tipTree), stale.stderr);
  const published = push(tip, varied);
  assert.equal(published.status, 0, published.stderr);
  assert.equal(git(p.bare, "rev-parse", "refs/heads/work^{tree}"), tipTree);
});

test("a local replacement neither grants nor withholds a protected push's judge coverage", () => {
  const product = repo({ VERSION: "1.0.0\n", "product.txt": "work\n" });
  const judged = git(product, "rev-parse", "HEAD");
  git(product, "remote", "add", "origin", "https://github.com/example/product.git");
  const records = repo({ "metrics/trajectory.jsonl": convergence(judged), ...judgeEvidence(judged) });
  const child = files => {
    for (const [path, text] of Object.entries(files)) { writeFileSync(join(product, path), text); git(product, "add", path); }
    const sha = git(product, "commit-tree", git(product, "write-tree"), "-p", judged, "-m", "child");
    git(product, "reset", "-q", "--hard", judged);
    return sha;
  };
  const tip = child({ VERSION: "1.0.1\n" });
  const unruled = child({ VERSION: "1.0.1\n", "product.txt": "never judged\n" });
  const push = sha => pushCommit({ repo: product, records, sha, branch: "main", protectedBranches: ["main"], require: [],
    suite: { repository: product, sha, tree: git(product, "--no-replace-objects", "rev-parse", `${sha}^{tree}`), green: true }, dry: true });
  git(product, "replace", unruled, tip);
  assert.match(push(unruled).refused, /judge.*CONVERGED/);
  git(product, "replace", "-d", unruled);
  git(product, "replace", tip, unruled);
  assert.equal(push(tip).refused, undefined);
});

test("R6-6: Git names the remote: any name Git accepts, with dots or slashes, resolves; a name Git does not know is refused", () => {
  const product = repo({ "a.txt": "1\n" });
  const sha = git(product, "rev-parse", "HEAD");
  const bares = ["team", "mirror", "dash"].map(name => { const b = temp(`${name}-`); git(b, "init", "-q", "--bare"); return b; });
  git(product, "remote", "add", "team/origin", bares[0]);
  git(product, "remote", "add", "my.mirror.v2", bares[1]);
  git(product, "config", "remote.-dash.url", bares[2]);
  const suite = { repository: product, sha, tree: git(product, "--no-replace-objects", "rev-parse", `${sha}^{tree}`), green: true };
  for (const [remote, bare] of [["team/origin", bares[0]], ["my.mirror.v2", bares[1]], ["-dash", bares[2]]]) {
    assert.equal(pushDestination(product, remote), bare, remote);
    const r = pushCommit({ repo: product, remote, sha, suite, branch: "work" });
    assert.equal(r.pushed, true, `${remote}: ${r.refused}`);
    assert.equal(git(bare, "rev-parse", "work"), sha);
  }
  for (const unknown of ["team", "absent/remote", "--all", ""]) assert.throws(() => pushDestination(product, unknown), e => e instanceof DestinationError && /Git knows no remote/.test(e.message), unknown);
  git(product, "remote", "add", "fork/gh", "https://github.com/example/fork.git");
  const reading = ciGreen({ repo: product, remote: "fork/gh", sha, require: ["github-actions/verify"], fetchRuns: dest => (dest.repository === "example/fork" ? [green()] : []) });
  assert.deepEqual([reading.host, reading.repository, reading.ci], ["github.com", "example/fork", "success"]);
  const { store } = registeredLoop(product, { remote: "team/origin" });
  const receipt = join(temp(), "suite.json");
  writeFileSync(receipt, JSON.stringify(suite));
  const cli = gatedPush(["--repo", product, "--owner-store", store, "--branch", "next", "--suite-receipt", receipt]);
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(git(bares[0], "rev-parse", "next"), sha);
});

function rawLoop(product, fields, files = {}) {
  const records = repo({ "records.json": "{}\n", ...files });
  writeFileSync(join(records, "loop.json"), JSON.stringify({ product, records, workDir: temp("work-"), phase: "S5", briefs: {}, agents: {}, ...fields }, null, 2) + "\n");
  git(records, "add", "-A");
  git(records, "commit", "-qm", "loop");
  const store = temp("owner-store-");
  writeFileSync(join(store, "products.json"), JSON.stringify({ products: [{ name: "product", records }] }));
  return { records, store };
}

test("R6-7: a registered loop without \"protected\" or \"gates.require\" is unconfigured: every gated push refuses with the migration; explicit [] is a decision", () => {
  const product = repo({ "a.txt": "1\n" });
  const sha = git(product, "rev-parse", "HEAD");
  const bare = temp("bare-"); git(bare, "init", "-q", "--bare");
  git(product, "remote", "add", "origin", bare);
  const receipt = join(temp(), "suite.json");
  writeFileSync(receipt, JSON.stringify({ repository: product, sha, tree: git(product, "--no-replace-objects", "rev-parse", `${sha}^{tree}`), green: true }));
  const push = (store, branch, env) => gatedPush(["--repo", product, "--owner-store", store, "--branch", branch, "--suite-receipt", receipt], env);
  const require = ["github-actions/verify"];
  for (const [fields, missing] of [
    [{ gates: { require } }, /no "protected"/],
    [{ protected: ["main"] }, /no "gates\.require"/],
    [{ protected: ["main"], gates: { remote: "origin" } }, /no "gates\.require"/],
    [{}, /no "protected" and no "gates\.require"/],
  ]) {
    for (const branch of ["main", "work"]) {
      const r = push(rawLoop(product, fields).store, branch);
      assert.equal(r.status, 2, `${JSON.stringify(fields)} ${branch}: ${r.stderr}`);
      assert.match(r.stderr, /unconfigured/);
      assert.match(r.stderr, missing);
      assert.match(r.stderr, /"protected": \[\] protects no branch, "require": \[\] requires no check/);
    }
  }
  for (const fields of [{ protected: null, gates: { require } }, { protected: "main", gates: { require } }, { protected: ["main"], gates: { require: null } }]) {
    const r = push(rawLoop(product, fields).store, "work");
    assert.equal(r.status, 2, JSON.stringify(fields));
    assert.match(r.stderr, /must be a list/);
  }
  assert.equal(git(bare, "for-each-ref"), "", "nothing was pushed");

  const open = push(rawLoop(product, { protected: [], gates: { require } }).store, "main");
  assert.equal(open.status, 0, open.stderr);
  assert.equal(git(bare, "rev-parse", "main"), sha, "\"protected\": [] protects no branch");

  const gh = hostGh({});
  const judged = rawLoop(product, { protected: ["release"], gates: { require: [] } }, { "metrics/trajectory.jsonl": convergence(sha), ...judgeEvidence(sha) });
  const noChecks = push(judged.store, "release", gh.env());
  assert.equal(noChecks.status, 0, noChecks.stderr);
  assert.match(noChecks.stdout, /no check required/);
  assert.deepEqual(gh.reads(), [], "\"require\": [] reads no CI");
  const unjudged = push(rawLoop(product, { protected: ["release"], gates: { require: [] } }).store, "release", gh.env());
  assert.equal(unjudged.status, 2, "a protected branch still needs the judge's convergence");
  assert.match(unjudged.stderr, /no judge CONVERGED ruling/);
});

test("R6-7: policyOf reads the loop's own keys, never defaults standing in for them", () => {
  const require = ["github-actions/verify"];
  assert.deepEqual(policyOf({ protected: ["main"], gates: { require } }), { remote: "origin", require, protected: ["main"] });
  assert.deepEqual(policyOf({ protected: [], gates: { require: [], remote: "team/origin" } }), { remote: "team/origin", require: [], protected: [] });
  assert.deepEqual(policyOf({ protected: ["main"], gates: { require: "github-actions/verify, github-actions/lint" } }).require, ["github-actions/verify", "github-actions/lint"]);
  for (const raw of [{}, { protected: ["main"] }, { gates: { require } }, { protected: ["main"], gates: null }]) assert.match(policyOf(raw).refused, /unconfigured/, JSON.stringify(raw));
  assert.match(policyOf({ protected: ["main", 3], gates: { require } }).refused, /must be a list of branch names/);
  assert.match(policyOf({ protected: ["main"], gates: { require, remote: 7 } }).refused, /must name a Git remote/);
});

test("flow: a configured remote includes its default transport port; loss: false-verdict; semantic destinations agree while alternate ports stay separate", () => {
  for (const url of ["https://GitHub.com:443/Example/Product.git", "ssh://git@github.com:22/example/product.git", "git@github.com:example/product.git", "https://github.com./example/product/"])
    assert.deepEqual(parseDestination(url), { forge: "github", host: "github.com", region: null, repository: "example/product", profile: null });
  assert.deepEqual(parseDestination("ssh://git@github.com:2222/example/product"), { forge: null, host: "github.com:2222", region: null, repository: "example/product", profile: null });
});
