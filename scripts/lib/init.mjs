// F-0003, F-0009, D-0010, D-0052, R-0033-judge-hooks
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { check } from "../records-check.mjs";
import { UsageError } from "./args.mjs";
import { ensureExcludeEntry, ensureGitignoreEntry, gitIgnoreTarget, gitTopLevel, isGitIgnored, isPathTracked } from "./git-exclude.mjs";
import { git, gitOk } from "./git-plumbing.mjs";
import { canonical, commonGitDir } from "./path-canonical.mjs";
import { addProduct, DEFAULT_RECORDS_DIR, initStore, loadRegistry, LOOP, PRODUCT_NAME, real, REGISTRY, resolveOwnerStore } from "./registry.mjs";

export const RECORDS_EXCLUDE_MARKER = "# self-loop managed: in-repo records";
export const DEFAULT_WORKING_BRANCH = "loop/v1";

export class InitError extends Error {
  constructor(message, code = 2) { super(message); this.code = code; }
}

const inside = (child, parent) => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);

export function sanitizeProductName(raw) {
  const slug = String(raw ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug && PRODUCT_NAME.test(slug) ? slug : "product";
}

function currentBranch(repo) {
  const r = spawnSync("git", ["-C", repo, "symbolic-ref", "--quiet", "--short", "HEAD"], { encoding: "utf8" });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
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

function buildLoopConfig({ productField, branch, protectedBranches, workDir }) {
  return {
    product: productField,
    ...(branch ? { branch } : {}),
    protected: protectedBranches,
    records: ".",
    workDir,
    phase: "v1",
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
      actor: [],
    },
    agents: {
      critic: { runner: "codex" },
      actor: { runner: "claude" },
      judge: { runner: "codex" },
      reviewer: { runner: "claude" },
    },
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
  localExclude = false,
  register = false,
  ownerStore = null,
  env = process.env,
  cwd = process.cwd(),
  home = env?.HOME || homedir(),
} = {}) {
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
    const loopCfg = buildLoopConfig({ productField, branch: resolvedBranch, protectedBranches, workDir });
    const readme = `# ${productName} self-loop records\n\nManaged loop records for \`${productName}\` (\`RECORDS.md\` layout).\n`;
    const recordsIgnore = ".DS_Store\n*.tmp\n";

    writeFileSync(join(recordsDir, "README.md"), readme);
    writeFileSync(join(recordsDir, "records.json"), `${JSON.stringify(recordsCfg, null, 2)}\n`);
    writeFileSync(join(recordsDir, LOOP), `${JSON.stringify(loopCfg, null, 2)}\n`);
    writeFileSync(join(recordsDir, ".gitignore"), recordsIgnore);

    const initialFiles = ["README.md", "records.json", LOOP, ".gitignore"];
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
