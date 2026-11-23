// End-to-end offline acceptance for F-0013 (AWS CodeCommit forge and AWS CodeBuild CI gate).
// Covers AC-01, AC-02, AC-31, AC-33 (CC-A01, CC-A02, CC-A03) with zero live AWS dependencies.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fakeAws, fakeGh, git, repo, scripts, temp } from "../scripts/test/helpers.mjs";

const ACCOUNT = "123456789012";

function runScript(name, args, env, cwd = process.cwd()) {
  return spawnSync(process.execPath, [join(scripts, name), ...args], { encoding: "utf8", env, cwd });
}

function makeSshShim(bareDir) {
  const dir = temp("git-ssh-shim-");
  const shim = join(dir, "ssh-shim.sh");
  writeFileSync(shim, `#!/bin/sh
for last; do true; done
case "$last" in
  *git-receive-pack*) exec git-receive-pack "${bareDir}" ;;
  *git-upload-pack*) exec git-upload-pack "${bareDir}" ;;
  *) echo "unexpected ssh cmd: $last" >&2; exit 1 ;;
esac
`, { mode: 0o755 });
  return shim;
}

function makeGrcShim(bareDir, { expectedRepo = "MyRepo", logFile = null, failProfile = null } = {}) {
  const bin = temp("grc-bin-");
  const log = logFile ?? join(bin, "grc.log");
  writeFileSync(join(bin, "git-remote-codecommit"), `#!/bin/sh
url="$2"
body="\${url#*://}"
body="\${body%/}"
case "$body" in
  *@*) profile="\${body%%@*}"; repo="\${body#*@}" ;;
  *) profile=""; repo="$body" ;;
esac
printf '%s\\t%s\\t%s\\n' "$url" "\${CODE_COMMIT_ENDPOINT:-}" "$repo" >> ${JSON.stringify(log)}
if [ -n ${JSON.stringify(failProfile ?? "")} ] && [ "$profile" = ${JSON.stringify(failProfile ?? "")} ]; then
  echo "botocore.exceptions.ProfileNotFound: The config profile ($profile) could not be found (remote $url)" >&2
  exit 1
fi
if [ -n "\${CODE_COMMIT_ENDPOINT:-}" ]; then
  echo "redirected to CODE_COMMIT_ENDPOINT=\${CODE_COMMIT_ENDPOINT}" >&2
  exit 1
fi
if [ "$repo" != ${JSON.stringify(expectedRepo)} ]; then
  echo "RepositoryDoesNotExistException: Repository $repo does not exist" >&2
  exit 1
fi
while IFS= read -r line; do
  case "$line" in
    capabilities)
      printf 'connect\\n\\n'
      ;;
    connect\\ git-receive-pack)
      printf '\\n'
      exec git-receive-pack "${bareDir}"
      ;;
    connect\\ git-upload-pack)
      printf '\\n'
      exec git-upload-pack "${bareDir}"
      ;;
    "")
      exit 0
      ;;
  esac
done
`, { mode: 0o755 });
  const calls = () => existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
  return { bin, calls };
}

function makeBuild(sha, { n = 1, status = "SUCCEEDED", repoName = "MyRepo", project = "verify", region = "us-east-1", account = ACCOUNT } = {}) {
  const id = `${project}:00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
  return {
    id,
    arn: `arn:aws:codebuild:${region}:${account}:build/${id}`,
    buildNumber: n,
    projectName: project,
    buildStatus: status,
    startTime: "2026-11-23T08:00:00+04:00",
    source: { type: "CODECOMMIT", location: `https://git-codecommit.${region}.amazonaws.com/v1/repos/${repoName}` },
    resolvedSourceVersion: sha,
  };
}

function judgeFiles(sha, { round = 1, phase = "v1" } = {}) {
  const n = String(round).padStart(4, "0");
  const record = `rounds/${n}-judge.md`, sealed = `sealed/judge/${n}/judge-1.md`;
  const handoff = {
    id: `R-${n}-judge`, role: "judge", step: "judge", phase, round, record, files: [record, sealed],
    product: { base: sha, commit: sha }, view: "a".repeat(40), attempt: 1,
    agent: { runner: "codex" }, audit: { violations: 0 },
  };
  return {
    "metrics/handoffs.jsonl": JSON.stringify(handoff) + "\n",
    [record]: `# R-${n}-judge\n\nphase: ${phase}\nrole: judge\n`,
    [sealed]: "# Judge\n\n## Task (verbatim)\n\n```text\nTask\n```\n\n## Report (verbatim)\n\nVERDICT: CONVERGED\nACCEPTANCE: pass\n",
  };
}

function setupCodeCommitLoop({ remoteUrl, require = ["codebuild/verify"], protectedBranches = ["main"], includeTrajectory = true, version = "0.4.10" }) {
  const bare = temp("cc-bare-");
  git(bare, "init", "-q", "--bare");
  const product = repo({ VERSION: `${version}\n`, "src/app.mjs": "export const x = 1;\n", "test/ok.test.mjs": "import test from 'node:test'; test('ok', () => {});\n" });
  git(product, "remote", "add", "origin", remoteUrl);
  const sha = git(product, "rev-parse", "HEAD");
  const tree = git(product, "--no-replace-objects", "rev-parse", `${sha}^{tree}`);
  const suiteFile = join(temp("suite-"), "suite.json");
  writeFileSync(suiteFile, JSON.stringify({ repository: product, sha, tree, green: true, reasons: [] }));

  const recordFiles = {
    "README.md": "# loop records\n",
    "records.json": "{}\n",
    "purpose/P-0001.md": "# P-0001 CodeCommit\n\nstatus: active\n",
    "blueprint/F-0001.md": "# F-0001 CodeCommit CI\n\nid: F-0001\nphase: v1\nrequirements: P-0001\n",
    "engines/shared.md": "# Shared\n",
    "engines/critic.md": "# Critic\n",
    "engines/actor.md": "# Actor\n",
    "engines/judge.md": "# Judge\n",
    "engines/frame-reviewer.md": "# Reviewer\n",
    ...judgeFiles(sha),
  };
  if (includeTrajectory) {
    recordFiles["metrics/trajectory.jsonl"] = JSON.stringify({ round: 1, phase: "v1", role: "judge", verdict: "CONVERGED", commit: sha }) + "\n";
  }
  const records = repo(recordFiles);
  writeFileSync(join(records, "loop.json"), JSON.stringify({
    product,
    branch: "main",
    records: ".",
    workDir: temp("work-"),
    phase: "v1",
    briefs: { shared: "engines/shared.md", critic: "engines/critic.md", actor: "engines/actor.md", judge: "engines/judge.md", reviewer: "engines/frame-reviewer.md" },
    agents: { critic: { runner: "codex" }, actor: { runner: "claude" }, judge: { runner: "codex" }, reviewer: { runner: "claude" } },
    protected: protectedBranches,
    gates: { remote: "origin", require },
  }, null, 2) + "\n");
  git(records, "add", "loop.json");
  git(records, "commit", "-qm", "add loop.json");

  const store = temp("owner-store-");
  writeFileSync(join(store, "products.json"), JSON.stringify({ products: [{ name: "cc-product", records }] }));
  return { bare, product, records, store, sha, tree, suiteFile };
}

test("AC-01 & AC-02 (CC-A01): end-to-end CodeCommit SSH protected push, trajectory append, records-check, and loop next with zero gh calls", () => {
  const sshKey = "APKAEXAMPLEKEY999999";
  const remoteUrl = `ssh://${sshKey}@git-codecommit.us-east-1.amazonaws.com/v1/repos/MyRepo`;
  const { bare, product, records, store, sha, suiteFile } = setupCodeCommitLoop({ remoteUrl, includeTrajectory: false });
  const sshShim = makeSshShim(bare);
  const gh = fakeGh({});
  const redBuild = makeBuild(sha, { n: 1, status: "FAILED" });
  const aws = fakeAws({ account: ACCOUNT, projects: { verify: { ids: [redBuild.id] } }, builds: { [redBuild.id]: redBuild } });
  const env = {
    ...process.env,
    PATH: `${aws.bin}:${gh.bin}:${process.env.PATH}`,
    GIT_SSH: sshShim,
    SELF_LOOP_LOAD_DIR: temp("load-"),
  };

  // AC-02 part 1: trajectory.mjs append refuses CONVERGED while CodeBuild is red
  const trajFile = join(records, "metrics", "trajectory.jsonl");
  const badAppend = runScript("trajectory.mjs", ["append", "--file", trajFile, "--round", "1", "--phase", "v1", "--role", "judge", "--verdict", "CONVERGED", "--commit", sha], env);
  assert.equal(badAppend.status, 2, badAppend.stdout + badAppend.stderr);
  assert.equal(existsSync(trajFile), false);
  assert.deepEqual(gh.queries(), []);

  // Switch CodeBuild to green (higher buildNumber 2)
  const greenBuild = makeBuild(sha, { n: 2, status: "SUCCEEDED" });
  aws.serve({ account: ACCOUNT, projects: { verify: { ids: [greenBuild.id, redBuild.id] } }, builds: { [greenBuild.id]: greenBuild, [redBuild.id]: redBuild } });

  // AC-02 part 2: trajectory.mjs append succeeds, saves CodeCommit CI receipt with canonical host, region, account, repository
  const okAppend = runScript("trajectory.mjs", ["append", "--file", trajFile, "--round", "1", "--phase", "v1", "--role", "judge", "--verdict", "CONVERGED", "--commit", sha], env);
  assert.equal(okAppend.status, 0, okAppend.stdout + okAppend.stderr);
  const row = JSON.parse(readFileSync(trajFile, "utf8").trim());
  assert.equal(row.ci, "success");
  assert.ok(row.ciReceipt);
  const savedReceipt = JSON.parse(readFileSync(join(records, row.ciReceipt), "utf8"));
  assert.deepEqual({
    forge: savedReceipt.forge,
    host: savedReceipt.host,
    region: savedReceipt.region,
    account: savedReceipt.account,
    repository: savedReceipt.repository,
    source: savedReceipt.source,
  }, {
    forge: "codecommit",
    host: "git-codecommit.us-east-1.amazonaws.com",
    region: "us-east-1",
    account: ACCOUNT,
    repository: "MyRepo",
    source: "live",
  });
  assert.doesNotMatch(JSON.stringify(savedReceipt), new RegExp(sshKey));
  git(records, "add", "metrics/trajectory.jsonl", row.ciReceipt);
  git(records, "commit", "-qm", "record converged trajectory with codebuild receipt");

  // records-check passes with the saved CodeCommit receipt
  const rcCheck = runScript("records-check.mjs", ["--repo", records, "--write"], env);
  assert.equal(rcCheck.status, 0, rcCheck.stdout + rcCheck.stderr);

  // AC-01: gated-push red refuses (exit 2, bare repo unchanged), then green succeeds (exit 0, bare repo updated, SSH key redacted)
  aws.serve({ account: ACCOUNT, projects: { verify: { ids: [redBuild.id] } }, builds: { [redBuild.id]: redBuild } });
  aws.clearCalls();
  const redPush = runScript("gated-push.mjs", ["--repo", product, "--owner-store", store, "--branch", "main", "--sha", sha, "--suite-receipt", suiteFile], env);
  assert.equal(redPush.status, 2, redPush.stdout + redPush.stderr);
  assert.equal(spawnSync("git", ["-C", bare, "rev-parse", "--verify", "-q", "refs/heads/main"]).status, 1, "bare repo unchanged on red push");
  assert.deepEqual(gh.queries(), []);
  assert.ok(aws.calls().every(c => c.argv[0] === "sts" || c.argv[0] === "codebuild"));

  aws.serve({ account: ACCOUNT, projects: { verify: { ids: [greenBuild.id, redBuild.id] } }, builds: { [greenBuild.id]: greenBuild, [redBuild.id]: redBuild } });
  aws.clearCalls();
  const greenPush = runScript("gated-push.mjs", ["--repo", product, "--owner-store", store, "--branch", "main", "--sha", sha, "--suite-receipt", suiteFile], env);
  assert.equal(greenPush.status, 0, greenPush.stdout + greenPush.stderr);
  assert.equal(git(bare, "rev-parse", "refs/heads/main"), sha);
  assert.doesNotMatch(greenPush.stdout + greenPush.stderr, new RegExp(sshKey));
  assert.match(greenPush.stdout, /ssh:\/\/\*\*\*@git-codecommit\.us-east-1\.amazonaws\.com\/v1\/repos\/MyRepo/);
  assert.deepEqual(gh.queries(), []);
  assert.ok(aws.calls().every(c => c.argv[0] === "sts" || c.argv[0] === "codebuild"));

  // AC-02 part 3: loop.mjs next reads live CodeBuild CI with zero gh calls
  aws.clearCalls();
  const next = runScript("loop.mjs", ["next", "--config", join(records, "loop.json"), "--owner-store", store], env);
  assert.equal(next.status, 0, next.stdout + next.stderr);
  assert.deepEqual(gh.queries(), []);
  assert.ok(aws.calls().some(c => c.argv[0] === "codebuild"));
});

test("AC-31: CodeCommit single-destination enforcement refuses multiple push URLs and pushInsteadOf-to-bare with zero CLI calls", () => {
  const remoteUrl = "https://git-codecommit.us-east-1.amazonaws.com/v1/repos/MyRepo";
  const { bare, product, records, store, sha, suiteFile } = setupCodeCommitLoop({ remoteUrl });
  const aws = fakeAws({ account: ACCOUNT });
  const gh = fakeGh({});
  const env = { ...process.env, PATH: `${aws.bin}:${gh.bin}:${process.env.PATH}`, SELF_LOOP_LOAD_DIR: temp("load-") };

  // Two push URLs (set-url --push + --add --push)
  git(product, "remote", "set-url", "--push", "origin", remoteUrl);
  git(product, "remote", "set-url", "--add", "--push", "origin", "codecommit::us-east-1://MyMirror");
  assert.equal(runScript("ci-green.mjs", ["--repo", product, "--sha", sha, "--require", "codebuild/verify"], env).status, 2);
  assert.equal(runScript("gated-push.mjs", ["--repo", product, "--owner-store", store, "--branch", "main", "--sha", sha, "--suite-receipt", suiteFile], env).status, 2);
  assert.equal(runScript("trajectory.mjs", ["append", "--file", join(records, "metrics/trajectory.jsonl"), "--round", "2", "--phase", "v1", "--role", "judge", "--verdict", "CONVERGED", "--commit", sha], env).status, 2);
  assert.equal(runScript("version-gate.mjs", ["reconcile", "--remote", "origin", "--branch", "main"], env, product).status, 2);

  // pushInsteadOf redirecting CodeCommit fetch URL to local bare repo
  git(product, "config", "--unset-all", "remote.origin.pushurl");
  git(product, "config", `url.${bare}.pushInsteadOf`, remoteUrl);
  assert.equal(runScript("ci-green.mjs", ["--repo", product, "--sha", sha, "--require", "codebuild/verify"], env).status, 2);
  assert.equal(runScript("gated-push.mjs", ["--repo", product, "--owner-store", store, "--branch", "main", "--sha", sha, "--suite-receipt", suiteFile], env).status, 2);
  assert.equal(spawnSync("git", ["-C", bare, "rev-parse", "--verify", "-q", "refs/heads/main"]).status, 1, "nothing pushed to protected branch");
  assert.deepEqual(aws.calls(), []);
  assert.deepEqual(gh.queries(), []);
});

test("AC-33 (CC-A02): CodeCommit GRC protected push with gates.require: [] succeeds with judge convergence when aws is absent and AWS_* unset", () => {
  const { bare, product, records, store, sha, suiteFile } = setupCodeCommitLoop({
    remoteUrl: "codecommit://MyRepo",
    require: [],
    includeTrajectory: false,
  });
  const grc = makeGrcShim(bare);
  const env = { HOME: temp("home-"), PATH: `${grc.bin}:/usr/bin:/bin`, SELF_LOOP_LOAD_DIR: temp("load-") };
  // Confirm aws is not resolvable on this PATH
  assert.notEqual(spawnSync("aws", ["--version"], { env }).status, 0);

  // Without committed judge convergence -> refused (exit 2), bare repo untouched
  const unjudged = runScript("gated-push.mjs", ["--repo", product, "--owner-store", store, "--branch", "main", "--sha", sha, "--suite-receipt", suiteFile], env);
  assert.equal(unjudged.status, 2, unjudged.stdout + unjudged.stderr);
  assert.match(unjudged.stderr, /no judge CONVERGED ruling/);
  assert.equal(spawnSync("git", ["-C", bare, "rev-parse", "--verify", "-q", "refs/heads/main"]).status, 1);

  // With committed judge convergence -> succeeds with zero aws calls and pushes via GRC shim
  writeFileSync(join(records, "metrics/trajectory.jsonl"), JSON.stringify({ round: 1, phase: "v1", role: "judge", verdict: "CONVERGED", commit: sha }) + "\n");
  git(records, "add", "metrics/trajectory.jsonl");
  git(records, "commit", "-qm", "commit judge convergence");

  const ok = runScript("gated-push.mjs", ["--repo", product, "--owner-store", store, "--branch", "main", "--sha", sha, "--suite-receipt", suiteFile], env);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /no check required/);
  assert.equal(git(bare, "rev-parse", "refs/heads/main"), sha);
});

test("CC-A03: version-gate.mjs release and reconcile work against a CodeCommit SSH remote with zero aws CLI dependency", () => {
  const bare = temp("vg-bare-");
  git(bare, "init", "-q", "--bare");
  const remoteUrl = "ssh://APKAEXAMPLE12345678@git-codecommit.us-east-1.amazonaws.com/v1/repos/MyRepo";
  const product = repo({
    VERSION: "0.4.10\n",
    "scripts/test/ok.test.mjs": "import test from 'node:test'; test('ok', () => {});\n",
  });
  git(product, "remote", "add", "origin", remoteUrl);
  const sshShim = makeSshShim(bare);
  const env = {
    HOME: temp("home-"),
    PATH: `/usr/bin:/bin:${join(process.execPath, "..")}`,
    GIT_SSH: sshShim,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.invalid",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.invalid",
    SELF_LOOP_LOAD_DIR: temp("load-"),
  };
  // Push base version 0.4.10 first
  assert.equal(spawnSync("git", ["-C", product, "push", "-q", "origin", "main"], { env, encoding: "utf8" }).status, 0);

  // Create VERSION-only tip 0.4.11 via version-gate.mjs tip, then sync checked-out VERSION
  const tipRes = runScript("version-gate.mjs", ["tip", "--version", "0.4.11", "--branch", "main"], env, product);
  assert.equal(tipRes.status, 0, tipRes.stdout + tipRes.stderr);
  git(product, "checkout", "HEAD", "--", "VERSION");
  const tipSha = git(product, "rev-parse", "refs/heads/main");

  // Atomic branch + tag release to CodeCommit SSH remote (zero aws CLI needed)
  const rel = runScript("version-gate.mjs", ["release", "--remote", "origin", "--branch", "main"], env, product);
  assert.equal(rel.status, 0, rel.stdout + rel.stderr);
  assert.equal(git(bare, "rev-parse", "refs/heads/main"), tipSha);
  assert.equal(git(bare, "rev-parse", "refs/tags/v0.4.11^{commit}"), tipSha);

  // Reconcile passes cleanly
  const rec = runScript("version-gate.mjs", ["reconcile", "--remote", "origin", "--branch", "main"], env, product);
  assert.equal(rec.status, 0, rec.stdout + rec.stderr);

  // Multi-push-URL refusal on version-gate.mjs release
  git(product, "remote", "set-url", "--push", "origin", remoteUrl);
  git(product, "remote", "set-url", "--add", "--push", "origin", "codecommit::us-east-1://MyMirror");
  const multi = runScript("version-gate.mjs", ["release", "--remote", "origin", "--branch", "main"], env, product);
  assert.equal(multi.status, 2, multi.stdout + multi.stderr);
});

test("J1: GRC CODE_COMMIT_ENDPOINT override and trailing .git repo names fail closed across gates with zero aws/git push calls", () => {
  // 1) CODE_COMMIT_ENDPOINT override with green CodeBuild mocked and also with require: []
  const { bare, product, store, sha, suiteFile } = setupCodeCommitLoop({
    remoteUrl: "codecommit::us-east-1://MyRepo",
    require: ["codebuild/verify"],
  });
  const grc = makeGrcShim(bare);
  const greenBuild = makeBuild(sha, { n: 1, status: "SUCCEEDED" });
  const aws = fakeAws({ account: ACCOUNT, projects: { verify: { ids: [greenBuild.id] } }, builds: { [greenBuild.id]: greenBuild } });
  const env = {
    ...process.env,
    PATH: `${aws.bin}:${grc.bin}:${process.env.PATH}`,
    CODE_COMMIT_ENDPOINT: "https://attacker.example",
    SELF_LOOP_LOAD_DIR: temp("load-"),
  };
  const ciRes = runScript("ci-green.mjs", ["--repo", product, "--sha", sha, "--require", "codebuild/verify"], env);
  assert.equal(ciRes.status, 2);
  assert.equal(JSON.parse(ciRes.stdout).ci, "unknown");
  assert.match(JSON.parse(ciRes.stdout).error, /CODE_COMMIT_ENDPOINT/);
  const pushRes = runScript("gated-push.mjs", ["--repo", product, "--owner-store", store, "--branch", "main", "--sha", sha, "--suite-receipt", suiteFile], env);
  assert.equal(pushRes.status, 2);
  assert.match(pushRes.stderr, /CODE_COMMIT_ENDPOINT/);
  const recRes = runScript("version-gate.mjs", ["reconcile", "--remote", "origin", "--branch", "main"], env, product);
  assert.equal(recRes.status, 2);
  // Explicit GRC URL pre-push (name === url) with synthetic profile + CODE_COMMIT_ENDPOINT (value and whitespace)
  const explicitUrl = "codecommit::us-east-1://synth-prepush-profile-77@MyRepo";
  for (const override of ["https://attacker.example", "   "]) {
    const ppRes = spawnSync(process.execPath, [join(scripts, "version-gate.mjs"), "pre-push", explicitUrl, explicitUrl], {
      cwd: product,
      env: { ...env, CODE_COMMIT_ENDPOINT: override },
      input: `refs/heads/main ${sha} refs/heads/main ${"0".repeat(40)}\n`,
      encoding: "utf8",
    });
    assert.equal(ppRes.status, 2, `explicit URL pre-push must refuse (${JSON.stringify(override)}): ${ppRes.stdout} ${ppRes.stderr}`);
    const out = ppRes.stdout + ppRes.stderr;
    assert.match(out, /CODE_COMMIT_ENDPOINT/);
    assert.equal(out.includes("synth-prepush-profile-77"), false, `profile leaked: ${out}`);
    assert.equal(out.includes("attacker.example"), false, `override leaked: ${out}`);
  }
  assert.equal(spawnSync("git", ["-C", bare, "rev-parse", "--verify", "-q", "refs/heads/main"]).status, 1, "nothing pushed");
  assert.deepEqual(aws.calls(), [], "zero aws calls under CODE_COMMIT_ENDPOINT override");
  assert.deepEqual(grc.calls(), [], "GRC helper never invoked under CODE_COMMIT_ENDPOINT override");

  // 2) GRC remote ending in .git fails closed (official helper does not strip .git; AWS forbids repo names ending in .git)
  git(product, "remote", "set-url", "origin", "codecommit::us-east-1://MyRepo.git");
  const cleanEnv = { ...env };
  delete cleanEnv.CODE_COMMIT_ENDPOINT;
  const dotGitCi = runScript("ci-green.mjs", ["--repo", product, "--sha", sha, "--require", "codebuild/verify"], cleanEnv);
  assert.equal(dotGitCi.status, 2);
  assert.equal(JSON.parse(dotGitCi.stdout).ci, "unknown");
  const dotGitPush = runScript("gated-push.mjs", ["--repo", product, "--owner-store", store, "--branch", "main", "--sha", sha, "--suite-receipt", suiteFile], cleanEnv);
  assert.equal(dotGitPush.status, 2);
  assert.deepEqual(aws.calls(), [], "zero aws calls for GRC .git repo");
  assert.deepEqual(grc.calls(), [], "GRC helper never invoked for GRC .git repo");
});

test("J2 (AC-30): GRC push failure redacts synthetic profile from stdout and stderr under gated-push", () => {
  const synthProfile = "synth-secret-profile-99";
  const { bare, product, store, sha, suiteFile } = setupCodeCommitLoop({
    remoteUrl: `codecommit::us-east-1://${synthProfile}@MyRepo`,
    require: [],
  });
  const grc = makeGrcShim(bare, { failProfile: synthProfile });
  const env = { HOME: temp("home-"), PATH: `${grc.bin}:/usr/bin:/bin`, SELF_LOOP_LOAD_DIR: temp("load-") };
  const res = runScript("gated-push.mjs", ["--repo", product, "--owner-store", store, "--branch", "main", "--sha", sha, "--suite-receipt", suiteFile], env);
  assert.notEqual(res.status, 0, "failed GRC push must exit non-zero");
  assert.equal(res.stdout.includes(synthProfile), false, `profile leaked to stdout: ${res.stdout}`);
  assert.equal(res.stderr.includes(synthProfile), false, `profile leaked to stderr: ${res.stderr}`);
  assert.match(res.stderr, /\*\*\*/);
  assert.equal(spawnSync("git", ["-C", bare, "rev-parse", "--verify", "-q", "refs/heads/main"]).status, 1, "bare repo unchanged");
  assert.equal(grc.calls().length, 1, "controlled GRC helper actually ran and failed");
});
