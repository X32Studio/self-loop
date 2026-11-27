// F-0008, F-0009, F-0015, D-0016, D-0062, D-0066, D-0068, design/paseo-and-judge-policy.md#1

export const PREPARED_RUNNERS = Object.freeze(["t3", "paseo"]);
export const isPreparedRunner = runner => runner === "t3" || runner === "paseo";
export const ANTIGRAVITY_PROVIDERS = Object.freeze(["antigravity", "better-paseo-antigravity"]);
export const isAntigravityProvider = provider => provider === "antigravity" || provider === "better-paseo-antigravity";
export const ADAPTERS = Object.freeze(["antigravity", "claude", "codex", "generic"]);
export const isAdapter = value => typeof value === "string" && ADAPTERS.includes(value);

export function canonicalProvider(provider) {
  if (isAntigravityProvider(provider)) return "antigravity";
  if (provider === "codex" || provider === "claude") return provider;
  return null;
}

export function resolveAdapter(agentOrProvider) {
  if (agentOrProvider && typeof agentOrProvider === "object") {
    if (agentOrProvider.adapter !== undefined && agentOrProvider.adapter !== null) {
      return isAdapter(agentOrProvider.adapter) ? agentOrProvider.adapter : null;
    }
    return resolveAdapter(agentOrProvider.provider);
  }
  if (typeof agentOrProvider !== "string") return null;
  const p = agentOrProvider.trim().toLowerCase();
  if (!p) return null;
  if (p.includes("antigravity")) return "antigravity";
  if (p.includes("claude")) return "claude";
  if (p.includes("codex")) return "codex";
  return "generic";
}

export const PASEO_MCP_TOOL_PREFIX = /^mcp(?:_paseo[-_]|__paseo__)(.+)$/;
export const isPaseoFramed = text => typeof text === "string" && /^<paseo-system(?:[\s>/]|$)/i.test(text.trimStart());

const PASEO_XML_ENTITIES = Object.freeze({
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  "#39": "'",
});

const OPEN_TAG_RE = /^<paseo-system((?:\s+[A-Za-z_:][A-Za-z0-9_.:-]*="[^"]*")*)\s*>/;
const ATTR_RE = /([A-Za-z_:][A-Za-z0-9_.:-]*)="([^"]*)"/g;
const INNER_TAG_RE = /<\/?paseo-system[\s>/]/i;
const CLOSE_TAG = "</paseo-system>";

export function unescapePaseoXml(text) {
  if (typeof text !== "string") return "";
  return text.replace(/&(amp|lt|gt|quot|apos|#39);/g, (_, name) => PASEO_XML_ENTITIES[name]);
}

export function unwrapPaseoAgentMessage(text) {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  const open = OPEN_TAG_RE.exec(trimmed);
  if (!open || !trimmed.endsWith(CLOSE_TAG)) return null;
  const openEnd = open[0].length;
  const closeStart = trimmed.length - CLOSE_TAG.length;
  if (closeStart < openEnd || trimmed.indexOf(CLOSE_TAG, openEnd) !== closeStart) return null;
  const innerRaw = trimmed.slice(openEnd, closeStart);
  if (INNER_TAG_RE.test(innerRaw)) return null;
  const attrs = {};
  for (const [, key, val] of open[1].matchAll(ATTR_RE)) {
    if (key === "kind" && Object.hasOwn(attrs, "kind")) return null;
    Object.defineProperty(attrs, key, { value: val, enumerable: true, writable: true, configurable: true });
  }
  if (attrs.kind !== "agent-message") return null;
  const framed = innerRaw.replace(/^\r?\n/, "").replace(/\r?\n$/, "");
  return { body: unescapePaseoXml(framed), attrs };
}

export function isPaseoSystemEnvelope(text) {
  if (typeof text !== "string") return false;
  let rest = text.trim();
  if (!rest) return false;
  let count = 0;
  while (rest.length > 0) {
    const open = OPEN_TAG_RE.exec(rest);
    if (!open) return false;
    const openEnd = open[0].length;
    const closeIdx = rest.indexOf(CLOSE_TAG, openEnd);
    if (closeIdx === -1 || INNER_TAG_RE.test(rest.slice(openEnd, closeIdx))) return false;
    count++;
    rest = rest.slice(closeIdx + CLOSE_TAG.length).trimStart();
  }
  return count > 0;
}

const CHAT_SUMMARY_OPEN_RE = /^<chat-history-summary(?:\s[^>]*)?>/i;
const CHAT_SUMMARY_CLOSE_RE = /<\/chat-history-summary>/i;
const CHAT_SUMMARY_NESTED_RE = /<chat-history-summary(?:\s|>)/i;

export function stripChatHistorySummary(text) {
  if (typeof text !== "string") return "";
  const leading = text.trimStart();
  const open = CHAT_SUMMARY_OPEN_RE.exec(leading);
  if (!open) return text;
  const afterOpen = leading.slice(open[0].length);
  const close = CHAT_SUMMARY_CLOSE_RE.exec(afterOpen);
  if (!close) return text;
  if (CHAT_SUMMARY_NESTED_RE.test(afterOpen.slice(0, close.index))) return text;
  return afterOpen.slice(close.index + close[0].length).trimStart();
}

export function isChatHistorySummaryEnvelope(text) {
  if (typeof text !== "string") return false;
  const stripped = stripChatHistorySummary(text);
  if (stripped === text) return false;
  const rest = stripped.trim();
  return !rest || isPaseoSystemEnvelope(rest);
}
