#!/usr/bin/env node
// F-0002, F-0009, D-0007, D-0052, R-0032-reviewer-architecture
import "./lib/unbind-git.mjs";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "./lib/args.mjs";
import { extractHookDirs, isAntigravityHook } from "./lib/antigravity.mjs";
import { antigravityHookSession, antigravitySessionState } from "./lib/antigravity-words.mjs";
import { claudeHookSession, delegatedThread, pendingKey, pendingOwnerPrompts, projectRoots, syncPromptSession } from "./lib/owner-words.mjs";
import { loadHookStore, matchHookProduct } from "./lib/registry.mjs";
import { openWords } from "./records-check.mjs";

const ownerWordsPath = fileURLToPath(new URL("./owner-words.mjs", import.meta.url));
const ownerWordsCommand = "node '" + ownerWordsPath.replaceAll("'", "'\"'\"'") + "'";

function antigravityStopBlocked(input) {
  if (input?.continuationActive === true || input?.fullyIdle === false) return true;
  return Boolean(input?.terminationReason && input.terminationReason !== "NO_TOOL_CALL" && !String(input.terminationReason).endsWith("_NO_TOOL_CALL"));
}

export function sessionOpenWords(input, { records, projects, env, harness = null, warn = console.error }) {
  const isAg = isAntigravityHook(input, harness);
  if (isAg) {
    if (antigravityStopBlocked(input) || !antigravityHookSession(input, projects, env)) return { open: [], pending: [] };
  } else if (!claudeHookSession(input, projects, env)) return { open: [], pending: [] };
  const sessionId = isAg ? input.conversationId : input.session_id;
  if (typeof sessionId !== "string" || !sessionId) return { open: [], pending: [] };
  try { syncPromptSession(isAg ? "antigravity" : "claude", records, projects, input); }
  catch (error) { warn(`word-gate: sync failed: ${error.message}`); }
  let open = [], pending = [];
  try { open = openWords(records).filter(w => w.session === sessionId); }
  catch (error) { warn(`word-gate: could not read committed words: ${error.message}`); }
  try { pending = pendingOwnerPrompts(records, sessionId); }
  catch (error) { warn(`word-gate: could not read pending captures: ${error.message}`); }
  return { open, pending };
}

export function reason(open, pending = []) {
  const waiting = pending.length ? `word-gate: pending transcript confirmation for ${pending.map(p => `${pendingKey(p)} ${JSON.stringify(p.text.slice(0, 80))}`).join(", ")}. Run ${ownerWordsCommand} sync --records <records> --project <projects> once the transcript is available, or use ${ownerWordsCommand} pending --discard <key> --records <records> --note "<why>" to archive an unresolved capture.` : "";
  if (!open.length) return waiting;
  const list = open.map(w => `${w.id} 「${w.text.replace(/\s+/g, " ").slice(0, 80)}${w.text.length > 80 ? "…" : ""}」`).join("; ");
  return `${waiting ? waiting + " " : ""}word-gate: the owner's words of this session are not settled: ${list}. Before ending the turn: reflect on them against the records (purpose, blueprint, decisions, design); derive what they change (extend, prune, integrate into one whole); write the distillation into a record that cites each ID (a purpose record's words: line, a decision, a blueprint feature, an intervention, a lesson or an extra record kind with settlesOwnerWords enabled); and bring any value judgement to the owner with a recommendation. A plain go-ahead or a status question is settled with: ${ownerWordsCommand} mark --records <records> --id <W-id> --as routine --note "<why>".`;
}

function gateStateFile(sessionId) {
  const dir = join(tmpdir(), "self-loop-word-gate");
  mkdirSync(dir, { recursive: true });
  return join(dir, `${sessionId.replace(/[^\w-]/g, "_")}.json`);
}

const readGateState = file => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return {}; } };

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const harnessFlag = args.harness || null;
  let isAg = harnessFlag === "antigravity";
  try {
    const hasOwnerStore = "owner-store" in args;
    if (hasOwnerStore && "records" in args) throw new Error("--owner-store and --records exclude each other");
    const input = JSON.parse(readFileSync(0, "utf8") || "{}");
    isAg = isAntigravityHook(input, harnessFlag);
    const sessionId = isAg ? input.conversationId : input.session_id;
    const max = Number(args["max-blocks"] || 3);
    let emitted = false, recordsPath = null, projects = null, storeError = null;
    if (hasOwnerStore) {
      const skip = (isAg && antigravityStopBlocked(input)) || delegatedThread(process.env)
        || (isAg && ((typeof input?.parentConversationId === "string" && input.parentConversationId.length > 0)
          || (input?.transcriptPath && antigravitySessionState(input.transcriptPath, { conversationId: input.conversationId }).state === "confirmed-child")));
      if (!skip) {
        const hookDirs = isAg ? extractHookDirs(input) : (typeof input?.cwd === "string" && input.cwd ? [input.cwd] : []);
        if (hookDirs.length) {
          const loaded = loadHookStore(args["owner-store"]);
          if (!loaded.ok) storeError = loaded.error;
          else {
            const routed = matchHookProduct(hookDirs, loaded.products);
            if (routed.status === "ambiguous") storeError = routed.error;
            else if (routed.status === "matched") { recordsPath = routed.product.records; projects = routed.projects; }
          }
        }
      }
    } else { recordsPath = resolve(args.records); projects = projectRoots(args.project); }
    if (storeError) {
      if (typeof sessionId === "string" && sessionId) {
        const file = gateStateFile(sessionId), state = readGateState(file);
        const storeErrorBlocks = (state.storeErrorBlocks ?? 0) + 1;
        writeFileSync(file, JSON.stringify({ ...state, storeErrorBlocks }));
        if (storeErrorBlocks <= max) {
          console.log(JSON.stringify({ decision: isAg ? "continue" : "block", reason: `word-gate: ${storeError}` }));
          emitted = true;
        } else console.error(`word-gate: ${storeError} (still failing after ${max} refusals)`);
      } else console.error(`word-gate: ${storeError}`);
    } else if (recordsPath) {
      const { open, pending } = sessionOpenWords(input, { records: recordsPath, projects, harness: harnessFlag });
      if ((open.length || pending.length) && typeof sessionId === "string" && sessionId) {
        const file = gateStateFile(sessionId), state = readGateState(file);
        const previousWordBlocks = state.wordBlocks ?? Object.fromEntries((state.key ?? "").split(",").filter(Boolean).map(id => [id, state.blocks]));
        const wordBlocks = Object.fromEntries(open.map(w => [w.id, (previousWordBlocks[w.id] ?? 0) + 1]));
        const pendingBlocks = Object.fromEntries(pending.map(p => [pendingKey(p), (state.pendingBlocks?.[pendingKey(p)] ?? 0) + 1]));
        writeFileSync(file, JSON.stringify({ wordBlocks, pendingBlocks }));
        const blockingWords = open.filter(w => wordBlocks[w.id] <= max);
        const blockingPending = pending.filter(p => pendingBlocks[pendingKey(p)] <= max);
        for (const w of open.filter(w => wordBlocks[w.id] > max))
          console.error(`word-gate: ${w.id} still open after ${max} refusals (${ownerWordsCommand} open --records <records> lists them)`);
        for (const p of pending.filter(p => pendingBlocks[pendingKey(p)] > max))
          console.error(`word-gate: pending:${pendingKey(p)} still open after ${max} refusals (${ownerWordsCommand} pending --discard <key> --records <records> --note "<why>" archives it)`);
        if (blockingWords.length || blockingPending.length) {
          console.log(JSON.stringify({ decision: isAg ? "continue" : "block", reason: reason(blockingWords, blockingPending) }));
          emitted = true;
        }
      }
    }
    if (isAg && !emitted) console.log("{}");
  } catch (error) {
    console.error(`word-gate: ${error.message}`);
    if (isAg) console.log("{}");
  }
  process.exitCode = 0;
}
