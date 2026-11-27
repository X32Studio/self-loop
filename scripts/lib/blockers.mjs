// R-0008-judge-frame, R-0007-judge, D-0024, D-0064, D-0067, design/round9-b.md#one-ruling-one-transition
export const FIELDS = ["opened", "closed", "shelved", "carried"];
export const LABELS = { opened: "OPENED", closed: "CLOSED", shelved: "SHELVED", carried: "CARRIED" };
const FIELD_OF = Object.fromEntries(FIELDS.map(f => [LABELS[f], f]));
const HEADER = /^(VERDICT|SHA|AREA|SUITE|OPENED|CLOSED|SHELVED|CARRIED|ACCEPTANCE):[ \t]*(.*?)\s*$/;
// design/round9-b.md#complete-tokens
const RUN = /[^\s,`*()\[\]{}"'<>|;]+/gu;
const NONE = /^(?:-|–|—|none|n\/a)?$/i;
const FORBIDDEN = [["opened", "carried"], ["opened", "shelved"], ["closed", "shelved"]];

export const tokens = text => [...String(text).matchAll(RUN)].map(m => m[0].replace(/[.:]+$/u, "")).filter(Boolean);

export function isKey(text) {
  return /^[^\s,:]+:[^\s,]+$/u.test(String(text)) && !String(text).endsWith(":");
}

const idOf = key => key.slice(key.indexOf(":") + 1);
const listOf = value => (Array.isArray(value) ? value : typeof value === "string" && value !== "-" ? value.split(",") : [])
  .map(s => String(s).trim()).filter(Boolean);
export const dispositions = row => Object.fromEntries(FIELDS.map(f => [f, [...new Set(listOf(row?.[f]))]]));
export const isRuling = row => (row?.role === "judge" || row?.role === "critic") && row.verdict !== undefined && row.verdict !== "-";

// design/round9-b.md#the-transition
export function transition(state, row) {
  const next = new Map(state);
  const { opened, closed, shelved, carried } = dispositions(row);
  const at = { round: row.round, area: row.area ?? "-", phase: row.phase };
  for (const key of opened) next.set(key, { status: "open", origin: "opened", ...at });
  for (const key of carried) if (next.get(key)?.status !== "open") next.set(key, { status: "open", origin: "carried", ...at });
  for (const key of closed) next.set(key, { status: "closed", ...at });
  for (const key of shelved) next.set(key, { status: "shelved", ...at });
  return next;
}

export function rulingRows(rows, phase) {
  const unique = new Map();
  for (const row of rows.filter(r => isRuling(r) && (phase === undefined || r.phase === phase))) {
    const identity = JSON.stringify([row.phase, row.round, row.role, row.commit, row.area, row.verdict,
      ...FIELDS.map(f => dispositions(row)[f].sort())]);
    unique.set(identity, row);
  }
  return [...unique.values()].sort((a, b) => a.round - b.round);
}

export function blockerState(rows, { phase } = {}) {
  let state = new Map();
  for (const row of rulingRows(rows, phase)) state = transition(state, row);
  return state;
}

export const withStatus = (state, status) => [...state].filter(([, s]) => s.status === status).map(([key, s]) => ({ key, ...s }));

// design/round9-b.md#structured-fields
function splitTop(value) {
  const items = [];
  let depth = 0, item = "";
  for (const ch of value) {
    if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch) && depth > 0) depth--;
    if (ch === "," && depth === 0) { items.push(item); item = ""; } else item += ch;
  }
  return [...items, item];
}

function outsideGroups(text) {
  let out = "", depth = 0;
  for (const ch of text) {
    if ("([{".includes(ch)) { depth++; continue; }
    if (")]}".includes(ch) && depth > 0) { depth--; continue; }
    if (!depth) out += ch;
  }
  return depth ? text : out;
}

export function fieldKeys(value) {
  const keys = [], unreadable = [];
  for (const item of splitTop(value)) {
    const bare = outsideGroups(item).replace(/[`*"']+(?=\s|$)|(?<=^|\s)[`*"']+/gu, " ").trim();
    if (NONE.test(bare)) continue;
    const words = tokens(bare), found = words.filter(isKey);
    if (!found.length || (found.length > 1 && found.length !== words.length)) unreadable.push(item.trim());
    else keys.push(...found);
  }
  return { keys: [...new Set(keys)], unreadable };
}

function fieldBlock(body) {
  let fenced = false, block = null;
  for (const line of body) {
    if (/^\s*(?:```|~~~)/.test(line)) { fenced = !fenced; if (block) break; continue; }
    const m = !fenced && HEADER.exec(line);
    if (m) { (block ??= []).push([m[1], m[2]]); continue; }
    if (block) break;
  }
  return block ?? [];
}

export function readRuling(path, text) {
  const lines = String(text).split(/\r?\n/);
  const end = lines.findIndex((line, i) => i > 0 && /^## /.test(line));
  const head = lines.slice(0, end === -1 ? lines.length : end);
  const value = name => head.map(line => new RegExp(`^${name}:\\s*(.*?)\\s*$`).exec(line)?.[1]).find(v => v !== undefined);
  const body = end === -1 ? [] : lines.slice(end + 1);
  const block = fieldBlock(body);
  const sha = /^[0-9a-f]{7,64}\b/.exec(value("product") ?? "")?.[0] ?? /^[0-9a-f]{7,64}\b/.exec(block.find(([name]) => name === "SHA")?.[1] ?? "")?.[0] ?? null;
  const fields = Object.fromEntries(FIELDS.map(f => [f, []])), unreadable = {};
  let structured = false;
  for (const [name, text] of block) {
    const field = FIELD_OF[name];
    if (!field) continue;
    structured = true;
    const read = fieldKeys(text);
    fields[field] = [...new Set([...fields[field], ...read.keys])];
    if (read.unreadable.length) unreadable[field] = [...(unreadable[field] ?? []), ...read.unreadable];
  }
  return { path, phase: value("phase") || null, sha, structured, fields, unreadable, tokens: new Set(tokens(body.join("\n"))) };
}

export function named(key, rulings) {
  if (rulings.some(r => r.tokens.has(key))) return true;
  const id = idOf(key);
  if (!rulings.some(r => r.tokens.has(id))) return false;
  return !rulings.some(r => [...r.tokens].some(t => t !== key && isKey(t) && idOf(t) === id));
}

const matches = (commit, sha) => typeof commit === "string" && commit.length >= sha.length && commit.startsWith(sha);

// R-0008-judge-frame
export function admit(row, rulings, flags, { where = "the records" } = {}) {
  const mine = rulings.filter(r => !r.phase || r.phase === row.phase);
  const candidates = mine.filter(r => r.structured && (!r.sha || matches(row.commit, r.sha)));
  const bound = candidates.slice(-1);
  const derived = new Map();
  for (const r of bound) {
    const own = new Map();
    for (const f of FIELDS) for (const key of r.fields[f]) (own.get(key) ?? own.set(key, new Set()).get(key)).add(f);
    for (const [key, set] of own) {
      const clash = FORBIDDEN.find(([a, b]) => set.has(a) && set.has(b));
      if (clash) return { refusal: `${r.path} lists ${key} under both ${LABELS[clash[0]]} and ${LABELS[clash[1]]}; a further judge call of the round (call.mjs ... judge --step judge-<word>) settles it` };
      derived.set(key, { set, path: r.path });
    }
  }
  const unreadable = new Map();
  for (const r of bound) for (const [f, items] of Object.entries(r.unreadable)) unreadable.set(f, [...(unreadable.get(f) ?? []), `${r.path}: ${items.map(i => `\`${i}\``).join(", ")}`]);
  const fields = Object.fromEntries(FIELDS.map(f => [f, []]));
  for (const [key, { set }] of derived) for (const f of set) fields[f].push(key);
  const roleLabel = row.role === "critic" ? "critic" : "judge";
  const roundFiles = `rounds/${String(row.round).padStart(4, "0")}-${roleLabel}*.md`;
  for (const f of FIELDS) {
    const given = [...new Set(flags[f] ?? [])];
    if (unreadable.has(f) && !given.length)
      return { refusal: `the ${LABELS[f]} line of ${unreadable.get(f).join("; ")} names no class:id key that can be read; give the keys with --${f}, each named by the ruling as class:id, or a further ${roleLabel} call of the round (call.mjs ... ${roleLabel} --step ${roleLabel}-<word>) writes the line` };
    const unnamed = [];
    for (const key of given) {
      const ruled = derived.get(key);
      if (ruled) {
        if (!ruled.set.has(f)) return { refusal: `--${f} ${key}: ${ruled.path} records it under ${[...ruled.set].map(x => LABELS[x]).join(" and ")}, not ${LABELS[f]}; the row takes the ruling's dispositions` };
        continue;
      }
      if (f === "opened" || bound.length || unreadable.has(f)) {
        if (!mine.length) return { refusal: `--${f} ${given.join(",")}: ${where} holds no ${roleLabel} record of round ${row.round}, phase ${row.phase} (${roundFiles}), so no ruling names these blockers` };
        if (!named(key, mine)) unnamed.push(key);
      }
      fields[f].push(key);
    }
    if (unnamed.length)
      return { refusal: `--${f} ${unnamed.join(",")}: not named (by class:id, or by its id) in ${mine.map(r => r.path).join(", ")}; an id alone names a key only while no other class:id of the round claims that id. Copy the keys from the ruling's ${LABELS[f]}: line; when the ruling itself lacks one, a further ${roleLabel} call of the round (call.mjs ... ${roleLabel} --step ${roleLabel}-<word>) names it` };
  }
  return { fields: Object.fromEntries(FIELDS.map(f => [f, [...new Set(fields[f])]])), sources: bound.map(r => r.path), refusal: null };
}
