// AWS STS and CodeBuild subprocess reader owned exclusively by lib/ci.mjs.
// Runs `aws` with zero shell, pinned child env (endpoint overrides stripped), manual bounded pagination,
// strictly decreasing buildNumber checks, STS caller account binding, and redacted error causes.
// design/codecommit-forge-ci.md#aws-codebuild-exact-commit-reading
import { execFileSync } from "node:child_process";
import {
  AWS_ACCOUNT_RE, AWS_REGION_RE, awsPartition, CODEBUILD_APP, DestinationError, parseDestination, shownUrl,
} from "./ci-destination.mjs";

const CODEBUILD_BATCH_SIZE = 100;
const CODEBUILD_MAX_BUILDS = 500;
const CODEBUILD_TIMEOUT_MS = 30_000;
const REGION_LOOKUP_TIMEOUT_MS = 10_000;

const AWS_ERROR_CODE_RE =
  /\b([A-Z][A-Za-z0-9]+Exception|AccessDenied|InvalidClientTokenId|SignatureDoesNotMatch|UnrecognizedClient|Throttling|ProfileNotFound)\b/;
const CODEBUILD_ARN_RE =
  /^arn:(aws|aws-cn|aws-us-gov):codebuild:([^:]+):(\d{12}):build\/([A-Za-z0-9][A-Za-z0-9_-]{1,254}):([0-9a-f-]{36})$/;
const CODEBUILD_STATUS = Object.freeze({
  SUCCEEDED: Object.freeze({ status: "completed", conclusion: "success" }),
  FAILED: Object.freeze({ status: "completed", conclusion: "failure" }),
  FAULT: Object.freeze({ status: "completed", conclusion: "failure" }),
  TIMED_OUT: Object.freeze({ status: "completed", conclusion: "timed_out" }),
  STOPPED: Object.freeze({ status: "completed", conclusion: "cancelled" }),
  IN_PROGRESS: Object.freeze({ status: "in_progress", conclusion: null }),
});

const isPlainObject = v => v !== null && typeof v === "object" && !Array.isArray(v);
const escapeRegExp = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function awsChildEnv(region, baseEnv = process.env) {
  const env = { ...baseEnv };
  for (const key of Object.keys(env)) {
    if (/^AWS_ENDPOINT_URL/i.test(key)) delete env[key];
  }
  env.AWS_IGNORE_CONFIGURED_ENDPOINT_URLS = "true";
  env.AWS_CLI_AUTO_PROMPT = "off";
  env.AWS_PAGER = "";
  if (region) {
    env.AWS_REGION = region;
    env.AWS_DEFAULT_REGION = region;
  } else {
    delete env.AWS_REGION;
    delete env.AWS_DEFAULT_REGION;
  }
  return env;
}

export function classifyAwsError(operation, err) {
  if (err?.code === "ENOENT") return "aws CLI not found (ENOENT)";
  if (err?.code === "ETIMEDOUT") return "aws CLI timed out";
  const match = AWS_ERROR_CODE_RE.exec(String(err?.stderr ?? ""));
  if (match) return `aws ${operation} failed (${match[1]})`;
  return `aws ${operation} exited ${err?.status ?? "error"}`;
}

/**
 * Resolve AWS region for regionless `codecommit://` GRC remotes with botocore precedence
 * (`AWS_DEFAULT_REGION`, else `aws configure get region`), refusing disagreement with `AWS_REGION`.
 */
export function resolveAwsRegion(profile, url) {
  const shown = shownUrl(url);
  let grcRegion = process.env.AWS_DEFAULT_REGION?.trim() || "";
  if (!grcRegion) {
    const argv = ["configure", "get", "region", ...(profile ? [`--profile=${profile}`] : [])];
    try {
      grcRegion = execFileSync("aws", argv, {
        encoding: "utf8",
        env: awsChildEnv(null),
        stdio: ["ignore", "pipe", "pipe"],
        timeout: REGION_LOOKUP_TIMEOUT_MS,
      }).trim();
    } catch { grcRegion = ""; }
  }
  const envAwsRegion = process.env.AWS_REGION?.trim() || "";
  if (!grcRegion) {
    const hint = envAwsRegion
      ? "git-remote-codecommit ignores AWS_REGION alone; set AWS_DEFAULT_REGION, configure a profile region, or use an explicit region URL (codecommit::<region>://<repo>)"
      : "set AWS_DEFAULT_REGION, configure a profile region, or use an explicit region URL (codecommit::<region>://<repo>)";
    throw new DestinationError(`AWS region for ${shown} could not be resolved: ${hint}`);
  }
  const normalized = grcRegion.toLowerCase();
  if (!AWS_REGION_RE.test(normalized)) {
    throw new DestinationError(`invalid AWS region resolved for ${shown}`);
  }
  if (envAwsRegion && envAwsRegion.toLowerCase() !== normalized) {
    throw new DestinationError(
      `AWS region disagreement for ${shown}: AWS_REGION (${envAwsRegion.toLowerCase()}) differs from git-remote-codecommit region (${normalized})`,
    );
  }
  return normalized;
}

function normalizeTimestamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = Math.abs(value) < 1e12 ? value * 1000 : value;
    const d = new Date(ms);
    return Number.isFinite(d.getTime()) ? d.toISOString() : null;
  }
  if (typeof value === "string" && value.trim()) {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  }
  return null;
}

export function normalizeCodeBuildBuild(build) {
  const mapped = CODEBUILD_STATUS[build.buildStatus] ?? { status: "unknown", conclusion: null };
  return {
    id: build.buildNumber,
    ...(typeof build.id === "string" ? { build_id: build.id } : {}),
    app: CODEBUILD_APP,
    name: build.projectName,
    status: mapped.status,
    conclusion: mapped.conclusion,
    started_at: normalizeTimestamp(build.startTime),
  };
}

function runAwsJson(operation, argv, commonArgs, env) {
  let stdout;
  try {
    stdout = execFileSync("aws", [...argv, ...commonArgs], {
      encoding: "utf8",
      env,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: CODEBUILD_TIMEOUT_MS,
      maxBuffer: 1 << 26,
    });
  } catch (err) {
    return { error: classifyAwsError(operation, err) };
  }
  try {
    const data = JSON.parse(stdout);
    if (!isPlainObject(data)) return { error: `aws ${operation} returned non-object JSON` };
    return { data };
  } catch {
    return { error: `aws ${operation} returned invalid JSON` };
  }
}

const hasBatchArn = build =>
  typeof build.buildBatchArn === "string" ? build.buildBatchArn.trim().length > 0 : Boolean(build.buildBatchArn);

function buildMatchesDestination(build, destination) {
  if (build.source?.type !== "CODECOMMIT" || typeof build.source?.location !== "string") return false;
  const src = parseDestination(build.source.location);
  return Boolean(src && src.forge === "codecommit" && src.region === destination.region && src.repository === destination.repository);
}

function verifyBuildMetadata(build, id, project, destination, callerAccount, expectedPartition, prevBuildNumber) {
  if (!Number.isSafeInteger(build.buildNumber) || build.buildNumber <= 0) {
    return `CodeBuild build ${id} is missing a valid positive safe-integer buildNumber`;
  }
  if (!(build.buildNumber < prevBuildNumber)) {
    return `CodeBuild buildNumber ordering violation for ${project}: ${id} has buildNumber ${build.buildNumber} after ${prevBuildNumber}`;
  }
  if (build.projectName !== project) {
    return `CodeBuild build ${id} projectName mismatch for ${project}`;
  }
  const arnMatch = typeof build.arn === "string" ? CODEBUILD_ARN_RE.exec(build.arn) : null;
  if (!arnMatch) return `CodeBuild build ${id} has invalid ARN for ${project}`;
  const [, arnPartition, arnRegion, arnAccount, arnProject, arnUuid] = arnMatch;
  if (arnPartition !== expectedPartition || arnRegion !== destination.region || arnProject !== project || `${arnProject}:${arnUuid}` !== build.id) {
    return `CodeBuild build ARN mismatch for ${project}: ${id}`;
  }
  if (arnAccount !== callerAccount) {
    return `CodeBuild build ARN account ${arnAccount} does not match AWS caller account ${callerAccount}`;
  }
  return null;
}

function readProjectRuns(project, destination, fullSha, callerAccount, expectedPartition, commonArgs, env) {
  const buildIdRe = new RegExp(`^${escapeRegExp(project)}:[0-9a-f-]{36}$`);
  let scanned = 0, nextToken = null, prevBuildNumber = Infinity, matchedMaxBuildNumber = -1;
  const matchedRuns = [], unresolvedPending = [];
  while (scanned < CODEBUILD_MAX_BUILDS) {
    const listArgv = [
      "codebuild", "list-builds-for-project",
      `--project-name=${project}`,
      `--max-items=${CODEBUILD_BATCH_SIZE}`,
      ...(nextToken ? [`--starting-token=${nextToken}`] : []),
    ];
    const listed = runAwsJson("codebuild list-builds-for-project", listArgv, commonArgs, env);
    if (listed.error) return { error: listed.error };
    const { ids, NextToken } = listed.data;
    if (ids !== undefined && !Array.isArray(ids)) {
      return { error: `CodeBuild list-builds-for-project returned invalid ids for ${project}` };
    }
    if (NextToken !== undefined && NextToken !== null) {
      if (typeof NextToken !== "string" || NextToken.length === 0 || NextToken.startsWith("-") || /[\x00-\x1f\x7f\s]/.test(NextToken)) {
        return { error: `CodeBuild list-builds-for-project returned invalid NextToken for ${project}` };
      }
    }
    const pageIds = (ids ?? []).slice(0, CODEBUILD_MAX_BUILDS - scanned);
    for (const id of pageIds) {
      if (typeof id !== "string" || !buildIdRe.test(id)) {
        return { error: `CodeBuild list-builds-for-project returned invalid build ID for ${project}` };
      }
    }
    for (let i = 0; i < pageIds.length; i += CODEBUILD_BATCH_SIZE) {
      const chunk = pageIds.slice(i, i + CODEBUILD_BATCH_SIZE);
      const batch = runAwsJson(
        "codebuild batch-get-builds",
        ["codebuild", "batch-get-builds", `--cli-input-json=${JSON.stringify({ ids: chunk })}`],
        commonArgs,
        env,
      );
      if (batch.error) return { error: batch.error };
      if (!Array.isArray(batch.data.builds)) {
        return { error: `CodeBuild batch-get-builds returned invalid builds for ${project}` };
      }
      if (batch.data.buildsNotFound !== undefined) {
        if (!Array.isArray(batch.data.buildsNotFound) || batch.data.buildsNotFound.length > 0) {
          return { error: "CodeBuild batch-get-builds reported buildsNotFound" };
        }
      }
      const byId = new Map();
      for (const build of batch.data.builds) {
        if (!isPlainObject(build) || typeof build.id !== "string" || byId.has(build.id)) {
          return { error: `CodeBuild batch-get-builds returned duplicate or invalid build entry for ${project}` };
        }
        byId.set(build.id, build);
      }
      if (byId.size !== chunk.length || chunk.some(id => !byId.has(id))) {
        return { error: `CodeBuild batch-get-builds did not return exact requested builds for ${project}` };
      }
      for (const id of chunk) {
        const build = byId.get(id);
        const metaProblem = verifyBuildMetadata(build, id, project, destination, callerAccount, expectedPartition, prevBuildNumber);
        if (metaProblem) return { error: metaProblem };
        prevBuildNumber = build.buildNumber;
        if (!buildMatchesDestination(build, destination)) continue;
        const resolved = typeof build.resolvedSourceVersion === "string" ? build.resolvedSourceVersion.trim().toLowerCase() : "";
        const sourceVer = typeof build.sourceVersion === "string" ? build.sourceVersion.trim().toLowerCase() : "";
        const matchesSha = resolved ? resolved === fullSha : (build.buildStatus !== "SUCCEEDED" && sourceVer === fullSha);
        if (matchesSha) {
          if (hasBatchArn(build)) return { error: "CodeBuild batch builds are not read in batch 1" };
          matchedRuns.push(normalizeCodeBuildBuild(build));
          matchedMaxBuildNumber = Math.max(matchedMaxBuildNumber, build.buildNumber);
        } else if (resolved === "" && build.buildStatus === "IN_PROGRESS") {
          unresolvedPending.push(build);
        }
      }
    }
    scanned += pageIds.length;
    if (matchedRuns.length > 0 || pageIds.length === 0 || !NextToken || scanned >= CODEBUILD_MAX_BUILDS) break;
    nextToken = NextToken;
  }
  if (matchedRuns.length > 0) {
    for (const u of unresolvedPending) {
      if (u.buildNumber > matchedMaxBuildNumber) {
        if (hasBatchArn(u)) return { error: "CodeBuild batch builds are not read in batch 1" };
        matchedRuns.push(normalizeCodeBuildBuild(u));
      }
    }
  }
  return { runs: matchedRuns };
}

export function fetchCodeBuildRuns(destination, fullSha, parsedRequired) {
  const env = awsChildEnv(destination.region);
  const commonArgs = [
    `--region=${destination.region}`,
    ...(destination.profile ? [`--profile=${destination.profile}`] : []),
    "--output=json",
  ];
  const sts = runAwsJson("sts get-caller-identity", ["sts", "get-caller-identity"], commonArgs, env);
  if (sts.error) return { runs: null, account: null, error: sts.error };
  if (typeof sts.data.Account !== "string" || !AWS_ACCOUNT_RE.test(sts.data.Account)) {
    return { runs: null, account: null, error: "aws sts get-caller-identity returned invalid Account" };
  }
  const callerAccount = sts.data.Account;
  const expectedPartition = awsPartition(destination.region);
  const projects = [...new Set(parsedRequired.map(spec => spec.name))];
  const runs = [];
  for (const project of projects) {
    const res = readProjectRuns(project, destination, fullSha, callerAccount, expectedPartition, commonArgs, env);
    if (res.error) return { runs: null, account: callerAccount, error: res.error };
    runs.push(...res.runs);
  }
  return { runs, account: callerAccount };
}
