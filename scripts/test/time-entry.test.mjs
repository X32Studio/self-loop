// design/time-entry.md
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import test from 'node:test';
import { cliClock, queryClock, timeLines } from '../loop.mjs';
import { main } from '../self-loop.mjs';
import { reconcileParentEntry } from '../lib/start.mjs';
import { isolatedEnv, loopProduct, ownerStore, scripts, selfLoop } from './helpers.mjs';

const NOW = '2026-11-22T12:00:00.000Z';
const at = Date.parse(NOW);
const projection = {
  rootPlan: 'PL-0001', plan: 'PL-0002', queriedAt: NOW, clockMode: 'simulation', elapsedSeconds: null,
  remainingSeconds: -60, deadline: '2026-11-22T11:59:00Z',
  forecast: { asOf: '2026-11-22T10:00:00Z', earliestAt: null, latestAt: null, stale: true,
    conditionalOn: ['capacity available'], unknowns: ['CI duration unbounded'], staleReasons: ['checkpoint expired'] },
  checkpoint: { nextAt: '2026-11-22T13:00:00Z', missed: [{ at: '2026-11-22T11:00:00Z' }] },
  promises: [{ id: 'usable', status: 'timing-unverified' }], history: [{ plan: 'PL-0001' }],
  findings: ['clock-anomaly'], actions: ['refresh from evidence'],
};

test('clock parsing distinguishes live and simulation, rejects calendar and timezone ambiguity', () => {
  assert.equal(cliClock({}).clockMode, 'live');
  assert.deepEqual(cliClock({ now: NOW }), { now: at, clockMode: 'simulation' });
  assert.deepEqual(queryClock({ now: at, clockMode: 'live' }), { now: at, clockMode: 'live' });
  for (const now of ['', 'bad', '2026-02-30T00:00:00Z', '2026-11-22T12:00:00', '2026-11-22T12:00:00+00:00'])
    assert.throws(() => cliClock({ now }), /--now/);
});

test('synthetic parent entry fails before input validation or registry access on start and next', async () => {
  for (const command of ['start', 'next']) for (const now of [NOW, '', 'bad']) {
    assert.throws(() => main([command, '--now', now, '--parent-entry', '/missing/input', '--hours', 'bad', '--owner-store', '/missing/store']), /--now simulation.*--parent-entry/);
  }
  await assert.rejects(reconcileParentEntry({ now: at, clockMode: 'simulation' }), /--now simulation.*--parent-entry/);
});

test('TimeProjection rendering preserves unknown, overdue, stale, promises and historical misses', () => {
  const before = structuredClone(projection), text = timeLines(projection).join('\n');
  for (const label of ['read-only simulation', 'Elapsed: unknown', 'overdue by 60 s', 'earliest unknown', 'latest unknown',
    'Forecast uncertainty: CI duration unbounded', 'Stale reason: checkpoint expired', 'Missed checkpoint history:',
    'Promise history:', 'timing-unverified', 'Forecast history:', 'actual parent entry']) assert.ok(text.includes(label), label);
  assert.match(timeLines({ ...projection, remainingSeconds: 0 }).join('\n'), /due now \(0 s\)/);
  assert.match(timeLines({ ...projection, remainingSeconds: null }).join('\n'), /budget: unknown/);
  assert.match(timeLines({ ...projection, checkpoint: { nextAt: NOW } }).join('\n'), /checkpoint: .*due now/);
  assert.deepEqual(timeLines(null), []);
  assert.deepEqual(projection, before);
});

function stubCheck(source, env = isolatedEnv()) {
  const run = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--input-type=module', '-e',
    `import assert from 'node:assert/strict'; import { mock } from 'node:test'; ${source}`], { encoding: 'utf8', env, cwd: scripts });
  assert.equal(run.status, 0, run.stderr || run.stdout);
}

test('stub coverage: measures passes identical clock to every plan and displays frozen projection', () => {
  stubCheck(`
    const calls = [];
    const real = await import('./lib/plan-measures.mjs');
    mock.module('./lib/plan-measures.mjs', { namedExports: { ...real, measurePlan(s,p,o) {
      calls.push(o); return { criticalPath: {seconds:null}, idleDispatchable:{seconds:null}, ownerWaiting:{intervals:[]}, time:${JSON.stringify(projection)} };
    }, renderMeasures() {} } });
    const { measuresLines } = await import('./loop.mjs');
    const text = measuresLines({ reconciled:{state:{}, plans:[{plan:{id:'PL-0001'}, result:{}},{plan:{id:'PL-0002'},result:{}}]}, cadence:{state:{returns:[]}}, now:${at}, clockMode:'simulation' }).join('\\n');
    assert.equal(calls.length,2); for (const c of calls) assert.deepEqual(c,{now:${at},clockMode:'simulation'});
    assert.match(text,/overdue by 60 s/);
  `);
});

test('stub coverage: start session and next --all forward one clock to each nextLines call', () => {
  const product = loopProduct(), store = ownerStore([{ name: 'one', records: product.records }]);
  stubCheck(`
    const real = await import('./loop.mjs'); const calls = [];
    mock.module('./loop.mjs', { namedExports: {...real, nextLines(c,f,s,o) { calls.push(o); return 'stub next'; }} });
    const { main } = await import('./self-loop.mjs');
    main(['start','--config',${JSON.stringify(join(product.records, 'loop.json'))},'--now',${JSON.stringify(NOW)},'--json']);
    main(['next','--all','--now',${JSON.stringify(NOW)}]);
    assert.equal(calls.length,2); for(const c of calls) { assert.equal(c.now,${at}); assert.equal(c.clockMode,'simulation'); }
    calls.length=0;
    main(['start','--config',${JSON.stringify(join(product.records, 'loop.json'))},'--json']);
    assert.equal(calls[0].clockMode,'live'); assert.equal(typeof calls[0].now,'number');
  `, isolatedEnv({ SELF_LOOP_OWNER_STORE: store }));
});

test('real legacy start exposes simulation clock and retains normal opportunities without time plans', () => {
  const product = loopProduct(), store = ownerStore([{ name: 'one', records: product.records }]);
  const result = selfLoop(['start', '--config', join(product.records, 'loop.json'), '--now', NOW, '--json'], { env: isolatedEnv({ SELF_LOOP_OWNER_STORE: store }) });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.clock, { now: NOW, mode: 'simulation', source: 'injected' });
  assert.match(report.session.next, /Normal opportunities:/);
});

// design/time-entry.md
test('stub coverage: plan measure CLI forwards simulation clock without changing JSON projection', () => {
  stubCheck(`
    const plans = await import('./lib/plan.mjs');
    const measures = await import('./lib/plan-measures.mjs');
    mock.module('./lib/plan.mjs', { namedExports: {...plans, snapshot(){return {};}, loadPlan(){return {id:'PL-0001'};} } });
    mock.module('./lib/plan-measures.mjs', { namedExports: {...measures, measurePlan(s,p,o){
      assert.deepEqual(o,{now:${at},clockMode:'simulation'}); return {time:${JSON.stringify(projection)}};
    }} });
    const {main} = await import('./plan.mjs');
    let output; console.log = value => {output=value;};
    main(['measure','--records','/unused','--plan','PL-0001','--now',${JSON.stringify(NOW)},'--json']);
    assert.deepEqual(JSON.parse(output).time,${JSON.stringify(projection)});
  `);
});
