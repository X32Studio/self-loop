import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

import { parseRows } from "../trajectory.mjs";
import { firings } from "./diagnosis.mjs";
import { parseAlarms, stallKey } from "./alarms.mjs";

export const ALARM_DETECTOR_REVISION = "32c9634ed2457e47e1e12f4a3d4e59a337a3472a";
const alarmPath = p => p === "metrics/trajectory.jsonl" || p === "metrics/alarms.jsonl";
const MANIFEST = "evidence/normal-entry/manifest.json";
const families = ["owner_word", "answer_clause", "judge_gap", "trial"];
const sha = x => createHash("sha256").update(x).digest("hex");
const compare = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const canonical = x => JSON.stringify(x, (_, v) => v && typeof v === "object" && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort(compare).map(k => [k, v[k]])) : v);
const hash = x => sha(canonical(x));
const obj = x => x !== null && typeof x === "object" && !Array.isArray(x);
const keys = (x, names) => obj(x) && Object.keys(x).sort().join() === names.split(" ").sort().join();
const id = x => typeof x === "string" && /^[A-Za-z0-9._:-]+$/.test(x);
const digest = x => typeof x === "string" && /^[a-f0-9]{64}$/.test(x);
const fail = reason => { throw Object.assign(new Error(reason), { reason }); };
const sourcePath = p => /^(owner\/(answers|words)\.jsonl|decisions\/D-[0-9]{4}\.md|reviews\/grok-R[0-9]{4}-[a-z0-9-]+\.md)$/.test(p);
const linkPath = p => /^(evidence\/normal-entry\/public-[a-z0-9-]+\.json|decisions\/D-[0-9]{4}\.md|reviews\/grok-R[0-9]{4}-[a-z0-9-]+\.md)$/.test(p);
const taskPath = p => /^(plans\/PL-[0-9]{4}\.md|delegations\/T-[0-9]{4}\.md)$/.test(p);
const utf8 = (bytes, ignoreBOM = false) => { try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM }).decode(bytes); } catch { fail("bad_span"); } };
function json(bytes) {
  const text = utf8(bytes);
  const tokens = text.match(/"(?:[^"\\]|\\.)*"|[{}\[\]:,]|[^\s{}\[\]:,]+/g) ?? [];
  let at = 0;
  function value() {
    const t = tokens[at++];
    if (t === "{") {
      const seen = new Set();
      while (tokens[at] !== "}") {
        const key = JSON.parse(tokens[at++]);
        if (seen.has(key) || tokens[at++] !== ":") fail("bad_type");
        seen.add(key); value();
        if (tokens[at] !== ",") break;
        at++;
      }
      if (tokens[at++] !== "}") fail("bad_type");
    } else if (t === "[") {
      while (tokens[at] !== "]") { value(); if (tokens[at] !== ",") break; at++; }
      if (tokens[at++] !== "]") fail("bad_type");
    } else {
      const v = JSON.parse(t);
      if (typeof v === "number" && !Number.isFinite(v)) fail("bad_type");
    }
  }
  value();
  if (at !== tokens.length) fail("bad_type");
  return JSON.parse(text);
}

export function readNormalEntry({ records, revision, phase, cadence, blockers, alarmContext, alarmSourcesOnly = false }) {
  const out = { schema: "normal-entry-facts/v1", repo: null, previousCut: null, currentCut: null,
    cutStatus: "valid", phase, events: [], dispositions: [], cadence, blockers,
    coverage: [...families.map(family => ({ family, availability: "available", completeness: "unknown", reason: "unenumerated_sources" })),
      { family: "alarm", availability: "unsupported", completeness: "unknown", reason: "unsupported_family" },
      { family: "inventory", availability: "available", completeness: "bounded", reason: "ok" }],
    diagnostics: [], accountingInput: { inputOccurrences: 0, invalidOccurrences: 0 } };
  const diagnostic = (scope, code, subject, provenance = []) => out.diagnostics.push({ scope, code, subject, provenance });
  const git = (...args) => execFileSync("git", ["--no-replace-objects", "-C", records, ...args], { encoding: null, stdio: ["ignore", "pipe", "pipe"] });
  let chain, positions, length;
  const commit = x => typeof x === "string" && new RegExp(`^[a-f0-9]{${length}}$`).test(x);
  try {
    length = git("rev-parse", "--show-object-format").toString().trim() === "sha256" ? 64 : 40;
    if (!commit(revision)) fail("bad_cut");
    out.currentCut = revision;
    if (git("cat-file", "-t", revision).toString().trim() !== "commit") fail("bad_cut");
    if (git("rev-parse", "--is-shallow-repository").toString().trim() === "true") fail("missing_cut");
    chain = git("rev-list", "--first-parent", "--reverse", revision).toString().trim().split("\n");
    const roots = git("rev-list", "--max-parents=0", revision).toString().trim().split("\n");
    if (roots.length !== 1 || roots[0] !== chain[0]) fail("unsupported_repo");
    out.repo = `git-root:${chain[0]}`;
    positions = new Map(chain.map((c, i) => [c, i]));
  } catch (e) {
    const reason = e.reason ?? "missing_cut";
    out.cutStatus = reason === "missing_cut" ? "unavailable" : "invalid";
    diagnostic("cut", reason, "inventory");
    out.coverage.find(c => c.family === "inventory").availability = "unavailable";
    return out;
  }
  const trees = new Map(), content = new Map();
  function entry(rev, path) {
    let tree = rev, result;
    for (const [i, part] of path.split("/").entries()) {
      const key = `${tree}:${part}`;
      if (!trees.has(key)) {
        let bytes;
        try { bytes = git("ls-tree", "-z", tree, "--", part); } catch { fail("source_unavailable"); }
        const row = bytes.toString("utf8").split("\0").find(r => r.slice(r.indexOf("\t") + 1) === part);
        trees.set(key, row ? /^(\d+) (\w+) ([a-f0-9]+)\t/.exec(row)?.slice(1) : null);
      }
      result = trees.get(key);
      if (!result) return null;
      if (i < path.split("/").length - 1) {
        if (result[0] !== "040000" || result[1] !== "tree") fail("symlink");
        tree = result[2];
      }
    }
    if (!["100644", "100755"].includes(result[0]) || result[1] !== "blob") fail("symlink");
    return result[2];
  }
  function blob(oid) {
    if (!content.has(oid)) { try { content.set(oid, git("cat-file", "blob", oid)); } catch { fail("source_unavailable"); } }
    return content.get(oid);
  }
  // evidence/0012/alarm-response/proposal.md#response-001
  const ledgers = new Map();
  function ledger(cut, origin) {
    const path = origin === "trajectory" ? "metrics/trajectory.jsonl" : "metrics/alarms.jsonl";
    const oid = entry(cut, path);
    if (!oid) return { raw: [], rows: [], groups: new Map(), absent: true };
    const cacheKey = `${origin}:${oid}`;
    if (ledgers.has(cacheKey)) return ledgers.get(cacheKey);
    const text = utf8(blob(oid), true);
    const raw = text.split("\n").filter(Boolean).map(l => l.endsWith("\r") ? l.slice(0, -1) : l);
    let rows, list;
    try {
      rows = origin === "trajectory" ? parseRows(text) : parseAlarms(text);
      list = origin === "trajectory" ? firings(rows) : rows.map((r, row) => ({ ...r, row }));
    } catch { fail("alarm_source_invalid"); }
    const groups = new Map();
    for (const a of list) groups.set(a.key, [...(groups.get(a.key) ?? []), a]);
    const result = { raw, rows, groups, list };
    ledgers.set(cacheKey, result); return result;
  }
  const identities = new Map();
  function alarmIdentity(cut, origin, key, line) {
    const cacheKey = canonical([cut, origin, key, line]);
    if (identities.has(cacheKey)) return identities.get(cacheKey);
    let episode = null, fingerprint = null, seen = false, gone = false, ambiguous = false;
    for (const c of chain.slice(0, positions.get(cut) + 1)) {
      let l;
      try { l = ledger(c, origin); } catch (error) { if (error.reason === "source_unavailable") throw error; l = null; }
      const copies = l?.raw.filter(r => r === line).length ?? 0;
      const group = l?.groups.get(key) ?? [];
      const continuous = origin === "trajectory" ? copies === 1 : copies > 0 && group.every(a => l.raw[a.row] === line);
      if (!continuous) { episode = null; fingerprint = null; seen = false; gone = false; ambiguous = false; continue; }
      episode ??= c;
      if (origin === "trajectory") {
        const selects = group.some(a => l.raw[a.row] === line);
        if (selects) {
          const f = canonical(group[0]);
          if (group.length !== 1 || gone || (fingerprint !== null && fingerprint !== f)) ambiguous = true;
          fingerprint ??= f; seen = true;
        } else if (seen) gone = true;
      }
    }
    const l = ledger(cut, origin), group = l.groups.get(key) ?? [];
    if (!episode || ambiguous || (origin === "trajectory" && group.length !== 1)) fail("alarm_identity_ambiguous");
    const selected = group.find(a => l.raw[a.row] === line);
    if (!selected || l.rows[selected.row]?.phase !== phase) fail("alarm_source_invalid");
    if (origin === "stall" && (selected.type !== "stall" || selected.key !== stallKey(selected.phase, selected.since))) fail("alarm_source_invalid");
    const result = { occurrenceId: `alarm-${hash([out.repo, phase, origin, key, episode, sha(line)])}`, origin, key };
    identities.set(cacheKey, result); return result;
  }
  function alarmSources() {
    const result = {};
    for (const origin of ["trajectory", "stall"]) {
      try {
        const l = ledger(revision, origin), ambiguousKeys = [];
        const list = (l.list ?? []).map(a => {
          let occurrenceId = null;
          try { occurrenceId = alarmIdentity(revision, origin, a.key, l.raw[a.row]).occurrenceId; }
          catch { ambiguousKeys.push(a.key); }
          return { ...a, occurrenceId };
        });
        result[origin] = { validation: "valid", [origin === "trajectory" ? "firings" : "rows"]: list,
          ambiguousKeys: [...new Set(ambiguousKeys)].sort(compare) };
      } catch { result[origin] = { validation: "unknown", [origin === "trajectory" ? "firings" : "rows"]: [], ambiguousKeys: [] }; }
    }
    return result;
  }
  if (alarmSourcesOnly) return alarmSources();
  let v2 = false;
  function pointer(p, use, publication, lower = 0) {
    if (!keys(p, "repo revision path selector entryRange clauseRange blobSha256 clauseSha256")) fail("bad_pointer");
    if (p.repo !== out.repo) fail("external_repo");
    if (!commit(p.revision) || !positions.has(p.revision) || positions.get(p.revision) > publication || positions.get(p.revision) < lower) fail("bad_pointer");
    if (typeof p.path !== "string" || !(use === "source" ? (sourcePath(p.path) || v2 && alarmPath(p.path)) : use === "task" ? taskPath(p.path) : linkPath(p.path))) fail("private_pointer");
    if (!digest(p.blobSha256) || !digest(p.clauseSha256)) fail("bad_pointer");
    const range = r => Array.isArray(r) && r.length === 2 && r.every(Number.isSafeInteger) && r[0] >= 0 && r[0] < r[1];
    if (!range(p.entryRange) || !range(p.clauseRange) || p.clauseRange[0] < p.entryRange[0] || p.clauseRange[1] > p.entryRange[1]) fail("bad_span");
    const s = p.selector;
    if (alarmPath(p.path)) {
      if (!v2 || !keys(s, "type origin key lineSha256 occurrence detectorRevision") || s.type !== "alarm" || !["trajectory", "stall"].includes(s.origin) || p.path !== (s.origin === "trajectory" ? "metrics/trajectory.jsonl" : "metrics/alarms.jsonl") || typeof s.key !== "string" || !s.key.length || !digest(s.lineSha256) || !Number.isSafeInteger(s.occurrence) || s.occurrence < 0) fail("bad_pointer");
      if (s.detectorRevision !== ALARM_DETECTOR_REVISION) fail("unsupported_detector");
      if (canonical(p.clauseRange) !== canonical(p.entryRange)) fail("bad_span");
    } else if (p.path === "owner/answers.jsonl") {
      if (!keys(s, "type batch time occurrence lineSha256") || s.type !== "answer" || !id(s.batch) || typeof s.time !== "string" || !s.time || !Number.isSafeInteger(s.occurrence) || s.occurrence < 0 || !digest(s.lineSha256)) fail("bad_pointer");
    } else if (p.path === "owner/words.jsonl") {
      if (!keys(s, "type id") || s.type !== "word" || !id(s.id)) fail("bad_pointer");
    } else if (!keys(s, "type") || s.type !== "document") fail("bad_pointer");
    const oid = entry(p.revision, p.path);
    if (!oid) fail("source_unavailable");
    const bytes = blob(oid);
    if (p.entryRange[1] > bytes.length) fail("bad_span");
    for (const r of [p.entryRange, p.clauseRange]) { utf8(bytes.subarray(0, r[0])); utf8(bytes.subarray(r[0], r[1])); utf8(bytes.subarray(r[1])); }
    if (sha(bytes) !== p.blobSha256 || sha(bytes.subarray(...p.clauseRange)) !== p.clauseSha256) fail("bad_digest");
    if (s.type === "document") {
      if (p.entryRange[0] !== 0 || p.entryRange[1] !== bytes.length) fail("bad_span");
    } else {
      let offset = 0, occurrence = 0, matched = false, ids = 0, alarmParseFailure = false;
      for (const line of bytes.toString("utf8").split("\n")) {
        const raw = Buffer.from(line.endsWith("\r") ? line.slice(0, -1) : line);
        if (raw.toString().trim()) {
          let data;
          try { data = json(raw); } catch {
            if (s.type !== "alarm") fail("bad_pointer");
            alarmParseFailure = true;
          }
          if (s.type === "word" && data.id === s.id) ids++;
          const selected = offset === p.entryRange[0] && offset + raw.length === p.entryRange[1];
          if (s.type === "word" && selected && data.id === s.id) matched = true;
          if (["answer", "alarm"].includes(s.type) && sha(raw) === s.lineSha256) {
            if (selected && (s.type === "alarm" || data.batch === s.batch && data.time === s.time) && occurrence === s.occurrence) matched = true;
            occurrence++;
          }
        }
        offset += Buffer.byteLength(line) + 1;
      }
      if (!matched || (s.type === "word" && ids !== 1)) fail("bad_pointer");
      if (alarmParseFailure) { ledger(p.revision, s.origin); fail("bad_pointer"); }
    }
    if (s.type === "alarm") alarmIdentity(p.revision, s.origin, s.key, utf8(bytes.subarray(...p.entryRange)));
    return oid;
  }
  const proofs = new Map(), originalValidity = new Map();
  let baseline = null, lastOid, published = false;
  const latest = new Map(), events = new Map();
  let snapshotDiagnostics = [];
  const snapshotDiagnostic = (scope, code, subject, provenance) => snapshotDiagnostics.push({ scope, code, subject, provenance });
  const prov = (revision, selector) => [{ revision, path: MANIFEST, selector }];
  function poison(code) {
    for (const values of latest.values()) for (const e of values) { e.validation = "unknown"; e.reason = code; }
  }
  for (const [index, publication] of chain.entries()) {
    let oid;
    try { oid = entry(publication, MANIFEST); }
    catch (e) { snapshotDiagnostic("manifest", e.reason, "inventory", prov(publication, "")); poison(e.reason); continue; }
    if (oid === lastOid) continue;
    lastOid = oid;
    if (!oid) {
      if (published) { snapshotDiagnostic("manifest", "manifest_deleted", "inventory", prov(publication, "")); poison("manifest_deleted"); }
      continue;
    }
    published = true;
    let m;
    try {
      m = json(blob(oid));
      if (v2 && m?.schema === "normal-entry-manifest/v1") {
        snapshotDiagnostic("manifest", "unsupported_downgrade", "inventory", prov(publication, "/schema")); poison("unsupported_downgrade"); continue;
      }
      if (!keys(m, "schema repo baseline phase inventory dispositions") || !["normal-entry-manifest/v1", "normal-entry-manifest/v2"].includes(m.schema) || typeof m.phase !== "string" || !m.phase || m.phase !== phase ) fail("malformed_manifest");
      if (m.repo !== out.repo) fail("external_repo");
      if (!commit(m.baseline) || !positions.has(m.baseline) || positions.get(m.baseline) >= index) fail("bad_cut");
      if (baseline && baseline !== m.baseline) fail("baseline_reset");
      if (m.schema === "normal-entry-manifest/v2" && (!Array.isArray(m.inventory) || !Array.isArray(m.dispositions))) fail("bad_type");
      if (m.schema === "normal-entry-manifest/v2") { v2 = true; out.schema = "normal-entry-facts/v2"; }
      baseline ??= m.baseline;
      out.previousCut = baseline;
    } catch (e) {
      const reason = e.reason ?? "malformed_manifest";
      const invalidCut = ["bad_cut", "baseline_reset", "external_repo"].includes(reason);
      (invalidCut ? diagnostic : snapshotDiagnostic)("manifest", reason, "inventory", prov(publication, "")); poison(reason);
      if (invalidCut) out.cutStatus = "invalid";
      continue;
    }
    if (!Array.isArray(m.inventory)) {
      snapshotDiagnostic("manifest", "bad_type", "inventory", prov(publication, "/inventory")); poison("bad_type"); continue;
    }
    snapshotDiagnostics = [];
    if (!Array.isArray(m.dispositions)) {
      snapshotDiagnostic("disposition", "bad_type", "dispositions", prov(publication, "/dispositions"));
      m.dispositions = [];
    }
    const next = new Map();
    for (const [i, row] of m.inventory.entries()) {
      out.accountingInput.inputOccurrences++;
      const provenance = prov(publication, `/inventory/${i}`);
      const keyed = obj(row) && id(row.kind) && typeof row.path === "string" && (sourcePath(row.path) || v2 && alarmPath(row.path)) && id(row.entryId) && id(row.clauseId);
      const logicalKey = keyed ? canonical([out.repo, row.kind, row.path, row.entryId, row.clauseId]) : null;
      let reason = "ok", version, source = null, proof = null;
      const previous = latest.get(logicalKey) ?? [];
      const same = previous.find(e => e.operation === row?.operation && canonical(e.source) === canonical(row?.source));
      try {
        if (!keys(row, "kind entryId clauseId path operation source predecessor") || !keyed) fail("bad_type");
        if (!(families.includes(row.kind) || v2 && row.kind === "alarm")) fail("unknown_kind");
        const kindPath = { owner_word: /^owner\/words\.jsonl$/, answer_clause: /^owner\/answers\.jsonl$/, judge_gap: /^reviews\//, alarm: /^metrics\/(trajectory|alarms)\.jsonl$/, trial: /^decisions\// };
        if (!kindPath[row.kind].test(row.path)) fail("bad_pointer");
        if (!["upsert", "delete"].includes(row.operation) || (row.predecessor !== null && !digest(row.predecessor))) fail("bad_type");
        if (same) {
          if (row.predecessor !== same.predecessor) fail("broken_chain");
          version = same.version;
        } else if (previous.length ? previous.length !== 1 || row.predecessor !== previous[0].version : row.predecessor !== null) fail("broken_chain");
        if (row.operation === "delete") {
          if (row.source !== null || !previous.length) fail("broken_chain");
        } else {
          if (row.source?.path !== row.path) fail("bad_pointer");
          pointer(row.source, "source", index);
          source = row.source;
        }
        if (row.kind === "alarm") {
          if (row.clauseId !== "alarm") fail("bad_pointer");
          if (row.operation === "delete") {
            proof = proofs.get(row.predecessor);
            if (!proof || proof.occurrenceId !== row.entryId) fail("broken_chain");
          } else {
            const p = row.source;
            proof = alarmIdentity(p.revision, p.selector.origin, p.selector.key, utf8(blob(entry(p.revision, p.path)).subarray(...p.entryRange)));
            if (proof.occurrenceId !== row.entryId) fail("bad_pointer");
          }
        }
        version ??= hash([logicalKey, publication, row.operation === "delete" ? row.predecessor : source, row.operation]);
      } catch (e) { reason = e.reason ?? "bad_type"; out.accountingInput.invalidOccurrences++; }
      if (!logicalKey) { snapshotDiagnostic("event", reason, hash(row), provenance); continue; }
      version ??= hash(["invalid", logicalKey, publication, hash(row)]);
      if (reason === "ok" && proof) proofs.set(version, proof);
      const existing = events.get(version);
      const fact = { logicalKey, version, current: true, publication: existing?.publication ?? publication,
        publicationIndex: existing?.publicationIndex ?? index, operation: row.operation === "delete" ? "delete" : "upsert",
        predecessor: digest(row.predecessor) ? row.predecessor : null, source,
        validation: reason === "ok" ? "valid" : "invalid", reason, provenance };
      if (existing && reason === "ok") {
        for (const prior of out.events.filter(e => e.version === version)) { prior.validation = "valid"; prior.reason = "ok"; }
      }
      if (!originalValidity.has(version)) originalValidity.set(version, { validation: fact.validation, reason: fact.reason });
      out.events.push(fact);
      events.set(version, fact);
      if (!next.has(logicalKey)) next.set(logicalKey, []);
      if (!next.get(logicalKey).some(e => e.version === version)) next.get(logicalKey).push(fact);
    }
    for (const [key, previous] of latest) {
      if (!next.has(key)) {
        for (const e of previous) { e.validation = "unknown"; e.reason = "inventory_omission"; }
        next.set(key, previous);
      }
    }
    for (const [key, values] of next) if (values.length > 1) {
      for (const e of values) { e.validation = "unknown"; e.reason = "duplicate_identity"; }
    }
    latest.clear(); for (const [k, v] of next) latest.set(k, v);
    out.dispositions = m.dispositions.map((d, i) => {
      let reason = "ok";
      try {
        if (!keys(d, "id version source outcome rationale ruling consumer decision task reason") || !id(d.id) || !digest(d.version) || !["CHANGE", "NO_CHANGE", "UNKNOWN"].includes(d.outcome) || !["retain", "withhold", "revise"].includes(d.decision) || typeof d.reason !== "string" || !d.reason.trim()) fail("invalid_disposition");
        const event = events.get(d.version);
        if (!event || canonical(d.source) !== canonical(event.source)) fail("invalid_disposition");
        if (d.source !== null) pointer(d.source, "source", index);
        let lower = positions.get(baseline);
        for (const p of [d.rationale, d.ruling, d.consumer]) { pointer(p, "link", index, lower); lower = positions.get(p.revision); }
        if (d.task !== null) pointer(d.task, "task", index, positions.get(baseline));
        else if (d.decision !== "withhold") fail("invalid_disposition");
      } catch (e) { reason = e.reason ?? "invalid_disposition"; }
      const provenance = prov(publication, `/dispositions/${i}`);
      if (reason !== "ok") snapshotDiagnostic("disposition", reason, digest(d?.version) ? d.version : hash(d), provenance);
      return { value: reason === "ok" ? d : null, validation: reason === "ok" ? "valid" : reason === "source_unavailable" ? "unavailable" : "invalid", reason,
        version: digest(d?.version) ? d.version : null, provenance };
    });
  }
  out.diagnostics.push(...snapshotDiagnostics);
  if (!published) diagnostic("manifest", "missing_manifest", "inventory");
  const current = new Set([...latest.values()].flat().map(e => e.version));
  for (const e of events.values()) if (v2 && !current.has(e.version) && originalValidity.get(e.version)?.validation === "valid") Object.assign(e, originalValidity.get(e.version));
  for (const e of out.events) {
    const final = events.get(e.version);
    e.validation = final.validation; e.reason = final.reason; e.source = final.source;
    e.current = current.has(e.version);
    if (e.current && e.validation === "valid" && e.operation === "upsert") {
      try {
        const now = entry(revision, e.source.path), before = entry(e.source.revision, e.source.path);
        if (!now) fail("source_unavailable");
        if (now !== before) fail("stale_inventory");
      } catch (error) { e.validation = "unknown"; e.reason = error.reason ?? "source_unavailable"; }
    }
    if (e.validation !== "valid") diagnostic("event", e.reason, e.logicalKey, e.provenance);
  }
  if (v2) {
    const sources = proofs.size ? alarmSources() : {};
    const contextOK = alarmContext?.revision === revision && alarmContext?.phase === phase && alarmContext?.detectorRevision === ALARM_DETECTOR_REVISION;
    out.alarmStates = [...events.values()].filter(e => JSON.parse(e.logicalKey)[1] === "alarm").map(e => {
      const proof = proofs.get(e.version);
      const state = { version: e.version, occurrenceId: proof?.occurrenceId ?? null, identityBasis: proof ? e.operation === "delete" ? "predecessor" : "source" : "unverified", evaluatedAtCut: revision, applicability: "unknown", diagnosis: "unknown", successorOccurrenceId: null, reason: e.reason };
      const evaluated = out.events.find(x => x.version === e.version);
      if (out.cutStatus !== "valid") state.reason = out.cutStatus === "unavailable" ? "missing_cut" : "bad_cut";
      else if (evaluated.validation !== "valid") state.reason = evaluated.reason;
      else if (!proof) state.reason = "broken_chain";
      else if (e.operation === "delete") Object.assign(state, { applicability: "inactive", diagnosis: "not_applicable", reason: "alarm_inactive" });
      else {
        const local = sources[proof.origin], context = alarmContext?.[proof.origin];
        if (!contextOK || context?.validation !== "valid" || local.validation !== "valid" || (proof.origin === "trajectory" && (!Array.isArray(context.firings) || !Array.isArray(context.undiagnosedKeys) || !Array.isArray(context.ambiguousKeys))) || (proof.origin === "stall" && context.currentKey !== null && typeof context.currentKey !== "string")) state.reason = "alarm_context_unknown";
        else if (proof.origin === "trajectory" && canonical(context.firings) !== canonical(local.firings)) state.reason = "alarm_context_unknown";
        else if (local.ambiguousKeys.includes(proof.key) || (context.ambiguousKeys ?? []).includes(proof.key)) state.reason = "alarm_identity_ambiguous";
        else if (proof.origin === "stall") {
          const active = context.currentKey === proof.key;
          Object.assign(state, { applicability: active ? "active" : "inactive", diagnosis: "not_applicable", reason: active ? "alarm_active" : "alarm_inactive" });
        } else {
          const now = local.firings.find(a => a.key === proof.key);
          if (now && !now.occurrenceId) state.reason = "alarm_identity_ambiguous";
          else if (!now) Object.assign(state, { applicability: "inactive", diagnosis: "not_applicable", reason: "alarm_inactive" });
          else if (now.occurrenceId !== proof.occurrenceId) Object.assign(state, { applicability: "superseded", diagnosis: "not_applicable", successorOccurrenceId: now.occurrenceId, reason: "alarm_superseded" });
          else Object.assign(state, { applicability: "active", diagnosis: context.undiagnosedKeys.includes(proof.key) ? "required" : "covered", reason: "alarm_active" });
        }
      }
      if (state.applicability === "unknown") diagnostic("event", state.reason, e.version, e.provenance);
      return state;
    }).sort((a, b) => compare(a.version, b.version));
    if (contextOK && alarmContext.stall?.validation === "valid" && alarmContext.stall.currentKey !== null) {
      const durable = sources.stall ?? alarmSources().stall;
      if (durable.validation !== "valid" || !durable.rows.some(r => r.key === alarmContext.stall.currentKey && r.occurrenceId)) diagnostic("coverage", "alarm_context_unknown", "alarm");
    }
    Object.assign(out.coverage.find(c => c.family === "alarm"), { availability: out.alarmStates.some(s => s.applicability === "unknown") || out.diagnostics.some(d => d.scope === "coverage" && d.subject === "alarm") ? "partial" : "available", completeness: "unknown", reason: "unenumerated_sources" });
  }
  if (out.diagnostics.length) Object.assign(out.coverage.find(c => c.family === "inventory"), { availability: "partial", completeness: "unknown", reason: out.diagnostics[0].code });
  return out;
}

// evidence/0012/alarm-response/contracts.json#AE-CONTEXT
export function buildAlarmContext(input) {
  const { records, revision, phase, detectorRevision, trajectory, stall } = input;
  let source;
  try { source = readNormalEntry({ records, revision, phase, alarmSourcesOnly: true }); } catch { source = null; }
  const good = detectorRevision === ALARM_DETECTOR_REVISION;
  const verified = source?.trajectory;
  const supplied = Array.isArray(trajectory?.firings) ? trajectory.firings : [];
  const strip = a => { const { occurrenceId, ...rest } = a; return rest; };
  const same = canonical(supplied.map(strip)) === canonical((verified?.firings ?? []).map(strip));
  return { revision, phase, detectorRevision,
    trajectory: { validation: good && trajectory?.validation === "valid" && verified?.validation === "valid" && same && Array.isArray(trajectory?.undiagnosedKeys) ? "valid" : "unknown",
      firings: supplied.map((a, i) => ({ ...a, occurrenceId: good && same ? verified.firings[i].occurrenceId : null })),
      undiagnosedKeys: trajectory?.undiagnosedKeys ?? [], ambiguousKeys: verified?.ambiguousKeys ?? [] },
    stall: { validation: good && stall?.validation === "valid" && source?.stall?.validation === "valid" ? "valid" : "unknown", currentKey: stall?.currentKey ?? null } };
}
