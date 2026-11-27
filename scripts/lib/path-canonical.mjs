// P-0003, F-0009, D-0052, R-0032-reviewer-architecture
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const isGitDir = dir => existsSync(join(dir, "HEAD")) && (existsSync(join(dir, "objects")) || existsSync(join(dir, "commondir")));

export function canonical(path) {
  let head = resolve(path);
  const rest = [];
  for (;;) {
    try { return join(realpathSync(head), ...rest); } catch {}
    const parent = dirname(head);
    if (parent === head) return resolve(path);
    rest.unshift(basename(head));
    head = parent;
  }
}

export function commonGitDir(path) {
  for (let dir = resolve(path); ; dir = dirname(dir)) {
    const dotgit = join(dir, ".git");
    if (existsSync(dotgit)) {
      if (statSync(dotgit).isDirectory()) {
        if (isGitDir(dotgit)) return { top: dir, common: dotgit };
      } else {
        const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotgit, "utf8"));
        if (!m) return null;
        const gitdir = resolve(dir, m[1].trim());
        const commondir = join(gitdir, "commondir");
        if (isGitDir(gitdir)) return { top: dir, common: existsSync(commondir) ? resolve(gitdir, readFileSync(commondir, "utf8").trim()) : gitdir };
      }
    }
    if (dirname(dir) === dir) return null;
  }
}
