import test from "node:test";
import { admission } from "./round7-b-fixture.mjs";
import { acceptedPatch, refusedPatch } from "./comment-contract-fixture.mjs";

const consoleLine = 'console.log("fixture");';
const typed = 'export const value: number = "intentional";';
const nodeIgnore = "node:coverage ignore next 2";
const schema = 'yaml-language-server: $schema=./schema.json';
const swiftLine = 'let value = raw as! String';

const cases = [
  ["01", "interpreter line", "release.sh", "#!/usr/bin/env bash\nprintf 'ready\\n'\n",
    "release.sh", "printf 'ready\\n'\n#!/usr/bin/env bash\n", 2, "/usr/bin/env bash"],
  ["02", "ESLint block disable", "fixture.mjs", `/* eslint-disable no-console */\n${consoleLine}\n`,
    "style.css", "/* eslint-disable no-console */\nbody { color: black; }\n", 1, "eslint-disable no-console"],
  ["03", "ESLint block enable", "fixture.mjs", `/* eslint-disable no-console */\n${consoleLine}\n/* eslint-enable no-console */\n`,
    "style.css", "body { color: black; }\n/* eslint-enable no-console */\n", 2, "eslint-enable no-console"],
  ["04", "ESLint next-line directive with a source pointer as its description", "fixture.mjs",
    `// eslint-disable-next-line no-console -- D-0016\n${consoleLine}\n`,
    "fixture.mjs", `// eslint-disable-next-line no-console -- Explain the test fixture in parallel.\n${consoleLine}\n`,
    1, "Explain the test fixture in parallel."],
  ["05", "ESLint same-line directive", "fixture.mjs", `${consoleLine} // eslint-disable-line no-console\n`,
    "fixture.py", "print('fixture') # eslint-disable-line no-console\n", 1, "eslint-disable-line no-console"],
  ["06", "TypeScript expect-error on a known negative test", "fixture.ts", `// @ts-expect-error: D-0016\n${typed}\n`,
    "fixture.ts", `/*\n@ts-expect-error\n*/\n${typed}\n`, 2, "@ts-expect-error"],
  ["07", "TypeScript ignore before the suppressed diagnostic", "fixture.ts", `// @ts-ignore\n${typed}\n`,
    "fixture.py", "# @ts-ignore\nvalue = 'fixture'\n", 1, "@ts-ignore"],
  ["08", "TypeScript ts-check at the top of a JavaScript source file", "fixture.mjs", "// @ts-check\nexport const n = 2;\n",
    "fixture.mjs", "export const n = 2;\n// @ts-check\n", 2, "@ts-check"],
  ["09", "TypeScript ts-nocheck at the top of a TypeScript source file", "fixture.ts", `// @ts-nocheck\n${typed}\n`,
    "fixture.ts", `${typed}\n// @ts-nocheck\n`, 2, "@ts-nocheck"],
  ["10", "TypeScript triple-slash path reference before declarations", "fixture.ts",
    '/// <reference path="./types.d.ts" />\nexport const label: Label = "release";\n',
    "fixture.ts", 'export const label = "release";\n/// <reference path="./types.d.ts" />\n', 2, "<reference"],
  ["11", "TypeScript triple-slash library reference before declarations", "fixture.ts",
    '/// <reference lib="es2015" preserve="true" />\nexport const ready = Promise.resolve(true);\n',
    "fixture.ts", '// <reference lib="es2015" />\nexport const ready = Promise.resolve(true);\n', 1, "<reference"],
  ["12", "TypeScript triple-slash package reference before declarations", "fixture.d.ts",
    '/// <reference types="node" />\nexport declare const input: Buffer;\n',
    "fixture.d.ts", 'export declare const input: Uint8Array;\n/// <reference types="node" />\n', 2, "<reference"],
  ["13", "TypeScript triple-slash default-library declaration before statements", "fixture.d.ts",
    '/// <reference no-default-lib="true" />\nexport {};\n',
    "fixture.d.ts", 'export {};\n/// <reference no-default-lib="true" />\n', 2, "<reference"],
  ["14", "Node test coverage ignore-next block", "fixture.mjs",
    `/* ${nodeIgnore} */\nif (process.platform === "win32")\n  ${consoleLine}\n`,
    "fixture.mjs", `// ${nodeIgnore}\nif (process.platform === "win32")\n  ${consoleLine}\n`, 1, nodeIgnore],
  ["15", "Node test coverage disable and enable blocks", "fixture.mjs",
    `/* node:coverage disable */\nif (process.platform === "win32") ${consoleLine}\n/* node:coverage enable */\n`,
    "fixture.mjs", `/* node:coverage disable */\nif (process.platform === "win32") ${consoleLine}\n// node:coverage enable\n`,
    3, "node:coverage enable"],
  ["16", "Istanbul ignore-next before an instrumented statement", "fixture.mjs",
    `/* istanbul ignore next */\nif (process.platform === "win32") ${consoleLine}\n`,
    "style.css", "/* istanbul ignore next */\nbody { color: black; }\n", 1, "istanbul ignore next"],
  ["17", "v8-to-istanbul counted ignore-next", "fixture.mjs",
    `/* v8 ignore next 2 */\nif (process.platform === "win32")\n  ${consoleLine}\n`,
    "style.css", "/* v8 ignore next 2 */\nbody { color: black; }\n", 1, "v8 ignore next 2"],
  ["18", "c8 ignore-next with the historical c8 spelling", "fixture.mjs",
    `/* c8 ignore next */\nif (process.platform === "win32") ${consoleLine}\n`,
    "style.css", "/* c8 ignore next */\nbody { color: black; }\n", 1, "c8 ignore next"],
  ["19", "ShellCheck disable before its command", "release.sh",
    '#!/usr/bin/env bash\npattern="*.log"\n# shellcheck disable=SC2086\nprintf "%s\\n" $pattern\n',
    "release.sh", '#!/usr/bin/env bash\npattern="*.log"\nprintf "%s\\n" $pattern # shellcheck disable=SC2086\n',
    3, "shellcheck disable=SC2086"],
  ["20", "Ruff inline noqa with specific rule codes", "fixture.py", "import os, sys  # noqa: F401, E401\n",
    "fixture.mjs", "export const path = 1; // noqa: F401, E401\n", 1, "noqa: F401, E401"],
  ["21", "Ruff inline noqa without rule codes", "fixture.py", "import os  # noqa\n",
    "fixture.mjs", "export const path = 1; // noqa\n", 1, "noqa"],
  ["22", "mypy inline type ignore with specific error code", "fixture.py", 'count: int = "fixture"  # type: ignore[assignment]\n',
    "fixture.mjs", "export const count = 1; // type: ignore[assignment]\n", 1, "type: ignore[assignment]"],
  ["23", "mypy inline type ignore without an error code", "fixture.py", 'count: int = "fixture"  # type: ignore\n',
    "fixture.sh", "count=1 # type: ignore\n", 1, "type: ignore"],
  ["24", "YAML language server schema modeline before YAML content", "config.yaml", `# ${schema}\nmode: release\n`,
    "config.yaml", `mode: release\n# ${schema}\n`, 2, schema],
  ["25", "SwiftLint disable and enable over a range", "Fixture.swift",
    `func cast(_ raw: Any) -> String {\n  // swiftlint:disable force_cast\n  ${swiftLine}\n  // swiftlint:enable force_cast\n  return value\n}\n`,
    "fixture.mjs", "export const raw = 1; // swiftlint:disable force_cast\n", 1, "swiftlint:disable force_cast"],
  ...["next", "this", "previous"].map((position, i) => {
    const directive = `swiftlint:disable:${position} force_cast`;
    const source = { next: `// ${directive}\n  ${swiftLine}`, this: `${swiftLine} // ${directive}`,
      previous: `${swiftLine}\n  // ${directive}` }[position];
    return [String(26 + i), `SwiftLint ${position}-line suppression`, "Fixture.swift",
      `func cast(_ raw: Any) -> String {\n  ${source}\n  return value\n}\n`,
      "fixture.mjs", `export const raw = 1; // ${directive}\n`, 1, directive];
  }),
  ["29", "ESLint next-line syntax is not consumed from a CSS comment", "fixture.mjs",
    `// eslint-disable-next-line no-console\n${consoleLine}\n`,
    "style.css", "/* eslint-disable-next-line no-console */\nbody { color: black; }\n", 1, "eslint-disable-next-line no-console"],
  ["30", "TypeScript expect-error on the last line of a block comment", "fixture.ts",
    `/*\n * @ts-expect-error */\n${typed}\n`,
    "fixture.ts", `/* @ts-expect-error\n */\n${typed}\n`, 1, "@ts-expect-error"],
  ["31", "YAML language server also consumes the IntelliJ-compatible modeline", "config.yaml",
    "# $schema: ./schema.json\nmode: release\n",
    "config.yaml", "mode: release\n# $schema: ./schema.json\n", 2, "$schema"],
  ...["if", "else", "file"].map((target, i) => {
    const directive = `istanbul ignore ${target}`;
    return [String(32 + i), `Istanbul ignore-${target} coverage hint`, "fixture.mjs",
      `/* ${directive} */\nif (process.platform === "win32") ${consoleLine} else console.log("other");\n`,
      "style.css", `/* ${directive} */\nbody { color: black; }\n`, 1, directive];
  }),
  ...["c8", "v8"].map((tool, i) => {
    const start = `${tool} ignore start`;
    const stop = `${tool} ignore stop`;
    return [String(35 + i), `${tool} coverage range start and stop`, "fixture.mjs",
      `/* ${start} */\nif (process.platform === "win32") ${consoleLine}\n/* ${stop} */\n`,
      "style.css", `/* ${start} */\nbody { color: black; }\n/* ${stop} */\n`, 3, stop];
  }),
];

for (const [id, title, goodFile, good, badFile, bad, line, phrase] of cases) {
  test(`R7-B5-${id} ${title} is admitted only in its consuming form`, t => {
    const { w, p, prepared } = admission(t);
    const invalid = "src/" + badFile;
    refusedPatch(w, p, prepared, { [invalid]: bad }, [invalid, line, phrase]);
    const support = id === "10" ? { "src/types.d.ts": "type Label = string;\n" } :
      ["24", "31"].includes(id) ? { "src/schema.json": '{"type":"object"}\n' } : {};
    const valid = { ...support, ["src/" + goodFile]: good };
    if (goodFile !== badFile) {
      const retry = { ...valid, [invalid]: null };
      acceptedPatch(w, p, prepared, retry);
    } else {
      acceptedPatch(w, p, prepared, valid);
    }
  });
}
