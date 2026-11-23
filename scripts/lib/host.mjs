// D-0025, D-0027, D-0029, design/driver.md#host-load
import { availableParallelism, cpus, freemem, loadavg, totalmem } from "node:os";

export const GiB = 2 ** 30;

export function measureHost() {
  const cores = cpus().length || availableParallelism();
  const [load1] = loadavg();
  return { load1, cores, availableGiB: freemem() / GiB, totalGiB: totalmem() / GiB, load: "os.loadavg() 1-minute", memory: "os.freemem()", total: "os.totalmem()" };
}

export function memoryFloor(bound, measured) {
  if (bound.minAvailableMemoryShare === null) return bound.minAvailableMemoryGB;
  const total = measured.totalGiB;
  return Number.isFinite(total) && total > 0 ? Math.min(bound.minAvailableMemoryGB, bound.minAvailableMemoryShare * total) : bound.minAvailableMemoryGB;
}

const two = n => (Math.round(n * 100) / 100).toString();
const gib = n => Number.isFinite(n) ? (Math.floor(n * 100 + 1e-9) / 100).toString() : String(n);

export function overBound(measured, bound) {
  const maxLoad = bound.maxLoadRatio * measured.cores;
  const floor = memoryFloor(bound, measured);
  const over = [];
  if (!(measured.load1 <= maxLoad))
    over.push(`the 1-minute load average ${two(measured.load1)} is above ${bound.maxLoadRatio} × ${measured.cores} cores = ${two(maxLoad)}`);
  if (!(measured.availableGiB >= floor))
    over.push(`available memory ${gib(measured.availableGiB)} GiB is below ${gib(floor)} GiB`);
  return over;
}

export function hostLine(measured, bound) {
  const floor = memoryFloor(bound, measured);
  const rule = bound.minAvailableMemoryShare === null ? ""
    : `: the smaller of ${bound.minAvailableMemoryGB} GiB and ${bound.minAvailableMemoryShare} × ${gib(measured.totalGiB)} GiB total`;
  return `1-minute load average ${two(measured.load1)} on ${measured.cores} cores (at most ${bound.maxLoadRatio} × ${measured.cores} = ${two(bound.maxLoadRatio * measured.cores)}), `
    + `available memory ${gib(measured.availableGiB)} GiB (at least ${gib(floor)} GiB${rule}); bound from ${bound.source}; measured by ${measured.load}, ${measured.memory} and ${measured.total}`;
}
