// D-0016, D-0064, D-0067
import { FEATURE_ID } from "./blueprint.mjs";

export const HANDOFFS = "metrics/handoffs.jsonl";
export const ROLES = ["reviewer", "critic", "actor", "judge"];
export const LEAD_PATCH_ROLE = "lead-patch";
const SHA = /^[0-9a-f]{40}$/;
const LP_ID = /^LP-\d{4,}$/;
const STEP = /^(reviewer|critic|actor|judge)(-[a-z]+)*$/;
const pad = n => String(n).padStart(4, "0");
export const recordOf = (round, step) => `rounds/${pad(round)}-${step}.md`;
export const idOf = (round, step) => `R-${pad(round)}-${step}`;
const relPath = p => typeof p === "string" && p.length > 0 && !p.startsWith("/") && !p.split("/").includes("..");

export function validateLeadPatchHandoff(h) {
  const fail = m => { throw new Error(m); };
  if (!h || typeof h !== "object" || Array.isArray(h)) fail("not an object");
  if (h.role !== LEAD_PATCH_ROLE) fail("role must be lead-patch");
  if (typeof h.id !== "string" || !LP_ID.test(h.id)) fail("id must be LP-NNNN");
  if (h.record !== undefined && h.record !== null) fail("lead-patch must not carry a round record");
  if (typeof h.phase !== "string" || !h.phase.trim() || /[\n\t]/.test(h.phase)) fail("phase must be a one-line name");
  if ("time" in h && (typeof h.time !== "string" || !Number.isFinite(Date.parse(h.time)))) fail("time must be a valid timestamp");
  if (!h.product || typeof h.product !== "object" || Array.isArray(h.product)
      || !SHA.test(h.product.base ?? "") || !SHA.test(h.product.commit ?? "") || h.product.commit === h.product.base)
    fail("product must carry distinct base and commit full SHAs");
  if (!Array.isArray(h.files) || !h.files.length || h.files.length > 3 || !h.files.every(relPath))
    fail("files must be 1..3 relative paths");
  if ("lines" in h) {
    const l = h.lines;
    if (!l || typeof l !== "object" || Array.isArray(l)
        || !Number.isInteger(l.added) || l.added < 0 || !Number.isInteger(l.deleted) || l.deleted < 0
        || !Number.isInteger(l.total) || l.total !== l.added + l.deleted || l.total < 1 || l.total > 20)
      fail("lines must record 1..20 added+deleted lines");
  }
  if (typeof h.reason !== "string" || !h.reason.trim()) fail("reason is missing");
  if (!h.verify || typeof h.verify !== "object" || Array.isArray(h.verify)
      || typeof h.verify.command !== "string" || !h.verify.command.trim() || h.verify.exit !== 0)
    fail("verify must record command and exit 0");
  if (!h.audit || typeof h.audit !== "object" || Array.isArray(h.audit) || h.audit.violations !== 0)
    fail("audit.violations must be 0");
  return h;
}

export function validateHandoff(h) {
  if (h && typeof h === "object" && !Array.isArray(h) && h.role === LEAD_PATCH_ROLE) return validateLeadPatchHandoff(h);
  const fail = m => { throw new Error(m); };
  if (!h || typeof h !== "object" || Array.isArray(h)) fail("not an object");
  if (!Number.isInteger(h.round) || h.round < 1) fail("round must be a whole number from 1");
  if (!STEP.test(h.step ?? "") || !h.step.startsWith(h.role ?? "-") || !ROLES.includes(h.role)) fail("step must start with its role (reviewer, critic, actor, judge)");
  if (h.id !== idOf(h.round, h.step)) fail(`id must be ${idOf(h.round, h.step)}`);
  if (h.record !== recordOf(h.round, h.step)) fail(`record must be ${recordOf(h.round, h.step)}`);
  if (typeof h.phase !== "string" || !h.phase.trim() || /[\n\t]/.test(h.phase)) fail("phase must be a one-line name");
  if (!SHA.test(h.view ?? "")) fail("view must be the full records commit the role read");
  if (!Number.isInteger(h.attempt) || h.attempt < 1) fail("attempt must be a whole number from 1");
  if (!h.agent || typeof h.agent.runner !== "string") fail("agent.runner is missing");
  if (h.product !== null && !(h.product && SHA.test(h.product.base ?? "") && SHA.test(h.product.commit ?? ""))) fail("product must be null or { base, commit } full SHAs");
  if ("features" in h && (!Array.isArray(h.features) || (!h.features.length && h.role !== "reviewer")
      || !h.features.every(id => typeof id === "string" && FEATURE_ID.test(id))))
    fail("features must be a list of F-NNNN IDs (empty only for a reviewer)");
  if (!h.audit || h.audit.violations !== 0) fail("a hand-off exists only for a call whose audit found no violation");
  if (!Array.isArray(h.files) || !h.files.every(relPath) || !h.files.includes(h.record)) fail("files must be relative paths and include the record");
  if ("designConflicts" in h && (h.role !== "actor" || !Array.isArray(h.designConflicts) || h.designConflicts.some(c =>
    !c || !/^design\/[^/]+\.md$/.test(c.path) || !(c.current === null || /^[0-9a-f]{64}$/.test(c.current))
    || !SHA.test(c.changed) || !h.files.includes(c.proposal))))
    fail("designConflicts must name the affected actor design, incumbent and proposal evidence");
  if ("dispatch" in h && (!h.dispatch || typeof h.dispatch !== "object" || Array.isArray(h.dispatch)
      || !/^PL-\d{4}$/.test(h.dispatch.plan ?? "") || !/^[\w.-]+$/.test(h.dispatch.package ?? "")
      || !Array.isArray(h.dispatch.files) || !h.dispatch.files.every(f => typeof f === "string" && f.trim().length > 0)))
    fail("dispatch must name plan PL-NNNN, package id, and files list");
  return h;
}

export function parseHandoffs(text) {
  return text.split("\n").filter(Boolean).map((line, i) => {
    try { return validateHandoff(JSON.parse(line)); } catch (e) { throw new Error(`${HANDOFFS}:${i + 1}: not a valid hand-off (${e.message})`); }
  });
}

export const hasPhaseFrame = (handoffs, phase, hasRecord) =>
  handoffs.some(h => h.role === "reviewer" && h.step === "reviewer-frame" && h.phase === phase && hasRecord(h.record));
