// Shared byte-safe Git ignore and .git/info/exclude management (P4: single path for hooks and in-repo records).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { commonGitDir } from "../lead-guard.mjs";

/** Canonical working-tree root of the Git repository containing `dir`, or null. */
export function gitTopLevel(dir) {
  const r = spawnSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (r.status !== 0) return null;
  const top = r.stdout.trim();
  if (!top) return null;
  try { return realpathSync(top); } catch { return resolve(top); }
}

/** Split a Buffer into raw and line-ending-stripped slices without decoding UTF-8. */
export function splitIgnoreLines(buf) {
  const lines = [];
  for (let start = 0; start < buf.length; ) {
    const nl = buf.indexOf(0x0a, start);
    const end = nl === -1 ? buf.length : nl + 1;
    let contentEnd = nl === -1 ? end : nl;
    if (contentEnd > start && buf[contentEnd - 1] === 0x0d) contentEnd--;
    lines.push({ raw: buf.subarray(start, end), content: buf.subarray(start, contentEnd) });
    start = end;
  }
  return lines;
}

/** Check whether a path inside a Git working tree is already ignored (works before creation). */
export function isGitIgnored(repoTop, relPosix, { directory = false } = {}) {
  const probe = directory ? `./${relPosix}/` : `./${relPosix}`;
  const check = spawnSync("git", ["-C", repoTop, "check-ignore", "-q", "--no-index", "--", probe], { encoding: "utf8" });
  return check.status === 0;
}

/** Fail-closed check whether a path (or any descendant) is tracked or staged in the Git index. */
export function isPathTracked(repoTop, relPosix) {
  const git = (...argv) => spawnSync("git", ["-C", repoTop, ...argv], { encoding: "utf8" });
  const failed = r => (r.error?.message ?? r.stderr ?? "").trim() || `exit ${r.status}`;
  const listed = git("ls-files", "-z", "--cached", "--", `:(literal,icase)${relPosix}`);
  if (listed.status !== 0) return { tracked: false, files: [], error: `Git could not inspect tracked files for ${relPosix}: ${failed(listed)}` };
  const entries = listed.stdout.split("\0").filter(Boolean);
  const exact = entries.filter(e => e === relPosix || e.startsWith(`${relPosix}/`));
  if (exact.length) return { tracked: true, files: exact, error: null };
  if (entries.length) {
    const ic = git("config", "--type=bool", "--get", "core.ignorecase");
    if (ic.error) return { tracked: false, files: [], error: `Git could not read core.ignorecase: ${failed(ic)}` };
    if (ic.stdout?.trim() === "true") return { tracked: true, files: entries, error: null };
  }
  return { tracked: false, files: [], error: null };
}

/** Resolve Git ignore/exclude metadata for a file or directory inside a Git working tree. */
export function gitIgnoreTarget(file, { repo = null, directory = false } = {}) {
  const found = repo ?? commonGitDir(directory ? resolve(file) : dirname(file));
  if (!found) return null;
  const rel = relative(found.top, resolve(file)).split(sep).join("/");
  if (!rel || rel.startsWith("..")) return null;
  const pattern = directory ? `/${rel}/` : `/${rel}`;
  return {
    repo: found,
    rel,
    pattern,
    ignored: isGitIgnored(found.top, rel, { directory }),
    excludeFile: join(found.common, "info", "exclude"),
  };
}

function findManagedExcludePair(lines, marker, patternBuf) {
  const markerBuf = Buffer.from(marker, "utf8");
  const markerNoNlBuf = Buffer.from(`${marker} (no-trailing-nl)`, "utf8");
  for (let i = 0; i < lines.length - 1; i++) {
    const isNl = lines[i].content.equals(markerBuf);
    const isNoNl = !isNl && lines[i].content.equals(markerNoNlBuf);
    if ((isNl || isNoNl) && lines[i + 1].content.equals(patternBuf)) return { index: i, noNl: isNoNl };
  }
  return null;
}

/** Idempotently append a managed marker+pattern block to .git/info/exclude, preserving raw bytes. */
export function ensureExcludeEntry(info, { marker }) {
  if (!info || info.ignored) return { changed: false, excludeFile: info?.excludeFile ?? null, pattern: info?.pattern ?? null };
  mkdirSync(dirname(info.excludeFile), { recursive: true });
  const existing = existsSync(info.excludeFile) ? readFileSync(info.excludeFile) : Buffer.alloc(0);
  const patternBuf = Buffer.from(info.pattern, "utf8");
  if (findManagedExcludePair(splitIgnoreLines(existing), marker, patternBuf)) {
    return { changed: false, excludeFile: info.excludeFile, pattern: info.pattern };
  }
  const noNl = existing.length > 0 && existing[existing.length - 1] !== 0x0a;
  const block = Buffer.from(
    noNl ? `\n${marker} (no-trailing-nl)\n${info.pattern}\n` : `${marker}\n${info.pattern}\n`,
    "utf8",
  );
  writeFileSync(info.excludeFile, Buffer.concat([existing, block]));
  return { changed: true, excludeFile: info.excludeFile, pattern: info.pattern };
}

/** Remove a managed marker+pattern block from .git/info/exclude, restoring prior trailing-newline state byte-for-byte. */
export function removeExcludeEntry(info, { marker }) {
  if (!info || !existsSync(info.excludeFile)) return { changed: false, excludeFile: info?.excludeFile ?? null };
  const existing = readFileSync(info.excludeFile);
  const lines = splitIgnoreLines(existing);
  const match = findManagedExcludePair(lines, marker, Buffer.from(info.pattern, "utf8"));
  if (!match) return { changed: false, excludeFile: info.excludeFile };
  const before = lines.slice(0, match.index).map(l => l.raw);
  const after = lines.slice(match.index + 2).map(l => l.raw);
  if (match.noNl && after.length === 0 && before.length > 0) {
    const prev = before[before.length - 1];
    if (prev.length > 0 && prev[prev.length - 1] === 0x0a) before[before.length - 1] = prev.subarray(0, prev.length - 1);
  }
  writeFileSync(info.excludeFile, Buffer.concat([...before, ...after]));
  return { changed: true, excludeFile: info.excludeFile };
}

/** Idempotently append a relative path rule to <repoTop>/.gitignore while preserving existing bytes verbatim. */
export function ensureGitignoreEntry(repoTop, relPosix, { directory = true } = {}) {
  const file = join(repoTop, ".gitignore");
  const pattern = directory ? `${relPosix}/` : relPosix;
  const existing = existsSync(file) ? readFileSync(file) : Buffer.alloc(0);
  const equivalent = directory
    ? [pattern, `/${pattern}`, relPosix, `/${relPosix}`]
    : [pattern, `/${pattern}`];
  const equivBufs = equivalent.map(p => Buffer.from(p, "utf8"));
  const negBufs = equivalent.map(p => Buffer.from(`!${p}`, "utf8"));
  const lines = splitIgnoreLines(existing);
  if (lines.some(line => negBufs.some(buf => line.content.equals(buf)))
    || lines.some(line => equivBufs.some(buf => line.content.equals(buf)))) {
    return { changed: false, file, pattern };
  }
  const prefix = existing.length > 0 && existing[existing.length - 1] !== 0x0a ? "\n" : "";
  const append = Buffer.from(`${prefix}${pattern}\n`, "utf8");
  writeFileSync(file, Buffer.concat([existing, append]));
  return { changed: true, file, pattern };
}
