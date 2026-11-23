import { createHash } from 'node:crypto';

// evidence/0010/ng03-final-response/contracts.json; NG03 v4.
const cmp = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const keys = (x, names) => object(x) && Object.keys(x).sort().join(',') === names.split(' ').sort().join(',');
const str = x => typeof x === 'string' && x.length > 0;
const id = x => typeof x === 'string' && /^[A-Za-z0-9._:-]+$/.test(x);
const hash = x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
const commit = x => typeof x === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(x);
const repoId = x => typeof x === 'string' && x.startsWith('git-root:') && commit(x.slice(9));
const nat = x => Number.isSafeInteger(x) && x >= 0;
const one = (x, s) => s.split(' ').includes(x);
const reasons = 'ok missing_manifest bad_cut missing_cut unsupported_repo baseline_reset malformed_manifest inventory_omission manifest_deleted unsupported_family unenumerated_sources bad_type bad_pointer private_pointer external_repo symlink source_unavailable bad_span bad_digest stale_inventory duplicate_identity broken_chain unknown_kind absent stale invalid_disposition unavailable_disposition conflicting_disposition unknown_outcome exact_link deletion_review duplicate_identical unchanged revised cadence_unknown projection_failed alarm_context_unknown alarm_source_invalid unsupported_detector alarm_active alarm_superseded alarm_inactive unsupported_downgrade alarm_identity_ambiguous';
const reason = x => one(x, reasons);
const validation = x => one(x, 'valid invalid unavailable unknown');
const canonical = x => JSON.stringify(x, function (_k, value) {
  return object(value) ? Object.fromEntries(Object.keys(value).sort(cmp).map(k => [k, value[k]])) : value;
});
const digest = x => createHash('sha256').update(canonical(x) ?? String(x)).digest('hex');
const unique = xs => [...new Map(xs.map(x => [canonical(x), x])).entries()].sort(([a], [b]) => cmp(a, b)).map(([, x]) => x);
const path = x => typeof x === 'string' && /^[A-Za-z0-9_./-]+$/.test(x) && x.split('/').every(p => p && p !== '.' && p !== '..');
const provenance = x => keys(x, 'revision path selector') && commit(x.revision) && path(x.path) && typeof x.selector === 'string';
const prov = xs => Array.isArray(xs) && xs.every(provenance);
const sortedProv = xs => unique(xs).sort((a, b) => cmp(a.revision, b.revision) || cmp(a.path, b.path) || cmp(a.selector, b.selector));
const range = x => Array.isArray(x) && x.length === 2 && nat(x[0]) && nat(x[1]) && x[0] < x[1];
function pointer(x) {
  if (!keys(x, 'repo revision path selector entryRange clauseRange blobSha256 clauseSha256') || !repoId(x.repo) || !commit(x.revision) || x.revision.length !== x.repo.length - 9 || !path(x.path) || !hash(x.blobSha256) || !hash(x.clauseSha256) || !range(x.entryRange) || !range(x.clauseRange) || x.clauseRange[0] < x.entryRange[0] || x.clauseRange[1] > x.entryRange[1]) return false;
  const s = x.selector;
  return keys(s, 'type origin key lineSha256 occurrence detectorRevision') && s.type === 'alarm' && one(s.origin, 'trajectory stall') && str(s.key) && hash(s.lineSha256) && nat(s.occurrence) && commit(s.detectorRevision) || keys(s, 'type') && s.type === 'document' || keys(s, 'type id') && s.type === 'word' && id(s.id) || keys(s, 'type batch time occurrence lineSha256') && s.type === 'answer' && id(s.batch) && str(s.time) && nat(s.occurrence) && hash(s.lineSha256);
}
function disposition(x) {
  return keys(x, 'id version source outcome rationale ruling consumer decision task reason') && id(x.id) && hash(x.version) && (x.source === null || pointer(x.source)) && one(x.outcome, 'CHANGE NO_CHANGE UNKNOWN') && pointer(x.rationale) && pointer(x.ruling) && pointer(x.consumer) && one(x.decision, 'retain withhold revise') && (pointer(x.task) || x.task === null && x.decision === 'withhold') && str(x.reason) && x.reason.trim().length > 0;
}
function logicalKey(x, v2 = false) {
  if (!str(x)) return false;
  try {
    const k = JSON.parse(x);
    return Array.isArray(k) && k.length === 5 && repoId(k[0]) && one(k[1], v2 ? 'owner_word answer_clause judge_gap trial alarm' : 'owner_word answer_clause judge_gap trial') && path(k[2]) && id(k[3]) && id(k[4]) && canonical(k) === x;
  } catch { return false; }
}
function event(x, v2 = false) {
  return keys(x, 'logicalKey version current publication publicationIndex operation predecessor source validation reason provenance') && logicalKey(x.logicalKey, v2) && hash(x.version) && typeof x.current === 'boolean' && commit(x.publication) && nat(x.publicationIndex) && one(x.operation, 'upsert delete') && (x.predecessor === null || hash(x.predecessor)) && validation(x.validation) && reason(x.reason) && prov(x.provenance) && (x.source === null ? x.operation === 'delete' || x.validation !== 'valid' : pointer(x.source) && x.operation === 'upsert');
}
const fact = x => keys(x, 'value validation reason version provenance') && (x.value === null || disposition(x.value)) && validation(x.validation) && reason(x.reason) && (x.version === null || hash(x.version)) && prov(x.provenance) && (x.validation !== 'valid' || x.value !== null && x.version === x.value.version);
const coverageRow = x => keys(x, 'family availability completeness reason') && one(x.family, 'owner_word answer_clause judge_gap trial alarm inventory') && one(x.availability, 'available partial unavailable unsupported') && one(x.completeness, 'bounded unknown') && reason(x.reason);
const diagnostic = x => keys(x, 'scope code subject provenance') && one(x.scope, 'cut manifest event disposition coverage cadence projection') && reason(x.code) && typeof x.subject === 'string' && prov(x.provenance);
const topKeys = 'schema repo previousCut currentCut cutStatus phase events dispositions cadence blockers coverage diagnostics accountingInput';

export function normalOpportunities(input) {
  const ds = [];
  const add = (scope, code, subject, p = []) => ds.push({ scope, code, subject, provenance: sortedProv(p) });
  const blockers = object(input) && Object.hasOwn(input, 'blockers') && input.blockers !== undefined ? input.blockers : null;
  const empty = () => ({ schema: 'normal-entry-projection/v1', previousCut: null, currentCut: null, state: 'unknown', items: [], accounting: { inputOccurrences: 0, uniqueVersions: 0, duplicateOccurrences: 0, invalidOccurrences: 0, unchangedVersions: [], revisedVersions: [], tombstones: [] }, coverage: [], diagnostics: [{ scope: 'projection', code: 'bad_type', subject: 'input', provenance: [] }], packet: { id: null, tags: [], versions: [] }, blockers });
  if (!object(input)) return empty();
  try { canonical({ ...input, blockers: null }); } catch { return empty(); }
  const v2 = input.schema === 'normal-entry-facts/v2';
  if (!v2 && input.schema !== 'normal-entry-facts/v1') return empty();
  input = { ...JSON.parse(canonical({ ...input, blockers: null })), blockers };
  if (!keys(input, topKeys + (v2 ? " alarmStates" : ""))) add('projection', 'bad_type', 'input');
  if (blockers === null) add('projection', 'bad_type', 'blockers');
  const collection = (name, scope) => {
    if (Array.isArray(input[name])) return input[name];
    add(scope, 'bad_type', name); return [];
  };
  const previousCut = commit(input.previousCut) ? input.previousCut : null;
  const currentCut = commit(input.currentCut) ? input.currentCut : null;
  let cutStatus = input.cutStatus;
  if (!one(cutStatus, 'valid invalid unavailable') || !(input.repo === null || repoId(input.repo)) || !(input.previousCut === null || commit(input.previousCut)) || !(input.currentCut === null || commit(input.currentCut)) || typeof input.phase !== 'string') {
    cutStatus = 'invalid'; add('cut', 'bad_type', 'cut');
  }
  if (cutStatus === 'valid' && (!previousCut || !currentCut || !repoId(input.repo) || previousCut.length !== currentCut.length || currentCut.length !== input.repo.length - 9)) cutStatus = 'invalid';
  if (cutStatus !== 'valid') add('cut', cutStatus === 'unavailable' ? 'missing_cut' : 'bad_cut', 'cut');
  let cadence = input.cadence;
  if (!keys(cadence, 'due stateIdentity') || typeof cadence.due !== 'boolean' || !hash(cadence.stateIdentity)) { cadence = null; add('cadence', 'cadence_unknown', 'cadence'); }
  const coverage = [];
  for (const x of collection('coverage', 'coverage')) {
    if (coverageRow(x)) coverage.push(x); else add('coverage', 'bad_type', digest(x));
  }
  for (const x of collection('diagnostics', 'projection')) {
    if (diagnostic(x)) ds.push(x); else add('projection', 'bad_type', digest(x));
  }
  const rawEvents = collection('events', 'event');
  let extraInvalid = 0;
  const groups = new Map();
  for (const raw of rawEvents) {
    let x = raw;
    if (!event(x, v2)) {
      if (x?.validation !== 'invalid') extraInvalid++;
      add('event', 'bad_type', digest(raw), prov(raw?.provenance) ? raw.provenance : []);
      if (!object(x) || !str(x.logicalKey) || !hash(x.version) || !commit(x.publication) || !nat(x.publicationIndex)) continue;
      x = { logicalKey: x.logicalKey, version: x.version, publication: x.publication, publicationIndex: x.publicationIndex, current: typeof x.current === 'boolean' ? x.current : false, operation: one(x.operation, 'upsert delete') ? x.operation : 'upsert', predecessor: hash(x.predecessor) ? x.predecessor : null, source: null, validation: 'invalid', reason: 'bad_type', provenance: prov(x.provenance) ? x.provenance : [] };
    }
    if (x.validation !== 'valid') add('event', x.reason, x.version, x.provenance);
    const { provenance: p, ...body } = x;
    const k = canonical(body);
    if (!groups.has(k)) groups.set(k, { ...body, provenance: [], occurrences: 0 });
    const g = groups.get(k); g.provenance.push(...p); g.occurrences++;
  }
  const events = [...groups.values()];
  const dispositions = [];
  for (const raw of collection('dispositions', 'disposition')) {
    if (fact(raw)) dispositions.push(raw);
    else {
      const version = hash(raw?.version) ? raw.version : hash(raw?.value?.version) ? raw.value.version : null;
      dispositions.push({ value: object(raw?.value) ? raw.value : null, version, validation: 'invalid', reason: 'bad_type', provenance: prov(raw?.provenance) ? raw.provenance : [] });
      add('disposition', 'bad_type', version ?? digest(raw));
    }
  }
  const effective = dispositions.map(d => {
    if (d.validation !== 'valid') add('disposition', d.reason, d.version ?? digest(d.value), d.provenance);
    return d;
  });
  const alarmStates = new Map();
  if (v2) for (const s of collection('alarmStates', 'event')) {
    const occurrence = x => typeof x === 'string' && /^alarm-[a-f0-9]{64}$/.test(x);
    if (!keys(s, 'version occurrenceId identityBasis evaluatedAtCut applicability diagnosis successorOccurrenceId reason') || !hash(s.version) || !(s.occurrenceId === null || occurrence(s.occurrenceId)) || !one(s.identityBasis, 'source predecessor unverified') || s.evaluatedAtCut !== currentCut || !one(s.applicability, 'active superseded inactive unknown') || !one(s.diagnosis, 'covered required not_applicable unknown') || !(s.successorOccurrenceId === null || occurrence(s.successorOccurrenceId)) || !reason(s.reason) || (s.identityBasis === 'unverified') !== (s.occurrenceId === null)) {
      add('event', 'bad_type', hash(s?.version) ? s.version : digest(s)); continue;
    }
    if (alarmStates.has(s.version) && canonical(alarmStates.get(s.version)) !== canonical(s)) {
      alarmStates.set(s.version, null); add('event', 'bad_type', s.version);
    } else if (!alarmStates.has(s.version)) alarmStates.set(s.version, s);
  }
  const emittedAlarmStates = new Map();
  const items = [];
  for (const e of events) {
    const exact = effective.filter(d => d.version === e.version).map(d => d.validation === 'valid' && canonical(d.value.source) !== canonical(e.source) ? { ...d, validation: 'invalid', reason: 'invalid_disposition' } : d);
    const payloads = unique(exact.map(d => { if (d.value === null) return null; const { id: _id, ...payload } = d.value; return payload; }));
    const conflict = events.some(other => other !== e && (other.version === e.version || other.logicalKey === e.logicalKey && ((other.current && e.current) || other.publicationIndex === e.publicationIndex)));
    const predecessor = events.filter(other => other.version === e.predecessor && other.logicalKey === e.logicalKey && other.publicationIndex < e.publicationIndex);
    const broken = e.predecessor !== null ? predecessor.length === 0 || events.some(other => other.logicalKey === e.logicalKey && other.publicationIndex < e.publicationIndex && other.publicationIndex > predecessor[0]?.publicationIndex) : e.operation === 'delete' || events.some(other => other.logicalKey === e.logicalKey && other.publicationIndex < e.publicationIndex);
    let status = 'pending', why = 'absent';
    if (cutStatus !== 'valid') { status = 'unknown'; why = cutStatus === 'unavailable' ? 'missing_cut' : 'bad_cut'; }
    else if (e.validation !== 'valid' || conflict || broken) { status = 'unknown'; why = e.validation !== 'valid' ? e.reason : conflict ? 'duplicate_identity' : 'broken_chain'; }
    else if (payloads.length > 1) why = 'conflicting_disposition';
    else if (exact.some(d => d.validation === 'invalid')) why = 'invalid_disposition';
    else if (exact.some(d => d.validation !== 'valid')) why = 'unavailable_disposition';
    else if (exact.length && exact[0].value.outcome === 'UNKNOWN') why = 'unknown_outcome';
    else if (exact.length) { status = 'reconciled'; why = 'exact_link'; }
    else if (effective.some(d => events.some(other => other.logicalKey === e.logicalKey && other.version !== e.version && other.version === d.version))) why = 'stale';
    else if (e.operation === 'delete') why = 'deletion_review';
    if (v2 && (() => { try { return JSON.parse(e.logicalKey)[1] === 'alarm'; } catch { return false; } })()) {
      let state = alarmStates.get(e.version);
      const invalid = cutStatus !== 'valid' || e.validation !== 'valid' || conflict || broken;
      if (!state || invalid && state.applicability !== 'unknown') state = { version: e.version, occurrenceId: null, identityBasis: 'unverified', evaluatedAtCut: currentCut, applicability: 'unknown', diagnosis: 'unknown', successorOccurrenceId: null, reason: invalid ? why : 'bad_type' };
      if (invalid) state = { ...state, applicability: 'unknown', diagnosis: 'unknown', successorOccurrenceId: null, reason: why };
      if (state.applicability === 'unknown') {
        add('event', state.reason, e.version, e.provenance);
        if (e.current || e.operation === 'delete' || state.identityBasis === 'unverified') { status = 'unknown'; why = state.reason; }
      }
      emittedAlarmStates.set(e.version, state);
    }
    if (conflict || broken) add('event', conflict ? 'duplicate_identity' : 'broken_chain', e.version, e.provenance);
    for (const d of exact) if (d.validation !== 'valid') add('disposition', d.reason, e.version, d.provenance);
    items.push({ logicalKey: e.logicalKey, version: e.version, source: e.source, operation: e.operation, predecessor: e.predecessor, current: e.current, publication: e.publication, status, reason: why, dispositionIds: unique(exact.map(d => d.value?.id).filter(id)), provenance: sortedProv(e.provenance) });
  }
  items.sort((a, b) => cmp(a.logicalKey, b.logicalKey) || events.find(e => e.version === a.version).publicationIndex - events.find(e => e.version === b.version).publicationIndex || cmp(a.version, b.version) || cmp(canonical(a), canonical(b)));
  const ai = input.accountingInput;
  const validAccounting = keys(ai, 'inputOccurrences invalidOccurrences') && nat(ai.inputOccurrences) && nat(ai.invalidOccurrences) && ai.invalidOccurrences <= ai.inputOccurrences;
  const inputOccurrences = validAccounting ? ai.inputOccurrences : rawEvents.length;
  const invalidOccurrences = (validAccounting ? ai.invalidOccurrences : rawEvents.filter(x => x?.validation === 'invalid').length) + extraInvalid;
  const representedOccurrences = rawEvents.reduce((n, e) => n + Math.max(1, prov(e?.provenance) ? e.provenance.length : 0), 0);
  if (!validAccounting || inputOccurrences < representedOccurrences || inputOccurrences > representedOccurrences + (validAccounting ? ai.invalidOccurrences : 0) || invalidOccurrences > inputOccurrences || (validAccounting && ai.invalidOccurrences < rawEvents.filter(x => x?.validation === 'invalid').length)) add('projection', 'bad_type', 'accountingInput');
  for (const d of ds) if (['event', 'disposition', 'manifest', 'projection'].includes(d.scope)) coverage.push({ family: 'inventory', availability: 'partial', completeness: 'unknown', reason: d.code });
  const diagnosticGroups = new Map();
  for (const d of ds) {
    const k = canonical([d.scope, d.code, d.subject]);
    if (!diagnosticGroups.has(k)) diagnosticGroups.set(k, { ...d, provenance: [] });
    diagnosticGroups.get(k).provenance.push(...d.provenance);
  }
  const diagnostics = [...diagnosticGroups.values()].map(d => ({ ...d, provenance: sortedProv(d.provenance) })).sort((a, b) => cmp(a.scope, b.scope) || cmp(a.code, b.code) || cmp(a.subject, b.subject));
  const families = new Set(events.flatMap(e => { try { const k = JSON.parse(e.logicalKey); return Array.isArray(k) ? [k[1], 'inventory'] : ['inventory']; } catch { return ['inventory']; } }));
  const state = cutStatus !== 'valid' || diagnostics.length || items.some(i => i.status === 'unknown') || coverage.some(c => families.has(c.family) && one(c.availability, 'partial unavailable')) ? 'unknown' : items.some(i => i.status === 'pending') || cadence?.due ? 'pending' : 'accounted';
  const versions = unique(items.filter(i => i.status !== 'reconciled').map(i => i.version));
  return { schema: v2 ? 'normal-entry-projection/v2' : 'normal-entry-projection/v1', ...(v2 ? { alarmStates: [...emittedAlarmStates.values()].sort((a, b) => cmp(a.version, b.version)) } : {}), previousCut, currentCut, state, items, accounting: { inputOccurrences, uniqueVersions: events.length, duplicateOccurrences: events.reduce((n, e) => n + Math.max(e.occurrences - 1, sortedProv(e.provenance).length - new Set(e.provenance.map(p => p.revision)).size), 0), invalidOccurrences, unchangedVersions: unique(events.filter(e => new Set(e.provenance.map(p => p.revision)).size > 1).map(e => e.version)), revisedVersions: unique(events.filter(e => e.operation === 'upsert' && e.predecessor !== null).map(e => e.version)), tombstones: unique(events.filter(e => e.operation === 'delete').map(e => e.version)) }, coverage: unique(coverage), diagnostics, packet: { id: repoId(input.repo) && currentCut && typeof input.phase === 'string' ? digest([input.repo, currentCut, input.phase]) : null, tags: [...(versions.length ? ['event'] : []), ...(cadence?.due ? ['cadence'] : [])], versions }, blockers };
}
