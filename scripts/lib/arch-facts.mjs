// P-0011, P-0012, D-0058, D-0059, design/two-loop-rhythm.md#3, design/parallel-dispatch.md#1
import { posix } from "node:path";
import { ANTI_ROT_THRESHOLDS, antiRotBreaches, scanAntiRot } from "./anti-rot.mjs";
import { blobs, gitOk, regularFiles, run } from "./git-plumbing.mjs";

export const ARCH_THRESHOLDS = Object.freeze({
  softLines: 500,
  hardLines: 800,
  growthPct: 35,
  churnCommits: 3,
  maxTop: 10,
});

const DEFAULT_EXTS = Object.freeze([".js", ".mjs", ".cjs", ".ts", ".tsx", ".py", ".go", ".rs"]);
const JS_TS_EXTS = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx"]);
const RESOLVE_EXTS = [".js", ".mjs", ".cjs", ".ts", ".tsx"];
const IGNORE_DIRS = new Set(["node_modules", "dist", "build", ".git"]);
const TEST_DIRS = new Set(["test", "tests", "acceptance", "test-support"]);
const TEST_FILE_RE = /\.(?:test|spec)\.[cm]?[jt]sx?$/i;
const ROLE_SUFFIX_RE = /^(?:(.+?)[-_])?(kernel|runtime|scheduler|engine|runner|dispatcher|registry|store|manager|controller)$/i;
const IMPORT_FROM_RE = /(?:^|[;\n])\s*(?:import|export)\s+(?:type\s+)?(?:[^;{}'"\n]*|\{[^}]*\})\s+from\s+["']([^"']+)["']/gm;
const SIDE_EFFECT_IMPORT_RE = /(?:^|[;\n])\s*import\s+["']([^"']+)["']/gm;

function isSourcePath(filePath, extSet) {
  const parts = filePath.split("/");
  for (let i = 0; i < parts.length - 1; i++) {
    if (IGNORE_DIRS.has(parts[i]) || TEST_DIRS.has(parts[i])) return false;
  }
  if (TEST_FILE_RE.test(filePath)) return false;
  const ext = posix.extname(filePath).toLowerCase();
  return extSet.has(ext);
}

function isTestPath(filePath, extSet) {
  const parts = filePath.split("/");
  let inTestDir = false;
  for (let i = 0; i < parts.length - 1; i++) {
    if (IGNORE_DIRS.has(parts[i])) return false;
    if (TEST_DIRS.has(parts[i])) inTestDir = true;
  }
  const ext = posix.extname(filePath).toLowerCase();
  return extSet.has(ext) && (inTestDir || TEST_FILE_RE.test(filePath));
}

function countLines(text) {
  if (!text) return 0;
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return text.charCodeAt(text.length - 1) === 10 ? n : n + 1;
}

function extractRelativeSpecifiers(source) {
  const stripped = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const specs = new Set();
  for (const re of [IMPORT_FROM_RE, SIDE_EFFECT_IMPORT_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(stripped)) !== null) {
      const spec = m[1];
      if (spec.startsWith("./") || spec.startsWith("../")) specs.add(spec);
    }
  }
  return [...specs];
}

function resolveImport(fromPath, spec, knownFiles) {
  const base = posix.normalize(posix.join(posix.dirname(fromPath), spec));
  if (base.startsWith("..")) return null;
  if (knownFiles.has(base)) return base;
  for (const ext of RESOLVE_EXTS) {
    if (knownFiles.has(base + ext)) return base + ext;
  }
  for (const ext of RESOLVE_EXTS) {
    const idx = posix.join(base, `index${ext}`);
    if (knownFiles.has(idx)) return idx;
  }
  return null;
}

function collectChurn(productRepo, baselineSha, sha, extSet, limits) {
  if (!baselineSha || baselineSha === sha) return [];
  if (!gitOk(productRepo, "merge-base", "--is-ancestor", baselineSha, sha)) return [];
  const raw = run(
    "git",
    ["-C", productRepo, "log", "--first-parent", "--name-only", "--format=%x00%H", `${baselineSha}..${sha}`],
    { encoding: "utf8" },
  );
  const counts = new Map();
  for (const block of raw.split("\0")) {
    if (!block.trim()) continue;
    const [, ...paths] = block.split("\n").filter(Boolean);
    const touched = new Set();
    for (const p of paths) {
      if (isSourcePath(p, extSet)) touched.add(p);
    }
    for (const p of touched) counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, commits]) => commits >= limits.churnCommits)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limits.maxTop)
    .map(([path, commits]) => ({ path, commits }));
}

function computeImportGraph(jsFiles, textsByPath) {
  const known = new Set(jsFiles.map(f => f.path));
  const outEdges = new Map();
  const inEdges = new Map();
  for (const path of known) {
    outEdges.set(path, new Set());
    inEdges.set(path, new Set());
  }
  const files = [...known].sort();
  const edges = [];
  for (const path of files) {
    const text = textsByPath.get(path) ?? "";
    for (const spec of extractRelativeSpecifiers(text)) {
      const target = resolveImport(path, spec, known);
      if (!target || target === path || outEdges.get(path).has(target)) continue;
      outEdges.get(path).add(target);
      inEdges.get(target).add(path);
      edges.push({ from: path, to: target });
    }
  }
  edges.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  return { files, outEdges, inEdges, edges };
}

// P-0012, D-0059, design/parallel-dispatch.md#1
export function buildImportGraph(productRepo, sha, { sourceExts = DEFAULT_EXTS } = {}) {
  const extSet = new Set(sourceExts.map(e => e.toLowerCase()));
  const jsFiles = regularFiles(productRepo, sha)
    .filter(f => isSourcePath(f.path, extSet) && JS_TS_EXTS.has(posix.extname(f.path).toLowerCase()));
  const contents = jsFiles.length ? blobs(productRepo, jsFiles.map(f => f.sha)) : [];
  const textsByPath = new Map(jsFiles.map((entry, i) => [entry.path, contents[i].toString("utf8")]));
  return computeImportGraph(jsFiles, textsByPath);
}

function collectImportHubs(jsFiles, textsByPath, maxTop) {
  const { files, outEdges, inEdges } = computeImportGraph(jsFiles, textsByPath);
  return files
    .map(path => ({ path, fanIn: inEdges.get(path).size, fanOut: outEdges.get(path).size }))
    .filter(h => h.fanIn > 0 || h.fanOut > 0)
    .sort((a, b) => (b.fanIn + b.fanOut) - (a.fanIn + a.fanOut) || b.fanIn - a.fanIn || a.path.localeCompare(b.path))
    .slice(0, maxTop);
}

function collectParallelSiblings(files) {
  const groups = new Map();
  for (const { path } of files) {
    const ext = posix.extname(path);
    const stem = posix.basename(path, ext);
    const match = ROLE_SUFFIX_RE.exec(stem);
    if (!match) continue;
    const role = match[2].toLowerCase();
    const dir = posix.dirname(path);
    if (!groups.has(role)) groups.set(role, { paths: [], dirs: new Set(), prefixed: new Set() });
    const g = groups.get(role);
    g.paths.push(path);
    g.dirs.add(dir);
    if (match[1]) g.prefixed.add(stem.toLowerCase());
  }
  return [...groups.entries()]
    .filter(([, g]) => g.paths.length >= 2 && (g.dirs.size >= 2 || g.prefixed.size >= 2))
    .map(([role, g]) => ({
      role,
      paths: [...g.paths].sort(),
      dirs: [...g.dirs].sort(),
    }))
    .sort((a, b) => b.paths.length - a.paths.length || a.role.localeCompare(b.role));
}

// P-0011, D-0058, design/two-loop-rhythm.md#3
export function collectArchFacts(
  productRepo,
  sha,
  { baselineSha = null, thresholds = ARCH_THRESHOLDS, antiRotThresholds = ANTI_ROT_THRESHOLDS, sourceExts = DEFAULT_EXTS } = {},
) {
  const limits = { ...ARCH_THRESHOLDS, ...thresholds };
  const extSet = new Set(sourceExts.map(e => e.toLowerCase()));
  const treeFiles = regularFiles(productRepo, sha);
  const currentEntries = treeFiles.filter(f => isSourcePath(f.path, extSet));
  const testEntries = treeFiles.filter(f => isTestPath(f.path, extSet));
  const currentBlobs = blobs(productRepo, currentEntries.map(f => f.sha));
  const testBlobs = testEntries.length ? blobs(productRepo, testEntries.map(f => f.sha)) : [];
  const textsByPath = new Map();
  const sourceFiles = currentEntries.map((entry, i) => {
    const text = currentBlobs[i].toString("utf8");
    textsByPath.set(entry.path, text);
    return { path: entry.path, text };
  });
  const testFiles = testEntries.map((entry, i) => ({ path: entry.path, text: testBlobs[i].toString("utf8") }));

  const validBaseline = baselineSha && gitOk(productRepo, "cat-file", "-e", `${baselineSha}^{commit}`) ? baselineSha : null;
  const baselineLinesByPath = new Map();
  if (validBaseline) {
    const wanted = new Set(currentEntries.map(f => f.path));
    const baseEntries = regularFiles(productRepo, validBaseline).filter(f => wanted.has(f.path));
    const baseBlobs = blobs(productRepo, baseEntries.map(f => f.sha));
    baseEntries.forEach((entry, i) => baselineLinesByPath.set(entry.path, countLines(baseBlobs[i].toString("utf8"))));
  }

  const fileMetrics = currentEntries.map(entry => {
    const lines = countLines(textsByPath.get(entry.path));
    const baselineLines = baselineLinesByPath.has(entry.path) ? baselineLinesByPath.get(entry.path) : null;
    const growthPct = baselineLines !== null && baselineLines > 0
      ? Math.round(((lines - baselineLines) / baselineLines) * 1000) / 10
      : null;
    return {
      path: entry.path,
      lines,
      baselineLines,
      growthPct,
      softBreach: lines > limits.softLines,
      hardBreach: lines > limits.hardLines,
      growthBreach: baselineLines !== null && baselineLines >= 100 && growthPct !== null && growthPct >= limits.growthPct,
    };
  });

  const largestFiles = [...fileMetrics]
    .sort((a, b) => b.lines - a.lines || a.path.localeCompare(b.path))
    .slice(0, limits.maxTop);

  const growthFiles = fileMetrics
    .filter(f => f.growthBreach)
    .sort((a, b) => (b.growthPct ?? 0) - (a.growthPct ?? 0) || a.path.localeCompare(b.path));

  const churnHotspots = collectChurn(productRepo, validBaseline, sha, extSet, limits);
  const jsFiles = currentEntries.filter(f => JS_TS_EXTS.has(posix.extname(f.path).toLowerCase()));
  const importHubs = collectImportHubs(jsFiles, textsByPath, limits.maxTop);
  const parallelSiblings = collectParallelSiblings(currentEntries);
  const antiRot = scanAntiRot({ sourceFiles, testFiles, thresholds: antiRotThresholds });

  return {
    sha,
    baselineSha: validBaseline,
    sourceFileCount: currentEntries.length,
    thresholds: limits,
    largestFiles,
    growthFiles,
    churnHotspots,
    importHubs,
    parallelSiblings,
    antiRot,
  };
}

// P-0011, D-0058, design/two-loop-rhythm.md#6
export function structuralBreaches(facts, thresholds = null) {
  if (!facts) return [];
  const limits = { ...ARCH_THRESHOLDS, ...(facts.thresholds ?? {}), ...(thresholds ?? {}) };
  const breaches = [];
  const seenGrowth = new Set();

  for (const file of facts.largestFiles ?? []) {
    if (file.lines > limits.hardLines) {
      breaches.push({
        kind: "file-size",
        path: file.path,
        detail: `${file.lines} lines exceeds hard limit ${limits.hardLines}`,
      });
    }
  }

  for (const file of [...(facts.growthFiles ?? []), ...(facts.largestFiles ?? [])]) {
    if (seenGrowth.has(file.path)) continue;
    if (file.baselineLines !== null && file.baselineLines !== undefined && file.baselineLines >= 100
        && file.growthPct !== null && file.growthPct !== undefined && file.growthPct >= limits.growthPct) {
      seenGrowth.add(file.path);
      breaches.push({
        kind: "file-growth",
        path: file.path,
        detail: `grew ${file.growthPct}% (${file.baselineLines} -> ${file.lines} lines, limit ${limits.growthPct}%)`,
      });
    }
  }

  for (const spot of facts.churnHotspots ?? []) {
    if (spot.commits >= limits.churnCommits) {
      breaches.push({
        kind: "churn-hotspot",
        path: spot.path,
        detail: `touched in ${spot.commits} commits (limit ${limits.churnCommits})`,
      });
    }
  }

  breaches.push(...antiRotBreaches(facts.antiRot));
  return breaches;
}

// D-0060, D-0058, design/mandatory-control-plane.md#3
export function compareArchFacts(currentFacts, baselineFacts, thresholds = null) {
  if (!currentFacts) return [];
  if (!baselineFacts) return structuralBreaches(currentFacts, thresholds);
  const limits = { ...ARCH_THRESHOLDS, ...(currentFacts.thresholds ?? {}), ...(thresholds ?? {}) };
  const breaches = [];

  const baseLinesByPath = new Map();
  const baseGrowthByPath = new Map();
  for (const f of [...(baselineFacts.growthFiles ?? []), ...(baselineFacts.largestFiles ?? [])]) {
    if (!baseLinesByPath.has(f.path)) baseLinesByPath.set(f.path, f.lines);
    if (f.baselineLines !== null && f.baselineLines !== undefined && f.baselineLines >= 100
        && f.growthPct !== null && f.growthPct !== undefined && f.growthPct >= limits.growthPct) {
      baseGrowthByPath.set(f.path, Math.max(baseGrowthByPath.get(f.path) ?? -Infinity, f.growthPct));
    }
  }

  for (const file of currentFacts.largestFiles ?? []) {
    if (file.lines <= limits.hardLines) continue;
    const baseLines = baseLinesByPath.get(file.path);
    if (baseLines === undefined || baseLines <= limits.hardLines) {
      breaches.push({
        kind: "file-size",
        path: file.path,
        detail: `${file.lines} lines exceeds hard limit ${limits.hardLines}`,
      });
    } else if (file.lines > baseLines) {
      breaches.push({
        kind: "file-size",
        path: file.path,
        detail: `${file.lines} lines exceeds hard limit ${limits.hardLines} (grew from ${baseLines})`,
      });
    }
  }

  const seenGrowth = new Set();
  for (const file of [...(currentFacts.growthFiles ?? []), ...(currentFacts.largestFiles ?? [])]) {
    if (seenGrowth.has(file.path)) continue;
    if (file.baselineLines !== null && file.baselineLines !== undefined && file.baselineLines >= 100
        && file.growthPct !== null && file.growthPct !== undefined && file.growthPct >= limits.growthPct) {
      seenGrowth.add(file.path);
      const basePct = baseGrowthByPath.get(file.path);
      if (basePct === undefined || file.growthPct > basePct) {
        breaches.push({
          kind: "file-growth",
          path: file.path,
          detail: `grew ${file.growthPct}% (${file.baselineLines} -> ${file.lines} lines, limit ${limits.growthPct}%)`,
        });
      }
    }
  }

  const baseChurnByPath = new Map((baselineFacts.churnHotspots ?? []).map(s => [s.path, s.commits]));
  for (const spot of currentFacts.churnHotspots ?? []) {
    if (spot.commits < limits.churnCommits) continue;
    const baseCommits = baseChurnByPath.get(spot.path);
    if (baseCommits === undefined || baseCommits < limits.churnCommits || spot.commits > baseCommits) {
      breaches.push({
        kind: "churn-hotspot",
        path: spot.path,
        detail: `touched in ${spot.commits} commits (limit ${limits.churnCommits})`,
      });
    }
  }

  const curRot = currentFacts.antiRot ?? {};
  const baseRot = baselineFacts.antiRot ?? {};

  const baseRemnantKeys = new Set(
    (baseRot.compatRemnants ?? []).map(i => `${i.path}\0${i.kind}\0${String(i.marker).toLowerCase()}`),
  );
  const deltaRemnants = (curRot.compatRemnants ?? []).filter(
    i => !baseRemnantKeys.has(`${i.path}\0${i.kind}\0${String(i.marker).toLowerCase()}`),
  );

  const baseLiteralKeys = new Set(
    (baseRot.hardcodedLiterals ?? []).map(i => `${i.path}\0${i.kind}\0${i.match}`),
  );
  const deltaLiterals = (curRot.hardcodedLiterals ?? []).filter(
    i => !baseLiteralKeys.has(`${i.path}\0${i.kind}\0${i.match}`),
  );

  const baseTestRotCounts = new Map();
  const baseTestRotExact = new Set();
  for (const i of baseRot.testRot ?? []) {
    const gk = `${i.path}\0${i.kind}`;
    baseTestRotCounts.set(gk, (baseTestRotCounts.get(gk) ?? 0) + 1);
    baseTestRotExact.add(`${gk}\0${i.line}`);
  }
  const curRotByGroup = new Map();
  for (const i of curRot.testRot ?? []) {
    const gk = `${i.path}\0${i.kind}`;
    if (!curRotByGroup.has(gk)) curRotByGroup.set(gk, []);
    curRotByGroup.get(gk).push(i);
  }
  const deltaTestRot = [];
  for (const [gk, items] of curRotByGroup) {
    let allowance = baseTestRotCounts.get(gk) ?? 0;
    const unmatched = [];
    for (const item of items) {
      if (allowance > 0 && baseTestRotExact.has(`${gk}\0${item.line}`)) allowance--;
      else unmatched.push(item);
    }
    deltaTestRot.push(...unmatched.slice(allowance));
  }

  const baseCommentByPath = new Map((baseRot.commentBloat ?? []).map(i => [i.path, i.proseLines]));
  const deltaCommentBloat = (curRot.commentBloat ?? []).filter(i => {
    const baseLines = baseCommentByPath.get(i.path);
    return baseLines === undefined || i.proseLines > baseLines;
  });

  breaches.push(...antiRotBreaches({
    compatRemnants: deltaRemnants,
    hardcodedLiterals: deltaLiterals,
    testRot: deltaTestRot,
    commentBloat: deltaCommentBloat,
  }));
  return breaches;
}
