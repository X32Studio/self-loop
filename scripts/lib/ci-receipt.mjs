// Where a closing write reads CI, the one reading it makes, and the receipt that keeps it (D-0015 item 1).
//
// The loop is never told: it is the records repository that holds the ledger being written (the Git repository of the
// ledger's real path, symlinks resolved, when the ledger is that repository's own file), and that repository's
// loop.json names the product, `gates.remote` (default `origin`) and `gates.require`. No flag, configuration file,
// environment variable or working directory names another, so one loop's CI cannot reach another loop's ledger.
// The reading is the CI gate's own (lib/ci.mjs `ciGreen`: the checks of one exact commit where a push to
// `gates.remote` goes, the latest run of each required check deciding), made once at the moment of writing and saved
// as `evidence/<round, 4 digits>/ci-<sha12>-<n>/receipt.json` in those records; what rests on it names that path. A
// reading that cannot be made is a receipt with the word `unknown` and its cause, never a success.
import "./unbind-git.mjs";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { ciGreen } from "./ci.mjs";
import { evidencePrefix, gatherCommand } from "./commands.mjs";

/** The push remote and required checks a loop configures (loop.json `gates`); `require` is null when none is set. */
export function gatesOf(cfg) {
  const { remote = "origin", require } = cfg?.gates ?? {};
  const listed = Array.isArray(require) ? require : typeof require === "string" ? require.split(",") : [];
  const checks = listed.map(spec => String(spec).trim()).filter(Boolean);
  return { remote, require: checks.length ? checks : null };
}

/**
 * The loop a records folder holds: its loop.json's product (resolved from that folder), phase, push remote and required
 * checks; null when it holds no loop.json. Throws when the loop.json cannot be read or names no product.
 */
export function recordsLoop(records) {
  const config = join(records, "loop.json");
  if (!existsSync(config)) return null;
  let cfg;
  try { cfg = JSON.parse(readFileSync(config, "utf8")); } catch (e) { throw new Error(`${config}: ${e.message}`); }
  if (cfg === null || typeof cfg !== "object" || typeof cfg.product !== "string" || !cfg.product.trim())
    throw new Error(`${config} names no product, so no push destination to read CI in`);
  return {
    config,
    product: resolve(records, cfg.product),
    phase: cfg.phase,
    branch: typeof cfg.branch === "string" && cfg.branch.trim() ? cfg.branch.trim() : null,
    ...(Object.hasOwn(cfg, "ssot") ? { ssot: cfg.ssot } : {}),
    ...gatesOf(cfg),
  };
}

// The operating system's real path: symlinks resolved and, on a case-insensitive file system, the case on disk, as Git
// reports a repository's top (Node's default realpath keeps the caller's case).
const real = realpathSync.native;

/** The real path of `file`; a link to nothing is refused (where it writes cannot be told). */
function realFile(file) {
  try { return real(file); } catch { /* not there yet */ }
  if (lstatSync(file, { throwIfNoEntry: false })) throw new Error(`${file} is a link to nothing`);
  return join(real(dirname(resolve(file))), basename(file));
}

/**
 * The records repository that holds a ledger, from the ledger's real path alone: the Git repository containing it, when
 * the file is that repository's `ledger` (a records path such as metrics/trajectory.jsonl); otherwise null. `path` is
 * the real path, where the row is written.
 */
export function ledgerRecords(file, ledger) {
  const path = realFile(file);
  let top = null;
  try {
    top = real(execFileSync("git", ["-C", dirname(path), "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim());
  } catch { /* not in a Git repository */ }
  return { path, records: top && path === join(top, ...ledger.split("/")) ? top : null };
}

/** One reading of the loop's CI on `sha`: the CI gate's receipt, or `{ sha, ci: "unknown", ok: false, error }`. */
export function readCi(loop, sha) {
  try { return ciGreen({ repo: loop.product, remote: loop.remote, sha, require: loop.require }); }
  catch (e) { return { forge: null, host: null, repository: null, sha, ci: "unknown", ok: false, error: e.message }; }
}

/** Why a reading is not green, in words: its error, or each required check that did not pass. */
export const readingCause = reading => reading.error ?? reading.missing?.join("; ") ?? reading.ci;

const readCommand = (loop, sha) => gatherCommand({ repo: loop.product, remote: loop.remote, sha, require: loop.require });

/** design/version-tip.md#the-one-reading-and-the-receipt-that-keeps-it (item 4) */
export const notGreen = (what, loop, sha, reading) => `${what} needs CI success on ${sha}; it is ${reading.ci}` + (reading.ci === "unknown"
  ? `: the CI could not be read (${readingCause(reading)}); read it with: ${readCommand(loop, sha)}`
  : ` (${readingCause(reading)})`);

/**
 * Save a reading in `records` as `evidence/<round>/ci-<sha12>-<n>/receipt.json` (`n`: the first free one; a folder is
 * claimed atomically, so concurrent writers never share one) and return its records path.
 */
export function saveReceipt(records, round, reading) {
  for (;;) {
    const folder = evidencePrefix(records, round, "ci", reading.sha);
    mkdirSync(dirname(folder), { recursive: true });
    try { mkdirSync(folder); } catch (e) { if (e.code === "EEXIST") continue; throw e; }
    const path = join(folder, "receipt.json");
    writeFileSync(path, `${JSON.stringify(reading, null, 2)}\n`, { flag: "wx" });
    return relative(records, path).split(sep).join("/");
  }
}

/**
 * Offline (records only): why a CONVERGED trajectory row that names a receipt (`ciReceipt`) does not rest on a green
 * reading of the SHA it pushed (its tip, else its commit); null when it does. `read(path)` gives a records file's text,
 * or null when the records do not hold it.
 */
export function rowReceiptProblem(row, read) {
  const sha = row.tip ?? row.commit;
  const text = read(row.ciReceipt);
  if (text === null) return `round ${row.round} names ${row.ciReceipt}, which the records do not hold`;
  let receipt;
  try { receipt = JSON.parse(text); } catch { return `round ${row.round}: ${row.ciReceipt} is not a readable CI receipt`; }
  if (receipt?.sha !== sha || receipt.ci !== "success" || receipt.ok !== true)
    return `round ${row.round} is CONVERGED on ${sha}, but ${row.ciReceipt} is not a green reading of it (${receipt?.ci} for ${receipt?.sha})`;
  return null;
}
