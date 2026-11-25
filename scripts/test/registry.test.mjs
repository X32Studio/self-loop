// I-0001, D-0009, D-0010, D-0052, R-0032-reviewer-architecture
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { load } from "../call.mjs";
import { DEFAULT_HOOK_ALLOW, hostLoad, loadHookStore, matchHookProduct, parseRegistry, resolveOwnerStore } from "../lib/registry.mjs";
import { git, isolatedEnv, loopProduct, ownerStore, repo, selfLoop, temp } from "./helpers.mjs";

const entry = (name, records, aliases) => ({ name, records, ...(aliases ? { aliases } : {}) });

test("the registry names each product once, by an absolute records path, and refuses unknown fields", () => {
  const ok = parseRegistry(JSON.stringify({ products: [entry("example-app", "/r/example-app", ["ExampleApp"]), entry("self-loop", "/r/self")], roots: ["/r"] }));
  assert.deepEqual(ok.products.map(p => p.name), ["example-app", "self-loop"]);
  assert.deepEqual(ok.products[1].aliases, []);
  assert.deepEqual(ok.roots, ["/r"]);
  assert.deepEqual(parseRegistry(JSON.stringify({ products: [] })).roots, []);
  const refused = [
    [{ products: [entry("a", "/r/a"), entry("a", "/r/b")] }, /a.*twice|duplicate/i],
    [{ products: [entry("a", "/r/a"), entry("b", "/r/a")] }, /\/r\/a/],
    [{ products: [entry("a", "/r/a", ["B"]), entry("b", "/r/b")] }, /alias/i],
    [{ products: [entry("a", "relative/path")] }, /absolute/],
    [{ products: [entry("ExampleApp:x", "/r/a")] }, /name/],
    [{ products: [{ name: "a", record: "/r/a" }] }, /record/],
    [{ products: [entry("a", "/r/a")], extra: true }, /extra/],
    [{ products: [entry("a", "/r/a")], roots: ["projects"] }, /absolute/],
    [{ roots: [] }, /products/],
    [{ products: [], maxLoadRatio: 0 }, /maxLoadRatio/],
    [{ products: [], maxLoadRatio: "0.7" }, /maxLoadRatio/],
    [{ products: [], minAvailableMemoryGB: -1 }, /minAvailableMemoryGB/],
    [{ products: [], minAvailableMemoryGB: null }, /minAvailableMemoryGB/],
  ];
  const defaults = parseRegistry(JSON.stringify({ products: [] }));
  assert.deepEqual(defaults.bound, { maxLoadRatio: 0.7, minAvailableMemoryGB: 16, minAvailableMemoryShare: 0.25, source: "the defaults of lib/thresholds.mjs" });
  assert.deepEqual(defaults.retired, []);
  const tuned = parseRegistry(JSON.stringify({ products: [], maxLoadRatio: 1.5, minAvailableMemoryGB: 0, heavyBudget: 3 }));
  assert.deepEqual(tuned.bound, { maxLoadRatio: 1.5, minAvailableMemoryGB: 0, minAvailableMemoryShare: null, source: "products.json maxLoadRatio, minAvailableMemoryGB" });
  assert.deepEqual(tuned.retired, ["heavyBudget"], "a store written for round 6 still loads; heavyBudget is named as no longer read");
  assert.equal(parseRegistry(JSON.stringify({ products: [], heavyBudget: "any" })).retired[0], "heavyBudget");
  for (const [registry, reason] of refused) assert.throws(() => parseRegistry(JSON.stringify(registry)), reason, JSON.stringify(registry));
  assert.throws(() => parseRegistry("{ not json"), /products\.json/);
});

test("the owner store comes from --owner-store, then SELF_LOOP_OWNER_STORE, then ~/.self-loop/owner-store", () => {
  assert.deepEqual(resolveOwnerStore({ flag: "/a", env: { SELF_LOOP_OWNER_STORE: "/b" }, home: "/h" }), { path: "/a", source: "--owner-store" });
  assert.deepEqual(resolveOwnerStore({ env: { SELF_LOOP_OWNER_STORE: "/b" }, home: "/h" }), { path: "/b", source: "SELF_LOOP_OWNER_STORE" });
  assert.deepEqual(resolveOwnerStore({ env: {}, home: "/h" }), { path: "/h/.self-loop/owner-store", source: "default" });

  const a = loopProduct(), store = ownerStore([entry("alpha", a.records)]);
  const env = isolatedEnv();
  mkdirSync(join(env.HOME, ".self-loop"), { recursive: true });
  const linked = join(env.HOME, ".self-loop", "owner-store");
  git(env.HOME, "clone", "-q", store, linked);
  const listed = selfLoop(["registry", "list", "--json"], { env });
  assert.equal(listed.status, 0, listed.stderr);
  assert.deepEqual(JSON.parse(listed.stdout).products.map(p => p.name), ["alpha"]);
  const missing = selfLoop(["registry", "list"], { env: { ...env, SELF_LOOP_OWNER_STORE: join(env.HOME, "nowhere") } });
  assert.equal(missing.status, 64);
  assert.match(missing.stderr, /SELF_LOOP_OWNER_STORE/);
});

test("inside a registered project next and stall find the configuration with no flags", () => {
  const project = temp("self-loop-lead-checkout-");
  const a = loopProduct({ activity: new Date().toISOString(), loop: { projects: [project] } });
  const b = loopProduct();
  const store = ownerStore([entry("alpha", a.records), entry("beta", b.records)]);
  const env = isolatedEnv({ SELF_LOOP_OWNER_STORE: store });
  mkdirSync(join(project, "deep", "er"), { recursive: true });
  for (const cwd of [a.records, join(a.records, "blueprint"), a.product, join(project, "deep", "er")]) {
    const next = selfLoop(["next"], { cwd, env });
    assert.equal(next.status, 0, `${cwd}: ${next.stderr}`);
    assert.match(next.stdout, /Phase v1 · loop\/v1/);
    const stall = selfLoop(["stall", "--hours", "1"], { cwd, env });
    assert.equal(stall.status, 0, stall.stderr);
    assert.match(stall.stdout, /alpha.*active/);
  }
  const other = selfLoop(["next"], { cwd: b.product, env });
  assert.equal(other.status, 0, other.stderr);
  assert.match(other.stdout, /^== beta · /, "a product found through the registry is named");
});

test("zero or several candidate products is a usage error naming them, never a guess", () => {
  const shared = temp("self-loop-shared-");
  const a = loopProduct({ loop: { projects: [shared] } });
  const b = loopProduct({ loop: { projects: [shared] } });
  const store = ownerStore([entry("alpha", a.records), entry("beta", b.records)]);
  const env = isolatedEnv({ SELF_LOOP_OWNER_STORE: store });
  for (const command of [["next"], ["stall", "--hours", "1"]]) {
    const several = selfLoop(command, { cwd: shared, env });
    assert.equal(several.status, 64, several.stderr);
    assert.match(several.stderr, /alpha/);
    assert.match(several.stderr, /beta/);
    const none = selfLoop(command, { cwd: temp("self-loop-elsewhere-"), env });
    assert.equal(none.status, 64, none.stderr);
    assert.match(none.stderr, /alpha/);
    assert.match(none.stderr, /beta/);
    assert.match(none.stderr, /--all|--config/);
  }
  const explicit = selfLoop(["next", "--config", join(b.records, "loop.json")], { cwd: shared, env });
  assert.equal(explicit.status, 0, explicit.stderr);
  const fromEnv = selfLoop(["next"], { cwd: shared, env: { ...env, SELF_LOOP_CONFIG: join(a.records, "loop.json") } });
  assert.equal(fromEnv.status, 0, fromEnv.stderr);
  assert.equal(selfLoop(["next", "--all", "--config", join(a.records, "loop.json")], { cwd: shared, env }).status, 64);
});

test("a registered product without loop.json is named as having no loop", () => {
  const a = loopProduct({ loopJson: false });
  const b = loopProduct({ activity: new Date().toISOString() });
  const store = ownerStore([entry("alpha", a.records), entry("beta", b.records)]);
  const env = isolatedEnv({ SELF_LOOP_OWNER_STORE: store });
  const inside = selfLoop(["next"], { cwd: a.records, env });
  assert.equal(inside.status, 64);
  assert.match(inside.stderr, /alpha.*no loop/);
  const all = selfLoop(["next", "--all"], { cwd: temp(), env });
  assert.equal(all.status, 0, all.stderr);
  assert.match(all.stdout, /alpha[^\n]*\n[^\n]*no loop/);
  assert.match(all.stdout, /beta[\s\S]*Phase v1 · loop\/v1/);
  const stall = selfLoop(["stall", "--all", "--hours", "1"], { cwd: temp(), env });
  assert.match(stall.stdout, /alpha.*no loop/);
  assert.match(stall.stdout, /beta.*active/);
});

test("registry init makes a skeleton owner store and add commits a validated registry", () => {
  const store = join(temp(), "owner-store");
  const env = isolatedEnv({ SELF_LOOP_OWNER_STORE: store });
  const init = selfLoop(["registry", "init"], { env });
  assert.equal(init.status, 0, init.stderr);
  assert.deepEqual(git(store, "ls-files").split("\n").sort(), ["README.md", "products.json"]);
  assert.equal(git(store, "status", "--porcelain"), "");
  assert.equal(selfLoop(["registry", "init"], { env }).status, 64, "an existing store is never overwritten");
  const a = loopProduct();
  const add = selfLoop(["registry", "add", "--name", "alpha", "--records", a.records, "--aliases", "Alpha,阿尔法"], { env });
  assert.equal(add.status, 0, add.stderr);
  assert.equal(git(store, "status", "--porcelain"), "");
  const registry = JSON.parse(readFileSync(join(store, "products.json"), "utf8"));
  assert.deepEqual(registry.products, [{ name: "alpha", records: realpathSync(a.records), aliases: ["Alpha", "阿尔法"] }]);
  const head = git(store, "rev-parse", "HEAD");
  for (const argv of [["--name", "alpha", "--records", loopProduct().records], ["--name", "beta", "--records", a.records], ["--name", "gamma", "--records", "relative"]]) {
    const refused = selfLoop(["registry", "add", ...argv], { env });
    assert.equal(refused.status, 64, refused.stdout);
  }
  assert.equal(git(store, "rev-parse", "HEAD"), head);
  const listed = JSON.parse(selfLoop(["registry", "list", "--json"], { env }).stdout);
  assert.equal(listed.products[0].loop, true);
  writeFileSync(join(store, "products.json"), "{ broken");
  const broken = selfLoop(["next", "--all"], { env });
  assert.equal(broken.status, 64);
  assert.match(broken.stderr, /products\.json/);
  assert.ok(existsSync(join(store, "README.md")));
});

test("a plain directory with records.json is not a product until registered", () => {
  const dir = repo({ "records.json": "{}\n", "loop.json": "{}\n" });
  const store = ownerStore([]);
  const r = selfLoop(["next"], { cwd: dir, env: isolatedEnv({ SELF_LOOP_OWNER_STORE: store }) });
  assert.equal(r.status, 64);
  assert.match(r.stderr, /no registered product/);
});


test("the host load counts live heavy work over every registered loop and the leases, once each", () => {
  const a = loopProduct(), b = loopProduct();
  const store = ownerStore([entry("a", a.records), entry("b", b.records)]);
  const env = { SELF_LOOP_LOAD_DIR: temp("self-loop-load-") };
  const prepare = (p, role, round, { live = true, recorded = false } = {}) => {
    const ws = join(p.dir, "work", `${String(round).padStart(4, "0")}-${role}-x`);
    mkdirSync(join(ws, live ? "wt" : "gone"), { recursive: true });
    const record = `rounds/${String(round).padStart(4, "0")}-${role}.md`;
    writeFileSync(join(ws, "call.json"), JSON.stringify({ version: 2, ws, wt: join(ws, "wt"), nonce: "n", role, round, step: role, record, id: `R-${String(round).padStart(4, "0")}-${role}`, phase: "v1" }));
    if (recorded) { mkdirSync(join(p.records, "rounds"), { recursive: true }); writeFileSync(join(p.records, record), "# recorded\n"); git(p.records, "add", "-A"); git(p.records, "commit", "-qm", "record"); }
  };
  prepare(a, "critic", 2);
  prepare(a, "actor", 3, { live: false });
  prepare(b, "judge", 4, { recorded: true });
  prepare(b, "actor", 5);
  const lease = (name, data) => writeFileSync(join(env.SELF_LOOP_LOAD_DIR, name), JSON.stringify(data));
  lease("call-1-0.json", { kind: "call", pid: process.pid, role: "judge", records: a.records });
  lease("call-2-0.json", { kind: "call", pid: process.pid, role: "reviewer", records: a.records });
  lease("suite-3-0.json", { kind: "suite", pid: process.pid, repo: b.product, sha: "0".repeat(40) });
  lease("suite-4-0.json", { kind: "suite", pid: 2 ** 22 + 1, repo: b.product });
  lease("suite-5-0.json", { kind: "call", pid: process.pid, role: "actor" });
  lease("notes.json", { kind: "suite", pid: process.pid });
  const busy = () => ({ load1: 99, cores: 4, availableGiB: 1, totalGiB: 64, load: "test", memory: "test", total: "test" });
  const read = cfg => hostLoad({ store: { path: store, source: "test" }, cfg, env, measure: busy });
  const counted = read(load(join(a.records, "loop.json")));
  assert.deepEqual(counted.calls.map(c => c.role ?? c.kind).sort(), ["actor", "critic", "judge", "suite"]);
  assert.deepEqual(counted.problems, []);
  assert.equal(counted.admits, false);
  assert.equal(counted.over.length, 2);
  const idle = hostLoad({ store: { path: store, source: "test" }, env, measure: () => ({ ...busy(), load1: 0, availableGiB: 64 }) });
  assert.equal(idle.admits, true, "four heavy calls are shown, never a bound");
  assert.equal(idle.calls.length, 4);
  const alone = hostLoad({ store: { path: join(store, "missing"), source: "test" }, cfg: load(join(a.records, "loop.json")), env, measure: busy });
  assert.deepEqual(alone.calls.map(c => c.role ?? c.kind).sort(), ["critic", "judge", "suite"], "without a registry the named loop and the leases still count");
  assert.match(alone.problems.join("\n"), /no product registry/);
  assert.equal(alone.bound.minAvailableMemoryGB, 16, "without a registry the defaults bound the host");
});

test("loadHookStore and matchHookProduct validate fail-closed and route primary, worktree, child, and ambiguous dirs", () => {
  const shared = temp("hook-shared-");
  const a = loopProduct({ loop: { projects: [shared] } });
  const b = loopProduct({ loop: { projects: [shared] } });
  const bWt = temp("hook-b-wt-");
  git(b.product, "worktree", "add", "-q", "--detach", bWt);
  const store = ownerStore([entry("alpha", a.records), entry("beta", b.records)]);
  const loaded = loadHookStore(store);
  assert.equal(loaded.ok, true, loaded.error);
  assert.equal(loaded.products.length, 2);
  assert.deepEqual(loaded.products[0].allow, [...DEFAULT_HOOK_ALLOW]);

  assert.equal(matchHookProduct([a.product], loaded.products).product.name, "alpha");
  const wtMatch = matchHookProduct([bWt], loaded.products);
  assert.equal(wtMatch.status, "matched");
  assert.equal(wtMatch.product.name, "beta");
  assert.ok(wtMatch.projects.some(p => realpathSync(p) === realpathSync(bWt)));
  assert.equal(matchHookProduct([join(a.dir, "work", "0001-actor", "wt")], loaded.products).status, "skip");
  assert.equal(matchHookProduct([temp("unregistered-")], loaded.products).status, "skip");
  const unregAndWt = matchHookProduct([temp("unregistered-"), bWt], loaded.products);
  assert.equal(unregAndWt.status, "matched");
  assert.equal(unregAndWt.product.name, "beta");
  const ambigShared = matchHookProduct([shared], loaded.products);
  assert.equal(ambigShared.status, "ambiguous");
  assert.deepEqual(ambigShared.products, ["alpha", "beta"]);
  const ambigMulti = matchHookProduct([a.product, bWt], loaded.products);
  assert.equal(ambigMulti.status, "ambiguous");
  assert.deepEqual(ambigMulti.products, ["alpha", "beta"]);
  assert.match(ambigMulti.error, /alpha.*beta/);

  assert.equal(loadHookStore("").ok, false);
  assert.equal(loadHookStore(temp("no-reg-")).ok, false);
});
