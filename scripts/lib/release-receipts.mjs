// Git skips pre-push entirely for an explicit bypass. Observe destination tips separately from the gate;
// seeing an unattested tip establishes missing evidence, not who pushed it or how.
import { createHash, randomUUID } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "./git-plumbing.mjs";
import { recordsSnapshot } from "./records-commit.mjs";

const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const store = repo => join(git(repo, "rev-parse", "--path-format=absolute", "--git-common-dir"), "self-loop-release");
const key = (destination, ref, sha) => hash([destination, ref, sha]);
const load = file => JSON.parse(readFileSync(file, "utf8"));

function writeOnce(dir, id, value) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = join(dir, `.${randomUUID()}.tmp`);
  writeFileSync(temp, JSON.stringify(value) + "\n", { flag: "wx", mode: 0o600 });
  try { linkSync(temp, join(dir, `${id}.json`)); }
  catch (e) { if (e.code !== "EEXIST") throw e; }
  finally { rmSync(temp, { force: true }); }
}

export function rememberGatedPush(repo, url, updates) {
  const destination = hash(url), dir = join(store(repo), "gated");
  for (const { ref, sha, before } of updates) {
    writeOnce(dir, key(destination, ref, sha), { destination, ref, sha, before, checkedAt: new Date().toISOString() });
  }
}

export function rememberReleaseTips(repo, url, tips) {
  const destination = hash(url), base = store(repo), dir = join(base, "unattested");
  for (const [ref, sha] of tips) {
    if (!sha) continue;
    const id = key(destination, ref, sha);
    if (!existsSync(join(base, "gated", `${id}.json`))) {
      writeOnce(dir, id, { id, destination, ref, sha, observedAt: new Date().toISOString() });
    }
  }
}

export function observeReleaseTips(repo, url, refs, remoteRefs) {
  const wanted = new Set(refs);
  rememberReleaseTips(repo, url, [...wanted].map(ref => [ref, remoteRefs.get(ref)]));
  const destination = hash(url), base = store(repo), dir = join(base, "unattested");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(name => /^[0-9a-f]{64}\.json$/.test(name)).map(name => load(join(dir, name)))
    .filter(row => row.destination === destination && wanted.has(row.ref) && !existsSync(join(base, "reconciled", `${row.id}.json`)));
}

export function closeReleaseFinding(repo, records, id, cite, findings) {
  const finding = findings.find(row => row.id === id);
  if (!finding) throw new Error("no open finding with that ID for this destination and ref");
  const snapshot = recordsSnapshot(records);
  const decision = /^D-\d{4,}$/.test(cite) && snapshot.files.has(`decisions/${cite}.md`);
  const word = /^W-[0-9a-f]{10}$/.test(cite) && snapshot.read("owner/words.jsonl").split("\n").some(line => line && JSON.parse(line).id === cite);
  if (!decision && !word) throw new Error("cite a committed owner word or decision in --records");
  writeOnce(join(store(repo), "reconciled"), id, { ...finding, cite, recordsHead: snapshot.head, closedAt: new Date().toISOString() });
}
