// Extensible harness hooks installation, conformance checking, and uninstallation (F-0009, design/antigravity-harness.md#hooks-cli).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { commonGitDir } from "../lead-guard.mjs";
import { UsageError } from "./args.mjs";
import { command } from "./commands.mjs";
import { ensureExcludeEntry, gitIgnoreTarget, removeExcludeEntry } from "./git-exclude.mjs";
import { geminiHome, t3AntigravityInstances, VERIFIED_ANTIGRAVITY_LS_VERSION } from "./antigravity.mjs";
import { canonical } from "./path-canonical.mjs";

export const HOOK_KEY = "self-loop";
export const EXCLUDE_MARKER = "# self-loop managed: antigravity hooks";
export const ANTIGRAVITY_TEMPLATE = fileURLToPath(new URL("../../assets/antigravity/hooks.json", import.meta.url));
const WORKSPACE_SKILL_DIRS = [".agents", ".agent", "_agents", "_agent"];

export class HooksError extends Error {
  constructor(message, code = 2) { super(message); this.code = code; }
}

const isPlainObject = v => v !== null && typeof v === "object" && !Array.isArray(v);

/** Split a simple POSIX shell command line into argv tokens. */
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
      const words = parseShellWords(v).map(w => w.replace(/<[A-Z_]+>/g, token => vars[token] ?? token));
      out[k] = command(...words);
    } else {
      out[k] = renderTemplateValue(v, vars);
    }
  }
  return out;
}

export function renderAntigravityHooks({ cfg, settings = null, scriptsDir, templatePath = ANTIGRAVITY_TEMPLATE }) {
  const { data } = readJsonObject(templatePath);
  if (!isPlainObject(data[HOOK_KEY])) throw new HooksError(`${templatePath}: missing "${HOOK_KEY}" template object`);
  const vars = {
    "<SELF_LOOP_SCRIPTS>": resolve(scriptsDir),
    "<RECORDS>": resolve(cfg.records),
    "<PROJECTS>": dedupeProjects(cfg, settings).join(","),
    "<PRODUCT>": resolve(cfg.product),
    "<WORKSPACES>": resolve(cfg.workDir),
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
  const listed = spawnSync("git", ["-C", info.repo.top, "worktree", "list", "--porcelain", "-z"], { encoding: "utf8" });
  if (listed.status !== 0) return false;
  const currentTop = canonical(info.repo.top);
  for (const entry of listed.stdout.split("\0")) {
    if (!entry.startsWith("worktree ")) continue;
    const wtTop = entry.slice("worktree ".length);
    if (!wtTop || canonical(wtTop) === currentTop) continue;
    if (!existsSync(join(wtTop, info.rel))) continue;
    const tracked = spawnSync("git", ["-C", wtTop, "ls-files", "--error-unmatch", "--", info.rel], { encoding: "utf8" }).status === 0;
    if (!tracked) return true;
  }
  return false;
}

function validateSelfLoopEntry(entry, file, { checkDisk = true } = {}) {
  const findings = [];
  if (!isPlainObject(entry)) return [`${file}: missing "${HOOK_KEY}" hook object`];
  if (entry.enabled === false) findings.push(`${file}: "${HOOK_KEY}" hook is disabled (enabled: false)`);
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
      } else if (checkDisk) {
        const script = scriptPathFromCommand(guard.command);
        if (!script || !existsSync(script)) findings.push(`${file}: PreToolUse script does not exist on disk (${script ?? "none"})`);
      }
    }
  }
  return findings;
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
  const globals = [
    join(geminiHome(env), "config", "skills", "self-loop", "SKILL.md"),
    join(env?.HOME || homedir(), ".agents", "skills", "self-loop", "SKILL.md"),
  ];
  for (const candidate of globals) {
    checked.push(candidate);
    if (existsSync(candidate)) return { discovered: true, path: candidate, checked };
  }
  return { discovered: false, path: null, checked };
}

export function installHooks({ harness, scope = "workspace", target = null, cfg, settings = null, scriptsDir, env = process.env, cwd = process.cwd(), dryRun = false }) {
  const adapter = getHarness(harness);
  const file = adapter.resolveTarget({ scope, target, cfg, env, cwd });
  const ignoreInfo = gitIgnoreTarget(file);
  if (ignoreInfo && isGitTracked(ignoreInfo)) {
    throw new HooksError(`${file}: tracked by Git; refusing to modify tracked user hooks (use --scope global or merge the "${HOOK_KEY}" entry manually)`, 2);
  }
  const { data } = readJsonObject(file);
  const rendered = adapter.render({ cfg, settings, scriptsDir });
  const next = { ...data, [HOOK_KEY]: rendered[HOOK_KEY] };
  const content = `${JSON.stringify(next, null, 2)}\n`;
  if (dryRun) {
    return {
      action: "install",
      harness,
      scope: target ? "target" : scope,
      target: file,
      dryRun: true,
      content,
      exclude: ignoreInfo ? { excludeFile: ignoreInfo.excludeFile, pattern: ignoreInfo.pattern, needed: !ignoreInfo.ignored } : null,
    };
  }
  writeAtomic(file, content);
  const exclude = ensureExcludeEntry(ignoreInfo, { marker: EXCLUDE_MARKER });
  return { action: "install", harness, scope: target ? "target" : scope, target: file, dryRun: false, exclude };
}

export function checkHooks({ harness, scope = "workspace", target = null, cfg = null, env = process.env, cwd = process.cwd() }) {
  const adapter = getHarness(harness);
  const file = adapter.resolveTarget({ scope, target, cfg, env, cwd });
  const findings = [];
  if (!existsSync(file)) {
    findings.push(`${file}: hooks file does not exist`);
  } else {
    try {
      const { data } = readJsonObject(file);
      findings.push(...validateSelfLoopEntry(data[HOOK_KEY], file));
    } catch (error) {
      findings.push(error.message);
    }
  }
  const ignoreInfo = gitIgnoreTarget(file);
  if (ignoreInfo && !ignoreInfo.ignored && !isGitTracked(ignoreInfo)) {
    findings.push(`${file}: untracked and not git-ignored (${ignoreInfo.pattern} missing from ${ignoreInfo.excludeFile})`);
  }
  const workspaceCovered = Boolean(cfg?.product && existsSync(join(cfg.product, ".agents", "hooks.json")) && (() => {
    try {
      const wsFile = join(cfg.product, ".agents", "hooks.json");
      const { data } = readJsonObject(wsFile);
      return validateSelfLoopEntry(data[HOOK_KEY], wsFile).length === 0;
    } catch { return false; }
  })());
  if (scope === "global" || !workspaceCovered) {
    for (const inst of t3AntigravityInstances({ env })) {
      if (!existsSync(inst.hooksFile)) {
        findings.push(`T3 Antigravity instance ${inst.id} is missing ${HOOK_KEY} hooks (${inst.hooksFile})`);
        continue;
      }
      try {
        const { data } = readJsonObject(inst.hooksFile);
        const errs = validateSelfLoopEntry(data[HOOK_KEY], inst.hooksFile);
        if (errs.length) findings.push(`T3 Antigravity instance ${inst.id} has unhealthy ${HOOK_KEY} hooks: ${errs[0]}`);
      } catch (error) {
        findings.push(`T3 Antigravity instance ${inst.id}: ${error.message}`);
      }
    }
  }
  if (env?.ANTIGRAVITY_LS_VERSION && env.ANTIGRAVITY_LS_VERSION !== VERIFIED_ANTIGRAVITY_LS_VERSION) {
    findings.push(`runtime version drift: ANTIGRAVITY_LS_VERSION=${env.ANTIGRAVITY_LS_VERSION} differs from verified ${VERIFIED_ANTIGRAVITY_LS_VERSION}; re-verify PreToolUse pass-through probe`);
  }
  const skill = discoverSkill({ cwd, product: cfg?.product ?? null, env });
  if (!skill.discovered) findings.push("Antigravity skill self-loop/SKILL.md not found in workspace or global skill paths");
  return { ok: findings.length === 0, harness, scope: target ? "target" : scope, target: file, findings, skill };
}

/** Fast read-only hook health probe for `self-loop start`: silent when no Antigravity dirs exist on the host. */
export function checkAntigravityHooks({ cfg = null, env = process.env, cwd = process.cwd() } = {}) {
  const wsHooks = cfg?.product ? join(cfg.product, ".agents", "hooks.json") : null;
  const globalHooks = join(geminiHome(env), "config", "hooks.json");
  const instances = t3AntigravityInstances({ env });
  const detected = Boolean((wsHooks && existsSync(wsHooks)) || existsSync(globalHooks) || instances.length > 0);
  if (!detected) return { detected: false, healthy: true, ok: true, harness: "antigravity", scope: null, findings: [] };
  const scope = wsHooks && existsSync(wsHooks) ? "workspace" : "global";
  try {
    const res = checkHooks({ harness: "antigravity", scope, cfg, env, cwd });
    return { detected: true, healthy: res.ok, ok: res.ok, harness: "antigravity", scope, target: res.target, findings: res.findings };
  } catch (error) {
    return { detected: true, healthy: false, ok: false, harness: "antigravity", scope, target: null, findings: [error.message] };
  }
}

function isGitTracked(info) {
  if (!info) return false;
  return spawnSync("git", ["-C", info.repo.top, "ls-files", "--error-unmatch", "--", info.rel], { encoding: "utf8" }).status === 0;
}

export function uninstallHooks({ harness, scope = "workspace", target = null, cfg = null, env = process.env, cwd = process.cwd(), dryRun = false }) {
  const adapter = getHarness(harness);
  const file = adapter.resolveTarget({ scope, target, cfg, env, cwd });
  const { exists, data } = readJsonObject(file);
  const hadKey = exists && Object.hasOwn(data, HOOK_KEY);
  const ignoreInfo = gitIgnoreTarget(file);
  const next = { ...data };
  if (hadKey) delete next[HOOK_KEY];
  const willDeleteFile = hadKey && Object.keys(next).length === 0 && !isGitTracked(ignoreInfo);
  if (dryRun) {
    return { action: "uninstall", harness, scope: target ? "target" : scope, target: file, dryRun: true, removed: hadKey, removedFile: willDeleteFile };
  }
  let removedFile = false;
  if (hadKey) {
    if (willDeleteFile) {
      rmSync(file, { force: true });
      removedFile = true;
      const parent = dirname(file);
      if (basename(parent) === ".agents") {
        try { if (readdirSync(parent).length === 0) rmdirSync(parent); } catch { /* non-empty or gone */ }
      }
    } else {
      writeAtomic(file, `${JSON.stringify(next, null, 2)}\n`);
    }
  }
  const exclude = otherWorktreesNeedExclude(ignoreInfo)
    ? { changed: false, excludeFile: ignoreInfo?.excludeFile ?? null, retainedForSibling: true }
    : removeExcludeEntry(ignoreInfo, { marker: EXCLUDE_MARKER });
  return { action: "uninstall", harness, scope: target ? "target" : scope, target: file, dryRun: false, removed: hadKey, removedFile, exclude };
}
