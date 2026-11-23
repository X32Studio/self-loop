// start: the one entry point a fresh session of any harness reads first (design §6.2, F-0003). This part of it shows
// what the heartbeat found for every registered product, whatever product the session runs in (I-0001: a product the
// lead was not looking at stood still), then the session's own product and its next steps.
//
// For each registered product: the committed stall alarm of its current idle period (the alarm `tick` wrote, identified
// by the phase and the last recorded activity, exactly as `tick` and `next` identify it, so it stays live until activity
// resumes or the phase changes, whatever threshold raised it), or a stall decided now that no tick has recorded (the
// heartbeat is not running); a product that cannot be clocked (missing, no loop, unreadable); and records repositories
// under the roots nobody registered. It reads committed records only and writes nothing: reading appends no alarm.
// Still to come in slice 6: lead or child, the rules block with effective rungs, open words, adapter and hooks health.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { load, Stop } from "../call.mjs";
import { UsageError } from "./args.mjs";
import { loadRegistry, LOOP, productState, resolveConfig } from "./registry.mjs";
import { discoveryFindings, findingLine, idleFindings, uncheckedFindings, inspectProduct, liveStallFinding, quietCount } from "./tick.mjs";
import { nextLines, queryClock, recordsOf } from "../loop.mjs";

/** One registered product's findings for a reader: its problem, its live stall, and what failed to compute. */
function watchFindings(i, now) {
  if (i.problem) return [{ kind: i.problem.kind, ...i.where, detail: i.problem.detail }];
  const stall = liveStallFinding(i, now);
  return [...(stall ? [{ ...stall, loop: join(i.product.records, LOOP) }] : []), ...[...idleFindings(i), ...uncheckedFindings(i)].map(f => ({ ...f, loop: join(i.product.records, LOOP) })),
    ...i.errors.map(detail => ({ kind: "error", ...i.where, detail }))];
}

/** The session's product: the one configuration resolved as `next` resolves it; none or several is reported, not guessed. */
function sessionOf({ config, env, cwd, store, inspected, clock }) {
  let resolved;
  try { resolved = resolveConfig({ config, env, cwd, store: () => store }); }
  catch (e) {
    if (e instanceof UsageError) return { product: null, problem: e.message };
    throw e;
  }
  const seen = resolved.product && inspected.find(i => i.product?.name === resolved.product.name && i.state);
  let cfg = seen?.product.cfg, state = seen?.state;
  if (!cfg) {
    try { cfg = resolved.product?.cfg ?? load(resolved.config); }
    catch (e) {
      if (e instanceof Stop || e.code === "ENOENT" || e instanceof SyntaxError) throw new UsageError(`${resolved.config}: ${e.message}`);
      throw e;
    }
  }
  const session = { product: resolved.product?.name ?? null, records: cfg.records, config: resolved.config, source: resolved.source, next: null, error: null };
  try { session.next = nextLines(cfg, resolved.config, state ?? recordsOf(cfg), { store, ...clock }); }
  catch (e) { session.error = `next failed: ${e.message}`; }
  return session;
}

/**
 * The start report. `config` is --config (else SELF_LOOP_CONFIG, else the registry by the working directory). A
 * missing or malformed registry is reported, not fatal: the session's own product still shows.
 */
export function startReport({ store, config, env = process.env, cwd = process.cwd(), now, clockMode, hours = null, skill }) {
  const clock = queryClock({ now, clockMode });
  now = clock.now;
  let registry = null, registryProblem = null;
  try { registry = loadRegistry(store); }
  catch (e) {
    if (!(e instanceof UsageError)) throw e;
    registryProblem = e.message;
  }
  const inspected = registry ? registry.products.map(entry => inspectProduct(entry, { now, hours, next: false, store })) : [];
  const findings = [...inspected.flatMap(i => watchFindings(i, now)), ...(registry ? discoveryFindings(registry, store, inspected) : [])];
  const version = skill && existsSync(join(skill, "VERSION")) ? readFileSync(join(skill, "VERSION"), "utf8").trim() : null;
  return { time: new Date(now).toISOString(), clock: { now: new Date(now).toISOString(), mode: clock.clockMode, source: clock.clockMode === "simulation" ? "injected" : "system-utc" }, release: { version, path: skill ?? null }, ownerStore: store.path, registry: registryProblem,
    products: registry?.products.length ?? 0, findings, session: sessionOf({ config, env, cwd, store, inspected, clock }) };
}

/** The report as text, for the session to read. `selfLoop` is the command a stalled product's next steps are shown by. */
export function startText(report, { selfLoop = "self-loop.mjs" } = {}) {
  const { release } = report;
  const lines = [`self-loop start ${report.time} · ${report.clock?.mode === "simulation" ? "read-only simulation" : "live clock"} · release ${release.version ?? "unknown"} (${release.path ?? "?"}) · owner store ${report.ownerStore} · ${report.products} registered product(s)`];
  if (report.registry) lines.push(`registry: ${report.registry}; no other product is watched from here`);
  else {
    lines.push("", report.continuation ? "Every registered product, from its committed records (parent-entry results below):" : "Every registered product, from its committed records (start records nothing):");
    for (const f of report.findings) {
      lines.push(findingLine(f));
      if (f.kind === "stall" || f.kind === "idle" || f.kind === "unchecked-release") lines.push(`  next: node ${selfLoop} next --config ${f.loop}`);
    }
    lines.push(`${quietCount(report)} registered product(s) quiet`);
  }
  if (report.continuation) lines.push("", continuationText(report.continuation));
  const { session } = report;
  lines.push("");
  if (session.problem) lines.push(`This session: ${session.problem}`);
  else {
    lines.push(`This session: ${session.product ?? "configured product"} · ${session.records} · ${session.config} (${session.source})`);
    lines.push(session.next ?? session.error);
  }
  return lines.join("\n");
}

// design/continuation-entry.md
export function parentEntryInput(path) {
  let input;
  try { input = JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { throw new UsageError(`--parent-entry: ${error.message}`); }
  const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
  const keys = (value, allowed) => Object.keys(value).every(key => allowed.includes(key));
  if (!object(input) || !keys(input, ["schema", "products"]) || input.schema !== "continuation-entry/v1" || !Array.isArray(input.products))
    throw new UsageError("--parent-entry requires {schema: 'continuation-entry/v1', products: [...]}");
  for (const p of input.products) {
    if (!object(p) || !keys(p, ["records", "parentBinding", "hostObservation", "observations"]) || typeof p.records !== "string" || !p.records ||
        !(p.parentBinding == null || object(p.parentBinding)) || !(p.hostObservation == null || object(p.hostObservation)) ||
        !(p.observations === undefined || Array.isArray(p.observations)))
      throw new UsageError("--parent-entry has an invalid product entry");
    for (const observation of p.observations ?? []) {
      if (!object(observation) || !keys(observation, ["publicObservation", "bindingRef"]) ||
          !object(observation.publicObservation) || !("bindingRef" in observation))
        throw new UsageError("--parent-entry observations require publicObservation and bindingRef");
    }
  }
  return input;
}

// design/continuation-entry.md
export async function reconcileParentEntry({ store, input, now, clockMode }) {
  const clock = queryClock({ now, clockMode });
  if (clock.clockMode !== "live") throw new UsageError("--now simulation cannot be combined with mutating --parent-entry");
  const registry = loadRegistry(store);
  const canonical = path => {
    try { return realpathSync(path); } catch { return path; }
  };
  const products = registry.products.map(productState);
  const registered = new Set(products.map(p => canonical(p.records)));
  const inputs = new Map();
  for (const entry of input.products) {
    const records = canonical(entry.records);
    if (!registered.has(records)) throw new UsageError(`--parent-entry: unregistered records ${entry.records}`);
    if (inputs.has(records)) throw new UsageError(`--parent-entry: duplicate records ${entry.records}`);
    inputs.set(records, entry);
  }
  let api, apiError;
  try { api = await import("./continuation.mjs"); }
  catch (error) { apiError = error.message; }
  const results = [];
  for (const product of products) {
    const records = canonical(product.records), entry = inputs.get(records);
    const result = { product: product.name, records, captures: [], reconciliation: null, next: null, errors: [], unknowns: [] };
    if (!entry?.parentBinding) result.unknowns.push("parent caller identity unavailable; no identity inferred from the environment");
    if (!entry?.hostObservation) result.unknowns.push("explicit host observation unavailable");
    if (apiError) result.errors.push(`continuation API unavailable: ${apiError}`);
    else {
      for (const observation of entry?.observations ?? []) {
        try { result.captures.push(await api.capture(observation.publicObservation, observation.bindingRef, records, { store })); }
        catch (error) { result.errors.push(`capture failed: ${error.message}`); }
      }
      try { result.reconciliation = await api.reconcileAtExistingParentEntry(records, entry?.parentBinding ?? null, entry?.hostObservation ?? null, { store }); }
      catch (error) { result.errors.push(`reconciliation failed: ${error.message}`); }
    }
    if (!product.exists || !product.cfg || product.error) result.errors.push(product.error ?? "registered product configuration unavailable");
    else {
      try { result.next = nextLines(product.cfg, product.loop, recordsOf(product.cfg), { store, ...clock }); }
      catch (error) { result.errors.push(`canonical next failed: ${error.message}`); }
    }
    results.push(result);
  }
  return { mode: "existing-parent-entry", wake: "unavailable", nextTrigger: "next actual parent entry with explicit public binding",
    limitation: "No independent wake/replay executor; if the parent never enters again, pending work remains pending. Local consume is not package delivery or launch acknowledgement.",
    products: results, failed: results.some(result => result.errors.length > 0) };
}

// design/continuation-entry.md
export function continuationText(report) {
  const lines = [`Continuation: ${report.mode} · independent wake ${report.wake}`, report.limitation, `Next trigger: ${report.nextTrigger}`];
  for (const result of report.products) {
    lines.push(`== continuation ${result.product} · ${result.records}`);
    for (const capture of result.captures) lines.push(`capture: ${JSON.stringify(capture)}`);
    lines.push(`reconciliation: ${JSON.stringify(result.reconciliation)}`);
    for (const unknown of result.unknowns) lines.push(`unknown: ${unknown}`);
    for (const error of result.errors) lines.push(`error: ${error}`);
    if (result.next !== null) lines.push(result.next);
  }
  return lines.join("\n");
}
