// tick: the heartbeat's one run over every registered product (design §2.6, §6.1). For each product it runs `stall` and
// `next` from its committed records; a stall becomes a durable alarm in that product's records; then it reports what
// nobody would otherwise see: a registered product without records or without a loop, a product whose records or next
// steps cannot be computed, and a records repository under the registry's roots that nobody registered (I-0001). It
// never needs a harness or a hook. Quiet products are counted, not named: the output is what needs attention.
//
// Every product is inspected on its own, and within a product the stall decision, the committed alarm and the next
// steps are computed separately: one failing never hides another (R-0001-judge R1-3, R1-4). `start` reads the same
// inspection without writing anything.
import { ALARMS, recordAlarm, stallKey } from "./alarms.mjs";
import { discoverRecords, hostLoad, loadRegistry, productState } from "./registry.mjs";
import { stallThreshold } from "./thresholds.mjs";
import { idleSteps, integrationTarget, liveStall, nextLines, reconcilePlans, recordsOf, stallState } from "../loop.mjs";

/** Capabilities an installed adapter provides on this host. No adapter of this release provides `run-lead`
 * (design §4.1; the Claude Code and T3 adapters are slices 8 and 10), so `onStall: resume` reports that and shows. */
export const installedCapabilities = () => new Set();

const round2 = n => Math.round(n * 100) / 100;

export { stallThreshold };

/** What `tick` does about a stall under loop.json `tick.onStall` on this host. */
export function stallAction(onStall) {
  if (onStall !== "resume") return "shown";
  return installedCapabilities().has("run-lead") ? "resume requested"
    : "resume unavailable: no installed adapter provides run-lead; the stall shows at the next start instead";
}

/**
 * One product as its committed records show it, read-only. `problem` ({ kind, detail }) when the product cannot be
 * clocked at all: its records folder is missing, it has no loop.json, its loop.json cannot be used, or its records cannot
 * be read. Otherwise each part on its own: `stall` (the decision, null if it failed), `alarm` (the committed stall alarm
 * of the current idle period, null if none or the ledger failed), `next` (the next steps, when asked for) and `errors`
 * (one line per part that failed).
 */
export function inspectState(product, { now = Date.now(), hours = null, next = true, store = null } = {}) {
  const where = { product: product.name, records: product.records };
  const out = { product, where, problem: null, state: null, threshold: null, stall: null, alarm: null, idle: [], unchecked: [], next: null, errors: [] };
  if (!product.exists) return { ...out, problem: { kind: "missing", detail: "the registered records folder does not exist" } };
  if (!product.loop) return { ...out, problem: { kind: "no loop", detail: "no loop.json, so neither next nor stall can see this product" } };
  if (product.error) return { ...out, problem: { kind: "error", detail: product.error } };
  const { cfg, loop, settings } = product;
  try { out.state = recordsOf(cfg); }
  catch (e) { return { ...out, problem: { kind: "error", detail: `the records cannot be read: ${e.message}` } }; }
  out.threshold = stallThreshold(settings, hours);
  try { out.stall = stallState(cfg, out.state, out.threshold, now); } catch (e) { out.errors.push(`stall failed: ${e.message}`); }
  try { out.alarm = liveStall(cfg, out.state); } catch (e) { out.errors.push(`the alarm ledger ${ALARMS} cannot be read: ${e.message}`); }
  if (out.state.files.some(path => /^plans\/PL-\d{4}\.md$/.test(path))) try {
    const reconciled = reconcilePlans(cfg.records, out.state.revision, cfg.phase, { host: hostLoad({ store, cfg }), base: integrationTarget(cfg, out.state) });
    if (reconciled.problem) out.errors.push(reconciled.problem);
    out.idle = reconciled.idle;
    out.unchecked = reconciled.unchecked;
  } catch (e) { out.errors.push(`the plans cannot be reconciled: ${e.message}`); }
  if (next) try { out.next = nextLines(cfg, loop, out.state, { store }); } catch (e) { out.errors.push(`next failed: ${e.message}`); }
  return out;
}

/** inspectState for a registry entry; an unexpected failure becomes that product's problem, never the run's. */
export function inspectProduct(entry, options) {
  try { return inspectState(productState(entry), options); }
  catch (e) {
    const where = { product: entry.name, records: entry.records };
    return { product: null, where, problem: { kind: "error", detail: `the product could not be inspected: ${e.message}` }, errors: [] };
  }
}

const problemFinding = i => ({ kind: i.problem.kind, ...i.where, detail: i.problem.detail });

// F-0012, R-0008-judge-mechanisms, design/generative-engine.md#idle-packages-and-holds
export const idleFindings = i => i.idle?.length ? [{ kind: "idle", ...i.where, phase: i.product.cfg.phase,
  packages: i.idle.map(p => ({ id: p.id, plan: p.plan, handoff: p.handoff, steps: idleSteps(p) })) }] : [];
// R-0008-judge, design/heartbeat-holds.md#data-flow
export const uncheckedFindings = i => i.unchecked?.length ? [{ kind: "unchecked-release", ...i.where, phase: i.product.cfg.phase,
  packages: i.unchecked.map(p => ({ id: p.id, plan: p.plan, handoff: p.handoff, ...p.unchecked })) }] : [];
const errorFindings = i => i.errors.map(detail => ({ kind: "error", ...i.where, detail }));

/** The stall a decision found, as a finding (without the alarm's outcome). */
function decidedStall(i) {
  const { cfg, settings } = i.product, { stall } = i;
  return { kind: "stall", ...i.where, phase: cfg.phase, since: stall.last.time, source: stall.last.source, hours: round2(stall.elapsed),
    threshold: i.threshold, unsettled: stall.unsettled, alarm: stallKey(cfg.phase, stall.last.time), onStall: settings.onStall,
    action: stallAction(settings.onStall) };
}

/** One product's tick findings; a stall's alarm is committed in its records (idempotently, by its key). */
function tickFindings(i, now) {
  if (i.problem) return [problemFinding(i)];
  const findings = [];
  if (i.stall?.stalled) {
    const d = decidedStall(i);
    const finding = { ...d, recorded: false, next: i.next };
    const alarm = { type: "stall", key: d.alarm, time: new Date(now).toISOString(), phase: d.phase, since: d.since, source: d.source,
      hours: d.hours, threshold: d.threshold, unsettled: d.unsettled, by: "tick", onStall: d.onStall, action: d.action };
    try {
      const written = recordAlarm(i.product.cfg.records, alarm);
      finding.recorded = written.recorded;
      if (written.recorded) finding.commit = written.commit;
    } catch (e) { finding.detail = `the alarm could not be recorded in ${ALARMS}: ${e.message}`; }
    findings.push(finding);
  }
  return [...findings, ...idleFindings(i), ...uncheckedFindings(i), ...errorFindings(i)];
}

/**
 * Records repositories under the registry's roots nobody registered, and every root or folder the search could not
 * cover. The owner store and the registered loops' work folders are not searched.
 */
export function discoveryFindings(registry, store, inspected) {
  const exclude = [store.path, ...inspected.map(i => i.product?.cfg?.workDir).filter(Boolean)];
  const { unregistered, problems } = discoverRecords(registry, { exclude });
  const findings = [];
  for (const found of unregistered) {
    findings.push({ kind: "unregistered", path: found.path, detail: "holds records.json, but products.json does not register it" });
    if (!found.loop) findings.push({ kind: "no loop", path: found.path, detail: "no loop.json, so neither next nor stall can see it" });
  }
  for (const problem of problems) findings.push({ kind: "error", path: problem.path, detail: problem.detail });
  return findings;
}

/** Run tick over the owner store's registry. `now` is a time in milliseconds; `hours` overrides every threshold. */
export function tick({ store, now = Date.now(), hours = null }) {
  const registry = loadRegistry(store);
  const inspected = registry.products.map(entry => inspectProduct(entry, { now, hours, store }));
  const findings = [...inspected.flatMap(i => tickFindings(i, now)), ...discoveryFindings(registry, store, inspected)];
  return { time: new Date(now).toISOString(), ownerStore: store.path, products: registry.products.length, findings };
}

/**
 * The stall a reader should see for one product: the committed alarm of its current idle period (live whatever
 * threshold raised it; `raised` is when tick recorded it), else a stall decided now that no tick has recorded.
 */
export function liveStallFinding(i, now) {
  if (i.problem) return null;
  const { alarm } = i;
  if (alarm)
    return { kind: "stall", ...i.where, phase: alarm.phase, since: alarm.since, source: alarm.source, hours: round2((now - Date.parse(alarm.since)) / 3600_000),
      threshold: alarm.threshold, unsettled: alarm.unsettled ?? [], alarm: alarm.key, raised: alarm.time, onStall: alarm.onStall, action: alarm.action };
  if (!i.stall?.stalled) return null;
  return { ...decidedStall(i), raised: null,
    action: "no alarm recorded: no tick has run since this product went idle (is the heartbeat installed? self-loop.mjs heartbeat install)" };
}

/** A finding's first line, shared by tick and start. */
export function findingLine(f) {
  const label = { stall: "STALL", "no loop": "NO LOOP", missing: "MISSING", error: "ERROR", unregistered: "UNREGISTERED" };
  const who = f.product ? `${f.product} (${f.records})` : f.path;
  if (f.kind === "unchecked-release")
    return `UNCHECKED RELEASE ${who}: phase ${f.phase}, ${f.packages.length} release(s) in words awaiting review (A3, screening): ${f.packages.map(p => `${p.id} (${p.plan}, ${p.handoff}) waits "${p.hold}" until "${p.release}": ${p.review}`).join("; ")}`;
  if (f.kind === "idle")
    return `IDLE ${who}: phase ${f.phase}, ${f.packages.length} package(s) ready by the plan with no start and no recorded hold (A3, screening): ${f.packages.map(p => `${p.id} (${p.plan}, ${p.handoff})`).join(", ")}; start each, or record its hold and release in a revision of its plan`;
  if (f.kind !== "stall") return `${label[f.kind]} ${who}: ${f.detail}`;
  const head = `STALL ${who}: phase ${f.phase}, no recorded activity since ${f.since} (${f.source}), ${f.hours}h ≥ ${f.threshold}h; unfinished ${f.unsettled.join(", ") || "no features"}`;
  if ("raised" in f) return head + (f.raised ? ` · alarm raised ${f.raised} by tick [${ALARMS}] · onStall ${f.onStall}: ${f.action}` : ` · ${f.action}`);
  return head + ` · alarm ${f.recorded ? "recorded" : f.detail ? "NOT recorded" : "already recorded"} in ${ALARMS} · onStall ${f.onStall}: ${f.action}`;
}

/** Products a report does not name. */
export const quietCount = (report) => report.products - new Set(report.findings.filter(f => f.product).map(f => f.product)).size;

/** The report as text: one line per finding, then the next steps of each stalled product. */
export function tickText(report) {
  const lines = [`tick ${report.time} · owner store ${report.ownerStore} · ${report.products} registered product(s)`];
  for (const f of report.findings) {
    lines.push(findingLine(f));
    if (f.kind === "idle") for (const p of f.packages) lines.push(`  ${p.id} (${p.plan}):`, ...p.steps.map(step => `    ${step}`));
    if (f.kind !== "stall") continue;
    if (f.detail) lines.push(`  ${f.detail}`);
    if (f.next) lines.push(...f.next.split("\n").map(line => `  ${line}`));
  }
  lines.push(`${quietCount(report)} registered product(s) quiet`);
  return lines.join("\n");
}
