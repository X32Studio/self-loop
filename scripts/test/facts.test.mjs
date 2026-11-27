// D-0016, D-0064, D-0067
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { area, shipped, sizes } from "../facts.mjs";
import { parse } from "../trajectory.mjs";
import { fixtures, git, repo, s4History } from "./helpers.mjs";

test("shipped: a symbol present only on an unmerged branch is reported as such", () => {
  const dir = repo({ "src/access.js": "export const read = () => 1;\n" });
  git(dir, "tag", "v0.1");
  git(dir, "checkout", "-q", "-b", "test/keys");
  writeFileSync(join(dir, "src/access.js"), "export const read = () => 1;\nexport function rewriteMemberKeyLines() {}\n");
  git(dir, "commit", "-q", "-am", "rewrite member key lines");
  git(dir, "checkout", "-q", "main");
  const fact = shipped(dir, { symbol: "rewriteMemberKeyLines", path: "src/access.js" });
  assert.deepEqual(fact.containing, ["test/keys"]);
  assert.deepEqual(fact.notContaining.sort(), ["main", "v0.1"]);
  assert.deepEqual(fact.firstChangeReachableFrom, { branches: ["test/keys"], tags: [] });
  assert.equal(fact.changes, 1);
  const byPath = shipped(dir, { path: "src/access.js" });
  assert.deepEqual(byPath.containing.sort(), ["main", "test/keys", "v0.1"]);
  assert.throws(() => shipped(dir, {}), /--path or --symbol/);
});

test("shipped: the recorded S4 key-file replacement never reached rewrite, main or a tag", () => {
  const { product, commits } = s4History();
  const fact = shipped(product, { symbol: "lsof", path: "src/access.js", refs: ["refs/remotes/origin", "refs/tags"] });
  assert.equal(fact.firstChange.sha, [...commits].find(([sha]) => sha.startsWith("c6dff19"))[1]);
  assert.ok(fact.firstChangeReachableFrom.branches.includes("origin/test/s4-collab"));
  assert.deepEqual(fact.containing, []);
  assert.ok(fact.notContaining.includes("origin/rewrite") && fact.notContaining.includes("origin/main"));
  assert.ok(!fact.firstChangeReachableFrom.branches.some(b => /(^|\/)(rewrite|main)$/.test(b)), fact.firstChangeReachableFrom.branches.join());
  assert.deepEqual(fact.firstChangeReachableFrom.tags, []);
});

test("area: rounds, blockers and commits per area from the trajectory", () => {
  const rows = parse(readFileSync(join(fixtures, "s4-trajectory.tsv"), "utf8"));
  const facts = area(rows, { area: "keyfile" });
  assert.deepEqual(facts.keyfile.rounds, [27, 28, 29, 30]);
  assert.equal(facts.keyfile.opened.length, 5);
  assert.equal(facts.keyfile.closed.length, 5, "round 27 closed both round-26 blockers");
  assert.deepEqual(facts.keyfile.verdicts.slice(1), ["28:CONTINUE:ci=failure", "29:CONTINUE:ci=failure", "30:CONTINUE:ci=failure"]);
});

test("area: includes role=critic convergence and continue verdicts alongside role=judge (D-0064 T10, D-0067)", () => {
  const sha = "a".repeat(40);
  const rows = [
    { round: 1, phase: "v1", area: "gate", role: "actor", verdict: "-", opened: "-", closed: "-", owner: "0", commit: sha, ci: "-" },
    { round: 2, phase: "v1", area: "gate", role: "critic", verdict: "-", opened: "-", closed: "-", owner: "0", commit: sha, ci: "-" },
    { round: 3, phase: "v1", area: "gate", role: "critic", verdict: "CONTINUE", opened: "gate:R3-1", closed: "-", owner: "0", commit: sha, ci: "failure" },
    { round: 4, phase: "v1", area: "gate", role: "critic", verdict: "PASS", opened: "-", closed: "gate:R3-1", owner: "0", commit: sha, ci: "success" },
    { round: 5, phase: "v1", area: "gate", role: "critic", verdict: "CONVERGED", opened: "-", closed: "-", owner: "0", commit: sha, ci: "success" },
    { round: 6, phase: "v1", area: "gate", role: "judge", verdict: "CONVERGED", opened: "-", closed: "-", owner: "0", commit: sha, ci: "success" },
  ];
  const facts = area(rows, { area: "gate", phase: "v1" });
  assert.deepEqual(facts.gate.verdicts, [
    "3:CONTINUE:ci=failure",
    "4:PASS:ci=success",
    "5:CONVERGED:ci=success",
    "6:CONVERGED:ci=success",
  ]);
  assert.equal(facts.gate.roles.critic, 4);
  assert.equal(facts.gate.roles.judge, 1);
});

test("sizes: lines per path per commit, absent where the file did not exist", () => {
  const dir = repo({ "a.js": "1\n2\n" });
  const first = git(dir, "rev-parse", "HEAD");
  writeFileSync(join(dir, "a.js"), "1\n2\n3\n4\n");
  git(dir, "commit", "-q", "-am", "grow");
  const second = git(dir, "rev-parse", "HEAD");
  assert.deepEqual(sizes(dir, ["a.js", "b.js"], [first, second]), { "a.js": { [first]: 2, [second]: 4 }, "b.js": {} });
});
