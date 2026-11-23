// Model-aware cross-vendor resolution for convergence independence (F-0009, design/antigravity-harness.md#cross-vendor-independence).
// Multi-vendor harnesses such as Antigravity host models from different vendors and can switch mid-conversation;
// vendor and model identity must come from observed transcript evidence, failing closed on empty/unknown observations or vendor switches.

export function vendorOfModel(name) {
  const s = String(name ?? "").trim().toLowerCase();
  if (!s) return null;
  if (/^claude\b/.test(s)) return "anthropic";
  if (/^(?:gpt-|o\d|codex\b)/.test(s)) return "openai";
  if (/^gemini\b/.test(s)) return "google";
  return null;
}

export function observedModelsOf(agent) {
  if (Array.isArray(agent?.observedModels)) return agent.observedModels.filter(Boolean);
  if (agent?.observedModel) return [agent.observedModel];
  return [];
}

export function modelVendor(agent) {
  const runner = agent?.runner?.replace(/^t3:/, "");
  const hasObservedList = Array.isArray(agent?.observedModels);
  const observed = observedModelsOf(agent);

  if (runner === "antigravity" || hasObservedList) {
    if (!observed.length) return null;
    const vendors = new Set(observed.map(vendorOfModel));
    if (vendors.has(null) || vendors.size !== 1) return null;
    return [...vendors][0];
  }
  const models = observed.length ? observed : [agent?.model].filter(Boolean);
  if (models.length) {
    const vendors = new Set(models.map(vendorOfModel));
    if (vendors.size === 1 && !vendors.has(null)) return [...vendors][0];
    if (vendors.size > 1) return null;
  }
  if (runner === "claude") return "anthropic";
  if (runner === "codex") return "openai";
  return runner || null;
}

export function independenceModel(agent) {
  const runner = agent?.runner?.replace(/^t3:/, "");
  const hasObservedList = Array.isArray(agent?.observedModels);
  const observed = observedModelsOf(agent);
  if (runner === "antigravity" || hasObservedList) {
    return observed.length === 1 ? observed[0] : null;
  }
  return agent?.observedModel ?? agent?.model ?? null;
}
