import test from 'node:test';
import assert from 'node:assert/strict';
import { normalOpportunities } from '../lib/normal-entry.mjs';

const sha = n => n.toString(16).padStart(64, '0');
const rev = n => n.toString(16).padStart(40, '0');
const repo = `git-root:${rev(1)}`;
const key = n => JSON.stringify([repo, 'answer_clause', 'owner/answers.jsonl', `answer-${n}`, 'clause']);
const pointer = () => ({ repo, revision: rev(2), path: 'decisions/D-0001.md', selector: { type: 'document' }, entryRange: [0, 30], clauseRange: [1, 10], blobSha256: sha(1), clauseSha256: sha(2) });
const provenance = (n = 0, r = 3) => ({ revision: rev(r), path: 'evidence/normal-entry/manifest.json', selector: `/inventory/${n}` });
const event = (n = 1, extra = {}) => ({ logicalKey: key(n), version: sha(n), current: true, publication: rev(3), publicationIndex: 3, operation: 'upsert', predecessor: null, source: pointer(), validation: 'valid', reason: 'ok', provenance: [provenance(n)], ...extra });
const disposition = (e, extra = {}) => ({ value: { id: 'd1', version: e.version, source: e.source, outcome: 'CHANGE', rationale: pointer(), ruling: pointer(), consumer: pointer(), decision: 'withhold', task: null, reason: 'Wait until separately authorized.', ...extra }, validation: 'valid', reason: 'ok', version: e.version, provenance: [] });
const input = (extra = {}) => ({ schema: 'normal-entry-facts/v1', repo, previousCut: rev(2), currentCut: rev(5), cutStatus: 'valid', phase: 'v1', events: [], dispositions: [], cadence: { due: false, stateIdentity: sha(44) }, blockers: { open: ['kept'], shelved: ['kept-too'] }, coverage: [{ family: 'answer_clause', availability: 'available', completeness: 'unknown', reason: 'unenumerated_sources' }], diagnostics: [], accountingInput: { inputOccurrences: extra.events?.length ?? 0, invalidOccurrences: extra.events?.filter(e => e?.validation === 'invalid').length ?? 0 }, ...extra });
const project = (e, ds = [], extra = {}) => normalOpportunities(input({ events: [e], dispositions: ds, ...extra }));

test('bounded empty and unenumerated coverage do not mask pending; blockers retain identity', () => {
  const x = input({ events: [event()] });
  const before = structuredClone(x);
  const result = normalOpportunities(x);
  assert.equal(result.state, 'pending');
  assert.equal(result.items[0].reason, 'absent');
  assert.strictEqual(result.blockers, x.blockers);
  assert.deepEqual(x, before);
  assert.equal(normalOpportunities(input()).state, 'accounted');
  assert.equal(normalOpportunities(input()).coverage[0].completeness, 'unknown');
});

test('A12 exact disposition precedence and valid controls', () => {
  const e = event(), d = disposition(e);
  const cases = [
    [[], 'absent', 'pending'],
    [[{ ...d, validation: 'invalid', reason: 'bad_digest' }], 'invalid_disposition', 'pending'],
    [[{ ...d, validation: 'unavailable', reason: 'source_unavailable' }], 'unavailable_disposition', 'pending'],
    [[disposition(e, { outcome: 'UNKNOWN' })], 'unknown_outcome', 'pending'],
    [[d], 'exact_link', 'reconciled'],
    [[disposition(e, { outcome: 'NO_CHANGE' })], 'exact_link', 'reconciled'],
    [[d, disposition(e, { id: 'd2' })], 'exact_link', 'reconciled'],
    [[d, disposition(e, { reason: 'Another claim.' })], 'conflicting_disposition', 'pending'],
  ];
  for (const [ds, why, status] of cases) {
    const item = project(e, ds).items[0];
    assert.equal(item.reason, why); assert.equal(item.status, status);
    assert.equal(project({ ...e, validation: 'unknown', reason: 'source_unavailable' }, ds).items[0].status, 'unknown');
  }
  assert.deepEqual(project(e, [d, disposition(e, { id: 'd2' })]).items[0].dispositionIds, ['d1', 'd2']);
});

test('A18 distinct invalid candidate conflicts before invalid status', () => {
  const e = event(), d = disposition(e);
  const bad = { ...disposition(e, { reason: 'Conflicting claim.' }), validation: 'invalid', reason: 'bad_span' };
  const out = project(e, [d, bad]);
  assert.equal(out.items[0].reason, 'conflicting_disposition');
  assert.ok(out.diagnostics.some(d => d.code === 'bad_span'));
});

test('A05 historical obligations survive revisions, rebind is explicit, unrelated clause unchanged', () => {
  const old = event(1, { current: false });
  const revised = event(1, { version: sha(2), predecessor: old.version, publication: rev(4), publicationIndex: 4 });
  const independent = event(3);
  const x = input({ events: [old, revised, independent], dispositions: [disposition(old), disposition(independent)] });
  let out = normalOpportunities(x);
  assert.equal(out.items.find(i => i.version === revised.version).reason, 'stale');
  assert.equal(out.items.find(i => i.version === independent.version).status, 'reconciled');
  x.dispositions.push(disposition(revised));
  out = normalOpportunities(x);
  assert.ok(out.items.every(i => i.status === 'reconciled'));
  assert.deepEqual(out.accounting.revisedVersions, [revised.version]);
  assert.equal(out.state, 'accounted');
});

test('A06 delete and re-add retain unresolved historical obligations', () => {
  const old = event(1, { current: false });
  const deleted = event(1, { version: sha(2), predecessor: old.version, publication: rev(4), publicationIndex: 4, operation: 'delete', source: null, current: false });
  const added = event(1, { version: sha(3), predecessor: deleted.version, publication: rev(5), publicationIndex: 5 });
  const out = normalOpportunities(input({ events: [old, deleted, added] }));
  assert.deepEqual(out.items.map(i => i.reason), ['absent', 'deletion_review', 'absent']);
  assert.deepEqual(out.accounting.tombstones, [deleted.version]);
  assert.equal(out.items.length, 3);
});

test('A09 invalid and unavailable cuts override exact evidence', () => {
  const e = event();
  for (const [cutStatus, why] of [['invalid', 'bad_cut'], ['unavailable', 'missing_cut']]) {
    const out = project(e, [disposition(e)], { cutStatus });
    assert.equal(out.state, 'unknown'); assert.equal(out.items[0].reason, why);
  }
});

test('A10 duplicates preserve provenance; permutations and repeated evaluations agree', () => {
  const e = event(), duplicate = { ...e, provenance: [provenance(9)] };
  const d = disposition(e), ds = [d, disposition(e, { id: 'd2' })];
  const a = input({ events: [e, duplicate, event(2)], dispositions: ds });
  const b = { ...a, events: [...a.events].reverse(), dispositions: [...ds].reverse() };
  assert.deepEqual(normalOpportunities(a), normalOpportunities(b));
  assert.equal(JSON.stringify(normalOpportunities(a)), JSON.stringify(normalOpportunities(a)));
  const out = normalOpportunities(a);
  assert.equal(out.accounting.duplicateOccurrences, 1);
  assert.equal(out.accounting.uniqueVersions, 2);
  assert.equal(out.items[0].provenance.length, 2);
  const conflict = event(1, { version: sha(3) });
  assert.ok(normalOpportunities(input({ events: [e, conflict] })).items.every(i => i.reason === 'duplicate_identity'));
});

test('A11 malformed local fields preserve valid neighbors and diagnostics', () => {
  const e = event();
  const malformed = event(2); delete malformed.current;
  const x = input({ events: [e, malformed, null], dispositions: {} });
  const out = normalOpportunities(x);
  assert.equal(out.items.find(i => i.version === e.version).status, 'pending');
  assert.equal(out.items.find(i => i.version === malformed.version).status, 'unknown');
  assert.equal(out.accounting.invalidOccurrences, 2);
  assert.equal(out.state, 'unknown');
  for (const code of ['bad_span', 'bad_digest', 'unknown_kind']) {
    const bad = event(2, { validation: 'invalid', reason: code, source: null });
    assert.ok(normalOpportunities(input({ events: [e, bad] })).diagnostics.some(d => d.code === code));
  }
});

test('A13 one packet coalesces event and cadence; reconciliation never resets cadence', () => {
  const e = event();
  for (const [events, dispositions, due, tags] of [
    [[e], [], false, ['event']], [[], [], true, ['cadence']],
    [[e], [], true, ['event', 'cadence']], [[e], [disposition(e)], true, ['cadence']],
  ]) {
    const x = input({ events, dispositions, cadence: { due, stateIdentity: sha(44) } });
    const out = normalOpportunities(x);
    assert.deepEqual(out.packet.tags, tags); assert.equal(x.cadence.due, due);
  }
  assert.notEqual(project(e).packet.id, project(e, [], { currentCut: rev(6) }).packet.id);
  assert.equal(project(e).items[0].version, project(e, [], { currentCut: rev(6) }).items[0].version);
  assert.ok(project(e, [], { cadence: null }).diagnostics.some(d => d.code === 'cadence_unknown'));
});

test('A19 withdrawn dispositions never carry through provenance', () => {
  const e = event();
  assert.equal(project(e, [disposition(e)]).items[0].status, 'reconciled');
  assert.equal(project(e).items[0].reason, 'absent');
});

test('unbound malformed dispositions do not veto exact match; wrong tuple cannot reconcile', () => {
  const e = event();
  const out = project(e, [disposition(e), null]);
  assert.equal(out.items[0].status, 'reconciled'); assert.equal(out.state, 'unknown');
  assert.equal(project(e, [disposition(e, { source: { ...pointer(), clauseSha256: sha(99) } })]).items[0].reason, 'invalid_disposition');
  const bad = disposition(e); delete bad.value.task;
  assert.equal(project(e, [bad]).items[0].reason, 'invalid_disposition');
});

test('total fallback and bad accounting, missing fields, unknown keys, broken chains', () => {
  for (const value of [null, undefined, 1, [], {}, { schema: 'wrong', blockers: {} }]) assert.equal(normalOpportunities(value).state, 'unknown');
  const cyclic = input(); cyclic.events.push(cyclic); assert.equal(normalOpportunities(cyclic).state, 'unknown');
  const e = event();
  assert.equal(project(e, [], { accountingInput: { inputOccurrences: 0, invalidOccurrences: 0 } }).state, 'unknown');
  assert.equal(project({ ...e, unexpected: true }).items[0].status, 'unknown');
  assert.equal(project({ ...e, predecessor: sha(99) }).items[0].reason, 'broken_chain');
  const x = input({ events: [e] }); delete x.dispositions;
  assert.equal(normalOpportunities(x).items[0].status, 'pending');
  assert.equal(normalOpportunities(x).state, 'unknown');
});

test('canonical object keys and set order are independent of insertion order', () => {
  const e = event();
  const reverseKeys = x => Array.isArray(x) ? x.map(reverseKeys) : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).reverse().map(([k, v]) => [k, reverseKeys(v)])) : x;
  const a = input({ events: [e], dispositions: [disposition(e)] });
  const b = reverseKeys(a); b.blockers = a.blockers;
  assert.equal(JSON.stringify(normalOpportunities(a)), JSON.stringify(normalOpportunities(b)));
});

test('adapter-coalesced provenance reports duplicate and unchanged snapshots', () => {
  const e = event(1, { provenance: [provenance(0, 3), provenance(1, 3), provenance(0, 4)] });
  const out = project(e, [], { accountingInput: { inputOccurrences: 3, invalidOccurrences: 0 } });
  assert.equal(out.accounting.duplicateOccurrences, 1);
  assert.deepEqual(out.accounting.unchangedVersions, [e.version]);
  assert.equal(out.items.length, 1);
});

test('a lineage cannot skip a known predecessor; declared unavailable family is unknown', () => {
  const a = event(1, { current: false });
  const b = event(1, { version: sha(2), current: false, predecessor: a.version, publicationIndex: 4, publication: rev(4) });
  const c = event(1, { version: sha(3), predecessor: a.version, publicationIndex: 5, publication: rev(5) });
  const out = normalOpportunities(input({ events: [a, b, c] }));
  assert.equal(out.items.find(i => i.version === c.version).reason, 'broken_chain');
  assert.equal(project(event(), [], { coverage: [{ family: 'answer_clause', availability: 'unavailable', completeness: 'unknown', reason: 'source_unavailable' }] }).state, 'unknown');
});

test('opaque blockers are not serialized and accounting cannot invent occurrences', () => {
  const blockers = {}; blockers.self = blockers;
  const out = project(event(), [], { blockers });
  assert.strictEqual(out.blockers, blockers);
  assert.equal(out.items.length, 1);
  assert.equal(project(event(), [], { accountingInput: { inputOccurrences: 99, invalidOccurrences: 0 } }).state, 'unknown');
});

test('malformed logical tuple cannot acquire reconciliation authority', () => {
  const e = event(1, { logicalKey: 'not-a-canonical-tuple' });
  const out = project(e, [disposition(e)]);
  assert.equal(out.items[0].status, 'unknown');
  assert.equal(out.items[0].reason, 'bad_type');
});

const alarmEvent = extra => event(21, { logicalKey: JSON.stringify([repo, 'alarm', 'metrics/trajectory.jsonl', 'alarm-'+sha(91), 'alarm']), ...extra });
const alarmState = (e, extra = {}) => ({ version: e.version, occurrenceId: 'alarm-'+sha(91), identityBasis: 'source', evaluatedAtCut: rev(5), applicability: 'active', diagnosis: 'required', successorOccurrenceId: null, reason: 'alarm_active', ...extra });
const alarmInput = (events, states, dispositions = []) => input({ schema: 'normal-entry-facts/v2', events, alarmStates: states, dispositions });
test('AE current unknown context vetoes accounting while historical exact accounting survives', () => {
  for (const current of [true, false]) {
    const e = alarmEvent({current}), s = alarmState(e, {applicability:'unknown',diagnosis:'unknown',reason:'alarm_context_unknown'});
    const p = normalOpportunities(alarmInput([e],[s],[disposition(e)]));
    assert.equal(p.schema,'normal-entry-projection/v2');
    assert.equal(p.items[0].status,current?'unknown':'reconciled');
    assert.equal(p.state,'unknown'); assert.deepEqual(p.alarmStates,[s]);
  }
});
test('AE nullable invalid identities are total; duplicate versions have one state', () => {
  const e = alarmEvent({validation:'invalid',reason:'bad_pointer',source:null});
  const s = alarmState(e,{occurrenceId:null,identityBasis:'unverified',applicability:'unknown',diagnosis:'unknown',reason:'bad_pointer'});
  const p = normalOpportunities(alarmInput([e,e],[s]));
  assert.deepEqual(p.alarmStates,[s]); assert.equal(p.items.length,1); assert.equal(p.items[0].reason,'bad_pointer');
});
test('AE deletion is accountable despite unknown predecessor applicability', () => {
  const e = alarmEvent({current:false});
  const d = {...e,version:sha(22),publication:rev(4),publicationIndex:4,current:true,operation:'delete',source:null,predecessor:e.version};
  const old = alarmState(e,{applicability:'unknown',diagnosis:'unknown',reason:'alarm_context_unknown'});
  const tombstone = alarmState(d,{identityBasis:'predecessor',applicability:'inactive',diagnosis:'not_applicable',reason:'alarm_inactive'});
  const p = normalOpportunities(alarmInput([e,d],[old,tombstone],[disposition(d)]));
  assert.equal(p.items.find(i=>i.version===d.version).status,'reconciled');
  assert.equal(p.items.find(i=>i.version===e.version).status,'pending');
  assert.equal(p.state,'unknown');
});
test('AE active diagnosis and supersession never discharge absent dispositions', () => {
  const e=alarmEvent({});
  for(const s of [alarmState(e),alarmState(e,{diagnosis:'covered'}),alarmState(e,{applicability:'superseded',diagnosis:'not_applicable',successorOccurrenceId:'alarm-'+sha(92),reason:'alarm_superseded'})]) {
    const p=normalOpportunities(alarmInput([e],[s])); assert.equal(p.items[0].status,'pending');assert.equal(p.items[0].reason,'absent');
    assert.deepEqual(p,normalOpportunities(alarmInput([e],[s])));
  }
});
test('AE v2 requires state for every keyed alarm, empty activation is explicit', () => {
  const e=alarmEvent({}); const p=normalOpportunities(alarmInput([e],[]));
  assert.equal(p.items[0].status,'unknown');assert.equal(p.alarmStates.length,1);assert.equal(p.alarmStates[0].occurrenceId,null);
  assert.deepEqual(normalOpportunities(alarmInput([],[])).alarmStates,[]);
  assert(!Object.hasOwn(normalOpportunities(input()),'alarmStates'));
});
