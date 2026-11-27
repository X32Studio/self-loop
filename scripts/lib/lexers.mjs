// D-0016, D-0023, D-0064, D-0067, R-0006-judge, design/comment-admission.md#module-map-and-data-flow

import { createRequire, Module } from "node:module";
import {
  isDigit, isIdPart, isIdStart, isSpace, lineEnd, quoted, regexEnd, scanBlockComment, scanHashbang, spanner,
  lexCFamily, lexC, lexCpp, lexGo, lexJava, lexKotlin, lexRust, lexSwift,
} from "./lexers-cfamily.mjs";
import {
  SQL_READINGS, lexCss, lexHtml as lexHtmlBase, lexPython, lexShell, lexSql, lexToml, lexYaml, sqlReading,
} from "./lexers-extra.mjs";

export {
  lexCFamily, lexC, lexCpp, lexGo, lexJava, lexKotlin, lexRust, lexSwift,
  SQL_READINGS, lexCss, lexPython, lexShell, lexSql, lexToml, lexYaml,
};

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

// D-0016, D-0064, R-0008-judge-frame
function sameSpans(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].start !== b[i].start || a[i].end !== b[i].end || a[i].kind !== b[i].kind
      || a[i].open !== b[i].open || a[i].close !== b[i].close) return false;
  }
  return true;
}

export function lexicalCoverage(src, language, { path = "" } = {}) {
  if (typeof src !== "string" || src.includes("\0")) {
    return { confidence: "unknown", scope: "source", spans: null };
  }
  if (language === "js") {
    const ecmascript = !/\.(?:[mc]?ts|tsx|jsx)$/i.test(path);
    const spans = (ecmascript ? establishedJs(src) : null)
      ?? lexJs(src, 0, src.length, { jsx: !/\.[mc]?ts$/i.test(path) });
    return { confidence: "established", scope: "source", spans };
  }
  if (language === "sql") {
    const readings = SQL_READINGS.map(reading => sqlReading(src, reading));
    return readings.every(reading => sameSpans(readings[0], reading))
      ? { confidence: "established", scope: "source", spans: readings[0] }
      : { confidence: "unknown", scope: "source", spans: null };
  }
  const lexer = LEXERS[language];
  if (!lexer) return { confidence: "unknown", scope: "source", spans: null };
  return { confidence: "established", scope: "source", spans: lexer(src) };
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
  const blockComment = i => scanBlockComment(src, i, to, push, false);
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

  function genericTail(i, angles = 1) {
    while (i < to) {
      i = trivia(i);
      const c = src.charCodeAt(i);
      if (c === 61 && src.charCodeAt(i + 1) === 62) { i += 2; continue; }
      if (c === 60) { angles++; i++; }
      else if (c === 62) { if (--angles === 0) return i + 1; i++; }
      else if (c === 123) i = container(i + 1);
      else if (c === 34 || c === 39) i = quoted(src, i, to, c);
      else if (c === 96) i = template(i + 1);
      else i++;
    }
    return to;
  }

  function element(i) {
    i = trivia(i + 1);
    if (src.charCodeAt(i) === 62) return children(i + 1);
    const start = i;
    while (i < to && (isIdPart(src.charCodeAt(i)) || src[i] === "." || src[i] === ":" || src[i] === "-")) i++;
    const tag = src.slice(start, i);
    i = trivia(i);
    if (tag === "const" && i < to && isIdStart(src.charCodeAt(i)) && src.charCodeAt(i) !== 92) {
      let j = i + 1;
      while (j < to && isIdPart(src.charCodeAt(j))) j++;
      const after = trivia(j);
      const ac = src.charCodeAt(after);
      if (ac === 62) return after + 1;
      if (ac === 61 || ac === 44 || (src.startsWith("extends", after) && !isIdPart(src.charCodeAt(after + 7)))) {
        return genericTail(ac === 61 || ac === 44 ? after + 1 : after);
      }
      i = after;
    }
    const first = src.charCodeAt(i);
    if (first === 61 || first === 44) return genericTail(i + 1);
    if (first === 60) i = genericTail(i + 1);
    while (i < to) {
      i = trivia(i);
      const c = src.charCodeAt(i);
      if (c === 47 && src.charCodeAt(i + 1) === 62) return i + 2;
      if (c === 62) return children(i + 1);
      if (c === 44) return genericTail(i + 1);
      if (c === 61) {
        const next = trivia(i + 1);
        const nc = src.charCodeAt(next);
        if (nc !== 34 && nc !== 39 && nc !== 123 && nc !== 60) return genericTail(next);
        i = next;
        continue;
      }
      if (src.startsWith("extends", i) && !isIdPart(src.charCodeAt(i - 1)) && !isIdPart(src.charCodeAt(i + 7))) {
        const next = trivia(i + 7);
        const nc = src.charCodeAt(next);
        if (nc !== 62 && nc !== 47 && nc !== 61) return genericTail(next);
        i = next;
        continue;
      }
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

  code(from === 0 ? scanHashbang(src, to, push) : from, false);
  return spans;
}

export const lexHtml = (src, options = {}) => lexHtmlBase(src, { lexJs, ...options });

export const LEXERS = {
  js: lexJs, swift: lexSwift, shell: lexShell, yaml: lexYaml, python: lexPython, sql: lexSql, css: lexCss, html: lexHtml,
  go: lexGo, rust: lexRust, c: lexC, cpp: lexCpp, java: lexJava, kotlin: lexKotlin, toml: lexToml,
};
