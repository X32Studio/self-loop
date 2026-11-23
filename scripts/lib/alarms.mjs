// Durable alarms of the next-step driver: `metrics/alarms.jsonl` in a product's records, one JSON line per alarm, written
// only by `tick` through the one records commit helper (D-0001 item 1), so concurrent ticks lose no line. A later
// intervention record can then say whether the loop raised the stall before the owner did (REQUIREMENTS item 4, I-0001).
//
// A stall alarm: { type: "stall", key, time, phase, since, source, hours, threshold, unsettled, by, onStall, action }.
// `since` is the time of the last recorded phase activity, so one idle period is one alarm: its key is the phase and
// `since`, and a tick that finds the key recorded writes nothing.
import { readFileSync } from "node:fs";
import { DEFAULT_LAYOUT, indexOfTree } from "../records-check.mjs";
import { appendJsonLines, commitRecords } from "./records-commit.mjs";

export const ALARMS = "metrics/alarms.jsonl";
export const stallKey = (phase, since) => `stall:${phase}:${since}`;

/** Alarm lines from the text of the ledger. A malformed line is an error, never skipped. */
export function parseAlarms(text, source = ALARMS) {
  return text.split("\n").filter(Boolean).map((line, i) => {
    let row;
    try { row = JSON.parse(line); } catch (e) { throw new Error(`${source}:${i + 1}: not JSON (${e.message})`); }
    if (!row || typeof row.type !== "string" || typeof row.key !== "string" || typeof row.time !== "string")
      throw new Error(`${source}:${i + 1}: an alarm needs type, key and time`);
    return row;
  });
}

/** The stall alarm of this idle period, if one was recorded. */
export const currentStall = (rows, phase, since) => rows.findLast(r => r.type === "stall" && r.key === stallKey(phase, since)) ?? null;

/**
 * Commit one alarm unless its key is already recorded. The index is regenerated in the same commit when the repository
 * keeps one and the new tree changes it (only the ledger's first line does). Returns { recorded, commit }.
 */
export function recordAlarm(records, alarm) {
  const layoutText = readFileSync(DEFAULT_LAYOUT, "utf8");
  const { commit, value } = commitRecords(records, ({ files, read, add, tree }) => {
    const old = read(ALARMS);
    if (parseAlarms(old).some(row => row.key === alarm.key)) return { value: false };
    add(ALARMS, appendJsonLines(old, [alarm]));
    if (files.has("INDEX.md")) {
      const index = indexOfTree(records, tree(), { layoutText });
      if (index !== read("INDEX.md")) add("INDEX.md", index);
    }
    return { message: `alarm: ${alarm.type} ${alarm.key}`, value: true };
  });
  return { recorded: value, commit };
}
