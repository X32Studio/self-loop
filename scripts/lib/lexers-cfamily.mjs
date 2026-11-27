// D-0016, D-0023, D-0064, D-0067, R-0006-judge, design/comment-admission.md#module-map-and-data-flow

export const isSpace = c => c === 32 || c === 9 || c === 10 || c === 13 || c === 11 || c === 12 || c === 0xa0 || c === 0xfeff || c === 0x2028 || c === 0x2029;
export const isDigit = c => c >= 48 && c <= 57;
export const isIdStart = c => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 36 || c === 95 || c >= 128 || c === 92;
export const isIdPart = c => isIdStart(c) || isDigit(c);
export const lineEnd = (src, i, to) => {
  const at = src.indexOf("\n", i);
  return at < 0 || at > to ? to : at;
};
export const escapeEnd = (src, j) => src.charCodeAt(j + 1) === 13 && src.charCodeAt(j + 2) === 10 ? j + 3 : j + 2;
export const quoted = (src, i, to, quote) => {
  for (let j = i + 1; j < to; j++) {
    const c = src.charCodeAt(j);
    if (c === 92) j = escapeEnd(src, j) - 1;
    else if (c === quote) return j + 1;
    else if (c === 10) return j;
  }
  return to;
};
export const spanner = (spans, language) => (start, end, open, close, kind) => spans.push({ start, end, open, close, kind, language });

export function scanHashbang(src, to, push) {
  if (!src.startsWith("#!")) return 0;
  const end = lineEnd(src, 0, to);
  push(0, end, "#!", "", "hashbang");
  return end;
}

export function scanBlockComment(src, i, to, push, nested = false) {
  if (nested) {
    let depth = 1, j = i + 2;
    while (j < to && depth > 0) {
      if (src.startsWith("/*", j)) { depth++; j += 2; }
      else if (src.startsWith("*/", j)) { depth--; j += 2; }
      else j++;
    }
    push(i, j, "/*", depth === 0 ? "*/" : "", "block");
    return j;
  }
  const at = src.indexOf("*/", i + 2);
  const closed = at >= 0 && at + 2 <= to;
  const end = closed ? at + 2 : to;
  push(i, end, "/*", closed ? "*/" : "", "block");
  return end;
}

export function scanLineLiteral(src, i, to, quote) {
  let j = i + 1;
  while (j < to && src.charCodeAt(j) !== quote && src.charCodeAt(j) !== 10) j++;
  return j < to && src.charCodeAt(j) === quote ? j + 1 : j;
}

export function regexEnd(src, i, to) {
  let inClass = false;
  for (let j = i + 1; j < to; j++) {
    const c = src.charCodeAt(j);
    if (c === 10 || c === 13 || c === 0x2028 || c === 0x2029) return -1;
    if (c === 92) j++;
    else if (inClass) { if (c === 93) inClass = false; }
    else if (c === 91) inClass = true;
    else if (c === 47) {
      j++;
      while (j < to && isIdPart(src.charCodeAt(j))) j++;
      return j;
    }
  }
  return -1;
}

export function tripleQuoted(src, i, to, quote, escaped) {
  const mark = quote.repeat(3);
  const q = quote.charCodeAt(0);
  let j = i + 3;
  while (j < to) {
    const c = src.charCodeAt(j);
    if (escaped && c === 92) { j = escapeEnd(src, j); continue; }
    if (c === q && src.startsWith(mark, j)) {
      let run = 3;
      while (j + run < to && src.charCodeAt(j + run) === q) run++;
      return j + Math.min(run, 5);
    }
    j++;
  }
  return to;
}

const SWIFT_REGEX_AFTER = new Set(["return", "case", "in", "where", "if", "guard", "while", "throw", "try", "await", "else", "repeat", "is", "as"]);

export function lexSwift(src) {
  const spans = [];
  const push = spanner(spans, "swift");
  const stack = [{ string: false, parens: 0, interpolation: false }];
  const to = src.length;
  let i = scanHashbang(src, to, push), regex = true;
  while (i < to) {
    const top = stack[stack.length - 1];
    const c = src.charCodeAt(i);
    if (top.string) {
      const hashes = "#".repeat(top.hashes);
      if (c === 92) {
        if (src.startsWith(hashes, i + 1)) {
          const after = i + 1 + top.hashes;
          if (src.charCodeAt(after) === 40) { stack.push({ string: false, parens: 0, interpolation: true }); i = after + 1; regex = true; continue; }
          i = after + 1;
          continue;
        }
        i++;
        continue;
      }
      if (c === 34) {
        const close = (top.multi ? '"""' : '"') + hashes;
        if (src.startsWith(close, i)) { stack.pop(); i += close.length; regex = false; continue; }
        i++;
        continue;
      }
      if (c === 10 && !top.multi) { stack.pop(); regex = false; }
      i++;
      continue;
    }
    if (isSpace(c)) { i++; continue; }
    if (c === 47 && src.charCodeAt(i + 1) === 47) { const end = lineEnd(src, i, to); push(i, end, "//", "", "line"); i = end; continue; }
    if (c === 47 && src.charCodeAt(i + 1) === 42) { i = scanBlockComment(src, i, to, push, true); continue; }
    if (c === 35) {
      let k = i;
      while (src.charCodeAt(k) === 35) k++;
      const count = k - i;
      if (src.charCodeAt(k) === 34) {
        const multi = src.startsWith('"""', k);
        stack.push({ string: true, hashes: count, multi });
        i = k + (multi ? 3 : 1);
        continue;
      }
      if (src.charCodeAt(k) === 47) {
        const close = src.indexOf("/" + "#".repeat(count), k + 1);
        i = close < 0 ? to : close + 1 + count;
        regex = false;
        continue;
      }
      i = k;
      continue;
    }
    if (c === 34) {
      const multi = src.startsWith('"""', i);
      stack.push({ string: true, hashes: 0, multi });
      i += multi ? 3 : 1;
      continue;
    }
    if (c === 47) {
      if (regex && !isSpace(src.charCodeAt(i + 1))) {
        const end = regexEnd(src, i, to);
        if (end > 0) { i = end; regex = false; continue; }
      }
      i++;
      regex = true;
      continue;
    }
    if (c === 40) { top.parens++; i++; regex = true; continue; }
    if (c === 41) {
      if (top.interpolation && top.parens === 0) { stack.pop(); i++; continue; }
      top.parens--;
      i++;
      regex = false;
      continue;
    }
    if (c === 96) { const end = src.indexOf("`", i + 1); i = end < 0 ? to : end + 1; regex = false; continue; }
    if (isIdStart(c) && c !== 92) {
      let j = i + 1;
      while (j < to && isIdPart(src.charCodeAt(j)) && src.charCodeAt(j) !== 92) j++;
      regex = SWIFT_REGEX_AFTER.has(src.slice(i, j));
      i = j;
      continue;
    }
    if (isDigit(c)) {
      let j = i + 1;
      while (j < to && (isIdPart(src.charCodeAt(j)) || src.charCodeAt(j) === 46) && src.charCodeAt(j) !== 92) j++;
      i = j;
      regex = false;
      continue;
    }
    regex = !(c === 93 || c === 125);
    i++;
  }
  return spans;
}

const CPP_RAW_PREFIX = new Set(["R", "u8R", "uR", "UR", "LR"]);
const RUST_RAW_PREFIX = new Set(["r", "br", "cr"]);

function rustCharEnd(src, i, to) {
  if (i + 1 >= to) return -1;
  const next = src.charCodeAt(i + 1);
  if (next === 10 || next === 13 || next === 39) return -1;
  if (next === 92) {
    if (i + 2 >= to) return -1;
    const esc = src.charCodeAt(i + 2);
    if (esc === 10 || esc === 13) return -1;
    let j = i + 3;
    while (j < to && src.charCodeAt(j) !== 39 && src.charCodeAt(j) !== 10 && src.charCodeAt(j) !== 13) j++;
    return j < to && src.charCodeAt(j) === 39 ? j + 1 : -1;
  }
  const step = src.codePointAt(i + 1) > 0xffff ? 2 : 1;
  return i + 1 + step < to && src.charCodeAt(i + 1 + step) === 39 ? i + 2 + step : -1;
}

function quotedMulti(src, i, to, quote) {
  for (let j = i + 1; j < to; j++) {
    const c = src.charCodeAt(j);
    if (c === 92) j = escapeEnd(src, j) - 1;
    else if (c === quote) return j + 1;
  }
  return to;
}

function cppRawEnd(src, i, to) {
  let k = i + 1;
  while (k < to && k - (i + 1) <= 16) {
    const c = src.charCodeAt(k);
    if (c === 40) {
      const close = ")" + src.slice(i + 1, k) + '"';
      const end = src.indexOf(close, k + 1);
      return end < 0 ? to : end + close.length;
    }
    if (c === 41 || c === 92 || isSpace(c)) return -1;
    k++;
  }
  return -1;
}

export function lexCFamily(src, { language, nested = false, backtick = false, tripleQuote = false, rawRust = false, rawCpp = false,
  multiLineQuote = false, rustLifetimes = false, digitSep = false, kotlinTemplates = false, shebang = false }) {
  const spans = [];
  const push = spanner(spans, language);
  const to = src.length;

  function kotlinString(i, multi) {
    const close = multi ? '"""' : '"';
    i += close.length;
    while (i < to) {
      const c = src.charCodeAt(i);
      if (!multi && c === 92) { i = escapeEnd(src, i); continue; }
      if (c === 34 && src.startsWith(close, i)) {
        if (!multi) return i + 1;
        let run = 3;
        while (i + run < to && src.charCodeAt(i + run) === 34) run++;
        return i + Math.min(run, 5);
      }
      if (!multi && c === 10) return i;
      if (c === 36 && src.charCodeAt(i + 1) === 123) {
        const end = scan(i + 2, true);
        i = end < to ? end + 1 : to;
        continue;
      }
      i++;
    }
    return to;
  }

  function scan(i, inBrace) {
    let depth = 0;
    while (i < to) {
      const c = src.charCodeAt(i);
      if (c === 47) {
        const n = src.charCodeAt(i + 1);
        if (n === 47) { const end = lineEnd(src, i, to); push(i, end, "//", "", "line"); i = end; continue; }
        if (n === 42) { i = scanBlockComment(src, i, to, push, nested); continue; }
        i++;
        continue;
      }
      if (c === 34) {
        if (kotlinTemplates) { i = kotlinString(i, src.startsWith('"""', i)); continue; }
        if (tripleQuote && src.startsWith('"""', i)) { i = tripleQuoted(src, i, to, '"', tripleQuote === "escaped"); continue; }
        i = multiLineQuote ? quotedMulti(src, i, to, 34) : quoted(src, i, to, 34);
        continue;
      }
      if (c === 39) {
        if (rustLifetimes) {
          const end = rustCharEnd(src, i, to);
          i = end > 0 ? end : i + 1;
        } else i = quoted(src, i, to, 39);
        continue;
      }
      if (c === 96 && backtick) {
        if (backtick === "multiline") {
          const end = src.indexOf("`", i + 1);
          i = end < 0 ? to : end + 1;
        } else {
          i = scanLineLiteral(src, i, to, 96);
        }
        continue;
      }
      if (isIdStart(c) && c !== 92) {
        let j = i + 1;
        while (j < to && isIdPart(src.charCodeAt(j)) && src.charCodeAt(j) !== 92) j++;
        const word = src.slice(i, j);
        if (rawRust && RUST_RAW_PREFIX.has(word)) {
          let k = j;
          while (k < to && src.charCodeAt(k) === 35) k++;
          if (src.charCodeAt(k) === 34) {
            const close = '"' + "#".repeat(k - j);
            const end = src.indexOf(close, k + 1);
            i = end < 0 ? to : end + close.length;
            continue;
          }
        }
        if (rawCpp && CPP_RAW_PREFIX.has(word) && src.charCodeAt(j) === 34) {
          const end = cppRawEnd(src, j, to);
          if (end > 0) { i = end; continue; }
        }
        i = j;
        continue;
      }
      if (digitSep && isDigit(c)) {
        let j = i + 1;
        while (j < to && (isIdPart(src.charCodeAt(j)) || (src.charCodeAt(j) === 39 && isIdPart(src.charCodeAt(j + 1))))) j++;
        i = j;
        continue;
      }
      if (inBrace) {
        if (c === 123) { depth++; i++; continue; }
        if (c === 125) {
          if (depth === 0) return i;
          depth--;
          i++;
          continue;
        }
      }
      i++;
    }
    return to;
  }

  let i = 0;
  if (shebang && (language === "rust" ? /^#!(?![ \t]*\[)/.test(src) : src.startsWith("#!"))) {
    i = lineEnd(src, 0, to);
    push(0, i, "#!", "", "hashbang");
  }
  scan(i, false);
  return spans;
}

export const lexGo = src => lexCFamily(src, { language: "go", backtick: "multiline" });
export const lexRust = src => lexCFamily(src, { language: "rust", nested: true, rawRust: true, multiLineQuote: true, rustLifetimes: true, shebang: true });
export const lexC = src => lexCFamily(src, { language: "c", rawCpp: true, digitSep: true });
export const lexCpp = src => lexCFamily(src, { language: "cpp", rawCpp: true, digitSep: true });
export const lexJava = src => lexCFamily(src, { language: "java", tripleQuote: "escaped" });
export const lexKotlin = src => lexCFamily(src, { language: "kotlin", nested: true, backtick: "line", kotlinTemplates: true, shebang: true });
