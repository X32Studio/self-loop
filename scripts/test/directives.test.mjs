// D-0016, R-0006-judge, design/driver.md#directives
import assert from "node:assert/strict";
import test from "node:test";
import { commentLines, DIRECTIVES, languageOf } from "../lib/comments.mjs";

const kinds = (path, text) => commentLines(text, languageOf(path, text), { path })
  .map(({ line, pieces }) => `${line}:${pieces.map(p => p.rule ?? p.kind).join("+")}`).join(" ");

const FORMS = [
  ["the interpreter line, only at byte 0 of line 1 (man 2 execve, Interpreter scripts; ECMAScript Hashbang Grammar)", "interpreter", [
    ["run.sh", "#!/bin/sh\necho\n", "1:interpreter"],
    ["tool.py", "#!/usr/bin/env python3\nx = 1\n", "1:interpreter"],
    ["bin/run", "#!/usr/bin/env node\nprocess.exit(0);\n", "1:interpreter"],
    ["main.swift", "#!/usr/bin/env swift\nprint(1)\n", "1:interpreter"],
    ["run.sh", "echo\n#!/bin/sh\n", "2:prose"],
    ["tool.py", "x = 1\n#!/usr/bin/python3\n", "2:prose"],
  ]],
  ["TypeScript @ts-expect-error and @ts-ignore: a // or /// comment, or the last line of a block (typescriptlang.org/docs/handbook/release-notes/typescript-3-9.html#-ts-expect-error-comments)", "ts-ignore-line", [
    ["a.ts", "// @ts-expect-error\nconst a: number = 'x';\n", "1:ts-ignore-line"],
    ["a.ts", "/// @ts-ignore\nf();\n", "1:ts-ignore-line"],
    ["a.mjs", "// @ts-expect-error: D-0016\nf();\n", "1:ts-ignore-line"],
    ["a.ts", "f(/* @ts-ignore */);\n", "1:ts-ignore-block"],
    ["a.ts", "/**\n * D-0016\n * @ts-expect-error */\nf();\n", "1:ts-ignore-block 2:ts-ignore-block 3:ts-ignore-block"],
    ["a.ts", "// @ts-expect-error the type is wrong\nf();\n", "1:prose"],
    ["a.ts", "/**\n * @ts-ignore\n */\nf();\n", "1:pointer 2:prose 3:pointer"],
  ]],
  ["TypeScript @ts-check and @ts-nocheck: a // comment among the file's leading comments (typescriptlang.org/docs/handbook/intro-to-js-ts.html#ts-check)", "ts-check", [
    ["a.mjs", "// @ts-check\nexport {};\n", "1:ts-check"],
    ["bin/run", "#!/usr/bin/env node\n/* D-0016 */\n// @ts-nocheck\nf();\n", "1:interpreter 2:pointer 3:ts-check"],
    ["a.mjs", "export {};\n// @ts-check\n", "2:prose"],
    ["a.mjs", "/* @ts-check */\nexport {};\n", "1:prose"],
  ]],
  ["TypeScript triple-slash directives: /// <reference …/>, <amd-module …/>, <amd-dependency …/> before the first statement (typescriptlang.org/docs/handbook/triple-slash-directives.html)", "ts-triple-slash", [
    ["a.ts", "/// <reference types=\"node\" />\nexport {};\n", "1:ts-triple-slash"],
    ["a.ts", "/// <reference path='./globals.d.ts' />\n/// <reference types=\"pkg\" resolution-mode=\"require\" />\n", "1:ts-triple-slash 2:ts-triple-slash"],
    ["a.ts", "/// <amd-module name=\"main\" />\n", "1:ts-triple-slash"],
    ["a.ts", "// <reference types=\"node\" />\n", "1:prose"],
    ["a.ts", "export {};\n/// <reference types=\"node\" />\n", "2:prose"],
    ["a.ts", "/// <reference types=\"node\" note=\"for timers\" />\n", "1:prose"],
  ]],
  ["Babel and TypeScript JSX pragmas: @jsx, @jsxFrag, @jsxImportSource, @jsxRuntime (babeljs.io/docs/babel-plugin-transform-react-jsx#customizing-with-the-classic-runtime)", "jsx-pragma", [
    ["page.js", "/** @jsx h */\nexport {};\n", "1:jsx-pragma"],
    ["page.js", "// @jsxRuntime classic\n", "1:jsx-pragma"],
    ["page.js", "/* @jsxImportSource preact */\n", "1:jsx-pragma"],
  ]],
  ["TypeScript JSDoc types in JavaScript files: /** @type, @param, @returns, @typedef, @template, @satisfies … */ with no description (typescriptlang.org/docs/handbook/jsdoc-supported-types.html)", "jsdoc-types", [
    ["a.mjs", "/** @type {import(\"./x.mjs\").Y} */\nlet y;\n", "1:jsdoc-types"],
    ["a.mjs", "/**\n * @param {string} name\n * @param {{ a: number }} [options]\n * @returns {number}\n */\n", "1:jsdoc-types 2:jsdoc-types 3:jsdoc-types 4:jsdoc-types 5:jsdoc-types"],
    ["a.cjs", "/** @satisfies {Config} */\n", "1:jsdoc-types"],
    ["a.mjs", "/** @param {string} name the user's name */\n", "1:prose"],
    ["a.ts", "/** @type {X} */\nlet y;\n", "1:prose"],
    ["a.mjs", "// @type {X}\nlet y;\n", "1:prose"],
  ]],
  ["ESLint: eslint-disable-line and eslint-disable-next-line in // or a one-line block; eslint-disable, eslint-enable, eslint, global, exported, eslint-env in blocks; a -- justification (eslint.org/docs/latest/use/configure/rules#disabling-rules)", "eslint-line", [
    ["a.mjs", "// eslint-disable-next-line no-console\nconsole.log(1);\n", "1:eslint-line"],
    ["a.mjs", "f(); // eslint-disable-line no-alert, no-console -- D-0016\n", "1:eslint-line"],
    ["a.mjs", "//eslint-disable-line\n", "1:eslint-line"],
    ["a.mjs", "/* eslint-disable */\n", "1:eslint-block"],
    ["a.mjs", "/* eslint-disable\n  no-console,\n  no-alert\n*/\n", "1:eslint-block 2:eslint-block 3:eslint-block 4:eslint-block"],
    ["a.mjs", "/* eslint-enable no-console */\n", "1:eslint-block"],
    ["a.mjs", "f(); /* eslint-disable-line @typescript-eslint/no-explicit-any */\n", "1:eslint-block-line"],
    ["a.mjs", "/* global window, document:writable */\n/* exported main */\n", "1:eslint-config 2:eslint-config"],
    ["a.mjs", "/* eslint quotes: [\"error\", \"double\"], curly: 2 */\n/* eslint-env node, mocha */\n", "1:eslint-config 2:eslint-config"],
    ["a.mjs", "// eslint-disable\n", "1:prose"],
    ["a.mjs", "// eslint-disable-next-line no-console -- the logger is not ready\n", "1:prose"],
    ["a.mjs", "/* eslint-disable-line\n  no-console */\n", "1:prose 2:prose"],
    ["a.mjs", "/** eslint-disable */\n", "1:prose"],
    ["a.mjs", "// oxlint-disable-next-line no-debugger\n/* oxlint-disable */\n", "1:eslint-line 2:eslint-block"],
  ]],
  ["TSLint rule flags: // tslint:disable[-line|-next-line][:rule …] and /* tslint:disable:rule */ (palantir.github.io/tslint/usage/rule-flags/)", "tslint", [
    ["a.ts", "// tslint:disable-next-line:no-console\n/* tslint:disable:max-line-length no-any */\n// tslint:enable\n", "1:tslint 2:tslint 3:tslint"],
    ["a.ts", "// tslint:disable-next-line because of the legacy logger\n", "1:prose"],
  ]],
  ["Prettier: // prettier-ignore and /* prettier-ignore */ in JavaScript (prettier.io/docs/ignore#javascript)", "prettier-ignore-js", [
    ["a.mjs", "// prettier-ignore\nconst m = [1,0,0];\n", "1:prettier-ignore-js"],
    ["a.mjs", "f(/* prettier-ignore */ x);\n", "1:prettier-ignore-js"],
    ["a.mjs", "// prettier-ignore because the matrix is aligned\n", "1:prose"],
  ]],
  ["istanbul hints: istanbul ignore if, else, next or file in a // or /* comment (github.com/istanbuljs/nyc#parsing-hints-ignoring-lines)", "istanbul", [
    ["a.mjs", "/* istanbul ignore next */\nf();\n", "1:istanbul"],
    ["a.mjs", "// istanbul ignore else\n", "1:istanbul"],
    ["a.mjs", "/* istanbul ignore file */\n/* istanbul ignore if: D-0016 */\n", "1:istanbul 2:istanbul"],
    ["a.mjs", "/** istanbul ignore next */\n", "1:prose"],
    ["a.mjs", "/* istanbul ignore next: the legacy path */\n", "1:prose"],
  ]],
  ["c8 and Vitest v8 hints: /* c8 ignore next [n] */, start, stop; /* v8 ignore … -- @preserve */ (github.com/bcoe/c8#ignoring-uncovered-lines-functions-and-blocks; vitest.dev/guide/coverage#ignoring-code)", "c8", [
    ["a.mjs", "/* c8 ignore next */\n/* c8 ignore next 3 */\n/* c8 ignore start */\n/* c8 ignore stop */\n", "1:c8 2:c8 3:c8 4:c8"],
    ["a.ts", "/* v8 ignore next -- @preserve */\n/* v8 ignore if */\n", "1:v8 2:v8"],
    ["a.mjs", "// c8 ignore next\n", "1:prose"],
    ["a.mjs", "/*c8 ignore next*/\n", "1:prose"],
  ]],
  ["Node.js test runner coverage: exactly /* node:coverage ignore next [n] */, /* node:coverage disable */, /* node:coverage enable */ (nodejs.org/docs/latest-v24.x/api/test.html#collecting-code-coverage)", "node-coverage", [
    ["a.mjs", "/* node:coverage ignore next */\n/* node:coverage ignore next 3 */\n/* node:coverage disable */\n/* node:coverage enable */\n", "1:node-coverage 2:node-coverage 3:node-coverage 4:node-coverage"],
    ["a.mjs", "// node:coverage disable\n", "1:prose"],
    ["a.mjs", "/*  node:coverage disable */\n", "1:prose"],
  ]],
  ["bundler annotations: /*#__PURE__*/, /*@__PURE__*/, /* #__NO_SIDE_EFFECTS__ */ (rollupjs.org/configuration-options/#treeshake-annotations; esbuild.github.io/api/#ignore-annotations)", "pure-annotation", [
    ["a.mjs", "const x = /*#__PURE__*/ make();\nconst y = /* @__PURE__ */ make();\n", "1:pure-annotation 2:pure-annotation"],
    ["a.mjs", "/* #__NO_SIDE_EFFECTS__ */\nexport function f() {}\n", "1:pure-annotation"],
  ]],
  ["source map links: //# sourceMappingURL=… and /*# sourceMappingURL=… */ (tc39.es/ecma426/#sec-linking-generated-code)", "source-map-url", [
    ["app.js", "f();\n//# sourceMappingURL=app.js.map\n", "2:source-map-url"],
    ["app.css", "a{}\n/*# sourceMappingURL=app.css.map */\n", "2:source-map-url"],
  ]],
  ["webpack magic comments and Vite's @vite-ignore inside import() (webpack.js.org/api/module-methods/#magic-comments; vite.dev/guide/features.html#dynamic-import)", "webpack-magic", [
    ["a.mjs", "import(/* webpackChunkName: \"chart\" */ \"./chart.js\");\n", "1:webpack-magic"],
    ["a.mjs", "import(/* webpackChunkName: \"x\", webpackPrefetch: true */ \"./x.js\");\n", "1:webpack-magic"],
    ["a.mjs", "import(/* @vite-ignore */ url);\n", "1:vite-ignore"],
    ["a.mjs", "import(/* webpackChunkName: \"x\" loads later */ \"./x.js\");\n", "1:prose"],
  ]],
  ["Flow, Prettier and test-environment pragmas: @flow and @format at the head of the file; @jest-environment and @vitest-environment (flow.org/en/docs/usage/; prettier.io/docs/options#require-pragma; jestjs.io/docs/configuration#testenvironment-string)", "flow", [
    ["a.js", "// @flow\nexport {};\n", "1:flow"],
    ["a.js", "/* @flow strict */\n", "1:flow"],
    ["a.js", "/** @format */\nexport {};\n", "1:format-pragma"],
    ["a.test.js", "/** @jest-environment jsdom */\n// @vitest-environment happy-dom\n", "1:test-environment 2:test-environment"],
    ["a.js", "f();\n// @flow\n", "2:prose"],
  ]],
  ["clang-format, Biome and Deno: // clang-format off|on; // biome-ignore <category>: <explanation>; // deno-lint-ignore, // deno-fmt-ignore (clang.llvm.org/docs/ClangFormatStyleOptions.html#disabling-formatting-on-a-piece-of-code; biomejs.dev/analyzer/suppressions/; docs.deno.com/runtime/reference/cli/lint/#ignore-directives)", "clang-format", [
    ["a.mjs", "// clang-format off\n/* clang-format on */\n", "1:clang-format 2:clang-format"],
    ["a.mjs", "// biome-ignore lint/suspicious/noDebugger: D-0016\ndebugger;\n", "1:biome"],
    ["a.ts", "// deno-lint-ignore no-explicit-any\n// deno-fmt-ignore-file\n", "1:deno 2:deno"],
    ["a.mjs", "// biome-ignore lint/suspicious/noDebugger: while debugging the parser\n", "1:prose"],
  ]],
  ["Swift Package Manager: // swift-tools-version:<version> on line 1 of a package manifest (github.com/swiftlang/swift-package-manager/blob/main/Documentation/Usage.md#swift-tools-version-specification)", "swift-tools-version", [
    ["Package.swift", "// swift-tools-version:5.9\nimport PackageDescription\n", "1:swift-tools-version"],
    ["Package@swift-6.0.swift", "// swift-tools-version: 6.0\n", "1:swift-tools-version"],
    ["App.swift", "// swift-tools-version:5.9\n", "1:prose"],
    ["Package.swift", "import PackageDescription\n// swift-tools-version:5.9\n", "2:prose"],
  ]],
  ["SwiftLint, swift-format and SwiftFormat: // swiftlint:disable[:next|:this|:previous] <rules> [- comment]; // swift-format-ignore[-file][: Rule]; // swiftformat:disable[:next] <rules> (github.com/realm/SwiftLint#disable-rules-in-code; github.com/swiftlang/swift-format/blob/main/Documentation/IgnoringSource.md; github.com/nicklockwood/SwiftFormat#comment-directives)", "swiftlint", [
    ["A.swift", "// swiftlint:disable:next force_cast\nlet x = y as! Z\n", "1:swiftlint"],
    ["A.swift", "let x = y as! Z // swiftlint:disable:this force_cast\n// swiftlint:disable all\n", "1:swiftlint 2:swiftlint"],
    ["A.swift", "// swiftlint:disable:next force_cast - D-0016\n", "1:swiftlint"],
    ["A.swift", "// swift-format-ignore\n// swift-format-ignore: AlwaysUseLowerCamelCase\n// swift-format-ignore-file\n", "1:swift-format 2:swift-format 3:swift-format"],
    ["A.swift", "// swiftformat:disable:next redundantSelf\n// swiftformat:options --indent 2\n", "1:swiftformat 2:swiftformat"],
    ["A.swift", "// swiftlint:disable:next force_cast - the API returns Any\n", "1:prose"],
    ["A.swift", "/* swiftlint:disable force_cast */\n", "1:prose"],
  ]],
  ["Periphery: // periphery:ignore[:all|:parameters a, b] [- comment] (github.com/peripheryapp/periphery#comment-commands)", "periphery", [
    ["A.swift", "// periphery:ignore\nclass A {}\n// periphery:ignore:parameters a, b\n// periphery:ignore - D-0016\n", "1:periphery 3:periphery 4:periphery"],
    ["A.swift", "// periphery:ignore - kept for the plugin API\n", "1:prose"],
  ]],
  ["ShellCheck: # shellcheck key=value … on its own line before a command, never trailing it (shellcheck.net/wiki/Directive; shellcheck.net/wiki/SC1126)", "shellcheck", [
    ["run.sh", "# shellcheck disable=SC2086\necho $x\n", "1:shellcheck"],
    ["run.sh", "  # shellcheck disable=SC2086,SC2034 source=/dev/null\n", "1:shellcheck"],
    ["run.sh", "#shellcheck shell=bash\n# shellcheck disable=SC1000-SC1100\n# shellcheck disable=all # D-0016\n", "1:shellcheck 2:shellcheck 3:shellcheck"],
    ["run.sh", "echo $x # shellcheck disable=SC2086\n", "1:prose"],
    ["run.sh", "# shellcheck disable=SC2086 because the words split on purpose\n", "1:prose"],
  ]],
  ["Python source encoding: # -*- coding: <name> -*-, # coding=<name> or a vim fileencoding line on line 1, or line 2 after a comment line (peps.python.org/pep-0263/)", "pep263", [
    ["a.py", "# -*- coding: utf-8 -*-\nx = 1\n", "1:pep263"],
    ["a.py", "#!/usr/bin/env python3\n# coding=latin-1\n", "1:interpreter 2:pep263"],
    ["a.py", "# vim: set fileencoding=utf-8 :\n", "1:pep263"],
    ["a.py", "x = 1\n# coding: utf-8\n", "2:prose"],
  ]],
  ["mypy and pyright: # type: ignore[codes] in any # segment, PEP 484 type comments first (mypy.readthedocs.io/en/stable/error_codes.html#silencing-errors-based-on-error-codes; peps.python.org/pep-0484/#type-comments)", "type-ignore", [
    ["a.py", "x = f()  # type: ignore\n", "1:type-ignore"],
    ["a.py", "x = f()  # type: ignore[attr-defined]  # noqa: E501\n", "1:type-ignore"],
    ["a.py", "x = []  # type: List[int]\n", "1:type-comment"],
    ["a.py", "def f(a, b):\n    # type: (int, str) -> bool\n    return True\n", "2:type-comment"],
    ["a.py", "x = f()  # type: ignore because the stubs lag\n", "1:prose"],
    ["a.py", "x = 1  # type: this is not a type\n", "1:prose"],
    ["a.py", "x = f()  # type: ignore  # the stubs lag\n", "1:prose"],
  ]],
  ["flake8 and Ruff: # noqa[: codes] (any case) in any # segment; # flake8: noqa and # ruff: noqa on their own line (flake8.pycqa.org/en/latest/user/violations.html#in-line-ignoring-errors; docs.astral.sh/ruff/linter/#error-suppression)", "noqa", [
    ["a.py", "import os  # noqa\n", "1:noqa"],
    ["a.py", "x = 1  # noqa: E501,W291\ny = 2  # NoQA\nz = 3  #noqa:F401\n", "1:noqa 2:noqa 3:noqa"],
    ["a.py", "# flake8: noqa\n# ruff: noqa: F401\n", "1:file-noqa 2:file-noqa"],
    ["a.py", "import os  # noqa because it is re-exported\n", "1:prose"],
  ]],
  ["Pylint, mypy inline configuration and Pyright: # pylint: disable=…; # mypy: … at column 0; # pyright: … (pylint.readthedocs.io/en/stable/user_guide/messages/message_control.html; mypy.readthedocs.io/en/stable/inline_config.html; microsoft.github.io/pyright/#/comments)", "pylint", [
    ["a.py", "# pylint: disable=invalid-name\nx = 1  # pylint: disable-next=too-many-arguments\n", "1:pylint 2:pylint"],
    ["a.py", "# mypy: ignore-errors\n# mypy: disable-error-code=\"misc,attr-defined\"\n", "1:mypy-inline 2:mypy-inline"],
    ["a.py", "# pyright: strict\nx = 1  # pyright: ignore[reportGeneralTypeIssues]\n# pyright: reportMissingImports=false\n", "1:pyright 2:pyright 3:pyright"],
    ["a.py", "def f():\n    # mypy: ignore-errors\n", "2:prose"],
    ["a.py", "#mypy: ignore-errors\n", "1:prose"],
  ]],
  ["Black, Ruff format, isort and coverage.py: # fmt: off|on|skip; # isort: skip|skip_file|off|on|split; # pragma: no cover|no branch (black.readthedocs.io/en/stable/the_black_code_style/current_style.html; pycqa.github.io/isort/docs/configuration/action_comments.html; coverage.readthedocs.io/en/latest/excluding.html)", "fmt", [
    ["a.py", "# fmt: off\nx = [1,2]  # fmt: skip\n", "1:fmt 2:fmt"],
    ["a.py", "# isort: skip_file\nimport a  # isort: skip\n", "1:isort 2:isort"],
    ["a.py", "if x:  # pragma: no cover\n    pass\nif y:  # pragma: no branch\n    pass\n", "1:coverage-pragma 3:coverage-pragma"],
    ["a.py", "# fmt: off because the table is aligned\n", "1:prose"],
    ["a.py", "subprocess.call(cmd, shell=True)  # nosec B602, B607\nx = eval(y)  # nosec\n", "1:nosec 2:nosec"],
    ["a.py", "x = eval(y)  # nosec trusted input\n", "1:prose"],
  ]],
  ["the YAML language server: # yaml-language-server: $schema=<url> or the IntelliJ-compatible # $schema: <url>, whitespace after #, among a document's header comments (github.com/redhat-developer/yaml-language-server#using-a-modeline; modelineUtil.ts isModeline over yamlParser07.ts getDocumentHeaderComments)", "yaml-language-server", [
    ["ci.yml", "# yaml-language-server: $schema=https://json.schemastore.org/github-workflow.json\non: push\n", "1:yaml-language-server"],
    ["ci.yml", "# yaml-language-server: $schema=./schema.json # D-0016\n", "1:yaml-language-server"],
    ["ci.yml", "# $schema: ./schema.json\nmode: release\n", "1:yaml-language-server"],
    ["ci.yml", "%YAML 1.2\n---\n# yaml-language-server: $schema=./a.json\na: 1\n---\n# $schema: ./b.json\nb: 2\n", "3:yaml-language-server 6:yaml-language-server"],
    ["ci.yml", "#yaml-language-server: $schema=./schema.json\n", "1:prose"],
    ["ci.yml", "# $schema=./schema.json\n", "1:prose"],
    ["ci.yml", "mode: release\n# yaml-language-server: $schema=./schema.json\n", "2:prose"],
    ["ci.yml", "mode: release\n# $schema: ./schema.json\n---\nnext: 1\n", "2:prose"],
  ]],
  ["yamllint: exactly # yamllint disable|enable|disable-line [rule:…]; # yamllint disable-file on line 1; Prettier's # prettier-ignore (yamllint.readthedocs.io/en/stable/disable_with_comments.html; prettier.io/docs/ignore#yaml)", "yamllint", [
    ["ci.yml", "# yamllint disable rule:line-length\nkey: value  # yamllint disable-line rule:truthy\n", "1:yamllint 2:yamllint"],
    ["ci.yml", "# yamllint disable-file\nkey: value\n", "1:yamllint-file"],
    ["ci.yml", "# prettier-ignore\nkey  : value\n", "1:prettier-ignore-yaml"],
    ["ci.yml", "#yamllint disable\n", "1:prose"],
    ["ci.yml", "key: value\n# yamllint disable-file\n", "2:prose"],
    ["ci.yml", "# yamllint disable rule:line-length # D-0016\n", "1:prose"],
  ]],
  ["Stylelint and Prettier in CSS and HTML: /* stylelint-disable[-line|-next-line] rules -- justification */; /* prettier-ignore */; <!-- prettier-ignore[-attribute] --> (stylelint.io/user-guide/ignore-code; prettier.io/docs/ignore#css; prettier.io/docs/ignore#html)", "stylelint", [
    ["a.css", "/* stylelint-disable */\na { color: red; } /* stylelint-disable-line color-named */\n", "1:stylelint 2:stylelint"],
    ["a.css", "/* stylelint-disable-next-line color-named -- D-0016 */\n/* prettier-ignore */\n", "1:stylelint 2:prettier-ignore-css"],
    ["p.html", "<!-- prettier-ignore -->\n<div   a=1></div>\n<!-- prettier-ignore-attribute (click) -->\n", "1:prettier-ignore-html 3:prettier-ignore-html"],
    ["a.css", "/* stylelint-disable-next-line color-named -- the brand colour */\n", "1:prose"],
  ]],
  ["SQLFluff: -- noqa[: codes | disable=… | enable=…]; -- sqlfluff:<key>:<value> at column 0 (docs.sqlfluff.com/en/stable/configuration/ignoring_configuration.html; docs.sqlfluff.com/en/stable/configuration/setting_configuration.html#in-file-configuration-directives)", "sqlfluff-noqa", [
    ["q.sql", "SELECT 1 -- noqa\n;SELECT 2 -- noqa: LT01,AL02\n-- noqa: disable=all\n", "1:sqlfluff-noqa 2:sqlfluff-noqa 3:sqlfluff-noqa"],
    ["q.sql", "-- sqlfluff:dialect:postgres\n--sqlfluff:max_line_length:120\n", "1:sqlfluff-config 2:sqlfluff-config"],
    ["q.sql", "SELECT 1;\n  -- sqlfluff:dialect:postgres\n", "2:prose"],
  ]],
  ["editor and spelling modelines: vim in the first or last 5 lines; Emacs -*- … -*- on line 1 or after an interpreter line; cspell: (vimhelp.org/options.txt.html#modeline; gnu.org/software/emacs/manual/html_node/emacs/Specifying-File-Variables.html; cspell.org/docs/Configuration/document-settings)", "vim-modeline", [
    ["a.mjs", "// vim: set ts=2 sw=2 :\nexport {};\n", "1:vim-modeline"],
    ["run.sh", "#!/bin/sh\n# -*- mode: sh -*-\necho\n# vim: ts=4 sw=4\n", "1:interpreter 2:emacs-file-variables 4:vim-modeline"],
    ["a.py", "# -*- mode: python; indent-tabs-mode: nil -*-\n", "1:emacs-file-variables"],
    ["a.mjs", "// cspell:disable-next-line\nconst x = 'zaallano';\n# cspell:ignore zaallano\n", "1:cspell"],
    ["a.py", "# cspell:ignore zaallano wooorrdd\n", "1:cspell"],
    ["a.mjs", `${"f();\n".repeat(8)}// vim: set ts=2 :\n${"f();\n".repeat(8)}`, "9:prose"],
    ["a.py", "x = 1\ny = 2\n# -*- mode: python -*-\n", "3:prose"],
  ]],
  ["SPDX and REUSE tags in any comment, a REUSE header block of them included, while licence text is prose (D-0029), and JetBrains noinspection on its own line (spdx.github.io/spdx-spec/v2.3/using-SPDX-short-identifiers-in-source-files/; reuse.software/spec-3.3/; jetbrains.com/help/idea/disabling-and-enabling-inspections.html#suppress-in-editor)", "spdx", [
    ["a.mjs", "// SPDX-License-Identifier: Apache-2.0 OR MIT\n// SPDX-FileCopyrightText: 2026 Example Contributors\n", "1:spdx 2:spdx"],
    ["run.sh", "#!/bin/sh\n# SPDX-License-Identifier: GPL-2.0-only WITH Linux-syscall-note\n", "1:interpreter 2:spdx"],
    ["a.css", "/* SPDX-License-Identifier: MIT */\n", "1:spdx"],
    ["a.mjs", "/*\n * SPDX-FileCopyrightText: 2019 Jane Doe <jane@example.com>\n *\n * SPDX-License-Identifier: (MIT OR Apache-2.0) AND BSD-3-Clause\n */\n", "1:spdx 2:spdx 3:spdx 4:spdx 5:spdx"],
    ["a.py", "# SPDX-SnippetBegin\n# SPDX-SnippetCopyrightText: 2022 Jane Doe\n# SPDX-License-Identifier: MIT\nprint(1)\n# SPDX-SnippetEnd\n", "1:spdx 2:spdx 3:spdx 5:spdx"],
    ["run.sh", "# REUSE-IgnoreStart\necho x\n# REUSE-IgnoreEnd\n", "1:spdx 3:spdx"],
    ["p.html", "<!-- SPDX-License-Identifier: MIT -->\n", "1:spdx"],
    ["ci.yml", "# SPDX-License-Identifier: MIT\nkey: value\n", "1:spdx"],
    ["a.mjs", "/*\n * SPDX-License-Identifier: MIT\n * Permission is hereby granted, free of charge, to any person\n */\n", "1:pointer 2:prose 3:prose 4:pointer"],
    ["a.mjs", "// SPDX-License-Identifier: MIT licensed by us\n", "1:prose"],
    ["a.mjs", "//noinspection JSUnusedGlobalSymbols\nexport const a = 1;\n", "1:noinspection"],
    ["a.py", "# noinspection PyUnresolvedReferences, PyProtectedMember\nimport x\n", "1:noinspection"],
    ["a.mjs", "// Licensed under the Apache License, Version 2.0\n", "1:prose"],
    ["a.mjs", "f(); // noinspection JSUnusedGlobalSymbols\n", "1:prose"],
  ]],
  ["Go compiler and golangci-lint directives: //go:generate, //go:embed, //go:build, // +build, //nolint with pointer-only trailing reason (pkg.go.dev/cmd/go; pkg.go.dev/embed; golangci-lint.run/usage/false-positives/#nolint-directive)", "go-generate", [
    ["main.go", "//go:generate stringer -type=Pill\npackage main\n", "1:go-generate"],
    ["main.go", "package main\n//go:embed hello.txt\nvar s string\n", "2:go-embed"],
    ["main.go", "//go:build (linux || darwin) && !cgo\n// +build linux,amd64 darwin\npackage main\n", "1:go-build 2:go-build"],
    ["main.go", "package main\nfunc f() { _ = 1 } //nolint\n// nolint:errcheck,gosec\n//nolint:errcheck // D-0016\n//nolint:gosec -- D-0016\n", "2:go-nolint 3:go-nolint 4:go-nolint 5:go-nolint"],
    ["main.go", "// go:generate stringer -type=Pill\npackage main\n", "1:prose"],
    ["main.go", "var s string //go:embed hello.txt\n", "1:prose"],
    ["main.go", "package main\n//go:build linux\n", "2:prose"],
    ["main.go", "package main\n// +build linux\n", "2:prose"],
    ["main.go", "//go:build (linux\npackage main\n", "1:prose"],
    ["main.go", "//go:build this file is for linux\npackage main\n", "1:prose"],
    ["main.go", "//+build linux\npackage main\n", "1:prose"],
    ["main.go", "//nolint:errcheck // ignore the error because legacy\npackage main\n", "1:prose"],
    ["main.go", "//nolint:errcheck -- explain why\npackage main\n", "1:prose"],
    ["main.go", "/* nolint:errcheck */\npackage main\n", "1:prose"],
    ["a.mjs", "//go:generate stringer -type=Pill\n//go:build linux\n//nolint:errcheck\n", "1:prose 2:prose 3:prose"],
  ]],
  ["C and C++ clang-tidy NOLINT and clang-format directives in line and block comments (clang.llvm.org/extra/clang-tidy/#suppressing-undesired-diagnostics; clang.llvm.org/docs/ClangFormatStyleOptions.html)", "clang-tidy-nolint", [
    ["mod.c", "// NOLINT\n// NOLINT(bugprone-narrowing-conversions)\n// NOLINTNEXTLINE\n// NOLINTNEXTLINE(readability-magic-numbers)\n// NOLINTBEGIN(cppcoreguidelines-*)\n// NOLINTEND\n", "1:clang-tidy-nolint 2:clang-tidy-nolint 3:clang-tidy-nolint 4:clang-tidy-nolint 5:clang-tidy-nolint 6:clang-tidy-nolint"],
    ["mod.cpp", "/* NOLINT */\n/* NOLINT(modernize-*, -modernize-use-auto) */\n/* NOLINTNEXTLINE(misc-unused-parameters) */\n// NOLINT(bugprone-*) -- D-0016\n// clang-format off\n/* clang-format on */\n", "1:clang-tidy-nolint 2:clang-tidy-nolint 3:clang-tidy-nolint 4:clang-tidy-nolint 5:clang-format 6:clang-format"],
    ["mod.cpp", "// NOLINT because legacy\n", "1:prose"],
    ["mod.cpp", "// NOLINT(readability-magic-numbers) -- magic constant\n", "1:prose"],
    ["mod.cpp", "// NOLINT()\n// nolint\n", "1:prose 2:prose"],
    ["mod.cpp", "// clang-format off: keep aligned\n", "1:prose"],
    ["a.mjs", "// NOLINT\n", "1:prose"],
    ["main.go", "// NOLINT\n// clang-format off\n", "1:prose 2:prose"],
  ]],
  ["Java Checkstyle and Kotlin ktlint directives, scoped strictly to their consuming language (checkstyle.org/filters/suppressioncommentfilter.html; pinterest.github.io/ktlint/latest/faq/#how-do-i-suppress-an-error-for-a-lineblockfile)", "ktlint", [
    ["App.kt", "// ktlint-disable\n// ktlint-enable\n// ktlint-disable no-wildcard-imports max-line-length\n// ktlint-disable standard:no-wildcard-imports -- D-0016\n/* ktlint-disable indent */\n", "1:ktlint 2:ktlint 3:ktlint 4:ktlint 5:ktlint"],
    ["App.java", "// CHECKSTYLE:OFF\n// CHECKSTYLE:ON\n// checkstyle:off\n// checkstyle:on\n// CHECKSTYLE:OFF: MagicNumber|VisibilityModifier\n// CHECKSTYLE:OFF -- D-0016\n/* CHECKSTYLE:OFF */\n// clang-format off\n", "1:checkstyle 2:checkstyle 3:checkstyle 4:checkstyle 5:checkstyle 6:checkstyle 7:checkstyle 8:clang-format"],
    ["App.kt", "// ktlint-disable because this line is long\n", "1:prose"],
    ["App.kt", "// ktlint-disable no-wildcard-imports -- explain why\n", "1:prose"],
    ["App.kt", "// CHECKSTYLE:OFF\n", "1:prose"],
    ["App.java", "// ktlint-disable no-wildcard-imports\n", "1:prose"],
    ["App.java", "// CHECKSTYLE:OFF because this method has many args\n", "1:prose"],
    ["App.java", "// CHECKSTYLE:OFF -- explain why\n", "1:prose"],
    ["a.mjs", "// CHECKSTYLE:OFF\n// ktlint-disable\n", "1:prose 2:prose"],
  ]],
  ["Rust rustfmt::skip and universal Rust directives (rust-lang.github.io/rustfmt/#tips)", "rustfmt-skip", [
    ["lib.rs", "#!/usr/bin/env -S cargo +nightly -Zscript\n// SPDX-License-Identifier: Apache-2.0\n// cspell:ignore rustc\n// rustfmt::skip\n// rustfmt::skip -- D-0016\n", "1:interpreter 2:spdx 3:cspell 4:rustfmt-skip 5:rustfmt-skip"],
    ["lib.rs", "// rustfmt::skip keep matrix aligned\n", "1:prose"],
    ["lib.rs", "// rustfmt::skip -- keep matrix aligned\n", "1:prose"],
    ["lib.rs", "/* rustfmt::skip */\n", "1:prose"],
    ["main.go", "// rustfmt::skip\n", "1:prose"],
    ["mod.cpp", "// rustfmt::skip\n", "1:prose"],
  ]],
];

for (const [name, id, cases] of FORMS) {
  test(name, () => {
    assert.ok(DIRECTIVES.some(rule => rule.id === id), id);
    for (const [path, text, expected] of cases) assert.equal(kinds(path, text), expected, `${path}: ${JSON.stringify(text)}`);
  });
}

test("every directive rule names its tool and a documented source, and a test above exercises it", () => {
  const exercised = new Set(FORMS.flatMap(([, , cases]) => cases.flatMap(([, , expected]) => expected.split(" ").flatMap(k => k.split(":")[1].split("+")))));
  for (const rule of DIRECTIVES) {
    assert.ok(rule.tool && rule.cite && rule.languages.length && rule.kinds.length && rule.where, rule.id);
    assert.ok(exercised.has(rule.id), `no test accepts a ${rule.id} form`);
  }
});

test("a comment of several # segments is a directive only when every segment is a directive or a pointer", () => {
  assert.equal(kinds("a.py", "x = f()  # type: ignore  # noqa: E501  # D-0016\n"), "1:type-ignore");
  assert.equal(kinds("a.py", "x = f()  # D-0016  # noqa\n"), "1:noqa");
  assert.equal(kinds("a.py", "x = f()  # noqa  # because\n"), "1:prose");
  assert.equal(kinds("a.py", "x = f()  # D-0016  # P-0001\n"), "1:pointer");
});
