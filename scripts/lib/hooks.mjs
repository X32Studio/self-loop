// F-0009, F-0010, D-0052, D-0060, D-0066, D-0067, R-0032-reviewer-architecture, design/antigravity-harness.md#hooks-cli
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { parseArgs, UsageError } from "./args.mjs";
import { command } from "./commands.mjs";
import { ensureExcludeEntry, gitIgnoreTarget, removeExcludeEntry } from "./git-exclude.mjs";
import { gitOk, run } from "./git-plumbing.mjs";
import { geminiHome, t3AntigravityInstances, VERIFIED_ANTIGRAVITY_LS_VERSION } from "./antigravity.mjs";
import { canonical, commonGitDir } from "./path-canonical.mjs";
import { loadHookStore } from "./registry.mjs";

export const HOOK_KEY = "self-loop";
export const EXCLUDE_MARKER = "# self-loop managed: antigravity hooks";
export const ANTIGRAVITY_TEMPLATE = fileURLToPath(new URL("../../assets/antigravity/hooks.json", import.meta.url));
const WORKSPACE_SKILL_DIRS = [".agents", ".agent", "_agents", "_agent"];

function antigravityHome(env = process.env) {
  return typeof env?.ANTIGRAVITY_HOME === "string" && env.ANTIGRAVITY_HOME.trim()
    ? resolve(env.ANTIGRAVITY_HOME)
    : null;
}

function antigravityHomeHooksFile(env = process.env) {
  const agHome = antigravityHome(env);
  return agHome ? join(agHome, "config", "hooks.json") : null;
}

export class HooksError extends Error {
  constructor(message, code = 2) { super(message); this.code = code; }
}

const isPlainObject = v => v !== null && typeof v === "object" && !Array.isArray(v);

export function parseShellWords(cmd) {
  if (typeof cmd !== "string") return [];
  const words = [];
  let cur = "", inSingle = false, inDouble = false, escaped = false, hasToken = false;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (escaped) { cur += ch; escaped = false; hasToken = true; continue; }
    if (inSingle) {
      if (ch === "'") inSingle = false;
      else cur += ch;
      continue;
    }
    if (inDouble) {
      if (ch === '"') inDouble = false;
      else if (ch === "\\") escaped = true;
      else cur += ch;
      continue;
    }
    if (ch === "\\") { escaped = true; hasToken = true; continue; }
    if (ch === "'") { inSingle = true; hasToken = true; continue; }
    if (ch === '"') { inDouble = true; hasToken = true; continue; }
    if (/\s/.test(ch)) {
      if (hasToken) { words.push(cur); cur = ""; hasToken = false; }
      continue;
    }
    cur += ch;
    hasToken = true;
  }
  if (hasToken) words.push(cur);
  return words;
}

function scriptPathFromCommand(cmd) {
  const words = parseShellWords(cmd);
  if (words.length < 2) return null;
  const bin = basename(words[0]);
  if (bin === "node" || bin.startsWith("node")) return words[1];
  return words[0];
}

function handlerArgsFromCommand(cmd) {
  const words = parseShellWords(cmd);
  const bin = basename(words[0] ?? "");
  const start = bin === "node" || bin.startsWith("node") ? 2 : 1;
  return parseArgs(words.slice(start));
}

function dedupeProjects(cfg, settings) {
  const raw = [cfg.product, cfg.records, ...(settings?.projects ?? [])].filter(Boolean);
  const seen = new Set();
  const out = [];
  for (const p of raw) {
    const abs = resolve(p);
    const key = canonical(abs);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(abs);
  }
  return out;
}

function renderTemplateValue(node, vars) {
  if (Array.isArray(node)) return node.map(item => renderTemplateValue(item, vars));
  if (!isPlainObject(node)) return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === "command" && node.type === "command" && typeof v === "string") {
      const words = parseShellWords(v).flatMap(w => (Array.isArray(vars[w])
        ? vars[w]
        : [w.replace(/<[A-Z_]+>/g, token => (typeof vars[token] === "string" ? vars[token] : token))]));
      out[k] = command(...words);
    } else {
      out[k] = renderTemplateValue(v, vars);
    }
  }
  return out;
}

export function renderAntigravityHooks({ cfg = null, settings = null, ownerStore = null, scriptsDir, templatePath = ANTIGRAVITY_TEMPLATE }) {
  const { data } = readJsonObject(templatePath);
  if (!isPlainObject(data[HOOK_KEY])) throw new HooksError(`${templatePath}: missing "${HOOK_KEY}" template object`);
  let startScopeArgs, wordsScopeArgs, guardScopeArgs;
  if (ownerStore !== null && ownerStore !== undefined && !cfg) {
    const loaded = loadHookStore(ownerStore);
    if (!loaded.ok) throw new HooksError(loaded.error, 2);
    const storeArg = ["--owner-store", loaded.storePath];
    startScopeArgs = storeArg;
    wordsScopeArgs = storeArg;
    guardScopeArgs = storeArg;
  } else {
    if (!cfg) throw new HooksError("rendering antigravity hooks requires cfg or ownerStore", 2);
    startScopeArgs = ownerStore ? ["--owner-store", resolve(ownerStore)] : [];
    wordsScopeArgs = ["--records", resolve(cfg.records), "--project", dedupeProjects(cfg, settings).join(",")];
    guardScopeArgs = ["--product", resolve(cfg.product), "--workspaces", resolve(cfg.workDir)];
  }
  const vars = {
    "<SELF_LOOP_SCRIPTS>": resolve(scriptsDir),
    "<START_SCOPE_ARGS>": startScopeArgs,
    "<WORDS_SCOPE_ARGS>": wordsScopeArgs,
    "<GUARD_SCOPE_ARGS>": guardScopeArgs,
  };
  return { [HOOK_KEY]: renderTemplateValue(data[HOOK_KEY], vars) };
}

export const HARNESSES = Object.freeze({
  antigravity: {
    render: renderAntigravityHooks,
    resolveTarget({ scope = "workspace", target = null, cfg = null, env = process.env, cwd = process.cwd() }) {
      if (target) return resolve(cwd, target);
      if (scope === "global") return join(geminiHome(env), "config", "hooks.json");
      if (scope === "workspace") {
        if (!cfg?.product) throw new UsageError("workspace scope requires a resolved product configuration (--config or registered workspace)");
        return join(cfg.product, ".agents", "hooks.json");
      }
      throw new UsageError(`--scope must be workspace or global, got ${JSON.stringify(scope)}`);
    },
  },
});

function getHarness(name) {
  const h = HARNESSES[name];
  if (!h) throw new UsageError(`--harness must be one of ${Object.keys(HARNESSES).join(", ")}, got ${JSON.stringify(name)}`);
  return h;
}

export function resolveHooksTarget({ harness, scope = "workspace", target = null, cfg = null, env = process.env, cwd = process.cwd() }) {
  return getHarness(harness).resolveTarget({ scope, target, cfg, env, cwd });
}

function readJsonObject(file) {
  if (!existsSync(file)) return { exists: false, data: {} };
  let parsed;
  try { parsed = JSON.parse(readFileSync(file, "utf8")); }
  catch (error) { throw new HooksError(`${file}: malformed JSON (${error.message})`); }
  if (!isPlainObject(parsed)) throw new HooksError(`${file}: root must be a plain JSON object`);
  return { exists: true, data: parsed };
}

function writeAtomic(file, content) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = join(dirname(file), `.${basename(file)}.${randomUUID()}.tmp`);
  writeFileSync(tmp, content, "utf8");
  try { renameSync(tmp, file); }
  catch (error) { rmSync(tmp, { force: true }); throw error; }
}

function otherWorktreesNeedExclude(info) {
  if (!info) return false;
  let stdout;
  try { stdout = run("git", ["-C", info.repo.top, "worktree", "list", "--porcelain", "-z"], { encoding: "utf8" }); }
  catch { return false; }
  const currentTop = canonical(info.repo.top);
  for (const entry of stdout.split("\0")) {
    if (!entry.startsWith("worktree ")) continue;
    const wtTop = entry.slice("worktree ".length);
    if (!wtTop || canonical(wtTop) === currentTop) continue;
    if (!existsSync(join(wtTop, info.rel))) continue;
    if (!gitOk(wtTop, "ls-files", "--error-unmatch", "--", info.rel)) return true;
  }
  return false;
}

function validateSelfLoopEntry(entry, file, { checkDisk = true } = {}) {
  const findings = [];
  if (!isPlainObject(entry)) return [`${file}: missing "${HOOK_KEY}" hook object`];
  if (entry.enabled === false) findings.push(`${file}: "${HOOK_KEY}" hook is disabled (enabled: false)`);
  const referencedStores = new Set();
  const noteStore = (flags, label) => {
    if (!("owner-store" in flags)) return false;
    const dir = String(flags["owner-store"] ?? "").trim();
    if (!dir) {
      findings.push(`${file}: ${label} --owner-store requires a non-empty directory path`);
      return false;
    }
    referencedStores.add(resolve(dir));
    return true;
  };
  const flatSpecs = [
    ["SessionStart", "self-loop.mjs"],
    ["PreInvocation", "owner-words.mjs"],
    ["Stop", "word-gate.mjs"],
  ];
  for (const [event, expectedScript] of flatSpecs) {
    const handlers = entry[event];
    if (!Array.isArray(handlers) || !handlers.length) {
      findings.push(`${file}: ${event} must be a non-empty flat array of command handlers`);
      continue;
    }
    const valid = handlers.find(h => isPlainObject(h) && h.type === "command" && typeof h.command === "string" && basename(scriptPathFromCommand(h.command) ?? "") === expectedScript);
    if (!valid) {
      findings.push(`${file}: ${event} is missing a command handler for ${expectedScript}`);
      continue;
    }
    const flags = handlerArgsFromCommand(valid.command);
    if (event === "SessionStart") {
      noteStore(flags, `${event} ${expectedScript}`);
    } else {
      const hasStore = noteStore(flags, `${event} ${expectedScript}`);
      const hasScoped = Boolean(flags.records && flags.project);
      if (!hasStore && !hasScoped) {
        findings.push(`${file}: ${event} ${expectedScript} requires (--records and --project) or --owner-store`);
      }
    }
    if (checkDisk) {
      const script = scriptPathFromCommand(valid.command);
      if (!script || !existsSync(script)) findings.push(`${file}: ${event} script does not exist on disk (${script ?? "none"})`);
    }
  }
  const preTool = entry.PreToolUse;
  if (!Array.isArray(preTool) || !preTool.length) {
    findings.push(`${file}: PreToolUse must be a non-empty grouped array`);
  } else {
    const starGroup = preTool.find(g => isPlainObject(g) && g.matcher === "*" && Array.isArray(g.hooks));
    if (!starGroup) {
      findings.push(`${file}: PreToolUse must contain a group with matcher "*" (required for Antigravity step-type routing)`);
    } else {
      const guard = starGroup.hooks.find(h => isPlainObject(h) && h.type === "command" && typeof h.command === "string" && basename(scriptPathFromCommand(h.command) ?? "") === "lead-guard.mjs");
      if (!guard) {
        findings.push(`${file}: PreToolUse matcher "*" is missing a command handler for lead-guard.mjs`);
      } else {
        const flags = handlerArgsFromCommand(guard.command);
        const hasStore = noteStore(flags, "PreToolUse lead-guard.mjs");
        const hasProduct = typeof flags.product === "string" && flags.product.trim().length > 0;
        if (!hasStore && !hasProduct) {
          findings.push(`${file}: PreToolUse lead-guard.mjs requires --product or --owner-store`);
        }
        if (checkDisk) {
          const script = scriptPathFromCommand(guard.command);
          if (!script || !existsSync(script)) findings.push(`${file}: PreToolUse script does not exist on disk (${script ?? "none"})`);
        }
      }
    }
  }
  if (checkDisk) {
    for (const storeDir of referencedStores) {
      const loaded = loadHookStore(storeDir);
      if (!loaded.ok) findings.push(`${file}: ${loaded.error}`);
    }
  }
  return findings;
}

function globalHookTargets({ harness, adapter, scope, target, cfg, env, cwd }) {
  const primary = adapter.resolveTarget({ scope, target, cfg, env, cwd });
  if (harness === "antigravity" && scope === "global" && !target) {
    const agFile = antigravityHomeHooksFile(env);
    if (agFile && canonical(agFile) !== canonical(primary)) return [primary, agFile];
  }
  return [primary];
}

export function discoverSkill({ cwd = null, product = null, env = process.env } = {}) {
  const checked = [];
  const start = product || cwd;
  if (start) {
    const repo = commonGitDir(start);
    const stop = repo ? canonical(repo.top) : canonical(resolve(start));
    for (let dir = resolve(start); ; dir = dirname(dir)) {
      for (const folder of WORKSPACE_SKILL_DIRS) {
        const candidate = join(dir, folder, "skills", "self-loop", "SKILL.md");
        checked.push(candidate);
        if (existsSync(candidate)) return { discovered: true, path: candidate, checked };
      }
      if (canonical(dir) === stop || dirname(dir) === dir) break;
    }
  }
  const agHome = antigravityHome(env);
  const rawGlobals = [
    ...(agHome ? [join(agHome, "config", "skills", "self-loop", "SKILL.md")] : []),
    join(geminiHome(env), "config", "skills", "self-loop", "SKILL.md"),
    join(env?.HOME || homedir(), ".agents", "skills", "self-loop", "SKILL.md"),
  ];
  const seenGlobals = new Set();
  for (const candidate of rawGlobals) {
    const key = canonical(candidate);
    if (seenGlobals.has(key)) continue;
    seenGlobals.add(key);
    checked.push(candidate);
    if (existsSync(candidate)) return { discovered: true, path: candidate, checked };
  }
  return { discovered: false, path: null, checked };
}

export function installHooks({ harness, scope = "workspace", target = null, cfg = null, settings = null, ownerStore = null, scriptsDir, env = process.env, cwd = process.cwd(), dryRun = false }) {
  const adapter = getHarness(harness);
  const files = globalHookTargets({ harness, adapter, scope, target, cfg, env, cwd });
  const rendered = adapter.render({ cfg, settings, ownerStore, scriptsDir });
  const plans = files.map(file => {
    const ignoreInfo = gitIgnoreTarget(file);
    if (ignoreInfo && isGitTracked(ignoreInfo)) {
      throw new HooksError(`${file}: tracked by Git; refusing to modify tracked user hooks (use --scope global or merge the "${HOOK_KEY}" entry manually)`, 2);
    }
    const { data } = readJsonObject(file);
    const next = { ...data, [HOOK_KEY]: rendered[HOOK_KEY] };
    return { file, ignoreInfo, content: `${JSON.stringify(next, null, 2)}\n` };
  });
  const primary = plans[0];
  const extra = files.length > 1 ? { targets: files } : {};
  const scopeOut = target ? "target" : scope;
  if (dryRun) {
    const exclude = primary.ignoreInfo ? { excludeFile: primary.ignoreInfo.excludeFile, pattern: primary.ignoreInfo.pattern, needed: !primary.ignoreInfo.ignored } : null;
    return { action: "install", harness, scope: scopeOut, target: primary.file, ...extra, dryRun: true, content: primary.content, exclude };
  }
  let primaryExclude = null;
  for (let i = 0; i < plans.length; i++) {
    writeAtomic(plans[i].file, plans[i].content);
    const exclude = ensureExcludeEntry(plans[i].ignoreInfo, { marker: EXCLUDE_MARKER });
    if (i === 0) primaryExclude = exclude;
  }
  return { action: "install", harness, scope: scopeOut, target: primary.file, ...extra, dryRun: false, exclude: primaryExclude };
}

function checkSecondaryHooksFile(file, label, findings) {
  if (!existsSync(file)) { findings.push(`${label} is missing ${HOOK_KEY} hooks (${file})`); return; }
  try {
    const { data } = readJsonObject(file);
    const errs = validateSelfLoopEntry(data[HOOK_KEY], file);
    if (errs.length) findings.push(`${label} has unhealthy ${HOOK_KEY} hooks: ${errs[0]}`);
  } catch (error) {
    findings.push(`${label}: ${error.message}`);
  }
  const ignoreInfo = gitIgnoreTarget(file);
  if (ignoreInfo && !ignoreInfo.ignored && !isGitTracked(ignoreInfo)) {
    findings.push(`${file}: untracked and not git-ignored (${ignoreInfo.pattern} missing from ${ignoreInfo.excludeFile})`);
  }
}

export function checkHooks({ harness, scope = "workspace", target = null, cfg = null, ownerStore = null, env = process.env, cwd = process.cwd() }) {
  const adapter = getHarness(harness);
  const file = adapter.resolveTarget({ scope, target, cfg, env, cwd });
  const findings = [];
  if (!existsSync(file)) {
    findings.push(`${file}: hooks file does not exist`);
  } else {
    try { findings.push(...validateSelfLoopEntry(readJsonObject(file).data[HOOK_KEY], file)); }
    catch (error) { findings.push(error.message); }
  }
  if (ownerStore !== null && ownerStore !== undefined) {
    const loaded = loadHookStore(ownerStore);
    if (!loaded.ok && !findings.some(f => f.includes(loaded.error))) findings.push(loaded.error);
  }
  const ignoreInfo = gitIgnoreTarget(file);
  if (ignoreInfo && !ignoreInfo.ignored && !isGitTracked(ignoreInfo)) {
    findings.push(`${file}: untracked and not git-ignored (${ignoreInfo.pattern} missing from ${ignoreInfo.excludeFile})`);
  }
  const workspaceCovered = Boolean(cfg?.product && existsSync(join(cfg.product, ".agents", "hooks.json")) && (() => {
    try {
      const wsFile = join(cfg.product, ".agents", "hooks.json");
      return validateSelfLoopEntry(readJsonObject(wsFile).data[HOOK_KEY], wsFile).length === 0;
    } catch { return false; }
  })());
  if (scope === "global" || !workspaceCovered) {
    const checkedFiles = new Set([canonical(file)]);
    const agFile = antigravityHomeHooksFile(env);
    if (agFile && !checkedFiles.has(canonical(agFile))) {
      checkedFiles.add(canonical(agFile));
      checkSecondaryHooksFile(agFile, "ANTIGRAVITY_HOME", findings);
    }
    for (const inst of t3AntigravityInstances({ env })) {
      const key = canonical(inst.hooksFile);
      if (checkedFiles.has(key)) continue;
      checkedFiles.add(key);
      checkSecondaryHooksFile(inst.hooksFile, `T3 Antigravity instance ${inst.id}`, findings);
    }
  }
  if (env?.ANTIGRAVITY_LS_VERSION && env.ANTIGRAVITY_LS_VERSION !== VERIFIED_ANTIGRAVITY_LS_VERSION) {
    findings.push(`runtime version drift: ANTIGRAVITY_LS_VERSION=${env.ANTIGRAVITY_LS_VERSION} differs from verified ${VERIFIED_ANTIGRAVITY_LS_VERSION}; re-verify PreToolUse pass-through probe`);
  }
  const skill = discoverSkill({ cwd, product: cfg?.product ?? null, env });
  if (!skill.discovered) findings.push("Antigravity skill self-loop/SKILL.md not found in workspace or global skill paths");
  return { ok: findings.length === 0, harness, scope: target ? "target" : scope, target: file, findings, skill };
}

export function checkAntigravityHooks({ cfg = null, env = process.env, cwd = process.cwd() } = {}) {
  const wsHooks = cfg?.product ? join(cfg.product, ".agents", "hooks.json") : null;
  const globalHooks = join(geminiHome(env), "config", "hooks.json");
  const agHooks = antigravityHomeHooksFile(env);
  const instances = t3AntigravityInstances({ env });
  const detected = Boolean((wsHooks && existsSync(wsHooks)) || existsSync(globalHooks) || (agHooks && existsSync(agHooks)) || instances.length > 0);
  if (!detected) return { detected: false, healthy: true, ok: true, harness: "antigravity", scope: null, findings: [] };
  const scope = wsHooks && existsSync(wsHooks) ? "workspace" : "global";
  const target = scope === "global" && !existsSync(globalHooks) && agHooks && existsSync(agHooks) ? agHooks : null;
  try {
    const res = checkHooks({ harness: "antigravity", scope, target, cfg, env, cwd });
    return { detected: true, healthy: res.ok, ok: res.ok, harness: "antigravity", scope, target: res.target, findings: res.findings };
  } catch (error) {
    return { detected: true, healthy: false, ok: false, harness: "antigravity", scope, target: null, findings: [error.message] };
  }
}

const isGitTracked = info => Boolean(info) && gitOk(info.repo.top, "ls-files", "--error-unmatch", "--", info.rel);

export function uninstallHooks({ harness, scope = "workspace", target = null, cfg = null, env = process.env, cwd = process.cwd(), dryRun = false }) {
  const adapter = getHarness(harness);
  const files = globalHookTargets({ harness, adapter, scope, target, cfg, env, cwd });
  const plans = files.map(file => {
    const { exists, data } = readJsonObject(file);
    const hadKey = exists && Object.hasOwn(data, HOOK_KEY);
    const ignoreInfo = gitIgnoreTarget(file);
    const next = { ...data };
    if (hadKey) delete next[HOOK_KEY];
    return { file, hadKey, ignoreInfo, next, willDeleteFile: hadKey && Object.keys(next).length === 0 && !isGitTracked(ignoreInfo) };
  });
  const primary = plans[0];
  const extra = files.length > 1 ? { targets: files } : {};
  const scopeOut = target ? "target" : scope;
  const removed = plans.some(p => p.hadKey);
  if (dryRun) return { action: "uninstall", harness, scope: scopeOut, target: primary.file, ...extra, dryRun: true, removed, removedFile: primary.willDeleteFile };
  let primaryRemovedFile = false;
  let primaryExclude = null;
  for (let i = 0; i < plans.length; i++) {
    const p = plans[i];
    let removedFile = false;
    if (p.hadKey) {
      if (p.willDeleteFile) {
        rmSync(p.file, { force: true });
        removedFile = true;
        const parent = dirname(p.file);
        if (basename(parent) === ".agents") {
          try { if (readdirSync(parent).length === 0) rmdirSync(parent); } catch {}
        }
      } else {
        writeAtomic(p.file, `${JSON.stringify(p.next, null, 2)}\n`);
      }
    }
    const exclude = otherWorktreesNeedExclude(p.ignoreInfo)
      ? { changed: false, excludeFile: p.ignoreInfo?.excludeFile ?? null, retainedForSibling: true }
      : removeExcludeEntry(p.ignoreInfo, { marker: EXCLUDE_MARKER });
    if (i === 0) { primaryRemovedFile = removedFile; primaryExclude = exclude; }
  }
  return { action: "uninstall", harness, scope: scopeOut, target: primary.file, ...extra, dryRun: false, removed, removedFile: primaryRemovedFile, exclude: primaryExclude };
}
