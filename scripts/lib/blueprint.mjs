// Structured blueprint records and their generated owner view (RECORDS.md).
import { resolve } from "node:path";
import { HANDOFFS, parseHandoffs } from "./handoff.mjs";
import { git, run } from "./git-plumbing.mjs";

export const BLUEPRINT = "BLUEPRINT.md";
export const FEATURE_EVENTS = "metrics/blueprint.jsonl";
export const FEATURE_ID = /^F-\d{4}$/;
export const FEATURE_FILE = /^blueprint\/(F-\d{4})\.md$/;
export const STATUSES = ["planned", "designing", "building", "done", "retired"];

const PURPOSE = /^P-\d{4}$/;
const PURPOSE_FILE = /^purpose\/(P-\d{4})\.md$/;
const DECISION = /^D-\d{4}$/;
const ROUND = /^R-(\d{4})-judge$/;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const HEADER_FIELDS = new Set(["id", "phase", "requirements", "depends", "decisions"]);
const nonempty = value => typeof value === "string" && value.trim().length > 0;
const object = value => value && typeof value === "object" && !Array.isArray(value);
const relativePath = value => nonempty(value) && !/^[A-Za-z]:|[\\\x00-\x1f]/.test(value)
  && value.split("/").every(part => part && part !== "." && part !== "..");
const unquote = text => text.trim().replace(/^`([^`]+)`$/, "$1");
const splitList = value => !value ? [] : value.split(/\s*,\s*/).map(unquote);
const linesOf = text => text.replace(/^\uFEFF/, "").split(/\r?\n/);

export function parsePointer(value) {
  if (typeof value !== "string") return null;
  const match = /^([^#]+)#([^\r\n]+)@([0-9a-f]{7,64})$/.exec(value);
  return match && relativePath(match[1]) && nonempty(match[2]) ? { path: match[1], heading: match[2], commit: match[3] } : null;
}

/** The blueprint's machine-readable header ends at the first body heading. */
export function parseFeature(path, text) {
  const id = FEATURE_FILE.exec(path)?.[1];
  const lines = linesOf(text);
  const title = /^#\s+(F-\d{4})[ \t]+(\S.*)$/.exec(lines[0]?.trimEnd());
  if (!id || title?.[1] !== id) throw new Error("expected a title headed by the feature ID in the filename");
  const fields = new Map(), unknownFields = new Set();
  const end = lines.findIndex((line, index) => index > 0 && /^ {0,3}#{2,6}[ \t]+/.test(line));
  for (const line of lines.slice(1, end < 0 ? undefined : end)) {
    if (!line.trim()) continue;
    const match = /^([\w-]+):[ \t]*(.*)$/.exec(line);
    if (!match) throw new Error("expected a field in the feature header");
    const [, key, value] = match;
    if (key.toLowerCase() === "status") throw new Error("status belongs in metrics/blueprint.jsonl");
    if (!HEADER_FIELDS.has(key)) { unknownFields.add(key); continue; }
    if (fields.has(key)) throw new Error(`duplicate ${key} field`);
    fields.set(key, value.trim());
  }
  const phase = fields.get("phase");
  const requirements = splitList(fields.get("requirements"));
  if (fields.get("id") !== id) throw new Error(`id must be ${id}`);
  if (!phase || !requirements.length) throw new Error("phase and one or more requirements are required");
  return { id, path, title: title[2], phase, requirements, depends: splitList(fields.get("depends")), decisions: splitList(fields.get("decisions")), unknownFields: [...unknownFields], text };
}

function* outsideFences(lines) {
  let fence;
  for (const [i, line] of lines.entries()) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
      continue;
    }
    if (marker) { fence = marker[1]; continue; }
    yield [i, line];
  }
}

export function taskFeatures(text, role) {
  const declarations = [...outsideFences(linesOf(text))].map(([, line]) => /^features:[ \t]*(.*)$/.exec(line)).filter(Boolean);
  if (declarations.length !== 1) throw new Error("task needs one line: features: F-NNNN[, ...] (reviewer may use features: none)");
  const value = declarations[0][1].trim();
  if (value === "none" && role === "reviewer") return [];
  const ids = value.split(",").map(id => id.trim());
  if (!ids.every(id => FEATURE_ID.test(id))) throw new Error("expected features: F-NNNN[, ...] (reviewer may use features: none)");
  return [...new Set(ids)];
}

function headings(lines) {
  const result = [];
  for (const [i, line] of outsideFences(lines)) {
    const atx = /^ {0,3}(#{1,6})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/.exec(line);
    if (atx) { result.push({ title: atx[2], level: atx[1].length, start: i, body: i + 1 }); continue; }
    const setext = /^ {0,3}(=+|-+)[ \t]*$/.exec(line);
    const previous = lines[i - 1]?.trim();
    if (setext && previous && !/^[#>`~]|^[-*+]\s/.test(previous))
      result.push({ title: previous, level: setext[1][0] === "=" ? 1 : 2, start: i - 1, body: i + 1 });
  }
  return result;
}

/** Resolves a literal heading or a Markdown slug, and returns its section through the next peer or parent. */
export function markdownSection(text, heading) {
  const lines = linesOf(text);
  const all = headings(lines);
  const counts = new Map();
  const slugs = all.map(({ title }) => {
    const slug = title.toLowerCase().replace(/[^\p{L}\p{N}\p{M}_ -]/gu, "").replaceAll(" ", "-");
    const count = counts.get(slug) ?? 0;
    counts.set(slug, count + 1);
    return count ? `${slug}-${count}` : slug;
  });
  const literal = all.findIndex(h => h.title === heading);
  const i = literal < 0 ? slugs.indexOf(heading) : literal;
  if (i < 0) return null;
  const h = all[i];
  const end = all.slice(i + 1).find(n => n.level <= h.level)?.start;
  return { title: h.title, body: lines.slice(h.body, end).join("\n").trimEnd(), text: lines.slice(h.start, end).join("\n").trimEnd() };
}

/** Read product documents from Git, using loop.json (whose product path is relative to that config). */
export function productDocuments(repo, has, read, override) {
  let config = {};
  try { if (has("loop.json")) config = JSON.parse(read("loop.json")) ?? {}; } catch { /* there is no usable locator */ }
  const product = override?.product ?? (nonempty(config.product) ? resolve(repo, config.product) : null);
  const tip = override?.tip ?? config.branch ?? "HEAD";
  const commits = new Map(), files = new Map();
  const resolveCommit = ref => {
    if (!commits.has(ref)) {
      let commit = null;
      if (product) try { commit = git(product, "rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`); }
      catch { /* checkout or commit cannot be read */ }
      commits.set(ref, commit);
    }
    return commits.get(ref);
  };
  const at = (path, ref) => {
    const commit = resolveCommit(ref);
    if (!commit || !relativePath(path)) return { status: "unreadable" };
    const key = JSON.stringify([path, commit]);
    if (!files.has(key)) {
      let result;
      try {
        const entry = git(product, "--literal-pathspecs", "ls-tree", "--full-tree", commit, "--", path);
        const blob = /^100(?:644|755) blob ([0-9a-f]+)\t/.exec(entry)?.[1];
        result = blob ? { status: "resolved", text: run("git", ["-C", product, "cat-file", "blob", blob], { encoding: "utf8" }) }
          : { status: "missing" };
      } catch { result = { status: "unreadable" }; }
      files.set(key, result);
    }
    return files.get(key);
  };
  return {
    section(pointer, ref = pointer.commit) {
      const file = at(pointer.path, ref);
      if (file.status !== "resolved") return file;
      const section = markdownSection(file.text, pointer.heading);
      return section ? { ...section, status: "resolved" } : { status: "missing" };
    },
    tip,
  };
}

// The receipt is for the pushed SHA: the commit, or the VERSION-only tip the trajectory row named after it (D-0009 item 2).
function problemWithReceipt(evidence, has, read) {
  if (typeof evidence.commit !== "string" || !SHA.test(evidence.commit)) return "evidence.commit must be a full SHA";
  if ("tip" in evidence && (typeof evidence.tip !== "string" || !SHA.test(evidence.tip))) return "evidence.tip must be a full SHA";
  if (!relativePath(evidence.ci) || !evidence.ci.endsWith(".json") || !has(evidence.ci))
    return "evidence.ci must name an existing records-relative JSON receipt";
  const pushed = evidence.tip ?? evidence.commit;
  let r;
  try { r = JSON.parse(read(evidence.ci)); } catch { return `${evidence.ci} is not a readable CI receipt`; }
  if (r?.sha !== pushed || r.ok !== true || r.ci !== "success" || !nonempty(r.repository) || !Array.isArray(r.missing)
      || r.missing.length !== 0 || !object(r.conclusions) || !Object.keys(r.conclusions).length
      || !Object.entries(r.conclusions).every(([check, verdict]) => /^[^/]+\/.+$/.test(check) && verdict === "success"))
    return `${evidence.ci} is not a green ci-green receipt for ${pushed}`;
  return null;
}

function decisionNames(text, id) {
  return new RegExp(`(?<![\\w-])${id}(?![\\w-])`).test(text);
}

export function addEvent(state, event, { writing = false, line = null } = {}) {
  const { has, read, documents, features, latest, completed, referencedRounds, judgeHandoffs, screening } = state;
  const noteFinding = (rule, detail) => screening.push({ rule: `blueprint-${rule}`, path: FEATURE_EVENTS, detail, ...(line ? { line } : {}) });
  if (!object(event)) throw new Error("expected an event object");
  const { feature, status, time, by, note, evidence } = event;
  if (typeof feature !== "string" || !features.has(feature)) throw new Error(`unknown feature ${feature}`);
  if (!STATUSES.includes(status) || !nonempty(by) || !nonempty(note) || !nonempty(time) || !TIME.test(time) || !Number.isFinite(Date.parse(time))
      || !object(evidence)) throw new Error("expected status, timestamp, by, note and an evidence object");
  if ("phase" in event && (!nonempty(event.phase) || /[\r\n\t]/.test(event.phase))) throw new Error("phase must be a one-line name");
  if (latest.get(feature)?.status === status) throw new Error(`${feature} already has status ${status}`);
  const round = typeof evidence.round === "string" ? ROUND.exec(evidence.round) : null;
  if ("round" in evidence && (!round || !has(`rounds/${round[1]}-judge.md`)))
    throw new Error(`evidence.round must name an existing judge round, got ${evidence.round}`);
  if ("decision" in evidence && (typeof evidence.decision !== "string" || !DECISION.test(evidence.decision)
      || !has(`decisions/${evidence.decision}.md`))) throw new Error(`unknown decision ${evidence.decision}`);
  if (status === "done" || "commit" in evidence || "ci" in evidence || "tip" in evidence) {
    const problem = problemWithReceipt(evidence, has, read);
    if (problem) throw new Error(problem);
  }
  const lastDone = completed.get(feature);
  const reopening = status === "building" && lastDone && !lastDone.reopened;
  const used = referencedRounds.get(feature) ?? new Set();
  if (reopening && (!round || evidence.round === lastDone.round)) throw new Error("reopening a done feature needs a different judge round");
  if (status === "done" && lastDone && round && used.has(evidence.round)) throw new Error("completing a reopened feature needs a judge round it has not previously cited");
  const findings = [];
  if (round && (status === "done" || reopening)) {
    const handoff = judgeHandoffs.get(evidence.round);
    if (!handoff) findings.push(["legacy-round", `${feature} 引用 ${evidence.round}，该裁判轮没有交接记录。`]);
    else {
      if (status === "done" && handoff.product?.base !== evidence.commit)
        throw new Error(`${evidence.round} ruled on ${handoff.product?.base ?? "an unrecorded SHA"}, not ${evidence.commit}`);
      if (handoff.features && !handoff.features.includes(feature))
        throw new Error(`${evidence.round} did not name ${feature}`);
    }
  }
  if ("acceptance" in evidence) {
    const pointer = parsePointer(evidence.acceptance);
    if (status !== "done" || by !== "lead" || round || lastDone)
      throw new Error("a baseline acceptance is for work first recorded as done by the lead and cannot also cite a round");
    const result = pointer && documents.section(pointer);
    if (!result || result.status === "missing" || writing && result.status !== "resolved")
      throw new Error(`unresolved baseline acceptance ${evidence.acceptance}`);
    if (result.status === "unreadable") findings.push(["unverifiable", `${feature} 无法读取基线验收所引提交：${evidence.acceptance}。`]);
  } else if (status === "done" && !round) {
    throw new Error("done needs an existing judge round or baseline acceptance");
  }
  if (status === "retired" && (!evidence.decision || !decisionNames(read(`decisions/${evidence.decision}.md`), feature)))
    throw new Error(`retired needs a decision naming ${feature}`);
  for (const [rule, detail] of findings) noteFinding(rule, detail);
  if (round) { used.add(evidence.round); referencedRounds.set(feature, used); }
  latest.set(feature, event);
  if (status === "done") completed.set(feature, { round: evidence.round, reopened: false });
  if (reopening) lastDone.reopened = true;
}

export function inspectBlueprint(repo, { files, read, product, has, handoffs }) {
  const managed = new Set(files);
  has ??= path => managed.has(path);
  const failures = [], screening = [];
  const features = new Map();
  const purposes = new Map();
  const documents = productDocuments(repo, has, read, product);
  if (!handoffs) try { handoffs = has(HANDOFFS) ? parseHandoffs(read(HANDOFFS)) : []; }
  catch (error) { failures.push({ rule: "handoff", path: HANDOFFS, detail: error.message }); handoffs = []; }
  const judgeHandoffs = new Map(handoffs.filter(h => h.role === "judge").map(h => [h.id, h]));
  const state = { features, purposes, documents, failures, screening, latest: new Map(), completed: new Map(),
    referencedRounds: new Map(), judgeHandoffs, has, read };
  const fail = (path, detail, line) => failures.push({ rule: path === FEATURE_EVENTS ? "feature-event" : "blueprint-feature", path, detail, ...(line ? { line } : {}) });
  for (const path of files) {
    const feature = FEATURE_FILE.exec(path);
    const purpose = PURPOSE_FILE.exec(path);
    if (feature) {
      try { features.set(feature[1], parseFeature(path, read(path))); } catch (e) { fail(path, e.message); }
    }
    if (purpose) {
      const [title, ...lines] = linesOf(read(path));
      const header = lines.join("\n").split(/^ {0,3}#{1,6}[ \t]/m, 1)[0];
      const status = /^status:[ \t]*(.+)$/mi.exec(header)?.[1].trim().toLowerCase();
      const scope = /^scope:[ \t]*(.+)$/mi.exec(header)?.[1].trim().toLowerCase();
      const supersedes = [...header.matchAll(/^supersedes:[ \t]*(.+)$/gmi)].flatMap(m => m[1].split(/[,\s]+/));
      purposes.set(purpose[1], { path, title: title.replace(/^#[ \t]+/, ""), status, scope, supersedes });
    }
  }
  const visiting = new Set();
  const seen = new Set();
  const visit = id => {
    if (visiting.has(id)) { fail(features.get(id).path, `dependency cycle: ${[...visiting, id].join(" → ")}`); return; }
    if (seen.has(id) || !features.has(id)) return;
    visiting.add(id);
    for (const dep of features.get(id).depends) visit(dep);
    visiting.delete(id);
    seen.add(id);
  };
  for (const { id, path, requirements, depends, decisions, unknownFields } of features.values()) {
    for (const field of unknownFields)
      screening.push({ rule: "blueprint-unknown-field", path, detail: `unknown blueprint header field ${field}` });
    for (const ref of requirements) {
      const pointer = parsePointer(ref);
      const result = pointer && documents.section(pointer);
      if (result?.status === "unreadable") screening.push({ rule: "blueprint-unverifiable", path, detail: `无法读取需求所引提交：${ref}。` });
      else if (!(PURPOSE.test(ref) ? has(`purpose/${ref}.md`) : result?.status === "resolved")) fail(path, `unknown requirement ${ref}`);
    }
    for (const dep of depends) if (!features.has(dep)) fail(path, `unknown dependency ${dep}`);
    for (const d of decisions) if (!DECISION.test(d) || !has(`decisions/${d}.md`)) fail(path, `unknown decision ${d}`);
    visit(id);
  }
  if (has(FEATURE_EVENTS)) linesOf(read(FEATURE_EVENTS)).forEach((line, i) => {
    if (!line.trim()) return;
    try { addEvent(state, JSON.parse(line), { line: i + 1 }); } catch (e) { fail(FEATURE_EVENTS, e.message, i + 1); }
  });
  return state;
}

const cell = value => String(value).replaceAll("|", "\\|").replace(/\r?\n/g, " ");
const row = (...values) => `| ${values.map(cell).join(" | ")} |`;
const table = (...headings) => [row(...headings), row(...headings.map(() => "---"))];

export function renderBlueprint({ features, purposes, latest }, alarms, { legacyCount = false } = {}) {
  const requirements = new Map([...purposes].map(([id, p]) => [id, { title: p.title, features: new Set() }]));
  const phases = new Map();
  let countsRetired = false;
  const lines = ["# 产品蓝图", "", "由 `records-check.mjs --write` 生成。", "", "## 顶层需求", ""];
  for (const f of features.values()) for (const ref of f.requirements) {
    if (!requirements.has(ref)) requirements.set(ref, { title: ref, features: new Set() });
    requirements.get(ref).features.add(f.id);
  }
  lines.push(...table("需求", "对应功能"));
  for (const { title, features: ids } of requirements.values()) lines.push(row(title, [...ids].join("、") || "—"));
  lines.push("", "## 全部功能", "", ...table("ID", "标题", "阶段", "状态", "最近证据", "依赖"));
  for (const f of features.values()) {
    const { status = "未记录", evidence = {} } = latest.get(f.id) ?? {};
    const citations = ["round", "acceptance", "decision", "commit", "tip", "ci"].map(key => evidence[key]).filter(Boolean);
    lines.push(row(f.id, f.title, f.phase, status, citations.join("、") || "—", f.depends.join("、") || "—"));
    const phase = phases.get(f.phase) ?? { done: 0, total: 0 };
    phase.total++;
    if (status === "done" || !legacyCount && status === "retired") phase.done++;
    if (!legacyCount && status === "retired") countsRetired = true;
    phases.set(f.phase, phase);
  }
  lines.push("", "## 按阶段统计", "", ...table("阶段", countsRetired ? "已完成或退役 / 总数" : "已完成 / 总数"));
  for (const [phase, { done, total }] of [...phases].sort(([a], [b]) => a.localeCompare(b, "en"))) lines.push(row(phase, `${done} / ${total}`));
  lines.push("", "## 待处理", "", ...(alarms.length ? alarms.map(alarm => `- ${alarm}`) : ["无。"]));
  return `${lines.join("\n")}\n`;
}
