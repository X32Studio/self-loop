// D-0009 item 2: a pushed tip is valid for a ruling on an earlier SHA when the only file between them is VERSION.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { pushCommit } from "../lib/ci.mjs";
import { tipProblem } from "../lib/tip.mjs";
import { fakeGh, git, green, loopProduct, repo, roomyStore, scripts, temp } from "./helpers.mjs";

/** The one required check's run as GitHub serves it: run `id` of github-actions/verify, completed with `conclusion`. */
const served = (conclusion = "success", id = 1) => conclusion === "pending"
  ? { id, app: "github-actions", name: "verify", status: "in_progress", conclusion: null }
  : { id, app: "github-actions", name: "verify", status: "completed", conclusion };

/** A records repository whose loop.json is the loop of `product` (phase v1, one required check), and its ledger. */
function loopRecords(product) {
  const records = repo({ "README.md": "# records\n", "metrics/.keep": "", "loop.json": JSON.stringify({ product, records: ".", workDir: temp(), phase: "v1",
    briefs: {}, agents: {}, gates: { require: ["github-actions/verify"] } }) + "\n" });
  return { records, file: join(records, "metrics", "trajectory.jsonl") };
}

function history() {
  const product = repo({ "VERSION": "1.0.0\n", "src/a.js": "a\n" });
  git(product, "remote", "add", "origin", "https://github.com/o/r.git"); // where the receipts below read CI
  const ruled = git(product, "rev-parse", "HEAD");
  const commit = (files, message, parent = "HEAD") => {
    git(product, "checkout", "-q", "--detach", parent);
    for (const [path, text] of Object.entries(files)) writeFileSync(join(product, path), text);
    git(product, "add", "-A");
    git(product, "commit", "-qm", message);
    return git(product, "rev-parse", "HEAD");
  };
  const tip = commit({ VERSION: "1.0.1\n" }, "1.0.1", ruled);
  const twice = commit({ VERSION: "1.0.2\n" }, "1.0.2", tip);
  const code = commit({ VERSION: "1.0.1\n", "src/a.js": "b\n" }, "version and code", ruled);
  const codeOnly = commit({ "src/a.js": "c\n" }, "code", ruled);
  return { product, ruled, tip, twice, code, codeOnly };
}

test("a VERSION-only tip may carry a prerelease (a round's candidate) or a release, in either order", () => {
  const product = repo({ "VERSION": "0.4.3\n", "src/a.js": "a\n" });
  const ruled = git(product, "rev-parse", "HEAD");
  const raise = version => { writeFileSync(join(product, "VERSION"), `${version}\n`); git(product, "commit", "-qam", version); return git(product, "rev-parse", "HEAD"); };
  const candidate = raise("0.4.4-v1.5");
  assert.equal(tipProblem(product, ruled, candidate), null);
  assert.equal(tipProblem(product, ruled, raise("0.4.4")), null, "the release after the candidate is still VERSION-only");
  assert.equal(tipProblem(product, candidate, raise("0.4.5-v1.6")), null);
});

test("only VERSION may differ between the ruled SHA and the pushed tip, and the tip follows the ruling", () => {
  const h = history();
  assert.equal(tipProblem(h.product, h.ruled, h.ruled), null);
  assert.equal(tipProblem(h.product, h.ruled, h.tip), null);
  assert.equal(tipProblem(h.product, h.ruled, h.twice), null, "several VERSION-only commits");
  assert.match(tipProblem(h.product, h.ruled, h.code), /src\/a\.js/);
  assert.match(tipProblem(h.product, h.ruled, h.codeOnly), /src\/a\.js/);
  assert.match(tipProblem(h.product, h.tip, h.ruled), /does not follow/);
  assert.match(tipProblem(h.product, h.ruled, "f".repeat(40)), /not a commit/);
  const orphan = git(h.product, "commit-tree", git(h.product, "rev-parse", `${h.tip}^{tree}`), "-m", "same tree, no history");
  assert.match(tipProblem(h.product, h.ruled, orphan), /does not follow/);
  const sameTree = git(h.product, "commit-tree", git(h.product, "rev-parse", `${h.ruled}^{tree}`), "-p", h.ruled, "-m", "no change");
  assert.match(tipProblem(h.product, h.ruled, sameTree), /changes no file/, "D-0009: the difference is exactly VERSION");
  const merged = git(h.product, "commit-tree", git(h.product, "rev-parse", `${h.tip}^{tree}`), "-p", h.ruled, "-p", orphan, "-m", "merge in other history");
  assert.match(tipProblem(h.product, h.ruled, merged), /through merge/);
});

test("trajectory append names both SHAs only for a VERSION-only tip, and reads CI on the pushed SHA", () => {
  const h = history();
  const { file } = loopRecords(h.product);
  const gh = fakeGh({ "o/r": { [h.ruled]: [served("failure")], [h.tip]: [served()] } });
  const append = (...args) => spawnSync(process.execPath, [join(scripts, "trajectory.mjs"), "append", "--file", file, "--round", "1",
    "--phase", "v1", "--role", "judge", "--verdict", "CONTINUE", "--commit", h.ruled, ...args], { encoding: "utf8", env: gh.env });
  const rows = () => { try { return readFileSync(file, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)); } catch { return []; } };
  const refused = append("--tip", h.code);
  assert.equal(refused.status, 2, refused.stderr);
  assert.match(refused.stderr, /src\/a\.js/);
  assert.deepEqual([rows(), gh.queries()], [[], []], "a refused row is not appended and reads nothing");
  const ok = append("--tip", h.tip);
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual([rows()[0].commit, rows()[0].tip, rows()[0].ci], [h.ruled, h.tip, "success"], "CI is read on the tip");
  const plain = append();
  assert.equal(plain.status, 0, plain.stderr);
  assert.equal("tip" in rows()[1], false, "a row without a tip is unchanged");
  assert.equal(rows()[1].ci, "failure", "a row on the ruled SHA itself takes the ruled SHA's CI");
  assert.deepEqual(gh.queries(), [`o/r ${h.tip}`, `o/r ${h.ruled}`]);
});

const appendTip = (file, gh, ruled, tip) => spawnSync(process.execPath, [join(scripts, "trajectory.mjs"), "append", "--file", file, "--round", "1",
  "--phase", "v1", "--role", "judge", "--verdict", "CONTINUE", "--commit", ruled, "--tip", tip], { encoding: "utf8", env: gh.env });
const followsInView = (repo, from, to) => spawnSync("git", ["-C", repo, "merge-base", "--is-ancestor", from, to]).status === 0;

test("a local replacement does not make a tip VERSION-only: tipProblem and trajectory append --tip read the commits Git publishes", () => {
  const h = history();
  const { file } = loopRecords(h.product);
  const gh = fakeGh({ "o/r": { [h.code]: [served()] } });
  git(h.product, "replace", h.code, h.tip);
  assert.equal(git(h.product, "diff", "--name-only", h.ruled, h.code), "VERSION");
  assert.match(tipProblem(h.product, h.ruled, h.code), /changes src\/a\.js/);
  const unrelated = git(h.product, "commit-tree", git(h.product, "rev-parse", `${h.tip}^{tree}`), "-m", "no history");
  git(h.product, "replace", "--graft", unrelated, h.ruled);
  assert.equal(followsInView(h.product, h.ruled, unrelated), true);
  assert.match(tipProblem(h.product, h.ruled, unrelated), /does not follow/);
  const refused = appendTip(file, gh, h.ruled, h.code);
  assert.equal(refused.status, 2, refused.stderr);
  assert.match(refused.stderr, /changes src\/a\.js/);
  assert.deepEqual([existsSync(file) ? readFileSync(file, "utf8") : "", gh.queries()], ["", []]);
});

test("a local replacement does not take a VERSION-only tip's ruling away: tipProblem and trajectory append --tip read the commits Git publishes", () => {
  const h = history();
  const { file } = loopRecords(h.product);
  const gh = fakeGh({ "o/r": { [h.tip]: [served()] } });
  git(h.product, "replace", h.tip, h.code);
  assert.equal(git(h.product, "diff", "--name-only", h.ruled, h.tip), "VERSION\nsrc/a.js");
  assert.equal(tipProblem(h.product, h.ruled, h.tip), null);
  git(h.product, "replace", "-d", h.tip);
  git(h.product, "replace", "--graft", h.tip);
  assert.equal(followsInView(h.product, h.ruled, h.tip), false);
  assert.equal(tipProblem(h.product, h.ruled, h.tip), null);
  const ok = appendTip(file, gh, h.ruled, h.tip);
  assert.equal(ok.status, 0, ok.stderr);
  const [row] = readFileSync(file, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
  assert.deepEqual([row.commit, row.tip, row.ci], [h.ruled, h.tip, "success"]);
});

function judgeRecords(product, ruled) {
  const record = "rounds/0001-judge.md", sealed = "sealed/judge/0001/judge-1.md";
  const handoff = { id: "R-0001-judge", role: "judge", step: "judge", phase: "v1", round: 1, record, files: [record, sealed],
    product: { base: ruled, commit: ruled }, view: "a".repeat(40), attempt: 1, agent: { runner: "codex" }, audit: { violations: 0 } };
  return repo({
    "metrics/handoffs.jsonl": JSON.stringify(handoff) + "\n", [record]: "# Public report\n",
    [sealed]: "# Judge\n\n## Report (verbatim)\n\nVERDICT: CONVERGED\nACCEPTANCE: pass\n",
    "metrics/trajectory.jsonl": JSON.stringify({ round: 1, phase: "v1", role: "judge", verdict: "CONVERGED", commit: ruled, suite: "3/0" }) + "\n",
  });
}

test("the protected-branch push accepts a VERSION-only tip of a converged ruling, with CI read on the tip", () => {
  const h = history();
  git(h.product, "remote", "set-url", "origin", "https://github.com/example/product.git");
  const records = judgeRecords(h.product, h.ruled);
  const queried = [];
  const push = sha => pushCommit({ repo: h.product, records, sha, branch: "main", protectedBranches: ["main"], require: ["github-actions/verify"],
    suite: { repository: h.product, sha, tree: git(h.product, "rev-parse", `${sha}^{tree}`), green: true }, fetchRuns: (_, commit) => { queried.push(commit); return [green()]; }, dry: true });
  assert.equal(push(h.ruled).refused, undefined);
  assert.equal(push(h.tip).refused, undefined);
  assert.match(push(h.code).refused, /judge.*CONVERGED/);
  assert.match(push(h.codeOnly).refused, /judge.*CONVERGED/);
  const main = git(h.product, "commit-tree", git(h.product, "rev-parse", `${h.ruled}^{tree}`), "-m", "the protected branch's own history");
  const promotion = git(h.product, "commit-tree", git(h.product, "rev-parse", `${h.tip}^{tree}`), "-p", main, "-p", h.tip, "-m", "promote the tip");
  assert.equal(push(promotion).refused, undefined, "a same-tree merge of a covered tip");
  assert.deepEqual(queried, [h.ruled, h.tip, promotion]);
});

test("next takes the ruling on the ruled SHA for a VERSION-only integration head and suggests the tip", () => {
  const p = loopProduct();
  writeFileSync(join(p.product, "VERSION"), "1.0.0\n");
  git(p.product, "checkout", "-q", "loop/v1");
  git(p.product, "add", "VERSION");
  git(p.product, "commit", "-qm", "version file");
  const ruled = git(p.product, "rev-parse", "HEAD");
  const record = "rounds/0002-judge.md";
  const handoff = { id: "R-0002-judge", role: "judge", step: "judge", phase: "v1", round: 2, record, files: [record],
    product: { base: ruled, commit: ruled }, view: "a".repeat(40), attempt: 1, agent: { runner: "codex" }, audit: { violations: 0 }, time: "2026-11-21T00:00:00Z" };
  mkdirSync(join(p.records, "rounds"), { recursive: true });
  mkdirSync(join(p.records, "metrics"), { recursive: true });
  writeFileSync(join(p.records, record), "# R-0002-judge\n");
  writeFileSync(join(p.records, "metrics/handoffs.jsonl"), JSON.stringify(handoff) + "\n");
  git(p.records, "add", "-A");
  git(p.records, "commit", "-qm", "judge hand-off");
  writeFileSync(join(p.product, "VERSION"), "1.0.1\n");
  git(p.product, "commit", "-qam", "1.0.1");
  const tip = git(p.product, "rev-parse", "HEAD");
  const host = { ...process.env, SELF_LOOP_LOAD_DIR: temp("self-loop-load-"), SELF_LOOP_OWNER_STORE: roomyStore() };
  const next = () => spawnSync(process.execPath, [join(scripts, "loop.mjs"), "next", "--config", join(p.records, "loop.json")], { encoding: "utf8", env: host });
  let out = next();
  assert.equal(out.status, 0, out.stderr);
  assert.doesNotMatch(out.stdout, /no judge ruling on the integration head/);
  assert.match(out.stdout, new RegExp(`ruling not in the trajectory: R-0002-judge[\\s\\S]*--commit ${ruled} --tip ${tip} --area`));
  writeFileSync(join(p.records, "metrics/trajectory.jsonl"), JSON.stringify({ round: 2, phase: "v1", role: "judge", verdict: "CONTINUE", commit: ruled, tip }) + "\n");
  git(p.records, "add", "-A");
  git(p.records, "commit", "-qm", "ruling");
  out = next();
  assert.doesNotMatch(out.stdout, /ruling not in the trajectory|no judge ruling on the integration head/);
  writeFileSync(join(p.product, "src/a.js"), "changed\n");
  git(p.product, "commit", "-qam", "code after the ruling");
  const code = git(p.product, "rev-parse", "HEAD");
  out = next();
  assert.match(out.stdout, new RegExp(`loop/v1 at ${code} is ahead of the integration SHA ${ruled} by commits no hand-off records`));
  assert.doesNotMatch(out.stdout, /no judge ruling on the integration head/);
  const actorRecord = "rounds/0003-actor.md";
  writeFileSync(join(p.records, actorRecord), "# R-0003-actor\n");
  const actor = { ...handoff, id: "R-0003-actor", role: "actor", step: "actor", round: 3, record: actorRecord, files: [actorRecord], product: { base: tip, commit: code } };
  writeFileSync(join(p.records, "metrics/handoffs.jsonl"), [handoff, actor].map(h => JSON.stringify(h)).join("\n") + "\n");
  git(p.records, "add", "-A");
  git(p.records, "commit", "-qm", "actor hand-off after the ruling");
  out = next();
  assert.match(out.stdout, /no judge ruling on the integration head/);
  assert.ok(out.stdout.includes(`--base ${code}`), out.stdout);
});

test("a CONVERGED row on a VERSION-only tip takes its CI word from the append's own reading of the tip; anything but green is refused", () => {
  const h = history();
  const { file } = loopRecords(h.product);
  const gh = fakeGh();
  const append = (verdict, ...args) => spawnSync(process.execPath, [join(scripts, "trajectory.mjs"), "append", "--file", file, "--round", "1",
    "--phase", "v1", "--role", "judge", "--area", "watch", "--verdict", verdict, "--suite", "10/0", "--commit", h.ruled, ...args], { encoding: "utf8", env: gh.env });
  const rows = () => { try { return readFileSync(file, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)); } catch { return []; } };
  const tip = ["--tip", h.tip];

  assert.equal(append("CONVERGED", ...tip, "--ci", "success").status, 64, "the lead's CI word is no input");
  for (const [now, word] of [[[served("failure")], /it is failure/], [[served("pending")], /it is pending/], [[], /it is absent/], [null, /could not be read/]]) {
    gh.serve({ "o/r": { [h.ruled]: [served()], ...(now ? { [h.tip]: now } : {}) } });
    const refused = append("CONVERGED", ...tip);
    assert.equal(refused.status, 2, refused.stderr);
    assert.match(refused.stderr, word, "green CI on the ruled SHA is not CI on the tip");
  }
  assert.deepEqual(rows(), [], "a refused row is not appended");
  assert.deepEqual(gh.queries(), Array(4).fill(`o/r ${h.tip}`), "one reading of the tip per append");

  gh.serve({ "o/r": { [h.tip]: [served()] } });
  const ok = append("CONVERGED", ...tip);
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual([rows()[0].commit, rows()[0].tip, rows()[0].ci, rows()[0].verdict], [h.ruled, h.tip, "success", "CONVERGED"]);

  // A real failure stays recordable, so its diagnosis still fires.
  gh.serve({ "o/r": { [h.tip]: [served(), served("failure", 2)] } });
  const failed = append("CONTINUE", ...tip);
  assert.equal(failed.status, 0, failed.stderr);
  assert.equal(rows()[1].ci, "failure");
  const alarms = spawnSync(process.execPath, [join(scripts, "trajectory.mjs"), "alarms", "--file", file, "--json"], { encoding: "utf8" });
  assert.ok(JSON.parse(alarms.stdout).some(a => a.type === "ci-not-green" && a.at === 1), alarms.stdout);
  // Old rows, a tip row without a receipt among them, are still read.
  writeFileSync(file, readFileSync(file, "utf8") + JSON.stringify({ round: 2, phase: "v1", role: "judge", verdict: "CONVERGED", commit: h.ruled, tip: h.tip, ci: "success" }) + "\n");
  assert.equal(spawnSync(process.execPath, [join(scripts, "trajectory.mjs"), "alarms", "--file", file], { encoding: "utf8" }).status, 0);
});

test("next prints the closing command for a VERSION-only tip without any CI input, and that command closes the round", () => {
  const p = loopProduct({ loop: { gates: { require: ["github-actions/verify"] } } });
  writeFileSync(join(p.product, "VERSION"), "1.0.0\n");
  git(p.product, "checkout", "-q", "loop/v1");
  git(p.product, "add", "VERSION");
  git(p.product, "commit", "-qm", "version file");
  git(p.product, "remote", "add", "origin", "https://github.com/example/product.git");
  const ruled = git(p.product, "rev-parse", "HEAD");
  const record = "rounds/0002-judge.md";
  const handoff = { id: "R-0002-judge", role: "judge", step: "judge", phase: "v1", round: 2, record, files: [record],
    product: { base: ruled, commit: ruled }, view: "a".repeat(40), attempt: 1, agent: { runner: "codex" }, audit: { violations: 0 }, time: "2026-11-21T00:00:00Z" };
  mkdirSync(join(p.records, "rounds"), { recursive: true });
  mkdirSync(join(p.records, "metrics"), { recursive: true });
  writeFileSync(join(p.records, record), "# R-0002-judge\n");
  writeFileSync(join(p.records, "metrics/handoffs.jsonl"), JSON.stringify(handoff) + "\n");
  git(p.records, "add", "-A");
  git(p.records, "commit", "-qm", "judge hand-off");
  writeFileSync(join(p.product, "VERSION"), "1.0.1\n");
  git(p.product, "commit", "-qam", "1.0.1");
  const tip = git(p.product, "rev-parse", "HEAD");
  const gh = fakeGh(); // serves nothing yet: the checks cannot be read
  const next = spawnSync(process.execPath, [join(scripts, "loop.mjs"), "next", "--config", join(p.records, "loop.json")], { encoding: "utf8", env: gh.env });
  const block = next.stdout.split("\n- ").find(text => text.startsWith("ruling not in the trajectory")) ?? "";
  const line = block.split("\n").map(l => l.trim()).find(l => l.includes("trajectory.mjs append")) ?? "";
  assert.match(line, new RegExp(`--commit ${ruled} --tip ${tip} `), block);
  assert.doesNotMatch(line, /--ci|--config|--repo|--remote/, "the append is given no CI word, receipt or loop");

  gh.serve({ "example/product": { [tip]: [served()] } });
  const reads = gh.queries().length;
  const fill = { JUDGE_AREA: "release", JUDGE_VERDICT: "CONVERGED", BLOCKERS_OPENED: "-", BLOCKERS_CLOSED: "-", JUDGE_SUITE: "10/0" };
  const closed = spawnSync("/bin/sh", ["-c", line], { encoding: "utf8", env: { ...gh.env, ...fill } });
  assert.equal(closed.status, 0, closed.stderr);
  assert.deepEqual(gh.queries().slice(reads), [`example/product ${tip}`], "the close reads the tip once in the loop's destination");
  const row = JSON.parse(readFileSync(join(p.records, "metrics", "trajectory.jsonl"), "utf8"));
  assert.deepEqual([row.commit, row.tip, row.verdict, row.ci], [ruled, tip, "CONVERGED", "success"]);
  assert.ok(readFileSync(join(p.records, row.ciReceipt), "utf8").includes(tip));
});
