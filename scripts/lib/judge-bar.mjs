// D-0018, D-0023, design/records-and-guard.md#judge-records
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export const LOSSES = ["data", "wrong-result", "false-verdict", "disclosure", "stuck"];
export const BAR = "decisions/D-0018.md";
export const JUDGE_RECORD = /^rounds\/(\d{4})-judge(?:-[^/]+)?\.md$/;

const HEADING = /^ {0,3}#{1,6}(?:\s|$)/;
const LEAD = /^(?:[-*+]\s|\d+[.)]\s|\*\*|__)/;
const FIELD = /^\s*(?:>\s*)*(?:[-*+]\s+|\d+[.)]\s+)?[*_`]*(flow|loss)[*_`]*\s*:[*_`]*\s*(.*)$/i;
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const list = value => (!value || value === "-" ? [] : value.split(",").map(s => s.trim()).filter(Boolean));

export function keyPattern(key) {
  const colon = key.indexOf(":");
  const cls = key.slice(0, colon), id = key.slice(colon + 1);
  return new RegExp(`(?<![\\w.:-])(?:${escape(cls)}:)?${escape(id)}(?![\\w-]|\\.[\\w-])`);
}

export function field(line) {
  const m = FIELD.exec(line);
  if (!m) return null;
  const name = m[1].toLowerCase();
  if (name === "flow") return { name };
  const word = (/^[*_`"'(\[]*([A-Za-z][A-Za-z-]*)/.exec(m[2])?.[1] ?? "").toLowerCase();
  return { name, word, listed: LOSSES.includes(word) };
}

export function parseJudgeRecord(text) {
  const lines = text.split(/\r?\n/);
  const end = lines.findIndex((line, i) => i > 0 && /^## /.test(line));
  const header = lines.slice(0, end === -1 ? lines.length : end);
  const value = name => header.map(line => new RegExp(`^${name}:\\s*(.*?)\\s*$`).exec(line)?.[1]).find(v => v !== undefined);
  return {
    view: /^records@([0-9a-f]{7,40})$/.exec(value("view") ?? "")?.[1] ?? null,
    phase: value("phase") || null,
    body: end === -1 ? [] : lines.slice(end + 1),
  };
}

export function blocks(lines, patterns) {
  const names = text => new Set(patterns.filter(([, re]) => re.test(text)).map(([key]) => key));
  const out = [];
  let paragraph = [], named = new Set();
  const close = () => {
    if (paragraph.length) out.push({ names: named, lines: paragraph });
    paragraph = [];
    named = new Set();
  };
  for (const [i, line] of lines.entries()) {
    if (HEADING.test(line)) {
      close();
      const next = lines.findIndex((l, j) => j > i && HEADING.test(l));
      out.push({ names: names(line), lines: lines.slice(i, next === -1 ? lines.length : next) });
      continue;
    }
    if (!line.trim()) { close(); continue; }
    const mine = names(line);
    if (paragraph.length && LEAD.test(line) && !field(line) && [...mine].some(k => !named.has(k))) close();
    paragraph.push(line);
    for (const k of mine) named.add(k);
  }
  close();
  return out;
}

function shortfall(block) {
  const fields = block.lines.map(field).filter(Boolean);
  const losses = fields.filter(f => f.name === "loss");
  const missing = [];
  if (!fields.some(f => f.name === "flow")) missing.push("a flow: line");
  if (!losses.length) missing.push("a loss: line");
  else if (!losses.some(f => f.listed))
    missing.push(`a listed loss (loss: ${losses.map(f => f.word ? `\`${f.word}\`` : "with no word").join(", ")} is not one of ${LOSSES.join(", ")})`);
  return missing;
}

export function keyProblem(body, key, keys = [key]) {
  const patterns = keys.map(k => [k, keyPattern(k)]);
  const naming = blocks(body, patterns).filter(b => b.names.has(key));
  if (!naming.length) return `no block names it (by ${key} or its id); it needs one holding a flow: line and a loss: line from ${LOSSES.join(", ")}`;
  const gaps = naming.map(shortfall);
  if (gaps.some(g => !g.length)) return null;
  const best = gaps.reduce((a, b) => (b.length < a.length ? b : a));
  return `no block naming it holds both lines: missing ${best.join(" and ")}`;
}

export function viewsHolding(repo, views, path) {
  const result = new Map(views.map(v => [v, null]));
  if (!views.length || !existsSync(join(repo, ".git"))) return result;
  const input = views.flatMap(v => [`${v}^{commit}`, `${v}:${path}`]).join("\n") + "\n";
  const r = spawnSync("git", ["-C", repo, "cat-file", "--batch-check"], { input, encoding: "utf8" });
  if (r.status !== 0) return result;
  const lines = r.stdout.split("\n");
  const found = i => !/ (?:missing|ambiguous)$/.test(lines[i] ?? " missing");
  views.forEach((v, i) => { if (found(2 * i)) result.set(v, found(2 * i + 1)); });
  return result;
}

export function judgeBarFindings(repo, { records, rows, read, bar = BAR }) {
  const failures = [], screening = [];
  const judged = records.filter(r => JUDGE_RECORD.test(r.path)).map(r => {
    const parsed = parseJudgeRecord(read(r.path));
    return { path: r.path, id: r.id, round: Number(JUDGE_RECORD.exec(r.path)[1]), ...parsed };
  });
  const opened = new Map();
  for (const row of rows) {
    if (row.role !== "judge") continue;
    for (const key of list(row.opened)) {
      const at = `${row.phase}\t${row.round}`;
      if (!opened.has(at)) opened.set(at, new Set());
      opened.get(at).add(key);
    }
  }
  const keysOf = j => [...opened].filter(([at]) => {
    const [phase, round] = at.split("\t");
    return Number(round) === j.round && (!j.phase || j.phase === phase);
  }).flatMap(([, keys]) => [...keys]);
  const subject = judged.map(j => ({ ...j, keys: [...new Set(keysOf(j))] })).filter(j => j.view && j.keys.length);
  const holding = viewsHolding(repo, [...new Set(subject.map(j => j.view))], bar);
  const held = [];
  for (const j of subject) {
    const state = holding.get(j.view);
    if (state === true) held.push(j);
    else if (state === null)
      screening.push({ rule: "judge-bar", path: j.path, detail: `${j.id} opened ${j.keys.join(", ")} but its view records@${j.view} cannot be read, so whether ${bar} governs it is unknown` });
  }
  const rounds = new Map();
  for (const j of held) {
    const at = `${j.phase ?? ""}\t${j.round}`;
    if (!rounds.has(at)) rounds.set(at, []);
    rounds.get(at).push(j);
  }
  for (const group of rounds.values()) {
    const keys = [...new Set(group.flatMap(j => j.keys))];
    for (const key of keys) {
      const problems = group.map(j => keyProblem(j.body, key, keys));
      if (problems.some(p => p === null)) continue;
      group.forEach((j, i) => failures.push({ rule: "judge-bar", path: j.path,
        detail: `${j.id}: ${key}, opened by the round's judge trajectory row, ${problems[i]} (${bar} is in its view records@${j.view})` }));
    }
  }
  return { failures, screening };
}
