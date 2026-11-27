#!/usr/bin/env node
// F-0002, F-0009, F-0015, D-0052, R-0032-reviewer-architecture
import "./lib/unbind-git.mjs";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { appendJsonLines, commitRecords, recordsSnapshot } from "./lib/records-commit.mjs";
import { cli, need, parseArgs, UsageError } from "./lib/args.mjs";
import { extractHookDirs, isAntigravityHook, resolveAuthoritativeTranscript, unwrapAntigravityUserText } from "./lib/antigravity.mjs";
import { antigravityHookSession, checkAntigravityTurnConfirmation } from "./lib/antigravity-words.mjs";
import { appendWords, captureOwnerText, claudeHookSession, CLASSES, committedWords, discardOwnerPrompt, findVerbatimQuoteMatches,
  hasPendingForSession, isRoutineCheckInCandidate, LINKS, MARKS, markProblem, parseWords, pendingOwnerPrompts, projectRoots,
  queueOwnerPrompt, reconcileOwnerPrompts, sameClass, sha, syncPromptSession, transcriptStoreWordsReport, transcriptWordsReport,
  wordClasses, WORDS } from "./lib/owner-words.mjs";
import { loadHookStore, matchHookProduct } from "./lib/registry.mjs";
import { openWords } from "./records-check.mjs";

export { findVerbatimQuoteMatches, isRoutineCheckInCandidate };

const agInject = message => JSON.stringify({ injectSteps: [{ systemMessage: { systemMessage: message } }] });

function parseMarkIds(argv) {
  const raw = [];
  let hasIdsFlag = false;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--id" || token === "--ids") {
      if (token === "--ids") hasIdsFlag = true;
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) continue;
      i++;
      for (const part of next.split(/[\s,]+/)) if (part) raw.push(part);
    } else if (token.startsWith("--id=") || token.startsWith("--ids=")) {
      const isIds = token.startsWith("--ids=");
      if (isIds) hasIdsFlag = true;
      for (const part of token.slice(isIds ? 6 : 5).split(/[\s,]+/)) if (part) raw.push(part);
    }
  }
  const ids = [...new Set(raw)];
  return { ids, batch: hasIdsFlag || ids.length > 1 };
}

function pendingStepBound(prompt) {
  if (Number.isInteger(prompt.anchorStep)) return prompt.anchorStep;
  if (Number.isInteger(prompt.observedUserStep)) return prompt.observedUserStep;
  return -1;
}

export function hookWord(input, projects, _records, env = process.env, harness = null) {
  if (isAntigravityHook(input, harness)) {
    if (typeof input?.lastUserInput !== "string" || !antigravityHookSession(input, projects, env)) return null;
    const unwrapped = unwrapAntigravityUserText(input.lastUserInput);
    const text = unwrapped === null ? null : captureOwnerText(unwrapped);
    if (text === null) return null;
    return { source: "antigravity", session: input.conversationId, time: new Date().toISOString(), text, event: null };
  }
  if (typeof input?.prompt !== "string" || !claudeHookSession(input, projects, env)) return null;
  if (input.promptSource === "system" || input.origin?.kind) return null;
  const text = captureOwnerText(input.prompt);
  if (text === null) return null;
  return { source: "claude", session: input.session_id, time: new Date().toISOString(), text,
    event: input.prompt_id ?? input.promptId ?? input.message_id ?? input.uuid ?? null };
}

function captureAntigravity(input, projects, records, env = process.env) {
  const invocationNum = typeof input?.invocationNum === "number" ? input.invocationNum : null;
  if (invocationNum !== null && invocationNum > 0) {
    if (!hasPendingForSession(records, input?.conversationId)) return "{}";
    if (!antigravityHookSession(input, projects, env)) return "{}";
    const actual = input.transcriptPath ? resolveAuthoritativeTranscript(input.transcriptPath) : null;
    if (actual && existsSync(actual)) syncPromptSession("antigravity", records, projects, input);
    return "{}";
  }
  const prompt = hookWord(input, projects, records, env, "antigravity");
  if (!prompt) return "{}";
  const actual = input.transcriptPath ? resolveAuthoritativeTranscript(input.transcriptPath) : null;
  const synced = actual && existsSync(actual) ? syncPromptSession("antigravity", records, projects, input) : { words: [], echoes: [] };
  const { confirmed, event, latestUserStep } = checkAntigravityTurnConfirmation({
    transcriptPath: actual, text: prompt.text, initialNumSteps: input.initialNumSteps, words: synced.words, echoes: synced.echoes,
  });
  if (confirmed) return "{}";
  const activePending = pendingOwnerPrompts(records, prompt.session);
  if (activePending.length) {
    const latest = activePending.reduce((a, b) => {
      const sa = pendingStepBound(a), sb = pendingStepBound(b);
      if (sa !== sb) return sb > sa ? b : a;
      return String(b.time ?? "") >= String(a.time ?? "") ? b : a;
    });
    if (latest.text === prompt.text && (latestUserStep === null || latestUserStep <= pendingStepBound(latest))) return "{}";
  }
  const anchorStep = Number.isInteger(input.initialNumSteps) && input.initialNumSteps >= 1 ? input.initialNumSteps - 1 : null;
  const pendingEvent = event ?? (anchorStep !== null ? `step-${anchorStep}` : null);
  const key = sha(JSON.stringify(["antigravity", prompt.session, input.initialNumSteps ?? "turn", sha(prompt.text)]));
  queueOwnerPrompt(records, {
    ...prompt,
    event: pendingEvent,
    ...(anchorStep !== null ? { anchorStep } : Number.isInteger(latestUserStep) ? { observedUserStep: latestUserStep } : {}),
    pendingKey: key,
  });
  return agInject("owner-words: prompt saved pending transcript confirmation; run owner-words.mjs sync if it is still pending after the turn");
}

function runCaptureScoped(input, isAg, projects, records) {
  if (isAg) { console.log(captureAntigravity(input, projects, records)); return; }
  const prompt = hookWord(input, projects, records);
  if (!prompt) return;
  const queued = queueOwnerPrompt(records, { ...prompt, text: input.prompt });
  const { pending, words } = input.transcript_path ? syncPromptSession("claude", records, projects, input) : { pending: [queued], words: [] };
  if (queued && pending.includes(queued) && !words.some(word => word.text === prompt.text))
    console.log("owner-words: prompt saved pending transcript confirmation; run owner-words.mjs sync if it is still pending after the turn");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  if (command === "capture") {
    const harnessFlag = args.harness || null;
    let isAg = harnessFlag === "antigravity";
    try {
      const hasOwnerStore = "owner-store" in args;
      if (hasOwnerStore && "records" in args) throw new UsageError("--owner-store and --records exclude each other");
      const input = JSON.parse(readFileSync(0, "utf8") || "{}");
      isAg = isAntigravityHook(input, harnessFlag);
      if (hasOwnerStore) {
        const hookDirs = isAg ? extractHookDirs(input) : (typeof input?.cwd === "string" && input.cwd ? [input.cwd] : []);
        if (!hookDirs.length) { if (isAg) console.log("{}"); }
        else {
          const loaded = loadHookStore(args["owner-store"]);
          if (!loaded.ok) throw new Error(loaded.error);
          const routed = matchHookProduct(hookDirs, loaded.products);
          if (routed.status === "skip") { if (isAg) console.log("{}"); }
          else if (routed.status === "ambiguous") throw new Error(routed.error);
          else runCaptureScoped(input, isAg, routed.projects, routed.product.records);
        }
      } else {
        need(args, "records", "project");
        runCaptureScoped(input, isAg, projectRoots(args.project), args.records);
      }
    } catch (e) {
      const firstLine = String(e?.message ?? e).split("\n")[0];
      const msg = `owner-words: the owner's message was NOT recorded (${firstLine}); run owner-words.mjs sync`;
      if (isAg) { console.error(msg); console.log(agInject(msg)); }
      else console.log(msg);
    }
    process.exitCode = 0;
  } else cli(async () => {
    if (command === "sync" && "owner-store" in args) {
      if ("records" in args) throw new UsageError("--owner-store and --records exclude each other");
      const loaded = loadHookStore(args["owner-store"]);
      if (!loaded.ok) throw new UsageError(loaded.error);
      const synced = transcriptStoreWordsReport(loaded.products, { routeProduct: matchHookProduct });
      const reports = loaded.products.map(p => {
        const bucket = synced.byProduct.get(p.name);
        const { added, commit } = appendWords(p.records, bucket.words, { message: "owner: record the owner's words from the session transcripts" });
        const pending = reconcileOwnerPrompts(p.records, bucket.words);
        return {
          product: p.name,
          records: p.records,
          found: bucket.words.length,
          added,
          recorded: committedWords(p.records).length,
          commit,
          pending,
          antigravity: bucket.antigravity,
          unresolved: bucket.unresolved,
        };
      });
      console.log(JSON.stringify(reports));
      for (const item of synced.unresolved) {
        const target = item.session ? `${item.source} session ${item.session}` : item.source;
        console.error(`owner-words: ${item.status} ${target}: ${item.reason}`);
      }
      return synced.unresolved.length || synced.antigravity.skipped > 0 ? 1 : 0;
    }
    need(args, "records");
    if (command === "sync") {
      need(args, "project");
      const { words, antigravity } = transcriptWordsReport(projectRoots(args.project));
      const { added, commit } = appendWords(args.records, words, { message: "owner: record the owner's words from the session transcripts" });
      const pending = reconcileOwnerPrompts(args.records, words);
      console.log(JSON.stringify({ found: words.length, added, recorded: committedWords(args.records).length, commit, pending, antigravity }));
      if (antigravity.skipped > 0) {
        console.error(`owner-words: skipped ${antigravity.skipped} Antigravity item(s): ${antigravity.reason}`);
        return 1;
      }
      return 0;
    }
    if (command === "open") {
      const open = openWords(args.records);
      const snap = recordsSnapshot(args.records);
      const marks = wordClasses(parseWords(snap.read(MARKS)));
      const waiting = w => marks.get(w.id)?.as === "direction" ? `  (direction: ${marks.get(w.id).intervention} not recorded)` : "";
      const quoteMatches = findVerbatimQuoteMatches(snap, open);
      const routineCandidates = open.filter(w => !marks.has(w.id) && isRoutineCheckInCandidate(w.text)).map(w => w.id);
      const routineHint = routineCandidates.length
        ? `Hint (routine check-ins): node scripts/owner-words.mjs mark --records ${args.records} --ids ${routineCandidates.join(",")} --as routine --note "status check-in"`
        : null;
      if (args.json !== undefined) {
        console.log(JSON.stringify(args.hints !== undefined ? { open, quoteMatches, routineCandidates, routineHint } : open, null, 1));
      } else {
        for (const w of open) console.log(`${w.id}  ${w.time}  ${w.text.replace(/\s+/g, " ").slice(0, 160)}${waiting(w)}`);
        for (const m of quoteMatches) console.log(`[quote-match] ${m.wordId} quoted in ${m.recordId} (${m.path}) without citation -> add "words: ${m.wordId}"`);
        if (routineHint) console.log(routineHint);
      }
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
      const { ids, batch } = parseMarkIds(rest);
      if (!ids.length) throw new UsageError("missing --id");
      need(args, "as");
      const link = LINKS[args.as];
      if (!CLASSES.includes(args.as)) throw new UsageError(`--as must be ${CLASSES.join(", ")}`);
      if (!link) need(args, "note");
      if (args.note !== undefined && !args.note.trim()) throw new UsageError("--note must give the reason");
      const now = new Date().toISOString();
      const extraLinks = Object.fromEntries(Object.values(LINKS).filter(l => l !== link && args[l.flag] !== undefined).map(l => [l.flag, args[l.flag]]));
      const makeMark = id => ({
        id, as: args.as, ...(link ? { [link.flag]: args[link.flag] } : {}), ...extraLinks,
        ...(args.note ? { note: args.note } : {}), time: now,
      });
      const problem = markProblem(makeMark(ids[0]));
      if (problem) throw new UsageError(problem);
      const { value: result } = commitRecords(args.records, ({ read, add, files }) => {
        const known = new Set(parseWords(read(WORDS)).map(w => w.id));
        const missing = ids.filter(id => !known.has(id));
        if (missing.length) throw new UsageError(batch ? `unknown word ID(s): ${missing.join(", ")}` : `${missing[0]} is not a recorded word`);
        if (args.as === "answer" && !files.has(`owner/${args.batch}.md`)) throw new UsageError(`${args.batch} is not a sent batch (owner/${args.batch}.md)`);
        const old = read(MARKS), active = wordClasses(parseWords(old));
        const marked = [], skipped = [];
        for (const id of ids) {
          const mark = makeMark(id), current = active.get(id);
          if (sameClass(current, mark)) {
            if (!batch) throw new UsageError(`${id} is already marked ${current.as}${link ? ` ${current[link.flag]}` : ""}`);
            skipped.push(id);
          } else marked.push(mark);
        }
        if (marked.length) add(MARKS, appendJsonLines(old, marked));
        const message = marked.length === 1 ? `owner: mark a word (${MARKS})` : `owner: mark ${marked.length} word(s) (${MARKS})`;
        return { message, value: { marked, skipped } };
      });
      console.log(JSON.stringify(batch ? result : result.marked[0]));
      const stillOpen = new Set(openWords(args.records).map(w => w.id));
      for (const m of result.marked) {
        if (stillOpen.has(m.id)) console.error(`${m.id} stays open until its intervention ${m.intervention} is committed`);
      }
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
