// D-0009, F-0017, design/version-tip.md#the-tree-git-publishes
import { spawnSync } from "node:child_process";
import { firstMergeBetweenFast, hasCommitFast, isAncestorFast } from "./dag.mjs";

export const LEAD_TIP_PATHS = ["VERSION"];

const ORIGINAL_OBJECTS = "--no-replace-objects";
const git = (repo, ...argv) => spawnSync("git", ["-C", repo, ORIGINAL_OBJECTS, ...argv], { encoding: "utf8", maxBuffer: 1 << 26 });

export function tipProblem(repo, ruled, tip) {
  const from = hasCommitFast(repo, ruled), to = hasCommitFast(repo, tip);
  if (!from) return `${ruled} is not a commit in ${repo}`;
  if (!to) return `${tip} is not a commit in ${repo}`;
  if (from === to) return null;
  if (!isAncestorFast(repo, from, to))
    return `${to.slice(0, 7)} does not follow the ruled commit ${from.slice(0, 7)}`;
  const merge = firstMergeBetweenFast(repo, from, to);
  if (merge) return `${to.slice(0, 7)} follows the ruled commit ${from.slice(0, 7)} through merge ${merge.slice(0, 7)}; only commits of ${LEAD_TIP_PATHS.join(", ")} may follow a ruling`;
  const diff = git(repo, "diff", "--no-renames", "--name-only", "-z", from, to);
  if (diff.status !== 0) throw new Error(`git diff ${from} ${to}: ${diff.stderr}`);
  const changed = diff.stdout.split("\0").filter(Boolean);
  const others = changed.filter(path => !LEAD_TIP_PATHS.includes(path));
  if (!others.length && changed.length === LEAD_TIP_PATHS.length) return null;
  if (!others.length) return `${to.slice(0, 7)} changes no file after the ruled commit ${from.slice(0, 7)}; a tip after a ruling changes exactly ${LEAD_TIP_PATHS.join(", ")}`;
  const shown = others.slice(0, 5).join(", ") + (others.length > 5 ? `, and ${others.length - 5} more` : "");
  return `${to.slice(0, 7)} changes ${shown} after the ruled commit ${from.slice(0, 7)}; only ${LEAD_TIP_PATHS.join(", ")} may change`;
}

export const tipCovers = (repo, ruled, tip) => tipProblem(repo, ruled, tip) === null;
