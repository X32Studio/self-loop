// F-0017, P-0018, P-0019, D-0016
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { receiptMatches, receiptProblem } from "../scripts/lib/ci.mjs";
import { snapshot } from "../scripts/lib/plan.mjs";
import { firstPublication } from "../scripts/lib/plan-measures.mjs";
import { tipCovers, tipProblem } from "../scripts/lib/tip.mjs";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SCRIPTS_DIR = join(REPO_ROOT, "scripts");
const REAL_GIT = (process.env.PATH ?? "").split(delimiter).map(d => join(d, "git")).find(p => existsSync(p)) ?? "git";

function makeTmp(t, prefix) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeEnv(t) {
  const home = makeTmp(t, "dd-home-"), load = makeTmp(t, "dd-load-"), store = makeTmp(t, "dd-store-");
  const env = {
    ...process.env, HOME: home, SELF_LOOP_LOAD_DIR: load, SELF_LOOP_OWNER_STORE: store,
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Critic", GIT_AUTHOR_EMAIL: "critic@example.invalid",
    GIT_COMMITTER_NAME: "Critic", GIT_COMMITTER_EMAIL: "critic@example.invalid",
  };
  delete env.NODE_OPTIONS;
  delete env.NODE_TEST_CONTEXT;
  return env;
}

function git(repo, env, ...argv) {
  const r = spawnSync(REAL_GIT, ["-C", repo, ...argv], { encoding: "utf8", env });
  assert.equal(r.status, 0, `git ${argv.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

function makeRepo(t, env, files = {}) {
  const dir = makeTmp(t, "dd-repo-");
  git(dir, env, "init", "-q", "-b", "main");
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  if (Object.keys(files).length) { git(dir, env, "add", "-A"); git(dir, env, "commit", "-qm", "init"); }
  return dir;
}

function withGitSpy(t, fn) {
  const bin = makeTmp(t, "dd-git-spy-"), log = join(bin, "calls.log"), spy = join(bin, "git");
  writeFileSync(spy, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\nexec ${JSON.stringify(REAL_GIT)} "$@"\n`);
  chmodSync(spy, 0o755);
  const orig = process.env.PATH ?? "";
  process.env.PATH = `${bin}${delimiter}${orig}`;
  try {
    fn({ path: `${bin}${delimiter}${orig}`, calls: () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []), clear: () => writeFileSync(log, "") });
  } finally {
    process.env.PATH = orig;
  }
}

test("F-0017 DAG: zero-import leaf dag.mjs, 7 wired callers, tipProblem/tipCovers black-box parity, and < 2 spawns across 25+ commits", t => {
  const dagSrc = readFileSync(join(SCRIPTS_DIR, "lib/dag.mjs"), "utf8");
  const dagImports = [...dagSrc.matchAll(/import\s+[^;]+\s+from\s+["']([^"']+)["']/g)].map(m => m[1]);
  assert.ok(dagImports.length > 0 && dagImports.every(s => s.startsWith("node:")));
  for (const rel of ["lib/provenance.mjs", "lib/tip.mjs", "lib/integration.mjs", "lib/window.mjs", "lib/dispatch.mjs", "lib/ci.mjs", "blueprint.mjs"]) {
    const src = readFileSync(join(SCRIPTS_DIR, rel), "utf8");
    assert.match(src, /from\s+["'](?:\.\/|\.\/lib\/)dag\.mjs["']/, `${rel} must import dag.mjs`);
    assert.doesNotMatch(src, /["']merge-base["']\s*,\s*["']--is-ancestor["']|["']rev-list["']\s*,\s*["']--min-parents=2["']/, `${rel} still invokes storm command`);
  }

  const env = makeEnv(t);
  const repo = makeRepo(t, env, { VERSION: "1.0.0\n", "src/a.js": "a\n" });
  const c0 = git(repo, env, "rev-parse", "HEAD");
  const commit = (files, msg) => {
    for (const [p, body] of Object.entries(files)) { mkdirSync(dirname(join(repo, p)), { recursive: true }); writeFileSync(join(repo, p), body); }
    git(repo, env, "add", "-A"); git(repo, env, "commit", "-qm", msg);
    return git(repo, env, "rev-parse", "HEAD");
  };
  const v1 = commit({ VERSION: "1.0.1\n" }, "v1");
  const v2 = commit({ VERSION: "1.0.2\n" }, "v2");
  const code = commit({ VERSION: "1.0.3\n", "src/a.js": "b\n" }, "code");
  git(repo, env, "checkout", "-q", "-b", "side", c0);
  const s1 = commit({ "src/side.js": "s\n" }, "side");
  git(repo, env, "checkout", "-q", "-b", "merged", v1);
  git(repo, env, "merge", "-q", "--no-edit", s1);
  const m1 = git(repo, env, "rev-parse", "HEAD");
  const mTip = commit({ VERSION: "1.0.9\n" }, "after-merge");

  assert.equal(tipCovers(repo, c0, v1), true);
  assert.equal(tipCovers(repo, c0, v2), true);
  assert.equal(tipProblem(repo, c0, v2), null);
  assert.equal(tipCovers(repo, c0, code), false);
  assert.match(tipProblem(repo, c0, code), /changes src\/a\.js/);
  assert.equal(tipCovers(repo, c0, m1), false);
  assert.match(tipProblem(repo, c0, mTip), new RegExp(`through merge ${m1.slice(0, 7)}`));
  assert.equal(tipCovers(repo, v2, c0), false);
  assert.match(tipProblem(repo, v2, c0), /does not follow/);

  const unreachLin = git(repo, env, "commit-tree", git(repo, env, "rev-parse", `${v1}^{tree}`), "-p", c0, "-m", "unreach-v");
  const unreachMerge = git(repo, env, "commit-tree", git(repo, env, "rev-parse", `${v1}^{tree}`), "-p", c0, "-p", s1, "-m", "unreach-m");
  const unreachOrph = git(repo, env, "commit-tree", git(repo, env, "rev-parse", `${v1}^{tree}`), "-m", "unreach-o");
  assert.equal(tipCovers(repo, c0, unreachLin), true);
  assert.equal(tipCovers(repo, c0, unreachMerge), false);
  assert.match(tipProblem(repo, c0, unreachMerge), /through merge/);
  assert.equal(tipCovers(repo, c0, unreachOrph), false);

  git(repo, env, "replace", code, v1);
  git(repo, env, "replace", "--graft", v1);
  try {
    assert.equal(tipCovers(repo, c0, code), false);
    assert.equal(tipCovers(repo, c0, v1), true);
  } finally {
    git(repo, env, "replace", "-d", code);
    git(repo, env, "replace", "-d", v1);
  }

  const big = makeRepo(t, env, { VERSION: "2.0.0\n", "src/x.js": "0\n" });
  const chain = [git(big, env, "rev-parse", "HEAD")];
  for (let i = 1; i <= 26; i++) {
    writeFileSync(join(big, "src/x.js"), `${i}\n`);
    git(big, env, "commit", "-qam", `c${i}`);
    chain.push(git(big, env, "rev-parse", "HEAD"));
  }
  git(big, env, "checkout", "-q", "-b", "alt", chain[0]);
  writeFileSync(join(big, "src/y.js"), "alt\n");
  git(big, env, "add", "src/y.js"); git(big, env, "commit", "-qm", "alt-1");
  const alt1 = git(big, env, "rev-parse", "HEAD");
  git(big, env, "merge", "-q", "--no-edit", chain[12]);
  const bigMerge = git(big, env, "rev-parse", "HEAD");

  withGitSpy(t, ({ calls }) => {
    let checks = 0;
    for (let i = 1; i < chain.length; i++) {
      assert.equal(tipCovers(big, chain[i], chain[i - 1]), false);
      assert.equal(tipCovers(big, alt1, chain[i]), false);
      checks += 2;
    }
    assert.equal(tipCovers(big, chain[0], bigMerge), false);
    assert.equal(tipCovers(big, chain[12], bigMerge), false);
    assert.ok(checks + 2 >= 50);
    const list = calls();
    assert.ok(list.length < 2, `expected < 2 git spawns across ${checks + 2} checks, got ${list.length}: ${list.join(" | ")}`);
    assert.ok(list.every(l => !l.includes("merge-base") && !l.includes("--min-parents=2")), `unexpected storm spawn: ${list.join(" | ")}`);
  });
});

test("F-0017 Seams: LP-0011 receiptMatches skips shownTree, LP-0012 snapshot batches cat-file, and TB-03 firstPublication runs <= 1 git log", t => {
  const env = makeEnv(t);
  const product = makeRepo(t, env, { VERSION: "1.0.0\n", "src/a.js": "1\n" });
  const c0 = git(product, env, "rev-parse", "HEAD"), t0 = git(product, env, "rev-parse", `${c0}^{tree}`);
  writeFileSync(join(product, "VERSION"), "1.0.1\n");
  git(product, env, "commit", "-qam", "v1");
  const v1 = git(product, env, "rev-parse", "HEAD"), tV1 = git(product, env, "rev-parse", `${v1}^{tree}`);
  writeFileSync(join(product, "src/a.js"), "2\n");
  git(product, env, "commit", "-qam", "code");
  const code = git(product, env, "rev-parse", "HEAD");

  git(product, env, "replace", c0, code);
  try {
    assert.match(receiptProblem({ repository: product, sha: c0, tree: "0".repeat(40), green: true }, product, c0), /a local replacement shows tree/);
    withGitSpy(t, ({ calls, clear }) => {
      const rejects = [
        null, {}, { id: "R-0001-actor", audit: { violations: 0 } }, { sha: c0, ci: "success", ok: true },
        { repository: product, sha: c0, tree: t0, green: false }, { repository: "/nonexistent/other", sha: c0, tree: t0, green: true },
        { repository: product, sha: v1, tree: tV1, green: true }, { repository: product, sha: c0, tree: tV1, versionVaried: "1.0.1", green: true },
      ];
      for (const item of rejects) assert.equal(receiptMatches(item, product, c0), false);
      assert.equal(calls().filter(l => l.includes("rev-parse")).length, 0);
      clear();
      assert.equal(receiptMatches({ repository: product, sha: c0, tree: t0, green: true }, product, c0), true);
      assert.equal(receiptMatches({ repository: product, sha: c0, tree: tV1, versionVaried: "1.0.1", green: true }, product, v1), true);
      assert.equal(receiptMatches({ repository: product, sha: c0, tree: t0, versionVaried: "1.0.1", green: true }, product, v1), false);
      assert.equal(receiptMatches({ repository: product, sha: c0, tree: t0, versionVaried: "1.0.1", green: true }, product, code), false);
    });
  } finally {
    git(product, env, "replace", "-d", c0);
  }

  const records = makeRepo(t, env, {});
  const put = (p, body) => { mkdirSync(dirname(join(records, p)), { recursive: true }); writeFileSync(join(records, p), body); };
  const commitAt = (iso, msg) => assert.equal(spawnSync(REAL_GIT, ["-C", records, "commit", "-qm", msg], { encoding: "utf8", env: { ...env, GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso } }).status, 0);
  const [iso1, iso2, iso3, iso4, iso5] = ["2026-11-20T10:00:00Z", "2026-11-21T11:00:00Z", "2026-11-22T12:00:00Z", "2026-11-23T13:00:00Z", "2026-11-24T14:00:00Z"];
  for (let i = 1; i <= 10; i++) put(`decisions/D-${String(i).padStart(4, "0")}.md`, `# D-${i}\n`);
  for (let i = 1; i <= 5; i++) put(`plans/PL-${String(i).padStart(4, "0")}.md`, `# PL-${i}\n`);
  put("owner/B-0001.md", "# B-0001\n");
  git(records, env, "add", "-A"); commitAt(iso1, "c1");
  put("rounds/0001-actor.md", "# actor\n"); put("rounds/0001-readd.md", "# v1\n");
  git(records, env, "add", "-A"); commitAt(iso2, "c2");
  git(records, env, "rm", "-q", "rounds/0001-readd.md"); put("plans/PL-0001.md", "# PL-1 v2\n");
  git(records, env, "add", "-A"); commitAt(iso3, "c3");
  put("rounds/0001-readd.md", "# v2\n");
  git(records, env, "add", "-A"); commitAt(iso4, "c4");
  const head = git(records, env, "rev-parse", "HEAD");

  withGitSpy(t, ({ calls, clear }) => {
    const snap = snapshot(records, head);
    for (let i = 1; i <= 10; i++) assert.equal(snap.read(`decisions/D-${String(i).padStart(4, "0")}.md`), `# D-${i}\n`);
    for (let i = 1; i <= 5; i++) assert.ok(snap.read(`plans/PL-${String(i).padStart(4, "0")}.md`).startsWith(`# PL-${i}`));
    assert.equal(calls().filter(l => /\bshow\b/.test(l)).length, 0);
    assert.ok(calls().filter(l => l.includes("cat-file --batch")).length <= 2);

    clear();
    const st = { records, revision: head };
    assert.equal(firstPublication(st, "decisions/D-0001.md"), Date.parse(iso1));
    assert.equal(firstPublication(st, "plans/PL-0001.md"), Date.parse(iso1));
    assert.equal(firstPublication(st, "owner/B-0001.md"), Date.parse(iso1));
    assert.equal(firstPublication(st, "rounds/0001-actor.md"), Date.parse(iso2));
    assert.equal(firstPublication(st, "rounds/0001-readd.md"), null);
    assert.equal(firstPublication(st, "rounds/9999-missing.md"), null);
    assert.ok(calls().filter(l => /\blog\b/.test(l)).length <= 1);
  });
  put("rounds/0002-late.md", "# late\n"); git(records, env, "add", "-A"); commitAt(iso5, "c5");
  assert.equal(firstPublication({ records, revision: "HEAD" }, "rounds/0002-late.md"), Date.parse(iso5));
});

test("F-0017 E2E: loop.mjs next executes without merge-base or per-file log/show storms", t => {
  const env = makeEnv(t), workDir = makeTmp(t, "dd-work-");
  const product = makeRepo(t, env, { VERSION: "1.0.0\n", "src/a.js": "export const a = 1;\n" });
  git(product, env, "branch", "loop/v1"); git(product, env, "checkout", "-q", "loop/v1");
  const ruled = git(product, env, "rev-parse", "HEAD");
  writeFileSync(join(product, "VERSION"), "1.0.1\n"); git(product, env, "commit", "-qam", "tip");
  const tip = git(product, env, "rev-parse", "HEAD");

  const records = makeRepo(t, env, {});
  const put = (p, body) => { mkdirSync(dirname(join(records, p)), { recursive: true }); writeFileSync(join(records, p), body); };
  put("README.md", "# records\n"); put("records.json", "{}\n"); put("purpose/P-0001.md", "# P-0001\n");
  put("decisions/D-0001.md", "# D-0001\n\nby: owner\nstatus: active\n");
  put("blueprint/F-0001.md", "# F-0001\n\nid: F-0001\nphase: v1\nrequirements: P-0001\n");
  put("owner/B-0001.md", "# B-0001\n\nphase: v1\n"); put("owner/answers.jsonl", "");
  put("rounds/0001-reviewer-frame.md", "# frame\n"); put("rounds/0001-judge.md", "# judge\n");
  put("evidence/0001/judge-1-audit.json", JSON.stringify({ id: "R-0001-judge", violations: 0 }) + "\n");
  put("evidence/0001/suite-old.json", JSON.stringify({ repository: product, sha: "0".repeat(40), tree: "0".repeat(40), green: true }) + "\n");
  put("metrics/handoffs.jsonl", [
    { id: "R-0001-reviewer-frame", time: "2026-11-21T00:00:00Z", phase: "v1", round: 1, step: "reviewer-frame", role: "reviewer", record: "rounds/0001-reviewer-frame.md", files: ["rounds/0001-reviewer-frame.md"], view: "a".repeat(40), attempt: 1, agent: { runner: "codex" }, product: null, audit: { violations: 0 } },
    { id: "R-0001-judge", time: "2026-11-21T00:01:00Z", phase: "v1", round: 1, step: "judge", role: "judge", record: "rounds/0001-judge.md", files: ["rounds/0001-judge.md"], view: "a".repeat(40), attempt: 1, agent: { runner: "codex" }, product: { base: ruled, commit: ruled }, audit: { violations: 0 } },
  ].map(x => JSON.stringify(x)).join("\n") + "\n");
  put("loop.json", JSON.stringify({
    product, branch: "loop/v1", records: ".", workDir, phase: "v1", briefs: {},
    agents: { critic: { runner: "codex" }, actor: { runner: "claude" }, judge: { runner: "codex" }, reviewer: { runner: "claude" } },
    gates: { require: [] },
  }, null, 2) + "\n");
  git(records, env, "add", "-A"); git(records, env, "commit", "-qm", "init records");

  withGitSpy(t, ({ path, calls }) => {
    const res = spawnSync(process.execPath, [join(SCRIPTS_DIR, "loop.mjs"), "next", "--config", join(records, "loop.json")], { encoding: "utf8", env: { ...env, PATH: path } });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, new RegExp(`--commit ${ruled} --tip ${tip}`));
    const list = calls();
    assert.equal(list.filter(l => l.includes("merge-base --is-ancestor") || l.includes("--min-parents=2")).length, 0);
    assert.ok(list.filter(l => l.includes("--diff-filter=A")).length <= 1);
  });
});

test("F-0017 Docs & P-0019: EXPERIENCE.md (TB-01..TB-10), brief/SKILL/init wiring, Node 24 docs parity, and 0 D-0069 leaks", t => {
  const exp = readFileSync(join(REPO_ROOT, "EXPERIENCE.md"), "utf8");
  for (let i = 1; i <= 10; i++) assert.ok(exp.includes(`TB-${String(i).padStart(2, "0")}`), `missing TB-${String(i).padStart(2, "0")}`);
  assert.match(exp, /^## Maintenance Rule/m);
  for (const rel of ["SKILL.md", "README.md", "assets/brief-actor.md", "assets/brief-critic.md", "assets/brief-frame-reviewer.md"]) {
    assert.ok(readFileSync(join(REPO_ROOT, rel), "utf8").includes("EXPERIENCE.md"), `${rel} must link EXPERIENCE.md`);
  }
  const example = JSON.parse(readFileSync(join(REPO_ROOT, "assets/self-loop.example.json"), "utf8"));
  assert.ok(example.owns.actor.includes("EXPERIENCE.md") && example.owns.actor.includes("GLOSSARY.md"));

  const env = makeEnv(t), p = makeRepo(t, env, { "src/index.js": "export const ok = true;\n" });
  const initRes = spawnSync(process.execPath, [join(SCRIPTS_DIR, "self-loop.mjs"), "init", "--json"], { cwd: p, env, encoding: "utf8" });
  assert.equal(initRes.status, 0, initRes.stderr);
  const loopCfg = JSON.parse(readFileSync(join(JSON.parse(initRes.stdout).records, "loop.json"), "utf8"));
  assert.ok(loopCfg.owns.actor.includes("EXPERIENCE.md") && loopCfg.owns.actor.includes("GLOSSARY.md"));

  const readme = readFileSync(join(REPO_ROOT, "README.md"), "utf8"), relDoc = readFileSync(join(REPO_ROOT, "docs/release-and-versioning.md"), "utf8");
  for (const [name, body] of [["README.md", readme], ["docs/release-and-versioning.md", relDoc]]) {
    assert.doesNotMatch(body, /^[ \t]*node --test acceptance[ \t]*$/m, `${name} contains bare node --test acceptance`);
    assert.doesNotMatch(body, /`node --test acceptance`/, `${name} contains backticked bare node --test acceptance`);
  }
  assert.ok(readme.includes("GLOSSARY.md") && readme.includes("EXPERIENCE.md") && readme.includes("suite-green.mjs") && readme.includes("--relay"));
  assert.ok(relDoc.includes("suite-green.mjs") && relDoc.includes("--relay") && relDoc.includes("SELF_LOOP_RELAY_DIR") && relDoc.includes("gc.auto=0") && relDoc.includes("codeTree"));

  const leakRe = new RegExp(["/Use" + "rs/", "/ho" + "me/", "\\bout" + "lit\\b", "\\bou" + "tis\\b", "\\bgpt-" + "6\\b", "\\bgemini-" + "4\\b"].join("|"), "i");
  for (const rel of [
    "EXPERIENCE.md", "README.md", "docs/release-and-versioning.md", "SKILL.md",
    "assets/brief-actor.md", "assets/brief-critic.md", "assets/brief-frame-reviewer.md", "assets/self-loop.example.json",
    "scripts/lib/dag.mjs", "scripts/lib/plan-measures.mjs", "scripts/lib/tip.mjs", "scripts/lib/ci.mjs",
    "scripts/lib/plan.mjs", "scripts/lib/provenance.mjs", "scripts/lib/integration.mjs", "scripts/lib/window.mjs",
    "scripts/lib/dispatch.mjs", "scripts/blueprint.mjs", "scripts/loop.mjs", "acceptance/dag-and-docs.test.mjs",
  ]) {
    assert.doesNotMatch(readFileSync(join(REPO_ROOT, rel), "utf8"), leakRe, `D-0069 leak in ${rel}`);
  }
});
