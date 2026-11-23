// The hand-off record `metrics/handoffs.jsonl`: one line per successful role call (`call.mjs`), committed in the same
// commit as every file it names. It states facts about the call (who ran, on what, what it wrote, what the audit found);
// it carries no verdict and decides nothing. A call that failed gets no line, only its numbered evidence.
import { FEATURE_ID } from "./blueprint.mjs";

export const HANDOFFS = "metrics/handoffs.jsonl";
export const ROLES = ["reviewer", "critic", "actor", "judge"];
const SHA = /^[0-9a-f]{40}$/;
const STEP = /^(reviewer|critic|actor|judge)(-[a-z]+)*$/;
const pad = n => String(n).padStart(4, "0");
export const recordOf = (round, step) => `rounds/${pad(round)}-${step}.md`;
export const idOf = (round, step) => `R-${pad(round)}-${step}`;
const relPath = p => typeof p === "string" && p.length > 0 && !p.startsWith("/") && !p.split("/").includes("..");

/** Validate one hand-off line; returns it or throws with the reason. */
export function validateHandoff(h) {
  const fail = m => { throw new Error(m); };
  if (!h || typeof h !== "object") fail("not an object");
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
  return h;
}

/** Hand-offs from the text of the record. A malformed line is an error, never skipped. */
export function parseHandoffs(text) {
  return text.split("\n").filter(Boolean).map((line, i) => {
    try { return validateHandoff(JSON.parse(line)); } catch (e) { throw new Error(`${HANDOFFS}:${i + 1}: not a valid hand-off (${e.message})`); }
  });
}

/** The phase's frame exists when a reviewer-frame hand-off names a record present in the same tree. */
export const hasPhaseFrame = (handoffs, phase, hasRecord) =>
  handoffs.some(h => h.role === "reviewer" && h.step === "reviewer-frame" && h.phase === phase && hasRecord(h.record));
