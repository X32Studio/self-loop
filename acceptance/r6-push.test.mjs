import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { has, jsonOutput, output, status } from "./fixture.mjs";
import { pushWorld } from "./r6-push-fixture.mjs";

function namesBoth(result, { first, second }) {
  has(output(result), first.url);
  has(output(result), second.url);
}

function fixRoutes(message) {
  const text = message.replace(/\s+/g, " ");
  assert.match(text, /(?:separat|each|one).*remote|remote.*(?:separat|each|one)/i);
  assert.match(text, /(?:remov|drop).*push.*url|push.*url.*(?:remov|drop)/i);
}

function refusedWithoutPush(p, action, code = 2) {
  const before = p.snapshot();
  const result = action();
  assert.deepEqual(p.snapshot(), before, output(result));
  status(result, code);
  return result;
}

test("R6-A01 protected promotion refuses a green first push URL and a red mirror", t => {
  const p = pushWorld(t);
  p.addMirror();
  const result = refusedWithoutPush(p, () => p.promote());
  namesBoth(result, p);
  fixRoutes(output(result));
});

test("R6-A02 an ambiguous destination cannot make a CONVERGED row or rewrite prior bytes", t => {
  const p = pushWorld(t);
  p.addMirror();
  const before = p.readTrajectory();
  assert.ok(before.length > 0);
  const result = p.append({ round: 2 });
  assert.ok(p.readTrajectory().equals(before), "CONVERGED refusal must preserve the ledger bytes");
  status(result, 2);
  namesBoth(result, p);
});

test("R6-A03 a CONTINUE row records unknown when the push destination is ambiguous", t => {
  const p = pushWorld(t);
  p.addMirror();
  const before = p.readTrajectory();
  const result = p.append({ verdict: "CONTINUE", round: 2 });
  status(result, 0);
  const after = p.readTrajectory();
  assert.deepEqual(after.subarray(0, before.length), before);
  const added = after.subarray(before.length).toString().trimEnd().split("\n");
  assert.equal(added.length, 1);
  const row = JSON.parse(added[0]);
  assert.deepEqual([row.round, row.verdict, row.ci, row.commit, row.tip], [2, "CONTINUE", "unknown", p.ruled, p.tip]);
  namesBoth(result, p);
});

test("R6-A04 the CI diagnostic cannot certify an ambiguous destination", t => {
  const p = pushWorld(t);
  p.addMirror();
  const result = p.diagnose();
  status(result, 2);
  namesBoth(result, p);
});

test("R6-A05 next reports unreadable live CI despite a committed green reading", t => {
  const p = pushWorld(t);
  p.addMirror();
  const text = status(p.next(), 0);
  assert.match(text, /CI.*(?:not green|not read|unreadable|unknown)|(?:could not|cannot) read .*CI/i);
  has(text, p.first.url);
  has(text, p.second.url);
});

test("R6-A06 a single default push destination allows diagnostic, close and promotion", t => {
  const p = pushWorld(t, { publishedRuling: false });
  const diagnostic = jsonOutput(p.diagnose());
  assert.deepEqual([diagnostic.ci, diagnostic.repository], ["success", p.first.slug]);
  status(p.append(), 0);
  p.row();
  p.w.commit(p.records, "Record verified round");
  const [, mirrorBefore] = p.snapshot();
  status(p.promote(), 0);
  p.assertDelivered(p.first);
  assert.equal(p.snapshot()[1], mirrorBefore);
});

test("R6-A07 an explicit gates.remote wins even when origin is green", t => {
  const p = pushWorld(t, { releaseRemote: true });
  p.w.git(p.product, "remote", "set-url", "--push", "origin", p.second.url);
  p.serve(p.close.initial, p.close.successfulRerun);
  const [, mirrorBefore] = p.snapshot();
  status(p.promote(), 0);
  p.assertDelivered(p.first);
  assert.equal(p.snapshot()[1], mirrorBefore);
  assert.deepEqual(p.readQueries().at(-1), { repository: p.first.slug, sha: p.tip });
});

test("R6-A08 pushInsteadOf can select the one verified destination", t => {
  const p = pushWorld(t);
  p.w.git(p.product, "config", "--unset-all", "remote.origin.pushurl");
  const fetch = p.w.git(p.product, "remote", "get-url", "origin");
  p.w.git(p.product, "config", `url.${p.first.url}.pushInsteadOf`, fetch);
  assert.equal(p.w.git(p.product, "remote", "get-url", "--push", "--all", "origin"), p.first.url);
  assert.equal(jsonOutput(p.diagnose()).repository, p.first.slug);
  const [, mirrorBefore] = p.snapshot();
  status(p.promote(), 0);
  p.assertDelivered(p.first);
  assert.equal(p.snapshot()[1], mirrorBefore);
});

test("R6-A09 separate remotes can be promoted independently after their own CI passes", t => {
  const p = pushWorld(t);
  p.w.git(p.product, "remote", "add", "mirror", p.second.url);
  const [, mirrorBefore] = p.snapshot();
  status(p.promote(), 0);
  p.assertDelivered(p.first);
  assert.equal(p.snapshot()[1], mirrorBefore);

  p.configure("mirror");
  has(output(refusedWithoutPush(p, () => p.promote())), p.close.failedCheck);
  const [firstBefore] = p.snapshot();
  p.serve(p.close.initial, p.close.successfulRerun);
  status(p.promote(), 0);
  assert.equal(p.snapshot()[0], firstBefore);
  p.assertDelivered(p.second);
});

const removed = [
  ["10", "--protected", () => "release"],
  ["11", "--require", p => p.close.requires.find(check => check !== p.close.failedCheck)],
  ["12", "--remote", () => "mirror"],
  ["13", "--records", p => p.records],
];

for (const [id, flag, argument] of removed) {
  test(`R6-A${id} the old ${flag} flag cannot override the registered loop`, t => {
    const p = pushWorld(t);
    p.w.git(p.product, "remote", "add", "mirror", p.second.url);
    p.serve(p.close.failedRerun, p.close.initial);
    const result = refusedWithoutPush(p, () => p.promote([flag, argument(p)]), 64);
    has(output(result), flag);
    p.serve();
    status(p.promote(), 0);
    p.assertDelivered(p.first);
  });
}

test("R6-A14 a product missing from the selected owner store cannot push", t => {
  const p = pushWorld(t);
  const emptyStore = p.w.repo(join(p.w.dir, "empty-store"), { "products.json": '{"products":[]}\n' });
  const result = refusedWithoutPush(p, () => p.promote(["--owner-store", emptyStore]));
  assert.match(output(result), /no .*product|no .*loop|not registered|0 (?:matches|registered)/i);
  assert.ok(output(result).includes(p.product) || output(result).includes(emptyStore), output(result));
  status(p.promote(), 0);
  p.assertDelivered(p.first);
});

test("R6-A15 two registrations for one Git common directory refuse with both candidates", t => {
  const p = pushWorld(t);
  const linked = join(p.w.dir, "linked-checkout");
  p.w.git(p.product, "worktree", "add", "-q", "--detach", linked, p.tip);
  const alternate = p.w.repo(join(p.w.projects, "other-release-records"), { "README.md": "# Second release loop\n" });
  p.configure(p.close.remote, alternate, linked);
  p.w.register([{ name: "release-target", records: p.records }, { name: "second-release", records: alternate }]);
  const result = refusedWithoutPush(p, () => p.promote());
  const text = output(result);
  assert.ok(text.includes("release-target") || text.includes(p.records), text);
  assert.ok(text.includes("second-release") || text.includes(alternate), text);

  p.w.register([{ name: "release-target", records: p.records }]);
  status(p.promote([], { repo: linked, suiteReceipt: p.makeReceipt(linked) }), 0);
  p.assertDelivered(p.first);
});

test("R6-A16 live configured checks can refuse a previously green promotion", t => {
  const p = pushWorld(t);
  const row = JSON.parse(readFileSync(p.file, "utf8"));
  assert.equal(row.ci, "success");
  p.serve(p.close.failedRerun);
  has(output(refusedWithoutPush(p, () => p.promote())), p.close.failedCheck);
  p.serve();
  status(p.promote(), 0);
  p.assertDelivered(p.first);
});

test("R6-A17 green live CI cannot stand in for judge convergence", t => {
  const p = pushWorld(t, { verdict: "CONTINUE" });
  assert.equal(jsonOutput(p.diagnose()).ci, "success");
  assert.match(output(refusedWithoutPush(p, () => p.promote())), /judge|converg/i);
});

test("R6-A18 a working branch cannot bypass the one-destination rule", t => {
  const p = pushWorld(t);
  p.addMirror();
  const result = refusedWithoutPush(p, () => p.promote([], { branch: "candidate" }));
  namesBoth(result, p);
  p.w.git(p.product, "remote", "set-url", "--delete", "--push", p.close.remote, "^" + p.second.url.replaceAll(".", "\\.") + "$");
  const [, mirrorBefore] = p.snapshot();
  status(p.promote([], { branch: "candidate" }), 0);
  p.assertDelivered(p.first, "candidate");
  assert.equal(p.snapshot()[1], mirrorBefore);
});
