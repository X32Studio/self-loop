// Canonical absolute path resolution: resolves existing ancestor symlinks and appends non-existent tail segments.
import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/** The canonical absolute form of a path: real folders, the not-yet-existing rest appended. */
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
