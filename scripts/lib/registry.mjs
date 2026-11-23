// The owner store's product registry (`products.json`, design §5.2) and how a command finds the loop configuration of the
// product it runs for (§2.2). One owner store per owner; the registry names every product the lead runs, so `tick` and
// `next --all` see each of them (I-0001: a product the driver does not know about stands still unnoticed).
//
// products.json: { "products": [ { "name": "example-app", "records": "/abs/example-loop", "aliases": ["ExampleApp"] } ],
//                  "roots": ["/abs/projects"] }
// - name: lower-case letters, digits and inner hyphens; the product's name in qualified citations (`example-app:D-0046`).
// - records: the absolute path of the product's records repository; its `loop.json` is the product's loop.
// - aliases: other names the owner uses for the product (routing of words, slice 4).
// - roots: absolute folders under which `tick` and `start` look for records repositories nobody registered.
// Names and aliases share one namespace (case-insensitive); a records repository is registered once.
//
// A command finds its configuration by --config, else SELF_LOOP_CONFIG, else the registered product whose folders
// contain the working directory: its records repository, the product checkout its loop.json names, and the folders its
// loop.json lists under `projects`. None or several candidates is a usage error naming them, never a guess.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gitOk } from "./git-plumbing.mjs";
import { HEAVY_ROLES, load, loadDir, preparedIn, Stop } from "../call.mjs";
import { UsageError } from "./args.mjs";
import { commitRecords } from "./records-commit.mjs";
import { measureHost, overBound } from "./host.mjs";
import { MAX_LOAD_RATIO, MIN_AVAILABLE_MEMORY_GB, MIN_AVAILABLE_MEMORY_SHARE, ON_STALL, ROOT_SCAN_FOLDERS } from "./thresholds.mjs";

export const REGISTRY = "products.json";
export const LOOP = "loop.json";
export const STORE_ENV = "SELF_LOOP_OWNER_STORE";
export const CONFIG_ENV = "SELF_LOOP_CONFIG";
export const HOST_BOUND = { maxLoadRatio: MAX_LOAD_RATIO, minAvailableMemoryGB: MIN_AVAILABLE_MEMORY_GB, minAvailableMemoryShare: MIN_AVAILABLE_MEMORY_SHARE };
const BOUND_FIELDS = ["maxLoadRatio", "minAvailableMemoryGB"];
const FIELDS = ["products", "roots", ...BOUND_FIELDS];
const RETIRED = ["heavyBudget"];
const NAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const oneLine = value => typeof value === "string" && value.trim().length > 0 && !/[\n\r\t]/.test(value);

/** A malformed registry: the command cannot know which products exist (exit 64). */
export class RegistryError extends UsageError {}

/** The canonical form of a folder: its real path when it exists. */
export const real = path => { try { return realpathSync(path); } catch { return resolve(path); } };
const inside = (path, dir) => path === dir || path.startsWith(dir.endsWith(sep) ? dir : dir + sep);

/** Where the owner store is: --owner-store, else SELF_LOOP_OWNER_STORE, else ~/.self-loop/owner-store. */
export function resolveOwnerStore({ flag, env = process.env, home = homedir() } = {}) {
  if (flag) return { path: resolve(flag), source: "--owner-store" };
  if (env[STORE_ENV]) return { path: resolve(env[STORE_ENV]), source: STORE_ENV };
  return { path: join(home, ".self-loop", "owner-store"), source: "default" };
}

/** Parse and validate the text of products.json. */
export function parseRegistry(text, source = REGISTRY) {
  const fail = message => { throw new RegistryError(`${source}: ${message}`); };
  let data;
  try { data = JSON.parse(text); } catch (e) { fail(`not valid JSON (${e.message})`); }
  if (!object(data)) fail("must be an object with a products list");
  for (const key of Object.keys(data)) if (![...FIELDS, ...RETIRED].includes(key)) fail(`unknown field "${key}" (${FIELDS.join(", ")})`);
  if ("maxLoadRatio" in data && !(typeof data.maxLoadRatio === "number" && Number.isFinite(data.maxLoadRatio) && data.maxLoadRatio > 0))
    fail(`maxLoadRatio must be a positive number (the 1-minute load average allowed per core), got ${JSON.stringify(data.maxLoadRatio)}`);
  if ("minAvailableMemoryGB" in data && !(typeof data.minAvailableMemoryGB === "number" && Number.isFinite(data.minAvailableMemoryGB) && data.minAvailableMemoryGB >= 0))
    fail(`minAvailableMemoryGB must be a number from 0 (GiB), got ${JSON.stringify(data.minAvailableMemoryGB)}`);
  if (!Array.isArray(data.products)) fail("products must be a list");
  const names = new Map(), paths = new Map();
  // A product may repeat its own name as an alias in another case ("ExampleApp" for example-app); another product's is a clash.
  const claim = (name, owner, what) => {
    const key = name.toLowerCase();
    if (names.has(key) && names.get(key) !== owner) fail(`${what} ${name} of ${owner} is already a name or alias of ${names.get(key)}`);
    names.set(key, owner);
  };
  const products = data.products.map((p, i) => {
    if (!object(p)) fail(`products[${i}] must be an object`);
    for (const key of Object.keys(p)) if (!["name", "records", "aliases"].includes(key)) fail(`products[${i}] has unknown field "${key}" (name, records, aliases)`);
    if (typeof p.name !== "string" || !NAME.test(p.name)) fail(`products[${i}].name must be lower-case letters, digits and inner hyphens, got ${JSON.stringify(p.name)}`);
    if (data.products.findIndex(q => q?.name === p.name) !== i) fail(`${p.name} is registered twice`);
    claim(p.name, p.name, "name");
    if (typeof p.records !== "string" || !isAbsolute(p.records)) fail(`${p.name}: records must be an absolute path, got ${JSON.stringify(p.records)}`);
    const records = resolve(p.records);
    if (paths.has(records)) fail(`${records} is registered for both ${paths.get(records)} and ${p.name}`);
    paths.set(records, p.name);
    const aliases = p.aliases ?? [];
    if (!Array.isArray(aliases) || !aliases.every(oneLine)) fail(`${p.name}: aliases must be a list of one-line names`);
    return { name: p.name, records, aliases: [...aliases] };
  });
  for (const p of products) for (const alias of p.aliases) claim(alias, p.name, "alias");
  const roots = data.roots ?? [];
  if (!Array.isArray(roots) || !roots.every(r => typeof r === "string" && isAbsolute(r))) fail("roots must be a list of absolute paths");
  const overrides = BOUND_FIELDS.filter(key => key in data);
  const bound = { ...HOST_BOUND, ...Object.fromEntries(overrides.map(key => [key, data[key]])),
    ...("minAvailableMemoryGB" in data ? { minAvailableMemoryShare: null } : {}),
    source: overrides.length ? `${source} ${overrides.join(", ")}` : "the defaults of lib/thresholds.mjs" };
  return { products, roots: roots.map(r => resolve(r)), bound, retired: RETIRED.filter(key => key in data) };
}

/** The registry of an owner store (working file). A missing store or registry is a usage error naming where it looked. */
export function loadRegistry(store) {
  const file = join(store.path, REGISTRY);
  if (!existsSync(file))
    throw new RegistryError(`no product registry at ${file} (owner store from ${store.source}); create it with \`self-loop registry init\`, or pass --owner-store <dir> or set ${STORE_ENV}`);
  return parseRegistry(readFileSync(file, "utf8"), file);
}

/** loop.json fields this driver reads beyond call.mjs's: the product's project folders and its tick settings. */
export function loopSettings(cfg, configPath) {
  const projects = cfg.projects ?? [];
  if (!Array.isArray(projects) || !projects.every(oneLine)) throw new Error(`${configPath}: projects must be a list of folders`);
  const tick = cfg.tick ?? {};
  if (!object(tick)) throw new Error(`${configPath}: tick must be an object`);
  for (const key of Object.keys(tick)) if (!["stallHours", "onStall"].includes(key)) throw new Error(`${configPath}: unknown tick field "${key}" (stallHours, onStall)`);
  if ("stallHours" in tick && !(typeof tick.stallHours === "number" && tick.stallHours > 0)) throw new Error(`${configPath}: tick.stallHours must be a positive number`);
  if ("onStall" in tick && !ON_STALL.includes(tick.onStall)) throw new Error(`${configPath}: tick.onStall must be one of ${ON_STALL.join(", ")}, got ${JSON.stringify(tick.onStall)}`);
  return { projects: projects.map(p => resolve(dirname(configPath), p)), stallHours: tick.stallHours ?? null, onStall: tick.onStall ?? "show" };
}

/**
 * One registered product as found on disk: whether its records exist, its loop.json (null when it has none), the parsed
 * configuration, and the folders that belong to it. `error` holds why a loop.json present cannot be used.
 * The records a driver reads and writes are the registered folder that holds the loop.json, whatever its `records`
 * field says: a moved or copied records repository must never make the driver write into another one.
 */
export function productState(entry) {
  const state = { ...entry, exists: existsSync(entry.records), loop: null, cfg: null, settings: null, error: null, dirs: [real(entry.records)] };
  if (!state.exists) return state;
  const file = join(entry.records, LOOP);
  if (!existsSync(file)) return state;
  state.loop = file;
  try {
    const cfg = load(file);
    state.settings = loopSettings(cfg, file);
    state.cfg = { ...cfg, records: entry.records };
    state.dirs.push(real(state.cfg.product), ...state.settings.projects.map(real));
  } catch (e) {
    state.error = e instanceof Stop || e instanceof SyntaxError ? `${file}: ${e.message}` : e.message;
  }
  return state;
}

const named = products => products.map(p => `${p.name} (${p.records})`).join(", ") || "none";

/**
 * The configuration a command runs on: { config, product } where product is the registered entry (null for an
 * explicit --config or SELF_LOOP_CONFIG). `store` is a function returning the owner store, called only when needed.
 */
export function resolveConfig({ config, env = process.env, cwd = process.cwd(), store }) {
  if (config) return { config: resolve(cwd, config), product: null, source: "--config" };
  if (env[CONFIG_ENV]) return { config: resolve(cwd, env[CONFIG_ENV]), product: null, source: CONFIG_ENV };
  const registry = loadRegistry(store());
  const here = real(cwd);
  const states = registry.products.map(productState);
  const candidates = states.filter(s => s.dirs.some(dir => inside(here, dir)));
  if (!candidates.length)
    throw new UsageError(`no registered product contains ${here}; registered: ${named(states)}. Pass --config <loop.json>, or --all for every product`);
  if (candidates.length > 1)
    throw new UsageError(`${here} belongs to ${candidates.length} registered products: ${named(candidates)}. Pass --config <loop.json>`);
  const [product] = candidates;
  if (!product.loop) throw new UsageError(`${product.name} (${product.records}) has no loop.json: no loop, so neither next nor stall can see it`);
  if (product.error) throw new UsageError(`${product.name}: ${product.error}`);
  return { config: product.loop, product, source: "registry" };
}

const gitCommonDir = dir => {
  const r = spawnSync("git", ["-C", dir, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" });
  return r.status === 0 ? real(r.stdout.trim()) : null;
};

/**
 * Records repositories under the registry's roots that the registry does not name (I-0001). A records repository is the
 * top of its own Git working tree (a `.git` entry) holding `records.json`. So a product's test fixtures, which Git tracks
 * as plain folders of the product's repository, are never one, while a records repository is found wherever it sits under
 * a root: at any depth, in an ordinary folder, nested in a code repository, under a root that is itself a repository.
 * Not searched: hidden folders (tool state: `.git`, caches, editor worktrees), `node_modules`, symbolic links, and
 * `exclude` (the owner store, and every registered loop's work folder, whose role workspaces hold record views, worktrees
 * and probes, never a product). Another worktree of a registered repository is the registered repository.
 * Returns { unregistered: [{ path, loop }], problems: [{ path, detail }] }. A root that does not exist or cannot be read,
 * a folder that cannot be read, and a root whose search reached `limit` folders are problems: nothing is missed silently.
 */
export function discoverRecords(registry, { exclude = [], limit = ROOT_SCAN_FOLDERS } = {}) {
  const known = new Set(registry.products.flatMap(p => [real(p.records), gitCommonDir(p.records)]).filter(Boolean));
  const skipped = new Set(exclude.map(real));
  const unregistered = [], problems = [], seen = new Set();
  for (const root of registry.roots) {
    if (!existsSync(root)) {
      problems.push({ path: root, detail: "the registry root does not exist, so no records repository under it can be found" });
      continue;
    }
    // Symbolic links are never followed, so below the root's real path every folder's real path is that path plus its
    // own relative path: no realpath call per folder.
    const base = real(root), realOf = dir => base + dir.slice(root.length);
    // Breadth first, in name order: records repositories sit near the top of a root, so a search that reaches its bound
    // has covered the shallow levels where they are most likely.
    const queue = [root];
    let read = 0;
    while (read < queue.length) {
      if (read === limit) {
        problems.push({ path: root, detail: `the search under this registry root stopped after ${limit} folders; records repositories deeper in it may be missed (narrow roots in ${REGISTRY})` });
        break;
      }
      const dir = queue[read++];
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); }
      catch (e) {
        problems.push({ path: dir, detail: `${dir === root ? "the registry root" : "a folder under a registry root"} cannot be read (${e.code ?? e.message})` });
        continue;
      }
      if (entries.some(e => e.name === ".git") && entries.some(e => e.name === "records.json" && e.isFile())) {
        const path = realOf(dir), id = gitCommonDir(dir);
        if (!known.has(path) && !(id && known.has(id)) && !skipped.has(path) && !seen.has(path) && !(id && seen.has(id))) {
          unregistered.push({ path: dir, loop: entries.some(e => e.name === LOOP) });
          for (const key of [path, id]) if (key) seen.add(key);
        }
      }
      const children = entries.filter(e => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules")
        .map(e => join(dir, e.name)).filter(child => !skipped.has(realOf(child)));
      queue.push(...children.sort());
    }
  }
  return { unregistered, problems };
}

const SKELETON = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "assets", "owner-store");

/** A skeleton owner store: a new Git repository holding README.md and products.json, committed. Never overwrites. */
export function initStore(path, { roots = [] } = {}) {
  if (existsSync(path) && readdirSync(path).length) throw new UsageError(`${path} exists and is not empty; an owner store is never overwritten`);
  const registry = { ...JSON.parse(readFileSync(join(SKELETON, REGISTRY), "utf8")), roots: roots.map(r => resolve(r)) };
  parseRegistry(JSON.stringify(registry));
  mkdirSync(path, { recursive: true });
  const g = (...argv) => { const r = spawnSync("git", ["-C", path, ...argv], { encoding: "utf8" }); if (r.status !== 0) throw new Error(`git ${argv.join(" ")}: ${r.stderr}`); };
  g("init", "-q");
  writeFileSync(join(path, "README.md"), readFileSync(join(SKELETON, "README.md")));
  writeFileSync(join(path, REGISTRY), JSON.stringify(registry, null, 2) + "\n");
  g("add", "--", "README.md", REGISTRY);
  g("commit", "-q", "--no-verify", "-m", "Owner store: an empty product registry", "--", "README.md", REGISTRY);
  return path;
}

/** Register a product: validated against the committed registry and committed through the records commit helper. */
export function addProduct(path, { name, records, aliases = [] }) {
  if (!records || !isAbsolute(records)) throw new UsageError(`--records must be an absolute path, got ${JSON.stringify(records)}`);
  if (!existsSync(join(records, "records.json"))) throw new UsageError(`${records} holds no records.json: not a records repository`);
  const entry = { name, records: real(records), ...(aliases.length ? { aliases } : {}) };
  if (!existsSync(join(path, ".git"))) throw new RegistryError(`${path} is not an owner store (no Git repository); create it with \`self-loop registry init\``);
  const { value } = commitRecords(path, ({ read, add }) => {
    const text = read(REGISTRY);
    if (!text) throw new RegistryError(`${path} has no committed ${REGISTRY}`);
    const taken = parseRegistry(text, join(path, REGISTRY)).products.find(p => real(p.records) === entry.records);
    if (taken) throw new RegistryError(`${entry.records} is already registered as ${taken.name}`);
    const current = JSON.parse(text);
    const next = { ...current, products: [...current.products, entry] };
    parseRegistry(JSON.stringify(next), join(path, REGISTRY));
    add(REGISTRY, JSON.stringify(next, null, 2) + "\n");
    return { message: `Register ${name} (${entry.records})`, value: entry };
  });
  return value;
}

const alive = pid => {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
};

export function hostLoad({ store, cfg = null, env = process.env, measure = measureHost } = {}) {
  const problems = [], calls = [];
  let bound = { ...HOST_BOUND, source: "the defaults of lib/thresholds.mjs" }, retired = [], loops = [];
  try {
    const registry = loadRegistry(store);
    bound = registry.bound;
    retired = registry.retired.map(key => `${join(store.path, REGISTRY)} ${key} is no longer read: the bound is the measured host state (D-0025)`);
    const states = registry.products.map(productState);
    for (const p of states) if (p.error) problems.push(`${p.name}: ${p.error}`);
    loops = states.filter(p => p.cfg).map(p => ({ name: p.name, cfg: p.cfg }));
  } catch (error) { problems.push(error.message); }
  if (cfg) loops.unshift({ name: null, cfg });
  const seen = new Set();
  for (const { name, cfg: loop } of loops) {
    const work = real(loop.workDir);
    if (seen.has(work)) continue;
    seen.add(work);
    let prepared;
    try { prepared = preparedIn(loop); } catch (error) { problems.push(`${loop.workDir}: ${error.message}`); continue; }
    for (const p of prepared)
      if (HEAVY_ROLES.includes(p.role) && p.liveWorkspace && !gitOk(loop.records, "cat-file", "-e", `HEAD:${p.record}`))
        calls.push({ kind: "prepared", role: p.role, line: `prepared ${p.role} ${p.id}${name ? ` · ${name}` : ""} · ${p.ws}` });
  }
  const dir = loadDir(env);
  let entries = [];
  try { entries = readdirSync(dir); } catch (error) { if (error.code !== "ENOENT") problems.push(`${dir}: ${error.message}`); }
  for (const entry of entries.sort()) {
    const kind = /^(call|suite)-\d+-\d+\.json$/.exec(entry)?.[1];
    if (!kind) continue;
    let lease;
    try { lease = JSON.parse(readFileSync(join(dir, entry), "utf8")); } catch { continue; }
    if (lease?.kind !== kind || !Number.isInteger(lease.pid) || !alive(lease.pid)) continue;
    if (kind === "call" && HEAVY_ROLES.includes(lease.role))
      calls.push({ kind, role: lease.role, pid: lease.pid, id: lease.id ?? null, records: lease.records ?? null,
        line: `running ${lease.role} call${lease.id ? ` ${lease.id}` : ""} · pid ${lease.pid} · ${lease.records ?? "records unknown"}` });
    if (kind === "suite")
      calls.push({ kind, line: `suite · pid ${lease.pid} · ${lease.repo ?? "repository unknown"}${lease.sha ? ` at ${lease.sha}` : ""}` });
  }
  const measured = measure();
  const over = overBound(measured, bound);
  return { calls, problems, retired, bound, measured, over, admits: over.length === 0 };
}
