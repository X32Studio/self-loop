// self-loop-records@ab79919:evidence/0011/brief-canonical-path-acceptance.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { capture } from '../lib/continuation.mjs';
import { bytesHash, generationOf, identity, LEDGER, obligationOf, parseLedger } from '../lib/continuation-store.mjs';
import { git, loopProduct, ownerStore, temp } from './helpers.mjs';

function fixture(t) {
  const dir = realpathSync(temp('self-loop-canonical-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const f = loopProduct({ dir });
  const alias = join(dir, 'records-alias');
  symlinkSync(f.records, alias, 'dir');
  assert.notEqual(alias, f.records);
  assert.equal(realpathSync(alias), f.records);
  const storeDir = join(dir, 'owner');
  mkdirSync(storeDir);
  const store = ownerStore([{ name: 'canonical-fixture', records: f.records, aliases: [] }], { dir: storeDir });
  const prior = process.env.SELF_LOOP_OWNER_STORE;
  process.env.SELF_LOOP_OWNER_STORE = store;
  t.after(() => {
    if (prior === undefined) delete process.env.SELF_LOOP_OWNER_STORE;
    else process.env.SELF_LOOP_OWNER_STORE = prior;
  });
  const write = (path, body) => {
    mkdirSync(dirname(join(f.records, path)), { recursive: true });
    writeFileSync(join(f.records, path), typeof body === 'string' ? body : JSON.stringify(body));
  };
  const commit = () => {
    git(f.records, 'add', '-A');
    git(f.records, 'commit', '-qm', 'Canonical path acceptance fixture');
  };
  const pointer = path => ({ repository: f.records, commit: git(f.records, 'rev-parse', 'HEAD'), path,
    sha256: bytesHash(readFileSync(join(f.records, path))) });
  write('plans/PL-0001.md', { id: 'PL-0001', phase: 'v1', scope: 'canonical/path', packages: [{
    id: 'review', authority: ['D-0001'], goal: 'Review canonical path evidence', files: [],
    interface: 'Review only', needs: [], role: 'actor', acceptance: 'Canonical evidence exists',
    handoff: 'R-0001-actor-review', task: import.meta.filename,
  }] });
  write('decisions/D-0001.md', '# D-0001\nReview only; no runtime launch.\n');
  write('delegations/T-0001.md', '# T-0001\nCanonical path review coordinator.\n');
  write('records.json', { extraKinds: [{ kind: 'Continuation delivery', path: LEDGER,
    changes: 'append-only', settlesOwnerWords: false }] });
  commit();
  const binding = { productKey: identity([f.records]), scope: 'canonical/path', phase: 'v1',
    planRef: pointer('plans/PL-0001.md'), delegationRef: pointer('delegations/T-0001.md'),
    attemptRef: null, nonce: null, environmentId: 'env', parentThreadId: 'parent', taskId: 'task',
    childThreadId: 'child', runId: 'run', generation: '' };
  binding.generation = generationOf(binding);
  write('evidence/0001/binding.json', binding);
  write('evidence/0001/terminal.json', { environmentId: 'env', taskId: 'task',
    latestTerminalRunId: 'run', latestTerminalStatus: 'failed' });
  commit();
  const bindingRef = pointer('evidence/0001/binding.json');
  const observation = { source: 't3-terminal', sourceRef: pointer('evidence/0001/terminal.json'), terminalStatus: 'failed' };
  const snapshot = () => ({
    head: git(f.records, 'rev-parse', 'HEAD'),
    status: git(f.records, 'status', '--porcelain=v1', '--untracked-files=all'),
    ledger: existsSync(join(f.records, LEDGER)) ? readFileSync(join(f.records, LEDGER)) : null,
    ownerHead: git(store, 'rev-parse', 'HEAD'),
    ownerStatus: git(store, 'status', '--porcelain=v1', '--untracked-files=all'),
  });
  return { ...f, alias, binding, bindingRef, observation, write, commit, pointer, snapshot };
}

async function accepted(f) {
  const result = await capture(f.observation, f.bindingRef, f.records);
  assert.deepEqual(result.unknowns, []);
  assert.ok(result.rowId);
  assert.equal(result.obligationId, obligationOf(f.binding));
  assert.equal(result.commit, git(f.records, 'rev-parse', 'HEAD'));
  const durable = git(f.records, 'show', `${result.commit}:${LEDGER}`);
  assert.equal(readFileSync(join(f.records, LEDGER), 'utf8').trimEnd(), durable);
  const rows = parseLedger(`${durable}\n`);
  assert.deepEqual(rows.map(row => row.type), ['bind', 'observe']);
  assert.deepEqual(rows[0].payload, f.binding);
  assert.equal(rows[1].rowId, result.rowId);
  assert.deepEqual(rows[1].payload.sourceRef, f.observation.sourceRef);
  assert.equal(rows[1].payload.bindingRowId, rows[0].rowId);
  assert.equal(rows[1].payload.obligationId, result.obligationId);
  return result;
}

test('canonical capture publishes durable binding and observation through a real filesystem alias fixture', async t => {
  const f = fixture(t), before = f.snapshot();
  assert.equal(before.ledger, null);
  const result = await accepted(f);
  assert.notEqual(result.commit, before.head);
  const published = f.snapshot();
  assert.equal((await accepted(f)).commit, result.commit);
  assert.deepEqual(f.snapshot(), published);
});

for (const seeded of [false, true]) {
  for (const mismatch of ['bindingRef', 'sourceRef', 'planRef', 'delegationRef', 'productKey']) {
    test(`${mismatch} alias rejects without writes (${seeded ? 'existing' : 'absent'} ledger); canonical control succeeds`, async t => {
      const f = fixture(t);
      let bindingRef = structuredClone(f.bindingRef), observation = structuredClone(f.observation);
      if (mismatch === 'bindingRef') bindingRef.repository = f.alias;
      else if (mismatch === 'sourceRef') observation.sourceRef.repository = f.alias;
      else {
        const bad = structuredClone(f.binding);
        if (mismatch === 'productKey') {
          bad.productKey = identity([f.alias]);
          assert.notEqual(bad.productKey, f.binding.productKey);
        } else bad[mismatch].repository = f.alias;
        bad.generation = generationOf(bad);
        f.write('evidence/0001/mismatched-binding.json', bad);
        f.commit();
        bindingRef = f.pointer('evidence/0001/mismatched-binding.json');
        assert.equal(bindingRef.repository, f.records);
      }
      if (seeded) await accepted(f);
      const before = f.snapshot();
      assert.equal(before.ledger !== null, seeded);
      const rejected = await capture(observation, bindingRef, f.records);
      assert.equal(rejected.rowId, null);
      assert.equal(rejected.obligationId, null);
      assert.deepEqual(rejected.unknowns, [mismatch === 'productKey'
        ? 'continuation: binding identity mismatch' : 'continuation: invalid, private or foreign reference']);
      assert.equal(rejected.commit, before.head);
      assert.deepEqual(f.snapshot(), before);
      await accepted(f);
    });
  }
}
