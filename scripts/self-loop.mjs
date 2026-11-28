#!/usr/bin/env node
// P-0003, P-0014, P-0015, F-0003, F-0009, F-0015, D-0010, D-0016, D-0052, R-0032-reviewer-architecture, R-0055-judge-frame-hygiene
import "./lib/unbind-git.mjs";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { load, Stop } from "./call.mjs";
import { cli, need, parseArgs, UsageError } from "./lib/args.mjs";
import { extractHookDirs } from "./lib/antigravity.mjs";
import { antigravityChildSession } from "./lib/antigravity-words.mjs";
import { git, gitOk, regularFiles } from "./lib/git-plumbing.mjs";
import { HANDOFFS, parseHandoffs } from "./lib/handoff.mjs";
import { dryRun, heartbeatEntry, install, resolveRelease, uninstall } from "./lib/heartbeat.mjs";
import { checkHooks, HooksError, installHooks, uninstallHooks } from "./lib/hooks.mjs";
import { InitError, initLoop, installRecordsPreCommitHook } from "./lib/init.mjs";
import { delegatedThread } from "./lib/owner-words.mjs";
import { pruneAndCompactRecords } from "./lib/records-prune.mjs";
import { addProduct, CONFIG_ENV, discoverLocalLoop, initStore, loadHookStore, loadRegistry, loopSettings, matchHookProduct, productState, real, REGISTRY, resolveConfig, resolveOwnerStore } from "./lib/registry.mjs";
import { continuationText, parentEntryInput, reconcileParentEntry, startReport, startText } from "./lib/start.mjs";
import { stallThreshold, tick, tickText } from "./lib/tick.mjs";
import { cleanWorkDir } from "./lib/work-hygiene.mjs";
import { cliClock, nextLines, recordsOf, stallState } from "./loop.mjs";
import { main as runDispatch } from "./dispatch.mjs";
import { main as runPatch } from "./lead-patch.mjs";
import { main as runSsot } from "./ssot-check.mjs";
import { pruneSuiteStore } from "./suite-green.mjs";
import { main as runWindow } from "./window.mjs";

const skill = join(dirname(fileURLToPath(import.meta.url)), "..");
const USAGE = "self-loop.mjs init|start|next|stall|tick|clean|prune|records|ssot|window|dispatch|patch|heartbeat|hooks|registry ...";

function hoursOf(args) {
  if (!("hours" in args)) return null;
  const hours = Number(args.hours);
  if (!Number.isFinite(hours) || hours <= 0) throw new UsageError("--hours must be a positive number");
  return hours;
}

function nowOf(args) {
  if (!("now" in args)) return Date.now();
  const now = Date.parse(args.now);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(args.now ?? "") || !Number.isFinite(now)) throw new UsageError("--now must be an ISO time, e.g. 2026-11-21T12:00:00Z");
  return now;
}

function selection(args, env, cwd) {
  const store = () => resolveOwnerStore({ flag: args["owner-store"], env });
  if ("all" in args) {
    if ("config" in args) throw new UsageError("--all and --config exclude each other");
    return loadRegistry(store()).products.map(productState);
  }
  const resolved = resolveConfig({ config: args.config, env, cwd, store });
  if (resolved.product) return [resolved.product];
  try {
    const cfg = load(resolved.config);
    return [{ name: null, records: cfg.records, exists: true, loop: resolved.config, cfg, settings: loopSettings(cfg, resolved.config), error: null }];
  } catch (e) { throw new UsageError(e instanceof Stop || e.code === "ENOENT" || e instanceof SyntaxError ? `${resolved.config}: ${e.message}` : e.message); }
}

const heading = p => `== ${p.name} · ${p.records}`;
const unusable = p => !p.exists ? "missing: the registered records folder does not exist"
  : !p.loop ? `no loop: ${p.records} has no loop.json` : p.error ? `error: ${p.error}` : null;

function runNext(products, all, store, clock, full = false) {
  let failed = false;
  const blocks = products.map(p => {
    const head = p.name ? [heading(p)] : [];
    const problem = unusable(p);
    if (problem) return [...head, problem].join("\n");
    try { return [...head, nextLines(p.cfg, p.loop, recordsOf(p.cfg), { store, ...clock, full })].join("\n"); }
    catch (e) {
      if (!all) throw e;
      failed = true;
      return [...head, `error: next failed: ${e.message}`].join("\n");
    }
  });
  console.log(blocks.join("\n\n"));
  return failed ? 1 : 0;
}

function recordsWorkMeta(recordsDir) {
  let maxRound = 0;
  const recordedIds = new Set();
  if (!gitOk(recordsDir, "rev-parse", "--verify", "--quiet", "HEAD^{commit}")) return { maxRound: null, recordedIds };
  for (const e of regularFiles(recordsDir, "HEAD")) {
    const m = /^(?:rounds|evidence|sealed\/judge)\/(\d{4})/.exec(e.path);
    if (m) maxRound = Math.max(maxRound, Number(m[1]));
  }
  if (gitOk(recordsDir, "cat-file", "-e", `HEAD:${HANDOFFS}`)) {
    try {
      for (const h of parseHandoffs(git(recordsDir, "show", `HEAD:${HANDOFFS}`))) {
        if (h.id) recordedIds.add(h.id);
        if (Number.isInteger(h.round)) maxRound = Math.max(maxRound, h.round);
      }
    } catch {}
  }
  return { maxRound: maxRound > 0 ? maxRound : null, recordedIds };
}

function runHygiene(command, args, env, cwd) {
  if (command === "records") {
    const sub = args._[1];
    if (!["gc", "compact"].includes(sub)) {
      throw new UsageError("records gc|compact [--config <loop.json> | --records <dir> | --all] [--retain-rounds N] [--dry-run | --apply] [--json]");
    }
  }
  if ("apply" in args && "dry-run" in args) throw new UsageError("cannot pass both --apply and --dry-run");
  if ("records" in args && ("config" in args || "all" in args)) throw new UsageError("--records excludes --config and --all");
  let retainRounds = null;
  if ("retain-rounds" in args) {
    const n = Number(args["retain-rounds"]);
    if (!Number.isInteger(n) || n < 0) throw new UsageError(`--retain-rounds must be a non-negative integer, got ${args["retain-rounds"]}`);
    retainRounds = n;
  }
  const apply = "apply" in args;
  const all = "all" in args;
  let targets;
  if ("records" in args) {
    if (!args.records) throw new UsageError("missing value for --records");
    const rec = resolve(cwd, args.records);
    if (!existsSync(rec) || !gitOk(rec, "rev-parse", "--git-dir")) throw new UsageError(`--records ${rec} is not a Git repository`);
    const loopPath = join(rec, "loop.json");
    let cfg = null;
    if (existsSync(loopPath)) { try { cfg = load(loopPath); } catch {} }
    targets = [{ name: null, records: rec, exists: true, loop: cfg ? loopPath : null, cfg, error: null }];
  } else {
    targets = selection(args, env, cwd);
  }
  let failed = false;
  const results = targets.map(p => {
    const problem = !p.exists ? "missing: the registered records folder does not exist" : p.error ? `error: ${p.error}` : null;
    if (problem) {
      if (all) failed = true;
      return { product: p.name, records: p.records, apply, error: problem };
    }
    try {
      const records = pruneAndCompactRecords(p.records, { ...(retainRounds !== null ? { retainRounds } : {}), apply, installHooks: false });
      const hook = apply ? installRecordsPreCommitHook(p.records) : null;
      const meta = p.cfg?.workDir ? recordsWorkMeta(p.records) : null;
      const work = p.cfg?.workDir
        ? cleanWorkDir(p.cfg.workDir, { maxRound: meta.maxRound, ...(retainRounds !== null ? { retainRounds } : {}), recordedIds: meta.recordedIds, apply })
        : null;
      const suite = p.cfg?.product && existsSync(p.cfg.product) ? pruneSuiteStore(p.cfg.product, { apply }) : null;
      return { product: p.name, records: p.records, apply, recordsResult: records, work, suite, hook };
    } catch (e) {
      if (!all) throw e;
      failed = true;
      return { product: p.name, records: p.records, apply, error: e.message };
    }
  });
  if ("json" in args) console.log(JSON.stringify(results.length === 1 && !all ? results[0] : results, null, 2));
  else {
    for (const r of results) {
      const prefix = r.product ? `${r.product} (${r.records}): ` : `${r.records}: `;
      if (r.error) { console.log(`${prefix}error: ${r.error}`); continue; }
      const rec = r.recordsResult;
      const mode = r.apply ? "applied" : "dry-run";
      const parts = [
        `${rec.prunedFiles.length} pruned`,
        `${rec.compactedAudits.length} compacted`,
        `${rec.bytesSaved} bytes records`,
        ...(rec.tombstonePath ? [rec.tombstonePath] : []),
        ...(r.work ? [`${r.apply ? r.work.removed.length : r.work.candidates.length} workspaces (${r.work.bytesFreed} bytes)`] : []),
        ...(r.suite ? [`${r.suite.removed.length} suite files (${r.suite.bytesFreed} bytes)`] : []),
        ...(r.hook ? [`hook ${r.hook.changed ? "installed" : "ok"}`] : []),
      ];
      console.log(`${prefix}${mode}: ${parts.join(", ")}`);
    }
  }
  return failed ? 1 : 0;
}

// R-0001-judge
function runStall(products, args) {
  const hours = hoursOf(args), now = nowOf(args);
  const results = products.map(p => {
    const problem = unusable(p);
    if (problem) return { product: p.name, records: p.records, stalled: null, problem };
    const threshold = stallThreshold(p.settings, hours);
    let s;
    try { s = stallState(p.cfg, recordsOf(p.cfg), threshold, now); }
    catch (e) { return { product: p.name, records: p.records, stalled: null, problem: `error: the records cannot be read: ${e.message}` }; }
    return { product: p.name, records: p.records, phase: p.cfg.phase, stalled: s.stalled, settled: s.settled, threshold,
      since: s.last?.time ?? null, source: s.last?.source ?? null, hours: s.elapsed === undefined ? null : Math.round(s.elapsed * 100) / 100,
      unsettled: s.unsettled, line: s.line };
  });
  if ("json" in args) console.log(JSON.stringify(results.length === 1 && !("all" in args) ? results[0] : results, null, 2));
  else for (const r of results) console.log(`${r.product ? `${r.product}: ` : ""}${r.line ?? r.problem}`);
  return results.some(r => r.stalled !== false) ? 2 : 0;
}

function runHeartbeat(args, env) {
  const [, action] = args._;
  if (!["install", "uninstall"].includes(action)) throw new UsageError("heartbeat install|uninstall [--dry-run] [--platform launchd|cron] [--release <dir>] [--owner-store <dir>]");
  const platform = args.platform || (process.platform === "darwin" ? "launchd" : "cron");
  if (!["launchd", "cron"].includes(platform)) throw new UsageError("--platform must be launchd or cron");
  if (action === "uninstall") {
    if ("dry-run" in args) return void console.log(`would remove the ${platform} heartbeat`);
    for (const line of uninstall({ platform })) console.log(line);
    return 0;
  }
  const store = resolveOwnerStore({ flag: args["owner-store"], env });
  loadRegistry(store);
  const entry = heartbeatEntry({ release: resolveRelease({ skill, release: args.release }), store: realpathSync(store.path) });
  if ("dry-run" in args) return void console.log(dryRun(entry));
  for (const line of install(entry, { platform })) console.log(line);
  return 0;
}

function runRegistry(args, env) {
  const [, action] = args._;
  const store = resolveOwnerStore({ flag: args["owner-store"], env });
  const list = value => (value ? value.split(",").map(s => s.trim()).filter(Boolean) : []);
  if (action === "init") {
    initStore(store.path, { roots: list(args.roots) });
    console.log(`owner store ${store.path}: README.md and an empty products.json, committed`);
    return 0;
  }
  if (action === "add") {
    need(args, "name", "records");
    const entry = addProduct(store.path, { name: args.name, records: args.records, aliases: list(args.aliases) });
    console.log(`registered ${entry.name} (${entry.records})`);
    return 0;
  }
  if (action === "list") {
    const registry = loadRegistry(store);
    const products = registry.products.map(productState).map(p => ({ name: p.name, records: p.records, aliases: p.aliases,
      exists: p.exists, loop: Boolean(p.loop), phase: p.cfg?.phase ?? null, error: p.error }));
    if ("json" in args) console.log(JSON.stringify({ ownerStore: store.path, products, roots: registry.roots }, null, 2));
    else {
      console.log(`owner store ${store.path} (${store.source}) · roots: ${registry.roots.join(", ") || "none"}`);
      for (const p of products) console.log(`${p.name}\t${p.records}\t${!p.exists ? "missing" : !p.loop ? "no loop" : p.error ? `error: ${p.error}` : `phase ${p.phase}`}`);
    }
    return 0;
  }
  throw new UsageError("registry init [--roots <dir>,...] | add --name <name> --records <dir> [--aliases a,b] | list [--json]");
}

// design/continuation-entry.md#entry
async function runParentEntry(args, env, cwd) {
  need(args, "parent-entry");
  const command = args._[0], store = resolveOwnerStore({ flag: args["owner-store"], env });
  const clock = cliClock(args);
  const hours = command === "start" ? hoursOf(args) : null;
  const products = command === "next" ? selection(args, env, cwd) : null;
  const input = parentEntryInput(args["parent-entry"]);
  const continuation = await reconcileParentEntry({ store, input, ...clock });
  if (command === "start") {
    const report = startReport({ store, config: args.config, env, cwd, ...clock, hours, skill });
    report.continuation = continuation;
    console.log("json" in args ? JSON.stringify(report, null, 2) : startText(report, { selfLoop: join(skill, "scripts", "self-loop.mjs") }));
    return continuation.failed ? 1 : 0;
  }
  console.log(continuationText(continuation));
  const code = runNext(products, "all" in args, store, clock, "full" in args);
  return code || (continuation.failed ? 1 : 0);
}

function runStartAntigravityHook(args, env) {
  try {
    let input;
    try { input = JSON.parse(readFileSync(0, "utf8") || "{}"); }
    catch { console.log("{}"); return 0; }
    if (delegatedThread(env)
      || (typeof input?.parentConversationId === "string" && input.parentConversationId.length > 0)
      || (input?.transcriptPath && antigravityChildSession(input.transcriptPath))) {
      console.log("{}");
      return 0;
    }
    const hookDirs = extractHookDirs(input);
    if (!hookDirs.length) { console.log("{}"); return 0; }
    const clock = cliClock(args), hours = hoursOf(args);
    const hasConfig = "config" in args;
    const hasOwnerStore = "owner-store" in args;
    const store = hasOwnerStore
      ? { path: args["owner-store"] ? resolve(args["owner-store"]) : "", source: "--owner-store" }
      : resolveOwnerStore({ env });
    const useStoreRouting = !hasConfig && (hasOwnerStore || (!env[CONFIG_ENV] && existsSync(join(store.path, REGISTRY))));
    let sessionRoute = null;
    let startCwd = hookDirs[0];
    let explicitConfig = args.config;
    if (!hasConfig && (hasOwnerStore || !env[CONFIG_ENV])) {
      const localLoops = [];
      for (const dir of hookDirs) {
        const localLoop = discoverLocalLoop(dir);
        if (localLoop) localLoops.push({ config: localLoop, records: real(dirname(localLoop)), cwd: dir });
      }
      const candidates = new Map();
      if (useStoreRouting) {
        const loaded = loadHookStore(hasOwnerStore ? args["owner-store"] : store.path);
        if (!loaded.ok) {
          if (!store.path) {
            console.log(JSON.stringify({ injectSteps: [{ systemMessage: { systemMessage: `This session: ${loaded.error}` } }] }));
            return 0;
          }
          sessionRoute = { problem: loaded.error };
        } else {
          const routed = matchHookProduct(hookDirs, loaded.products);
          if (routed.status === "matched") {
            const p = routed.product;
            candidates.set(real(p.records), { kind: "store", product: p, cwd: routed.projects[0] ?? p.product, label: p.name });
          } else if (routed.status === "ambiguous") {
            const byName = new Map(loaded.products.map(p => [p.name, p]));
            for (const name of routed.products) {
              const p = byName.get(name);
              if (p) candidates.set(real(p.records), { kind: "store", product: p, cwd: p.product, label: p.name });
            }
          }
        }
      }
      if (!sessionRoute) {
        for (const loc of localLoops) {
          if (!candidates.has(loc.records)) {
            candidates.set(loc.records, { kind: "local", config: loc.config, cwd: loc.cwd, label: `in-repo ${loc.records}` });
          }
        }
        if (candidates.size === 0) {
          console.log("{}");
          return 0;
        }
        if (candidates.size > 1) {
          const labels = [...candidates.values()].map(c => c.label).sort();
          const dirs = [...hookDirs].sort();
          const subject = dirs.length > 1 ? `workspaces [${dirs.join(", ")}] match` : `workspace ${dirs[0]} matches`;
          sessionRoute = { problem: `${subject} multiple products: ${labels.join(", ")}` };
          startCwd = dirs[0];
        } else {
          const [only] = candidates.values();
          if (only.kind === "store") {
            sessionRoute = { product: only.product };
            startCwd = only.cwd;
          } else {
            explicitConfig = only.config;
            startCwd = only.cwd;
          }
        }
      }
    }
    const report = startReport({ store, config: explicitConfig, env, cwd: startCwd, ...clock, hours, skill, sessionRoute });
    const text = startText(report, { selfLoop: join(skill, "scripts", "self-loop.mjs") });
    console.log(JSON.stringify({ injectSteps: [{ systemMessage: { systemMessage: text } }] }));
  } catch (error) {
    console.error(`self-loop start --hook antigravity: ${error?.message ?? error}`);
    console.log("{}");
  }
  return 0;
}

function runHooks(args, env, cwd) {
  const [, action] = args._;
  if (!["install", "check", "uninstall"].includes(action)) {
    throw new UsageError("hooks install --records <dir> [--dry-run] [--json] | hooks install|check|uninstall --harness antigravity [--scope workspace|global] [--target <hooks.json>] [--all] [--config <loop.json>] [--owner-store <dir>] [--release <dir>] [--dry-run] [--json]");
  }
  const dryRunFlag = "dry-run" in args;
  const jsonFlag = "json" in args;
  if (action === "install" && "records" in args) {
    if ("harness" in args) throw new UsageError("--records and --harness exclude each other");
    if (!args.records) throw new UsageError("missing value for --records");
    const recordsDir = resolve(cwd, args.records);
    if (!existsSync(recordsDir) || !gitOk(recordsDir, "rev-parse", "--git-dir")) {
      throw new UsageError(`--records ${recordsDir} is not a Git repository`);
    }
    if (dryRunFlag) {
      const hookPath = join(recordsDir, ".githooks", "pre-commit");
      const res = { records: recordsDir, hookPath, dryRun: true };
      if (jsonFlag) console.log(JSON.stringify(res, null, 2));
      else console.log(`# would install records pre-commit hook at ${hookPath}`);
      return 0;
    }
    const res = installRecordsPreCommitHook(recordsDir);
    if (jsonFlag) console.log(JSON.stringify({ records: recordsDir, ...res }, null, 2));
    else console.log(`${res.changed ? "installed" : "verified"} records pre-commit hook at ${res.hookPath}`);
    return 0;
  }
  need(args, "harness");
  const harness = args.harness;
  const scope = args.scope || "workspace";
  const target = args.target || null;
  const allFlag = "all" in args;
  if (allFlag && "config" in args) throw new UsageError("--all and --config exclude each other");
  if (allFlag && scope === "workspace" && !target) throw new UsageError("--all cannot be combined with --scope workspace without --target");
  const hasOwnerStore = "owner-store" in args;
  const store = resolveOwnerStore({ flag: hasOwnerStore ? (args["owner-store"] || undefined) : undefined, env });
  const multiProductInstall = action === "install" && (
    allFlag
    || (!("config" in args) && (
      (scope === "global" && (hasOwnerStore || (!env.SELF_LOOP_CONFIG && existsSync(join(store.path, REGISTRY)))))
      || (Boolean(target) && hasOwnerStore)
    ))
  );
  let cfg = null, settings = null, ownerStore = null;
  if (multiProductInstall) {
    ownerStore = hasOwnerStore ? args["owner-store"] : store.path;
  } else {
    const needConfig = action === "install" || (!target && scope === "workspace");
    if (needConfig || "config" in args || (scope === "workspace" && !target && env.SELF_LOOP_CONFIG)) {
      try {
        const [selected] = selection(args, env, cwd);
        cfg = selected.cfg;
        settings = selected.settings;
      } catch (error) {
        if (needConfig) throw error;
      }
    }
    if (hasOwnerStore) ownerStore = args["owner-store"] ? resolve(args["owner-store"]) : "";
  }
  try {
    if (action === "install") {
      const scriptsDir = args.release ? join(resolveRelease({ skill, release: args.release }), "scripts") : join(skill, "scripts");
      const res = installHooks({ harness, scope, target, cfg, settings, ownerStore, scriptsDir, env, cwd, dryRun: dryRunFlag });
      if (jsonFlag) console.log(JSON.stringify(res, null, 2));
      else if (dryRunFlag) {
        console.log(`# would write ${res.target}`);
        console.log(res.content.trimEnd());
        if (res.exclude?.needed) console.log(`# would append ${res.exclude.pattern} to ${res.exclude.excludeFile}`);
      } else {
        console.log(`installed ${harness} hooks to ${res.target}${res.exclude?.changed ? ` (excluded ${res.exclude.pattern} in ${res.exclude.excludeFile})` : ""}`);
      }
      return 0;
    }
    if (action === "check") {
      const res = checkHooks({ harness, scope, target, cfg, ownerStore, env, cwd });
      if (jsonFlag) console.log(JSON.stringify(res, null, 2));
      else {
        console.log(`${res.ok ? "ok" : "unhealthy"}: ${res.target} (${res.findings.length} finding(s))`);
        for (const f of res.findings) console.log(`  finding: ${f}`);
      }
      return res.ok ? 0 : 2;
    }
    const res = uninstallHooks({ harness, scope, target, cfg, env, cwd, dryRun: dryRunFlag });
    if (jsonFlag) console.log(JSON.stringify(res, null, 2));
    else console.log(`${dryRunFlag ? "would remove" : "removed"} ${harness} hooks from ${res.target}${res.exclude?.changed ? ` (cleaned ${res.exclude.excludeFile})` : ""}`);
    return 0;
  } catch (error) {
    if (error instanceof HooksError) {
      console.error(error.message);
      return error.code;
    }
    throw error;
  }
}

const INIT_VALUE_FLAGS = new Set([
  "product",
  "records",
  "name",
  "branch",
  "owner-store",
  "harness",
  "runner",
  "provider",
  "adapter",
  "model",
  "actor-model",
  "critic-model",
  "judge-model",
  "reviewer-model",
  "independence",
]);
const INIT_BOOL_FLAGS = new Set(["local-exclude", "register", "json"]);

function runInit(args, env, cwd) {
  if (args._.length > 1) throw new UsageError(`init takes no positional argument, got ${args._[1]}`);
  for (const key of Object.keys(args)) {
    if (key === "_") continue;
    if (INIT_VALUE_FLAGS.has(key)) {
      if (!args[key]) throw new UsageError(`missing value for --${key}`);
    } else if (INIT_BOOL_FLAGS.has(key)) {
      if (args[key] !== "") throw new UsageError(`--${key} takes no value`);
    } else {
      throw new UsageError(`init takes no --${key}`);
    }
  }
  try {
    const res = initLoop({
      product: args.product ?? null,
      records: args.records ?? null,
      name: args.name ?? null,
      branch: args.branch ?? null,
      harness: args.harness ?? null,
      runner: args.runner ?? null,
      provider: args.provider ?? null,
      adapter: args.adapter ?? null,
      model: args.model ?? null,
      actorModel: args["actor-model"] ?? null,
      criticModel: args["critic-model"] ?? null,
      judgeModel: args["judge-model"] ?? null,
      reviewerModel: args["reviewer-model"] ?? null,
      independence: args.independence ?? null,
      localExclude: "local-exclude" in args,
      register: "register" in args,
      ownerStore: args["owner-store"] ?? null,
      env,
      cwd,
    });
    if ("json" in args) console.log(JSON.stringify(res, null, 2));
    else {
      const ignoreNote = res.ignore
        ? ` (${res.ignore.changed ? "ignored" : "already ignored"} ${res.ignore.pattern} in ${res.ignore.file})`
        : "";
      const regNote = res.registered ? ` · registered in ${res.ownerStore}` : "";
      console.log(`initialized ${res.name} records at ${res.records}${ignoreNote}${regNote}`);
      console.log(`config: ${res.config}`);
    }
    return 0;
  } catch (error) {
    if (error instanceof InitError) {
      console.error(error.message);
      return error.code;
    }
    throw error;
  }
}

export function main(argv, { env = process.env, cwd = process.cwd(), stdin = null } = {}) {
  const args = parseArgs(argv);
  const [command] = args._;
  if ("parent-entry" in args) {
    if ("now" in args) throw new UsageError("--now simulation cannot be combined with mutating --parent-entry");
    if (!["start", "next"].includes(command)) throw new UsageError("--parent-entry is only valid with start or next");
    return runParentEntry(args, env, cwd);
  }
  if (command === "init") return runInit(args, env, cwd);
  if (command === "start") {
    if ("hook" in args) {
      if (args.hook !== "antigravity") throw new UsageError(`--hook must be antigravity, got ${JSON.stringify(args.hook)}`);
      return runStartAntigravityHook(args, env);
    }
    const clock = cliClock(args), hours = hoursOf(args);
    const report = startReport({ store: resolveOwnerStore({ flag: args["owner-store"], env }), config: args.config, env, cwd, ...clock, hours, skill });
    console.log("json" in args ? JSON.stringify(report, null, 2) : startText(report, { selfLoop: join(skill, "scripts", "self-loop.mjs") }));
    return 0;
  }
  if (command === "next") {
    const clock = cliClock(args);
    return runNext(selection(args, env, cwd), "all" in args, resolveOwnerStore({ flag: args["owner-store"], env }), clock, "full" in args);
  }
  if (command === "clean" || command === "prune" || command === "records") return runHygiene(command, args, env, cwd);
  if (command === "stall") return runStall(selection(args, env, cwd), args);
  if (command === "tick") {
    const report = tick({ store: resolveOwnerStore({ flag: args["owner-store"], env }), now: nowOf(args), hours: hoursOf(args) });
    console.log("json" in args ? JSON.stringify(report, null, 2) : tickText(report));
    return report.findings.length ? 2 : 0;
  }
  if (command === "ssot") return runSsot(argv.slice(1), { env, cwd });
  if (command === "window") return runWindow(argv.slice(1), { env, cwd });
  if (command === "dispatch") return runDispatch(argv.slice(1));
  if (command === "patch") return runPatch(argv.slice(1), { env, cwd, stdin });
  if (command === "heartbeat") return runHeartbeat(args, env);
  if (command === "hooks") return runHooks(args, env, cwd);
  if (command === "registry") return runRegistry(args, env);
  throw new UsageError(USAGE);
}

const invokedAsScript = () => {
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
};
if (invokedAsScript()) cli(() => main(process.argv.slice(2)));
