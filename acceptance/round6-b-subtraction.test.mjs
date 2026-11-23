import assert from "node:assert/strict";
import { chmodSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { has, jsonOutput, put, status, writeGh } from "./fixture.mjs";
import { append, argsFor, edit, greenCheck, next, phase, prepare, record, round6B } from "./round6-b-fixture.mjs";

const convergence = "The recorded convergence checks are satisfied";
const blocked = "convergence conditions not met";
const legacy = "src/legacy.mjs";
const code = 'export const endpoint = "https://example.test/";\n';

function convergedPhase(w, { oldComments = true } = {}) {
  const p = phase(w, "work", {
    agents: { judge: { runner: "claude", model: "fixture-claude" } },
    files: {
      [legacy]: (oldComments ? "// The old endpoint shipped before the new policy.\n/* The caller uses the shared resource. */\n" : "") + code,
      "smoke.test.mjs": 'import test from "node:test";\ntest("smoke", () => {});\n',
    },
  });
  chmodSync(put(w.bin, "claude", `#!/usr/bin/env node
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");
const target = join(process.env.SELF_LOOP_WORKSPACE, "out");
writeFileSync(join(target, "report.md"), "VERDICT: CONVERGED\\nACCEPTANCE: pass\\n");
writeFileSync(join(target, "public.md"), "The review is complete.\\n");
`), 0o755);
  const actor = prepare(w, p, "actor");
  edit(actor, { "src/result.mjs": "export const answer = 42;\n// F-0003\n" });
  const judged = jsonOutput(record(w, p, actor)).product.commit;
  writeGh(w, { [judged]: [greenCheck] });
  jsonOutput(w.run("call.mjs", argsFor(w, p, "judge", { base: judged })));
  append(w, p, judged, { round: 2, verdict: "CONVERGED", suite: "1/0" });
  status(w.run("blueprint.mjs", ["set", "--records", p.records, "--feature", "F-0003",
    "--status", "done", "--round", "R-0002-judge", "--by", "lead", "--note", "Judge verified the feature."]), 0);
  status(w.run("suite-green.mjs", ["--repo", p.product, "--sha", judged,
    "--command", "node --test smoke.test.mjs", "--out", join(p.records, "evidence/0002/suite")]), 0);
  w.git(p.records, "add", "-A");
  status(w.run("records-check.mjs", ["--repo", p.records, "--write"]), 0);
  w.commit(p.records, "File the green suite receipt");
  return p;
}

function subtraction(w, p) {
  return jsonOutput(w.run("call.mjs", argsFor(w, p, "reviewer", { round: 3, step: "reviewer-subtraction" })));
}

function showsCount(text, total) {
  const lines = text.split("\n").filter(line => /prose.*comment|comment.*prose/i.test(line));
  assert.ok(lines.some(line => new RegExp(`\\b${total}\\b`).test(line)), text);
}

test("R6-B3-09 next counts prose at the recorded SHA without blocking pre-subtraction convergence", t => {
  const w = round6B(t);
  const p = convergedPhase(w);
  put(p.product, legacy, "// A local draft has a different comment count.\n" + code);
  const text = next(w, p);
  has(text, convergence);
  assert.ok(!text.includes(blocked), text);
  showsCount(text, 2);
});

test("R6-B3-10 the phase's recorded subtraction hand-off makes legacy prose block convergence", t => {
  const w = round6B(t);
  const p = convergedPhase(w);
  has(next(w, p), convergence);
  assert.equal(subtraction(w, p).step, "reviewer-subtraction");
  const text = next(w, p);
  has(text, blocked);
  assert.ok(!text.includes(convergence), text);
  showsCount(text, 2);
});

test("R6-B3-11 the subtraction hand-off allows convergence when only pointers and source strings remain", t => {
  const w = round6B(t);
  const p = convergedPhase(w, { oldComments: false });
  subtraction(w, p);
  has(next(w, p), convergence);
});
