import assert from "node:assert/strict";
import test from "node:test";
import { output, put, status } from "./fixture.mjs";
import { at, dispatchPkg, dispatchWorld, mechanisms, pkg, planText, refusal, shuffled } from "./plan-world-fixture.mjs";
import { seed, seeded } from "./scenario.mjs";

const actorFiles = {
  a: ["scripts/owner-words.mjs", "scripts/lib/owner-words.mjs", "scripts/lib/owner-metrics.mjs", "scripts/records-check.mjs"],
  b: ["scripts/decisions.mjs"],
  c: ["scripts/loop.mjs", "scripts/lib/cadence.mjs"],
  d: ["scripts/plan.mjs", "scripts/lib/plan.mjs", "SKILL.md", "RECORDS.md"],
};
const directions = { a: "D-0030", b: "D-0031", c: "D-0032", d: "R-0008-judge-frame-dispatch" };
const letters = (n, width) => Array.from({ length: width }, (_, i) => String.fromCharCode(97 + Math.floor(n / 26 ** (width - 1 - i)) % 26)).join("");
const mentions = (body, ids) => ids.filter(id => new RegExp(`(?<![\\w-])${id}(?![\\w-])`).test(body));
const offered = (text, item) => text.split("\n").some(line => /\bcall\.mjs\b/.test(line) && new RegExp(`--step ${item.handoff.replace(/^R-\d{4}-/, "")}(?:\\s|$)`).test(line));

test("R8-D1-01 ordered · flow: lead plans actor D and a read-only judge follow-up from settled direction · loss: false-verdict", t => {
  const w = dispatchWorld(t);
  const judge = dispatchPkg("judge-plan", { files: [], authority: "D-0030" });
  const actor = dispatchPkg("actor-d", { files: actorFiles.d, authority: directions.d });
  status(w.validate([actor, judge]), 0);
  refusal(w.validate([{ ...actor, authority: null }, judge]), /authority/i);
});

test("R8-D1-02 ordered · flow: lead carves two packages whose file globs include the same planner path · loss: wrong-result", t => {
  const w = dispatchWorld(t);
  const actor = dispatchPkg("actor-d", { files: ["scripts/lib/**/plan*.mjs"], authority: directions.d });
  const disjoint = dispatchPkg("actor-c", { files: ["scripts/lib/**/cadence*.mjs", "scripts/plan.mjs"], authority: directions.c });
  status(w.validate([actor, disjoint]), 0);
  for (const path of ["scripts/lib/plan.mjs", "scripts/lib/future/planning-*.mjs"]) {
    refusal(w.validate([actor, { ...disjoint, files: [...disjoint.files, path] }]), /overlap|conflict|share|both/i);
  }
});

test("R8-D1-03 fresh · flow: lead links a long join chain in shuffled package order then accidentally routes its root through the join · loss: stuck", t => {
  const w = dispatchWorld(t);
  const steps = Array.from({ length: 28 + seeded(seed)(17) }, (_, i) => `judge-chain-${String.fromCharCode(97 + Math.floor(i / 26))}${String.fromCharCode(97 + i % 26)}`);
  const packages = steps.map((id, i) => dispatchPkg(id, { needs: i ? [steps[i - 1]] : [] }));
  const join = dispatchPkg("judge-integration", { needs: [steps.at(-1), steps[0], "D-0030"] });
  status(w.validate(shuffled([join, ...packages], 101)), 0);
  packages[0].needs.push(join.id);
  refusal(w.validate(shuffled([join, ...packages], 101)), /cycle|circular/i);
});

test("R8-D1-04 fresh · flow: lead validates a plan referencing an authority still staged, then publishes the decision · loss: false-verdict", t => {
  const x = dispatchWorld(t);
  const actor = dispatchPkg("actor-b", { authority: "D-0099", needs: ["D-0031"], files: actorFiles.b });
  const decision = "decisions/D-0099.md";
  put(x.p.records, decision, "# D-0099 Settle the delegated owner decisions work\n\nid: D-0099\nby: owner\nstatus: active\n");
  x.w.git(x.p.records, "add", "--", decision);
  refusal(x.validate([actor]), /D-0099/);
  x.checkAndCommit("Publish owner decision D-0099");
  status(x.validate([actor]), 0);
  refusal(x.validate([{ ...actor, needs: ["D-0098"] }]), /D-0098/);
});

function graphs() {
  const edges = [];
  for (const a of [0, 1, 2]) for (const b of [0, 1, 2]) if (a !== b) edges.push([a, b]);
  const all = [];
  for (let mask = 0; mask < 1 << edges.length; mask++) all.push(edges.filter((_, i) => mask & 1 << i));
  for (const node of [0, 1, 2]) all.push([[node, node], ...edges.filter(([a, b]) => a < b)]);
  return all;
}

function cyclic(graph) {
  const out = [0, 1, 2].map(n => graph.filter(([a]) => a === n).map(([, b]) => b));
  const state = [0, 0, 0];
  const visit = n => {
    if (state[n] === 1) return true;
    if (state[n] === 2) return false;
    state[n] = 1;
    const found = out[n].some(visit);
    state[n] = 2;
    return found;
  };
  return [0, 1, 2].some(visit);
}

async function inBatches(jobs, size = 6) {
  const results = [];
  for (let i = 0; i < jobs.length; i += size) results.push(...await Promise.all(jobs.slice(i, i + size).map(job => job())));
  return results;
}

function validateLater(f, name, packages) {
  const file = put(f.w.dir, `drafts/${name}.md`, planText("PL-0009", packages, { scope: "v1/round-8" }));
  return () => f.w.runAsync(["validate", file, "--records", f.p.records], { entry: "plan.mjs", cwd: f.p.records, at: at(60) });
}

test("R8-A5-02 ordered · flow: lead links three read-only packages in every possible dependency graph beside every acyclic one, bound 3 packages x 9 edges · loss: stuck", async t => {
  const f = mechanisms(t);
  const all = graphs();
  const acyclic = all.filter(g => !cyclic(g)), loops = all.filter(cyclic);
  const rooted = g => [0, 1, 2].some(n => !g.some(([, b]) => b === n));
  assert.ok(loops.some(g => !rooted(g)) && loops.some(g => !g.some(([a, b]) => g.some(([c, d]) => c === b && d === a)) && g.every(([a, b]) => a !== b)),
    "the bound does not reach a rootless or three-package cycle");
  const nodes = ["x", "y", "z"];
  const packagesOf = (graph, tag) => nodes.map((node, i) => pkg(`${tag}${node}`, { role: "judge", round: 8, authority: "D-0030",
    needs: graph.filter(([a]) => a === i).map(([, b]) => `${tag}${nodes[b]}`) }));
  const base = acyclic.flatMap((g, i) => packagesOf(g, `a${letters(i, 2)}`));
  const jobs = [validateLater(f, "acyclic", shuffled(base, 52)),
    ...loops.map((g, i) => validateLater(f, `loop-${i}`, shuffled([...base, ...packagesOf(g, `c${letters(i, 2)}`)], 53 + i)))];
  const results = await inBatches(jobs);
  assert.equal(results[0].status, 0, output(results[0]));
  results.slice(1).forEach((result, i) => {
    assert.ok(result.status > 0, `cycle ${JSON.stringify(loops[i])} accepted: ${output(result)}`);
    assert.match(output(result), /cycle|circular/i, JSON.stringify(loops[i]));
  });
});

const GLOBS = ["a/b", "a/*", "*/b", "a/a*", "a/*b", "a/?", "a/[ab]", "a/{x,ab}", "b/*", "a/**/b", "**/ab", "b/", "a/x/*", "*/x/?", "*/[a-b]x", "{a,b}/x/a"];

function globRegex(pattern, { zero }) {
  if (pattern.endsWith("/")) return new RegExp(`^${segmentsOf(pattern.slice(0, -1), zero)}/.+$`);
  return new RegExp(`^${segmentsOf(pattern, zero)}$`);
}

function segmentsOf(pattern, zero) {
  const parts = pattern.split("/");
  let source = "";
  parts.forEach((part, i) => {
    const last = i === parts.length - 1;
    if (part === "**") { source += zero ? "(?:[^/]+/)*" : "(?:[^/]+/)+"; return; }
    let segment = "", inClass = false;
    for (const c of part) {
      if (inClass) { segment += c; inClass = c !== "]"; }
      else if (c === "[") { segment += c; inClass = true; }
      else if (c === "*") segment += "[^/]*";
      else if (c === "?") segment += "[^/]";
      else if (c === "{") segment += "(?:";
      else if (c === "}") segment += ")";
      else if (c === ",") segment += "|";
      else segment += c.replace(/[.+^$()|\\]/g, "\\$&");
    }
    source += segment + (last ? "" : "/");
  });
  return source;
}

function universe() {
  const names = [];
  const grow = (prefix, depth) => { if (prefix) names.push(prefix); if (depth) for (const c of "abx") grow(prefix + c, depth - 1); };
  grow("", 3);
  const short = names.filter(n => n.length <= 2);
  const paths = [...names];
  for (const a of names) for (const b of names) paths.push(`${a}/${b}`);
  for (const a of names) for (const b of names) for (const c of names) paths.push(`${a}/${b}/${c}`);
  for (const a of short) for (const b of short) for (const c of short) for (const d of short) paths.push(`${a}/${b}/${c}/${d}`);
  return paths;
}

test("R8-A5-03 fresh · flow: lead carves two writers for every pair of sixteen globs that meet only at paths no file has yet, bound 3 segments of 3 letters and 4 segments of 2 · loss: wrong-result", async t => {
  const f = mechanisms(t);
  const paths = universe();
  const matches = zero => GLOBS.map(g => { const re = globRegex(g, { zero }); return new Set(paths.filter(p => re.test(p))); });
  const withZero = matches(true), withoutZero = matches(false);
  const meets = (sets, i, j) => [...sets[i]].some(path => sets[j].has(path));
  const pairs = [];
  for (let i = 0; i < GLOBS.length; i++) for (let j = i + 1; j < GLOBS.length; j++) {
    const a = meets(withZero, i, j), b = meets(withoutZero, i, j);
    if (a === b) pairs.push({ left: GLOBS[i], right: GLOBS[j], overlap: a });
  }
  const prefix = g => g.split(/[*?[{]/)[0];
  const literalPrefix = pair => prefix(pair.left).startsWith(prefix(pair.right)) || prefix(pair.right).startsWith(prefix(pair.left));
  assert.ok(pairs.some(pair => pair.overlap) && pairs.some(pair => !pair.overlap), "the bound holds no overlap or no disjoint pair");
  assert.ok(pairs.some(pair => literalPrefix(pair) !== pair.overlap), "the bound does not separate a literal-prefix comparison");
  assert.ok(pairs.some(pair => pair.overlap && pair.left !== pair.right), "the bound does not separate string equality");
  const jobs = pairs.map((pair, n) => validateLater(f, `pair-${n}`, [
    pkg("left", { round: 8, files: [pair.left] }), pkg("right", { round: 8, files: [pair.right] })]));
  const results = await inBatches(jobs);
  const wrong = pairs.filter((pair, n) => pair.overlap ? results[n].status === 0 : results[n].status !== 0)
    .map(pair => `${pair.left} / ${pair.right}: ${pair.overlap ? "overlap accepted" : "disjoint refused"}`);
  assert.deepEqual(wrong, []);
  pairs.forEach((pair, n) => { if (pair.overlap) assert.match(output(results[n]), /overlap|share|conflict/i, `${pair.left} / ${pair.right}`); });
});

test("R8-A5-07 fresh · flow: lead gives the documents package the top-level glob [A-Z]*.md beside a package that owns SKILL.md · loss: stuck", async t => {
  const f = mechanisms(t);
  const docs = pkg("docs", { round: 8, files: ["[A-Z]*.md"] }), code = pkg("code", { round: 8, files: ["scripts/**"] }), skill = pkg("skill", { round: 8, files: ["SKILL.md"] });
  const [alone, clash] = await inBatches([validateLater(f, "docs", [docs, code]), validateLater(f, "clash", [docs, skill])]);
  assert.equal(alone.status, 0, output(alone));
  assert.ok(clash.status > 0, output(clash));
  assert.match(output(clash), /overlap|share|conflict/i);
  assert.doesNotMatch(output(clash), /JSON/);
});

const OVERLAPS = [
  [["scripts/lib/plan.mjs"], ["scripts/lib/**"]],
  [["SKILL.md"], ["[A-Z]*.md"]],
  [["acceptance/plan-validation-and-overlap.test.mjs"], ["acceptance/*.test.mjs"]],
  [["docs/guide/start.md"], ["docs/"]],
];

function holdsBy(text, waiting, holder) {
  return text.split("\n").some(line => mentions(line, [waiting.id, waiting.handoff]).length && mentions(line, [holder.id, holder.handoff]).length);
}

test("R9-A3-01 fresh · flow: lead publishes two current plans in different scopes whose packages write the same files · loss: wrong-result", t => {
  const f = mechanisms(t);
  const draw = seeded(seed + 31);
  const [left, right] = OVERLAPS[draw(OVERLAPS.length)];
  const [calm, quiet] = [["unaffected/bravo/**"], ["unaffected/delta/**"]];
  const alpha = pkg("alpha", { files: left }), bravo = pkg("bravo", { files: calm });
  const charlie = pkg("charlie", { files: right }), delta = pkg("delta", { files: quiet });
  f.plan("PL-0001", shuffled([alpha, bravo], 32), { when: at(20) });
  f.plan("PL-0002", shuffled([charlie, delta], 33), { scope: "v1/docs", when: at(25) });
  const text = f.next({ when: at(100) });
  for (const item of [bravo, delta]) assert.ok(offered(text, item), `${item.id} writes disjoint files and is not offered:\n${text}`);
  const pair = [alpha, charlie].filter(item => offered(text, item));
  assert.equal(pair.length, 1, `${left} and ${right} overlap; offered: ${pair.map(item => item.id).join(", ") || "none"}\n${text}`);
  const [first] = pair, second = first === alpha ? charlie : alpha;
  assert.ok(holdsBy(text, second, first), `${second.id} waits without naming ${first.id}:\n${text}`);
});

test("R9-A3-02 ordered · flow: lead plans two scopes with disjoint writers, then starts and records one of two overlapping writers · loss: wrong-result", t => {
  const f = mechanisms(t);
  const alpha = pkg("alpha", { files: ["scripts/lib/plan.mjs"] }), bravo = pkg("bravo", { files: ["src/bravo/**"] });
  const charlie = pkg("charlie", { files: ["scripts/other/**"] }), delta = pkg("delta", { files: ["docs/**"] });
  f.plan("PL-0001", [alpha, bravo], { when: at(20) });
  f.plan("PL-0002", [charlie, delta], { scope: "v1/docs", when: at(25) });
  const apart = f.next({ when: at(60) });
  for (const item of [alpha, bravo, charlie, delta]) assert.ok(offered(apart, item), `${item.id}:\n${apart}`);
  const overlapping = pkg("echo", { files: ["scripts/lib/**"] });
  const g = mechanisms(t);
  g.plan("PL-0001", [alpha, bravo], { when: at(20) });
  g.plan("PL-0002", [overlapping, delta], { scope: "v1/docs", when: at(25) });
  const running = g.prepare(alpha, at(30));
  const held = g.next({ when: at(60) });
  assert.ok(!offered(held, overlapping), held);
  assert.ok(holdsBy(held, overlapping, alpha), held);
  status(g.record(alpha, running, { start: at(70), when: at(80) }), 0);
  const after = g.next({ when: at(100) });
  assert.ok(offered(after, overlapping), after);
});
