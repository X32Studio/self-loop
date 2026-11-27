// D-0064
import { markdownSection, parsePointer } from "./blueprint.mjs";
import { validateRow } from "../trajectory.mjs";

const add = (rule, path, detail) => ({ rule: `blueprint-${rule}`, path, detail });

export function phaseMoveAlarms({ features, latest }) {
  const alarms = [];
  for (const { id, path, phase } of features.values()) {
    const recorded = latest.get(id)?.phase;
    if (recorded && recorded !== phase)
      alarms.push(add("phase-moved", path, `${id} 的最近状态事件属于 ${recorded}，功能表头现为 ${phase}。`));
  }
  return alarms;
}

export function ownerAlarms({ features, purposes, latest }) {
  const served = new Set([...features.values()].filter(f => latest.get(f.id)?.status !== "retired").flatMap(f => f.requirements));
  const superseded = new Set([...purposes.values()].flatMap(p => p.supersedes));
  const alarms = [];
  for (const [id, { path, status, scope }] of purposes)
    if (scope !== "process" && (!status || status === "active") && !superseded.has(id) && !served.has(id))
      alarms.push(add("unserved-purpose", path, `${id} 没有对应的现行功能。`));
  for (const { id, path } of features.values())
    if (!latest.has(id)) alarms.push(add("no-status", path, `${id} 尚未记录状态。`));
  return alarms.concat(phaseMoveAlarms({ features, latest }));
}

function designCitations(text) {
  const body = markdownSection(text, "设计")?.body ?? "";
  const refs = new Set();
  for (const line of body.split("\n")) {
    const bare = line.trim().replace(/^(?:[-*+]|\d+\.)\s+/, "");
    const candidates = [bare, ...[...line.matchAll(/`([^`]+)`|\]\(([^)]+)\)|(?:^|\s)([^\s`<>()[\]]+#[^\s`<>()[\]]+@[0-9a-f]{7,64})(?![0-9a-f])/g)]
      .map(match => match[1] ?? match[2] ?? match[3])];
    for (const ref of candidates) if (parsePointer(ref)) refs.add(ref);
  }
  return refs;
}

const TRAJECTORY = "metrics/trajectory.jsonl";

function recentRounds({ has, read }, handoffs) {
  const byPhase = new Map();
  const addRound = ({ phase, round }) => {
    if (!Number.isInteger(round) || round < 1) return;
    if (!byPhase.has(phase)) byPhase.set(phase, new Set());
    byPhase.get(phase).add(round);
  };
  for (const handoff of handoffs) addRound(handoff);
  if (has(TRAJECTORY)) for (const line of read(TRAJECTORY).split("\n")) {
    if (!line.trim()) continue;
    try { addRound(validateRow(JSON.parse(line))); }
    catch {}
  }
  return new Map([...byPhase].map(([phase, rounds]) => [phase, [...rounds].sort((a, b) => b - a).slice(0, 3)]));
}

export function blueprintAlarms(state, handoffs) {
  const { features, latest, documents } = state;
  const alarms = [...state.screening, ...ownerAlarms(state)];
  if (!features.size) return alarms;
  const rounds = recentRounds(state, handoffs);
  for (const { id, path, phase, depends, text } of features.values()) {
    const status = latest.get(id)?.status;
    const recent = rounds.get(phase) ?? [];
    const named = handoffs.some(h => h.phase === phase && recent.includes(h.round) && Array.isArray(h.features) && h.features.includes(id));
    if (status === "building" && recent.length === 3 && !named)
      alarms.push(add("inactive-building", path, `${id} 在 ${phase} 最近三轮（${recent.join("、")}）的交接记录中未被点名。`));
    for (const ref of designCitations(text)) {
      const pointer = parsePointer(ref);
      const cited = documents.section(pointer);
      const current = documents.section(pointer, documents.tip);
      if (cited.status !== "resolved" || cited.text !== current.text) {
        const detail = cited.status !== "resolved" ? "无法解析引用的章节" : current.status === "resolved" ? "引用的章节已更改" : "当前分支缺少该章节或无法读取";
        alarms.push(add("design-drift", path, `${detail}：${ref}（当前：${documents.tip}）。`));
      }
    }
    if (status === "done") for (const dep of depends)
      if (latest.get(dep)?.status !== "done") alarms.push(add("dependency", path, `${id} 已完成，依赖 ${dep} 尚未完成。`));
  }
  return alarms;
}
