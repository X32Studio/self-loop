// F-0012, R-0008-judge-mechanisms, design/generative-engine.md#bounded-models
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { cadenceState } from "../lib/cadence.mjs";
import { admitAcrossPlans, isIdle, LEAD_STEPS, readyPlan, validatePlan } from "../lib/plan.mjs";
import { appendJsonLines, commitRecords } from "../lib/records-commit.mjs";
import { blockerState } from "../loop.mjs";
import { git, repo, temp } from "./helpers.mjs";

const TASK = import.meta.filename;
const MISSING = join(temp("self-loop-model-"), "missing-task.md");
const RECORDS = "/model/records";
const product = (...lists) => lists.reduce((all, list) => all.flatMap(a => list.map(b => [...a, b])), [[]]);

function memory(files = {}) {
  const contents = { "decisions/D-0001.md": "# D-0001\n", ...files };
  return { records: RECORDS, revision: "a".repeat(40), files: new Set(Object.keys(contents)),
    read: path => typeof contents[path] === "string" ? contents[path] : contents[path]?.toString("utf8") ?? "",
    bytes: path => contents[path] === undefined ? null : Buffer.from(contents[path]) };
}

const pkg = (id, fields = {}) => ({ id, authority: ["D-0001"], goal: `Deliver ${id}`, files: [], interface: "fixed",
  needs: [], role: "actor", acceptance: "its cases pass", handoff: `R-0008-actor-${id}`, task: TASK, ...fields });
const planOf = packages => ({ id: "PL-0001", scope: "v1/model", phase: "v1", packages });
const cfg = { agents: { actor: { runner: "t3" }, critic: { runner: "t3" }, judge: { runner: "t3" } }, workDir: "/model/work",
  configFile: "/model/records/loop.json", records: RECORDS };
const roomy = { admits: true, over: [], calls: [] };
const crowded = { admits: false, over: ["1-minute load average 99 over 14"], calls: [] };
const ready = (state, plan, { handoffs = [], batches = [], prepared = [], host = roomy, plans = [plan], base } = {}) =>
  readyPlan(state, plan, { context: { cfg, handoffs, batches, plans, prepared }, host, base });
const done = id => ({ id: `R-0008-actor-${id}`, phase: "v1", record: `rounds/0008-actor-${id}.md` });
const recordedState = ids => memory(Object.fromEntries(ids.map(id => [`rounds/0008-actor-${id}.md`, "# recorded\n"])));
const live = (id, files = []) => ({ id: `R-0008-actor-${id}`, phase: "v1", liveWorkspace: true, ws: `/model/work/${id}`, owns: files });

const PATTERNS = ["", "a/x.js", "a/*.js", "a/", "b/**/c.js", "b/c.js"];
const PATHS = ["a/x.js", "a/y.js", "a/q/x.js", "b/c.js", "b/d/c.js", "b/d/e.js", "b/e/f/c.js"];
function matches(pattern, path) {
  if (!pattern) return false;
  if (pattern.endsWith("/")) return path.startsWith(pattern);
  const source = pattern.split("/").map(part => part === "**" ? "(?:[^/]+/)*" : `${part.replaceAll(".", "\\.").replaceAll("*", "[^/]*")}/`).join("").slice(0, -1);
  return new RegExp(`^${source}$`).test(path);
}
const meet = (a, b) => PATHS.some(path => matches(a, path) && matches(b, path));

function writersCounterexamples({ validate = validatePlan, dispatch = ready } = {}) {
  const found = [];
  let states = 0, valid = 0;
  for (const [x, y, z, w] of product(PATTERNS, PATTERNS, PATTERNS, PATTERNS)) {
    states++;
    const plan = planOf([pkg("x", { files: x ? [x] : [] }), pkg("y", { files: y ? [y] : [] }), pkg("z", { files: z ? [z] : [] })]);
    const clash = [[x, y], [x, z], [y, z]].some(([a, b]) => meet(a, b));
    const refused = validate(plan, memory()).length > 0;
    if (refused && !clash) found.push(`disjoint packages refused (x=${x}, y=${y}, z=${z})`);
    if (refused) continue;
    valid++;
    const earlier = { ...planOf([pkg("w", { files: w ? [w] : [] })]), id: "PL-0000" };
    const result = dispatch(memory(), plan, { plans: [earlier, plan], prepared: [live("w")] });
    const writing = [{ id: "w", files: w ? [w] : [] }, ...plan.packages.filter((p, i) => ["ready", "running"].includes(result.packages[i].status))];
    for (let i = 0; i < writing.length; i++) for (let j = i + 1; j < writing.length; j++)
      for (const a of writing[i].files) for (const b of writing[j].files)
        if (meet(a, b)) found.push(`${writing[i].id}:${a} and ${writing[j].id}:${b} may both write (x=${x}, y=${y}, z=${z}, live w=${w})`);
  }
  return { found, states, valid };
}

test("A5 disjoint writers, bound: 3 packages × 6 file patterns each beside a live writer of an earlier plan with 6 patterns (1,296 states); flow: the lead reconciles a plan while an earlier package still writes; loss: wrong-result, two writers of one file", () => {
  const { found, states, valid } = writersCounterexamples();
  assert.deepEqual(found, []);
  assert.equal(states, 1296);
  assert.equal(valid, 312, "the plans whose three packages are disjoint by the path oracle, each reconciled beside every live writer");
  const skipsOverlap = (plan, state) => validatePlan(plan, state).filter(error => !/overlapping files/.test(error));
  assert.ok(writersCounterexamples({ validate: skipsOverlap }).found.length, "seeded defect: a plan validator without the overlap check");
  const ignoresWriter = (state, plan, options) => {
    const result = ready(state, plan, options);
    for (const row of result.packages) {
      row.holds = row.holds.filter(h => h.kind !== "writer");
      if (row.status === "waiting" && !row.holds.length) row.status = "ready";
    }
    return result;
  };
  assert.ok(writersCounterexamples({ dispatch: ignoresWriter }).found.length, "seeded defect: a dispatcher that ignores the live writer");
});

function acrossPlansCounterexamples({ admit = admitAcrossPlans } = {}) {
  const found = [];
  let states = 0, valid = 0;
  const ids = ["x", "y", "z"], planNo = { x: 1, y: 1, z: 2 };
  for (const [x, y, z, ...runs] of product(PATTERNS, PATTERNS, PATTERNS, ["none", "running", "done"], ["none", "running", "done"], ["none", "running", "done"])) {
    states++;
    const files = { x, y, z };
    const first = planOf([pkg("x", { files: x ? [x] : [] }), pkg("y", { files: y ? [y] : [] })]);
    const second = { id: "PL-0002", scope: "v1/other", phase: "v1", packages: [pkg("z", { files: z ? [z] : [] })] };
    if (validatePlan(first, memory()).length) continue;
    valid++;
    const finished = ids.filter((_, i) => runs[i] === "done");
    const calls = ids.filter((_, i) => runs[i] === "running").map(id => ({ kind: "call", id: `R-0008-actor-${id}`, records: RECORDS, pid: 1 }));
    const options = { handoffs: finished.map(done), plans: [first, second], host: { ...roomy, calls } };
    const entries = [second, first].map(plan => ({ plan, result: ready(recordedState(finished), plan, options) }));
    admit(entries);
    const rows = Object.fromEntries(entries.flatMap(e => e.result.packages.map(row => [row.id, row])));
    const claims = ids.filter((_, i) => runs[i] === "running"), want = {};
    ids.forEach((id, i) => {
      if (runs[i] !== "none") { want[id] = runs[i]; return; }
      const holder = claims.find(c => planNo[c] !== planNo[id] && meet(files[c], files[id]));
      want[id] = holder ? `waiting on ${holder}` : "ready";
      if (!holder) claims.push(id);
    });
    const context = JSON.stringify({ x, y, z, runs });
    for (const id of ids) {
      const row = rows[id], writer = row.holds.find(h => h.kind === "writer");
      const got = row.status === "waiting" && writer ? `waiting on ${writer.target.slice("R-0008-actor-".length)}` : row.status;
      if (got !== want[id]) found.push(`${id}: ${got}, oracle ${want[id]} (${context})`);
      if (row.command && row.status !== "ready") found.push(`${id} offered a command while ${row.status} (${context})`);
    }
    const writing = ids.filter(id => rows[id].status === "ready" || rows[id].status === "running");
    for (let i = 0; i < writing.length; i++) for (let j = i + 1; j < writing.length; j++)
      if ([writing[i], writing[j]].some(id => rows[id].status === "ready") && meet(files[writing[i]], files[writing[j]]))
        found.push(`${writing[i]} and ${writing[j]} may both write (${context})`);
  }
  return { found, states, valid };
}

test("A5 one writer across current plans, bound: 2 current plans (2 packages and 1) × 6 file patterns × 3 run states per package (5,832 states); flow: the lead reconciles two plans of one phase whose packages meet in a file; loss: wrong-result, two writers of one file offered from one reading", () => {
  const { found, states, valid } = acrossPlansCounterexamples();
  assert.deepEqual(found, []);
  assert.equal(states, 5832);
  assert.equal(valid, 3726, "the states whose first plan is valid (23 of the 36 pattern pairs are disjoint)");
  assert.ok(acrossPlansCounterexamples({ admit: () => {} }).found.length, "seeded defect: each plan reconciled alone, the R8-Grok-1 shape");
  const laterFirst = entries => admitAcrossPlans(entries.map(e => ({ ...e, plan: { ...e.plan, id: e.plan.id === "PL-0001" ? "PL-0009" : e.plan.id } })));
  assert.ok(acrossPlansCounterexamples({ admit: laterFirst }).found.length, "seeded defect: the later plan admitted first");
});

const EDGES = [[0, 1], [0, 2], [1, 0], [1, 2], [2, 0], [2, 1]];
function cyclic(graph) {
  const state = [0, 0, 0];
  const visit = n => {
    if (state[n] === 1) return true;
    if (state[n] === 2) return false;
    state[n] = 1;
    const found = graph.filter(([a]) => a === n).some(([, b]) => visit(b));
    state[n] = 2;
    return found;
  };
  return [0, 1, 2].some(visit);
}

function dependencyCounterexamples({ validate = validatePlan } = {}) {
  const found = [];
  const graphs = [...Array(1 << EDGES.length).keys()].map(mask => EDGES.filter((_, i) => mask & 1 << i))
    .concat([0, 1, 2].map(n => [[n, n]]));
  for (const graph of graphs) {
    const ids = ["x", "y", "z"];
    const plan = planOf(ids.map((id, i) => pkg(id, { needs: graph.filter(([a]) => a === i).map(([, b]) => ids[b]) })));
    const refused = validate(plan, memory()).length > 0;
    if (refused !== cyclic(graph)) { found.push(`${JSON.stringify(graph)} ${refused ? "refused while acyclic" : "accepted while cyclic"}`); continue; }
    if (refused) continue;
    const finished = new Set();
    for (let step = 0; step < ids.length; step++) {
      const result = ready(recordedState([...finished]), plan, { handoffs: [...finished].map(done) });
      const next = result.packages.find(row => row.status === "ready");
      if (!next) break;
      finished.add(next.id);
    }
    if (finished.size !== ids.length) found.push(`${JSON.stringify(graph)}: ${ids.filter(id => !finished.has(id)).join(", ")} can never become ready`);
  }
  return { found, states: graphs.length, acyclic: graphs.filter(g => !cyclic(g)).length };
}

test("A5 acyclic dependencies, bound: every needs graph on 3 packages (64) and 3 self-loops; flow: the lead links packages by needs; loss: stuck, a dependency cycle no package can break", () => {
  const { found, states, acyclic } = dependencyCounterexamples();
  assert.deepEqual(found, []);
  assert.deepEqual([states, acyclic], [67, 25], "the bound: 64 graphs and 3 self-loops, 25 of them acyclic");
  const acceptsCycles = (plan, state) => validatePlan(plan, state).filter(error => !/cycle/.test(error));
  assert.ok(dependencyCounterexamples({ validate: acceptsCycles }).found.length, "seeded defect: a validator without the cycle check");
});

const RUN_STATES = ["none", "prepared", "lease", "lost-stopped", "lost-unknown", "done"];
function evidenceFor(id, nonce) {
  return { [`evidence/0008/actor-${id}-1-audit.json`]: JSON.stringify({ id: `R-0008-actor-${id}`, agent: { session: "s" } }),
    [`evidence/0008/actor-${id}-1.log.gz`]: gzipSync(`prompt ${nonce}\n`) };
}

function startCounterexamples({ dispatch = ready } = {}) {
  const found = [];
  const ids = ["x", "y", "z"];
  let checked = 0;
  for (const states of product(RUN_STATES, RUN_STATES, RUN_STATES)) {
    checked++;
    let files = {};
    const prepared = [], handoffs = [], calls = [];
    states.forEach((s, i) => {
      const id = ids[i], handoff = `R-0008-actor-${id}`;
      if (s === "prepared") prepared.push(live(id));
      if (s === "lease") calls.push({ kind: "call", id: handoff, records: RECORDS, pid: 1000 + i });
      if (s.startsWith("lost")) prepared.push({ id: handoff, phase: "v1", liveWorkspace: false, ws: `/model/work/${id}`, nonce: `nonce-${id}` });
      if (s === "lost-stopped") files = { ...files, ...evidenceFor(id, `nonce-${id}`) };
      if (s === "done") { handoffs.push(done(id)); files[`rounds/0008-actor-${id}.md`] = "# recorded\n"; }
    });
    const plan = planOf(ids.map(id => pkg(id, { files: [`src/${id}/`] })));
    const result = dispatch(memory(files), plan, { prepared, handoffs, host: { ...roomy, calls } });
    result.packages.forEach((row, i) => {
      const startable = ["none", "lost-stopped"].includes(states[i]);
      if (Boolean(row.command) !== startable) found.push(`${row.id} in ${states[i]} ${row.command ? "offered a start" : "offered none"} (${states.join(", ")})`);
    });
  }
  return { found, states: checked };
}

test("A5 no duplicate start, bound: 3 packages × 6 run states (none, prepared, a live CLI lease, a lost attempt that stopped or may still run, done; 216 states); flow: the lead reconciles while calls run or were lost; loss: wrong-result, one package started twice", () => {
  const { found, states } = startCounterexamples();
  assert.deepEqual(found, []);
  assert.equal(states, 216);
  const blindToLeases = (state, plan, options) => ready(state, plan, { ...options, host: { ...options.host, calls: [] } });
  assert.ok(startCounterexamples({ dispatch: blindToLeases }).found.length, "seeded defect: a dispatcher that ignores live CLI call leases");
  const trustsLostAttempts = (state, plan, options) => ready(state, plan, { ...options, prepared: options.prepared.filter(p => p.liveWorkspace) });
  assert.ok(startCounterexamples({ dispatch: trustsLostAttempts }).found.length, "seeded defect: a dispatcher that forgets an attempt whose worktree is gone");
});

const DISPOSITIONS = [[], ["opened"], ["carried"], ["closed"], ["shelved"], ["opened", "closed"], ["carried", "closed"]];
function blockerOracle(sequence) {
  let state = "none";
  for (const fields of sequence) {
    if (fields.includes("opened") || fields.includes("carried")) state = "open";
    if (fields.includes("closed")) state = "closed";
    if (fields.includes("shelved")) state = "shelved";
  }
  return state;
}

function blockerCounterexamples(transition = blockerState) {
  const found = [];
  let states = 0;
  for (const sequence of product(DISPOSITIONS, DISPOSITIONS, DISPOSITIONS, DISPOSITIONS)) {
    const rows = sequence.map((fields, r) => ({ round: r + 1, role: "judge", verdict: "CONTINUE", phase: "v1",
      ...Object.fromEntries(fields.map(field => [field, "k:1"])) }));
    states++;
    const { open, shelved } = transition(rows);
    const got = open.length ? "open" : shelved.length ? "shelved" : "none-or-closed";
    const want = blockerOracle(sequence);
    if (got !== (want === "closed" || want === "none" ? "none-or-closed" : want)) found.push(`${JSON.stringify(sequence)}: ${got}, documented ${want}`);
  }
  return { found, states };
}

test("A5 carried-and-closed precedence, bound: 1 key × 4 rulings × 7 dispositions per ruling (2,401 sequences); flow: a ruling carries a blocker into the phase and closes it; loss: stuck, convergence waits on a closed blocker", () => {
  const { found, states } = blockerCounterexamples();
  assert.deepEqual(found, []);
  assert.equal(states, 2401);
  const closedFirst = rows => blockerState(rows.flatMap(r => [{ ...r, opened: undefined, carried: undefined, shelved: undefined },
    { ...r, closed: undefined }]));
  assert.ok(blockerCounterexamples(closedFirst).found.length, "seeded defect: the R7-1 order, closed keys applied before carried ones");
});

const HOLDS = ["none", "opaque", "met", "unmet", "unreleased"];
const holdFields = kind => ({ none: {}, opaque: { hold: "waiting for a word", release: "the owner says go" },
  met: { hold: "waiting for D-0001", release: "D-0001" }, unmet: { hold: "waiting for D-0099", release: "D-0099" },
  unreleased: { hold: "waiting for the frame judge" } })[kind];

function progressCounterexamples({ dispatch = ready } = {}) {
  const found = [];
  const ids = ["x", "y"];
  const graphs = [[], [[1, 0]], [[0, 1]]];
  let states = 0;
  for (const [graph, capacity, ...pairs] of product(graphs, ["admits", "over"], ...ids.map(() => product(["none", "running", "done"], HOLDS, [true, false])))) {
    states++;
    const host = capacity === "admits" ? roomy : crowded;
    const packages = ids.map((id, i) => pkg(id, { files: [`src/${id}/`], needs: graph.filter(([a]) => a === i).map(([, b]) => ids[b]),
      task: pairs[i][2] ? TASK : MISSING, ...holdFields(pairs[i][1]) }));
    const plan = planOf(packages);
    const prepared = ids.filter((_, i) => pairs[i][0] === "running").map(id => live(id));
    const finished = ids.filter((_, i) => pairs[i][0] === "done");
    const options = { handoffs: finished.map(done), prepared, host };
    const before = dispatch(recordedState(finished), plan, options);
    const obstructed = i => graph.some(([a, b]) => a === i && pairs[b][0] !== "done") || ["opaque", "unmet"].includes(pairs[i][1]) || !host.admits;
    before.packages.forEach((row, i) => {
      const started = pairs[i][0] !== "none";
      if (!started && !obstructed(i) !== isIdle(row)) found.push(`${row.id} ${isIdle(row) ? "flagged while held" : "neither started, held nor flagged"} (${JSON.stringify({ graph, capacity, pairs })})`);
      if (started && isIdle(row)) found.push(`${row.id} flagged while ${pairs[i][0]}`);
    });
    const started = before.packages.filter(row => row.command).map(row => live(row.id));
    const after = dispatch(recordedState(finished), plan, { ...options, prepared: [...prepared, ...started] });
    after.packages.forEach((row, i) => {
      if (isIdle(row) && pairs[i][2]) found.push(`${row.id} left with neither a start nor a hold after reconciliation (${JSON.stringify({ graph, capacity, pairs })})`);
      if (isIdle(row) && row.holds.some(h => !LEAD_STEPS.includes(h.kind))) found.push(`${row.id} flagged although a real hold holds it`);
    });
  }
  return { found, states };
}

test("A5 progress after reconciliation, bound: 2 packages × 3 needs graphs × 2 capacities × (3 run states × 5 hold forms × task written or not) per package (5,400 states); flow: the lead reconciles and starts every offered package; loss: stuck, an authorized package left with neither a start nor a hold", () => {
  const { found, states } = progressCounterexamples();
  assert.deepEqual(found, []);
  assert.equal(states, 5400);
  const keepsReleased = (state, plan, options) => {
    const result = ready(state, plan, options);
    result.packages.forEach(row => {
      if (row.released) { row.holds.push({ kind: "hold", target: row.released.hold, release: row.released.release }); row.status = "waiting"; delete row.command; }
    });
    return result;
  };
  assert.ok(progressCounterexamples({ dispatch: keepsReleased }).found.length, "seeded defect: a released hold still counts as a hold");
  const taskIsAHold = (state, plan, options) => {
    const result = ready(state, plan, options);
    result.packages.forEach(row => row.holds.forEach(h => { if (h.kind === "task") h.kind = "record"; }));
    return result;
  };
  assert.ok(progressCounterexamples({ dispatch: taskIsAHold }).found.length, "seeded defect: an unwritten task counts as a hold (the shape of I-0002)");
  const dropsReady = (state, plan, options) => {
    const result = ready(state, plan, options);
    result.packages.forEach(row => { if (row.status === "ready") { row.status = "waiting"; delete row.command; row.holds.push({ kind: "package", target: "-", release: "-" }); } });
    return result;
  };
  assert.ok(progressCounterexamples({ dispatch: dropsReady }).found.length, "seeded defect: a ready package reported as waiting with no real hold");
});

const EVENTS = ["judged", "repeat", "unjudged", "advancing", "frame-only"];
function cadenceCounterexamples(state = cadenceState) {
  const found = [];
  let sequences = 0;
  for (const adversarial of [1, 2, 3]) for (let length = 0; length <= adversarial + 2; length++) for (const events of product(...Array(length).fill(EVENTS))) {
    const handoffs = [{ id: "R-0001-reviewer-frame", round: 1, role: "reviewer", step: "reviewer-frame", time: "2026-11-22T00:00:00Z" }];
    const rows = [];
    let round = 1, expected = 0;
    for (const event of events) {
      if (event === "repeat" && rows.length) { rows.push({ ...rows.at(-1) }); continue; }
      round++;
      if (event === "judged" || event === "repeat") { rows.push({ round, role: "judge", verdict: "CONTINUE", phase: "v1", area: "a" }); expected++; }
      if (event === "unjudged") rows.push({ round, role: "judge", verdict: "-", phase: "v1", area: "a" });
      if (event === "advancing" || event === "frame-only") handoffs.push({ id: `R-${round}-reviewer-frame`, round, role: "reviewer", step: "reviewer-frame", time: "2026-11-22T00:00:00Z" });
      if (event === "advancing") {
        handoffs.push({ id: `R-${round}-judge-frame`, round, role: "judge", step: "judge-frame", time: "2026-11-22T00:00:00Z" });
        rows.push({ round, role: "judge", verdict: "CONTINUE", phase: "v1", area: "frame" });
        expected = 0;
      }
    }
    sequences++;
    const due = state({ handoffs, rows, adversarial, nextRound: round + 1 }).due;
    if (due !== (expected >= adversarial)) found.push(`cadence ${adversarial}, events ${events.join(" ") || "none"}: ${due ? "due" : "not due"} after ${expected} judged rounds`);
  }
  return { found, states: sequences };
}

test("A5 advancing review within the cadence, bound: cadence 1–3 × every sequence of up to cadence + 2 events (a judged round, a repeated ruling, an unjudged row, an advancing round, a frame without its judge; 4,843 sequences); flow: rulings arrive round by round; loss: stuck, the advancing review never falls due", () => {
  const { found, states } = cadenceCounterexamples();
  assert.deepEqual(found, []);
  assert.equal(states, 4843);
  const lateByOne = args => { const s = cadenceState(args); return { ...s, due: s.count > args.adversarial }; };
  assert.ok(cadenceCounterexamples(lateByOne).found.length, "seeded defect: due one judged round late");
  const countsItsOwnRow = args => cadenceState({ ...args, handoffs: args.handoffs.filter(h => h.step !== "judge-frame") });
  assert.ok(cadenceCounterexamples(countsItsOwnRow).found.length, "seeded defect: an advancing round that does not restart the count");
});

const writer = (name, ...nested) => ({ name, nested });
const INTERLEAVINGS = [[writer("a"), writer("b")], [writer("a", writer("b"))], [writer("a", writer("b", writer("c")))],
  [writer("a", writer("b"), writer("c"))], [writer("a"), writer("b", writer("c"))]];

function transactionCounterexamples({ stale = false } = {}) {
  const found = [];
  const ledger = "metrics/model.jsonl";
  for (const shape of INTERLEAVINGS) {
    const records = repo({ "README.md": "# records\n", [ledger]: "" });
    const names = [];
    const write = node => {
      names.push(node.name);
      const before = stale ? readFileSync(join(records, ledger), "utf8") : null;
      let first = true;
      commitRecords(records, ({ read, add }) => {
        if (first) { first = false; node.nested.forEach(write); }
        add(ledger, appendJsonLines(stale ? before : read(ledger), [{ writer: node.name }]));
        return { message: `append ${node.name}` };
      });
    };
    shape.forEach(write);
    const lines = git(records, "show", `HEAD:${ledger}`).split("\n").filter(Boolean).map(line => JSON.parse(line).writer).sort();
    if (JSON.stringify(lines) !== JSON.stringify([...names].sort())) found.push(`${JSON.stringify(shape)}: the ledger holds ${lines.join(", ") || "nothing"}, written by ${names.join(", ")}`);
  }
  return { found, states: INTERLEAVINGS.length };
}

test("A5 record transactions, bound: up to 3 writers of one ledger, each nested inside another's open transaction or after it (5 interleavings); flow: the heartbeat and the lead append records at the same time; loss: data, an appended line lost", () => {
  const { found, states } = transactionCounterexamples();
  assert.deepEqual(found, []);
  assert.equal(states, 5);
  assert.ok(transactionCounterexamples({ stale: true }).found.length, "seeded defect: a writer that reads the ledger outside its transaction");
});
