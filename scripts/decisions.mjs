#!/usr/bin/env node
// D-0015, D-0031, design/replaced-batches.md#the-record, design/generative-engine-c.md#the-batch
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cli, need, parseArgs, UsageError } from "./lib/args.mjs";

const text = v => typeof v === "string" && v.trim().length > 0;
const norm = s => s.toLowerCase().replace(/\s+/g, " ").trim();
const line = s => s.replace(/\s+/g, " ").trim();
const absent = v => v === undefined || v === null;
export const ANSWERS = "owner/answers.jsonl";
export const INTENT = "intent";
export const INTENT_BATCHES_PER_REQUIREMENT = 2;
export const OUTCOMES = ["as-recommended", "amended", "other"];
const REQUIREMENT = /^P-\d{4}$/;
const USAGE = "decisions.mjs validate <decisions.json> | send --records R --file F --phase P --from R-NNNN-role"
  + ` | answer --records R --batch B-NNNN --words "<the owner's words>" [--outcome ${OUTCOMES.join("|")}]`
  + ` | replace --records R --batch B-NNNN --by B-MMMM [--note "<why>"] | status --records R [--phase P]`;

const optionsOf = q => (Array.isArray(q?.options) ? q.options.filter(text) : []);

function dependencyProblems(q, index, list) {
  const problems = [];
  const { dependsOn, ifOther } = q ?? {};
  let target = null;
  if (!absent(dependsOn)) {
    if (!Number.isInteger(dependsOn) || dependsOn < 1 || dependsOn > list.length)
      problems.push(`dependsOn ${JSON.stringify(dependsOn)} names no question of this batch (questions are numbered 1 to ${list.length})`);
    else if (dependsOn > index) problems.push(`dependsOn ${dependsOn} is not an earlier question: a question depends only on one asked before it`);
    else target = list[dependsOn - 1];
  }
  if (absent(ifOther)) return problems;
  if (typeof ifOther !== "object" || Array.isArray(ifOther) || !Object.keys(ifOther).length)
    return [...problems, "ifOther maps options of the question depended on to the recommendation that follows each"];
  if (absent(dependsOn)) return [...problems, "ifOther needs dependsOn, the earlier question whose other answers change this recommendation"];
  if (!target) return problems;
  const options = new Set(optionsOf(target).map(norm));
  const keyed = new Set();
  for (const [option, recommendation] of Object.entries(ifOther)) {
    if (!options.has(norm(option))) problems.push(`ifOther key ${JSON.stringify(option)} is not an option of question ${dependsOn}`);
    else if (keyed.has(norm(option))) problems.push(`ifOther names option ${JSON.stringify(option)} of question ${dependsOn} twice`);
    keyed.add(norm(option));
    if (!text(recommendation)) problems.push(`ifOther ${JSON.stringify(option)} needs the recommendation that follows`);
  }
  return problems;
}

function conditional(q, list) {
  if (absent(q.ifOther)) return [];
  const options = list[q.dependsOn - 1].options.map(line);
  const given = new Map(Object.entries(q.ifOther).map(([option, recommendation]) => [norm(option), line(recommendation)]));
  return options.filter(option => given.has(norm(option))).map(option => ({ option, recommendation: given.get(norm(option)) }));
}

export function validate(raw) {
  const list = Array.isArray(raw) ? raw : raw?.questions;
  if (!Array.isArray(list)) return { questions: [], errors: ["decisions must be { \"questions\": [...] }"] };
  const head = Array.isArray(raw) ? {} : raw;
  const intent = head.kind === INTENT;
  const errors = [];
  if (!absent(head.kind) && !intent) errors.push(`kind must be "${INTENT}" or absent, not ${JSON.stringify(head.kind)}`);
  if (intent && !(typeof head.requirement === "string" && REQUIREMENT.test(head.requirement)))
    errors.push(`an intent batch names the requirement it grills as "requirement": "P-NNNN", not ${JSON.stringify(head.requirement ?? null)}`);
  if (!intent && !absent(head.requirement)) errors.push(`"requirement" belongs to an intent batch ("kind": "${INTENT}")`);
  if (!list.length) errors.push("no questions");
  const seen = new Set();
  list.forEach((q, i) => {
    const at = `question ${i + 1}`;
    if (!text(q?.question)) errors.push(`${at}: empty question`);
    else if (seen.has(norm(q.question))) errors.push(`${at}: the same question is asked twice in this batch`);
    else seen.add(norm(q.question));
    const options = optionsOf(q).map(norm);
    if (new Set(options).size < 2) errors.push(`${at}: needs at least two distinct non-empty options`);
    if (options.length !== new Set(options).size) errors.push(`${at}: an option is repeated`);
    if (Array.isArray(q?.options) && q.options.some(o => !text(o))) errors.push(`${at}: an option is empty`);
    if (!text(q?.recommendation)) errors.push(`${at}: empty recommendation`);
    for (const key of ["context", "costOfWaiting"]) if (q?.[key] !== undefined && typeof q[key] !== "string") errors.push(`${at}: ${key} must be text`);
    if (intent && !text(q?.whyAsked)) errors.push(`${at}: an intent question needs whyAsked: why the records, the code and first principles cannot settle it`);
    else if (!absent(q?.whyAsked) && typeof q.whyAsked !== "string") errors.push(`${at}: whyAsked must be text`);
    for (const problem of dependencyProblems(q, i, list)) errors.push(`${at}: ${problem}`);
  });
  if (errors.length) return { questions: [], errors };
  return {
    errors, kind: intent ? INTENT : null, requirement: intent ? head.requirement : null,
    questions: list.map(q => ({ question: line(q.question), options: q.options.map(line), recommendation: line(q.recommendation),
      context: text(q.context) ? line(q.context) : "", costOfWaiting: text(q.costOfWaiting) ? line(q.costOfWaiting) : "",
      whyAsked: text(q.whyAsked) ? line(q.whyAsked) : "", dependsOn: absent(q.dependsOn) ? null : q.dependsOn, ifOther: conditional(q, list) })),
  };
}

export function readJson(file) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch (e) { return { invalid: `${file} is not JSON: ${e.message}` }; }
}

export function render(id, { phase, from, questions, kind = null, requirement = null, ordinal = 1 }) {
  const intent = kind === INTENT;
  const lines = [`# ${id} Owner batch`, "", `phase: ${line(phase)}`, `from: ${line(from)}`, ...(intent ? [`kind: ${INTENT}`, `requirement: ${requirement}`] : []), "",
    `Each question carries the loop's recommendation; answering "as recommended" is enough. The answer is recorded verbatim with \`node scripts/decisions.mjs answer --records <records> --batch ${id} --words "<the owner's words>"\`.`, ""];
  if (intent) lines.push(`Intent batch ${ordinal} of at most ${INTENT_BATCHES_PER_REQUIREMENT} for ${requirement} in this phase. Question numbers and dependsOn are one-based (1 is the first question). The questions come in dependency order; where an earlier answer changes a recommendation, the question says which recommendation follows.`, "");
  questions.forEach((q, i) => {
    lines.push(`### ${i + 1}. ${q.question}`);
    if (q.context) lines.push(`Context: ${q.context}`);
    if (q.whyAsked) lines.push(`Why asked: ${q.whyAsked}`);
    if (q.dependsOn) lines.push(`Depends on: question ${q.dependsOn}`);
    lines.push(`Options: ${q.options.join(" / ")}`, `Recommendation: ${q.recommendation}`);
    for (const { option, recommendation } of q.ifOther ?? []) lines.push(`If question ${q.dependsOn} is answered "${option}": ${recommendation}`);
    if (q.costOfWaiting) lines.push(`Cost of waiting: ${q.costOfWaiting}`);
    lines.push("");
  });
  return lines.join("\n");
}

const BATCH = /^B-\d{4}$/;

export function parseEvents(textOfFile) {
  return textOfFile.split("\n").filter(Boolean).map((l, i) => {
    let a;
    try { a = JSON.parse(l); } catch { throw new Error(`${ANSWERS}:${i + 1} is not JSON`); }
    if (!BATCH.test(a?.batch ?? "") || !text(a?.time)) throw new Error(`${ANSWERS}:${i + 1} needs batch B-NNNN, time and the owner's words`);
    if ("replacedBy" in a) {
      if ("words" in a || "outcome" in a || !BATCH.test(a.replacedBy ?? "") || ("note" in a && typeof a.note !== "string"))
        throw new Error(`${ANSWERS}:${i + 1}: a replacement names replacedBy B-NNNN, carries no words or outcome and at most a text note`);
    } else if (!text(a?.words)) throw new Error(`${ANSWERS}:${i + 1} needs batch B-NNNN, time and the owner's words`);
    else if ("outcome" in a && !OUTCOMES.includes(a.outcome))
      throw new Error(`${ANSWERS}:${i + 1}: outcome ${JSON.stringify(a.outcome)} is not one of ${OUTCOMES.join(", ")}`);
    return a;
  });
}

export const parseAnswers = textOfFile => parseEvents(textOfFile).filter(e => !("replacedBy" in e));

const names = (t, id) => new RegExp(`(?<![\\w-])${id}(?![\\w-])`).test(t);

export function replacementProblem({ batch, replacedBy: by }, { exists, textOf }, prior) {
  for (const id of [batch, by]) if (!exists(id)) return `unknown batch ${id}: owner/${id}.md does not exist`;
  if (batch === by) return `${batch} cannot replace itself`;
  if (Number(by.slice(2)) < Number(batch.slice(2))) return `${by} was sent before ${batch}; only a later batch replaces it`;
  if (!prior.some(e => e.batch === by && !("replacedBy" in e))) return `${by} is not answered: ${batch} closes only through the owner's answer to the batch that replaced it`;
  if (prior.some(e => e.batch === batch && !("replacedBy" in e))) return `${batch} is already answered by the owner's words`;
  const earlier = prior.find(e => e.batch === batch && "replacedBy" in e);
  if (earlier) return `${batch} was already replaced by ${earlier.replacedBy}`;
  if (!names(textOf(by), batch)) return `${by} does not name ${batch}: a replacing batch says which batch it replaces`;
  return null;
}

export function replacementProblems(events, batchFiles) {
  return events.flatMap((e, i) => {
    if (!("replacedBy" in e)) return [];
    const problem = replacementProblem(e, batchFiles, events.slice(0, i));
    return problem ? [`${ANSWERS}:${i + 1}: ${problem}`] : [];
  });
}

const eventsOf = records => (existsSync(join(records, ANSWERS)) ? parseEvents(readFileSync(join(records, ANSWERS), "utf8")) : []);
const field = (t, key) => t.split("\n").find(l => l.startsWith(`${key}: `))?.slice(key.length + 2) ?? null;

export function batches(records) {
  const dir = join(records, "owner");
  if (!existsSync(dir)) return [];
  return batchesFrom(readdirSync(dir).map(f => `owner/${f}`), path => {
    const file = join(records, path);
    return existsSync(file) ? readFileSync(file, "utf8") : "";
  });
}

export function batchesFrom(files, read) {
  const events = parseEvents(read(ANSWERS));
  return files.filter(path => /^owner\/B-\d{4}\.md$/.test(path)).sort().map(file => {
    const t = read(file);
    const id = file.slice(6, -3);
    const mine = events.filter(e => e.batch === id && !("replacedBy" in e));
    const replacedBy = events.find(e => e.batch === id && "replacedBy" in e)?.replacedBy ?? null;
    return { id, file, phase: field(t, "phase"), from: field(t, "from"), kind: field(t, "kind"), requirement: field(t, "requirement"),
      questions: [...t.matchAll(/^### \d+\. (.+)$/gm)].map(m => m[1].trim()), answered: mine.length > 0 || replacedBy !== null, answers: mine, replacedBy };
  });
}

export const batchState = b => (b.answers.length ? "answered" : b.replacedBy ? `replaced by ${b.replacedBy}` : "open");

export const intentBatches = (all, phase, requirement) =>
  all.filter(b => b.phase === line(phase) && b.kind === INTENT && b.requirement === requirement).map(b => b.id);

export function send(records, raw, { phase, from }) {
  const checked = raw?.invalid ? { questions: [], errors: [raw.invalid] } : validate(raw);
  if (checked.errors.length) return { errors: checked.errors };
  const { questions, kind, requirement } = checked;
  const all = batches(records);
  const earlier = kind === INTENT ? intentBatches(all, phase, requirement) : [];
  if (earlier.length >= INTENT_BATCHES_PER_REQUIREMENT)
    return { errors: [], refused: `phase ${line(phase)} already holds ${earlier.length} intent batches for ${requirement} (${earlier.join(", ")}): one batch and at most one follow-up per requirement` };
  const id = `B-${String(Math.max(0, ...all.map(b => Number(b.id.slice(2)))) + 1).padStart(4, "0")}`;
  const asked = new Set(all.filter(b => b.phase === line(phase)).flatMap(b => b.questions.map(norm)));
  const repeats = questions.filter(q => asked.has(norm(q.question))).map(q => q.question);
  mkdirSync(join(records, "owner"), { recursive: true });
  writeFileSync(join(records, "owner", `${id}.md`), render(id, { phase, from, questions, kind, requirement, ordinal: earlier.length + 1 }));
  const intent = kind === INTENT ? { requirement, earlier, recorded: existsSync(join(records, "purpose", `${requirement}.md`)) } : null;
  return { errors: [], id, file: `owner/${id}.md`, repeats, intent };
}

export function answer(records, id, words, now = new Date(), { outcome } = {}) {
  if (!/^B-\d{4}$/.test(id ?? "")) throw new UsageError("--batch must be B-NNNN");
  if (!text(words)) throw new UsageError("the owner's answer is empty; record the owner's words verbatim");
  if (outcome !== undefined && !OUTCOMES.includes(outcome))
    throw new UsageError(`--outcome must be one of ${OUTCOMES.join(", ")} (the lead's reading of the answer), not ${JSON.stringify(outcome)}; nothing written`);
  if (!existsSync(join(records, "owner", `${id}.md`))) throw new UsageError(`owner/${id}.md does not exist`);
  eventsOf(records);
  const event = { batch: id, time: now.toISOString().slice(0, 19) + "Z", words, ...(outcome === undefined ? {} : { outcome }) };
  appendFileSync(join(records, ANSWERS), `${JSON.stringify(event)}\n`);
  return event;
}

export function replace(records, id, by, { note = "", now = new Date() } = {}) {
  for (const [flag, value] of [["--batch", id], ["--by", by]]) if (!BATCH.test(value ?? "")) throw new UsageError(`${flag} must be B-NNNN`);
  const events = eventsOf(records);
  const file = batch => join(records, "owner", `${batch}.md`);
  const event = { batch: id, time: now.toISOString().slice(0, 19) + "Z", replacedBy: by, ...(text(note) ? { note: line(note) } : {}) };
  const problem = replacementProblem(event, { exists: batch => existsSync(file(batch)), textOf: batch => readFileSync(file(batch), "utf8") }, events);
  if (problem) return { problem };
  appendFileSync(join(records, ANSWERS), `${JSON.stringify(event)}\n`);
  return { event };
}

export function statusLine(b) {
  const intent = b.kind === INTENT ? `  intent ${b.requirement}` : "";
  const outcome = b.answers.length ? `  outcome ${b.answers.map(a => a.outcome ?? "none").join(", ")}` : "";
  return `${b.id} ${batchState(b)}  phase ${b.phase}  from ${b.from}  ${b.questions.length} question(s)${intent}${outcome}`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) cli(() => {
  const args = parseArgs(process.argv.slice(2));
  const [command, file] = args._;
  if (command === "validate") {
    if (!file) throw new UsageError("decisions.mjs validate <decisions.json>");
    const raw = readJson(file);
    const checked = raw?.invalid ? { questions: [], errors: [raw.invalid] } : validate(raw);
    for (const e of checked.errors) console.log(`not sendable: ${e}`);
    if (checked.errors.length) return 1;
    console.log(`sendable: ${checked.questions.length} question(s)${checked.kind === INTENT ? `; intent batch for ${checked.requirement}; dependsOn uses one-based question numbers` : ""}`);
    checked.questions.forEach((q, i) => {
      if (q.dependsOn) console.log(`question ${i + 1} depends on question ${q.dependsOn} (${checked.questions[q.dependsOn - 1].question}); ${q.ifOther.length} conditional recommendation(s)`);
    });
    return 0;
  }
  if (command === "send") {
    need(args, "records", "file", "phase", "from");
    const r = send(args.records, readJson(args.file), { phase: args.phase, from: args.from });
    for (const e of r.errors) console.log(`not sendable: ${e}`);
    if (r.errors.length) return 1;
    if (r.refused) {
      console.error(`refused: ${r.refused}; nothing written`);
      return 2;
    }
    for (const q of r.repeats) console.log(`screening: already asked in phase ${args.phase}: ${q}`);
    if (r.intent?.earlier.length) console.log(`screening: follow-up intent batch for ${r.intent.requirement} after ${r.intent.earlier.join(", ")}; no further intent batch for it in phase ${args.phase}`);
    if (r.intent && !r.intent.recorded) console.log(`screening: ${r.intent.requirement} has no record purpose/${r.intent.requirement}.md in the records`);
    console.log(`wrote ${r.file}; commit it by explicit path`);
    return 0;
  }
  if (command === "answer") {
    need(args, "records", "batch", "words");
    const event = answer(args.records, args.batch, args.words, new Date(), { outcome: args.outcome });
    console.log(JSON.stringify(event));
    if (!event.outcome) console.error(`screening: no --outcome; the precision of the loop's recommendations counts only answers that carry one (${OUTCOMES.join(", ")})`);
    return 0;
  }
  if (command === "replace") {
    need(args, "records", "batch", "by");
    const r = replace(args.records, args.batch, args.by, { note: args.note ?? "" });
    if (r.problem) {
      console.error(`refused: ${r.problem}; nothing written`);
      return 2;
    }
    console.log(JSON.stringify(r.event));
    return 0;
  }
  if (command === "status") {
    need(args, "records");
    const list = batches(args.records).filter(b => !args.phase || b.phase === args.phase);
    for (const b of list) console.log(statusLine(b));
    if (!list.length) console.log("no batches");
    return 0;
  }
  throw new UsageError(USAGE);
});
