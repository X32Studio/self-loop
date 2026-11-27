import assert from "node:assert/strict";
import test from "node:test";
import { addedProse, commentLines, isPointer, languageOf, LEXERS, proseLines, SQL_READINGS } from "../lib/comments.mjs";

const kinds = (path, text) => commentLines(text, languageOf(path, text), { path }).map(({ line, pieces }) => [line, pieces.map(p => `${p.kind}:${p.text}`).join(" | ")]);
const prose = (path, text) => commentLines(text, languageOf(path, text), { path }).flatMap(({ line, pieces }) => { const words = pieces.filter(p => p.kind === "prose").map(p => p.text); return words.length ? [[line, words.join(" ")]] : []; });

test("languages come from the extension, a .githooks folder, or the interpreter line of an extensionless file", () => {
  const cases = [
    ["a/b.mjs", "", "js"], ["a/b.cjs", "", "js"], ["a/b.ts", "", "js"], ["a/b.tsx", "", "js"], ["a/b.jsx", "", "js"],
    ["a/b.mts", "", "js"], ["a/b.cts", "", "js"], ["App.swift", "", "swift"], ["run.sh", "", "shell"],
    [".githooks/pre-push", "", "shell"], ["ci.yml", "", "yaml"], ["tool.py", "", "python"], ["q.sql", "", "sql"],
    ["s.css", "", "css"], ["p.html", "", "html"], ["main.go", "", "go"], ["lib.rs", "", "rust"],
    ["mod.c", "", "c"], ["mod.h", "", "c"], ["mod.cc", "", "cpp"], ["mod.cpp", "", "cpp"], ["mod.cxx", "", "cpp"], ["mod.hpp", "", "cpp"],
    ["App.java", "", "java"], ["App.kt", "", "kotlin"], ["build.gradle.kts", "", "kotlin"], ["Cargo.toml", "", "toml"],
    ["bin/run", "#!/usr/bin/env node\n", "js"], ["bin/run", "#!/usr/bin/env -S node --x\n", "js"],
    ["bin/run", "#!/bin/bash\n", "shell"], ["bin/run", "#!/usr/bin/python3\n", "python"], ["bin/run", "plain text\n", null],
    ["README.md", "", null], ["data.json", "", null], ["VERSION", "1.0.0\n", null],
  ];
  for (const [path, text, language] of cases) assert.equal(languageOf(path, text), language, path);
});

test("a pointer holds only references and separators; anything else is prose", () => {
  for (const text of ["D-0016", "D-0016, design/driver.md#comments", "self-loop D-0016; ExampleApp D-0052", "R-0006-reviewer-diagnosis, SL-05",
    "W-28b0f5ca46", "docs/calls.md#dispatch", "PR-0012 / T-0003 / B-0001 / I-0001 / L-0005 / F-0010 / P-0003", "example-app:D-0046",
    "(D-0016)", "", "----------", "R-0005-judge"])
    assert.ok(isPointer(text), text);
  for (const text of ["See D-0016", "D-0016 explains this", "design/driver.md", "W-28b0f5ca4", "D-16", "XD-0016", "ExampleApp", "the old endpoint",
    "R-0006-actor-b's fix", "42", "TODO"])
    assert.ok(!isPointer(text), text);
});

test("JavaScript: strings, templates, regular expressions and divisions are not comments", () => {
  const text = [
    "#!/usr/bin/env node",
    'const url = "https://example.test/"; // D-0016',
    "const rx = /[//]x/g, half = a / 2 / b; /* P-0001 */",
    "const t = `${url}// data ${`nested ${1} // more`} /* data */`;",
    "if (ok) /a\\/\\/b/.test(t); // An explanation of the test.",
    "const y = (z) / 2; // Divided by two.",
    "/**",
    " * A block of prose.",
    " * D-0016",
    " */",
    "const s = 'it\\'s // not a comment';",
    "x = a++ / 2; // After a postfix increment.",
    "return /re/.test(s) // after return",
  ].join("\n");
  assert.deepEqual(kinds("x.mjs", text), [
    [1, "directive:#!/usr/bin/env node"], [2, "pointer:D-0016"], [3, "pointer:P-0001"], [5, "prose:An explanation of the test."],
    [6, "prose:Divided by two."], [7, "pointer:"], [8, "prose:A block of prose."], [9, "pointer:D-0016"], [10, "pointer:"],
    [12, "prose:After a postfix increment."], [13, "prose:after return"],
  ]);
});

test("Swift: nested block comments, raw and multi-line strings and interpolation", () => {
  const text = [
    'let a = #"/* raw */ // raw"#',
    'let b = """',
    "  // inside a multi-line string",
    '  \\(value) /* still text */',
    '  """',
    'let c = "\\(f("// in interpolation"))" // Explain c.',
    "/* D-0016",
    "   /* nested prose */",
    "   P-0001 */",
    'let d = ##"a "# // not the end"##',
    "let e = x / y // Divided.",
  ].join("\n");
  assert.deepEqual(prose("A.swift", text), [[6, "Explain c."], [8, "nested prose"], [11, "Divided."]]);
});

test("shell: quoting, parameter expansion, heredocs and words that contain a hash", () => {
  const text = [
    "#!/bin/sh",
    'echo "a # b" \'c # d\' e#f ${x#prefix} $# # Explain the echo.',
    "cat <<'EOF'",
    "# heredoc data",
    "EOF",
    "cat <<-END",
    "\t# tab-stripped heredoc data",
    "\tEND",
    'v=$(printf "%s" "#x") # D-0016',
    "  # An indented prose comment.",
  ].join("\n");
  assert.deepEqual(prose("run.sh", text), [[2, "Explain the echo."], [10, "An indented prose comment."]]);
});

test("YAML: quoted scalars, block scalars and hashes without a space before them", () => {
  const text = [
    "a: \"value # quoted\"",
    "b: 'it''s # quoted'",
    "c: value#plain",
    "d: |",
    "  # block scalar data",
    "  more data",
    "e: value # Explain e.",
    "list:",
    "  - |",
    "    # data in a list item",
    "  - key: >",
    "      # folded data",
    "    other: x # Explain other.",
  ].join("\n");
  assert.deepEqual(prose("c.yml", text), [[7, "Explain e."], [13, "Explain other."]]);
});

test("Python, SQL, CSS and HTML strings hide comment markers", () => {
  assert.deepEqual(prose("t.py", 'x = """\n# text\n"""\ny = r"\\"#" # Explain y.\nz = f\'{a}#\'\n'), [[4, "Explain y."]]);
  assert.deepEqual(prose("q.sql", "SELECT '--x', 'it''s', $$ -- body $$, E'\\' -- y'; -- Explain the query.\n/* A block. */\n"),
    [[1, "Explain the query."], [2, "A block."]]);
  assert.deepEqual(prose("s.css", 'a::after { content: "/* x */"; } /* Explain the rule. */\n'), [[1, "Explain the rule."]]);
  const html = '<div title="<!-- attr -->"></div>\n<script>\nconst s = "<!-- x -->"; // A script comment.\n</script>\n<style>\n/* A style comment. */\n</style>\n<!-- A page comment. -->\n<script type="application/json">{"a": "// b"}</script>\n';
  assert.deepEqual(prose("p.html", html), [[3, "A script comment."], [6, "A style comment."], [8, "A page comment."]]);
});

test("flow: edits and renames require new independent judgments; loss: stale approval", () => {
  const path = "x.mjs", before = "// Keep the default.\nexport const a = 1;\n";
  const resolutions = proseLines(path, before).map(p => ({ ...p, verdict: "directive", evidence: "consumer facts" }));
  assert.deepEqual(addedProse([{ path, before, after: before }], { resolutions }), []);
  assert.deepEqual(addedProse([{ path, before, after: null }]), []);
  for (const after of ["export const z = 0;\n" + before, before.replace("default", "value"), before + "// D-0016\n"]) {
    assert.equal(addedProse([{ path, before, after }], { resolutions })[0].status, "pending");
  }
  assert.equal(addedProse([{ path, before, after: null }, { path: "new.mjs", before: null, after: before }], { resolutions })[0].status, "pending");
});

const comments = (path, text) => commentLines(text, languageOf(path, text), { path }).map(({ line, pieces }) => [line, pieces.map(p => p.raw.trim()).join(" ")]);

test("JSX text and attribute values in a .js file are literal data; comments in tags and expression containers are comments", () => {
  const text = [
    "export function Page({ user }) {",
    "  const label = user ? <b>Welcome back, {user.name} // you're in</b> : null; // A real comment.",
    "  return (",
    "    <main title=\"https://example.test/a // b\" data-x='/* not */'>",
    "      {/* D-0016 */}",
    "      <p>Don't use // or /* in prose */ here.</p>",
    "      <a href=\"http://x.test\">Visit http://x.test/#top</a>",
    "      <><Item value={1 / 2} /* An attribute comment. */ /><Item render={() => <span>it's // fine</span>} /></>",
    "      {list.map(x => (",
    "        // Inside a container.",
    "        <li key={x}>{x} // text</li>",
    "      ))}",
    "    </main>",
    "  );",
    "}",
    "const shift = (1 << 4) <= 16 && a <b; // After a shift.",
  ].join("\n");
  assert.deepEqual(prose("page.js", text), [[2, "A real comment."], [8, "An attribute comment."], [10, "Inside a container."], [16, "After a shift."]]);
  assert.deepEqual(prose("types.ts", "const n = <number>value / 2; // Halved.\nconst m = total! / 2; const s = \"/\" + \"// path\"; // After a non-null assertion.\n"),
    [[1, "Halved."], [2, "After a non-null assertion."]]);
});

test("Python strings: docstrings, prefixes and PEP 701 f-strings with nested quotes, format specs and replacement-field comments", () => {
  const text = [
    "def f():",
    "    \"\"\"A docstring with # inside.\"\"\"",
    "    d = {\"#\": 1}",
    "    a = f\"{d[\"#\"]}\"  # After nested quotes.",
    "    b = f\"{n:#06x}\" + rb'\\#' + t\"{a}#{b}\"",
    "    c = f\"\"\"{a # A replacement-field comment.",
    "    }\"\"\"",
    "    e = f'{x!r:>{w}}'  # After a conversion.",
  ].join("\n");
  assert.deepEqual(prose("a.py", text), [[4, "After nested quotes."], [6, "A replacement-field comment."], [8, "After a conversion."]]);
});

test("YAML scalars after anchors and tags, under standalone or indented block indicators, and plain continuation lines", () => {
  const text = [
    "anchored: &anchor |",
    "  # block data under an anchor",
    "tagged: !!str |",
    "  # block data under a tag",
    "quoted: &a \"x # not a comment\"",
    "single: !tag 'x # not a comment'",
    "list:",
    "  - &item |",
    "    # data in an anchored item",
    "standalone:",
    "  |",
    "  # data under a standalone indicator",
    "explicit: |2",
    "    # deeper data",
    "  # data at the indicated indentation",
    "empty: {}",
    "next: |",
    "  # data after an empty flow mapping",
    "plain: first line",
    "  'second # Explain the plain scalar.",
    "json: {\"a\":\"b # data\", \"c\":'d # data'}",
    "url: http://example.test/#fragment",
    "after: x # Explain after.",
  ].join("\n");
  assert.deepEqual(prose("c.yml", text), [[20, "Explain the plain scalar."], [23, "Explain after."]]);
});

test("shell arithmetic is not a here-document and a here-document body is never a comment", () => {
  const text = "echo $(( 1 << 2 )) # Explain the shift.\nn=1; (( n <<= 3 ))\nx=$((16#ff)) # Explain the base.\ncat <<EOF\n# heredoc data\nEOF\n";
  assert.deepEqual(prose("run.sh", text), [[1, "Explain the shift."], [3, "Explain the base."]]);
});

test("SQL is read in every dialect family: a marker is a comment only where each reading agrees", () => {
  assert.equal(SQL_READINGS.length, 3);
  const text = "INSERT INTO t VALUES ('it\\'s -- data'); -- Explain the insert.\nSELECT E'\\' -- data', $tag$ -- body $tag$; /* outer /* inner */ -- Explain the select.\n";
  assert.deepEqual(prose("q.sql", text), [[1, "Explain the insert."], [2, "outer /* inner Explain the select."]]);
});

test("CSS strings and unquoted url() arguments are literal data", () => {
  assert.deepEqual(prose("s.css", "a { background: url(data:image/svg+xml;utf8,/*x*/); } /* Explain the icon. */\nb::after { content: '/* data */'; }\n"),
    [[1, "Explain the icon."]]);
});

test("HTML text, attribute values, title and textarea text, and script data blocks are literal; script and style bodies are lexed as JavaScript and CSS", () => {
  const html = [
    "<title><!-- not a comment --></title>",
    "<textarea>// data <!-- data --></textarea>",
    "<a title=it's>// text</a> <!--> <!-- A page comment. -->",
    "<script type=\"application/json\">{\"a\": \"// b\"}</script>",
    "<script type=\"module\">const s = \"<!-- x -->\"; // A module comment.</script>",
    "<style>a::after { content: \"/* x */\"; } /* A style comment. */</style>",
    "<p>Don't // stop</p>",
    "<svg><![CDATA[ a > b <!-- data --> ]]></svg>",
  ].join("\n");
  assert.deepEqual(prose("p.html", html), [[3, "A page comment."], [5, "A module comment."], [6, "A style comment."]]);
  assert.deepEqual(comments("p.html", "<!-->\n<!--->\n").map(([line]) => line), [1, 2]);
});

test("a Swift script's interpreter line is a directive, not a comment of prose", () => {
  assert.deepEqual(kinds("main.swift", "#!/usr/bin/env swift\nprint(\"// data\") // Explain the print.\n"),
    [[1, "directive:#!/usr/bin/env swift"], [2, "prose:Explain the print."]]);
});

test("an escaped CRLF continues a JavaScript, CSS or Python string, inline or in an HTML element, and the next line stays literal", () => {
  assert.deepEqual(prose("a.mjs", 'const s = "a \\\r\n// data"; // Explain the label.\r\n'), [[2, "Explain the label."]]);
  assert.deepEqual(prose("a.css", 'b::after { content: "a \\\r\n/* data */"; } /* Explain the badge. */\r\n'), [[2, "Explain the badge."]]);
  assert.deepEqual(prose("a.py", 's = "a \\\r\n# data"  # Explain the label.\r\n'), [[2, "Explain the label."]]);
  assert.deepEqual(prose("p.html", '<script>\r\nconst s = "a \\\r\n// data"; // Explain the script.\r\n</script>\r\n<style>\r\nb { content: "a \\\r\n/* data */"; } /* Explain the style. */\r\n</style>\r\n'),
    [[3, "Explain the script."], [7, "Explain the style."]]);
});

test("a regular expression may follow the head of a for await statement, as after if, while, for and with", () => {
  assert.deepEqual(prose("a.mjs", "async function f(e) {\n  for await (const x of e) /[//]x/.test(x); // Explain the scan.\n  for (const x of e) /\\/\\//.test(x);\n  if (a) /#/.test(b) // Explain the test.\n}\n"),
    [[2, "Explain the scan."], [4, "Explain the test."]]);
});

test("a here-document ends at its delimiter word after quote removal over the whole word", () => {
  const delimiters = [["'END'-NOTES", "END-NOTES"], ['E"N\\"D"x\\ y', 'EN"Dx y'], ["$'Z'", "Z"], ['"A\\$B"', "A$B"], ["\\EOF", "EOF"], ["''", ""]];
  for (const [word, line] of delimiters) {
    const text = `cat <<${word}\nEND\n# body data\n${line}\necho done # Explain the end.\n`;
    assert.deepEqual(prose("run.sh", text), [[5, "Explain the end."]], word);
  }
  assert.deepEqual(prose("run.sh", "cat <<-'X'Y\n\t# body data\n\tXY\n# Explain the tail.\n"), [[4, "Explain the tail."]]);
});

test("a PostgreSQL dollar-quote tag is an identifier without $, letters outside ASCII included; a $ inside an identifier opens none", () => {
  assert.deepEqual(prose("q.sql", "SELECT $café$a\n-- data\n/* data */$café$, $日本$ -- data $日本$; -- Explain the select.\n"), [[3, "Explain the select."]]);
  assert.deepEqual(prose("q.sql", "SELECT café$x$ -- Explain the column.\n, 2 -- Explain the second.\n"), [[1, "Explain the column."], [2, "Explain the second."]]);
});

test("a YAML comment is in a document's header only before that document's content: after directives, ---, ... or a byte order mark", () => {
  const text = "%YAML 1.2\n# a\n---\n# b\na: 1\n...\n# c\n---\nb: 2\n---\n# d\nc: 3\n# e\n---\nd: 4\n";
  assert.deepEqual(LEXERS.yaml(text).map(span => [text.slice(span.start, span.end), span.head]),
    [["# a", true], ["# b", true], ["# c", true], ["# d", true], ["# e", false]]);
  assert.deepEqual(LEXERS.yaml("\ufeff# x\n--- # y\nk: v # z\n").map(span => span.head), [true, true, false]);
});

test("in a Python f-string a backslash never escapes a brace, and \\N{name} is a name only where the string is not raw", () => {
  assert.deepEqual(prose("a.py", 's = rf"\\{{"  # Explain the raw brace.\nt = f"\\N{EM DASH} {1}"  # Explain the dash.\nu = rf"\\N{x}"  # Explain the field.\nv = f"\\{x}"  # Explain the escape.\n'),
    [[1, "Explain the raw brace."], [2, "Explain the dash."], [3, "Explain the field."], [4, "Explain the escape."]]);
});

// D-0016, D-0064
test("TSX generic arrow functions do not swallow subsequent comments", () => {
  const text = [
    "export const id = <T,>(x: T) => <span>{x}</span>; // Explain id.",
    "export const map = <T extends Record<string, () => void>>(x: T) => x; // Explain map.",
    "export const def = <T = string>(x: T) => x; // Explain def.",
  ].join("\n") + "\n";
  assert.deepEqual(prose("generic.tsx", text), [[1, "Explain id."], [2, "Explain map."], [3, "Explain def."]]);
});

test("Go, Rust, C/C++, Java, Kotlin and TOML strings hide comment markers while real comments are detected on exact lines", () => {
  const go = [
    "package main",
    'const a = "https://example.test/a // b"',
    "const b = `line 1",
    "/* raw backtick */ // raw \\",
    "` // Explain Go.",
    "const r = '/' /* Block Go. */",
  ].join("\n") + "\n";
  assert.deepEqual(prose("main.go", go), [[5, "Explain Go."], [6, "Block Go."]]);

  const rust = [
    "#![allow(unused)]",
    "fn f<'a, 'b>(x: &'a str, y: &'static str) -> char {",
    '  let a = r#"raw " // /* not a comment */"#;',
    '  let b = br##"nested "# // still raw"##;',
    '  let c = "multi\n// line";',
    "  let d = '\\''; let e = '/'; let f = '🦀'; // Explain Rust.",
    "  /* D-0016",
    "     /* Nested Rust. */",
    "     P-0001 */",
    "  e",
    "}",
  ].join("\n") + "\n";
  assert.deepEqual(prose("lib.rs", rust), [[7, "Explain Rust."], [9, "Nested Rust."]]);

  const cpp = [
    'const char* a = "http://x // y";',
    'const char* b = R"delim(a )" // raw /* raw */)delim";',
    "int n = 1'000'000; // Explain Cpp.",
    "/* Block Cpp. */",
  ].join("\n") + "\n";
  assert.deepEqual(prose("mod.cpp", cpp), [[3, "Explain Cpp."], [4, "Block Cpp."]]);

  const java = [
    "class App {",
    '  String a = "a // b";',
    '  String b = """',
    '    // inside text block \\"\\"\\"',
    '    /* still text block */',
    '    """; // Explain Java.',
    "}",
  ].join("\n") + "\n";
  assert.deepEqual(prose("App.java", java), [[6, "Explain Java."]]);

  const kotlin = [
    "#!/usr/bin/env kotlin",
    'fun `test // name`() {',
    '  val a = "hello ${foo("// data")}" // Explain Kotlin.',
    '  val b = """raw // """"',
    "  /* D-0016 /* Nested Kotlin. */ */",
    "}",
  ].join("\n") + "\n";
  assert.deepEqual(prose("App.kts", kotlin), [[3, "Explain Kotlin."], [5, "D-0016 /* Nested Kotlin."]]);

  const toml = [
    'title = "app # not a comment"',
    "path = 'C:\\Users\\# not a comment'",
    'escaped = "quote \\" # still string" # Explain TOML.',
    'multi = """',
    '# inside basic \\"\\"\\"',
    '""""" # After five quotes.',
    "raw = '''",
    "\\ # literal",
    "''' # After literal.",
  ].join("\n") + "\n";
  assert.deepEqual(prose("Cargo.toml", toml), [[3, "Explain TOML."], [6, "After five quotes."], [9, "After literal."]]);
});

test("D-0064 T10: zero-comment, pointer-only and directive-only files pass deterministically across all supported languages", () => {
  const clean = [
    ["a.js", 'export const x = "https://example.test";\n'],
    ["a.mjs", "export const x = 1;\n"],
    ["a.cjs", "module.exports = 1;\n"],
    ["a.ts", "export const x: number = 1;\n"],
    ["a.mts", "export type Id = string;\n"],
    ["a.cts", "export type Id = string;\n"],
    ["a.tsx", "export const App = <T,>(p: { x: T }) => <div>{String(p.x)}</div>;\n"],
    ["a.jsx", "export const App = () => <div title=\"// literal\">hi</div>;\n"],
    ["a.py", 'x = "# literal"\n'],
    ["a.pyi", "def f(x: int) -> str: ...\n"],
    ["a.swift", 'let x = #"// literal"#\n'],
    ["a.sh", 'echo "# literal"\n'],
    ["a.yml", 'key: "value # literal"\n'],
    ["a.yaml", "key: value\n"],
    ["a.css", 'a::after { content: "/* literal */"; }\n'],
    ["a.html", "<p>hello</p>\n"],
    ["a.sql", "SELECT 'value -- literal', 1;\n"],
    ["a.go", "package main\nvar s = `// literal`\n"],
    ["a.rs", "#![allow(unused)]\nfn f<'a>(s: &'a str) -> &'a str { s }\n"],
    ["a.c", 'const char *s = "// literal";\n'],
    ["a.h", 'extern const char *s;\n'],
    ["a.cpp", 'auto s = R"(// literal)"; int n = 1\'000;\n'],
    ["a.java", 'class A { String s = "// literal"; }\n'],
    ["a.kt", 'val s = """// literal"""\n'],
    ["a.toml", 'title = "app # literal"\n'],
  ];
  for (const [path, src] of clean) {
    assert.deepEqual(proseLines(path, src), [], `0-comment ${path}`);
    assert.deepEqual(addedProse([{ path, before: null, after: src }]), [], `addedProse ${path}`);
  }

  const pointersAndDirectives = [
    ["a.ts", "// D-0016\n// @ts-expect-error\nexport const x: number = 'a';\n"],
    ["a.py", "# P-0001\nimport os  # noqa\n"],
    ["a.swift", "// D-0016\n// swiftlint:disable:next force_cast\nlet x = y as! Z\n"],
    ["a.yml", "# yaml-language-server: $schema=./schema.json\n# D-0016\nkey: value\n"],
    ["a.sh", "#!/usr/bin/env bash\n# shellcheck disable=SC2086\n# D-0016\necho $x\n"],
    ["a.css", "/* D-0016 */\n/* stylelint-disable */\na {}\n"],
    ["a.html", "<!-- D-0016 -->\n<!-- prettier-ignore -->\n<div></div>\n"],
    ["a.sql", "-- D-0016\nSELECT 1 -- noqa\n;\n"],
    ["a.go", "// SPDX-License-Identifier: MIT\n// D-0016\npackage main\n"],
    ["a.rs", "#!/usr/bin/env -S cargo +nightly -Zscript\n// SPDX-License-Identifier: Apache-2.0\n// D-0016\nfn main() {}\n"],
    ["a.c", "// clang-format off\n// D-0016\nint x = 1;\n"],
    ["a.java", "// SPDX-License-Identifier: MIT\n// D-0016\nclass A {}\n"],
    ["a.kt", "// SPDX-License-Identifier: MIT\n// D-0016\nval x = 1\n"],
    ["a.toml", "# SPDX-License-Identifier: MIT\n# P-0001\ntitle = 'x'\n"],
  ];
  for (const [path, src] of pointersAndDirectives) {
    assert.deepEqual(proseLines(path, src), [], `pointers/directives ${path}`);
  }

  assert.equal(proseLines("a.go", "// @ts-expect-error\npackage main\n")[0].line, 1);
  assert.equal(proseLines("a.toml", "# shellcheck disable=SC2086\ntitle = 'x'\n")[0].line, 1);

  const realProse = [
    ["a.ts", "const x = 1;\n// Explain this.\n", 2, "Explain this."],
    ["a.tsx", "export const A = () => <div/>;\n// Explain this.\n", 2, "Explain this."],
    ["a.py", "x = 1\n# Explain this.\n", 2, "Explain this."],
    ["a.swift", "let x = 1\n// Explain this.\n", 2, "Explain this."],
    ["a.yml", "key: 1\n# Explain this.\n", 2, "Explain this."],
    ["a.sh", "echo 1\n# Explain this.\n", 2, "Explain this."],
    ["a.css", "a {}\n/* Explain this. */\n", 2, "Explain this."],
    ["a.html", "<p>1</p>\n<!-- Explain this. -->\n", 2, "Explain this."],
    ["a.sql", "SELECT 1;\n-- Explain this.\n", 2, "Explain this."],
    ["a.go", "package main\n// Explain this.\n", 2, "Explain this."],
    ["a.rs", "fn main() {}\n// Explain this.\n", 2, "Explain this."],
    ["a.c", "int x = 1;\n// Explain this.\n", 2, "Explain this."],
    ["a.java", "class A {}\n// Explain this.\n", 2, "Explain this."],
    ["a.kt", "val x = 1\n// Explain this.\n", 2, "Explain this."],
    ["a.toml", "a = 1\n# Explain this.\n", 2, "Explain this."],
  ];
  for (const [path, src, line, text] of realProse) {
    const [hit] = proseLines(path, src);
    assert.equal(hit.scope, "comment", path);
    assert.equal(hit.line, line, path);
    assert.equal(hit.text, text, path);
    assert.deepEqual(proseLines(path, src, { resolutions: [{ ...hit, verdict: "directive", evidence: "consumer fact" }] }), [], path);
    assert.deepEqual(proseLines(path, src, { resolutions: [{ ...hit, verdict: "prose", evidence: "explanatory prose" }] }), [{ line, text }], path);
  }
});

test("TSX generic defaults, nested generic types, and const type parameters lex as generics while JSX elements with attributes keep JSX children literal", () => {
  const genericProse = [
    'export type A = <T = "ok">(x: T) => T; // After string default.',
    "export type B = <T = 'a > b'>(x: T) => T; // After single-quoted default.",
    "export type C = <T = { a: number }>(x: T) => T; // After object default.",
    "export type D = <T extends Foo = Bar>(x: T) => T; // After constrained default.",
    'export type E = <T extends { a: string } = { a: "ok" }>(x: T) => T; // After object constraint.',
    "export type F = <T = Record<string, number>>(x: T) => T; // After nested generic.",
    'export type G = <T = <U = "a">(u: U) => U>(x: T) => T; // After generic fn default.',
    "export const h = <const T = string>(x: T) => x; // After const string.",
    'export const i = <const T = "ok">(x: T) => x; // After const literal.',
    "export const j = <const T = { a: number }>(x: T) => x; // After const object.",
    "export const k = <const T extends Foo = Bar>(x: T) => x; // After const extends.",
    "export const l = <const T>(x: T) => x; // After bare const.",
    "export const m = () => <List<string> items={xs} />; // After generic self-closing JSX.",
    "export type N = <T = { /* Explain inside default. */ a: number }>(x: T) => T;",
  ].join("\n") + "\n";
  assert.deepEqual(prose("generic-defaults.tsx", genericProse), [
    [1, "After string default."],
    [2, "After single-quoted default."],
    [3, "After object default."],
    [4, "After constrained default."],
    [5, "After object constraint."],
    [6, "After nested generic."],
    [7, "After generic fn default."],
    [8, "After const string."],
    [9, "After const literal."],
    [10, "After const object."],
    [11, "After const extends."],
    [12, "After bare const."],
    [13, "After generic self-closing JSX."],
    [14, "Explain inside default."],
  ]);

  const jsxControls = [
    'export const V1 = () => <div className="x">// jsx text</div>; // After div.',
    "export const V2 = () => <Card data={{ a: 1 }}>/* jsx text */</Card>; // After Card.",
    'export const V3 = () => <Box title="a = b" subtitle=\'c = d\'>// text = ok</Box>; // After Box.',
    'export const V4 = () => <Box extends="foo">// extends attr text</Box>; // After extends attr.',
    "export const V5 = () => <List<Record<string, number>> items={xs}>// generic jsx text</List>; // After List.",
    "export const V6 = () => <Box>{/* Inside jsx expr. */ 1}</Box>;",
  ].join("\n") + "\n";
  assert.deepEqual(prose("jsx-controls.tsx", jsxControls), [
    [1, "After div."],
    [2, "After Card."],
    [3, "After Box."],
    [4, "After extends attr."],
    [5, "After List."],
    [6, "Inside jsx expr."],
  ]);

  const jsxClean = [
    'export type Clean = <T = "ok">(x: T) => T;',
    'export const View = () => <div className="x"><Card data={{ a: 1 }}><Box title="a = b">// literal text</Box></Card></div>;',
  ].join("\n") + "\n";
  assert.deepEqual(proseLines("clean.tsx", jsxClean), []);
});

// D-0016, D-0064, D-0067
test("Go, C/C++, Java, Kotlin and Rust directives pass only in their consuming language and reject prose or cross-language misuse", async () => {
  const lexers = await import("../lib/lexers.mjs");
  for (const name of [
    "establishedJs", "lexicalCoverage", "lexJs", "lexSwift", "lexCFamily",
    "lexGo", "lexRust", "lexC", "lexCpp", "lexJava", "lexKotlin",
    "lexShell", "lexYaml", "lexPython", "SQL_READINGS", "lexSql", "lexCss", "lexHtml", "lexToml", "LEXERS",
  ]) {
    assert.ok(name in lexers, `missing export ${name}`);
  }
  assert.equal(lexers.lexHtml("<script>\n// inside script\n</script>\n").length, 1);

  const admitted = [
    ["main.go", "//go:build linux && amd64\n// +build linux,amd64\npackage main\n//go:generate stringer -type=Mode\n//go:embed data/*.txt\nvar s string\nfunc f() { _ = s } //nolint:errcheck // D-0016\n"],
    ["mod.c", "// clang-format off\n/* clang-format on */\nint x = 1; // NOLINT(readability-magic-numbers)\n// NOLINTNEXTLINE\nint y = 2;\n"],
    ["mod.cpp", "// NOLINTBEGIN(cppcoreguidelines-*)\nint a = 1; /* NOLINT(bugprone-*) */\n// NOLINTEND(cppcoreguidelines-*)\n// clang-format off\n// clang-format on\n"],
    ["App.java", "// CHECKSTYLE:OFF: MagicNumber\n// checkstyle:off\nint x = 42;\n// checkstyle:on\n// CHECKSTYLE:ON\n// clang-format off\n// clang-format on\n"],
    ["App.kt", "// ktlint-disable no-wildcard-imports\nimport a.*\n// ktlint-enable no-wildcard-imports\n// ktlint-disable standard:max-line-length -- D-0016\n"],
    ["lib.rs", "#!/usr/bin/env -S cargo +nightly -Zscript\n// SPDX-License-Identifier: MIT\n// cspell:ignore rustc\n// rustfmt::skip\nfn main() {}\n"],
  ];
  for (const [path, src] of admitted) {
    assert.deepEqual(proseLines(path, src), [], `admitted ${path}`);
  }

  const refused = [
    ["main.go", "//nolint:errcheck // ignore the error here\npackage main\n", 1],
    ["main.go", "package main\n//go:build linux\n", 2],
    ["main.go", "// NOLINT\npackage main\n", 1],
    ["main.go", "// rustfmt::skip\npackage main\n", 1],
    ["mod.cpp", "// NOLINT because of legacy\nint x = 1;\n", 1],
    ["mod.cpp", "//nolint:errcheck\nint x = 1;\n", 1],
    ["mod.c", "//go:generate foo\nint x = 1;\n", 1],
    ["App.java", "// ktlint-disable no-wildcard-imports\nclass App {}\n", 1],
    ["App.java", "// CHECKSTYLE:OFF because this class is long\nclass App {}\n", 1],
    ["App.kt", "// CHECKSTYLE:OFF\nval x = 1\n", 1],
    ["App.kt", "// ktlint-disable because this line is long\nval x = 1\n", 1],
    ["lib.rs", "// rustfmt::skip keep this aligned\nfn main() {}\n", 1],
    ["lib.rs", "// NOLINT\nfn main() {}\n", 1],
    ["a.mjs", "//go:build linux\nexport {};\n", 1],
  ];
  for (const [path, src, line] of refused) {
    const hits = proseLines(path, src);
    assert.equal(hits.length, 1, `refused ${path}`);
    assert.equal(hits[0].line, line, `line ${path}`);
  }
});
