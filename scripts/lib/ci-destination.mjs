// Pure CI destination identity, URL credential redaction, and check-spec validation.
// Single source of truth for GitHub and AWS CodeCommit destination parsing; zero subprocesses, zero I/O.
// design/codecommit-forge-ci.md

export class DestinationError extends Error {}

export const CODEBUILD_APP = "codebuild";
export const AWS_REGION_RE =
  /^(?:(?!cn-)[a-z]{2}-(?:north|south|east|west|central|northeast|northwest|southeast|southwest)|cn-(?:north|northwest)|us-gov-(?:east|west))-\d+$/;
export const AWS_ACCOUNT_RE = /^\d{12}$/;

const CODECOMMIT_REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;
const AWS_PROFILE_RE = /^[A-Za-z0-9][A-Za-z0-9._+=-]*$/;
const CODEBUILD_PROJECT_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{1,254}$/;
const CODECOMMIT_PUBLIC_HOST_RE = /^git-codecommit(?:-fips)?\.([^.]+)\.amazonaws\.com(\.cn)?$/;
const CODECOMMIT_VPCE_HOST_RE = /^vpce-[a-z0-9]+(?:-[a-z0-9]+)*\.git-codecommit(?:-fips)?\.([^.]+)\.vpce\.amazonaws\.com(\.cn)?$/;
const GRC_URL_RE = /^codecommit(?:::([^/:?#]+))?:\/\/(.+)$/;
const SCHEME_URL_RE = /^([A-Za-z][A-Za-z0-9+.-]*(?:::[^/:?#]+)?:\/\/)([^/?#]*)(.*)$/;
const EMBEDDED_URL_RE = /[A-Za-z][A-Za-z0-9+.-]*(?:::[^/:?#\s]+)?:\/\/[^\s'"<>]+/g;
const DEFAULT_PORTS = Object.freeze({ "https:": "443", "ssh:": "22" });

export function awsPartition(region) {
  if (region.startsWith("cn-")) return "aws-cn";
  if (region.startsWith("us-gov-")) return "aws-us-gov";
  return "aws";
}

export function codecommitHost(region) {
  return region.startsWith("cn-")
    ? `git-codecommit.${region}.amazonaws.com.cn`
    : `git-codecommit.${region}.amazonaws.com`;
}

function parseCodeCommitHost(hostname) {
  const host = String(hostname).toLowerCase().replace(/\.$/, "");
  const m = CODECOMMIT_PUBLIC_HOST_RE.exec(host) ?? CODECOMMIT_VPCE_HOST_RE.exec(host);
  if (!m) return null;
  const region = m[1];
  const cn = Boolean(m[2]);
  if (!AWS_REGION_RE.test(region) || cn !== region.startsWith("cn-")) return null;
  return { region, host: codecommitHost(region) };
}

export const isCodeCommitHost = hostname => parseCodeCommitHost(hostname) !== null;
export const isGrcUrl = url => /^codecommit(?::|\/\/)/i.test(String(url).trim());

/** Refuse non-empty CODE_COMMIT_ENDPOINT overrides for GRC remotes so push host matches canonical CodeCommit host. */
export function grcEndpointProblem(url, env = {}) {
  if (!isGrcUrl(url)) return null;
  if (typeof env?.CODE_COMMIT_ENDPOINT === "string" && env.CODE_COMMIT_ENDPOINT.length > 0) {
    return `CODE_COMMIT_ENDPOINT override is not supported for ${shownUrl(url)}: unset CODE_COMMIT_ENDPOINT so git-remote-codecommit connects only to the canonical AWS CodeCommit endpoint`;
  }
  return null;
}

// AWS CodeCommit forbids repository names ending in ".git", ".", or "..".
const validCodeCommitRepo = repo =>
  CODECOMMIT_REPO_RE.test(repo) && repo !== "." && repo !== ".." && !repo.endsWith(".git");

function parseGrc(text) {
  const m = GRC_URL_RE.exec(text);
  if (!m) return null;
  if (/[%?#]/.test(text)) return null;
  const rawRegion = m[1];
  let region = null, host = null;
  if (rawRegion !== undefined) {
    region = rawRegion.toLowerCase();
    if (!AWS_REGION_RE.test(region)) return null;
    host = codecommitHost(region);
  }
  const rawBody = m[2];
  const body = rawBody.endsWith("/") ? rawBody.slice(0, -1) : rawBody;
  if (body.includes("/")) return null;
  // Official git-remote-codecommit forwards authority repo verbatim without stripping ".git";
  // AWS CodeCommit forbids repo names ending in ".git", so trailing ".git" fails closed.
  const at = body.indexOf("@");
  let profile = null, repo = body;
  if (at >= 0) {
    profile = body.slice(0, at);
    repo = body.slice(at + 1);
    if (!AWS_PROFILE_RE.test(profile)) return null;
  }
  if (!validCodeCommitRepo(repo)) return null;
  return { forge: "codecommit", host, region, repository: repo, profile };
}

function parseCodeCommitPath(rawPath, allowLeadingSlash) {
  let path = rawPath;
  if (allowLeadingSlash && path.startsWith("/")) path = path.slice(1);
  if (path.endsWith("/")) path = path.slice(0, -1);
  const prefix = allowLeadingSlash ? "v1/repos/" : "/v1/repos/";
  if (!path.startsWith(prefix)) return null;
  let repo = path.slice(prefix.length);
  if (repo.includes("/")) return null;
  if (repo.endsWith(".git")) repo = repo.slice(0, -4);
  return validCodeCommitRepo(repo) ? repo : null;
}

/**
 * Parse a Git push URL into canonical destination identity.
 * Rejects backslashes, whitespace, and ASCII control characters before parsing to prevent WHATWG/RFC 3986
 * parser differentials across all forges.
 */
export function parseDestination(url) {
  const text = String(url).trim();
  if (!text || /[\\\s\x00-\x1f\x7f]/.test(text) || /^ext::/i.test(text)) return null;
  if (isGrcUrl(text)) return parseGrc(text);
  if (text.includes("://")) {
    let parsed;
    try { parsed = new URL(text); } catch { return null; }
    if (!["https:", "ssh:"].includes(parsed.protocol) || parsed.search || parsed.hash || /[?#]/.test(text)) return null;
    const afterScheme = text.slice(text.indexOf("://") + 3);
    const slash = afterScheme.indexOf("/");
    if (slash < 0) return null;
    const rawAuthority = afterScheme.slice(0, slash);
    const rawPath = afterScheme.slice(slash);
    const at = rawAuthority.lastIndexOf("@");
    const rawHostPort = at >= 0 ? rawAuthority.slice(at + 1) : rawAuthority;
    const colon = rawHostPort.lastIndexOf(":");
    const rawHost = colon >= 0 ? rawHostPort.slice(0, colon) : rawHostPort;
    const rawPort = colon >= 0 ? rawHostPort.slice(colon + 1) : "";
    const defaultPort = DEFAULT_PORTS[parsed.protocol];
    if (rawHost.toLowerCase() !== parsed.hostname.toLowerCase()) return null;
    if (rawPort !== parsed.port && rawPort !== defaultPort) return null;
    const port = parsed.port === defaultPort ? "" : parsed.port;
    const bareHost = parsed.hostname.toLowerCase().replace(/\.$/, "");
    const cc = parseCodeCommitHost(bareHost);
    if (cc) {
      if (port || afterScheme.includes("%") || rawPath !== parsed.pathname) return null;
      const repository = parseCodeCommitPath(parsed.pathname, false);
      return repository ? { forge: "codecommit", host: cc.host, region: cc.region, repository, profile: null } : null;
    }
    let pathname;
    try { pathname = decodeURIComponent(parsed.pathname).replace(/^\//, ""); } catch { return null; }
    const path = /^([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(pathname);
    if (!path) return null;
    const host = bareHost + (port ? `:${port}` : "");
    return { forge: host === "github.com" ? "github" : null, host, region: null, repository: `${path[1]}/${path[2]}`.toLowerCase(), profile: null };
  }
  const scp = /^(?:[^@/:]+@)?([^/:@]+):(.+)$/.exec(text);
  if (!scp) return null;
  const host = scp[1].toLowerCase().replace(/\.$/, "");
  const rawPath = scp[2];
  const cc = parseCodeCommitHost(host);
  if (cc) {
    if (/[%?#]/.test(text)) return null;
    const repository = parseCodeCommitPath(rawPath, true);
    return repository ? { forge: "codecommit", host: cc.host, region: cc.region, repository, profile: null } : null;
  }
  if (rawPath.startsWith("/")) return null;
  const path = /^([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(rawPath);
  if (!path) return null;
  return { forge: host === "github.com" ? "github" : null, host, region: null, repository: `${path[1]}/${path[2]}`.toLowerCase(), profile: null };
}

/** Redact userinfo/profile from any `<scheme>://` URL and non-`git`/CodeCommit SCP URLs for display in errors and logs. */
export function shownUrl(url) {
  const text = String(url);
  const schemeMatch = SCHEME_URL_RE.exec(text);
  if (schemeMatch) {
    const [, scheme, authority, rest] = schemeMatch;
    const at = authority.lastIndexOf("@");
    if (at < 0) return text;
    const userPart = authority.slice(0, at);
    const hostPort = authority.slice(at + 1);
    const hostname = hostPort.replace(/:\d+$/, "").replace(/\.$/, "");
    if (/^ssh:\/\//i.test(scheme) && userPart === "git" && !isCodeCommitHost(hostname)) return text;
    return `${scheme}***@${hostPort}${rest}`;
  }
  if (!text.includes("://")) {
    const m = /^([^/:]+)@([^/:]+):(.+)$/.exec(text);
    if (m) {
      const [, userPart, host, path] = m;
      if (userPart === "git" && !isCodeCommitHost(host)) return text;
      return `***@${host}:${path}`;
    }
  }
  return text;
}

const escapeRegExp = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function destinationSecrets(url) {
  const text = String(url).trim();
  const secrets = new Set();
  const schemeMatch = SCHEME_URL_RE.exec(text);
  if (schemeMatch) {
    const [, scheme, authority] = schemeMatch;
    const at = authority.lastIndexOf("@");
    if (at >= 0) {
      const userPart = authority.slice(0, at);
      const hostPort = authority.slice(at + 1);
      const hostname = hostPort.replace(/:\d+$/, "").replace(/\.$/, "");
      if (!(/^ssh:\/\//i.test(scheme) && userPart === "git" && !isCodeCommitHost(hostname)) && userPart) {
        secrets.add(userPart);
        const colon = userPart.indexOf(":");
        if (colon >= 0 && userPart.slice(colon + 1)) secrets.add(userPart.slice(colon + 1));
      }
    }
  } else if (!text.includes("://")) {
    const m = /^([^/:]+)@([^/:]+):(.+)$/.exec(text);
    if (m && !(m[1] === "git" && !isCodeCommitHost(m[2]))) secrets.add(m[1]);
  }
  return [...secrets].sort((a, b) => b.length - a.length);
}

/** Redact embedded URLs, raw destination URL, and extracted credentials/GRC profiles from subprocess output. */
export function redactDestinationOutput(text, destinationUrl) {
  if (!text) return "";
  let out = String(text).replace(EMBEDDED_URL_RE, m => shownUrl(m));
  if (destinationUrl) {
    const raw = String(destinationUrl).trim();
    const shown = shownUrl(raw);
    if (raw && shown !== raw) out = out.replaceAll(raw, shown);
    for (const secret of destinationSecrets(raw)) {
      if (secret.length >= 2) out = out.replaceAll(secret, "***");
      else out = out.replace(new RegExp(`(?<![A-Za-z0-9._+=-])${escapeRegExp(secret)}(?![A-Za-z0-9._+=-])`, "g"), "***");
    }
  }
  return out;
}

export function validateCodeBuildSpec(spec) {
  if (!CODEBUILD_PROJECT_RE.test(spec.name)) {
    return `invalid CodeBuild project name "${spec.name}" in "${spec.app}/${spec.name}" (must be 2-255 chars matching [A-Za-z0-9][A-Za-z0-9_-]{1,254})`;
  }
  return null;
}

export function checkAppProblem(destination, parsed, forges) {
  const forge = forges[destination.forge];
  if (!forge) return `unsupported CI forge "${destination.forge}"`;
  if (Array.isArray(forge.apps)) {
    for (const spec of parsed) {
      if (!forge.apps.includes(spec.app)) {
        return `check "${spec.app}/${spec.name}" is not supported for ${forge.label} (allowed check apps: ${forge.apps.join(", ")})`;
      }
    }
  } else {
    const reserved = new Set(
      Object.values(forges)
        .filter(f => f.id !== forge.id && Array.isArray(f.apps))
        .flatMap(f => f.apps),
    );
    for (const spec of parsed) {
      if (reserved.has(spec.app)) {
        return `check "${spec.app}/${spec.name}" is not supported for ${forge.label}`;
      }
    }
  }
  if (typeof forge.validateSpec === "function") {
    for (const spec of parsed) {
      const problem = forge.validateSpec(spec);
      if (problem) return problem;
    }
  }
  return null;
}
