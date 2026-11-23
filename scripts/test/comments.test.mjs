import assert from "node:assert/strict";
import test from "node:test";
import { addedProse, commentLines, isPointer, languageOf, LEXERS, proseLines, SQL_READINGS } from "../lib/comments.mjs";

const kinds = (path, text) => commentLines(text, languageOf(path, text), { path }).map(({ line, pieces }) => [line, pieces.map(p => `${p.kind}:${p.text}`).join(" | ")]);
const prose = (path, text) => commentLines(text, languageOf(path, text), { path }).flatMap(({ line, pieces }) => { const words = pieces.filter(p => p.kind === "prose").map(p => p.text); return words.length ? [[line, words.join(" ")]] : []; });

test("languages come from the extension, a .githooks folder, or the interpreter line of an extensionless file", () => {
  const cases = [
    ["a/b.mjs", "", "js"], ["a/b.cjs", "", "js"], ["a/b.ts", "", "js"], ["App.swift", "", "swift"], ["run.sh", "", "shell"],
    [".githooks/pre-push", "", "shell"], ["ci.yml", "", "yaml"], ["tool.py", "", "python"], ["q.sql", "", "sql"],
    ["s.css", "", "css"], ["p.html", "", "html"], ["bin/run", "#!/usr/bin/env node\n", "js"], ["bin/run", "#!/usr/bin/env -S node --x\n", "js"],
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
