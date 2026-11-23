import test from "node:test";
import { batchDraw } from "./round6-b-fixture.mjs";
import { admission } from "./round7-b-fixture.mjs";
import { acceptedPatch, refusedPatch } from "./comment-contract-fixture.mjs";

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
    acceptedPatch(w, p, prepared, { [file]: source });
  });
}
