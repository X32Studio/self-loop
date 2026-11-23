import assert from "node:assert/strict";
import test from "node:test";
import { closingScenario, closingWorld, noBytes } from "./closing-fixture.mjs";
import { has, output, status, world } from "./fixture.mjs";

function declineCopied(release, copied, diagnostic) {
  const before = release.readQueries().length;
  const result = release.suggested(copied);
  status(result, 2);
  has(output(result), diagnostic);
  assert.deepEqual(release.readTrajectory(), noBytes);
  release.assertReading(before);
}

test("RULE-13 the printed append checks the push destination even with a green upstream receipt", t => {
  const spec = closingScenario();
  const release = closingWorld(world(t), spec);
  release.setRuns(spec.failedRerun);
  release.record("ci-upstream", { remote: "upstream" });
  declineCopied(release, release.next(), spec.failedCheck);
});

test("RULE-14 a partial green receipt cannot replace the complete live check set", t => {
  const spec = closingScenario();
  const release = closingWorld(world(t), spec);
  release.record("ci-subset", { checks: spec.requires.slice(1) });
  release.setRuns(spec.initial.slice(1));
  const copied = release.next();
  declineCopied(release, copied, spec.requires[0]);
  release.setRuns(spec.initial);
  const before = release.readQueries().length;
  status(release.suggested(copied), 0);
  release.row();
  release.assertReading(before);
});

test("RULE-15 a non-default push remote closes with the checks in either order", t => {
  const spec = closingScenario({ releaseRemote: true });
  const release = closingWorld(world(t), { ...spec, requires: spec.requires.toReversed() });
  release.setRuns(spec.initial);
  const first = release.readQueries().length;
  status(release.append(), 0);
  release.row();
  release.assertReading(first);
  release.setRuns(spec.initial.toReversed());
  const second = release.readQueries().length;
  status(release.append({ round: 2 }), 0);
  release.row({ round: 2 });
  release.assertReading(second);
});

function failedRerun(t, names) {
  const spec = closingScenario();
  const release = closingWorld(world(t), spec);
  release.record(names[0]);
  const copied = release.next();
  release.setRuns(spec.failedRerun);
  release.record(names[1], { exit: 2 });
  declineCopied(release, copied, spec.failedCheck);
}

test("RULE-16 a copied close command refuses after a recorded red rerun", t => {
  failedRerun(t, ["ci-1", "ci-2"]);
});

test("RULE-17 a successful rerun restores a previously failing close", t => {
  const spec = closingScenario();
  const release = closingWorld(world(t), spec);
  release.setRuns(spec.failedRerun);
  release.record("ci-1", { exit: 2 });
  const copied = release.next();
  declineCopied(release, copied, spec.failedCheck);
  release.setRuns(spec.successfulRerun);
  const before = release.readQueries().length;
  status(release.suggested(copied), 0);
  release.row();
  release.assertReading(before);
});

test("RULE-18 misleading evidence filenames cannot override the current CI reading", t => {
  // Two evidence files can be committed in the same second, with independently chosen prefixes.
  failedRerun(t, ["ci-check-10", "ci-check-2"]);
});
