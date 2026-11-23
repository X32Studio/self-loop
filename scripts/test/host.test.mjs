// D-0025, D-0027, D-0029, design/driver.md#host-load
import assert from "node:assert/strict";
import { freemem, totalmem } from "node:os";
import test from "node:test";
import { GiB, hostLine, measureHost, memoryFloor, overBound } from "../lib/host.mjs";
import { MAX_LOAD_RATIO, MIN_AVAILABLE_MEMORY_GB, MIN_AVAILABLE_MEMORY_SHARE } from "../lib/thresholds.mjs";
import { HOST_BOUND, parseRegistry } from "../lib/registry.mjs";

test("the defaults are the measured bound of D-0025 and D-0029: 70 % of the cores, and the smaller of 16 GiB and a quarter of the total memory", () => {
  assert.equal(MAX_LOAD_RATIO, 0.7);
  assert.equal(MIN_AVAILABLE_MEMORY_GB, 16);
  assert.equal(MIN_AVAILABLE_MEMORY_SHARE, 0.25);
  assert.equal(GiB, 2 ** 30);
});

test("available memory is os.freemem() and the total os.totalmem(), in GiB", () => {
  const measured = measureHost();
  assert.equal(measured.memory, "os.freemem()");
  assert.equal(measured.total, "os.totalmem()");
  assert.ok(Math.abs(measured.availableGiB - freemem() / GiB) < 1);
  assert.equal(measured.totalGiB, totalmem() / GiB);
  assert.ok(measured.cores >= 1 && Number.isFinite(measured.load1));
});

test("the default memory floor scales down on a host with less than 64 GiB, and a floor the owner store sets is used as written", () => {
  const host = totalGiB => ({ load1: 0, cores: 4, availableGiB: 0, totalGiB });
  assert.equal(memoryFloor(HOST_BOUND, host(120)), 16);
  assert.equal(memoryFloor(HOST_BOUND, host(64)), 16);
  assert.equal(memoryFloor(HOST_BOUND, host(16)), 4);
  assert.equal(memoryFloor(HOST_BOUND, host(7.5)), 1.875);
  assert.equal(memoryFloor(HOST_BOUND, host(0)), 16, "an unreadable total keeps the 16 GiB floor");
  assert.equal(memoryFloor(HOST_BOUND, host(NaN)), 16);
  const set = parseRegistry(JSON.stringify({ products: [], minAvailableMemoryGB: 12 })).bound;
  assert.equal(memoryFloor(set, host(16)), 12);
  assert.equal(memoryFloor(parseRegistry(JSON.stringify({ products: [], maxLoadRatio: 2 })).bound, host(16)), 4);
});

test("a heavy call is admitted only while the load is at most the ratio times the cores and the memory at least the floor", () => {
  const bound = { ...HOST_BOUND, source: "test" };
  const host = (load1, availableGiB, cores = 20, totalGiB = 128) => ({ load1, cores, availableGiB, totalGiB, load: "load", memory: "free", total: "total" });
  assert.deepEqual(overBound(host(14, 16), bound), []);
  assert.deepEqual(overBound(host(0, 100), bound), []);
  assert.match(overBound(host(14.01, 100), bound).join(), /load average 14\.01 is above 0\.7 × 20 cores = 14/);
  assert.match(overBound(host(1, 16 - 1 / GiB), bound).join(), /available memory 15\.99 GiB is below 16 GiB/);
  assert.deepEqual(overBound(host(1, 4, 4, 16), bound), []);
  assert.match(overBound(host(1, 4 - 1 / GiB, 4, 16), bound).join(), /available memory 3\.99 GiB is below 4 GiB/);
  assert.equal(overBound(host(30, 1), bound).length, 2);
  assert.equal(overBound(host(NaN, NaN), bound).length, 2, "an unreadable measurement is never within the bound");
  assert.match(hostLine(host(3.5, 102.7), bound), /1-minute load average 3\.5 on 20 cores \(at most 0\.7 × 20 = 14\), available memory 102\.7 GiB \(at least 16 GiB: the smaller of 16 GiB and 0\.25 × 128 GiB total\); bound from test; measured by load, free and total$/);
  const set = { ...bound, minAvailableMemoryGB: 8, minAvailableMemoryShare: null };
  assert.match(hostLine(host(3.5, 102.7, 20, 16), set), /available memory 102\.7 GiB \(at least 8 GiB\); bound from test/);
});
