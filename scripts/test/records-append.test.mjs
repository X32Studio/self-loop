import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { recordCall } from "../call.mjs";
import { appendWords, committedWords, MARKS, WORDS } from "../lib/owner-words.mjs";
import { createHash } from "node:crypto";
import { wordId } from "../lib/owner-words.mjs";
import { git, repo, scripts, setup, temp } from "./helpers.mjs";

process.env.SELF_LOOP_LOAD_DIR = temp("self-loop-load-");

const put = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
const owner = text => ({
  id: wordId("fixture", text, 1), session: "fixture", text, source: "claude", time: new Date().toISOString(),
  sha256: createHash("sha256").update(text).digest("hex"),
});
const ownerCli = (records, args, input) => spawnSync(process.execPath, [
  join(scripts, "owner-words.mjs"), args[0], "--records", records, ...args.slice(1),
], { encoding: "utf8", input, env: { ...process.env, T3CODE_THREAD_ID: "" } });
const markArgs = word => ["mark", "--id", word.id, "--as", "routine", "--note", "fixture"];

// Interpose a single real Git operation and write a receipt that proves the second writer actually ran.
function interpose(t, predicate, action, { after = false } = {}) {
  const original = process.env.PATH;
  const real = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const dir = temp(), receipt = join(dir, "receipt"), bin = join(dir, "git");
  writeFileSync(bin, [
    "#!" + process.execPath,
    `const { spawnSync } = require("node:child_process"), fs = require("node:fs");
const real = ${JSON.stringify(real)}, receipt = ${JSON.stringify(receipt)}, original = ${JSON.stringify(original)};
const args = process.argv.slice(2);
const run = () => spawnSync(real, args, { stdio: ["inherit", "pipe", "pipe"] });
let result = ${after ? "run()" : "null"};
if (!fs.existsSync(receipt) && (${predicate})) {
  fs.writeFileSync(receipt, "running");
  const child = (${action})(args, real, { ...process.env, PATH: original, T3CODE_THREAD_ID: "" });
  fs.writeFileSync(receipt, String(child.status) + (child.stderr?.toString() || ""));
}
result ??= run();
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exitCode = result.status ?? 1;`,
  ].join("\n"), { mode: 0o755 });
  process.env.PATH = dir + ":" + original;
  t.after(() => { process.env.PATH = original; });
  return { receipt, stop: () => { process.env.PATH = original; } };
}

function nestedOwner(records, args, input) {
  return `(_args, _real, env) => spawnSync(process.execPath, ${JSON.stringify([
    join(scripts, "owner-words.mjs"), args[0], "--records", records, ...args.slice(1),
  ])}, { env, input: ${JSON.stringify(input)} })`;
}

test("B03: two marks survive an append between reading the log and publishing", t => {
  const records = repo({ "README.md": "fixture\n" });
  const [seed, a, b] = ["seed", "a", "b"].map(text => owner(text));
  appendWords(records, [seed, a, b]);
  assert.equal(ownerCli(records, markArgs(seed)).status, 0);
  const blob = git(records, "rev-parse", `HEAD:${MARKS}`);
  const { receipt } = interpose(t, `args.includes("show") && args.some(a => a.endsWith(":${MARKS}")) ||
    args.includes("cat-file") && args.includes(${JSON.stringify(blob)})`, nestedOwner(records, markArgs(b)), { after: true });
  const result = ownerCli(records, markArgs(a));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(receipt, "utf8"), "0");
  assert.deepEqual(new Set(git(records, "show", `HEAD:${MARKS}`).split("\n").map(l => JSON.parse(l).id)), new Set([seed.id, a.id, b.id]));
});

test("B04: a later automatic append stays in the index and survives a normal commit", t => {
  const records = repo({ "README.md": "fixture\n" });
  const a = owner("a"), b = owner("b"), c = owner("c");
  appendWords(records, [a]);
  const blob = git(records, "rev-parse", `HEAD:${WORDS}`);
  const transcript = join(temp(), "fixture.jsonl");
  put(transcript, JSON.stringify({ type: "user", sessionId: "fixture", cwd: records, timestamp: c.time, message: { content: c.text } }) + "\n");
  const { receipt, stop } = interpose(t, `args.includes("checkout") && args.includes(${JSON.stringify(WORDS)}) ||
    args.includes("cat-file") && args.includes(${JSON.stringify(blob)})`,
  nestedOwner(records, ["capture", "--project", records], JSON.stringify({ cwd: records, session_id: "fixture", prompt: "c", transcript_path: transcript })));
  appendWords(records, [b]);
  stop();
  assert.equal(readFileSync(receipt, "utf8"), "0");
  assert.ok(git(records, "show", `:${WORDS}`).includes(c.id));
  put(join(records, "README.md"), "ordinary edit\n");
  git(records, "add", "README.md");
  git(records, "commit", "-qm", "ordinary commit");
  assert.deepEqual(new Set(committedWords(records).map(w => w.id)), new Set([a.id, b.id, c.id]));
});

test("B05: marking a word preserves a log larger than the default Git subprocess buffer", () => {
  const records = repo({ "README.md": "fixture\n", [MARKS]: JSON.stringify({ id: "old", note: "x".repeat(1_100_000) }) + "\n" });
  const word = owner("new");
  appendWords(records, [word]);
  const result = ownerCli(records, markArgs(word));
  assert.equal(result.status, 0, result.stderr);
  const marks = readFileSync(join(records, MARKS), "utf8").trim().split("\n").map(line => JSON.parse(line).id);
  assert.deepEqual(marks, ["old", word.id]);
});

async function prepared() {
  const s = await setup({}, { agents: { actor: { runner: "t3", provider: "codex", model: "fixture" } } });
  const prepare = (round, step) => {
    const { prepared: p } = s.run("actor", { round, step, prepare: true });
    const transcript = join(p.ws, "fixture.jsonl");
    put(transcript, [
      { type: "session_meta", payload: { id: p.id } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: p.prompt }] } },
      { type: "event_msg", payload: { type: "task_complete" } },
    ].map(row => JSON.stringify(row)).join("\n") + "\n");
    put(join(p.ws, "out/report.md"), "fixture report\n");
    return { ...p, transcript };
  };
  return { ...s, prepare };
}

test("B01: hand-offs from two prepared calls both survive a concurrent append", async t => {
  const s = await prepared();
  const a = s.prepare(2, "actor-a"), b = s.prepare(2, "actor-b");
  const log = "metrics/handoffs.jsonl", blob = git(s.records, "rev-parse", `HEAD:${log}`);
  const child = `import { recordCall } from ${JSON.stringify(join(scripts, "call.mjs"))};
const result = recordCall(${JSON.stringify(s.cfg)}, ${JSON.stringify(b.ws)}, { transcript: ${JSON.stringify(b.transcript)}, session: ${JSON.stringify(b.id)} });
if (result.code) console.error(result.message);
process.exitCode = result.code;`;
  const { receipt } = interpose(t, `args.includes("show") && args.some(a => a.endsWith(":${log}")) ||
    args.includes("cat-file") && args.includes(${JSON.stringify(blob)})`,
  `(_args, _real, env) => spawnSync(process.execPath, ["--input-type=module", "-e", ${JSON.stringify(child)}], { env })`, { after: true });
  const result = recordCall(s.cfg, a.ws, { transcript: a.transcript, session: a.id });
  assert.equal(result.code, 0, result.message);
  assert.equal(readFileSync(receipt, "utf8"), "0");
  const ids = git(s.records, "show", `HEAD:${log}`).split("\n").map(l => JSON.parse(l).id);
  assert.deepEqual(ids.slice(1), [b.id, a.id]);
});

test("B01/B02: a hand-off draft after prepare survives and the worktree can be recorded on retry", async () => {
  const s = await prepared();
  const p = s.prepare(2, "actor");
  const log = "metrics/handoffs.jsonl", draft = git(s.records, "show", `HEAD:${log}`) + "\nlead's draft\n";
  put(join(s.records, log), draft);
  put(join(p.wt, "src/a.js"), "export const a = 2;\n");
  const result = recordCall(s.cfg, p.ws, { transcript: p.transcript, session: p.id });
  assert.equal(result.code, 7, result.message);
  assert.equal(readFileSync(join(s.records, log), "utf8"), draft);
  assert.ok(existsSync(p.wt));
  git(s.records, "restore", "--", log);
  const retry = recordCall(s.cfg, p.ws, { transcript: p.transcript, session: p.id });
  assert.equal(retry.code, 0, retry.message);
  assert.equal(git(s.product, "show", "loop/s5:src/a.js"), "export const a = 2;");
  assert.equal(existsSync(p.wt), false);
});

test("B02: an unrelated ref move at publication is retried before releasing the actor's worktree", async t => {
  const s = await prepared();
  const p = s.prepare(2, "actor");
  put(join(p.wt, "src/a.js"), "export const a = 2;\n");
  const { receipt } = interpose(t, `args[1] === ${JSON.stringify(s.records)} && args.includes("update-ref") && args.includes("HEAD")`,
  `(args, real, env) => {
    const git = (...argv) => spawnSync(real, ["-C", args[1], ...argv], { env, encoding: "utf8" });
    const head = git("rev-parse", "HEAD").stdout.trim();
    const tree = git("rev-parse", "HEAD^{tree}").stdout.trim();
    const commit = git("commit-tree", tree, "-p", head, "-m", "concurrent records commit").stdout.trim();
    return git("update-ref", "HEAD", commit, head);
  }`);
  const result = recordCall(s.cfg, p.ws, { transcript: p.transcript, session: p.id });
  assert.equal(readFileSync(receipt, "utf8"), "0");
  assert.equal(result.code, 0, result.message);
  assert.equal(git(s.records, "log", "-2", "--format=%s").split("\n")[1], "concurrent records commit");
  assert.equal(git(s.product, "show", "loop/s5:src/a.js"), "export const a = 2;");
  assert.equal(existsSync(p.wt), false);
});
