#!/usr/bin/env node
// The records check and generated index of RECORDS.md rule 7. The layout (kinds, paths, how each changes, citation
// forms) is parsed from the skill's RECORDS.md table, so the table is the one source; a records repository may add
// kinds in records.json.
//
// Two tiers (REQUIREMENTS item 11):
// - failures (certain, exit 1): a file of the checked set outside every declared kind and path; an INDEX.md that
//   differs from the generated one; a hand-off line (metrics/handoffs.jsonl) that is malformed or names a file the
//   records do not hold; a malformed answer or replacement event (owner/answers.jsonl), or a replacement that
//   `decisions.mjs replace` would refuse. All are decided by structured facts (paths, bytes, JSON fields). The checked
//   set is every tracked or staged file for the command (stage new records, then --write, then commit); for a role
//   call's hand-off it is only the paths that hand-off commits, so a stray file elsewhere never fails unrelated work.
// - screening (reported with evidence, exit 0): untracked files; undeclared files outside the checked set; record IDs that no record
//   carries; sealed paths named in material for roles that may not read them; edits of immutable or append-only
//   records against HEAD; bare `file:line` citations, scratch paths, unresolved `path@commit`, digest mismatches,
//   secret-like strings, "Round N" history inside a design file. Text can name such things legitimately (a template's
//   example ID, a judge-only brief naming its sealed file), and none has two-way historical admission, so a person or
//   model reviews them.
//
// The index lists the given set only (a role call passes the exact tree it commits, so never an ignored, staged or
// uncommitted draft) and takes an owner batch's status from the events of owner/answers.jsonl alone (answered, replaced
// by a later batch, or open), other records' from `status:` and `supersedes:` fields.
//
// node records-check.mjs --repo <records repo> [--write] [--json] [--layout <RECORDS.md>]
//   --write regenerates INDEX.md first; without it the check is read-only and names the fix command on index drift.
import "./lib/unbind-git.mjs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cli, need, parseArgs } from "./lib/args.mjs";
import { ANSWERS, parseEvents, replacementProblems } from "./decisions.mjs";
import { HANDOFFS, parseHandoffs } from "./lib/handoff.mjs";
import { BLUEPRINT, FEATURE_EVENTS, FEATURE_FILE, inspectBlueprint, renderBlueprint } from "./lib/blueprint.mjs";
import { blueprintAlarms, ownerAlarms } from "./lib/blueprint-alarms.mjs";
import { rowReceiptProblem } from "./lib/ci-receipt.mjs";
import { blobs, regularFiles } from "./lib/git-plumbing.mjs";
import { BAR, judgeBarFindings } from "./lib/judge-bar.mjs";
import { MARKS, parseWords, wordClasses, WORDS } from "./lib/owner-words.mjs";
import { ssotRecordsFindings } from "./lib/ssot.mjs";
import { parseRows, TRAJECTORY } from "./trajectory.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_LAYOUT = join(here, "..", "RECORDS.md");
export const PUBLIC_KINDS = ["Purpose", "Decisions", "Design", "Blueprint", "Rounds", "Hand-offs", "Trajectory",
  "Owner batches", "Owner answers", "Interventions", "Lessons", "Research", "Plan"];
export const isPublicKind = kind => kind !== "Rounds" && PUBLIC_KINDS.includes(kind);
// Quoted output and generated views are not processed as records' ordinary citations.
const QUOTED = new Set(["Backtests", "Evidence", "Blueprint evidence", "Sealed", "Index", "Blueprint view"]);
const JSONL = /\.jsonl$/i;
const TEXT = /\.(md|tsv|json|txt|mjs|js|ts|ya?ml)$/i;

/** Convert a path or citation template from the RECORDS table to a regular expression source. */
function templateSource(template, { anchored }) {
  let source = "";
  const re = /<NNNN>|NNNN|<([a-z]+)>|[.*+?^${}()|[\]\\]|[^]/g;
  for (const m of template.matchAll(re)) {
    if (m[0] === "NNNN" || m[0] === "<NNNN>") source += anchored ? "(?<n>\\d{4})" : "\\d{4}";
    else if (m[1]) source += anchored ? `(?<${m[1]}>[^/]+)` : "[a-z](?:[a-z0-9-]*[a-z0-9])?";
    else if (/[.*+?^${}()|[\]\\]/.test(m[0])) source += `\\${m[0]}`;
    else source += m[0];
  }
  if (anchored && template.endsWith("/")) source += ".+";
  return source;
}

/** Parse the layout table of RECORDS.md (plus extra kinds) into matchers. */
export function parseLayout(recordsMd, extraKinds = []) {
  const rows = [];
  let inTable = false;
  for (const line of recordsMd.split("\n")) {
    if (/^\|\s*Kind\s*\|\s*Path\s*\|/.test(line)) { inTable = true; continue; }
    if (!inTable) continue;
    if (!line.startsWith("|")) break;
    const cells = line.split("|").slice(1, -1).map(c => c.trim());
    if (/^-+$/.test(cells[0])) continue;
    rows.push({ kind: cells[0], path: cells[1], changes: cells[3] ?? "", citedAs: cells[4] ?? "" });
  }
  for (const extra of extraKinds) {
    const path = `\`${extra.path}\``;
    // Keep the legacy index ordering and display while repositories remove now-native extra kinds.
    const native = rows.findIndex(row => row.kind === extra.kind && row.path === path);
    if (native !== -1) rows.splice(native, 1);
    rows.push({
      kind: extra.kind, path, changes: extra.changes ?? "", citedAs: extra.citedAs ? `\`${extra.citedAs}\`` : "",
      settlesOwnerWords: extra.settlesOwnerWords === true,
    });
  }
  if (!rows.length) throw new Error("no layout table found (a row starting with | Kind | Path |)");
  return rows.map(({ kind, path, changes, citedAs, settlesOwnerWords }) => {
    const paths = [...path.matchAll(/`([^`]+)`/g)].map(m => m[1]);
    const cite = [...citedAs.matchAll(/`([^`]+)`/g)].map(m => m[1]).find(c => !c.includes("/"));
    return {
      kind,
      paths,
      settlesOwnerWords,
      changes: /append-only/i.test(changes) ? "append-only" : /immutable/i.test(changes) ? "immutable" : "editable",
      matchers: paths.map(p => new RegExp(`^${templateSource(p, { anchored: true })}$`)),
      cite,
      idPattern: cite && paths.some(path => !JSONL.test(path)) ? templateSource(cite, { anchored: false }) : null,
    };
  });
}

const recordId = (cite, m) => cite ? cite.replace(/<NNNN>|NNNN/, m.groups?.n ?? "")
  .replace(/<([a-z]+)>/g, (_, name) => m.groups?.[name] ?? "") : null;

/** The declared kind of a path, and the record ID the path carries when the kind is cited by ID. */
export function classify(layout, path, { legacyLogIds = false } = {}) {
  for (const kind of layout) for (const matcher of kind.matchers) {
    const m = matcher.exec(path);
    if (!m) continue;
    const id = !legacyLogIds && JSONL.test(path) ? null : recordId(kind.cite, m);
    const record = { kind: kind.kind, id, changes: kind.changes };
    if (kind.settlesOwnerWords) record.settlesOwnerWords = true;
    return record;
  }
  return null;
}

/**
 * The managed files: tracked (staged included) files of a repository, or every file of a plain folder (a role view).
 * With `untracked`, the new files git does not ignore instead.
 */
export function listFiles(repo, { untracked = false } = {}) {
  if (existsSync(join(repo, ".git"))) {
    const out = execFileSync("git", ["-C", repo, "ls-files", "-z", ...(untracked ? ["--others", "--exclude-standard"] : ["--cached"])], { encoding: "utf8", maxBuffer: 1 << 28 });
    return [...new Set(out.split("\0").filter(Boolean))].filter(p => existsSync(join(repo, p))).sort();
  }
  const files = [];
  const walk = dir => {
    for (const name of readdirSync(join(repo, dir))) {
      if (name === ".git") continue;
      const rel = dir ? `${dir}/${name}` : name;
      if (statSync(join(repo, rel)).isDirectory()) walk(rel); else files.push(rel);
    }
  };
  walk("");
  return files.sort();
}

const WORD_ID = "W-[0-9a-f]{10}";
const wordCitation = new RegExp(`(?<![\\w-])${WORD_ID}(?![\\w-])`, "g");
const wordList = new RegExp(`^${WORD_ID}(?:[, \\t]+${WORD_ID})*$`);
const wordIds = text => text.matchAll(wordCitation);
const DISTILLATIONS = new Set(["Purpose", "Decisions", "Blueprint", "Interventions", "Lessons"]);
const ownerCitation = (path, record) => TEXT.test(path)
  && (DISTILLATIONS.has(record?.kind) || record?.settlesOwnerWords === true);

function ownerWordState(read, citations, hasRecord) {
  const words = parseWords(read(WORDS));
  const marks = wordClasses(parseWords(read(MARKS)));
  const cited = new Set();
  for (const text of citations) for (const match of wordIds(text)) cited.add(match[0]);
  const states = words.map(word => {
    const mark = marks.get(word.id) ?? null;
    if (mark) return { word, mark, class: mark.as, settled: mark.as !== "direction" || hasRecord(mark.intervention) };
    return { word, mark, class: cited.has(word.id) ? "unclassified" : null, settled: cited.has(word.id) };
  });
  return { words, states, open: states.filter(s => !s.settled).map(s => s.word) };
}

const idRegexOf = layout => new RegExp(`(?<![\\w-])(?:${layout.filter(k => k.idPattern).map(k => k.idPattern).join("|")})(?![\\w-])`, "g");
const OWNER_EXTRA = path => path === HANDOFFS || path === ANSWERS || path === "loop.json" || /^owner\/B-\d{4}\.md$/.test(path);

function ownerTree(repo, rev, { extra = () => false } = {}) {
  rev = execFileSync("git", ["-C", repo, "rev-parse", "--verify", `${rev}^{commit}`], { encoding: "utf8" }).trim();
  const all = regularFiles(repo, rev);
  const config = all.find(f => f.path === "records.json");
  const layout = parseLayout(readFileSync(DEFAULT_LAYOUT, "utf8"), config ? JSON.parse(blobs(repo, [config.sha])[0]).extraKinds : []);
  const classified = all.map(f => ({ ...f, record: classify(layout, f.path) }));
  const ids = new Map(classified.filter(f => f.record?.id).map(f => [f.record.id, f.path]));
  const interventions = classified.filter(f => f.record?.kind === "Interventions" && TEXT.test(f.path));
  const selected = classified.filter(f => f.path === WORDS || f.path === MARKS || ownerCitation(f.path, f.record)
    || f.record?.kind === "Interventions" || extra(f.path));
  const content = new Map(blobs(repo, selected.map(f => f.sha)).map((bytes, i) => [selected[i].path, bytes.toString("utf8")]));
  const read = path => content.get(path) ?? "";
  const citations = selected.filter(f => f.path !== WORDS && f.path !== MARKS && ownerCitation(f.path, f.record)).map(f => read(f.path));
  const state = ownerWordState(read, citations, id => ids.has(id));
  return { ...state, rev, layout, ids, read, interventions: interventions.map(f => ({ path: f.path, id: f.record.id, text: read(f.path) })) };
}

// SL-01
export const openWords = (repo, rev = "HEAD") => ownerTree(repo, rev).open;

export function ownerRecords(repo, rev = "HEAD") {
  const tree = ownerTree(repo, rev, { extra: OWNER_EXTRA });
  const raised = raisedFirstFindings({ interventions: tree.interventions, states: tree.states, ids: tree.ids,
    idRegex: idRegexOf(tree.layout), firstCommit: firstCommits(repo, tree.rev) });
  return { ...tree, raised };
}

const RAISED_FIRST = /^raised-first:[ \t]*(.*)$/gm;

export function interventionClaim(text, idRegex) {
  const words = [...new Set([...wordIds(text)].map(w => w[0]))];
  const value = [...text.matchAll(RAISED_FIRST)].at(-1)?.[1].trim();
  if (value === undefined) return { words, value, named: undefined };
  if (/^no(?![\p{L}\p{N}_-])/iu.test(value)) return { words, value, named: null };
  return { words, value, named: [...new Set([...value.matchAll(idRegex)].map(m => m[0]))] };
}

// F-0011, R-0008-judge-mechanisms, design/generative-engine.md#intervention-dispositions
export const RUNGS = Object.freeze(["construction", "hard gate", "screening predicate", "question bank", "owner-only"]);
const RUNG_LINE = /^rung:[ \t]*(.*)$/gm;
const CARRIED_BY_LINE = /^carried-by:[ \t]*(.*)$/gm;

export function interventionDisposition(text) {
  const given = [...text.matchAll(RUNG_LINE)].at(-1)?.[1].trim();
  const carriedBy = [...text.matchAll(CARRIED_BY_LINE)].at(-1)?.[1].trim();
  const rung = given === undefined ? null : given.toLowerCase().replace(/\s+/g, " ");
  const problems = [];
  if (given === undefined) problems.push("no rung: line");
  else if (!given) problems.push("its rung: line is blank");
  else if (!RUNGS.includes(rung)) problems.push(`rung "${given}" is not one of ${RUNGS.join(", ")}`);
  if (carriedBy === undefined) problems.push("no carried-by: line");
  else if (!carriedBy) problems.push("its carried-by: line is blank");
  else if (/^none(?![\p{L}\p{N}_-])/iu.test(carriedBy) && !carriedBy.replace(/^none[\s:—–-]*/iu, "").trim())
    problems.push("carried-by: none gives no reason why no mechanism can carry it");
  return { rung: RUNGS.includes(rung) ? rung : given ?? null, carriedBy: carriedBy ?? null, disposed: !problems.length, problems };
}

function firstCommits(repo, rev = "HEAD") {
  const cache = new Map();
  try {
    rev = execFileSync("git", ["-C", repo, "rev-parse", "--verify", `${rev}^{commit}`],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (execFileSync("git", ["-C", repo, "rev-parse", "--is-shallow-repository"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() === "true") return () => undefined;
  } catch { return () => undefined; }
  return path => {
    if (!cache.has(path)) {
      let found;
      try {
        const line = execFileSync("git", ["-C", repo, "log", "--reverse", "--full-history", "--no-renames", "--diff-filter=A", "--format=%H %ct", rev, "--", path],
          { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 1 << 28 }).split("\n")[0].trim();
        found = line ? { sha: line.split(" ")[0], time: Number(line.split(" ")[1]) } : null;
      } catch { found = undefined; }
      cache.set(path, found);
    }
    return cache.get(path);
  };
}

const iso = seconds => new Date(seconds * 1000).toISOString().replace(".000Z", "Z");

export function raisedFirstFindings({ interventions, states, ids, idRegex, firstCommit }) {
  const failures = [], screening = [], claims = new Map();
  const words = new Map(states.map(s => [s.word.id, s.word]));
  for (const { path, id, text } of interventions) {
    const claim = interventionClaim(text, idRegex);
    const linked = states.filter(s => s.mark?.as === "direction" && s.mark.intervention === id).map(s => s.word.id);
    const cited = [...new Set([...claim.words, ...linked])];
    const problems = [];
    const fail = detail => { problems.push(detail); failures.push({ rule: "raised-first", path, detail }); };
    const screen = detail => screening.push({ rule: "raised-first", path, detail });
    claims.set(id, { ...claim, cited, problems, verified: false });
    if (claim.named === undefined) { screen(`${id} has no raised-first: line (a record ID, or no)`); continue; }
    if (claim.named === null) continue;
    if (!claim.named.length) { fail(`raised-first: ${claim.value} names no record ID; name the record that raised it first, or write no`); continue; }
    const compared = cited.filter(w => words.has(w) && Number.isFinite(Date.parse(words.get(w).time)));
    for (const w of cited) if (!words.has(w)) screen(`${id} cites ${w}, which ${WORDS} does not hold; raised-first is not checked against its capture time`);
    for (const w of cited) if (words.has(w) && !Number.isFinite(Date.parse(words.get(w).time)))
      screen(`${id} cites ${w} with an unreadable capture time; raised-first cannot be verified`);
    if (!compared.length) screen(`${id} names ${claim.named.join(", ")} as raised first but has no cited or marked word with a known capture time`);
    let unread = false;
    for (const named of claim.named) {
      if (!ids.has(named)) { fail(`raised-first: names ${named}, which no record carries`); continue; }
      const first = firstCommit(ids.get(named));
      if (first === undefined) { unread = true; screen(`the history of ${ids.get(named)} cannot be read, so raised-first: ${named} is not checked`); continue; }
      if (first === null) { fail(`raised-first: ${named} (${ids.get(named)}) has no commit, so it was not on record before the owner's words`); continue; }
      for (const w of compared) {
        const word = words.get(w);
        if (!(first.time * 1000 < Date.parse(word.time)))
          fail(`raised-first: ${named} was first committed at ${iso(first.time)} (${first.sha.slice(0, 12)}), not before ${w} (captured ${word.time})`);
      }
    }
    claims.get(id).verified = !problems.length && !unread && compared.length > 0 && compared.length === cited.length;
  }
  return { failures, screening, claims };
}

function checkOwnerWords(records, texts, read, has, ids, failures, screening) {
  let state;
  try { state = ownerWordState(path => has.has(path) ? read(path) : "",
    records.filter(r => ownerCitation(r.path, r)).map(r => texts.get(r.path)), id => ids.has(id)); }
  catch (e) {
    screening.push({ rule: "owner-word-log", path: WORDS, detail: `could not check the owner ledgers: ${e.message}` });
    return null;
  }
  const known = new Set(state.words.map(w => w.id));
  for (const { word, mark, settled } of state.states) {
    if (settled) continue;
    screening.push({ rule: "open-owner-word", path: WORDS, detail: mark?.as === "direction"
      ? `${word.id} is a direction word; its intervention ${mark.intervention} is not recorded` : `${word.id} has no record citation or mark` });
  }
  for (const { path, kind } of records) {
    if (kind !== "Purpose") continue;
    const fields = new Map();
    for (const line of (texts.get(path) ?? "").split(/\r?\n/).slice(1)) {
      if (!line.trim()) continue;
      const match = /^(\w[\w-]*):[ \t]*(.*)$/.exec(line);
      if (!match) break;
      fields.set(match[1], match[2].trim());
    }
    const citations = (fields.get("words") ?? "").replaceAll("`", "");
    const named = new Set(wordList.test(citations) ? [...wordIds(citations)].map(m => m[0]) : []);
    for (const id of named)
      if (!known.has(id)) failures.push({ rule: "unknown-owner-word", path, detail: `words: names ${id}, missing from ${WORDS}` });
    const date = fields.get("date") ?? "";
    if (/^\d{4}-\d{2}-\d{2}$/.test(date) && date >= "2026-11-21" && !named.size)
      screening.push({ rule: "purpose-words", path, detail: `purpose dated ${date} needs a words: line naming recorded owner words` });
  }
  return state;
}

const firstHeading = text => (/^#\s+(.+)$/m.exec(text)?.[1] ?? "").trim();

function sealedScreenText(record, text) {
  if (record.path === HANDOFFS) {
    return text.split("\n").map(line => {
      try {
        const handoff = JSON.parse(line);
        delete handoff.files;
        if (handoff.audit && typeof handoff.audit === "object") delete handoff.audit.file;
        return JSON.stringify(handoff);
      } catch { return line; } // The hand-off validator reports malformed rows separately.
    }).join("\n");
  }
  if (record.kind !== "Rounds") return text;
  const lines = text.split(/\r?\n/);
  const fields = ["phase", "role", "agent", "view", "briefs", "product", "audit"];
  // call.mjs writes these metadata lines before the verbatim task or public report.
  if (lines[0] !== `# ${record.id}` || lines[1] !== "" || lines[9] !== ""
      || !/^## (?:Task \(verbatim\)|Public report \(verbatim, out\/public\.md\))$/.test(lines[10] ?? "")
      || !fields.every((field, i) => lines[i + 2]?.startsWith(field + ": "))) return text;
  return lines.map((line, i) => i < 10 ? "" : line).join("\n");
}

/** The status a non-round record carries in its own `status:` field. */
const ownStatus = text => /^status:\s*(.+)$/mi.exec(text)?.[1]?.trim() ?? "";

/**
 * Everything the check needs, computed once. Pure apart from reading the repository.
 * @param options.files the managed set (default: tracked and new files); the index lists exactly these
 * @param options.own the paths whose structure is certain to matter (default: all of `files`)
 * @param options.screenOnly screen the text of these paths only (default: every record)
 * @param options.blueprint validate the full blueprint (default true; false for partial role views)
 * @param options.read the text of a path (default: the file under `repo`); given with `files`, the set is taken as is
 */
export function inspect(repo, { layoutText, config = {}, files, own, screenOnly, read, blueprint: includeBlueprint = true } = {}) {
  repo = resolve(repo);
  const given = Boolean(read && files);
  read ??= p => readFileSync(join(repo, p), "utf8");
  const layout = parseLayout(layoutText ?? readFileSync(DEFAULT_LAYOUT, "utf8"), config.extraKinds ?? []);
  const sealedReaders = new Set(config.sealedReaders ?? ["judge", "lead"]);
  const sealedRoots = [join(repo, "sealed"), ...(config.sealed ?? []).map(p => resolve(repo, p))];
  const untracked = files || !existsSync(join(repo, ".git")) ? [] : listFiles(repo, { untracked: true });
  files = (files ?? listFiles(repo)).filter(p => given || existsSync(join(repo, p))).sort();
  const checked = new Set(own ?? files);
  const records = [];
  const failures = [];
  const screening = [];
  const ids = new Map();
  for (const path of files) {
    const c = classify(layout, path);
    if (!c) {
      (checked.has(path) ? failures : screening).push({ rule: "undeclared", path, detail: "no declared kind and path (RECORDS.md layout or records.json extraKinds)" });
      continue;
    }
    records.push({ path, ...c });
    if (c.id) ids.set(c.id, path);
  }
  for (const path of untracked) screening.push({ rule: "untracked", path, detail: `not committed or staged, so not in the index${classify(layout, path) ? "" : "; no declared kind either"}` });
  const idRegex = idRegexOf(layout);
  const has = new Set(files);
  let handoffs = [];
  if (has.has(HANDOFFS)) {
    try {
      handoffs = parseHandoffs(read(HANDOFFS));
      const seen = new Set();
      for (const h of handoffs) {
        if (seen.has(h.record)) failures.push({ rule: "handoff", path: HANDOFFS, detail: `two hand-offs for ${h.record}` });
        seen.add(h.record);
        for (const f of h.files) if (!has.has(f)) failures.push({ rule: "handoff", path: HANDOFFS, detail: `${h.id} names ${f}, which the records do not hold` });
      }
    } catch (e) { failures.push({ rule: "handoff", path: HANDOFFS, detail: e.message }); }
  }
  const roleView = new Set([...handoffs.map(h => h.record), ...(config.publicImports ?? [])]);
  const isPublicMaterial = record => record.kind !== "Sealed" && (roleView.has(record.path) || isPublicKind(record.kind));
  const supersededBy = new Map();
  const decisionCitations = new Set();
  const texts = new Map();
  for (const record of records) {
    if (!TEXT.test(record.path) && !(JSONL.test(record.path) && isPublicMaterial(record))) continue;
    const text = read(record.path);
    texts.set(record.path, text);
    if (record.kind === "Decisions") for (const m of text.matchAll(idRegex)) decisionCitations.add(m[0]);
    for (const m of text.matchAll(/^supersedes:\s*(.+)$/gmi))
      for (const target of m[1].split(/[,\s]+/).filter(Boolean)) supersededBy.set(target, record.id ?? record.path);
  }
  const latestActorWrite = new Map();
  for (const [i, h] of handoffs.entries()) {
    if (h.role === "actor") for (const path of h.files) latestActorWrite.set(path, i);
  }
  for (const [i, h] of handoffs.entries()) {
    if (decisionCitations.has(h.id)) continue;
    for (const conflict of h.designConflicts ?? []) {
      if (latestActorWrite.get(conflict.path) > i) continue;
      const current = texts.has(conflict.path) ? createHash("sha256").update(texts.get(conflict.path)).digest("hex") : null;
      if (current === conflict.current) screening.push({ rule: "design-conflict", path: conflict.path,
        detail: `${h.id} proposed a design based on an older view. The current design changed at ${conflict.changed}${conflict.writer ? ` (prior design hand-off ${conflict.writer})` : ""}. Compare ${conflict.proposal} with the current design` });
    }
  }
  const screened = screenOnly ? new Set(screenOnly) : null;
  for (const record of records) {
    const text = texts.get(record.path);
    if (text === undefined || screened && !screened.has(record.path)) continue;
    const lineOf = index => text.slice(0, index).split("\n").length;
    const role = record.kind === "Rounds" ? /\d{4}-([a-z]+)/.exec(record.path)?.[1] : record.kind === "Engines" ? /([^/]+)\.md$/.exec(record.path)?.[1] : null;
    const publicMaterial = isPublicMaterial(record);
    if (publicMaterial || role && !sealedReaders.has(role)) {
      const material = sealedScreenText(record, text);
      for (const root of sealedRoots) {
        const forms = [root, ...(root.startsWith(`${repo}/`) ? [root.slice(repo.length + 1) + "/"] : [])];
        for (const form of forms) {
          const escaped = form.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const tail = form.endsWith("/") ? "[\\w.@/-]*" : "(?:/[\\w.@/-]*)?(?![\\w@/-]|\\.[\\w.@-])";
          const re = new RegExp(`(?<![\\w./-])${escaped}${tail}`, "g");
          for (const m of material.matchAll(re))
            screening.push({ rule: "sealed-path", path: record.path, line: material.slice(0, m.index).split("\n").length,
              detail: `${publicMaterial ? "public role" : role} material names sealed path ${m[0]}` });
        }
      }
    }
    if (!TEXT.test(record.path) || QUOTED.has(record.kind)) continue;
    for (const m of text.matchAll(idRegex))
      if (!ids.has(m[0]) && m[0] !== record.id)
        screening.push({ rule: "dangling-id", path: record.path, line: lineOf(m.index), detail: `cites ${m[0]}, which no record carries` });
    screen(repo, record, text, lineOf, ids, screening);
  }
  screenChanged(repo, records, screening);
  const answered = new Set(), replaced = new Map();
  if (has.has(ANSWERS)) {
    try {
      const events = parseEvents(read(ANSWERS));
      for (const e of events) if ("replacedBy" in e) { if (!replaced.has(e.batch)) replaced.set(e.batch, e.replacedBy); } else answered.add(e.batch);
      const batch = id => `owner/${id}.md`;
      for (const detail of replacementProblems(events, { exists: id => has.has(batch(id)), textOf: id => read(batch(id)) }))
        failures.push({ rule: "answers", path: ANSWERS, detail });
    } catch (e) { failures.push({ rule: "answers", path: ANSWERS, detail: e.message }); }
  }
  let blueprint;
  if (includeBlueprint) {
    const owner = checkOwnerWords(records, texts, read, has, ids, failures, screening);
    if (owner) {
      const raised = raisedFirstFindings({ states: owner.states, ids, idRegex,
        interventions: records.filter(r => r.kind === "Interventions" && texts.has(r.path)).map(r => ({ path: r.path, id: r.id, text: texts.get(r.path) })),
        firstCommit: existsSync(join(repo, ".git")) ? firstCommits(repo) : () => undefined });
      for (const f of raised.failures)
        (checked.has(f.path) || checked.has(WORDS) || checked.has(MARKS) ? failures : screening).push(f);
      screening.push(...raised.screening);
    }
    blueprint = inspectBlueprint(repo, { files, read, handoffs });
    failures.push(...blueprint.failures);
    let rows = [];
    // D-0015 item 1; design/version-tip.md#who-reads-what
    if (has.has(TRAJECTORY)) {
      try {
        rows = parseRows(read(TRAJECTORY));
        for (const row of rows) {
          const problem = row.verdict === "CONVERGED" && row.ciReceipt && rowReceiptProblem(row, path => has.has(path) ? read(path) : null);
          if (problem) failures.push({ rule: "trajectory", path: TRAJECTORY, detail: problem });
        }
      } catch (e) { failures.push({ rule: "trajectory", path: TRAJECTORY, detail: e.message }); }
    }
    const bar = config.blockerBar ?? BAR;
    if (typeof bar !== "string" || !/^[^/\\].*\.md$/.test(bar))
      failures.push({ rule: "judge-bar", path: "records.json", detail: `blockerBar must be the records path of a decision (default ${BAR}), got ${JSON.stringify(bar)}` });
    else {
      const judged = judgeBarFindings(repo, { records, rows, read, bar });
      for (const f of judged.failures) (checked.has(f.path) || checked.has(TRAJECTORY) ? failures : screening).push(f);
      screening.push(...judged.screening);
    }
    screening.push(...blueprintAlarms(blueprint, handoffs));
    if (has.has("loop.json")) {
      const { phase } = JSON.parse(read("loop.json"));
      if (phase) {
        const currentDesigns = new Set(handoffs.filter(h => h.role === "actor" && h.phase === phase).flatMap(h => h.files));
        for (const { kind, path } of records) {
          if (kind === "Design" && !currentDesigns.has(path))
            screening.push({ rule: "stale-design", path, detail: `no actor hand-off wrote this design in phase ${phase}` });
        }
      }
    }
    const ssotRec = ssotRecordsFindings(repo, { has, read, given });
    failures.push(...ssotRec.failures);
    screening.push(...ssotRec.screening);
  }
  return { repo, layout, files, records, ids, supersededBy, failures, screening, sealedRoots, answered, replaced, read, blueprint };
}

/** Immutable records edited, or append-only records not extended, against HEAD (screening: the lead reviews). */
function screenChanged(repo, records, screening) {
  if (!existsSync(join(repo, ".git"))) return;
  let changed;
  try { changed = new Set(execFileSync("git", ["-C", repo, "diff", "--name-only", "--diff-filter=MT", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split("\n").filter(Boolean)); }
  catch { return; }
  for (const r of records) {
    if (!changed.has(r.path) || r.changes === "editable") continue;
    if (r.changes === "append-only") {
      let before = "";
      try { before = execFileSync("git", ["-C", repo, "show", `HEAD:${r.path}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch { continue; }
      if (existsSync(join(repo, r.path)) && readFileSync(join(repo, r.path), "utf8").startsWith(before)) continue;
    }
    screening.push({ rule: "changed-record", path: r.path, detail: `${r.changes} record differs from HEAD other than by appending` });
  }
}

const SECRET = [
  /gh[pousr]_[A-Za-z0-9]{30,}/, /github_pat_[A-Za-z0-9_]{40,}/, /sk-ant-[A-Za-z0-9_-]{20,}/, /\bsk-[A-Za-z0-9]{32,}/,
  /\bAKIA[0-9A-Z]{16}\b/, /\bASIA[0-9A-Z]{16}\b/,
  /["']?(?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY|SecretAccessKey)["']?\s*[:=]\s*["']?[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\bxox[abpr]-[A-Za-z0-9-]{10,}/,
];
const SCRATCH = /(?:^|[\s(\[`'"])((?:\/private)?\/tmp\/[^\s)\]`'"]+|\/var\/folders\/[^\s)\]`'"]+)/g;

function screen(repo, record, text, lineOf, ids, screening) {
  const add = (rule, index, detail) => screening.push({ rule, path: record.path, line: lineOf(index), detail });
  // A bare line number in a file that changes (RECORDS rule 4): `path.ext:123` with no `@commit` before the colon.
  for (const m of text.matchAll(/(?<![\w@/.-])((?:\/|\.{0,2}\/)?[\w.@-]+(?:\/[\w.@-]+)*\.[A-Za-z]{1,8}):(\d+)\b/g))
    if (!/@[0-9a-f]{7,40}$/.test(m[1]) && !/^\d+\.\d+$/.test(m[1])) add("bare-line-citation", m.index, `${m[1]}:${m[2]} names a line without a commit`);
  for (const m of text.matchAll(SCRATCH)) add("scratch-path", m.index, `${m[1]} lives in scratch space`);
  for (const m of text.matchAll(/(?<![\w/.-])([\w.-]+(?:\/[\w.-]+)*)@([0-9a-f]{7,40})\b/g)) {
    const [, path, commit] = m;
    if (!existsSync(join(repo, ".git")) || !existsSync(join(repo, path.split("/")[0]))) continue; // not a records path
    try { execFileSync("git", ["-C", repo, "cat-file", "-e", `${commit}:${path}`], { stdio: "ignore" }); }
    catch { add("commit-citation", m.index, `${path}@${commit} does not resolve in the records repository`); }
  }
  for (const m of text.matchAll(/(evidence\/\d{4}\/[^\s)`'"]+)\s+sha256:([0-9a-f]{64})/g)) {
    const file = join(repo, m[1]);
    if (!existsSync(file)) { add("digest", m.index, `${m[1]} cited by digest does not exist`); continue; }
    const actual = createHash("sha256").update(readFileSync(file)).digest("hex");
    if (actual !== m[2]) add("digest", m.index, `${m[1]} has sha256 ${actual.slice(0, 12)}…, cited ${m[2].slice(0, 12)}…`);
  }
  for (const pattern of SECRET) {
    const m = pattern.exec(text);
    if (m) add("secret", m.index, `secret-like string (${pattern.source.slice(0, 24)}…)`);
  }
  if (record.kind === "Design")
    for (const m of text.matchAll(/^#{1,6}\s.*(?:\bRound\s+\d+|第\s*\d+\s*轮)/gmi)) add("history-in-design", m.index, `history heading in a design file: ${m[0].trim()}`);
}

/** The generated index: one table per kind, sealed contents counted but not named. Deterministic (content only). */
export function renderIndex(state, { legacyLogIds = false } = {}) {
  const { layout, records, supersededBy } = state;
  if (!state.answered) throw new Error("renderIndex needs the state from inspect");
  const lines = ["# Index", "", "Generated by `node scripts/records-check.mjs --write`; do not edit. A record not listed here does not exist for the loop.", ""];
  for (const kind of layout) {
    if (kind.kind === "Index" || kind.kind === "Blueprint view") continue;
    const mine = records.filter(r => r.kind === kind.kind);
    if (!mine.length) continue;
    lines.push(`## ${kind.kind}`, "");
    if (kind.kind === "Sealed") { lines.push(`${mine.length} sealed file(s); readable only by the judge and the lead.`, ""); continue; }
    if (["Backtests", "Evidence"].includes(kind.kind)) {
      const dirs = new Map();
      for (const r of mine) { const d = r.path.split("/").slice(0, 2).join("/"); dirs.set(d, (dirs.get(d) ?? 0) + 1); }
      lines.push("| Folder | Files |", "|---|---|", ...[...dirs].map(([d, n]) => `| \`${d}/\` | ${n} |`), "");
      continue;
    }
    lines.push("| ID | Path | Title | Status |", "|---|---|---|---|");
    for (const r of mine) {
      let title = "", status = "";
      if (/\.md$/.test(r.path)) {
        const text = state.read(r.path);
        title = firstHeading(text).replace(/\|/g, "\\|");
        if (r.kind === "Owner batches") status = state.answered.has(r.id) ? "answered" : state.replaced?.has(r.id) ? `replaced by ${state.replaced.get(r.id)}` : "open";
        else if (r.kind !== "Blueprint") status = ownStatus(text);
      }
      const by = supersededBy.get(r.id ?? r.path);
      if (by) status = `superseded by ${by}`;
      const id = legacyLogIds && JSONL.test(r.path) ? classify(layout, r.path, { legacyLogIds }).id : r.id;
      lines.push(`| ${id ?? "—"} | \`${r.path}\` | ${title} | ${status} |`);
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * The index generated for one tree of a records repository (an automatic writer's candidate commit), reading only what
 * the index shows: Markdown titles and status fields, supersessions and the answer events.
 */
export function indexOfTree(repo, treeish, { layoutText = readFileSync(DEFAULT_LAYOUT, "utf8") } = {}) {
  const all = regularFiles(repo, treeish).filter(e => e.path !== "INDEX.md");
  const configEntry = all.find(e => e.path === "records.json");
  const config = configEntry ? JSON.parse(blobs(repo, [configEntry.sha])[0].toString("utf8")) : {};
  const layout = parseLayout(layoutText, config.extraKinds ?? []);
  const shown = all.filter(e => e.path === ANSWERS || (/\.md$/.test(e.path) && !QUOTED.has(classify(layout, e.path)?.kind)));
  const contents = new Map(blobs(repo, shown.map(e => e.sha)).map((bytes, i) => [shown[i].path, bytes.toString("utf8")]));
  const state = inspect(repo, { layoutText, config, files: all.map(e => e.path), screenOnly: [], blueprint: false, read: p => contents.get(p) ?? "" });
  return renderIndex(state);
}

export function check(repo, options = {}) {
  const state = inspect(repo, options);
  checkGenerated("INDEX.md", renderIndex(state), "index-drift", () => renderIndex(state, { legacyLogIds: true }));
  if (state.blueprint && state.files.some(p => p === BLUEPRINT || p === FEATURE_EVENTS || FEATURE_FILE.test(p))) {
    const alarms = ownerAlarms(state.blueprint).map(alarm => alarm.detail);
    checkGenerated(BLUEPRINT, renderBlueprint(state.blueprint, alarms), "blueprint-drift",
      () => renderBlueprint(state.blueprint, alarms, { legacyCount: true }));
  }
  return state;

  function checkGenerated(path, expected, rule, legacy) {
    const file = join(state.repo, path);
    if (options.write) {
      writeFileSync(file, expected);
      return;
    }
    const actual = existsSync(file) ? readFileSync(file, "utf8") : null;
    if (actual === expected) return;
    if (actual !== null && actual === legacy()) {
      state.screening.push({ rule: "generated-format", path, detail: "matches the previous generated format; regenerate with --write" });
      return;
    }
    state.failures.push({ rule, path, detail: `${actual === null ? "missing" : "differs from the generated " + (path === BLUEPRINT ? "blueprint" : "index")}; fix: node ${join(here, "records-check.mjs")} --repo ${state.repo} --write` });
  }
}

function loadConfig(repo) {
  const file = join(repo, "records.json");
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
}

if (process.argv[1] === fileURLToPath(import.meta.url)) cli(() => {
  const args = parseArgs(process.argv.slice(2));
  need(args, "repo");
  const repo = resolve(args.repo);
  const layoutText = readFileSync(args.layout || DEFAULT_LAYOUT, "utf8");
  const state = check(repo, { layoutText, config: loadConfig(repo), write: "write" in args });
  if ("json" in args) console.log(JSON.stringify({ failures: state.failures, screening: state.screening }, null, 2));
  else {
    const show = (items, max = 40) => {
      for (const f of items.slice(0, max)) console.log(`  ${f.rule}  ${f.path}${f.line ? `:${f.line}` : ""}  ${f.detail}`);
      if (items.length > max) console.log(`  … ${items.length - max} more (use --json)`);
    };
    console.log(`${state.files.length} files, ${state.records.length} declared records`);
    if (state.failures.length) { console.log(`FAILED: ${state.failures.length} certain finding(s)`); show(state.failures); }
    if (state.screening.length) { console.log(`${state.screening.length} screening finding(s) for review (not blocking)`); show(state.screening, 20); }
    if (!state.failures.length) console.log("records check passed");
  }
  return state.failures.length ? 1 : 0;
});
