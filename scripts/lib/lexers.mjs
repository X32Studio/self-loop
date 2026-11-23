// D-0016, D-0023, R-0006-judge, design/driver.md#comments

import { createRequire, Module } from "node:module";

let jsParser;
export function establishedJs(src) {
  try {
    if (!jsParser) {
      const source = process.binding("natives")["internal/deps/acorn/acorn/dist/acorn"];
      if (!source) return null;
      const module = new Module("self-loop-acorn");
      module.require = createRequire(import.meta.url);
      module._compile(source, "self-loop-acorn.cjs");
      jsParser = module.exports;
    }
    for (const sourceType of ["module", "script"]) {
      const spans = [];
      try {
        jsParser.parse(src, { ecmaVersion: "latest", sourceType, allowHashBang: true,
          onComment(block, value, start, end) {
            const hashbang = start === 0 && src.startsWith("#!");
            spans.push({ start, end, language: "js", kind: hashbang ? "hashbang" : block ? "block" : "line",
              open: hashbang ? "#!" : block ? "/*" : "//", close: block ? "*/" : "" });
          } });
        return spans;
      } catch {}
    }
  } catch {}
  return null;
}

// D-0016, R-0008-judge-frame
export function lexicalCoverage(src, language, { path = "" } = {}) {
  const ecmascript = language === "js" && !/\.(?:[mc]?ts|tsx|jsx)$/i.test(path);
  const spans = ecmascript ? establishedJs(src) : null;
  return spans === null
    ? { confidence: "unknown", scope: "source", spans: null }
    : { confidence: "established", scope: "source", spans };
}

const isSpace = c => c === 32 || c === 9 || c === 10 || c === 13 || c === 11 || c === 12 || c === 0xa0 || c === 0xfeff || c === 0x2028 || c === 0x2029;
const isDigit = c => c >= 48 && c <= 57;
const isIdStart = c => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 36 || c === 95 || c >= 128 || c === 92;
const isIdPart = c => isIdStart(c) || isDigit(c);
const lineEnd = (src, i, to) => {
  const at = src.indexOf("\n", i);
  return at < 0 || at > to ? to : at;
};
const escapeEnd = (src, j) => src.charCodeAt(j + 1) === 13 && src.charCodeAt(j + 2) === 10 ? j + 3 : j + 2;
const quoted = (src, i, to, quote) => {
  for (let j = i + 1; j < to; j++) {
    const c = src.charCodeAt(j);
    if (c === 92) j = escapeEnd(src, j) - 1;
    else if (c === quote) return j + 1;
    else if (c === 10) return j;
  }
  return to;
};
const spanner = (spans, language) => (start, end, open, close, kind) => spans.push({ start, end, open, close, kind, language });

function regexEnd(src, i, to) {
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

const JS_REGEX_AFTER = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await", "extends", "default"]);
const JS_CONTROL = new Set(["if", "while", "for", "with"]);

export function lexJs(src, from = 0, to = src.length, { jsx = true, language = "js" } = {}) {
  const spans = [];
  const push = spanner(spans, language);
  const lineComment = i => {
    const end = lineEnd(src, i, to);
    push(i, end, "//", "", "line");
    return end;
  };
  const blockComment = i => {
    const at = src.indexOf("*/", i + 2);
    const closed = at >= 0 && at + 2 <= to;
    const end = closed ? at + 2 : to;
    push(i, end, "/*", closed ? "*/" : "", "block");
    return end;
  };
  const trivia = i => {
    while (i < to) {
      const c = src.charCodeAt(i);
      if (isSpace(c)) i++;
      else if (c === 47 && src.charCodeAt(i + 1) === 47) i = lineComment(i);
      else if (c === 47 && src.charCodeAt(i + 1) === 42) i = blockComment(i);
      else break;
    }
    return i;
  };
  const container = i => {
    const end = code(i, true);
    return end < to ? end + 1 : to;
  };

  function template(i) {
    while (i < to) {
      const c = src.charCodeAt(i);
      if (c === 92) i += 2;
      else if (c === 96) return i + 1;
      else if (c === 36 && src.charCodeAt(i + 1) === 123) i = container(i + 2);
      else i++;
    }
    return to;
  }

  function element(i) {
    i = trivia(i + 1);
    if (src.charCodeAt(i) === 62) return children(i + 1);
    while (i < to && (isIdPart(src.charCodeAt(i)) || src[i] === "." || src[i] === ":" || src[i] === "-")) i++;
    while (i < to) {
      i = trivia(i);
      const c = src.charCodeAt(i);
      if (c === 47 && src.charCodeAt(i + 1) === 62) return i + 2;
      if (c === 62) return children(i + 1);
      if (c === 123) i = container(i + 1);
      else if (c === 34 || c === 39) {
        const at = src.indexOf(src[i], i + 1);
        i = at < 0 || at >= to ? to : at + 1;
      } else if (c === 60) i = element(i);
      else i++;
    }
    return to;
  }

  function children(i) {
    while (i < to) {
      const c = src.charCodeAt(i);
      if (c === 123) i = container(i + 1);
      else if (c === 60) {
        const next = trivia(i + 1);
        if (src.charCodeAt(next) === 47) {
          const end = src.indexOf(">", next);
          return end < 0 || end >= to ? to : end + 1;
        }
        i = element(i);
      } else i++;
    }
    return to;
  }

  function code(i, inBraces) {
    const parens = [];
    let regex = true, word = null, member = false, depth = 0;
    const operand = () => { regex = false; word = null; member = false; };
    const punct = () => { regex = true; word = null; member = false; };
    while (i < to) {
      const c = src.charCodeAt(i);
      if (isSpace(c)) { i++; continue; }
      if (c === 47) {
        const n = src.charCodeAt(i + 1);
        if (n === 47) { i = lineComment(i); continue; }
        if (n === 42) { i = blockComment(i); continue; }
        if (regex) {
          const end = regexEnd(src, i, to);
          if (end > 0) { i = end; operand(); continue; }
        }
        i += n === 61 ? 2 : 1;
        punct();
        continue;
      }
      if (c === 39 || c === 34) { i = quoted(src, i, to, c); operand(); continue; }
      if (c === 96) { i = template(i + 1); operand(); continue; }
      if (c === 60 && src.charCodeAt(i + 1) === 60) { i += src.charCodeAt(i + 2) === 61 ? 3 : 2; punct(); continue; }
      if (c === 60 && jsx && regex) {
        let j = i + 1;
        while (j < to && (src.charCodeAt(j) === 32 || src.charCodeAt(j) === 9)) j++;
        const n = src.charCodeAt(j);
        if (n === 62 || (isIdStart(n) && n !== 92)) { i = element(i); operand(); continue; }
      }
      if (isIdStart(c) || c === 35) {
        let j = i + 1;
        while (j < to && isIdPart(src.charCodeAt(j))) j++;
        const name = src.slice(i, j);
        const keyword = !member && c !== 35;
        regex = keyword && JS_REGEX_AFTER.has(name);
        word = keyword ? (name === "await" && word === "for" ? word : name) : null;
        member = false;
        i = j;
        continue;
      }
      if (isDigit(c) || (c === 46 && isDigit(src.charCodeAt(i + 1)))) {
        let j = i + 1;
        while (j < to && (isIdPart(src.charCodeAt(j)) || src.charCodeAt(j) === 46)) j++;
        i = j;
        operand();
        continue;
      }
      if (c === 123) { depth++; i++; punct(); continue; }
      if (c === 125) {
        if (inBraces && depth === 0) return i;
        depth--;
        i++;
        punct();
        continue;
      }
      if (c === 40) { parens.push(word !== null && JS_CONTROL.has(word)); i++; punct(); continue; }
      if (c === 41) { const control = parens.pop(); i++; if (control) punct(); else operand(); continue; }
      if (c === 93) { i++; operand(); continue; }
      if (c === 46) {
        if (src.startsWith("...", i)) { i += 3; punct(); continue; }
        i++;
        regex = false; word = null; member = true;
        continue;
      }
      if ((c === 43 || c === 45) && src.charCodeAt(i + 1) === c) {
        i += 2;
        if (regex) punct(); else operand();
        continue;
      }
      if (c === 33 && !regex && src.charCodeAt(i + 1) !== 61) { i++; continue; }
      i++;
      punct();
    }
    return to;
  }

  let i = from;
  if (from === 0 && src.startsWith("#!")) {
    const end = lineEnd(src, 0, to);
    push(0, end, "#!", "", "hashbang");
    i = end;
  }
  code(i, false);
  return spans;
}

const SWIFT_REGEX_AFTER = new Set(["return", "case", "in", "where", "if", "guard", "while", "throw", "try", "await", "else", "repeat", "is", "as"]);

export function lexSwift(src) {
  const spans = [];
  const push = spanner(spans, "swift");
  const stack = [{ string: false, parens: 0, interpolation: false }];
  const to = src.length;
  let i = 0, regex = true;
  if (src.startsWith("#!")) {
    i = lineEnd(src, 0, to);
    push(0, i, "#!", "", "hashbang");
  }
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
    if (c === 47 && src.charCodeAt(i + 1) === 42) {
      let depth = 1, j = i + 2;
      while (j < to && depth > 0) {
        if (src.startsWith("/*", j)) { depth++; j += 2; }
        else if (src.startsWith("*/", j)) { depth--; j += 2; }
        else j++;
      }
      push(i, j, "/*", depth === 0 ? "*/" : "", "block");
      i = j;
      continue;
    }
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

const SHELL_BREAK = /[\s;&|<>()]/;
const DQUOTE_ESCAPES = new Set(["$", "`", '"', "\\", "\n"]);

function heredocWord(src, i, to) {
  let j = i, delimiter = "";
  while (j < to && !SHELL_BREAK.test(src[j])) {
    const c = src[j];
    const dollar = c === "$" && (src[j + 1] === "'" || src[j + 1] === '"');
    const quote = dollar ? src[j + 1] : c;
    if (quote === "'" && (dollar || c === "'")) {
      let k = j + (dollar ? 2 : 1);
      while (k < to && src[k] !== "'") k += dollar && src[k] === "\\" ? 2 : 1;
      if (k >= to) return null;
      delimiter += src.slice(j + (dollar ? 2 : 1), k);
      j = k + 1;
    } else if (quote === '"' && (dollar || c === '"')) {
      let k = j + (dollar ? 2 : 1);
      while (k < to && src[k] !== '"') {
        if (src[k] === "\\" && DQUOTE_ESCAPES.has(src[k + 1])) k++;
        delimiter += src[k++];
      }
      if (k >= to) return null;
      j = k + 1;
    } else if (c === "\\") {
      if (src[j + 1] !== "\n") delimiter += src[j + 1] ?? "";
      j += 2;
    } else {
      delimiter += c;
      j++;
    }
  }
  return j > i ? { delimiter, end: Math.min(j, to) } : null;
}

export function lexShell(src) {
  const spans = [];
  const push = spanner(spans, "shell");
  const stack = [{ kind: "code", parens: 0 }];
  const pending = [];
  const to = src.length;
  let i = 0, start = true;
  const heredocBodies = at => {
    let j = at;
    for (const { delimiter, strip } of pending.splice(0)) {
      while (j < to) {
        const end = lineEnd(src, j, to);
        const line = src.slice(j, end).replace(/\r$/, "");
        j = end + 1;
        if ((strip ? line.replace(/^\t+/, "") : line) === delimiter) break;
      }
    }
    return Math.min(j, to);
  };
  const skipBackticks = j => {
    const end = src.indexOf("`", j + 1);
    return end < 0 ? to : end + 1;
  };
  if (src.startsWith("#!")) {
    i = lineEnd(src, 0, to);
    push(0, i, "#!", "", "hashbang");
  }
  while (i < to) {
    const top = stack[stack.length - 1];
    const c = src.charCodeAt(i);
    if (top.kind === "dquote" || top.kind === "brace" || top.kind === "arith") {
      if (c === 92) { i += 2; continue; }
      if (top.kind === "dquote" && c === 34) { stack.pop(); i++; start = false; continue; }
      if (top.kind === "brace" && c === 125) { stack.pop(); i++; start = false; continue; }
      if (top.kind === "arith") {
        if (c === 40) { top.parens++; i++; continue; }
        if (c === 41) {
          if (top.parens === 0 && src.charCodeAt(i + 1) === 41) { stack.pop(); i += 2; start = false; continue; }
          top.parens--;
          i++;
          continue;
        }
        if (c === 39) { const end = src.indexOf("'", i + 1); i = end < 0 ? to : end + 1; continue; }
        if (c === 34) { stack.push({ kind: "dquote" }); i++; continue; }
      }
      if (c === 36 && src.charCodeAt(i + 1) === 40 && src.charCodeAt(i + 2) === 40) { stack.push({ kind: "arith", parens: 0 }); i += 3; continue; }
      if (c === 36 && src.charCodeAt(i + 1) === 40) { stack.push({ kind: "code", parens: 0 }); i += 2; start = true; continue; }
      if (c === 36 && src.charCodeAt(i + 1) === 123) { stack.push({ kind: "brace" }); i += 2; continue; }
      if (c === 96) { i = skipBackticks(i); continue; }
      if (top.kind === "brace" && c === 39) { const end = src.indexOf("'", i + 1); i = end < 0 ? to : end + 1; continue; }
      if (top.kind === "brace" && c === 34) { stack.push({ kind: "dquote" }); i++; continue; }
      i++;
      continue;
    }
    if (c === 10) {
      i++;
      if (pending.length) i = heredocBodies(i);
      start = true;
      continue;
    }
    if (c === 32 || c === 9 || c === 13) { i++; start = true; continue; }
    if (c === 35 && start) { const end = lineEnd(src, i, to); push(i, end, "#", "", "line"); i = end; continue; }
    if (c === 92) { i += 2; start = false; continue; }
    if (c === 39) { const end = src.indexOf("'", i + 1); i = end < 0 ? to : end + 1; start = false; continue; }
    if (c === 36 && src.charCodeAt(i + 1) === 39) { i = quoted(src, i + 1, to, 39); start = false; continue; }
    if (c === 34) { stack.push({ kind: "dquote" }); i++; start = false; continue; }
    if (c === 96) { i = skipBackticks(i); start = false; continue; }
    if (c === 36 && src.charCodeAt(i + 1) === 40 && src.charCodeAt(i + 2) === 40) { stack.push({ kind: "arith", parens: 0 }); i += 3; start = false; continue; }
    if (c === 40 && src.charCodeAt(i + 1) === 40 && start) { stack.push({ kind: "arith", parens: 0 }); i += 2; start = false; continue; }
    if (c === 36 && src.charCodeAt(i + 1) === 40) { stack.push({ kind: "code", parens: 0 }); i += 2; start = true; continue; }
    if (c === 36 && src.charCodeAt(i + 1) === 123) { stack.push({ kind: "brace" }); i += 2; start = false; continue; }
    if (c === 40) { top.parens++; i++; start = true; continue; }
    if (c === 41) {
      if (stack.length > 1 && top.parens === 0) stack.pop();
      else top.parens--;
      i++;
      start = true;
      continue;
    }
    if (c === 60 && src.charCodeAt(i + 1) === 60 && src.charCodeAt(i + 2) !== 60) {
      const strip = src.charCodeAt(i + 2) === 45;
      let j = i + (strip ? 3 : 2);
      while (src.charCodeAt(j) === 32 || src.charCodeAt(j) === 9) j++;
      const word = heredocWord(src, j, lineEnd(src, j, to));
      if (word) {
        pending.push({ strip, delimiter: word.delimiter });
        i = word.end;
        start = false;
        continue;
      }
    }
    start = c === 59 || c === 38 || c === 124 || c === 60 || c === 62;
    i++;
  }
  return spans;
}

const leadingSpaces = line => /^ */.exec(line)[0].length;
const YAML_MARKER = /^(?:---|\.\.\.)(?:\s|$)/;

export function lexYaml(src) {
  const spans = [];
  let offset = 0, quote = null, block = null, plain = null, flow = 0;
  let level = "stream", shape = null, documents = 0, pending = [];
  const settle = head => {
    for (const span of pending) span.head = head;
    pending = [];
  };
  const begin = () => {
    if (level !== "stream") return;
    settle(true);
    documents++;
  };
  const content = kind => {
    begin();
    if (level === "complete") settle(false);
    level = "doc";
    if (shape === null) shape = kind;
    else if (kind === "block" && !flow) shape = "block";
  };
  const push = (start, end, own) => {
    const span = { start, end, open: "#", close: "", kind: "line", language: "yaml", head: level === "start" };
    spans.push(span);
    if (own && (level === "stream" || level === "complete")) pending.push(span);
  };
  for (const raw of src.split("\n")) {
    const line = raw.replace(/\r$/, "");
    const at = offset;
    offset += raw.length + 1;
    const indent = leadingSpaces(line);
    const blank = line.trim() === "";
    const marker = !quote && YAML_MARKER.test(line);
    if (block) {
      if (blank) continue;
      if (!marker) {
        if (block.content === null && indent > block.parent) block.content = indent;
        if (block.content !== null && indent >= block.content) continue;
      }
      block = null;
    }
    if (plain) {
      if (blank) continue;
      if (!marker && indent > plain.parent && line[indent] !== "#") {
        const hash = line.search(/\s#/);
        if (hash >= 0) { push(at + hash + 1, at + line.length, false); plain = null; }
        continue;
      }
      plain = null;
    }
    if (level === "doc" && shape === "scalar" && !quote && !flow) level = "complete";
    let j = quote ? 0 : indent, expect = !quote, parent = indent - 1, scalarParent = null, entry = indent, closed = -1, seen = false;
    while (j < line.length) {
      const c = line[j];
      if (quote) {
        seen = true;
        if (quote === '"' && c === "\\") { j += 2; continue; }
        if (c === quote) {
          if (quote === "'" && line[j + 1] === "'") { j += 2; continue; }
          quote = null;
          expect = false;
          closed = j;
        }
        j++;
        continue;
      }
      if (c === " " || c === "\t" || (c === "\ufeff" && at + j === 0)) { j++; continue; }
      if (c === "#" && (j === 0 || /\s/.test(line[j - 1]))) {
        push(at + j, at + line.length, !seen);
        scalarParent = null;
        break;
      }
      if (level === "stream" && c === "%" && j === 0 && !flow) {
        const hash = line.search(/\s#/);
        if (hash >= 0) push(at + hash + 1, at + line.length, true);
        break;
      }
      seen = true;
      const spaced = j + 1 >= line.length || /\s/.test(line[j + 1]);
      if (flow && c === ",") { expect = true; j++; continue; }
      if (flow && (c === "]" || c === "}")) { flow--; expect = false; scalarParent = null; j++; continue; }
      if (expect) {
        if (j === 0 && YAML_MARKER.test(line)) {
          const starts = line[0] === "-";
          settle(starts);
          if (starts) documents++;
          level = starts ? "start" : "stream";
          shape = null;
          j += 3;
          parent = -1;
          continue;
        }
        if ((c === "-" || c === "?") && spaced) { content("block"); parent = j; entry = j + 1; while (line[entry] === " ") entry++; j++; continue; }
        if (c === ":" && spaced) { content("block"); parent = entry; j++; continue; }
        if (c === "&" || c === "!") {
          if (level === "stream" || level === "start") { begin(); level = "start"; }
          while (j < line.length && !/\s/.test(line[j]) && !(flow && /[,\]}]/.test(line[j]))) j++;
          continue;
        }
        if (c === "*") { content("scalar"); while (j < line.length && !/\s/.test(line[j]) && !(flow && /[,\]}]/.test(line[j]))) j++; expect = false; continue; }
        if (c === '"' || c === "'") { content("scalar"); quote = c; j++; continue; }
        if ((c === "|" || c === ">") && !flow) {
          const header = /^[|>]([1-9])?[+-]?([1-9])?(?=\s|$)/.exec(line.slice(j));
          if (header) {
            content("scalar");
            const digit = Number(header[1] ?? header[2] ?? 0);
            block = { parent, content: digit ? Math.max(parent, 0) + digit : null };
            const hash = line.slice(j + header[0].length).search(/(?:^|\s)#/);
            if (hash >= 0) {
              const from = j + header[0].length + hash + (line[j + header[0].length + hash] === "#" ? 0 : 1);
              push(at + from, at + line.length, false);
            }
            break;
          }
        }
        if (c === "[" || c === "{") { content("scalar"); flow++; j++; continue; }
        content("scalar");
        expect = false;
        scalarParent = flow ? null : parent;
        j++;
        continue;
      }
      if (c === ":" && (spaced || closed === j - 1 || (flow && /[,\]}]/.test(line[j + 1] ?? "")))) {
        content("block");
        expect = true;
        parent = entry;
        scalarParent = null;
        j++;
        continue;
      }
      j++;
    }
    if (!quote && !block && !flow && scalarParent !== null && !expect) plain = { parent: scalarParent };
  }
  settle(documents === 0);
  return spans;
}

const PYTHON_PREFIX = /^(?:[rRuUbBfFtT]|[rR][bBfFtT]|[bBfFtT][rR])$/;

export function lexPython(src) {
  const spans = [];
  const push = spanner(spans, "python");
  const to = src.length;

  function string(k, formatted, raw = false) {
    const q = src[k];
    const triple = src.startsWith(q.repeat(3), k);
    const close = triple ? q.repeat(3) : q;
    k += close.length;
    while (k < to) {
      const c = src[k];
      if (c === "\\") {
        if (formatted && !raw && src[k + 1] === "N" && src[k + 2] === "{") {
          const name = src.indexOf("}", k + 3);
          k = name < 0 ? to : name + 1;
        } else if (formatted && (src[k + 1] === "{" || src[k + 1] === "}")) k++;
        else k = escapeEnd(src, k);
        continue;
      }
      if (src.startsWith(close, k)) return k + close.length;
      if (!triple && c === "\n") return k;
      if (formatted && c === "{") {
        if (src[k + 1] === "{") { k += 2; continue; }
        k = field(k + 1);
        continue;
      }
      k++;
    }
    return to;
  }

  function field(k) {
    k = code(k, true);
    if (src[k] === "!") k += 2;
    if (src[k] === ":") {
      k++;
      while (k < to && src[k] !== "}") {
        if (src[k] === "{") k = field(k + 1);
        else if (src[k] === "\\") k += 2;
        else k++;
      }
    }
    return src[k] === "}" ? k + 1 : k;
  }

  function code(k, inField) {
    let depth = 0;
    while (k < to) {
      const c = src[k];
      if (c === "#") { const end = lineEnd(src, k, to); push(k, end, "#", "", "line"); k = end; continue; }
      if (c === "'" || c === '"') { k = string(k, false); continue; }
      const point = src.charCodeAt(k);
      if (isIdStart(point) && point !== 92) {
        let j = k + 1;
        while (j < to && isIdPart(src.charCodeAt(j)) && src.charCodeAt(j) !== 92) j++;
        const word = src.slice(k, j);
        if ((src[j] === "'" || src[j] === '"') && PYTHON_PREFIX.test(word)) { k = string(j, /[fFtT]/.test(word), /[rR]/.test(word)); continue; }
        k = j;
        continue;
      }
      if (inField) {
        if (c === "(" || c === "[" || c === "{") depth++;
        else if (c === ")" || c === "]") depth--;
        else if (c === "}") { if (depth === 0) return k; depth--; }
        else if (depth === 0 && c === ":") return k;
        else if (depth === 0 && c === "!" && src[k + 1] !== "=") return k;
      }
      k++;
    }
    return to;
  }

  let k = 0;
  if (src.startsWith("#!")) {
    k = lineEnd(src, 0, to);
    push(0, k, "#!", "", "hashbang");
  }
  code(k, false);
  return spans;
}

const SQL_IDENTIFIER_PART = /[\w$\u0080-\uffff]/;
const DOLLAR_TAG = /\$(?:[A-Za-z_\u0080-\uffff][\w\u0080-\uffff]*)?\$/y;

function sqlReading(src, { escapes, nested }) {
  const spans = [];
  const push = spanner(spans, "sql");
  const to = src.length;
  let i = 0;
  while (i < to) {
    const c = src[i];
    if (c === "-" && src[i + 1] === "-") { const end = lineEnd(src, i, to); push(i, end, "--", "", "line"); i = end; continue; }
    if (c === "/" && src[i + 1] === "*") {
      let depth = 1, j = i + 2;
      while (j < to && depth > 0) {
        if (nested && src.startsWith("/*", j)) { depth++; j += 2; }
        else if (src.startsWith("*/", j)) { depth--; j += 2; }
        else j++;
      }
      push(i, j, "/*", depth === 0 ? "*/" : "", "block");
      i = j;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      const backslash = c !== "`" && (escapes || (c === "'" && /(?:^|[^\w$])[eE]$/.test(src.slice(Math.max(0, i - 2), i))));
      let j = i + 1;
      while (j < to) {
        if (backslash && src[j] === "\\") { j += 2; continue; }
        if (src[j] === c) { if (src[j + 1] === c) { j += 2; continue; } break; }
        j++;
      }
      i = j + 1;
      continue;
    }
    if (c === "$" && !SQL_IDENTIFIER_PART.test(src[i - 1] ?? "")) {
      DOLLAR_TAG.lastIndex = i;
      const tag = DOLLAR_TAG.exec(src);
      if (tag) {
        const end = src.indexOf(tag[0], i + tag[0].length);
        i = end < 0 ? to : end + tag[0].length;
        continue;
      }
    }
    i++;
  }
  return spans;
}

export const SQL_READINGS = [{ escapes: false, nested: true }, { escapes: false, nested: false }, { escapes: true, nested: false }];

export function lexSql(src) {
  const readings = SQL_READINGS.map(reading => sqlReading(src, reading));
  const [first, ...others] = readings;
  let ranges = first.map(s => [s.start, s.end]);
  for (const reading of others) {
    const next = [];
    let a = 0, b = 0;
    while (a < ranges.length && b < reading.length) {
      const start = Math.max(ranges[a][0], reading[b].start), end = Math.min(ranges[a][1], reading[b].end);
      if (start < end) next.push([start, end]);
      if (ranges[a][1] < reading[b].end) a++; else b++;
    }
    ranges = next;
  }
  const spans = readings.flat();
  return ranges.map(([start, end]) => {
    const opening = spans.find(s => s.start === start), closing = spans.find(s => s.end === end);
    const kind = opening?.kind ?? spans.find(s => s.start <= start && end <= s.end).kind;
    return { start, end, open: opening?.open ?? "", close: closing?.close ?? "", kind, language: "sql" };
  });
}

export function lexCss(src, from = 0, to = src.length) {
  const spans = [];
  const push = spanner(spans, "css");
  let i = from;
  while (i < to) {
    const c = src.charCodeAt(i);
    if (c === 47 && src.charCodeAt(i + 1) === 42) {
      const at = src.indexOf("*/", i + 2);
      const closed = at >= 0 && at + 2 <= to;
      const end = closed ? at + 2 : to;
      push(i, end, "/*", closed ? "*/" : "", "block");
      i = end;
      continue;
    }
    if (c === 34 || c === 39) { i = quoted(src, i, to, c); continue; }
    if ((c === 117 || c === 85) && /^url\(/i.test(src.slice(i, i + 4)) && !/[\w-]/.test(src[i - 1] ?? "")) {
      let j = i + 4;
      while (j < to && /\s/.test(src[j])) j++;
      if (src[j] !== '"' && src[j] !== "'") {
        while (j < to && src[j] !== ")") j += src[j] === "\\" ? 2 : 1;
        i = j + 1;
        continue;
      }
      i = j;
      continue;
    }
    i++;
  }
  return spans;
}

const SCRIPT_TYPES = /^(?:module|(?:text|application)\/(?:x-)?(?:java|ecma)script(?:1\.\d)?|text\/(?:jsx|babel))$/i;
const RAW_TEXT = new Set(["title", "textarea", "xmp", "iframe", "noembed", "noframes", "noscript"]);

export function lexHtml(src) {
  const spans = [];
  const push = spanner(spans, "html");
  const to = src.length;
  let i = 0;
  while (i < to) {
    if (src.startsWith("<!--", i)) {
      const abrupt = /^<!---?>/.exec(src.slice(i, i + 6));
      if (abrupt) {
        push(i, i + abrupt[0].length, "<!--", ">", "block");
        i += abrupt[0].length;
        continue;
      }
      const close = /--!?>/g;
      close.lastIndex = i + 4;
      const found = close.exec(src);
      const end = found ? found.index + found[0].length : to;
      push(i, end, "<!--", found ? found[0] : "", "block");
      i = end;
      continue;
    }
    if (src[i] !== "<") { i++; continue; }
    if (src.startsWith("<![CDATA[", i)) {
      const end = src.indexOf("]]>", i);
      i = end < 0 ? to : end + 3;
      continue;
    }
    if (src[i + 1] === "!" || src[i + 1] === "?") {
      const end = src.indexOf(">", i);
      i = end < 0 ? to : end + 1;
      continue;
    }
    if (!/[A-Za-z/]/.test(src[i + 1] ?? "")) { i++; continue; }
    let j = i + 1, quote = null, equals = false;
    while (j < to) {
      const c = src[j];
      if (quote) { if (c === quote) quote = null; }
      else if (c === ">") break;
      else if (equals && (c === '"' || c === "'")) { quote = c; equals = false; }
      else if (c === "=") equals = true;
      else if (!/\s/.test(c)) equals = false;
      j++;
    }
    const tag = src.slice(i, j + 1);
    i = j + 1;
    const name = /^<([A-Za-z][\w-]*)/.exec(tag)?.[1]?.toLowerCase();
    if (!name || /\/>$/.test(tag)) continue;
    if (name === "plaintext") break;
    if (name !== "script" && name !== "style" && !RAW_TEXT.has(name)) continue;
    const close = new RegExp(`</${name}(?=[\\s/>])`, "i");
    const at = src.slice(i).search(close);
    const end = at < 0 ? to : i + at;
    const type = /\stype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    const declared = type ? (type[1] ?? type[2] ?? type[3]).trim() : "";
    if (name === "style" && (!declared || /^text\/css$/i.test(declared))) spans.push(...lexCss(src, i, end));
    else if (name === "script" && (!declared || SCRIPT_TYPES.test(declared))) spans.push(...lexJs(src, i, end, { jsx: /jsx|babel/i.test(declared) }));
    i = end;
  }
  return spans;
}

export const LEXERS = { js: lexJs, swift: lexSwift, shell: lexShell, yaml: lexYaml, python: lexPython, sql: lexSql, css: lexCss, html: lexHtml };
