#!/usr/bin/env node
import "./lib/unbind-git.mjs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { appendJsonLines, commitRecords, recordsSnapshot } from "./lib/records-commit.mjs";
import { cli, need, parseArgs, UsageError } from "./lib/args.mjs";
import { appendWords, captureOwnerText, claudeHookSession, CLASSES, committedWords, discardOwnerPrompt, LINKS, MARKS, markProblem,
  parseWords, projectRoots, queueOwnerPrompt, reconcileOwnerPrompts, sameClass, syncClaudePromptSession, transcriptWords, wordClasses,
  WORDS } from "./lib/owner-words.mjs";
import { openWords } from "./records-check.mjs";

/** Validate the raw hook payload. The hook does not guess its ordinal from words already committed. */
export function hookWord(input, projects, _records, env = process.env) {
  if (typeof input?.prompt !== "string" || !claudeHookSession(input, projects, env)) return null;
  if (input.promptSource === "system" || input.origin?.kind) return null;
  const text = captureOwnerText(input.prompt);
  if (text === null) return null;
  return { source: "claude", session: input.session_id, time: new Date().toISOString(), text,
    event: input.prompt_id ?? input.promptId ?? input.message_id ?? input.uuid ?? null };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  if (command === "capture") {
    try {
      need(args, "records", "project");
      const input = JSON.parse(readFileSync(0, "utf8") || "{}");
      const projects = projectRoots(args.project);
      const prompt = hookWord(input, projects, args.records);
      if (prompt) {
        const queued = queueOwnerPrompt(args.records, { ...prompt, text: input.prompt });
        const { pending, words } = input.transcript_path
          ? syncClaudePromptSession(args.records, projects, input) : { pending: [queued], words: [] };
        if (queued && pending.includes(queued) && !words.some(word => word.text === prompt.text)) console.log("owner-words: prompt saved pending transcript confirmation; run owner-words.mjs sync if it is still pending after the turn");
      }
    } catch (e) {
      console.log(`owner-words: the owner's message was NOT recorded (${e.message.split("\n")[0]}); run owner-words.mjs sync`);
    }
    process.exitCode = 0;
  } else cli(async () => {
    need(args, "records");
    if (command === "sync") {
      need(args, "project");
      const words = transcriptWords(projectRoots(args.project));
      const { added, commit } = appendWords(args.records, words, { message: "owner: record the owner's words from the session transcripts" });
      const pending = reconcileOwnerPrompts(args.records, words);
      console.log(JSON.stringify({ found: words.length, added, recorded: committedWords(args.records).length, commit, pending }));
      return 0;
    }
    if (command === "open") {
      const open = openWords(args.records);
      const marks = wordClasses(parseWords(recordsSnapshot(args.records).read(MARKS)));
      const waiting = w => marks.get(w.id)?.as === "direction" ? `  (direction: ${marks.get(w.id).intervention} not recorded)` : "";
      if (args.json !== undefined) console.log(JSON.stringify(open, null, 1));
      else for (const w of open) console.log(`${w.id}  ${w.time}  ${w.text.replace(/\s+/g, " ").slice(0, 160)}${waiting(w)}`);
      console.error(`${open.length} word(s) not yet distilled into a record or marked`);
      return open.length ? 2 : 0;
    }
    if (command === "pending") {
      need(args, "discard", "note");
      if (!args.note.trim()) throw new UsageError("--note must give the reason for discarding the capture");
      if (!discardOwnerPrompt(args.records, args.discard, args.note)) throw new UsageError("--discard must name an existing pending capture key");
      console.log(JSON.stringify({ discarded: args.discard }));
      return 0;
    }
    if (command === "mark") {
      need(args, "id", "as");
      const link = LINKS[args.as];
      if (!CLASSES.includes(args.as)) throw new UsageError(`--as must be ${CLASSES.join(", ")}`);
      if (!link) need(args, "note");
      if (args.note !== undefined && !args.note.trim()) throw new UsageError("--note must give the reason");
      const mark = { id: args.id, as: args.as, ...(link ? { [link.flag]: args[link.flag] } : {}),
        ...Object.fromEntries(Object.values(LINKS).filter(l => l !== link && args[l.flag] !== undefined).map(l => [l.flag, args[l.flag]])),
        ...(args.note ? { note: args.note } : {}), time: new Date().toISOString() };
      const problem = markProblem(mark);
      if (problem) throw new UsageError(problem);
      commitRecords(args.records, ({ read, add, files }) => {
        if (!parseWords(read(WORDS)).some(w => w.id === args.id)) throw new UsageError(`${args.id} is not a recorded word`);
        if (args.as === "answer" && !files.has(`owner/${args.batch}.md`)) throw new UsageError(`${args.batch} is not a sent batch (owner/${args.batch}.md)`);
        const old = read(MARKS);
        const current = wordClasses(parseWords(old)).get(args.id);
        if (sameClass(current, mark)) throw new UsageError(`${args.id} is already marked ${current.as}${link ? ` ${current[link.flag]}` : ""}`);
        add(MARKS, appendJsonLines(old, [mark]));
        return { message: `owner: mark a word (${MARKS})` };
      });
      console.log(JSON.stringify(mark));
      if (openWords(args.records).some(w => w.id === args.id)) console.error(`${args.id} stays open until its intervention ${mark.intervention} is committed`);
      return 0;
    }
    if (command === "metrics") {
      const { metricsLines, phaseMetrics } = await import("./lib/owner-metrics.mjs");
      const metrics = phaseMetrics(args.records, args.phase);
      if (args.json !== undefined) console.log(JSON.stringify(metrics, null, 1));
      else for (const line of metricsLines(metrics)) console.log(line);
      return 0;
    }
    throw new UsageError("command must be capture, sync, open, pending, mark or metrics");
  });
}
