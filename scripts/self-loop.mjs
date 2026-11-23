#!/usr/bin/env node
// The one command (design §2.2): the next-step driver for one product or every product in the owner store's registry,
// the heartbeat's tick, the heartbeat itself and the registry. No harness or hook is needed for any of it; a session of
// any agent, a terminal or the OS scheduler runs the same lines.
//
// node self-loop.mjs start [--config <loop.json>] [--hours N] [--now <ISO time>] [--json] [--owner-store <dir>]
// node self-loop.mjs start|next --parent-entry <public-input.json> [--owner-store <dir>]
// node self-loop.mjs next  [--config <loop.json> | --all] [--owner-store <dir>]
// node self-loop.mjs stall [--hours N] [--config <loop.json> | --all] [--now <ISO time>] [--json] [--owner-store <dir>]
// node self-loop.mjs tick  [--hours N] [--now <ISO time>] [--json] [--owner-store <dir>]
// node self-loop.mjs heartbeat install|uninstall [--dry-run] [--platform launchd|cron] [--release <dir>] [--owner-store <dir>]
// node self-loop.mjs registry init [--roots <dir>,...] | add --name <name> --records <dir> [--aliases a,b] | list [--json]
//
// The configuration: --config, else SELF_LOOP_CONFIG, else the registered product whose folders hold the working
// directory (lib/registry.mjs). The owner store: --owner-store, else SELF_LOOP_OWNER_STORE, else ~/.self-loop/owner-store.
// design/continuation-entry.md
import "./lib/unbind-git.mjs";
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { load, Stop } from "./call.mjs";
import { cli, need, parseArgs, UsageError } from "./lib/args.mjs";
import { dryRun, heartbeatEntry, install, resolveRelease, uninstall } from "./lib/heartbeat.mjs";
import { addProduct, initStore, loadRegistry, loopSettings, productState, resolveConfig, resolveOwnerStore } from "./lib/registry.mjs";
import { continuationText, parentEntryInput, reconcileParentEntry, startReport, startText } from "./lib/start.mjs";
import { stallThreshold, tick, tickText } from "./lib/tick.mjs";
import { cliClock, nextLines, recordsOf, stallState } from "./loop.mjs";

const skill = join(dirname(fileURLToPath(import.meta.url)), "..");
const USAGE = "self-loop.mjs start|next|stall|tick|heartbeat|registry ... (see the header of scripts/self-loop.mjs)";

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

/** The products a next or stall runs on: every registered one (--all), or the one configuration resolved. */
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

function runNext(products, all, store, clock) {
  let failed = false;
  const blocks = products.map(p => {
    const head = p.name ? [heading(p)] : [];
    const problem = unusable(p);
    if (problem) return [...head, problem].join("\n");
    try { return [...head, nextLines(p.cfg, p.loop, recordsOf(p.cfg), { store, ...clock })].join("\n"); }
    catch (e) {
      if (!all) throw e;
      failed = true;
      return [...head, `error: next failed: ${e.message}`].join("\n");
    }
  });
  console.log(blocks.join("\n\n"));
  return failed ? 1 : 0;
}

/** Each product's stall decision on its own: one whose records cannot be read is a result of its own (R-0001-judge R1-4). */
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
  loadRegistry(store); // a heartbeat with no registry would tick nothing
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

// design/continuation-entry.md
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
  const code = runNext(products, "all" in args, store, clock);
  return code || (continuation.failed ? 1 : 0);
}

export function main(argv, { env = process.env, cwd = process.cwd() } = {}) {
  const args = parseArgs(argv);
  const [command] = args._;
  if ("parent-entry" in args) {
    if ("now" in args) throw new UsageError("--now simulation cannot be combined with mutating --parent-entry");
    if (!["start", "next"].includes(command)) throw new UsageError("--parent-entry is only valid with start or next");
    return runParentEntry(args, env, cwd);
  }
  if (command === "start") {
    const clock = cliClock(args), hours = hoursOf(args);
    const report = startReport({ store: resolveOwnerStore({ flag: args["owner-store"], env }), config: args.config, env, cwd, ...clock, hours, skill });
    console.log("json" in args ? JSON.stringify(report, null, 2) : startText(report, { selfLoop: join(skill, "scripts", "self-loop.mjs") }));
    return 0;
  }
  if (command === "next") {
    const clock = cliClock(args);
    return runNext(selection(args, env, cwd), "all" in args, resolveOwnerStore({ flag: args["owner-store"], env }), clock);
  }
  if (command === "stall") return runStall(selection(args, env, cwd), args);
  if (command === "tick") {
    const report = tick({ store: resolveOwnerStore({ flag: args["owner-store"], env }), now: nowOf(args), hours: hoursOf(args) });
    console.log("json" in args ? JSON.stringify(report, null, 2) : tickText(report));
    return report.findings.length ? 2 : 0;
  }
  if (command === "heartbeat") return runHeartbeat(args, env);
  if (command === "registry") return runRegistry(args, env);
  throw new UsageError(USAGE);
}

const invokedAsScript = () => {
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
};
if (invokedAsScript()) cli(() => main(process.argv.slice(2)));
