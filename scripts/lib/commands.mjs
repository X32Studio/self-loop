// The commands the driver and the gates print for the lead to run, built one way: shell-quoted words, the scripts by
// absolute path, a placeholder that stops the shell when the lead has not set it, and a fresh evidence prefix per gate run.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scripts = dirname(dirname(fileURLToPath(import.meta.url)));

/** One shell word. */
export const shell = value => {
  const text = String(value);
  return /^[\w@%+=:,./-]+$/.test(text) ? text : "'" + text.replaceAll("'", "'\"'\"'") + "'";
};
export const command = (...args) => args.map(shell).join(" ");
/** `node <scripts>/<script> args…` */
export const node = (script, ...args) => command("node", join(scripts, script), ...args);
/** A placeholder the shell refuses to expand until the lead sets it. */
export const env = (name, reason) => '"${' + name + ':?' + reason + '}"';

/**
 * A fresh evidence prefix `<records>/evidence/<dir>/<gate>-<sha12>-<n>` for one gate run: the first `n` for which
 * nothing exists in the records folder at the prefix itself (a folder), with `.json` or with `.log.gz`, and no such path
 * is in `taken` (paths committed at the revision read). `dir` is the round's four digits, or a folder such as `blueprint`.
 */
export function evidencePrefix(records, dir, gate, sha, taken = new Set()) {
  const prefix = join("evidence", typeof dir === "number" ? String(dir).padStart(4, "0") : dir, `${gate}-${sha.slice(0, 12)}`);
  const used = path => existsSync(join(records, path)) || taken.has(path);
  const usedFolder = path => existsSync(join(records, path)) || [...taken].some(p => p.startsWith(`${path}/`));
  let n = 1;
  while (used(`${prefix}-${n}.json`) || used(`${prefix}-${n}.log.gz`) || usedFolder(`${prefix}-${n}`)) n++;
  return join(records, `${prefix}-${n}`);
}

/**
 * The command that reads CI for one commit: `ci-green.mjs` reading the checks where a push to `remote` of `repo` goes,
 * over `require` (every required check; a placeholder when none is set), saving the receipt to `<out>.json` when `out`
 * is given.
 */
export const gatherCommand = ({ repo, remote, sha, require, out }) =>
  node("ci-green.mjs", "--repo", repo, "--remote", remote, "--sha", sha) + (out ? " --out " + shell(out) : "")
  + " --require " + (require?.length ? shell(require.join(",")) : env("REQUIRED_CHECKS", "set the required app/name list"));
