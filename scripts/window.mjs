#!/usr/bin/env node
// CLI for Bounded Horizon Windows (`metrics/windows.jsonl`).
//
// node scripts/window.mjs open --records <dir> --phase <p> --horizon <N> --goal "<text>" --invariant "<text>" [--invariant ...] [--start-round <R>] [--by <who>] [--json]
// node scripts/window.mjs status --records <dir> [--phase <p>] [--json]
// node scripts/window.mjs close --records <dir> --id <W-NNNN> --verdict verified|reframed [--commit <sha>] [--config <loop.json>] [--by <who>] [--note "<text>"] [--json]
import "./lib/unbind-git.mjs";
import { lstatSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { load, Stop } from "./call.mjs";
import { cli, UsageError } from "./lib/args.mjs";
import { HANDOFFS, parseHandoffs } from "./lib/handoff.mjs";
import { RecordsConflict, recordsSnapshot } from "./lib/records-commit.mjs";
import {
  CLOSE_VERDICTS, closeWindow, defaultStartRound, MAX_HORIZON, MIN_HORIZON, openWindow,
  parseWindows, WindowRefusalError, WINDOWS, windowState,
} from "./lib/window.mjs";
import { parseRows, TRAJECTORY } from "./trajectory.mjs";

const USAGE = [
  "window.mjs open --records <dir> --phase <p> --horizon <N> --goal <text> --invariant <text> [--invariant ...] [--start-round <R>] [--by <who>] [--json]",
  "window.mjs status --records <dir> [--phase <p>] [--json]",
  "window.mjs close --records <dir> --id <W-NNNN> --verdict verified|reframed [--commit <sha>] [--config <loop.json>] [--by <who>] [--note <text>] [--json]",
].join("\n");

const FLAGS = {
  open: { value: new Set(["records", "config", "phase", "horizon", "goal", "start-round", "by"]), multi: new Set(["invariant"]), bool: new Set(["json"]) },
  status: { value: new Set(["records", "config", "phase"]), multi: new Set(), bool: new Set(["json"]) },
  close: { value: new Set(["records", "config", "id", "phase", "verdict", "commit", "by", "note"]), multi: new Set(), bool: new Set(["json"]) },
};

function parseWindowArgs(argv) {
  const [sub, ...rest] = argv;
  if (!Object.hasOwn(FLAGS, sub)) throw new UsageError(USAGE);
  const spec = FLAGS[sub];
  const opts = { invariants: [], json: false };
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (!token.startsWith("--")) throw new UsageError(`unexpected positional argument: ${token}`);
    const key = token.slice(2);
    if (spec.bool.has(key)) {
      if (rest[i + 1] !== undefined && !rest[i + 1].startsWith("--")) throw new UsageError(`--${key} takes no value`);
      opts[key] = true;
    } else if (spec.multi.has(key)) {
      const val = rest[++i];
      if (val === undefined || val.startsWith("--")) throw new UsageError(`missing value for --${key}`);
      opts.invariants.push(val);
    } else if (spec.value.has(key)) {
      const val = rest[++i];
      if (val === undefined || val.startsWith("--")) throw new UsageError(`missing value for --${key}`);
      opts[key] = val;
    } else {
      throw new UsageError(`${sub} takes no --${key}`);
    }
  }
  return { sub, opts };
}

function positiveInt(raw, flag) {
  if (!/^\d+$/.test(raw)) throw new UsageError(`--${flag} must be a positive integer, got ${JSON.stringify(raw)}`);
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 1) throw new UsageError(`--${flag} must be a positive integer, got ${JSON.stringify(raw)}`);
  return n;
}

function resolveRecordsAndCfg(opts, cwd) {
  let cfg = null;
  if (opts.config) {
    try { cfg = load(resolve(cwd, opts.config)); }
    catch (e) { throw new UsageError(e instanceof Stop ? e.message : `--config ${opts.config}: ${e.message}`); }
  }
  const recordsArg = opts.records ?? cfg?.records;
  if (!recordsArg) throw new UsageError("missing --records");
  const records = resolve(cwd, recordsArg);
  if (!lstatSync(records, { throwIfNoEntry: false })?.isDirectory()) throw new UsageError(`--records ${recordsArg} must name a directory`);
  return { records: realpathSync.native(records), cfg };
}

function formatStatusText(state, phase) {
  if (!state.active) return `phase ${phase ?? "all"}: no active bounded window (${state.history.length} closed)`;
  const w = state.active;
  const lines = [
    `Window ${w.id} (phase ${w.phase} · ${state.mode} · ${state.usedActorRounds}/${w.horizon} actor rounds · start ${w.startRound} · end ${state.endRound})`,
    `  Goal: ${w.goal}`,
    `  Invariants: ${w.invariants.join("; ")}`,
    `  Gate due: ${state.gateDue ? "yes (actor calls refused)" : `no (${state.remainingSlack} slack remaining)`}`,
  ];
  if (state.alarm) lines.push(`  Alarm: ${state.alarm.key} — ${state.alarm.message}`);
  return lines.join("\n");
}

export function main(argv, { cwd = process.cwd() } = {}) {
  const { sub, opts } = parseWindowArgs(argv);
  const { records, cfg } = resolveRecordsAndCfg(opts, cwd);
  try {
    if (sub === "open") {
      const phase = opts.phase ?? cfg?.phase;
      if (!phase) throw new UsageError("missing --phase");
      if (!opts.horizon) throw new UsageError("missing --horizon");
      const horizon = positiveInt(opts.horizon, "horizon");
      if (horizon < MIN_HORIZON || horizon > MAX_HORIZON)
        throw new UsageError(`--horizon must be between ${MIN_HORIZON} and ${MAX_HORIZON}, got ${horizon}`);
      if (!opts.goal) throw new UsageError("missing --goal");
      if (!opts.invariants.length) throw new UsageError("missing --invariant (provide at least one)");
      const startRound = opts["start-round"] ? positiveInt(opts["start-round"], "start-round") : defaultStartRound(records);
      const res = openWindow(records, { phase, startRound, horizon, goal: opts.goal, invariants: opts.invariants, by: opts.by ?? "lead" });
      if (opts.json) console.log(JSON.stringify(res, null, 2));
      else console.log(`opened ${res.event.id} (phase ${res.event.phase}, start ${res.event.startRound}, horizon ${res.event.horizon}) -> ${res.commit.slice(0, 12)}`);
      return 0;
    }
    if (sub === "status") {
      const snap = recordsSnapshot(records);
      const windows = parseWindows(snap.read(WINDOWS), WINDOWS);
      const handoffs = parseHandoffs(snap.read(HANDOFFS)).filter(h => snap.files.has(h.record));
      const rows = parseRows(snap.read(TRAJECTORY));
      let phase = opts.phase ?? cfg?.phase ?? null;
      if (!phase && snap.files.has("loop.json")) {
        try { phase = JSON.parse(snap.read("loop.json")).phase ?? null; } catch {}
      }
      const nextRound = defaultStartRound(records, snap.head);
      const state = windowState({ windows, handoffs, rows, phase, nextRound });
      if (opts.json) console.log(JSON.stringify(state, null, 2));
      else console.log(formatStatusText(state, phase));
      return 0;
    }
    if (!opts.id) throw new UsageError("missing --id");
    if (!opts.verdict) throw new UsageError("missing --verdict");
    if (!CLOSE_VERDICTS.includes(opts.verdict))
      throw new UsageError(`--verdict must be one of ${CLOSE_VERDICTS.join(", ")}, got ${JSON.stringify(opts.verdict)}`);
    const res = closeWindow(records, {
      id: opts.id, phase: opts.phase ?? null, commit: opts.commit ?? null,
      verdict: opts.verdict, by: opts.by ?? "lead", note: opts.note ?? null, cfg,
    });
    if (opts.json) console.log(JSON.stringify(res, null, 2));
    else console.log(`closed ${res.event.id} (${res.event.verdict}) -> ${res.commit.slice(0, 12)}`);
    return 0;
  } catch (e) {
    if (e instanceof WindowRefusalError || e instanceof RecordsConflict) {
      console.error(`Refused: ${e.message}`);
      return 2;
    }
    throw e;
  }
}

const invokedAsScript = () => {
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
};
if (invokedAsScript()) cli(() => main(process.argv.slice(2)));
