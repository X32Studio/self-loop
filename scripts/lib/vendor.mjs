// F-0009, D-0016, D-0062, D-0066, D-0068, design/paseo-and-judge-policy.md#1
import { isAntigravityProvider } from "./paseo.mjs";

export const JUDGE_INDEPENDENCE_POLICIES = Object.freeze(["vendor", "model", "session"]);

const MODEL_FAMILY_VENDORS = Object.freeze([
  [/^claude(?:\b|[\d._-])/, "anthropic"],
  [/^(?:gpt(?:\b|[\d._-])|o\d|codex(?:\b|[\d._-]))/, "openai"],
  [/^gemini(?:\b|[\d._-])/, "google"],
  [/^grok(?:\b|[\d._-])/, "xai"],
  [/^qwen(?:\b|[\d._-])/, "alibaba"],
  [/^deepseek(?:\b|[\d._-])/, "deepseek"],
  [/^minimax(?:\b|[\d._-])/, "minimax"],
  [/^glm(?:\b|[\d._-])/, "zhipu"],
  [/^(?:kimi|moonshot)(?:\b|[\d._-])/, "moonshot"],
  [/^llama(?:\b|[\d._-])/, "meta"],
  [/^(?:mistral|mixtral|codestral)(?:\b|[\d._-])/, "mistral"],
]);

export function normalizeModelName(name) {
  const raw = String(name ?? "").trim().toLowerCase();
  if (!raw) return "";
  return raw.includes("/") ? raw.slice(raw.lastIndexOf("/") + 1).trim() : raw;
}

export function validateJudgeIndependence(value) {
  if (value === undefined) return { ok: true, policy: "vendor", error: null };
  if (JUDGE_INDEPENDENCE_POLICIES.includes(value)) return { ok: true, policy: value, error: null };
  return { ok: false, policy: null, error: `invalid judgeIndependence ${JSON.stringify(value)} (expected "vendor", "model", or "session")` };
}

export function validateModelVendors(value) {
  if (value === undefined || value === null) return { ok: true, vendors: null, error: null };
  if (typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, vendors: null, error: "modelVendors must be an object mapping model names or prefixes to non-empty vendor strings" };
  }
  for (const [k, v] of Object.entries(value)) {
    if (!k.trim() || typeof v !== "string" || !v.trim()) {
      return { ok: false, vendors: null, error: `invalid modelVendors entry ${JSON.stringify(k)}: ${JSON.stringify(v)}` };
    }
  }
  return { ok: true, vendors: value, error: null };
}

function lookupCustomVendor(raw, stripped, customVendors) {
  if (!customVendors || typeof customVendors !== "object" || Array.isArray(customVendors)) return null;
  const entries = [];
  for (const [k, v] of Object.entries(customVendors)) {
    const key = String(k ?? "").trim().toLowerCase();
    const val = typeof v === "string" ? v.trim().toLowerCase() : "";
    if (key && val) entries.push([key, val]);
  }
  for (const [key, val] of entries) if (raw === key || stripped === key) return val;
  let bestLen = -1, bestVal = null;
  for (const [key, val] of entries) {
    if ((raw.startsWith(key) || stripped.startsWith(key)) && key.length > bestLen) {
      bestLen = key.length;
      bestVal = val;
    }
  }
  return bestVal;
}

export function vendorOfModel(name, customVendors = null) {
  const raw = String(name ?? "").trim().toLowerCase();
  if (!raw) return null;
  const stripped = normalizeModelName(raw);
  const custom = lookupCustomVendor(raw, stripped, customVendors);
  if (custom) return custom;
  if (!stripped) return null;
  for (const [re, vendor] of MODEL_FAMILY_VENDORS) if (re.test(stripped)) return vendor;
  return null;
}

export function observedModelsOf(agent) {
  if (Array.isArray(agent?.observedModels)) return agent.observedModels.filter(m => typeof m === "string" && m.trim()).map(m => m.trim());
  if (typeof agent?.observedModel === "string" && agent.observedModel.trim()) return [agent.observedModel.trim()];
  return [];
}

const explicitVendorOf = agent => (typeof agent?.vendor === "string" && agent.vendor.trim() ? agent.vendor.trim().toLowerCase() : null);
const sessionOf = agent => (typeof agent?.session === "string" && agent.session.trim() ? agent.session.trim() : null);

function strictObserved(agent, customVendors = null) {
  if (!agent || typeof agent !== "object") return null;
  const explicit = explicitVendorOf(agent);
  if (agent.observedModels !== undefined) {
    if (!Array.isArray(agent.observedModels) || !agent.observedModels.length) return null;
    const normModels = new Set(), vendors = new Set();
    let first = null;
    for (const entry of agent.observedModels) {
      if (typeof entry !== "string" || !entry.trim()) return null;
      const trimmed = entry.trim(), norm = normalizeModelName(trimmed), vendor = vendorOfModel(trimmed, customVendors) ?? explicit;
      if (!vendor || !norm) return null;
      if (first === null) first = trimmed;
      normModels.add(norm);
      vendors.add(vendor);
    }
    return normModels.size === 1 && vendors.size === 1 ? { vendor: [...vendors][0], model: first } : null;
  }
  const raw = agent.observedModel;
  if (typeof raw !== "string" || !raw.trim()) return null;
  const trimmed = raw.trim(), norm = normalizeModelName(trimmed), vendor = vendorOfModel(trimmed, customVendors) ?? explicit;
  return vendor && norm ? { vendor, model: trimmed } : null;
}

const stripPreparedPrefix = runner => typeof runner === "string" ? runner.replace(/^(?:t3|paseo):/, "") : undefined;

const isStrictObservedAgent = agent => {
  const runner = stripPreparedPrefix(agent?.runner);
  return isAntigravityProvider(runner) || isAntigravityProvider(agent?.provider) || agent?.observedModels !== undefined;
};

export function modelVendor(agent, { modelVendors = null } = {}) {
  if (!agent || typeof agent !== "object") return null;
  if (isStrictObservedAgent(agent)) return strictObserved(agent, modelVendors)?.vendor ?? null;
  const runner = stripPreparedPrefix(agent.runner), observed = observedModelsOf(agent), explicit = explicitVendorOf(agent);
  if (observed.length) {
    const vendors = new Set(observed.map(m => vendorOfModel(m, modelVendors) ?? explicit));
    return vendors.size === 1 && !vendors.has(null) ? [...vendors][0] : null;
  }
  const v = typeof agent.model === "string" ? vendorOfModel(agent.model, modelVendors) : null;
  if (v) return v;
  if (explicit) return explicit;
  if (runner === "claude") return "anthropic";
  if (runner === "codex") return "openai";
  return runner || null;
}

export function independenceModel(agent, { modelVendors = null } = {}) {
  if (!agent || typeof agent !== "object") return null;
  if (isStrictObservedAgent(agent) || observedModelsOf(agent).length) return strictObserved(agent, modelVendors)?.model ?? null;
  const raw = agent.model ?? null;
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

function identityForPolicy(agent, policy, opts = {}) {
  if (!agent || typeof agent !== "object") return null;
  if (policy === "session") {
    const session = sessionOf(agent);
    return session ? { session } : null;
  }
  if (policy === "model") return strictObserved(agent, opts?.modelVendors ?? null);
  const vendor = modelVendor(agent, opts), model = independenceModel(agent, opts);
  return vendor && model && normalizeModelName(model) ? { vendor, model } : null;
}

export function judgeIndependenceProblem(judgeAgent, actorAgent, policy = "vendor", opts = {}) {
  const v = validateJudgeIndependence(policy);
  if (!v.ok) return v.error;
  if (v.policy === "session") {
    const j = identityForPolicy(judgeAgent, "session", opts);
    if (!j) return "judge has unknown session";
    const a = identityForPolicy(actorAgent, "session", opts);
    if (!a) return "actor has unknown session";
    if (j.session === a.session) return `same-session judge cannot certify actor (session ${j.session})`;
    return null;
  }
  const j = identityForPolicy(judgeAgent, v.policy, opts);
  if (!j) return "judge has unknown vendor/model";
  const a = identityForPolicy(actorAgent, v.policy, opts);
  if (!a) return "actor has unknown vendor/model";
  if (v.policy === "vendor" && j.vendor === a.vendor) return `same-vendor judge (${j.vendor}/${j.model}) cannot certify actor (${a.vendor}/${a.model})`;
  if (normalizeModelName(j.model) === normalizeModelName(a.model)) return `same-model judge (${j.vendor}/${j.model}) cannot certify actor (${a.vendor}/${a.model})`;
  return null;
}

export function unjudgedCoveringActors({ actors = [], targetCommit, priorConvergedCommits = [], isAncestor, baseline = null }) {
  if (!targetCommit || typeof isAncestor !== "function") return [];
  const covering = actors.filter(a => a?.product?.commit && isAncestor(a.product.commit, targetCommit));
  const activeBaseline = baseline && targetCommit !== baseline && !isAncestor(targetCommit, baseline) ? baseline : null;
  const bounded = activeBaseline ? covering.filter(a => !isAncestor(a.product.commit, activeBaseline)) : covering;
  const priors = [...priorConvergedCommits].filter(c => c && c !== targetCommit && isAncestor(c, targetCommit));
  if (!priors.length) return bounded;
  const unjudged = bounded.filter(a => !priors.some(c => isAncestor(a.product.commit, c)));
  return unjudged.length ? unjudged : bounded;
}

export function waveIndependenceProblem({ judge, actors = [], targetCommit = null, priorConvergedCommits = [], isAncestor = null, policy = "vendor", requireActor = true, baseline = null, modelVendors = null }) {
  const v = validateJudgeIndependence(policy);
  if (!v.ok) return v.error;
  const opts = { modelVendors };
  if (!judge || !identityForPolicy(judge.agent, v.policy, opts)) {
    return `judge ${judge?.id ?? "unknown"} has unknown ${v.policy === "session" ? "session" : "vendor/model"}`;
  }
  const selected = targetCommit && isAncestor ? unjudgedCoveringActors({ actors, targetCommit, priorConvergedCommits, isAncestor, baseline }) : actors;
  if (requireActor && !selected.length) return "no covering actor hand-off";
  for (const actor of selected) {
    const err = judgeIndependenceProblem(judge.agent, actor.agent, v.policy, opts);
    if (err) return `judge ${judge.id} / actor ${actor.id}: ${err}`;
  }
  return null;
}

const PASSING_SUITE = /^[1-9]\d*\/0$/;
export function priorConvergedCommits({ rows = [], judges = [], actors = [], targetCommit, targetRuling = null, targetJudge = null, isAncestor, policy = "vendor", judgeAccepted = null, baseline = null, rulingPolicies = null, modelVendors = null }) {
  const v = validateJudgeIndependence(policy);
  if (!v.ok || !targetCommit || typeof isAncestor !== "function") return [];
  const resolvePolicies = rulingPolicies == null ? () => [v.policy] : rulingPolicies;
  if (typeof resolvePolicies !== "function") return [];
  const excludedCommits = new Set([targetCommit, targetRuling?.commit, targetRuling?.tip].filter(Boolean));
  const candidates = rows
    .filter(r => r.role === "judge" && r.verdict === "CONVERGED" && PASSING_SUITE.test(r.suite ?? "")
      && r !== targetRuling && r.commit && r.commit !== "-" && !excludedCommits.has(r.commit) && !excludedCommits.has(r.tip)
      && r.round <= (targetRuling?.round ?? Infinity) && isAncestor(r.commit, targetCommit))
    .sort((a, b) => a.round - b.round || (a.commit === b.commit ? 0 : isAncestor(a.commit, b.commit) ? -1 : isAncestor(b.commit, a.commit) ? 1 : 0));
  const valid = [];
  for (const pr of candidates) {
    const matching = judges.filter(h =>
      h !== targetJudge && (!targetJudge?.id || h.id !== targetJudge.id) && h.round === pr.round
      && (h.product?.base === pr.commit || h.product?.commit === pr.commit)
      && !excludedCommits.has(h.product?.base) && !excludedCommits.has(h.product?.commit));
    const certified = matching.some(pj => {
      if (judgeAccepted && !judgeAccepted(pj, pr, valid)) return false;
      const pols = resolvePolicies(pr, pj);
      if (!Array.isArray(pols) || !pols.length) return false;
      return pols.every(p => typeof p === "string" && validateJudgeIndependence(p).ok
        && !waveIndependenceProblem({ judge: pj, actors, targetCommit: pr.commit, priorConvergedCommits: valid, isAncestor, policy: p, requireActor: false, baseline, modelVendors }));
    });
    if (certified && !valid.includes(pr.commit)) valid.push(pr.commit);
  }
  return valid;
}
