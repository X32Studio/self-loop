#!/usr/bin/env node
// The word gate: a Claude Code `Stop` hook that keeps the lead's turn open while words the owner said in this session
// are not settled (owner, 2026-11-21: 「如果你现在的self-loop工作良好，应该会记录我这段话，反思和推导设计的问题和不足，扩展和
// 延伸设计，并凝练，剪枝，提纯，揉成一统的整体，并和我探讨，进行对齐，如果没有这些过程，而是我提醒你你才做的，那就是你的系统还是有问题」).
// Recording is the prompt hook's job (owner-words.mjs capture); this gate makes the next step due before the turn ends:
// a word is settled when a record cites it (records-check `openWords`: purpose, decision, blueprint, intervention,
// lesson or an opted-in extra kind) or a mark settles it as routine or not the owner's. Whether the distillation is good stays a model and
// owner judgement; that it happened is this gate.
//
// node word-gate.mjs --records <dir> --project <dir>[,<dir>...] [--max-blocks 3]
// Reads the hook's JSON on stdin. Prints a block decision while this session's owner words are open; nothing
// otherwise. Each open word and pending capture have separate --max-blocks refusal budgets. Always exit 0.
import "./lib/unbind-git.mjs";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "./lib/args.mjs";
import { claudeHookSession, pendingKey, pendingOwnerPrompts, projectRoots, syncClaudePromptSession } from "./lib/owner-words.mjs";
import { openWords } from "./records-check.mjs";

const ownerWordsPath = fileURLToPath(new URL("./owner-words.mjs", import.meta.url));
const ownerWordsCommand = "node '" + ownerWordsPath.replaceAll("'", "'\"'\"'") + "'";

/** Check the committed ledger and pending captures independently so a failed write cannot hide either. */
export function sessionOpenWords(input, { records, projects, env, warn = console.error }) {
  if (!claudeHookSession(input, projects, env)) return { open: [], pending: [] };
  try { syncClaudePromptSession(records, projects, input); }
  catch (error) { warn(`word-gate: sync failed: ${error.message}`); }
  let open = [], pending = [];
  try { open = openWords(records).filter(w => w.session === input.session_id); }
  catch (error) { warn(`word-gate: could not read committed words: ${error.message}`); }
  try { pending = pendingOwnerPrompts(records, input.session_id); }
  catch (error) { warn(`word-gate: could not read pending captures: ${error.message}`); }
  return { open, pending };
}

export function reason(open, pending = []) {
  const waiting = pending.length ? `word-gate: pending transcript confirmation for ${pending.map(p => `${pendingKey(p)} ${JSON.stringify(p.text.slice(0, 80))}`).join(", ")}. Run ${ownerWordsCommand} sync --records <records> --project <projects> once the transcript is available, or use ${ownerWordsCommand} pending --discard <key> --records <records> --note "<why>" to archive an unresolved capture.` : "";
  if (!open.length) return waiting;
  const list = open.map(w => `${w.id} 「${w.text.replace(/\s+/g, " ").slice(0, 80)}${w.text.length > 80 ? "…" : ""}」`).join("; ");
  return `${waiting ? waiting + " " : ""}word-gate: the owner's words of this session are not settled: ${list}. Before ending the turn: reflect on them against the records (purpose, blueprint, decisions, design); derive what they change (extend, prune, integrate into one whole); write the distillation into a record that cites each ID (a purpose record's words: line, a decision, a blueprint feature, an intervention, a lesson or an extra record kind with settlesOwnerWords enabled); and bring any value judgement to the owner with a recommendation. A plain go-ahead or a status question is settled with: ${ownerWordsCommand} mark --records <records> --id <W-id> --as routine --note "<why>".`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const input = JSON.parse(readFileSync(0, "utf8") || "{}");
    const { open, pending } = sessionOpenWords(input, { records: resolve(args.records), projects: projectRoots(args.project) });
    if (open.length || pending.length) {
      const dir = join(tmpdir(), "self-loop-word-gate");
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `${String(input.session_id).replace(/[^\w-]/g, "_")}.json`);
      let state = {};
      try { state = JSON.parse(readFileSync(file, "utf8")); } catch { /* first block */ }
      const max = Number(args["max-blocks"] || 3);
      // Every word in the last legacy set shared its count.
      const previousWordBlocks = state.wordBlocks ?? Object.fromEntries(
        (state.key ?? "").split(",").filter(Boolean).map(id => [id, state.blocks]));
      const wordBlocks = Object.fromEntries(open.map(w => [w.id, (previousWordBlocks[w.id] ?? 0) + 1]));
      const pendingBlocks = Object.fromEntries(pending.map(p => {
        const id = pendingKey(p);
        return [id, (state.pendingBlocks?.[id] ?? 0) + 1];
      }));
      writeFileSync(file, JSON.stringify({ wordBlocks, pendingBlocks }));
      const blockingWords = open.filter(w => wordBlocks[w.id] <= max);
      const blockingPending = pending.filter(p => pendingBlocks[pendingKey(p)] <= max);
      for (const w of open.filter(w => wordBlocks[w.id] > max))
        console.error(`word-gate: ${w.id} still open after ${max} refusals (${ownerWordsCommand} open --records <records> lists them)`);
      for (const p of pending.filter(p => pendingBlocks[pendingKey(p)] > max))
        console.error(`word-gate: pending:${pendingKey(p)} still open after ${max} refusals (${ownerWordsCommand} pending --discard <key> --records <records> --note "<why>" archives it)`);
      if (blockingWords.length || blockingPending.length)
        console.log(JSON.stringify({ decision: "block", reason: reason(blockingWords, blockingPending) }));
    }
  } catch (error) { console.error(`word-gate: ${error.message}`); }
  process.exitCode = 0;
}
