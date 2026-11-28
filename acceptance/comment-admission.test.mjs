import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { acceptedPatch as accept, admission, refusedPatch } from "./comment-contract-fixture.mjs";
import { jsonOutput, output, status } from "./fixture.mjs";
import { batchDraw, edit, head, loopWorld, phase, prepare, record } from "./loop-world-fixture.mjs";

function reject(w, p, role, files, diagnostics, legacy = {}) {
  const prepared = prepare(w, p, role);
  refusedPatch(w, p, prepared, files, diagnostics, legacy);
  return prepared;
}

test("R6-B3-01 a new actor prose line refuses before committing and a pointer correction can be retried", t => {
  const w = loopWorld(t);
  const p = phase(w);
  const file = "src/new feature.mjs";
  const prose = "Cache the derived answer so the result is reproducible.";
  const prepared = reject(w, p, "actor", { [file]: `export const answer = 42;\n// ${prose}\n` }, [[file, 2, prose]]);
  accept(w, p, prepared, { [file]: "export const answer = 42;\n// D-0016, design/comments.md#pointers\n" });
});

test("R6-B3-02 an edited inline prose comment refuses while unchanged legacy comment text can move with its code", t => {
  const w = loopWorld(t);
  const file = "src/existing.mjs";
  const old = "The legacy caller expects a number.";
  const p = phase(w, "work", { files: { [file]: `export const original = 4; // ${old}\n` } });
  const prose = "The downstream caller expects a string.";
  const prepared = reject(w, p, "actor", { [file]: `export const original = 4; // ${prose}\n` }, [[file, 1, prose]], { [file]: [[1, old]] });
  accept(w, p, prepared, { [file]: `export const interim = 3;\nexport const original = 5; // ${old}\n` }, [[file, 2, old]], { [file]: [[1, old]] });
});

test("R6-B3-03 a critic's new prose block refuses and a reference-only block passes", t => {
  const w = loopWorld(t);
  const p = phase(w);
  const file = "acceptance/example.cjs";
  const prose = "A second explanation would drift after this regression is fixed.";
  const prepared = reject(w, p, "critic", { [file]: `/*\n * ${prose}\n */\nmodule.exports = 1;\n` }, [[file, 2, prose]]);
  accept(w, p, prepared, { [file]: "/*\n * self-loop D-0016; ExampleApp D-0052\n * R-0006-reviewer-diagnosis, SL-05\n */\nmodule.exports = 1;\n" });
});

const directives = JSON.parse(readFileSync(new URL("./fixtures/round6-b-directives.json", import.meta.url), "utf8"));

test("R6-B3-04 exact captured tool directives, source pointers and comment deletions pass", t => {
  const w = loopWorld(t);
  const p = phase(w, "work", { files: {
    "src/old.mjs": "// Historical prose removed at closing.\nexport const today = 1;\n",
    "src/obsolete.py": "# Historical helper removed at closing.\n",
  } });
  const files = Object.fromEntries(directives.map(({ project, path, text }) => {
    const base = path.startsWith(".githooks/") ? path : `src/${project}/${path}`;
    const body = text.endsWith(" node") ? "process.exit(0);" : "exit 0";
    return [base, `${text}\n${body}\n`];
  }));
  Object.assign(files, {
    "src/extensionless-node": "#!/usr/bin/env node\n// docs/calls.md#dispatch\nprocess.exit(0);\n",
    "src/extensionless-sh": "#!/usr/bin/env bash\n# D-0023 / F-0010, W-28b0f5ca46\nexit 0\n",
    "src/old.mjs": "export const today = 1;\n",
    "src/obsolete.py": null,
  });
  accept(w, p, prepare(w, p, "actor"), files);
});

function jsSamples() {
  const draw = batchDraw(42);
  const number = 10 + draw(24);
  return Array.from({ length: number }, (_, i) => {
    const id = `${i}_${draw(10_000)}`;
    return [
      `const url_${id} = "https://example.test/item_${id}";`,
      `const regex_${id} = /[//]item_${id}/;`,
      "const msg_" + id + " = `${url_" + id + "}// literal\n/* ordinary template data */`;",
      `if (url_${id}) /[//]again/.test(msg_${id});`,
    ].join("\n");
  }).join("\n") + "\n";
}

test("R6-B3-05 JavaScript slash sequences and nested template strings pass as code at generated scale", t => {
  const w = loopWorld(t);
  const p = phase(w);
  const sample = jsSamples() + 'const nested = `after ${`https://example.test/${1}`}// template tail`;\n';
  const syntax = spawnSync(process.execPath, ["--check", "--input-type=module"], { input: sample, encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);
  accept(w, p, prepare(w, p, "actor"), { "src/generated.mjs": sample });
});

test("R6-B3-06 real comments after valid JavaScript regexes and inside template expressions still refuse", t => {
  const w = loopWorld(t);
  const p = phase(w);
  const file = "src/interpolated.mjs";
  const prose = "The expression uses the default here.";
  const second = "The string ends before this explanation.";
  const good = ['const rx = /[//]abc/;', 'const template = `${', 'Number(1)', '}`;', 'const url = "https://example.test/";'];
  const bad = good.with(2, `Number(1) // ${prose}`).with(4, `${good[4]} // ${second}`);
  const prepared = reject(w, p, "actor", { [file]: bad.join("\n") + "\n" }, [[file, 3, prose], [file, 5, second]]);
  accept(w, p, prepared, { [file]: good.join("\n") + "\n" });
});

const polyglot = {
  "src/options.yml": 'marker: "value # with hash"\nother: value#without-boundary\n',
  "src/check.sh": 'printf "%s\\n" "an argument # with hash" word#suffix\ncat <<\'TEXT\'\n# here-document data\nTEXT\n',
  "src/Nested.swift": 'let marker = #"/* literal */ // text"#\n/* D-0016\n   /* R-0006-reviewer-diagnosis */\n   P-0001 */\n',
  "src/page.html": '<script>\nconst body = "<!-- text inside script -->";\n</script>\n',
  "src/lookup.sql": "SELECT 'value -- with dashes', '/* literal */';\n",
  "src/style.css": '.icon::after { content: "/* literal */"; }\n',
  "src/tool.py": 'marker = """data\n# triple-quoted text\n"""\n',
};

test("R6-B3-07 quoted hashes, heredocs, Swift nesting and HTML script string markers pass", t => {
  const w = loopWorld(t);
  const p = phase(w);
  accept(w, p, prepare(w, p, "actor"), polyglot);
});

test("R6-B3-08 real comments next to polyglot strings and after a nested Swift block still refuse", t => {
  const w = loopWorld(t);
  const p = phase(w);
  const prose = {
    "src/options.yml": "# Explain the deployment marker.",
    "src/check.sh": "# Explain the previous shell command.",
    "src/Nested.swift": "   Explain why the enclosing Swift block stayed. */",
    "src/page.html": "<!-- Explain the rendered page. -->",
    "src/lookup.sql": "-- Explain the preceding SQL selection.",
    "src/style.css": "/* Explain the generated icon. */",
    "src/tool.py": "# Explain the Python marker.",
  };
  const bad = Object.fromEntries(Object.entries(polyglot).map(([file, value]) => [
    file, (file.endsWith(".swift") ? value.replace(/   P-0001 \*\/\n$/, "") : value) + prose[file] + "\n",
  ]));
  const diagnostics = Object.entries(bad).map(([file, value]) => [
    file, value.split("\n").length - 1, prose[file].trim().replace(/^(#|--|\/\*|<!--) /, "").replace(/ (?:\*\/|-->)$/, ""),
  ]);
  const prepared = reject(w, p, "actor", bad, diagnostics);
  accept(w, p, prepared, polyglot);
});

test("R6-B3-12 extensionless node and shell files enforce the same policy as files with extensions", t => {
  const w = loopWorld(t);
  const p = phase(w);
  const js = "src/rebuild";
  const sh = "src/check";
  const hook = ".githooks/pre-push";
  const files = {
    [js]: "#!/usr/bin/env node\n// Explain the rebuild policy.\nprocess.exitCode = 0;\n",
    [sh]: "#!/usr/bin/env bash\n# Explain the validation policy.\nexit 0\n",
    [hook]: "#!/bin/sh\n# Explain the push policy.\nexit 0\n",
  };
  const diagnostics = Object.entries(files).map(([file, text]) => [file, 2, text.split("\n")[1].replace(/^(?:#|\/\/) /, "")]);
  const prepared = reject(w, p, "actor", files, diagnostics);
  accept(w, p, prepared, {
    [js]: "#!/usr/bin/env node\n// D-0016\nprocess.exitCode = 0;\n",
    [sh]: "#!/usr/bin/env bash\n# D-0016\nexit 0\n",
    [hook]: "#!/bin/sh\n# D-0016\nexit 0\n",
  });
});

test("R6-B3-13 copying a legacy prose line creates a new comment even when its text already exists", t => {
  const w = loopWorld(t);
  const file = "src/config.mjs";
  const prose = "Clients use the default timeout.";
  const original = `// ${prose}\nexport const defaultTimeout = 30;\n`;
  const p = phase(w, "work", { files: { [file]: original } });
  const added = "export const fallbackTimeout = 60;\n";
  const prepared = reject(w, p, "actor", {
    [file]: original + `\n// ${prose}\n` + added,
  }, [[file, 4, prose]], { [file]: [[1, prose]] });
  accept(w, p, prepared, { [file]: original + "\n" + added }, [[file, 1, prose]], { [file]: [[1, prose]] });
});

test("R6-B3-14 fresh · flow: valid TSX generic defaults (<T = \"ok\">, <T = { a: number }>) cannot switch the lexer into JSX children and hide trailing prose comments · loss: false-verdict", t => {
  const w = loopWorld(t), p = phase(w), file = "src/Component.tsx";
  const good = 'export type Handler = <T = "ok">(x: T) => T;\nexport type BoxFn = <T = { a: number }>(x: T) => T;\nexport const View = () => <div>{"// literal text"}</div>;\n';
  const bad = 'export type Handler = <T = "ok">(x: T) => T;\n// Explain why the guard was bypassed.\nexport const View = () => <div>ok</div>;\n';
  const prepared = reject(w, p, "actor", { [file]: bad }, [[file, 2, "Explain why the guard was bypassed."]]);
  accept(w, p, prepared, { [file]: good });
});

test("R6-B3-15 fresh · flow: Go, C/C++, Rust, Java, and Kotlin literals, lifetimes, digit separators, and nested Rust blocks pass while trailing prose refuses · loss: false-verdict", t => {
  const w = loopWorld(t), p = phase(w);
  const clean = {
    "src/main.go": "package main\nfunc main() { _ = `// literal /* inside raw */` }\n",
    "src/main.cpp": 'int n = 1\'000;\nconst char* s = R"(// raw C++ string)";\n',
    "src/lib.rs": "/* D-0016\n   /* R-0053-critic-vfive-full */\n   D-0068 */\npub fn f<'a>(s: &'a str) -> &'a str { let _r = r#\"// literal\"#; s }\n",
    "src/Main.java": 'class Main { String s = """\n// text block\n"""; }\n',
    "src/Main.kt": 'fun main() { val n = 1; println("// $n /* keep */"); }\n',
  };
  const prose = {
    "src/main.go": "// Explain Go raw string behavior.",
    "src/main.cpp": "// Explain C++ digit separator.",
    "src/lib.rs": "// Explain Rust lifetime parameter.",
    "src/Main.java": "// Explain Java text block literal.",
    "src/Main.kt": "// Explain Kotlin string template.",
  };
  const bad = Object.fromEntries(Object.entries(clean).map(([f, v]) => [f, v + prose[f] + "\n"]));
  const diags = Object.entries(bad).map(([f, v]) => [f, v.split("\n").length - 1, prose[f].slice(3)]);
  const prepared = reject(w, p, "actor", bad, diags);
  accept(w, p, prepared, clean);
});

const draw = batchDraw(74);
const number = 10 + draw(80);
const rows = Array.from({ length: 12 + draw(22) }, (_, i) => `row_${i}: feed-${number}#revision-${draw(9_999)}`);

const literals = [
  ["01", "JavaScript string with an escaped Windows line ending", "message.mjs",
    'export const label = "Revision ' + number + ' \\\r\n// in the printed label";\r\n', "//"],
  ["02", "JavaScript template segments and interpolation", "message.mjs",
    'export const message = `Revision ${String(' + number + ')}\n// literal owner text\n/* literal footer */`;\n', "//"],
  ["03", "JavaScript regex as a for-await loop body", "events.mjs",
    "export async function scan(events) {\n  for await (const item of events) /[//]revision" + number + "/.test(item);\n}\n", "//"],
  ["04", "shell here-document with a partly quoted delimiter", "release.sh",
    "#!/usr/bin/env bash\ncat <<'END'-NOTES\nEND\n# Release notes for revision " + number + "\nEND-NOTES\n", "#"],
  ["05", "plain YAML scalars with adjacent hash characters at generated scale", "defaults.yml",
    rows.join("\n") + "\n", "#"],
  ["06", "single- and double-quoted YAML scalars following anchors and tags", "labels.yaml",
    `short: &short "Revision # ${number}"\nlong: !!str 'Release ''candidate'' # ${number}'\n`, "#"],
  ["07", "YAML block scalar following an anchor", "contents.yaml",
    `notice: &notice |2-\n  # Release ${number}\n  Ship after verification.\npreview: *notice\n`, "#"],
  ["08", "Python module docstring with a rendered heading", "tool.py",
    `"""Generate release notes.\n\n# Revision ${number}\n"""\nrevision = ${number}\n`, "#"],
  ["09", "Python 3.12 f-string with quote reuse in a subscript", "labels.py",
    `record = {"revision # display": ${number}}\nlabel = f"{record["revision # display"]}"\n`, "#"],
  ["10", "PostgreSQL string with a localized dollar-quote tag", "labels.sql",
    `SELECT 'Version -- in SQL text', $café$Revision ${number}\n-- User-visible heading\n/* Literal divider */$café$;\n`, "--"],
  ["11", "CSS string with an escaped Windows line ending", "labels.css",
    '.badge::after { content: "Revision ' + number + ' \\\r\n/* in the content */"; }\r\n', "/*", " */"],
  ["12", "HTML textarea and title text", "editor.html",
    `<!doctype html>\n<title>Revision <!-- label --> ${number}</title>\n<textarea><!-- Editable template --></textarea>\n`, "<!--", " -->"],
  ["13", "HTML quoted attribute values", "editor.html",
    `<!doctype html>\n<input value="Revision ${number}: <!-- literal -->" data-note='<!-- default -->'>\n`, "<!--", " -->"],
  ["14", "JavaScript literals in an HTML script element", "script.html",
    '<!doctype html>\r\n<script type="module">\r\nconst label = "Revision ' + number + ' \\\r\n// in the label";\r\n</script>\r\n', "//", "", "</script>"],
  ["15", "CSS literals in an HTML style element", "style.html",
    '<!doctype html>\r\n<style>\r\n.badge::before { content: "Revision ' + number + ' \\\r\n/* in the content */"; }\r\n</style>\r\n', "/*", " */", "</style>"],
];

for (const [id, title, name, source, marker, end = "", closingTag] of literals) {
  test(`R7-B4-${id} ${title} can land and a nearby prose comment cannot`, t => {
    const { w, p, prepared } = admission(t);
    const file = "src/" + name;
    const phrase = "Explain the default shipped in this release.";
    const comment = `${marker} ${phrase}${end}`;
    const eol = source.includes("\r\n") ? "\r\n" : "\n";
    const offset = closingTag ? source.lastIndexOf(closingTag) : source.length;
    const negative = source.slice(0, offset) + comment + eol + source.slice(offset);
    const line = source.slice(0, offset).split("\n").length;
    refusedPatch(w, p, prepared, { [file]: negative }, [file, line, phrase]);
    accept(w, p, prepared, { [file]: source });
  });
}

test("R9-C-fastpass-01 fresh · flow: D-0064 T10 deterministic 0-comment, pointer-only, and directive-only sources across all supported languages land via real call.mjs record with zero judge-comments calls · loss: stuck / false-verdict", t => {
  const { w, p, prepared } = admission(t);
  const files = {
    "src/app.ts": "export type N = number;\nexport const f = (x: N): N => x + 1;\n",
    "src/view.tsx": "export const Card = ({ title }: { title: string }) => <section>{title}</section>;\n",
    "src/tool.py": '# D-0016\nVALUE = "# not prose"\n',
    "src/App.swift": '// D-0064\nlet s = "// literal"\n',
    "src/cfg.yml": "# $schema: ./schema.json\nmode: fast\n",
    "src/run.sh": '#!/usr/bin/env bash\n# shellcheck disable=SC2086\necho "$1"\n',
    "src/style.css": '.card { content: "/* literal */"; }\n',
    "src/index.html": "<!doctype html><html><body><p>ok</p></body></html>\n",
    "src/main.go": "package main\nfunc main() { _ = `// raw` }\n",
    "src/lib.rs": "// D-0064\npub fn id(x: i32) -> i32 { x }\n",
    "src/core.c": "// D-0064\nint add(int a, int b) { return a + b; }\n",
    "src/core.cpp": "int n = 1'000;\n",
    "src/App.java": "// D-0068\nclass App { int v = 1; }\n",
    "src/App.kt": "// ktlint-disable\nfun ok() = 1\n",
    "src/Cargo.toml": '[package]\nname = "demo"\n',
  };
  edit(prepared, files);
  const res = record(w, p, prepared);
  assert.equal(res.status, 0, output(res));
  const handoff = jsonOutput(res);
  assert.notEqual(handoff.product.commit, handoff.product.base);
  const recorded = w.git(p.records, "show", "HEAD:metrics/handoffs.jsonl").trim().split("\n").map(l => JSON.parse(l));
  assert.equal(recorded.some(r => r.role === "judge" || /judge-comments/.test(r.step)), false, "no judge-comments call expected");
  for (const [file, text] of Object.entries(files)) {
    assert.equal(w.runGit(p.product, "show", `${handoff.product.commit}:${file}`).stdout, text);
  }
});

test("R9-C-fastpass-02 fresh · flow: added prose in Go, C, C++, Rust, Java, and Kotlin refuses before commit with zero judge-comments calls · loss: false-verdict", t => {
  const { w, p, prepared } = admission(t);
  const cases = [
    ["src/main.go", "package main\nfunc main() {}\n", "// Explain main entrypoint.\n"],
    ["src/core.c", "int zero(void) { return 0; }\n", "/* Explain why zero returns 0. */\n"],
    ["src/core.cpp", "int zero() { return 0; }\n", "// Explain zero helper.\n"],
    ["src/lib.rs", "pub fn one() -> i32 { 1 }\n", "// Explain constant one.\n"],
    ["src/App.java", "class App {}\n", "// Explain empty class.\n"],
    ["src/App.kt", "fun one() = 1\n", "// Explain one return.\n"],
  ];
  const bad = Object.fromEntries(cases.map(([f, clean, prose]) => [f, clean + prose]));
  const diags = cases.map(([f, clean, prose]) => [f, clean.split("\n").length, prose.replace(/^(?:\/\/|\/\*)\s*|\s*\*\/\n$|\n$/g, "")]);
  const before = head(w, p);
  edit(prepared, bad);
  const badRes = record(w, p, prepared);
  status(badRes, 7);
  assert.match(output(badRes), /pending independent resolution \(comment\)/);
  for (const [file, line, phrase] of diags) {
    assert.ok(output(badRes).includes(`${file}:${line}`), output(badRes));
    assert.ok(output(badRes).includes(phrase), output(badRes));
  }
  assert.equal(head(w, p), before);
  edit(prepared, Object.fromEntries(cases.map(([f, clean]) => [f, clean])));
  assert.equal(record(w, p, prepared).status, 0);
  const recorded = w.git(p.records, "show", "HEAD:metrics/handoffs.jsonl").trim().split("\n").map(l => JSON.parse(l));
  assert.equal(recorded.some(r => r.role === "judge" || /judge-comments/.test(r.step)), false);
});
