// Rule data of the next-step driver and the heartbeat, defined once (design/self-loop-v1 §2.6). A product overrides the
// stall threshold in loop.json (`tick.stallHours`); a command overrides it with `--hours`.

/** Hours without recorded phase activity before a product with unfinished features counts as stalled. Longer than the
 * longest single role call recorded so far (a call's work is recorded only at its hand-off), shorter than a day, so a
 * product left alone over a working day alarms the same day. */
export const STALL_HOURS = 12;

/** The stall threshold of a product: `--hours`, else loop.json `tick.stallHours`, else `STALL_HOURS`. */
export const stallThreshold = (settings, hours = null) => hours ?? settings?.stallHours ?? STALL_HOURS;

/** Minutes between two heartbeat runs of `tick`. */
export const HEARTBEAT_MINUTES = 60;

/** Folders `tick` and `start` read under one registry root when they search for records repositories nobody registered.
 * The search has no depth limit (a records repository is found wherever it sits under a root); this bound only stops a
 * root that is far larger than a projects folder (e.g. a few thousand folders under `~/projects`),
 * and reaching it is reported, never silent. */
export const ROOT_SCAN_FOLDERS = 50_000;

/** What `tick` does on a stall (loop.json `tick.onStall`). `resume` needs an installed `run-lead` capability (D-0003). */
export const ON_STALL = ["show", "resume"];

// D-0025, D-0027, D-0029, design/driver.md#host-load
export const MAX_LOAD_RATIO = 0.7;
export const MIN_AVAILABLE_MEMORY_GB = 16;
export const MIN_AVAILABLE_MEMORY_SHARE = 0.25;
