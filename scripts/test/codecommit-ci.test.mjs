// Unit and adversarial verification of AWS CodeBuild CI reading, pagination, ARN/account binding,
// fail-closed edge cases (B2), and redacted error causes (CC-11).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { requiredChecks } from "../lib/check-runs.mjs";
import { awsPartition, codecommitHost } from "../lib/ci-destination.mjs";
import { classifyAwsError, normalizeCodeBuildBuild } from "../lib/ci-codebuild.mjs";
import { fakeAws, git, repo, scripts, skill } from "./helpers.mjs";

const CODEBUILD_BATCH_SIZE = 100;
const CODEBUILD_MAX_BUILDS = 500;

const ACCOUNT = "123456789012";
const OTHER_ACCOUNT = "999999999999";

const uuid = n => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;

function makeBuild({
  project = "verify",
  n = 1,
  region = "us-east-1",
  account = ACCOUNT,
  repoName = "MyRepo",
  sourceLocation = null,
  sourceType = "CODECOMMIT",
  sha = "a".repeat(40),
  resolvedSourceVersion = undefined,
  sourceVersion = undefined,
  buildStatus = "SUCCEEDED",
  startTime = "2026-11-23T08:00:00+04:00",
  buildBatchArn = undefined,
  extra = {},
} = {}) {
  const id = `${project}:${uuid(n)}`;
  const loc = sourceLocation ?? `https://${codecommitHost(region)}/v1/repos/${repoName}`;
  const build = {
    id,
    arn: `arn:${awsPartition(region)}:codebuild:${region}:${account}:build/${id}`,
    buildNumber: n,
    projectName: project,
    buildStatus,
    startTime,
    source: { type: sourceType, location: loc },
    resolvedSourceVersion: resolvedSourceVersion === undefined ? sha : resolvedSourceVersion,
    ...(sourceVersion !== undefined ? { sourceVersion } : {}),
    ...(buildBatchArn !== undefined ? { buildBatchArn } : {}),
    ...extra,
  };
  if (build.resolvedSourceVersion === null) delete build.resolvedSourceVersion;
  return build;
}

const ciGreenCli = (args, env) => spawnSync(process.execPath, [join(scripts, "ci-green.mjs"), ...args], { encoding: "utf8", env });

function makeRepo(url) {
  const r = repo({ "a.txt": "1\n" });
  git(r, "remote", "add", "origin", url);
  return { r, sha: git(r, "rev-parse", "HEAD") };
}

test("AC-04 & AC-05 & CC-10(d)(f): manual pagination (--max-items=100, --starting-token), no --sort-order on >100 builds, stops on match and caps at 500", () => {
  const { r, sha } = makeRepo("https://git-codecommit.us-east-1.amazonaws.com/v1/repos/MyRepo");
  const ids = [], builds = {};
  for (let n = 600; n >= 1; n--) {
    const id = `verify:${uuid(n)}`;
    ids.push(id);
    builds[id] = makeBuild({ n, sha: n === 450 ? sha : "b".repeat(40) });
  }
  const aws = fakeAws({ account: ACCOUNT, projects: { verify: { ids } }, builds });
  const res = ciGreenCli(["--repo", r, "--sha", sha, "--require", "codebuild/verify"], aws.env);
  assert.equal(res.status, 0, res.stderr + res.stdout);
  const reading = JSON.parse(res.stdout);
  assert.equal(reading.ci, "success");
  assert.equal(reading.runs["codebuild/verify"].id, 450);

  const listCalls = aws.calls().filter(c => c.argv[0] === "codebuild" && c.argv[1] === "list-builds-for-project");
  assert.equal(listCalls.length, 2, "match on page 2 stops without fetching page 3");
  assert.ok(listCalls.every(c => c.argv.includes(`--max-items=${CODEBUILD_BATCH_SIZE}`)));
  assert.ok(listCalls.every(c => !c.argv.some(a => a.startsWith("--sort-order") || a.startsWith("--next-token") || a === "--no-paginate")));
  assert.ok(listCalls[1].argv.includes("--starting-token=tok_100"));

  // Cap at CODEBUILD_MAX_BUILDS (500) when commit is deeper than 500 builds -> absent
  aws.clearCalls();
  builds[`verify:${uuid(50)}`] = makeBuild({ n: 50, sha });
  builds[`verify:${uuid(450)}`] = makeBuild({ n: 450, sha: "c".repeat(40) });
  aws.serve({ account: ACCOUNT, projects: { verify: { ids } }, builds });
  const miss = ciGreenCli(["--repo", r, "--sha", sha, "--require", "codebuild/verify"], aws.env);
  assert.equal(miss.status, 2);
  assert.equal(JSON.parse(miss.stdout).ci, "absent");
  assert.equal(aws.calls().filter(c => c.argv[1] === "list-builds-for-project").length, CODEBUILD_MAX_BUILDS / CODEBUILD_BATCH_SIZE);

  // Verify fakeAws enforces AWS CLI v2 semantics (auto-pagination, --next-token, --no-paginate conflict, --sort-order >100)
  const auto = spawnSync("aws", ["codebuild", "list-builds-for-project", "--project-name=verify"], { encoding: "utf8", env: aws.env });
  assert.equal(auto.status, 0);
  assert.equal(JSON.parse(auto.stdout).ids.length, 600);
  assert.notEqual(spawnSync("aws", ["codebuild", "list-builds-for-project", "--project-name=verify", "--next-token=x"], { encoding: "utf8", env: aws.env }).status, 0);
  assert.notEqual(spawnSync("aws", ["codebuild", "list-builds-for-project", "--project-name=verify", "--no-paginate", "--max-items=100"], { encoding: "utf8", env: aws.env }).status, 0);
  assert.notEqual(spawnSync("aws", ["codebuild", "list-builds-for-project", "--project-name=verify", "--sort-order=DESCENDING"], { encoding: "utf8", env: aws.env }).status, 0);
});

test("AC-06: newer IN_PROGRESS or FAILED last on page 1 beats older SUCCEEDED first on page 2 without fetching page 2", () => {
  const { r, sha } = makeRepo("https://git-codecommit.us-east-1.amazonaws.com/v1/repos/MyRepo");
  for (const [status, expectedCi] of [["IN_PROGRESS", "pending"], ["FAILED", "failure"]]) {
    const ids = [], builds = {};
    for (let n = 150; n >= 1; n--) {
      const id = `verify:${uuid(n)}`;
      ids.push(id);
      if (n === 51) builds[id] = makeBuild({ n, sha, buildStatus: status });
      else if (n === 50) builds[id] = makeBuild({ n, sha, buildStatus: "SUCCEEDED" });
      else builds[id] = makeBuild({ n, sha: "b".repeat(40) });
    }
    const aws = fakeAws({ account: ACCOUNT, projects: { verify: { ids } }, builds });
    const res = ciGreenCli(["--repo", r, "--sha", sha, "--require", "codebuild/verify"], aws.env);
    assert.equal(res.status, 2);
    assert.equal(JSON.parse(res.stdout).ci, expectedCi);
    assert.equal(aws.calls().filter(c => c.argv[1] === "list-builds-for-project").length, 1);
  }
});

test("AC-07: non-strictly-decreasing buildNumber within a page or across page boundary fails closed as unknown", () => {
  const { r, sha } = makeRepo("https://git-codecommit.us-east-1.amazonaws.com/v1/repos/MyRepo");
  const b1 = makeBuild({ n: 10, sha: "b".repeat(40) });
  const b2 = makeBuild({ n: 12, sha });
  const aws1 = fakeAws({ account: ACCOUNT, projects: { verify: { ids: [b1.id, b2.id] } }, builds: { [b1.id]: b1, [b2.id]: b2 } });
  const r1 = JSON.parse(ciGreenCli(["--repo", r, "--sha", sha, "--require", "codebuild/verify"], aws1.env).stdout);
  assert.equal(r1.ci, "unknown");
  assert.match(r1.error, /buildNumber ordering violation/);
  assert.match(r1.missing[0], /buildNumber ordering violation/);

  const page1Ids = [], builds2 = {};
  for (let n = 100; n >= 1; n--) {
    const b = makeBuild({ n, sha: "b".repeat(40) });
    page1Ids.push(b.id);
    builds2[b.id] = b;
  }
  const cross = makeBuild({ n: 5, sha, extra: { id: `verify:${uuid(999)}`, arn: `arn:aws:codebuild:us-east-1:${ACCOUNT}:build/verify:${uuid(999)}` } });
  builds2[cross.id] = cross;
  const aws2 = fakeAws({
    account: ACCOUNT,
    projects: { verify: { pages: [{ ids: page1Ids, NextToken: "page_1" }, { ids: [cross.id] }] } },
    builds: builds2,
  });
  const r2 = JSON.parse(ciGreenCli(["--repo", r, "--sha", sha, "--require", "codebuild/verify"], aws2.env).stdout);
  assert.equal(r2.ci, "unknown");
  assert.match(r2.error, /buildNumber ordering violation/);
});

test("AC-11 & CC-10(b)(c): AWS child env strips AWS_ENDPOINT_URL*, disables prompts/pager, pins region, and uses --flag=value", () => {
  const dirty = {
    AWS_ENDPOINT_URL: "http://evil.invalid",
    AWS_ENDPOINT_URL_CODEBUILD: "http://evil-cb.invalid",
    aws_endpoint_url_sts: "http://evil-sts.invalid",
    AWS_CLI_AUTO_PROMPT: "on",
    AWS_PAGER: "less",
    AWS_REGION: "ap-south-1",
    AWS_DEFAULT_REGION: "ap-south-1",
  };
  const { r, sha } = makeRepo("codecommit::us-east-1://ops@MyRepo");
  const b = makeBuild({ n: 5, sha });
  const aws = fakeAws({ account: ACCOUNT, projects: { verify: { ids: [b.id] } }, builds: { [b.id]: b } });
  const res = ciGreenCli(["--repo", r, "--sha", sha, "--require", "codebuild/verify"], { ...process.env, ...dirty, PATH: aws.env.PATH });
  assert.equal(res.status, 0, res.stderr + res.stdout);
  assert.ok(aws.calls().length >= 3);
  for (const call of aws.calls()) {
    assert.deepEqual(call.env.endpointKeys, []);
    assert.equal(call.env.AWS_IGNORE_CONFIGURED_ENDPOINT_URLS, "true");
    assert.equal(call.env.AWS_CLI_AUTO_PROMPT, "off");
    assert.equal(call.env.AWS_PAGER, "");
    assert.equal(call.env.AWS_REGION, "us-east-1");
    assert.equal(call.env.AWS_DEFAULT_REGION, "us-east-1");
    assert.ok(call.argv.includes("--profile=ops"));
    assert.ok(call.argv.includes("--region=us-east-1"));
    for (const tok of call.argv.filter(t => t.startsWith("--"))) assert.ok(tok.includes("="), `flag must be --flag=value: ${tok}`);
  }
  // Regionless GRC configure lookup strips AWS_REGION and AWS_DEFAULT_REGION from child env
  const { r: r2, sha: sha2 } = makeRepo("codecommit://ops@MyRepo");
  aws.clearCalls();
  aws.serve({ account: ACCOUNT, profiles: { ops: { region: "us-east-1" } }, projects: { verify: { ids: [] } }, builds: {} });
  const cleanEnv = { ...process.env, ...dirty, PATH: aws.env.PATH };
  delete cleanEnv.AWS_REGION;
  delete cleanEnv.AWS_DEFAULT_REGION;
  ciGreenCli(["--repo", r2, "--sha", sha2, "--require", "codebuild/verify"], cleanEnv);
  const cfgCall = aws.calls().find(c => c.argv[0] === "configure");
  assert.ok(cfgCall);
  assert.deepEqual(cfgCall.env.endpointKeys, []);
  assert.equal(cfgCall.env.AWS_REGION, undefined);
  assert.equal(cfgCall.env.AWS_DEFAULT_REGION, undefined);
});

test("AC-12 & B2(nexttokctl): hostile build IDs and hostile/whitespace/control NextToken fail closed without reaching aws argv", () => {
  const { r, sha } = makeRepo("https://git-codecommit.us-east-1.amazonaws.com/v1/repos/MyRepo");
  for (const badId of ["--endpoint-url=http://evil", `other:${uuid(1)}`]) {
    const aws = fakeAws({ account: ACCOUNT, projects: { verify: { ids: [badId] } }, builds: {} });
    const out = JSON.parse(ciGreenCli(["--repo", r, "--sha", sha, "--require", "codebuild/verify"], aws.env).stdout);
    assert.equal(out.ci, "unknown");
    assert.ok(aws.calls().every(c => !c.argv.some(a => a.includes(badId))));
    assert.equal(aws.calls().filter(c => c.argv[1] === "batch-get-builds").length, 0);
  }
  const b = makeBuild({ n: 1, sha: "b".repeat(40) });
  for (const badToken of ["--endpoint-url=http://evil", "tok with space", "tok\nnewline", "tok\x00nul"]) {
    const aws = fakeAws({
      account: ACCOUNT,
      projects: { verify: { pages: [{ ids: [b.id], NextToken: badToken }] } },
      builds: { [b.id]: b },
    });
    const out = JSON.parse(ciGreenCli(["--repo", r, "--sha", sha, "--require", "codebuild/verify"], aws.env).stdout);
    assert.equal(out.ci, "unknown", JSON.stringify(badToken));
    assert.match(out.error, /invalid NextToken/);
    assert.match(out.missing[0], /invalid NextToken/);
    assert.ok(aws.calls().every(c => !c.argv.some(a => a.includes(badToken))));
  }
});

test("AC-13 & AC-14: mismatched/missing projectName, ARN region/partition mismatch, and cross-account ARN fail closed as unknown", () => {
  const { r, sha } = makeRepo("https://git-codecommit.us-east-1.amazonaws.com/v1/repos/MyRepo");
  const badCases = [
    ["wrong-projectName", makeBuild({ n: 1, sha, extra: { projectName: "other" } })],
    ["missing-projectName", makeBuild({ n: 1, sha, extra: { projectName: undefined } })],
    ["arn-wrong-region", makeBuild({ n: 1, sha, extra: { arn: `arn:aws:codebuild:eu-west-1:${ACCOUNT}:build/verify:${uuid(1)}` } })],
    ["arn-wrong-partition", makeBuild({ n: 1, sha, extra: { arn: `arn:aws-cn:codebuild:us-east-1:${ACCOUNT}:build/verify:${uuid(1)}` } })],
    ["arn-wrong-uuid", makeBuild({ n: 1, sha, extra: { arn: `arn:aws:codebuild:us-east-1:${ACCOUNT}:build/verify:${uuid(9)}` } })],
  ];
  for (const [label, b] of badCases) {
    const aws = fakeAws({ account: ACCOUNT, projects: { verify: { ids: [b.id] } }, builds: { [b.id]: b } });
    const out = JSON.parse(ciGreenCli(["--repo", r, "--sha", sha, "--require", "codebuild/verify"], aws.env).stdout);
    assert.equal(out.ci, "unknown", label);
    assert.equal(out.ok, false, label);
  }
  const cross = makeBuild({ n: 1, sha, account: OTHER_ACCOUNT });
  const aws = fakeAws({ account: ACCOUNT, projects: { verify: { ids: [cross.id] } }, builds: { [cross.id]: cross } });
  const out = JSON.parse(ciGreenCli(["--repo", r, "--sha", sha, "--require", "codebuild/verify"], aws.env).stdout);
  assert.equal(out.ci, "unknown");
  assert.ok(out.error.includes(OTHER_ACCOUNT) && out.error.includes(ACCOUNT), out.error);
  assert.ok(out.missing[0].includes(OTHER_ACCOUNT) && out.missing[0].includes(ACCOUNT), out.missing[0]);
});

test("AC-15 & AC-16: all CodeCommit URL transports converge to identical canonical identity + DEBT.md records D-0053 Option (a) and R-0007-actor-a", () => {
  const urls = [
    "https://git-codecommit.us-east-1.amazonaws.com/v1/repos/MyRepo",
    "https://git-codecommit-fips.us-east-1.amazonaws.com/v1/repos/MyRepo.git",
    "https://vpce-0123abcd-ef45.git-codecommit.us-east-1.vpce.amazonaws.com/v1/repos/MyRepo",
    "ssh://APKAEXAMPLE12345678@git-codecommit.us-east-1.amazonaws.com/v1/repos/MyRepo",
    "APKAEXAMPLE12345678@git-codecommit.us-east-1.amazonaws.com:v1/repos/MyRepo",
    "codecommit::us-east-1://MyRepo",
    "codecommit://MyRepo",
  ];
  const expected = { forge: "codecommit", host: "git-codecommit.us-east-1.amazonaws.com", region: "us-east-1", account: ACCOUNT, repository: "MyRepo" };
  for (const url of urls) {
    const { r, sha } = makeRepo(url);
    const b = makeBuild({ n: 3, sha });
    const aws = fakeAws({ account: ACCOUNT, profiles: { default: { region: "us-east-1" } }, projects: { verify: { ids: [b.id] } }, builds: { [b.id]: b } });
    const env = { ...aws.env };
    delete env.AWS_REGION;
    delete env.AWS_DEFAULT_REGION;
    const res = ciGreenCli(["--repo", r, "--sha", sha, "--require", "codebuild/verify"], env);
    assert.equal(res.status, 0, `${url}: ${res.stderr} ${res.stdout}`);
    const out = JSON.parse(res.stdout);
    assert.deepEqual({ forge: out.forge, host: out.host, region: out.region, account: out.account, repository: out.repository }, expected, url);
    assert.equal(out.source, "live");
  }
  const debt = readFileSync(join(skill, "DEBT.md"), "utf8");
  assert.match(debt, /D-0053 Option \(a\)/);
  assert.match(debt, /R-0007-actor-a/);
});

test("AC-17..AC-23 & B2(exactset, dupentry, pendingbatch): batch builds, unresolved reruns, missing/duplicate builds, unresolved SUCCEEDED, tie-break, timestamps", () => {
  const { r, sha } = makeRepo("https://git-codecommit.us-east-1.amazonaws.com/v1/repos/MyRepo");

  // AC-17: matched build with buildBatchArn -> unknown
  const batchHi = makeBuild({ n: 10, sha, buildStatus: "SUCCEEDED", buildBatchArn: `arn:aws:codebuild:us-east-1:${ACCOUNT}:build-batch/verify:${uuid(10)}` });
  const batchLo = makeBuild({ n: 9, sha, buildStatus: "FAILED", buildBatchArn: `arn:aws:codebuild:us-east-1:${ACCOUNT}:build-batch/verify:${uuid(10)}` });
  const aws17 = fakeAws({ account: ACCOUNT, projects: { verify: { ids: [batchHi.id, batchLo.id] } }, builds: { [batchHi.id]: batchHi, [batchLo.id]: batchLo } });
  const r17 = JSON.parse(ciGreenCli(["--repo", r, "--sha", sha, "--require", "codebuild/verify"], aws17.env).stdout);
  assert.equal(r17.ci, "unknown");
  assert.equal(r17.error, "CodeBuild batch builds are not read in batch 1");

  // AC-18 & AC-19: older SUCCEEDED + newer unresolved IN_PROGRESS -> pending; resolves to other SHA -> success
  const queued = makeBuild({ n: 20, sha, resolvedSourceVersion: null, sourceVersion: "refs/heads/main", buildStatus: "IN_PROGRESS" });
  const olderOk = makeBuild({ n: 19, sha, buildStatus: "SUCCEEDED" });
  const aws18 = fakeAws({ account: ACCOUNT, projects: { verify: { ids: [queued.id, olderOk.id] } }, builds: { [queued.id]: queued, [olderOk.id]: olderOk } });
  assert.equal(JSON.parse(ciGreenCli(["--repo", r, "--sha", sha, "--require", "codebuild/verify"], aws18.env).stdout).ci, "pending");

  const resolvedOther = makeBuild({ n: 20, sha: "d".repeat(40), sourceVersion: "refs/heads/main", buildStatus: "SUCCEEDED" });
  aws18.serve({ account: ACCOUNT, projects: { verify: { ids: [resolvedOther.id, olderOk.id] } }, builds: { [resolvedOther.id]: resolvedOther, [olderOk.id]: olderOk } });
  assert.equal(JSON.parse(ciGreenCli(["--repo", r, "--sha", sha, "--require", "codebuild/verify"], aws18.env).stdout).ci, "success");

  // B2(pendingbatch): unresolved IN_PROGRESS batch build superseding matched SUCCEEDED -> unknown (not pending/success)
  const pendingBatch = makeBuild({
    n: 21, sha, resolvedSourceVersion: null, sourceVersion: "refs/heads/main", buildStatus: "IN_PROGRESS",
    buildBatchArn: `arn:aws:codebuild:us-east-1:${ACCOUNT}:build-batch/verify:${uuid(21)}`,
  });
  aws18.serve({ account: ACCOUNT, projects: { verify: { ids: [pendingBatch.id, olderOk.id] } }, builds: { [pendingBatch.id]: pendingBatch, [olderOk.id]: olderOk } });
  const rPendingBatch = JSON.parse(ciGreenCli(["--repo", r, "--sha", sha, "--require", "codebuild/verify"], aws18.env).stdout);
  assert.equal(rPendingBatch.ci, "unknown");
  assert.equal(rPendingBatch.error, "CodeBuild batch builds are not read in batch 1");
  assert.match(rPendingBatch.missing[0], /batch builds are not read/);

  // AC-20: buildsNotFound -> unknown
  const aws20 = fakeAws({ account: ACCOUNT, projects: { verify: { ids: [olderOk.id] } }, builds: {} });
  const r20 = JSON.parse(ciGreenCli(["--repo", r, "--sha", sha, "--require", "codebuild/verify"], aws20.env).stdout);
  assert.equal(r20.ci, "unknown");
  assert.match(r20.error, /buildsNotFound/);

  // B2(exactset): batch-get-builds omits a requested build without listing buildsNotFound -> unknown (exit 2, not exit 64 crash)
  const awsOmit = fakeAws({ account: ACCOUNT, projects: { verify: { ids: [olderOk.id] } }, builds: { [olderOk.id]: olderOk }, omitIds: [olderOk.id] });
  const omitRes = ciGreenCli(["--repo", r, "--sha", sha, "--require", "codebuild/verify"], awsOmit.env);
  assert.equal(omitRes.status, 2, omitRes.stderr);
  const rOmit = JSON.parse(omitRes.stdout);
  assert.equal(rOmit.ci, "unknown");
  assert.match(rOmit.error, /did not return exact requested builds/);
  assert.match(rOmit.missing[0], /did not return exact requested builds/);

  // B2(dupentry): batch-get-builds returns duplicate build entry -> unknown
  const awsDup = fakeAws({ account: ACCOUNT, projects: { verify: { ids: [olderOk.id] } }, builds: { [olderOk.id]: olderOk }, extraBuilds: [olderOk] });
  const dupRes = ciGreenCli(["--repo", r, "--sha", sha, "--require", "codebuild/verify"], awsDup.env);
  assert.equal(dupRes.status, 2, dupRes.stderr);
  const rDup = JSON.parse(dupRes.stdout);
  assert.equal(rDup.ci, "unknown");
  assert.match(rDup.error, /duplicate or invalid build entry/);
  assert.match(rDup.missing[0], /duplicate or invalid build entry/);

  // AC-21: SUCCEEDED without resolvedSourceVersion -> absent
  const unresSha = makeBuild({ n: 30, sha, resolvedSourceVersion: null, sourceVersion: sha, buildStatus: "SUCCEEDED" });
  const unresBranch = makeBuild({ n: 29, sha, resolvedSourceVersion: null, sourceVersion: "main", buildStatus: "SUCCEEDED" });
  const aws21 = fakeAws({ account: ACCOUNT, projects: { verify: { ids: [unresSha.id, unresBranch.id] } }, builds: { [unresSha.id]: unresSha, [unresBranch.id]: unresBranch } });
  assert.equal(JSON.parse(ciGreenCli(["--repo", r, "--sha", sha, "--require", "codebuild/verify"], aws21.env).stdout).ci, "absent");

  // AC-22: equal buildNumber tie-break picks FAILED -> failure
  const tie = requiredChecks([
    normalizeCodeBuildBuild(makeBuild({ n: 5, sha, buildStatus: "SUCCEEDED" })),
    normalizeCodeBuildBuild(makeBuild({ n: 5, sha, buildStatus: "FAILED" })),
  ], ["codebuild/verify"], sha);
  assert.equal(tie.ok, false);
  assert.equal(tie.conclusions["codebuild/verify"], "failure");

  // AC-23: missing buildNumber -> unknown; CLI v1 epoch & v2 offset normalize to 24-char UTC ISO
  const noNum = makeBuild({ n: 7, sha, extra: { buildNumber: undefined } });
  const aws23 = fakeAws({ account: ACCOUNT, projects: { verify: { ids: [noNum.id] } }, builds: { [noNum.id]: noNum } });
  assert.equal(JSON.parse(ciGreenCli(["--repo", r, "--sha", sha, "--require", "codebuild/verify"], aws23.env).stdout).ci, "unknown");
  assert.equal(normalizeCodeBuildBuild(makeBuild({ n: 8, sha, startTime: 1700000000.5 })).started_at, "2023-11-14T22:13:20.500Z");
  assert.equal(normalizeCodeBuildBuild(makeBuild({ n: 9, sha, startTime: "2026-11-23T08:00:00+04:00" })).started_at, "2026-11-23T04:00:00.000Z");
});

test("AC-24, AC-25 & CC-09(a)-(h): source filtering, case sensitivity, canonical source.location matching, and status mappings", () => {
  const { r, sha } = makeRepo("https://git-codecommit.us-east-1.amazonaws.com/v1/repos/MyRepo");
  const ignored = [
    makeBuild({ n: 9, sha, repoName: "OtherRepo" }),
    makeBuild({ n: 8, sha, repoName: "myrepo" }),
    makeBuild({ n: 7, sha, sourceLocation: "https://git-codecommit.eu-west-1.amazonaws.com/v1/repos/MyRepo" }),
    makeBuild({ n: 6, sha, sourceType: "GITHUB", sourceLocation: "https://github.com/o/r" }),
    makeBuild({ n: 5, sha, sourceType: "S3", sourceLocation: "my-bucket/key.zip" }),
    makeBuild({ n: 4, sha, sourceType: "NO_SOURCE", sourceLocation: "" }),
    makeBuild({ n: 3, sha, sourceType: "CODEPIPELINE", sourceLocation: "" }),
    makeBuild({ n: 2, sha, sourceType: "NO_SOURCE", sourceLocation: "", extra: { secondarySources: [{ type: "CODECOMMIT", location: "https://git-codecommit.us-east-1.amazonaws.com/v1/repos/MyRepo" }] } }),
  ];
  const aws = fakeAws({ account: ACCOUNT, projects: { verify: { ids: ignored.map(b => b.id) } }, builds: Object.fromEntries(ignored.map(b => [b.id, b])) });
  assert.equal(JSON.parse(ciGreenCli(["--repo", r, "--sha", sha, "--require", "codebuild/verify"], aws.env).stdout).ci, "absent");

  for (const loc of ["https://GIT-CODECOMMIT.US-EAST-1.AMAZONAWS.COM/v1/repos/MyRepo.git/", "https://git-codecommit-fips.us-east-1.amazonaws.com/v1/repos/MyRepo.git"]) {
    const b = makeBuild({ n: 1, sha, sourceLocation: loc });
    aws.serve({ account: ACCOUNT, projects: { verify: { ids: [b.id] } }, builds: { [b.id]: b } });
    assert.equal(JSON.parse(ciGreenCli(["--repo", r, "--sha", sha, "--require", "codebuild/verify"], aws.env).stdout).ci, "success", loc);
  }
  for (const [newerStatus, expectedCi] of [["FAILED", "failure"], ["FAULT", "failure"], ["TIMED_OUT", "failure"], ["STOPPED", "failure"], ["IN_PROGRESS", "pending"]]) {
    const hi = makeBuild({ n: 2, sha, buildStatus: newerStatus }), lo = makeBuild({ n: 1, sha, buildStatus: "SUCCEEDED" });
    aws.serve({ account: ACCOUNT, projects: { verify: { ids: [hi.id, lo.id] } }, builds: { [hi.id]: hi, [lo.id]: lo } });
    assert.equal(JSON.parse(ciGreenCli(["--repo", r, "--sha", sha, "--require", "codebuild/verify"], aws.env).stdout).ci, expectedCi, newerStatus);
  }
  const hiOk = makeBuild({ n: 2, sha, buildStatus: "SUCCEEDED" }), loFail = makeBuild({ n: 1, sha, buildStatus: "FAILED" });
  aws.serve({ account: ACCOUNT, projects: { verify: { ids: [hiOk.id, loFail.id] } }, builds: { [hiOk.id]: hiOk, [loFail.id]: loFail } });
  assert.equal(JSON.parse(ciGreenCli(["--repo", r, "--sha", sha, "--require", "codebuild/verify"], aws.env).stdout).ci, "success");
});

test("CC-11 & B2(idsarray, nonobject): AWS CLI failures, timeout classification, non-object JSON, and non-array ids fail closed with redacted causes", () => {
  const { r, sha } = makeRepo("codecommit::us-east-1://secretprof@MyRepo");
  const scenarios = [
    ["ExpiredTokenException", { stsError: { status: 254, stderr: "An error occurred (ExpiredTokenException) for profile secretprof secret=MYSECRET" } }, /ExpiredTokenException/],
    ["AccessDeniedException", { account: ACCOUNT, listError: { status: 254, stderr: "AccessDeniedException token=MYSECRET profile=secretprof" } }, /AccessDeniedException/],
    ["ResourceNotFoundException", { account: ACCOUNT, projects: { verify: null } }, /ResourceNotFoundException/],
    ["invalid-json", { account: ACCOUNT, stsRaw: "not json at all" }, /invalid JSON/],
    ["non-object-array", { account: ACCOUNT, stsRaw: "[]" }, /non-object JSON/],
    ["non-object-null", { account: ACCOUNT, stsRaw: "null" }, /non-object JSON/],
    ["non-object-number", { account: ACCOUNT, stsRaw: "42" }, /non-object JSON/],
    ["ids-not-array", { account: ACCOUNT, projects: { verify: { listRaw: '{"ids":"not-an-array"}' } } }, /invalid ids/],
  ];
  for (const [label, state, match] of scenarios) {
    const aws = fakeAws(state);
    const out = JSON.parse(ciGreenCli(["--repo", r, "--sha", sha, "--require", "codebuild/verify"], aws.env).stdout);
    assert.equal(out.ci, "unknown", label);
    assert.equal(out.ok, false, label);
    assert.equal(out.runs, null, label);
    assert.match(out.error, match, label);
    assert.match(out.missing[0], match, label);
    assert.doesNotMatch(JSON.stringify(out), /secretprof|MYSECRET/, label);
  }
  const noAws = JSON.parse(ciGreenCli(["--repo", r, "--sha", sha, "--require", "codebuild/verify"], { ...process.env, PATH: "/usr/bin:/bin" }).stdout);
  assert.equal(noAws.ci, "unknown");
  assert.match(noAws.error, /ENOENT/);
  assert.doesNotMatch(JSON.stringify(noAws), /secretprof/);

  // Direct classifier unit coverage including ETIMEDOUT
  assert.equal(classifyAwsError("sts get-caller-identity", { code: "ETIMEDOUT" }), "aws CLI timed out");
  assert.equal(classifyAwsError("sts get-caller-identity", { code: "ENOENT" }), "aws CLI not found (ENOENT)");
  assert.equal(classifyAwsError("codebuild batch-get-builds", { stderr: "Throttling secret=abc" }), "aws codebuild batch-get-builds failed (Throttling)");
  assert.equal(classifyAwsError("sts get-caller-identity", { status: 255, stderr: "secret=abc" }), "aws sts get-caller-identity exited 255");
});
