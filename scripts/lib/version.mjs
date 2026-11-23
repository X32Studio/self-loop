// `VERSION` (D-0004, D-0015 item 4): SemVer 2.0 without build metadata, `X.Y.Z` (a release, the only kind installed:
// D-0008, the heartbeat's release worktree) or `X.Y.Z-<prerelease>` (a round's candidate pushed to reach real CI, for
// example `0.4.4-v1.5`). Its tag is `v<VERSION>`. Order is SemVer precedence: numeric identifiers compare as numbers,
// others in ASCII order, a numeric identifier sorts before a word, a longer list of equal identifiers is greater, and a
// prerelease sorts before its release (0.4.3 < 0.4.4-v1.5 < 0.4.4-v1.6 < 0.4.4).

const NUMBER = "0|[1-9]\\d*";
const IDENTIFIER = `(?:${NUMBER}|\\d*[A-Za-z-][0-9A-Za-z-]*)`;
const FORM = new RegExp(`^(${NUMBER})\\.(${NUMBER})\\.(${NUMBER})(?:-(${IDENTIFIER}(?:\\.${IDENTIFIER})*))?$`);
export const FORMS = "X.Y.Z or X.Y.Z-<prerelease> (SemVer 2.0, no build metadata)";

/**
 * The parts of a version text (surrounding whitespace ignored): { text, core: [X, Y, Z] as BigInt, pre: identifiers
 * (BigInt when numeric) }, or null when it is no version.
 */
export function parseVersion(value) {
  const text = String(value ?? "").trim();
  const m = FORM.exec(text);
  if (!m) return null;
  return { text, core: m.slice(1, 4).map(BigInt), pre: m[4] === undefined ? [] : m[4].split(".").map(id => (/^\d+$/.test(id) ? BigInt(id) : id)) };
}

/** A release: `X.Y.Z` with no prerelease. */
export const isRelease = version => Boolean(version) && version.pre.length === 0;

const order = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** SemVer precedence of two parsed versions: negative, zero or positive. */
export function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) if (a.core[i] !== b.core[i]) return order(a.core[i], b.core[i]);
  if (!a.pre.length || !b.pre.length) return b.pre.length - a.pre.length; // a release outranks its prereleases
  for (let i = 0; i < Math.min(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i], y = b.pre[i];
    if (x === y) continue;
    const numeric = typeof x === "bigint", other = typeof y === "bigint";
    if (numeric !== other) return numeric ? -1 : 1;
    return order(x, y);
  }
  return a.pre.length - b.pre.length;
}
