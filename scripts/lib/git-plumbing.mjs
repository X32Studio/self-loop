// Git plumbing shared by the call: commands that fail loudly, regular files of a tree, blob contents in one batch.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function run(cmd, argv, opts = {}) {
  const r = spawnSync(cmd, argv, { maxBuffer: 1 << 30, ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${argv.join(" ")}: ${r.stderr?.toString() || `exit ${r.status}`}`);
  return r.stdout;
}
export const git = (repo, ...argv) => run("git", ["-C", repo, ...argv], { encoding: "utf8" }).trim();
export const gitOk = (repo, ...argv) => spawnSync("git", ["-C", repo, ...argv], { stdio: "ignore" }).status === 0;

/** Regular files of a commit or tree: [{ path, sha }]. Symlinks and submodules are never listed. */
export function regularFiles(repo, treeish) {
  const out = run("git", ["-C", repo, "ls-tree", "-r", "-z", "--full-tree", treeish], { encoding: "utf8" });
  return out.split("\0").filter(Boolean).map(entry => {
    const [meta, path] = entry.split("\t");
    const [mode, type, sha] = meta.split(" ");
    return { path, sha, regular: type === "blob" && (mode === "100644" || mode === "100755") };
  }).filter(e => e.regular).map(({ path, sha }) => ({ path, sha }));
}

/** The contents of blobs, by `git cat-file --batch`. */
export function blobs(repo, shas) {
  if (!shas.length) return [];
  const out = run("git", ["-C", repo, "cat-file", "--batch"], { input: `${shas.join("\n")}\n` });
  const result = [];
  let at = 0;
  for (let i = 0; i < shas.length; i++) {
    const nl = out.indexOf(10, at);
    const [, , size] = out.subarray(at, nl).toString().split(" ");
    const start = nl + 1;
    result.push(out.subarray(start, start + Number(size)));
    at = start + Number(size) + 1;
  }
  return result;
}

export function writeFiles(into, entries, contents) {
  entries.forEach((e, i) => {
    mkdirSync(dirname(join(into, e.path)), { recursive: true });
    writeFileSync(join(into, e.path), contents[i]);
  });
}
