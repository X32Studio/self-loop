// D-0009 item 2: `VERSION` is the lead's file. A round's pushed tip stands for a ruling on an earlier SHA when
// `git diff --name-only <ruled>..<tip>` is exactly `VERSION` and the tip follows the ruled SHA through commits of one
// parent each (the lead's VERSION commits; a merge would bring in history the judge never saw). The code the CI tests on
// the tip is then the code the judge ruled on. One rule for the round close (`trajectory.mjs append --tip`), the
// protected-branch push (`lib/ci.mjs`) and `next`.
import { spawnSync } from "node:child_process";
import { ORIGINAL_OBJECTS } from "./ci.mjs";

/** Paths a lead commit may change between a ruling and the pushed tip. */
export const LEAD_TIP_PATHS = ["VERSION"];

// design/version-tip.md#the-tree-git-publishes
const git = (repo, ...argv) => spawnSync("git", ["-C", repo, ORIGINAL_OBJECTS, ...argv], { encoding: "utf8", maxBuffer: 1 << 26 });
const commitOf = (repo, rev) => {
  const r = git(repo, "rev-parse", "--verify", "--quiet", `${rev}^{commit}`);
  return r.status === 0 ? r.stdout.trim() : null;
};

/** Why `tip` does not stand for a ruling on `ruled` in `repo`; null when it does (the same commit included). */
export function tipProblem(repo, ruled, tip) {
  const from = commitOf(repo, ruled), to = commitOf(repo, tip);
  if (!from) return `${ruled} is not a commit in ${repo}`;
  if (!to) return `${tip} is not a commit in ${repo}`;
  if (from === to) return null;
  if (git(repo, "merge-base", "--is-ancestor", from, to).status !== 0)
    return `${to.slice(0, 7)} does not follow the ruled commit ${from.slice(0, 7)}`;
  const merges = git(repo, "rev-list", "--min-parents=2", `${from}..${to}`).stdout.split("\n").filter(Boolean);
  if (merges.length) return `${to.slice(0, 7)} follows the ruled commit ${from.slice(0, 7)} through merge ${merges[0].slice(0, 7)}; only commits of ${LEAD_TIP_PATHS.join(", ")} may follow a ruling`;
  const diff = git(repo, "diff", "--no-renames", "--name-only", "-z", from, to);
  if (diff.status !== 0) throw new Error(`git diff ${from} ${to}: ${diff.stderr}`);
  const changed = diff.stdout.split("\0").filter(Boolean);
  const others = changed.filter(path => !LEAD_TIP_PATHS.includes(path));
  if (!others.length && changed.length === LEAD_TIP_PATHS.length) return null;
  if (!others.length) return `${to.slice(0, 7)} changes no file after the ruled commit ${from.slice(0, 7)}; a tip after a ruling changes exactly ${LEAD_TIP_PATHS.join(", ")}`;
  const shown = others.slice(0, 5).join(", ") + (others.length > 5 ? `, and ${others.length - 5} more` : "");
  return `${to.slice(0, 7)} changes ${shown} after the ruled commit ${from.slice(0, 7)}; only ${LEAD_TIP_PATHS.join(", ")} may change`;
}

/** Whether a ruling on `ruled` covers `tip`. */
export const tipCovers = (repo, ruled, tip) => tipProblem(repo, ruled, tip) === null;
