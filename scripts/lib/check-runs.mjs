// The CI gate's rule over the check runs of one commit in one repository, defined once. `ci-green.mjs`, the protected
// push and the closing writers (lib/ci-receipt.mjs) apply it to the runs they read from the push destination's forge
// (GitHub check runs or AWS CodeBuild builds via lib/ci.mjs).
//
// - A required check is `app/name` (e.g. `github-actions/verify` or `codebuild/my-project`): only that source counts.
// - Among the runs of one app and name the latest wins: the highest check-run id (ids only grow), or, without ids, the
//   latest `started_at`, a run not started yet (queued) being the latest of all. So a re-run replaces an earlier result,
//   a re-run that failed is a failure, and a queued re-run is pending, never the earlier success. On a tie the run that
//   is not a success counts.
// Pure: no process, no file.

/** The CI words a reading can carry; `success` exactly when every required check passed. */
export const CI_WORDS = ["success", "failure", "pending", "unknown", "absent"];

/** "github-actions/verify" or "codebuild/my-project" -> { app, name }. A bare name is refused: the source must be stated. */
export function parseRequired(spec) {
  const i = typeof spec === "string" ? spec.indexOf("/") : -1;
  if (i <= 0 || i === spec.length - 1) throw new Error(`required check "${spec}" must be app/name (e.g. github-actions/verify or codebuild/my-project)`);
  return { app: spec.slice(0, i), name: spec.slice(i + 1) };
}

const NOT_STARTED = "￿";
/** Whether run `a` is later than run `b`. */
function later(a, b) {
  if (Number.isInteger(a.id) && Number.isInteger(b.id)) return a.id > b.id;
  return (a.started_at ?? NOT_STARTED) > (b.started_at ?? NOT_STARTED);
}

/** The run that counts for one app and name: the latest; on a tie, the one that is not a success. */
export function latestRun(runs, app, name) {
  let best = null;
  for (const run of runs) {
    if (run.app !== app || run.name !== name) continue;
    if (!best || later(run, best)) best = run;
    else if (!later(best, run) && best.conclusion === "success" && run.conclusion !== "success") best = run;
  }
  return best;
}

/**
 * The verdict of the required checks on one commit, decided by structured fields only.
 * @param runs check runs, each { id?, app, name, status, conclusion, started_at }; null when they could not be read
 * @returns {{ ok: boolean, missing: string[], conclusions: Record<string,string>, runs: Record<string,object>|null }}
 *   `runs` holds the run that decided each check that ran (null when the runs could not be read)
 */
export function requiredChecks(runs, required, sha = "") {
  const missing = [];
  const conclusions = {};
  const decided = runs === null ? null : {};
  for (const spec of required) {
    const { app, name } = parseRequired(spec);
    if (runs === null) { missing.push(`${spec}: check runs could not be read`); conclusions[spec] = "unknown"; continue; }
    const run = latestRun(runs, app, name);
    if (!run) { missing.push(`${spec}: never ran${sha ? ` on ${sha.slice(0, 7)}` : ""}`); conclusions[spec] = "absent"; continue; }
    decided[spec] = run;
    conclusions[spec] = run.status === "completed" ? run.conclusion ?? "none" : run.status ?? "unknown";
    if (run.status !== "completed" || run.conclusion !== "success") missing.push(`${spec}: ${run.status}/${run.conclusion ?? "-"}`);
  }
  return { ok: required.length > 0 && missing.length === 0, missing, conclusions, runs: decided };
}

/** One word: success | failure | pending | unknown | absent. */
export function ciWord(verdict) {
  if (verdict.ok) return "success";
  const values = Object.values(verdict.conclusions);
  if (values.some(v => ["failure", "cancelled", "timed_out", "action_required", "startup_failure", "stale", "neutral", "skipped", "none"].includes(v))) return "failure";
  if (values.some(v => ["queued", "in_progress", "pending", "waiting", "requested"].includes(v))) return "pending";
  if (values.some(v => v === "unknown")) return "unknown";
  return "absent";
}
