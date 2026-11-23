// P-0006, D-0020, design/dispatch.md#file-ownership
const ANY = [[1, 0x10ffff]];
const SEGMENT = [[1, 46], [48, 0x10ffff]];
const literal = c => [[c.codePointAt(0), c.codePointAt(0)]];
const intersects = (a, b) => a.some(([lo, hi]) => b.some(([x, y]) => lo <= y && x <= hi));

function alternatives(pattern) {
  const start = pattern.indexOf('{');
  if (start < 0) return [pattern];
  let depth = 0, end = -1, at = start + 1;
  const parts = [];
  for (let i = start; i < pattern.length; i++) {
    if (pattern[i] === '{') depth++;
    if (pattern[i] === '}') {
      if (--depth === 0) { parts.push(pattern.slice(at, i)); end = i; break; }
    }
    if (pattern[i] === ',' && depth === 1) { parts.push(pattern.slice(at, i)); at = i + 1; }
  }
  if (end < 0 || parts.length < 2) throw new Error(`invalid brace alternatives: ${pattern}`);
  return parts.flatMap(part => alternatives(pattern.slice(0, start) + part + pattern.slice(end + 1)));
}

function characterClass(source) {
  const negate = /^[!^]/.test(source);
  const chars = Array.from(negate ? source.slice(1) : source);
  const ranges = [];
  for (let i = 0; i < chars.length; i++) {
    const first = chars[i].codePointAt(0);
    const last = chars[i + 1] === '-' && chars[i + 2] ? chars[i += 2].codePointAt(0) : first;
    if (last < first) throw new Error(`invalid character range: [${source}]`);
    ranges.push([first, last]);
  }
  if (!ranges.length) throw new Error('empty glob character class');
  if (!negate) return ranges.flatMap(([a, b]) => SEGMENT.map(([c, d]) => [Math.max(a, c), Math.min(b, d)]).filter(([a, b]) => a <= b));
  return ranges.reduce((out, [lo, hi]) => out.flatMap(([a, b]) => hi < a || lo > b ? [[a, b]]
    : [[a, lo - 1], [hi + 1, b]].filter(([x, y]) => x <= y)), SEGMENT);
}

function compile(pattern) {
  if (typeof pattern !== 'string' || !pattern || pattern.startsWith('/') || pattern.includes('\\')
      || pattern.includes('\0') || pattern.split('/').some(s => s === '..' || s === '.') || pattern.includes('//'))
    throw new Error(`files must be repository-relative paths or globs: ${pattern}`);
  const states = [{ edges: [], eps: [] }];
  const state = () => (states.push({ edges: [], eps: [] }), states.length - 1);
  const edge = (from, to, chars) => states[from].edges.push({ to, chars });
  const end = state();
  for (let source of alternatives(pattern)) {
    if (source.endsWith('/')) source += '**';
    let at = state();
    states[0].eps.push(at);
    const chars = Array.from(source);
    for (let i = 0; i < chars.length; i++) {
      const c = chars[i], next = state();
      if (c === '*') {
        const globstar = chars[i + 1] === '*';
        if (globstar) i++;
        states[at].eps.push(next);
        if (globstar && chars[i + 1] === '/') {
          i++;
          const loop = state();
          states[at].eps.push(loop);
          edge(loop, loop, ANY);
          edge(loop, next, literal('/'));
        } else edge(at, at, globstar ? ANY : SEGMENT);
      } else if (c === '?') edge(at, next, SEGMENT);
      else if (c === '[') {
        const close = chars.indexOf(']', i + 1);
        if (close < 0) throw new Error(`unterminated glob character class: ${pattern}`);
        edge(at, next, characterClass(chars.slice(i + 1, close).join('')));
        i = close;
      } else {
        if ('{}]'.includes(c) || ('!+@'.includes(c) && chars[i + 1] === '(')) throw new Error(`unsupported glob syntax: ${pattern}`);
        edge(at, next, literal(c));
      }
      at = next;
    }
    states[at].eps.push(end);
  }
  return { states, end };
}

export function globOverlap(left, right) {
  const a = compile(left), b = compile(right), seen = new Set(), queue = [[0, 0]];
  while (queue.length) {
    const [x, y] = queue.pop(), key = `${x}:${y}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (x === a.end && y === b.end) return true;
    queue.push(...a.states[x].eps.map(n => [n, y]), ...b.states[y].eps.map(n => [x, n]));
    for (const l of a.states[x].edges) for (const r of b.states[y].edges)
      if (intersects(l.chars, r.chars)) queue.push([l.to, r.to]);
  }
  return false;
}

export function fileOverlap(left, right) {
  for (const a of left) for (const b of right) if (globOverlap(a, b)) return { left: a, right: b };
  return null;
}
