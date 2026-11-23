#!/usr/bin/env node
// A scripted stand-in for an agent CLI, for the call.mjs tests. Usage: node fake-agent.mjs <scenario.json>
// The scenario maps each role to a list of calls (the n-th call of a role takes the n-th entry, the last repeats):
//   { report, write: { path: text }, decisions: [question objects], git: [[args]], events: [tool_use objects], exit,
//     noPublic, noReport }
// A `ws:` path is relative to the working folder, any other to the current directory (the product worktree).
// `{{HEAD}}` in a report or written text becomes the current directory's HEAD commit. A judge writes a default
// out/public.md unless `noPublic`. Events go to stdout as stream-json lines.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const scenarioFile = process.argv[2];
const scenario = JSON.parse(readFileSync(scenarioFile, "utf8"));
const prompt = readFileSync(0, "utf8");
const role = /You are the ([a-z]+) of a self-loop/.exec(prompt)[1];
const ws = /Your working folder is (.+?)\.\n/.exec(prompt)[1];
const countsFile = `${scenarioFile}.counts.json`;
const counts = existsSync(countsFile) ? JSON.parse(readFileSync(countsFile, "utf8")) : {};
const n = counts[role] ?? 0;
counts[role] = n + 1;
writeFileSync(countsFile, JSON.stringify(counts));
const list = scenario[role] ?? [{}];
const step = list[Math.min(n, list.length - 1)];
writeFileSync(`${scenarioFile}.${role}.${n}.prompt`, prompt);

let head = "";
try { head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch {}
const fill = text => text.replaceAll("{{HEAD}}", head);
const put = (path, text) => {
  const target = path.startsWith("ws:") ? join(ws, path.slice(3)) : join(process.cwd(), path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, fill(text));
};
for (const [path, text] of Object.entries(step.write ?? {})) put(path, text);
if (step.decisions) put("ws:out/decisions.json", JSON.stringify({ questions: step.decisions }));
if (role === "judge" && !step.noPublic && !existsSync(join(ws, "out", "public.md"))) put("ws:out/public.md", `Public ruling ${n}: properties only.\n`);
for (const args of step.git ?? []) execFileSync("git", args, { stdio: "ignore" });
if (!step.noReport) put("ws:out/report.md", step.report ?? (role === "reviewer" ? `VERDICT: CONTINUE\n\n# Review ${n}\n` : `${role} report ${n}`));
for (const part of step.events ?? []) console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", ...part }] } }));
process.exit(step.exit ?? 0);
