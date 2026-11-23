// Unit and adversarial verification of AWS CodeCommit destination parsing, GRC region resolution,
// anti-spoofing (including WHATWG/RFC 3986 parser-differential defense), credential redaction, and cross-forge rules.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  DestinationError, grcEndpointProblem, isCodeCommitHost, parseDestination, redactDestinationOutput, shownUrl,
} from "../lib/ci-destination.mjs";
import { FORGES, pushDestination } from "../lib/ci.mjs";
import { fakeAws, fakeGh, git, repo, scripts, skill, temp } from "./helpers.mjs";

const ACCOUNT = "123456789012";

function ciGreenCli(args, env) {
  return spawnSync(process.execPath, [join(scripts, "ci-green.mjs"), ...args], { encoding: "utf8", env });
}

function makeRepo(url) {
  const r = repo({ "a.txt": "1\n" });
  git(r, "remote", "add", "origin", url);
  return { r, sha: git(r, "rev-parse", "HEAD") };
}

test("CC-01..CC-03: parseDestination handles standard, FIPS, China, GovCloud, VPC, SSH, SCP, and GRC remotes with exact case", () => {
  const cases = [
    ["https://git-codecommit.us-east-1.amazonaws.com/v1/repos/MyRepo", { forge: "codecommit", host: "git-codecommit.us-east-1.amazonaws.com", region: "us-east-1", repository: "MyRepo", profile: null }],
    ["https://git-codecommit.us-east-1.amazonaws.com:443/v1/repos/MyRepo.git/", { forge: "codecommit", host: "git-codecommit.us-east-1.amazonaws.com", region: "us-east-1", repository: "MyRepo", profile: null }],
    ["https://git-codecommit-fips.us-east-1.amazonaws.com/v1/repos/MyRepo.git", { forge: "codecommit", host: "git-codecommit.us-east-1.amazonaws.com", region: "us-east-1", repository: "MyRepo", profile: null }],
    ["https://git-codecommit.cn-north-1.amazonaws.com.cn/v1/repos/CnRepo", { forge: "codecommit", host: "git-codecommit.cn-north-1.amazonaws.com.cn", region: "cn-north-1", repository: "CnRepo", profile: null }],
    ["https://git-codecommit-fips.us-gov-west-1.amazonaws.com/v1/repos/GovRepo", { forge: "codecommit", host: "git-codecommit.us-gov-west-1.amazonaws.com", region: "us-gov-west-1", repository: "GovRepo", profile: null }],
    ["https://vpce-0123abcd-ef45.git-codecommit.us-east-1.vpce.amazonaws.com/v1/repos/MyRepo", { forge: "codecommit", host: "git-codecommit.us-east-1.amazonaws.com", region: "us-east-1", repository: "MyRepo", profile: null }],
    ["https://vpce-0123abcd.git-codecommit-fips.cn-northwest-1.vpce.amazonaws.com.cn/v1/repos/CnRepo.git", { forge: "codecommit", host: "git-codecommit.cn-northwest-1.amazonaws.com.cn", region: "cn-northwest-1", repository: "CnRepo", profile: null }],
    ["ssh://APKAEXAMPLE12345678@git-codecommit.us-east-1.amazonaws.com:22/v1/repos/MyRepo.git", { forge: "codecommit", host: "git-codecommit.us-east-1.amazonaws.com", region: "us-east-1", repository: "MyRepo", profile: null }],
    ["APKAEXAMPLE12345678@git-codecommit.us-east-1.amazonaws.com:v1/repos/MyRepo", { forge: "codecommit", host: "git-codecommit.us-east-1.amazonaws.com", region: "us-east-1", repository: "MyRepo", profile: null }],
    ["APKAEXAMPLE12345678@git-codecommit.us-east-1.amazonaws.com:/v1/repos/MyRepo.git/", { forge: "codecommit", host: "git-codecommit.us-east-1.amazonaws.com", region: "us-east-1", repository: "MyRepo", profile: null }],
    ["codecommit::us-east-1://MyRepo", { forge: "codecommit", host: "git-codecommit.us-east-1.amazonaws.com", region: "us-east-1", repository: "MyRepo", profile: null }],
    ["codecommit::US-EAST-1://work_1@MyRepo/", { forge: "codecommit", host: "git-codecommit.us-east-1.amazonaws.com", region: "us-east-1", repository: "MyRepo", profile: "work_1" }],
    ["codecommit://MyRepo", { forge: "codecommit", host: null, region: null, repository: "MyRepo", profile: null }],
    ["codecommit://work@MyRepo", { forge: "codecommit", host: null, region: null, repository: "MyRepo", profile: "work" }],
  ];
  for (const [url, expected] of cases) assert.deepEqual(parseDestination(url), expected, url);
  assert.equal(isCodeCommitHost("git-codecommit.us-east-1.amazonaws.com"), true);
  assert.equal(isCodeCommitHost("vpce-123.git-codecommit-fips.us-east-1.vpce.amazonaws.com"), true);
  assert.equal(isCodeCommitHost("github.com"), false);
  assert.ok(FORGES.github && FORGES.codecommit);
});

test("AC-03: deleted legacy CI symbols have zero hits in scripts/ and acceptance/ code", () => {
  const deleted = ["fetch" + "CheckRuns", "repo" + "Slug", "destination" + "Identity", "CI_" + "HOSTS"];
  const re = new RegExp(`\\b(${deleted.join("|")})\\b`);
  const hits = [];
  const walk = dir => {
    for (const name of readdirSync(dir)) {
      if (name === "fixtures" || name.startsWith(".")) continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(m?js|cjs|md)$/.test(name) && re.test(readFileSync(full, "utf8"))) hits.push(full);
    }
  };
  walk(scripts);
  walk(join(skill, "acceptance"));
  assert.deepEqual(hits, []);
});

test("AC-08 & AC-09: regionless GRC botocore precedence, AWS_REGION disagreement refusal, and profile redaction", () => {
  const { r, sha } = makeRepo("codecommit://work@MyRepo");
  const aws = fakeAws({
    account: ACCOUNT,
    profiles: { work: { region: "us-east-1" } },
    projects: { verify: { ids: [] } },
    builds: {},
  });
  const cleanEnv = extra => {
    const env = { ...aws.env };
    delete env.AWS_REGION;
    delete env.AWS_DEFAULT_REGION;
    delete env.AWS_PROFILE;
    return { ...env, ...extra };
  };

  // AC-08: AWS_REGION disagrees with profile work region -> DestinationError, zero sts/codebuild calls, profile redacted
  const disagree = ciGreenCli(["--repo", r, "--sha", sha, "--require", "codebuild/verify"], cleanEnv({ AWS_REGION: "eu-west-1" }));
  assert.equal(disagree.status, 2);
  const rd = JSON.parse(disagree.stdout);
  assert.equal(rd.ci, "unknown");
  assert.match(rd.error, /region disagreement/i);
  assert.doesNotMatch(rd.error, /\bwork\b/);
  assert.ok(aws.calls().every(c => c.argv[0] === "configure"), "zero sts/codebuild calls on region disagreement");

  // AC-09: AWS_DEFAULT_REGION > profile region > missing > AWS_REGION alone
  aws.clearCalls();
  const defRes = JSON.parse(ciGreenCli(["--repo", r, "--sha", sha, "--require", "codebuild/verify"], cleanEnv({ AWS_DEFAULT_REGION: "us-west-2" })).stdout);
  assert.deepEqual([defRes.region, defRes.host], ["us-west-2", "git-codecommit.us-west-2.amazonaws.com"]);

  aws.clearCalls();
  const profRes = JSON.parse(ciGreenCli(["--repo", r, "--sha", sha, "--require", "codebuild/verify"], cleanEnv({})).stdout);
  assert.deepEqual([profRes.region, profRes.host], ["us-east-1", "git-codecommit.us-east-1.amazonaws.com"]);

  aws.serve({ account: ACCOUNT, profiles: {}, projects: {}, builds: {} });
  const noneRes = JSON.parse(ciGreenCli(["--repo", r, "--sha", sha, "--require", "codebuild/verify"], cleanEnv({})).stdout);
  assert.equal(noneRes.ci, "unknown");
  assert.match(noneRes.error, /could not be resolved/);
  assert.doesNotMatch(noneRes.error, /\bwork\b/);

  const onlyAwsRegion = JSON.parse(ciGreenCli(["--repo", r, "--sha", sha, "--require", "codebuild/verify"], cleanEnv({ AWS_REGION: "us-east-1" })).stdout);
  assert.equal(onlyAwsRegion.ci, "unknown");
  assert.match(onlyAwsRegion.error, /ignores AWS_REGION alone/);
});

test("AC-10: malformed GRC profiles fail parseDestination and leak nothing through shownUrl", () => {
  for (const [url, forbidden] of [
    ["codecommit://a@b@MyRepo", [/\ba\b/, /\bb\b/]],
    ["codecommit://-x@MyRepo", [/-x/]],
    ["codecommit://a:b@MyRepo", [/a:b/, /\ba\b/, /\bb\b/]],
  ]) {
    assert.equal(parseDestination(url), null, url);
    const shown = shownUrl(url);
    assert.equal(shown, "codecommit://***@MyRepo", url);
    for (const pat of forbidden) assert.doesNotMatch(shown, pat, `${url} -> ${shown}`);
  }
});

test("AC-29 & B1: spoofed, malformed, backslash/control/whitespace parser-differential URLs return null and invoke zero aws/gh calls", () => {
  const hostile = [
    // B1 parser-differential URLs (WHATWG vs RFC 3986 / curl / Git)
    "https://git-codecommit.us-east-1.amazonaws.com\\@127.0.0.1:9/v1/repos/MyRepo",
    "https://\\git-codecommit.us-east-1.amazonaws.com/v1/repos/MyRepo",
    "https://git-code\tcommit.us-east-1.amazonaws.com/v1/repos/MyRepo",
    "https://git-codecommit.us-east-1.amazonaws.com/v1/repos/My\tRepo",
    "https://github.com\\@127.0.0.1:9/example/product.git",
    "ssh://APKA123@git-codecommit.us-east-1.amazonaws.com\\@127.0.0.1/v1/repos/MyRepo",
    "codecommit://My\\Repo",
    "APKA123@git-codecommit.us-east-1.amazonaws.com:v1/repos/My\\Repo",
    // Spoofing, non-default ports, partitions, traversal, percent-encoding, query/fragment, ext::, invalid regions
    "https://git-codecommit.us-east-1.amazonaws.com.evil.example/v1/repos/MyRepo",
    "https://evil-git-codecommit.us-east-1.amazonaws.com/v1/repos/MyRepo",
    "http://git-codecommit.us-east-1.amazonaws.com/v1/repos/MyRepo",
    "https://git-codecommit.us-east-1.amazonaws.com:8443/v1/repos/MyRepo",
    "ssh://APKA123@git-codecommit.us-east-1.amazonaws.com:2222/v1/repos/MyRepo",
    "https://git-codecommit.cn-north-1.amazonaws.com/v1/repos/MyRepo",
    "https://git-codecommit.us-east-1.amazonaws.com.cn/v1/repos/MyRepo",
    "https://vpce-1.git-codecommit.us-east-1.amazonaws.com/v1/repos/MyRepo",
    "https://git-codecommit.us-east-1.amazonaws.com/v1/repos/a/b",
    "https://git-codecommit.us-east-1.amazonaws.com/v1/repos/..",
    "https://git-codecommit.us-east-1.amazonaws.com/v1/repos/a/../b",
    "https://git-codecommit.us-east-1.amazonaws.com/v1/repos/My%2FRepo",
    "https://git-codecommit.us-east-1.amazonaws.com/v1/repos/My%20Repo",
    "https://git-codecommit.us-east-1.amazonaws.com/v1/repos/MyRepo?x=1",
    "https://git-codecommit.us-east-1.amazonaws.com/v1/repos/MyRepo#f",
    "ext::sh -c echo",
    "codecommit::bad_region://r",
    "codecommit::us-iso-east-1://r",
    "codecommit::eusc-de-east-1://r",
    // J1: official git-remote-codecommit forwards repo verbatim without stripping .git; AWS forbids repo names ending in .git
    "codecommit::us-east-1://MyRepo.git",
    "codecommit::us-east-1://work@MyRepo.git/",
    "codecommit://MyRepo.git",
    "codecommit://work@MyRepo.git",
    "https://git-codecommit.us-east-1.amazonaws.com/v1/repos/MyRepo.git.git",
  ];
  const aws = fakeAws({ account: ACCOUNT });
  const gh = fakeGh({});
  const env = { ...process.env, PATH: `${aws.bin}:${gh.bin}:${process.env.PATH}` };
  for (const url of hostile) {
    assert.equal(parseDestination(url), null, url);
    if (/[\r\n]/.test(url)) continue;
    const { r, sha } = makeRepo(url);
    const res = ciGreenCli(["--repo", r, "--sha", sha, "--require", "codebuild/verify"], env);
    assert.equal(res.status, 2, url);
    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.ci, "unknown", url);
    assert.equal(parsed.ok, false, url);
  }
  // Control chars rejected by parseDestination as well (not storable in git config newline-delimited)
  assert.equal(parseDestination("https://git-code\r\ncommit.us-east-1.amazonaws.com/v1/repos/MyRepo"), null);
  assert.equal(parseDestination("https://git-code\x00commit.us-east-1.amazonaws.com/v1/repos/MyRepo"), null);
  assert.deepEqual(aws.calls(), []);
  assert.deepEqual(gh.queries(), []);
});

test("AC-30: credential redaction covers all scheme:// authorities (including git+ssh, ssh+git, ftps) and preserves GitHub git@ display", () => {
  assert.equal(shownUrl("https://user:s3cr3t@git-codecommit.us-east-1.amazonaws.com/v1/repos/MyRepo"), "https://***@git-codecommit.us-east-1.amazonaws.com/v1/repos/MyRepo");
  assert.equal(shownUrl("ssh://APKASECRETKEY123456@git-codecommit.us-east-1.amazonaws.com/v1/repos/MyRepo"), "ssh://***@git-codecommit.us-east-1.amazonaws.com/v1/repos/MyRepo");
  assert.equal(shownUrl("git+ssh://APKASECRETKEY123456@git-codecommit.us-east-1.amazonaws.com/v1/repos/MyRepo"), "git+ssh://***@git-codecommit.us-east-1.amazonaws.com/v1/repos/MyRepo");
  assert.equal(shownUrl("ssh+git://APKASECRETKEY123456@git-codecommit.us-east-1.amazonaws.com/v1/repos/MyRepo"), "ssh+git://***@git-codecommit.us-east-1.amazonaws.com/v1/repos/MyRepo");
  assert.equal(shownUrl("ftps://user:hunter2@files.example.com/repo.git"), "ftps://***@files.example.com/repo.git");
  assert.equal(shownUrl("APKASECRETKEY123456@git-codecommit.us-east-1.amazonaws.com:v1/repos/MyRepo"), "***@git-codecommit.us-east-1.amazonaws.com:v1/repos/MyRepo");
  assert.equal(shownUrl("codecommit::us-east-1://secretprof@MyRepo"), "codecommit::us-east-1://***@MyRepo");
  assert.equal(shownUrl("git@github.com:example/mirror.git"), "git@github.com:example/mirror.git");
  assert.equal(shownUrl("ssh://git@github.com/example/mirror.git"), "ssh://git@github.com/example/mirror.git");
  assert.equal(shownUrl("ssh://git@git-codecommit.us-east-1.amazonaws.com/v1/repos/MyRepo"), "ssh://***@git-codecommit.us-east-1.amazonaws.com/v1/repos/MyRepo");
  assert.equal(shownUrl("/srv/git/user@host/repo"), "/srv/git/user@host/repo");

  const { r } = makeRepo("ssh://APKASECRETKEY123456@git-codecommit.us-east-1.amazonaws.com/v1/repos/MyRepo");
  git(r, "remote", "set-url", "--push", "origin", "ssh://APKASECRETKEY123456@git-codecommit.us-east-1.amazonaws.com/v1/repos/MyRepo");
  git(r, "remote", "set-url", "--add", "--push", "origin", "codecommit::us-east-1://secretprof@MyRepo");
  assert.throws(() => pushDestination(r), e => e instanceof DestinationError && !e.message.includes("APKASECRETKEY123456") && !e.message.includes("secretprof"));

  // Unsupported git+ssh:// scheme still redacts SSH key ID in DestinationError / ci-green output
  const { r: r2, sha: sha2 } = makeRepo("git+ssh://APKASECRETKEY123456@git-codecommit.us-east-1.amazonaws.com/v1/repos/MyRepo");
  const out2 = JSON.parse(ciGreenCli(["--repo", r2, "--sha", sha2, "--require", "codebuild/verify"], process.env).stdout);
  assert.equal(out2.ci, "unknown");
  assert.doesNotMatch(out2.error, /APKASECRETKEY123456/);
});

test("AC-32: cross-forge and invalid check specs fail closed with zero aws/gh calls (including regionless codecommit:// and --from-json)", () => {
  const aws = fakeAws({ account: ACCOUNT });
  const gh = fakeGh({});
  const env = { ...process.env, PATH: `${aws.bin}:${gh.bin}:${process.env.PATH}` };
  delete env.AWS_REGION;
  delete env.AWS_DEFAULT_REGION;
  const runsFile = join(temp(), "runs.json");
  writeFileSync(runsFile, JSON.stringify({ check_runs: [{ app: "codebuild", name: "verify", status: "completed", conclusion: "success", id: 1 }] }));

  const cases = [
    ["https://git-codecommit.us-east-1.amazonaws.com/v1/repos/MyRepo", "github-actions/verify"],
    ["codecommit://MyRepo", "github-actions/verify"],
    ["https://github.com/example/product.git", "codebuild/verify"],
    ["https://git-codecommit.us-east-1.amazonaws.com/v1/repos/MyRepo", "codepipeline/deploy"],
    ["https://git-codecommit.us-east-1.amazonaws.com/v1/repos/MyRepo", "codebuild/--bad"],
    ["https://git-codecommit.us-east-1.amazonaws.com/v1/repos/MyRepo", "codebuild/a/b"],
    ["https://git-codecommit.us-east-1.amazonaws.com/v1/repos/MyRepo", "codebuild/x"],
  ];
  for (const [url, spec] of cases) {
    const { r, sha } = makeRepo(url);
    const live = ciGreenCli(["--repo", r, "--sha", sha, "--require", spec], env);
    assert.equal(live.status, 2, `${url} ${spec}`);
    assert.equal(JSON.parse(live.stdout).ci, "unknown", `${url} ${spec}`);
    assert.equal(JSON.parse(live.stdout).source, "live", `${url} ${spec}`);

    const fromJson = ciGreenCli(["--repo", r, "--sha", sha, "--require", spec, "--from-json", runsFile], env);
    assert.equal(fromJson.status, 2, `from-json ${url} ${spec}`);
    const parsed = JSON.parse(fromJson.stdout);
    assert.equal(parsed.ci, "unknown");
    assert.equal(parsed.source, "from-json");
  }
  assert.deepEqual(aws.calls(), [], "zero aws calls on cross-forge / invalid specs (even on regionless codecommit://)");
  assert.deepEqual(gh.queries(), [], "zero gh calls on cross-forge specs");

  const { r: ccRepo, sha: ccSha } = makeRepo("https://git-codecommit.us-east-1.amazonaws.com/v1/repos/MyRepo");
  const okFromJson = ciGreenCli(["--repo", ccRepo, "--sha", ccSha, "--require", "codebuild/verify", "--from-json", runsFile], env);
  assert.equal(okFromJson.status, 0, okFromJson.stderr);
  assert.equal(JSON.parse(okFromJson.stdout).source, "from-json");
});

test("J1 & J2: CODE_COMMIT_ENDPOINT fails closed on GRC remotes with zero aws calls, and redactDestinationOutput strips profiles and credentials", () => {
  const err = grcEndpointProblem("codecommit::us-east-1://secretprof@MyRepo", { CODE_COMMIT_ENDPOINT: "https://attacker.example" });
  assert.match(err, /CODE_COMMIT_ENDPOINT/);
  assert.doesNotMatch(err, /secretprof|attacker\.example/);
  assert.equal(grcEndpointProblem("https://git-codecommit.us-east-1.amazonaws.com/v1/repos/MyRepo", { CODE_COMMIT_ENDPOINT: "https://attacker.example" }), null);
  assert.equal(grcEndpointProblem("codecommit://MyRepo", {}), null);

  const aws = fakeAws({ account: ACCOUNT, profiles: { work: { region: "us-east-1" } } });
  for (const url of ["codecommit::us-east-1://work@MyRepo", "codecommit://work@MyRepo"]) {
    const { r, sha } = makeRepo(url);
    const res = ciGreenCli(["--repo", r, "--sha", sha, "--require", "codebuild/verify"], { ...aws.env, CODE_COMMIT_ENDPOINT: "https://attacker.example" });
    assert.equal(res.status, 2, url);
    const out = JSON.parse(res.stdout);
    assert.equal(out.ci, "unknown", url);
    assert.match(out.error, /CODE_COMMIT_ENDPOINT/);
    assert.doesNotMatch(out.error, /\bwork\b|attacker\.example/);
  }
  assert.deepEqual(aws.calls(), [], "CODE_COMMIT_ENDPOINT refusal makes zero aws calls");

  const rawErr = "ProfileNotFound: The config profile (synth-secret-profile-99) could not be found for codecommit::us-east-1://synth-secret-profile-99@MyRepo\n";
  const redacted = redactDestinationOutput(rawErr, "codecommit::us-east-1://synth-secret-profile-99@MyRepo");
  assert.doesNotMatch(redacted, /synth-secret-profile-99/);
  assert.match(redacted, /\*\*\*/);
});
