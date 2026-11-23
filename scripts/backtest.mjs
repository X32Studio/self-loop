#!/usr/bin/env node
// Blind backtest driver. Order and visibility are enforced by code, not by asking the agent:
// - the agent's working directory holds only the brief, the snapshots revealed so far and its output folder;
// - snapshot N+1 is copied in only after out/N.md exists and is non-empty;
// - a docs-only role receives only the snapshot's docs/ folder;
// - Claude runs in --restricted mode with file tools only (confined to the working directory);
// - every tool call is logged and audited afterwards; any access outside the working directory fails the run.
//
// node backtest.mjs --runner claude|codex --model M --effort E --brief FILE --scope full|docs \
//   --snapshots DIR --order 01,02,... --work DIR
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { auditAccess } from "./audit-access.mjs";

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, i, all) =>
  value.startsWith("--") ? [...pairs, [value.slice(2), all[i + 1]]] : pairs, []));
for (const key of ["runner", "model", "effort", "brief", "scope", "snapshots", "order", "work"])
  if (!args[key]) throw new Error(`missing --${key}`);
if (!["claude", "codex"].includes(args.runner)) throw new Error("--runner must be claude or codex");
if (!["full", "docs"].includes(args.scope)) throw new Error("--scope must be full or docs");

const work = resolve(args.work);
const visible = join(work, "visible");
const logs = join(work, "logs");
if (existsSync(visible)) throw new Error(`${visible} exists; use a fresh --work`);
mkdirSync(join(visible, "snapshots"), { recursive: true });
mkdirSync(join(visible, "out"), { recursive: true });
mkdirSync(logs, { recursive: true });
cpSync(resolve(args.brief), join(visible, "brief.md"));
const order = args.order.split(",");
const dirs = readdirSync(resolve(args.snapshots));

function reveal(id) {
  const name = dirs.find(d => d.startsWith(`${id}-`));
  if (!name) throw new Error(`snapshot ${id} not found`);
  const from = join(resolve(args.snapshots), name);
  const to = join(visible, "snapshots", id);
  if (args.scope === "docs") cpSync(join(from, "docs"), join(to, "docs"), { recursive: true });
  else cpSync(from, to, { recursive: true });
}

const first = id => `Your role brief is brief.md in the current directory. Read it first; it defines your job and the output format.
The folder snapshots/ will receive snapshots of one software project in time order, each the state just before some moment.
Snapshot ${id} is now at snapshots/${id}/. Review it as your brief says and write your proposals to out/${id}.md.
Only the files in the current directory exist for this task. Write in Chinese.`;
const next = id => `Snapshot ${id} is now at snapshots/${id}/ (earlier ones remain; you may compare with them). Review it as your brief says and write your proposals to out/${id}.md.`;

function run(command, argv, input, logFile) {
  return new Promise((done, fail) => {
    const child = spawn(command, argv, { cwd: visible, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", chunk => { out += chunk; });
    child.stderr.on("data", chunk => { out += chunk; });
    child.on("error", fail);
    child.on("close", code => { writeFileSync(logFile, out); code === 0 ? done(out) : fail(new Error(`${command} exited ${code}; see ${logFile}`)); });
    child.stdin.end(input);
  });
}

let session;
const events = [];
for (const [i, id] of order.entries()) {
  reveal(id);
  const prompt = i === 0 ? first(id) : next(id);
  const logFile = join(logs, `${id}.jsonl`);
  let argv;
  if (args.runner === "claude") {
    argv = ["-p", "--restricted", "--strict-mcp-config", "--permission-mode", "acceptEdits", "--tools", "Read,Write,Edit,Glob,Grep",
      "--model", args.model, "--effort", args.effort, "--output-format", "stream-json", "--verbose",
      ...(session ? ["--resume", session] : [])];
  } else {
    argv = ["exec", ...(session ? ["resume", session] : []), "--json", "--skip-git-repo-check",
      "-c", 'sandbox_mode="workspace-write"', "-m", args.model, "-c", `model_reasoning_effort="${args.effort}"`, "-"];
  }
  const out = await run(args.runner, argv, prompt, logFile);
  for (const line of out.split("\n")) {
    if (!line.startsWith("{")) continue;
    let event; try { event = JSON.parse(line); } catch { continue; }
    events.push({ id, event });
    if (!session && event.type === "system" && event.session_id) session = event.session_id;
    if (!session && event.type === "thread.started") session = event.thread_id;
  }
  const result = join(visible, "out", `${id}.md`);
  if (!existsSync(result) || statSync(result).size === 0) throw new Error(`no output for ${id}; see ${logFile}`);
  console.log(`${id} done`);
}

// Audit: every path the agent touched must lie inside the working directory (see audit-access.mjs).
const { violations, flags } = auditAccess(visible, events);
writeFileSync(join(work, "audit.json"), JSON.stringify({ runner: args.runner, model: args.model, scope: args.scope, order, session, violations, flags }, null, 2));
console.log(violations.length ? `AUDIT FAILED: ${violations.length} certain access(es) outside the working directory` : "audit clean");
if (flags.length) console.log(`${flags.length} command(s) flagged for review (screening, not blocking); see audit.json`);
process.exitCode = violations.length ? 3 : 0;
