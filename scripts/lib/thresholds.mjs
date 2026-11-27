// D-0003, D-0010, D-0016, D-0025, D-0027, D-0029, D-0069, F-0015, design/driver.md#host-load
export const STALL_HOURS = 12;

export const stallThreshold = (settings, hours = null) => hours ?? settings?.stallHours ?? STALL_HOURS;

export const HEARTBEAT_MINUTES = 60;

export const ROOT_SCAN_FOLDERS = 50_000;

export const ON_STALL = ["show", "resume"];

export const MAX_LOAD_RATIO = 0.7;
export const MIN_AVAILABLE_MEMORY_GB = 16;
export const MIN_AVAILABLE_MEMORY_SHARE = 0.25;

export const MAX_LIVE_EVIDENCE_FILES = 1500;
export const MAX_LIVE_EVIDENCE_BYTES = 50 * 1024 * 1024;
export const MAX_STALE_WORKSPACES = 10;
export const MAX_FAST_PROSE_FILES = 2000;
export const MAX_FAST_PROSE_MS = 1500;
