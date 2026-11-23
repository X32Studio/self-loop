import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { jsonOutput, put } from "./fixture.mjs";
import { assertRefused, edit, head, phase, prepare, record, round6B } from "./round6-b-fixture.mjs";

export function acceptedPatch(w, p, prepared, files) {
  edit(prepared, files);
  const result = jsonOutput(record(w, p, prepared));
  assert.notEqual(result.product.commit, result.product.base);
  for (const [file, source] of Object.entries(files)) {
    if (source === null) {
      assert.equal(w.git(p.product, "ls-tree", "--name-only", result.product.commit, "--", file), "");
      continue;
    }
    const bytes = w.runGit(p.product, "show", `${result.product.commit}:${file}`);
    assert.equal(bytes.status, 0, bytes.stderr);
    assert.equal(bytes.stdout, source);
  }
}

export function refusedPatch(w, p, prepared, files, diagnostic) {
  const before = head(w, p);
  edit(prepared, files);
  assertRefused(w, p, prepared, record(w, p, prepared), [diagnostic]);
  assert.equal(head(w, p), before);
}

export function admission(t) {
  const w = round6B(t);
  const p = phase(w);
  return { w, p, prepared: prepare(w, p, "actor") };
}

const GiB = 1024 ** 3;

export function hostMeasurement(w, { cores, load, availableGB, freeGB = availableGB }) {
  const available = Math.round(availableGB * GiB);
  const free = Math.round(freeGB * GiB);
  const preload = put(w.dir, "measured-host.cjs", `
const os = require("node:os");
const fs = require("node:fs");
const { syncBuiltinESMExports } = require("node:module");
os.cpus = () => Array.from({ length: ${cores} }, () => ({ model: "Fixture", speed: 2400, times: {} }));
os.availableParallelism = () => ${cores};
os.loadavg = () => [${load}, 0.02, 0.01];
os.freemem = () => ${available};
os.totalmem = () => 64 * 2 ** 30;
process.availableMemory = () => ${available};
const read = fs.readFileSync;
fs.readFileSync = (path, options) => {
  const source = path === "/proc/meminfo"
    ? "MemTotal:       67108864 kB\\nMemFree:        ${Math.round(free / 1024)} kB\\nMemAvailable:   ${Math.round(available / 1024)} kB\\n"
    : path === "/proc/loadavg" ? "${load} 0.02 0.01 1/10 123\\n" : null;
  if (source === null) return read(path, options);
  return typeof options === "string" || options?.encoding ? source : Buffer.from(source);
};
syncBuiltinESMExports();
`);
  return {
    NODE_OPTIONS: `--import=${pathToFileURL(join(w.dir, "clock.mjs")).href} --require=${preload}`,
  };
}

export function suggestedHeavy(text) {
  return text.split("\n").filter(line =>
    /call\.mjs.* (critic|actor|judge) --round |suite-green\.mjs.* --command /.test(line));
}
