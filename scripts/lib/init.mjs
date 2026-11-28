// F-0003, F-0009, F-0015, F-0017, P-0019, D-0010, D-0052, D-0065, D-0066, D-0067, D-0068, D-0069, R-0033-judge-hooks, R-0055-judge-frame-alphax
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { check } from "../records-check.mjs";
import { UsageError } from "./args.mjs";
import { ensureExcludeEntry, ensureGitignoreEntry, gitIgnoreTarget, gitTopLevel, isGitIgnored, isPathTracked } from "./git-exclude.mjs";
import { git, gitOk } from "./git-plumbing.mjs";
import { ADAPTERS, isAdapter, isAntigravityProvider, isPreparedRunner, PREPARED_RUNNERS } from "./paseo.mjs";
import { canonical, commonGitDir } from "./path-canonical.mjs";
import { addProduct, DEFAULT_RECORDS_DIR, initStore, loadRegistry, LOOP, PRODUCT_NAME, real, REGISTRY, resolveOwnerStore } from "./registry.mjs";
import { validateJudgeIndependence } from "./vendor.mjs";

export const RECORDS_EXCLUDE_MARKER = "# self-loop managed: in-repo records";
export const DEFAULT_WORKING_BRANCH = "loop/v1";

const SKILL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const RECORDS_PRE_COMMIT_HOOK = `#!/bin/sh
set -eu
REPO_ROOT="$(git rev-parse --show-toplevel)"
CFG_HOME="$(git config --get self-loop.home 2>/dev/null || true)"
for c in "\${SELF_LOOP_HOME:-}/scripts/records-check.mjs" "\${CFG_HOME:-}/scripts/records-check.mjs" "$REPO_ROOT/../scripts/records-check.mjs" "$REPO_ROOT/../../scripts/records-check.mjs" "\${HOME:-}/.agents/skills/self-loop/scripts/records-check.mjs"; do
  [ -f "$c" ] && exec node "$c" --repo "$REPO_ROOT" --staged
done
echo "self-loop pre-commit: cannot locate scripts/records-check.mjs (set SELF_LOOP_HOME)" >&2
exit 2
`;

export function installRecordsPreCommitHook(recordsDir) {
  const dir = resolve(recordsDir), hookDir = join(dir, ".githooks"), hookPath = join(hookDir, "pre-commit");
  let changed = false;
  mkdirSync(hookDir, { recursive: true });
  const existing = existsSync(hookPath) ? readFileSync(hookPath, "utf8") : null;
  if (existing !== RECORDS_PRE_COMMIT_HOOK) { writeFileSync(hookPath, RECORDS_PRE_COMMIT_HOOK, { mode: 0o755 }); chmodSync(hookPath, 0o755); changed = true; }
  else if ((statSync(hookPath).mode & 0o111) !== 0o111) { chmodSync(hookPath, 0o755); changed = true; }
  let cur = "";
  try { cur = git(dir, "config", "--local", "--get", "core.hooksPath"); } catch {}
  if (cur !== ".githooks") { git(dir, "config", "core.hooksPath", ".githooks"); changed = true; }
  let curHome = "";
  try { curHome = git(dir, "config", "--local", "--get", "self-loop.home"); } catch {}
  if (curHome !== SKILL_ROOT) { git(dir, "config", "self-loop.home", SKILL_ROOT); changed = true; }
  return { hookPath, changed };
}

const ANTIGRAVITY_MODEL_ROLES = Object.freeze({
  critic: Object.freeze({ model: "gemini-2.5-pro", effort: "xhigh" }),
  actor: Object.freeze({ model: "gemini-2.5-flash", effort: "high" }),
  judge: Object.freeze({ model: "gemini-2.5-pro-exp", effort: "high" }),
  reviewer: Object.freeze({ model: "gemini-2.5-pro-exp", effort: "high" }),
});

export class InitError extends Error {
  constructor(message, code = 2) { super(message); this.code = code; }
}

const inside = (child, parent) => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);

export function sanitizeProductName(raw) {
  const slug = String(raw ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug && PRODUCT_NAME.test(slug) ? slug : "product";
}

function currentBranch(repo) {
  try {
    return git(repo, "symbolic-ref", "--quiet", "--short", "HEAD") || null;
  } catch {
    return null;
  }
}

function highestMissingDir(dir) {
  if (existsSync(dir)) return null;
  let cursor = dir;
  while (dirname(cursor) !== cursor && !existsSync(dirname(cursor))) cursor = dirname(cursor);
  return cursor;
}

function assertNotBlockedByFile(productRoot, relPosix) {
  let cursor = productRoot;
  for (const part of relPosix.split("/")) {
    cursor = join(cursor, part);
    const stat = lstatSync(cursor, { throwIfNoEntry: false });
    if (stat && !stat.isDirectory()) {
      throw new InitError(`${cursor} exists and is not a directory; refusing to overwrite`, 2);
    }
  }
}

function defaultWorkDir(home, name, recordsDir) {
  const primary = resolve(home, ".self-loop", "work", name);
  const canonPrimary = canonical(primary), canonRecords = canonical(recordsDir);
  if (inside(canonPrimary, canonRecords) || inside(canonRecords, canonPrimary)) {
    return resolve(home, ".self-loop-work", name);
  }
  return primary;
}

function buildRecordsConfig() {
  return {
    sealed: [],
    sealedReaders: ["judge", "lead"],
    extraKinds: [],
    publicImports: [],
  };
}

const CLI_RUNNERS = Object.freeze(["claude", "codex"]);
const ALL_RUNNERS = Object.freeze([...CLI_RUNNERS, ...PREPARED_RUNNERS]);

function requireNonEmptyString(flag, value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new UsageError(`${flag} must be a non-empty string, got ${JSON.stringify(value)}`);
  }
  return value.trim();
}

function resolveAgentPreset({
  harness = null,
  runner = null,
  provider = null,
  adapter = null,
  model = null,
  actorModel = null,
  criticModel = null,
  judgeModel = null,
  reviewerModel = null,
  independence = null,
} = {}) {
  const hasHarness = harness !== null && harness !== undefined;
  const hasRunner = runner !== null && runner !== undefined;
  const hasProvider = provider !== null && provider !== undefined;
  const hasAdapter = adapter !== null && adapter !== undefined;
  const hasIndependence = independence !== null && independence !== undefined;

  if (hasHarness && !isPreparedRunner(harness)) {
    throw new UsageError(`--harness must be one of ${PREPARED_RUNNERS.join(", ")}, got ${JSON.stringify(harness)}`);
  }
  if (hasRunner && !ALL_RUNNERS.includes(runner)) {
    throw new UsageError(`--runner must be one of ${ALL_RUNNERS.join(", ")}, got ${JSON.stringify(runner)}`);
  }
  if (hasHarness && hasRunner && harness !== runner) {
    throw new UsageError(`--harness ${JSON.stringify(harness)} conflicts with --runner ${JSON.stringify(runner)}`);
  }
  if (hasAdapter && !isAdapter(adapter)) {
    throw new UsageError(`--adapter must be one of ${ADAPTERS.join(", ")}, got ${JSON.stringify(adapter)}`);
  }
  if (hasIndependence) {
    const v = validateJudgeIndependence(independence);
    if (!v.ok) throw new UsageError(v.error);
  }
  const cleanProvider = hasProvider ? requireNonEmptyString("--provider", provider) : null;
  const baseModel = model !== null && model !== undefined ? requireNonEmptyString("--model", model) : null;
  const roleModels = {
    actor: actorModel !== null && actorModel !== undefined ? requireNonEmptyString("--actor-model", actorModel) : baseModel,
    critic: criticModel !== null && criticModel !== undefined ? requireNonEmptyString("--critic-model", criticModel) : baseModel,
    judge: judgeModel !== null && judgeModel !== undefined ? requireNonEmptyString("--judge-model", judgeModel) : baseModel,
    reviewer: reviewerModel !== null && reviewerModel !== undefined ? requireNonEmptyString("--reviewer-model", reviewerModel) : baseModel,
  };

  const explicitRunner = hasRunner ? runner : (hasHarness ? harness : null);
  if (explicitRunner && !isPreparedRunner(explicitRunner) && hasProvider) {
    throw new UsageError(`--provider requires a prepared runner (${PREPARED_RUNNERS.join(" or ")}), got ${JSON.stringify(explicitRunner)}`);
  }
  if (explicitRunner === "t3" && cleanProvider === "better-paseo-antigravity") {
    throw new UsageError('provider "better-paseo-antigravity" requires harness "paseo"');
  }

  let defaultIndependence = null;
  let agents;
  if (!explicitRunner && !hasProvider) {
    agents = {
      critic: { runner: "codex" },
      actor: { runner: "claude" },
      judge: { runner: "codex" },
      reviewer: { runner: "claude" },
    };
  } else if (explicitRunner && !isPreparedRunner(explicitRunner)) {
    agents = {
      critic: { runner: explicitRunner },
      actor: { runner: explicitRunner },
      judge: { runner: explicitRunner },
      reviewer: { runner: explicitRunner === "codex" ? "claude" : explicitRunner },
    };
  } else if (explicitRunner === "t3" && !hasProvider) {
    agents = {
      critic: { runner: "t3", provider: "codex" },
      actor: { runner: "t3", provider: "claude" },
      judge: { runner: "t3", provider: "codex" },
      reviewer: { runner: "t3", provider: "claude" },
    };
  } else if ((explicitRunner === "paseo" && !hasProvider) || (hasProvider && isAntigravityProvider(cleanProvider))) {
    const resolvedRunner = explicitRunner ?? (cleanProvider === "better-paseo-antigravity" ? "paseo" : "t3");
    const resolvedProvider = cleanProvider ?? "better-paseo-antigravity";
    defaultIndependence = "model";
    agents = Object.fromEntries(
      Object.entries(ANTIGRAVITY_MODEL_ROLES).map(([role, spec]) => [
        role,
        { runner: resolvedRunner, provider: resolvedProvider, model: spec.model, effort: spec.effort },
      ]),
    );
  } else {
    const resolvedRunner = explicitRunner ?? "t3";
    agents = Object.fromEntries(
      ["critic", "actor", "judge", "reviewer"].map(role => [
        role,
        { runner: resolvedRunner, provider: cleanProvider },
      ]),
    );
  }

  for (const [role, spec] of Object.entries(agents)) {
    if (hasAdapter && isPreparedRunner(spec.runner)) spec.adapter = adapter;
    if (roleModels[role]) spec.model = roleModels[role];
  }
  return {
    judgeIndependence: hasIndependence ? independence : defaultIndependence,
    agents,
  };
}

function buildLoopConfig({ productField, branch, protectedBranches, workDir, preset }) {
  return {
    product: productField,
    ...(branch ? { branch } : {}),
    protected: protectedBranches,
    records: ".",
    workDir,
    phase: "v1",
    ...(preset.judgeIndependence ? { judgeIndependence: preset.judgeIndependence } : {}),
    purpose: [],
    briefs: {
      shared: "engines/shared.md",
      critic: "engines/critic.md",
      actor: "engines/actor.md",
      judge: "engines/judge.md",
      reviewer: "engines/frame-reviewer.md",
    },
    owns: {
      critic: [],
      actor: ["GLOSSARY.md", "EXPERIENCE.md"],
    },
    agents: preset.agents,
    setup: [],
    sealed: [],
    gates: {
      suite: "",
      require: [],
      remote: "origin",
    },
  };
}

export function initLoop({
  product = null,
  records = null,
  name = null,
  branch = null,
  harness = null,
  runner = null,
  provider = null,
  adapter = null,
  model = null,
  actorModel = null,
  criticModel = null,
  judgeModel = null,
  reviewerModel = null,
  independence = null,
  localExclude = false,
  register = false,
  ownerStore = null,
  env = process.env,
  cwd = process.cwd(),
  home = env?.HOME || homedir(),
} = {}) {
  const preset = resolveAgentPreset({
    harness,
    runner,
    provider,
    adapter,
    model,
    actorModel,
    criticModel,
    judgeModel,
    reviewerModel,
    independence,
  });
  const targetDir = product ? resolve(cwd, product) : resolve(cwd);
  if (!existsSync(targetDir)) throw new UsageError(`product directory does not exist: ${targetDir}`);
  const productRoot = gitTopLevel(targetDir);
  if (!productRoot) throw new UsageError(`${targetDir} is not inside a Git repository`);

  const recordsDir = records ? canonical(resolve(cwd, records)) : join(productRoot, DEFAULT_RECORDS_DIR);
  const productName = name ?? sanitizeProductName(basename(productRoot));
  if (!PRODUCT_NAME.test(productName)) {
    throw new UsageError(`--name must be lower-case letters, digits and inner hyphens, got ${JSON.stringify(productName)}`);
  }
  if (branch !== null && (!branch.trim() || /\s/.test(branch))) {
    throw new UsageError(`--branch must be a single branch name without whitespace, got ${JSON.stringify(branch)}`);
  }
  const detectedBranch = currentBranch(productRoot);
  const protectedBranches = detectedBranch === "master" ? ["master"] : ["main"];
  const defaultedWorkingBranch = branch === null && Boolean(detectedBranch && protectedBranches.includes(detectedBranch));
  const resolvedBranch = branch ?? (defaultedWorkingBranch ? DEFAULT_WORKING_BRANCH : detectedBranch);

  const rel = relative(productRoot, recordsDir);
  if (rel === "") throw new UsageError("--records must not be the product repository root itself");
  const isInRepo = !rel.startsWith("..") && !isAbsolute(rel);
  const relPosix = isInRepo ? rel.split(sep).join("/") : null;
  if (isInRepo && (relPosix === ".git" || relPosix.startsWith(".git/"))) {
    throw new UsageError("--records must not live inside the product repository's .git directory");
  }

  if (isInRepo) {
    const tracked = isPathTracked(productRoot, relPosix);
    if (tracked.error) throw new InitError(tracked.error, 2);
    if (tracked.tracked) {
      const sample = tracked.files.slice(0, 3).join(", ");
      const more = tracked.files.length > 3 ? ` (+${tracked.files.length - 3} more)` : "";
      throw new InitError(`${recordsDir} is tracked by Git in ${productRoot} (${sample}${more}); refusing to initialize or ignore a tracked path`, 2);
    }
    assertNotBlockedByFile(productRoot, relPosix);
  }

  if (existsSync(recordsDir)) {
    const stat = lstatSync(recordsDir);
    if (!stat.isDirectory()) throw new InitError(`${recordsDir} exists and is not a directory`, 2);
    if (existsSync(join(recordsDir, LOOP))) {
      throw new InitError(`${recordsDir} is already initialized (${LOOP} exists); refusing to overwrite`, 2);
    }
    if (readdirSync(recordsDir).length > 0) {
      throw new InitError(`${recordsDir} exists and is not empty; refusing to overwrite`, 2);
    }
  }

  const store = register ? resolveOwnerStore({ flag: ownerStore, env, home }) : null;
  if (register && existsSync(join(store.path, REGISTRY))) {
    const existingReg = loadRegistry(store);
    const conflictName = existingReg.products.find(p => p.name.toLowerCase() === productName.toLowerCase()
      || p.aliases.some(a => a.toLowerCase() === productName.toLowerCase()));
    if (conflictName) throw new InitError(`${productName} is already registered in ${store.path} (as ${conflictName.name})`, 2);
    const conflictPath = existingReg.products.find(p => real(p.records) === recordsDir);
    if (conflictPath) throw new InitError(`${recordsDir} is already registered in ${store.path} as ${conflictPath.name}`, 2);
  }

  let ignoreSnapshot = null;
  let recordsPreExisted = false;
  let recordsCreatedRoot = null;
  let storeCreatedRoot = null;
  let branchCreated = null;

  const rollback = () => {
    if (branchCreated) {
      try { git(productRoot, "branch", "-D", branchCreated); } catch {}
    }
    if (storeCreatedRoot) {
      try { rmSync(storeCreatedRoot, { recursive: true, force: true }); } catch {}
    }
    if (recordsCreatedRoot) {
      try { rmSync(recordsCreatedRoot, { recursive: true, force: true }); } catch {}
    } else if (recordsPreExisted && existsSync(recordsDir)) {
      try {
        for (const entry of readdirSync(recordsDir)) {
          rmSync(join(recordsDir, entry), { recursive: true, force: true });
        }
      } catch {}
    }
    if (ignoreSnapshot) {
      try {
        if (ignoreSnapshot.existed) writeFileSync(ignoreSnapshot.file, ignoreSnapshot.bytes);
        else rmSync(ignoreSnapshot.file, { force: true });
      } catch {}
    }
  };

  let ignoreResult = null;
  let commit = null;
  let registered = false;
  try {
    if (isInRepo) {
      if (localExclude) {
        const repoInfo = commonGitDir(productRoot);
        if (!repoInfo) throw new InitError(`could not locate Git directory for ${productRoot}`, 2);
        const targetInfo = gitIgnoreTarget(recordsDir, { repo: repoInfo, directory: true });
        ignoreSnapshot = {
          file: targetInfo.excludeFile,
          existed: existsSync(targetInfo.excludeFile),
          bytes: existsSync(targetInfo.excludeFile) ? readFileSync(targetInfo.excludeFile) : null,
        };
        const applied = ensureExcludeEntry(targetInfo, { marker: RECORDS_EXCLUDE_MARKER });
        ignoreResult = { mode: "local-exclude", file: applied.excludeFile, pattern: applied.pattern, changed: applied.changed };
      } else {
        const gitignoreFile = join(productRoot, ".gitignore");
        ignoreSnapshot = {
          file: gitignoreFile,
          existed: existsSync(gitignoreFile),
          bytes: existsSync(gitignoreFile) ? readFileSync(gitignoreFile) : null,
        };
        const applied = ensureGitignoreEntry(productRoot, relPosix, { directory: true });
        ignoreResult = { mode: "gitignore", file: applied.file, pattern: applied.pattern, changed: applied.changed };
      }
      if (!isGitIgnored(productRoot, relPosix, { directory: true })
        || !isGitIgnored(productRoot, `${relPosix}/${LOOP}`)) {
        throw new InitError(
          `${recordsDir} is not git-ignored by ${productRoot} after updating ${ignoreResult.file} `
          + `(check for a negating rule such as !${relPosix}/ in .gitignore); refusing to create an unignored records repository`,
          2,
        );
      }
    }

    recordsPreExisted = existsSync(recordsDir);
    recordsCreatedRoot = highestMissingDir(recordsDir);
    mkdirSync(recordsDir, { recursive: true });
    git(recordsDir, "init", "-q");

    const productField = isInRepo ? relative(recordsDir, productRoot).split(sep).join("/") : productRoot;
    const workDir = defaultWorkDir(home, productName, recordsDir);
    const recordsCfg = buildRecordsConfig();
    const loopCfg = buildLoopConfig({ productField, branch: resolvedBranch, protectedBranches, workDir, preset });
    const readme = `# ${productName} self-loop records\n\nManaged loop records for \`${productName}\` (\`RECORDS.md\` layout).\n`;
    const recordsIgnore = ".DS_Store\n*.tmp\n";

    writeFileSync(join(recordsDir, "README.md"), readme);
    writeFileSync(join(recordsDir, "records.json"), `${JSON.stringify(recordsCfg, null, 2)}\n`);
    writeFileSync(join(recordsDir, LOOP), `${JSON.stringify(loopCfg, null, 2)}\n`);
    writeFileSync(join(recordsDir, ".gitignore"), recordsIgnore);
    installRecordsPreCommitHook(recordsDir);

    const initialFiles = ["README.md", "records.json", LOOP, ".gitignore", ".githooks/pre-commit"];
    git(recordsDir, "add", "--", ...initialFiles);
    const checked = check(recordsDir, { config: recordsCfg, write: true });
    if (checked.failures.length) {
      throw new InitError(`records check failed after initialization: ${checked.failures.map(f => `${f.rule} ${f.path}: ${f.detail}`).join("; ")}`, 2);
    }
    git(recordsDir, "add", "--", "INDEX.md");
    git(recordsDir, "commit", "-q", "--no-verify", "-m", `Initialize self-loop records for ${productName}`, "--", ...initialFiles, "INDEX.md");
    commit = git(recordsDir, "rev-parse", "HEAD");

    if (defaultedWorkingBranch
      && gitOk(productRoot, "rev-parse", "--verify", "--quiet", "HEAD^{commit}")
      && !gitOk(productRoot, "show-ref", "--verify", "--quiet", `refs/heads/${resolvedBranch}`)) {
      git(productRoot, "branch", resolvedBranch);
      branchCreated = resolvedBranch;
    }

    if (register) {
      if (!existsSync(join(store.path, ".git"))) {
        storeCreatedRoot = highestMissingDir(store.path);
        initStore(store.path);
      }
      addProduct(store.path, { name: productName, records: recordsDir });
      registered = true;
    }
  } catch (error) {
    rollback();
    if (error instanceof InitError || error instanceof UsageError) throw error;
    const detail = String(error?.message ?? error).trim();
    if (/author identity unknown|please tell me who you are|unable to auto-detect email|empty ident name/i.test(detail)) {
      throw new InitError(
        "cannot commit initial records: Git user.name and user.email are not configured "
        + "(set them with `git config --global user.name ...` and `git config --global user.email ...`, then re-run `self-loop.mjs init`)",
        2,
      );
    }
    throw new InitError(`failed to initialize records at ${recordsDir}: ${detail}`, 2);
  }

  return {
    name: productName,
    product: productRoot,
    records: recordsDir,
    config: join(recordsDir, LOOP),
    inRepo: isInRepo,
    ignore: ignoreResult,
    branch: resolvedBranch,
    commit,
    registered,
    ...(registered ? { ownerStore: store.path } : {}),
  };
}
