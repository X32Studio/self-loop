import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { has, jsonOutput, output, put, readQueries, status, writeGh } from "./fixture.mjs";
import { append, batchDraw, edit, greenCheck, head, integration, loopWorld, next, phase, prepare, record } from "./loop-world-fixture.mjs";

function sourceCommit(w, p, path, value) {
  put(p.product, path, `export const value = ${value};\n`);
  return w.commit(p.product, `Implement ${path}`);
}

function point(w, p, sha) {
  w.git(p.product, "branch", "-f", integration, sha);
}

test("R6-B1-01 both next entries recover a judged SHA and its protected VERSION tip from a lagging ref", t => {
  const w = loopWorld(t);
  const p = phase(w);
  const judged = sourceCommit(w, p, "src/judged.mjs", batchDraw()(1000));
  put(p.product, "VERSION", "1.0.1\n");
  const tip = w.commit(p.product, "Bump VERSION for the candidate");
  writeGh(w, { [tip]: [greenCheck], [judged]: [greenCheck] });
  append(w, p, judged, { tip });
  w.register([p]);
  for (const entry of ["loop.mjs", "self-loop.mjs"]) {
    const before = head(w, p);
    const text = next(w, p, entry);
    assert.match(text, /lag|behind/i);
    has(text, judged);
    has(text, tip);
    assert.match(text, /merge --ff-only/);
    assert.doesNotMatch(text, /no judge ruling on/);
    assert.equal(head(w, p), before, "next is a read");
  }
});

test("R6-B1-02 a critic and actor on explicit descending SHAs advance the integration branch", t => {
  const w = loopWorld(t);
  const p = phase(w);
  const critic = prepare(w, p, "critic", { base: p.initial });
  edit(critic, { "acceptance/check.mjs": "export const check = true;\n" });
  const cases = jsonOutput(record(w, p, critic)).product.commit;
  const afterCritic = head(w, p);
  const actor = prepare(w, p, "actor", { base: cases });
  edit(actor, { "src/work.mjs": "export const work = true;\n" });
  const implementation = jsonOutput(record(w, p, actor)).product.commit;
  assert.deepEqual([afterCritic, head(w, p)], [cases, implementation]);
  assert.equal(w.git(p.product, "rev-parse", implementation + "^"), cases);
});

test("R6-B1-03 next uses the newest recorded hand-off for suite, CI and judge when the branch lags", t => {
  const w = loopWorld(t);
  const p = phase(w);
  writeGh(w, { [p.initial]: [greenCheck] });
  append(w, p, p.initial);
  const critic = prepare(w, p, "critic", { base: p.initial });
  edit(critic, { "acceptance/check.mjs": "export const check = true;\n" });
  const cases = jsonOutput(record(w, p, critic)).product.commit;
  const actor = prepare(w, p, "actor", { base: cases });
  edit(actor, { "src/work.mjs": "export const work = true;\n" });
  const implementation = jsonOutput(record(w, p, actor)).product.commit;
  w.git(p.product, "branch", "recovered-work", implementation);
  point(w, p, p.initial);
  const before = readQueries(w).length;
  const preload = put(w.dir, "measured-host.mjs", `
import os from "node:os";
import { syncBuiltinESMExports } from "node:module";
os.cpus = () => Array.from({ length: 10 }, () => ({ model: "Fixture", speed: 2400, times: {} }));
os.availableParallelism = () => 10;
os.loadavg = () => [0.25, 0.02, 0.01];
os.freemem = () => 32 * 2 ** 30;
syncBuiltinESMExports();
`);
  const text = status(w.run("self-loop.mjs", ["next", "--config", p.config], {
    extraEnv: { NODE_OPTIONS: `--import=${pathToFileURL(join(w.dir, "clock.mjs")).href} --import=${pathToFileURL(preload).href}` },
  }), 0);
  assert.deepEqual(readQueries(w).slice(before), [implementation], text);
  const commands = text.split("\n");
  has(commands.find(line => line.includes("suite-green.mjs") && line.includes("--command")) ?? "", `--sha ${implementation}`);
  has(commands.find(line => line.includes("call.mjs") && line.includes(" judge ")) ?? "", `--base ${implementation}`);
  assert.match(text, /lag|behind/i);
  assert.match(text, /merge --ff-only/);
});

test("R6-B1-04 parallel hand-offs give both heads and request a merge", t => {
  const w = loopWorld(t);
  const p = phase(w);
  writeGh(w, { [p.initial]: [greenCheck] });
  append(w, p, p.initial);
  const parallel = [
    prepare(w, p, "critic", { base: p.initial }),
    prepare(w, p, "actor", { base: p.initial }),
  ];
  edit(parallel[0], { "acceptance/check.mjs": "export const check = true;\n" });
  edit(parallel[1], { "src/work.mjs": "export const work = true;\n" });
  const firstIndex = batchDraw(7)(2);
  const first = jsonOutput(record(w, p, parallel[firstIndex])).product.commit;
  const second = jsonOutput(record(w, p, parallel[1 - firstIndex])).product.commit;
  const text = next(w, p);
  has(text, first);
  has(text, second);
  assert.match(text, /\bmerge (?:is )?(?:needed|required)\b|\bneeds? (?:a )?merge\b/i);
  assert.equal(head(w, p), first, "the second sibling cannot overwrite the first recorded commit");
});

test("R6-B1-05 a role prepared before the judged commit is recorded with a stale-base warning", t => {
  const w = loopWorld(t);
  const p = phase(w);
  const actor = prepare(w, p, "actor", { base: p.initial });
  edit(actor, { "src/in-flight.mjs": "export const work = true;\n" });
  const judged = sourceCommit(w, p, "src/judged.mjs", batchDraw()(1000));
  point(w, p, judged);
  writeGh(w, { [judged]: [greenCheck] });
  append(w, p, judged);
  const result = record(w, p, actor);
  const handoff = jsonOutput(result);
  assert.equal(handoff.product.base, p.initial);
  assert.notEqual(handoff.product.commit, p.initial);
  assert.equal(head(w, p), judged);
  assert.match(output(result), /warn|does not descend|not a descendant|stale base/i);
  assert.ok(output(result).includes(judged) || output(result).includes(judged.slice(0, 7)), output(result));
});

test("R6-B1-06 a source-changing branch ahead of the latest ruling cannot replace the recorded SHA", t => {
  const w = loopWorld(t);
  const p = phase(w);
  const unruled = sourceCommit(w, p, "src/unruled.mjs", batchDraw()(1000));
  put(p.product, "VERSION", "1.0.1\n");
  const candidate = w.commit(p.product, "Bump VERSION after the source change");
  point(w, p, candidate);
  writeGh(w, { [p.initial]: [greenCheck], [unruled]: [greenCheck], [candidate]: [greenCheck] });
  append(w, p, p.initial);
  const before = readQueries(w).length;
  const text = next(w, p);
  assert.deepEqual(readQueries(w).slice(before), [p.initial], text);
  assert.doesNotMatch(text, /no judge ruling on/);
});

test("R6-B1-07 a same-second hand-off recorded before the ruling does not advance it", t => {
  const w = loopWorld(t);
  const p = phase(w);
  const actor = prepare(w, p, "actor", { round: 2, base: p.initial });
  edit(actor, { "src/parallel.mjs": "export const parallel = true;\n" });
  const candidate = jsonOutput(record(w, p, actor)).product.commit;
  writeGh(w, { [p.initial]: [greenCheck], [candidate]: [greenCheck] });
  append(w, p, p.initial, { round: 2 });
  const before = readQueries(w).length;
  const text = next(w, p);
  assert.deepEqual(readQueries(w).slice(before), [p.initial], text);
  assert.doesNotMatch(text, /no judge ruling on/);
});

test("R6-B1-08 a diverged local branch gets a merge command for the newest judgement", t => {
  const w = loopWorld(t);
  const p = phase(w);
  const judged = sourceCommit(w, p, "src/judged.mjs", batchDraw()(1000));
  const recovery = join(w.dir, "recovery");
  w.git(p.product, "worktree", "add", "-q", "--detach", recovery, p.initial);
  put(recovery, "operator.log", "A lead saved independent recovery work.\n");
  const diverged = w.commit(recovery, "Save the recovery work");
  point(w, p, diverged);
  w.git(p.product, "worktree", "remove", recovery);
  writeGh(w, { [p.initial]: [greenCheck], [judged]: [greenCheck] });
  append(w, p, p.initial);
  append(w, p, judged, { round: 2 });
  const text = next(w, p);
  assert.match(text, /diverg/i);
  const merge = text.split("\n").find(line => /\bgit\b.*\bmerge\b/.test(line) && line.includes(judged));
  assert.ok(merge, text);
  assert.doesNotMatch(merge, /--ff-only/);
  assert.equal(head(w, p), diverged);
});
