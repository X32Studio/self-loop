// D-0016, D-0023, D-0064, D-0067, D-0069, R-0006-judge, design/driver.md#directives

const ID = String.raw`(?:(?:D|P|F|L|I|B|T|PR)-\d{4,}|R-\d{4,}(?:-[a-z]+)*|SL-\d{2,}|W-[0-9a-f]{10})`;
const ANCHOR = String.raw`(?:design|docs)\/(?:[\w.-]+\/)*[\w.-]+\.md#[\p{L}\p{N}_.-]+`;
const PRODUCT = String.raw`(?:ExampleApp|example-app|self-loop)`;
export const REFERENCE = new RegExp(String.raw`(?<![\p{L}\p{N}_])(?:${PRODUCT}[\s:]+)?(?:${ID}|${ANCHOR})(?![\p{L}\p{N}_])`, "gu");
const SEPARATORS = /^[\s,;:./|·*=#~+_()[\]<>!&-]*$/u;
export const isPointer = text => SEPARATORS.test(text.replace(REFERENCE, " "));

const re = (source, flags = "") => new RegExp(source, flags);
const RULE = String.raw`[\w@/.-]+`;
const RULES = String.raw`${RULE}(?:\s*,\s*${RULE})*`;
const LINE_RULES = String.raw`${RULE}(?:[ \t]*,[ \t]*${RULE})*`;
const JUSTIFY = String.raw`(?:\s+-{2,}\s+(?<tail>[\s\S]*?))?`;
const LINE_JUSTIFY = String.raw`(?:[ \t]+-{2,}[ \t]+(?<tail>.*?))?`;
const NAMES = String.raw`[\w$]+(?:\s*:\s*\w+)?(?:\s*,\s*[\w$]+(?:\s*:\s*\w+)?)*`;
const PRESERVE = String.raw`(?:\s+--\s+@preserve)?`;
const WEBPACK_VALUE = String.raw`(?:"[^"]*"|'[^']*'|true|false|-?\d+(?:\.\d+)?|\/(?:[^/\\\n]|\\.)+\/[a-z]*|\[[^\]]*\])`;
const WEBPACK = String.raw`webpack[A-Z]\w*\s*:\s*${WEBPACK_VALUE}(?:\s*,\s*webpack[A-Z]\w*\s*:\s*${WEBPACK_VALUE})*`;
const JSDOC_TYPE = String.raw`\{(?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*\}`;
const JSDOC_TAG = re(String.raw`^@(?:(?:type|satisfies|enum|this|extends|augments|implements|returns?)\s+${JSDOC_TYPE}`
  + String.raw`|(?:param|arg|argument|property|prop)\s+${JSDOC_TYPE}\s+(?:\[[\w$.]+(?:=[^\]]*)?\]|[\w$.]+)`
  + String.raw`|typedef\s+(?:${JSDOC_TYPE}\s+)?[\w$]+|template\s+(?:${JSDOC_TYPE}\s+)?[\w$]+(?:\s*,\s*[\w$]+)*`
  + String.raw`|import\s+.+\s+from\s+(?:"[^"]*"|'[^']*')|callback\s+[\w$]+`
  + String.raw`|overload|override|readonly|private|protected|public|abstract|deprecated)\s*$`);
const SHELLCHECK_CODE = String.raw`(?:SC)?\d+(?:-(?:SC)?\d+)?`;
const SHELLCHECK_VALUE = String.raw`(?:"[^"\n]*"|'[^'\n]*'|[^\s#]+)`;
const SHELLCHECK_KEY = String.raw`(?:disable=(?:all|${SHELLCHECK_CODE})(?:,(?:all|${SHELLCHECK_CODE}))*|enable=(?:"[\w,-]+"|'[\w,-]+'|[\w,-]+)`
  + String.raw`|source=${SHELLCHECK_VALUE}|source-path=${SHELLCHECK_VALUE}|shell=[^\s#]+|external-sources=(?:true|false)|extended-analysis=(?:true|false))`;
const PY_CODES = String.raw`[A-Z]+[0-9]+(?:[,\s]+[A-Z]+[0-9]+)*`;
const NOQA = "[nN][oO][qQ][aA]";
const PYLINT = String.raw`(?:(?:disable|enable|disable-next|disable-msg|enable-msg)\s*=\s*[\w-]+(?:\s*,\s*[\w-]+)*|skip-file)`;
const MYPY_FLAG = String.raw`[\w-]+(?:=(?:"[^"]*"|[\w.,-]+))?`;
const SQLFLUFF_NOQA = String.raw`noqa(?:\s*:\s*(?:(?:disable|enable)=[\w.,*]+|[\w.*]+(?:\s*,\s*[\w.*]+)*))?`;
const TYPE_COMMENT = /^[\w.[\], ()\->|*'"]+$/;
const SPDX_LICENSE = String.raw`\(*[\w.+:-]+\)*`;
const SPDX_EXPRESSION = String.raw`${SPDX_LICENSE}(?:\s+(?:AND|OR|WITH|and|or|with)\s+${SPDX_LICENSE})*`;
const GO_BUILD_TAG = String.raw`[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*`;
const GO_BUILD_TERM = String.raw`(?:\([ \t]*|![ \t]*)*${GO_BUILD_TAG}(?:[ \t]*\))*`;
const GO_BUILD_EXPR = String.raw`${GO_BUILD_TERM}(?:[ \t]*(?:&&|\|\|)[ \t]*${GO_BUILD_TERM})*`;
const GO_PLUS_BUILD = String.raw`!?${GO_BUILD_TAG}(?:,!?${GO_BUILD_TAG})*(?:[ \t]+!?${GO_BUILD_TAG}(?:,!?${GO_BUILD_TAG})*)*`;
const GO_LINTERS = String.raw`[\w-]+(?:[ \t]*,[ \t]*[\w-]+)*`;
const CLANG_TIDY_CHECKS = String.raw`-?[\w.*-]+(?:\s*,\s*-?[\w.*-]+)*`;
const KTLINT_RULE = String.raw`(?:[a-z][a-z0-9-]*:[a-z][a-z0-9-]*|[a-z][a-z0-9]*-[a-z0-9-]+|annotation|filename|indent|wrapping)`;
const CHECKSTYLE_CHECK = String.raw`(?:[A-Z]\w*|\.\*)`;
const CHECKSTYLE_CHECKS = String.raw`${CHECKSTYLE_CHECK}(?:[ \t]*[,|][ \t]*${CHECKSTYLE_CHECK})*`;

const JS_FILES = /(?:\.[mc]?js|(?:^|\/)[^./]+)$/;
const ALL_LANGUAGES = ["js", "swift", "shell", "yaml", "python", "sql", "css", "html", "go", "rust", "c", "cpp", "java", "kotlin", "toml"];
const LINE_LANGUAGES = ALL_LANGUAGES.filter(lang => lang !== "html");

const balancedParens = expr => {
  let depth = 0;
  for (const ch of expr) {
    if (ch === "(") depth++;
    else if (ch === ")" && --depth < 0) return false;
  }
  return depth === 0;
};

export const DIRECTIVES = [
  { id: "interpreter", tool: "the kernel's execve and each language's hashbang grammar", cite: "man 2 execve, Interpreter scripts; ECMAScript Hashbang Grammar",
    languages: ["js", "shell", "python", "swift", "rust", "kotlin"], kinds: ["hashbang"], where: "line1", pattern: /^#!.*$/ },

  { id: "ts-ignore-line", tool: "TypeScript", cite: "typescriptlang.org/docs/handbook/release-notes/typescript-3-9.html#-ts-expect-error-comments; typescript scanner commentDirectiveRegExSingleLine",
    languages: ["js"], kinds: ["line"], where: "any", pattern: /^\/\/\/?\s*@ts-(?:expect-error|ignore)(?<tail>.*)$/ },
  { id: "ts-ignore-block", tool: "TypeScript", cite: "typescript scanner commentDirectiveRegExMultiLine, read on the last line of the comment",
    languages: ["js"], kinds: ["block"], where: "any", pattern: /^\/\*(?<head>(?:.*\n)*?)[ \t]*[/*]*[ \t]*@ts-(?:expect-error|ignore)(?<tail>[^\n]*?)\*\/$/ },
  { id: "ts-check", tool: "TypeScript", cite: "typescriptlang.org/docs/handbook/intro-to-js-ts.html#ts-check; typescript singleLinePragmaRegEx over the file's leading comments",
    languages: ["js"], kinds: ["line"], where: "head", pattern: /^\/\/\/?\s*@ts-(?:no)?check(?<tail>(?:[^\S\r\n]|:).*)?$/i },
  { id: "ts-triple-slash", tool: "TypeScript", cite: "typescriptlang.org/docs/handbook/triple-slash-directives.html; typescript tripleSlashXMLCommentStartRegEx and commentPragmas",
    languages: ["js"], kinds: ["line"], where: "head",
    pattern: /^\/\/\/\s*<(?<name>reference|amd-module|amd-dependency)(?<args>(?:\s+[\w-]+\s*=\s*(?:"[^"]*"|'[^']*'))+)\s*\/>(?<tail>.*)$/i,
    accept: groups => {
      const allowed = { reference: ["types", "lib", "path", "no-default-lib", "resolution-mode", "preserve"], "amd-module": ["name"], "amd-dependency": ["path", "name"] }[groups.name.toLowerCase()];
      return [...groups.args.matchAll(/([\w-]+)\s*=/g)].every(([, name]) => allowed.includes(name.toLowerCase()));
    } },
  { id: "jsx-pragma", tool: "Babel and TypeScript JSX pragmas", cite: "babeljs.io/docs/babel-plugin-transform-react-jsx#customizing-with-the-classic-runtime; typescript commentPragmas jsx, jsxfrag, jsximportsource, jsxruntime",
    languages: ["js"], kinds: ["line", "block"], where: "any", body: /^\*?\s*@jsx(?:Frag|ImportSource|Runtime)?\s+\S+\s*$/ },
  { id: "jsdoc-types", tool: "TypeScript JSDoc types in JavaScript files", cite: "typescriptlang.org/docs/handbook/jsdoc-supported-types.html",
    languages: ["js"], kinds: ["block"], where: "any", files: JS_FILES, pattern: /^\/\*\*(?!\/)[\s\S]*\*\/$/,
    accept: (groups, raw) => {
      const lines = raw.slice(3, -2).split("\n").map(line => line.replace(/^\s*\*?\s*/, "").trim()).filter(Boolean);
      return lines.some(line => JSDOC_TAG.test(line)) && lines.every(line => JSDOC_TAG.test(line) || isPointer(line));
    } },

  { id: "eslint-line", tool: "ESLint and oxlint", cite: "eslint.org/docs/latest/use/configure/rules#disabling-rules (line comments carry only eslint-disable-line and eslint-disable-next-line); oxc.rs/docs/guide/usage/linter.html",
    languages: ["js"], kinds: ["line"], where: "any", pattern: re(String.raw`^\/\/\s*(?:eslint|oxlint)-disable(?:-next)?-line(?:[ \t]+${LINE_RULES})?${LINE_JUSTIFY}[ \t]*$`) },
  { id: "eslint-block", tool: "ESLint and oxlint", cite: "eslint.org/docs/latest/use/configure/rules#using-configuration-comments-1 and #disabling-rules",
    languages: ["js"], kinds: ["block"], where: "any", pattern: re(String.raw`^\/\*\s*(?:eslint|oxlint)-(?:disable|enable)(?:\s+${RULES})?${JUSTIFY}\s*\*\/$`) },
  { id: "eslint-block-line", tool: "ESLint and oxlint", cite: "eslint.org/docs/latest/use/configure/rules#disabling-rules (a block eslint-disable-line must not span lines)",
    languages: ["js"], kinds: ["block"], where: "any", pattern: re(String.raw`^\/\*[ \t]*(?:eslint|oxlint)-disable(?:-next)?-line(?:[ \t]+${LINE_RULES})?${LINE_JUSTIFY}[ \t]*\*\/$`) },
  { id: "tslint", tool: "TSLint", cite: "palantir.github.io/tslint/usage/rule-flags/",
    languages: ["js"], kinds: ["line", "block"], where: "any", body: /^\s*tslint:(?:disable|enable)(?:-line|-next-line)?(?::[\w-]+(?:\s+[\w-]+)*)?\s*$/ },
  { id: "eslint-config", tool: "ESLint", cite: "eslint.org/docs/latest/use/configure/rules#using-configuration-comments-1; eslint.org/docs/latest/use/configure/language-options#using-configuration-comments",
    languages: ["js"], kinds: ["block"], where: "any",
    pattern: re(String.raw`^\/\*\s*(?:eslint\s+${RULE}\s*:[\s\S]+?|globals?(?:\s+${NAMES})?|exported(?:\s+${NAMES})?|eslint-env(?:\s+${RULES})?)${JUSTIFY}\s*\*\/$`) },
  { id: "prettier-ignore-js", tool: "Prettier", cite: "prettier.io/docs/ignore#javascript",
    languages: ["js"], kinds: ["line", "block"], where: "any", body: /^\*?\s*prettier-ignore\s*$/ },
  { id: "istanbul", tool: "istanbul (nyc)", cite: "github.com/istanbuljs/nyc#parsing-hints-ignoring-lines; istanbul-lib-instrument COMMENT_RE",
    languages: ["js"], kinds: ["line", "block"], where: "any", body: re(String.raw`^\s*istanbul\s+ignore\s+(?:if|else|next|file)${PRESERVE}(?<tail>(?:\W[\s\S]*)?)$`) },
  { id: "c8", tool: "c8 (v8-to-istanbul)", cite: "github.com/bcoe/c8#ignoring-uncovered-lines-functions-and-blocks",
    languages: ["js"], kinds: ["block"], where: "any", pattern: re(String.raw`^\/\* c8 ignore (?:next(?: \d+)?|start|stop)${PRESERVE}(?<tail>\s[\s\S]*?)?\s*\*\/$`) },
  { id: "v8", tool: "Vitest coverage-v8", cite: "vitest.dev/guide/coverage#ignoring-code",
    languages: ["js"], kinds: ["block"], where: "any", pattern: re(String.raw`^\/\* v8 ignore (?:next(?: \d+)?|start|stop|if|else|file)${PRESERVE}(?<tail>\s[\s\S]*?)?\s*\*\/$`) },
  { id: "node-coverage", tool: "Node.js test runner coverage", cite: "nodejs.org/docs/latest-v24.x/api/test.html#collecting-code-coverage; node lib/internal/test_runner/coverage.js kIgnoreRegex and kStatusRegex",
    languages: ["js"], kinds: ["block"], where: "any", pattern: /^\/\* node:coverage (?:ignore next (?:\d+ )?|enable |disable )\*\/$/ },
  { id: "pure-annotation", tool: "Rollup, esbuild and terser annotations", cite: "rollupjs.org/configuration-options/#treeshake-annotations; esbuild.github.io/api/#ignore-annotations",
    languages: ["js"], kinds: ["line", "block"], where: "any", body: /^\s*[#@]__(?:PURE|NO_SIDE_EFFECTS)__\s*$/ },
  { id: "source-map-url", tool: "source maps (ECMA-426)", cite: "tc39.es/ecma426/#sec-linking-generated-code; node lib/internal/source_map/source_map_cache.js kSourceMappingURLMagicComment",
    languages: ["js", "css"], kinds: ["line", "block"], where: "any", body: /^[#@]\s*source(?:Mapping)?URL=\S+\s*$/ },
  { id: "webpack-magic", tool: "webpack magic comments", cite: "webpack.js.org/api/module-methods/#magic-comments",
    languages: ["js"], kinds: ["line", "block"], where: "any", body: re(String.raw`^\s*${WEBPACK}\s*$`) },
  { id: "vite-ignore", tool: "Vite", cite: "vite.dev/guide/features.html#dynamic-import (import(/* @vite-ignore */ path))",
    languages: ["js"], kinds: ["line", "block"], where: "any", body: /^\s*@vite-ignore\s*$/ },
  { id: "flow", tool: "Flow", cite: "flow.org/en/docs/usage/#toc-prepare-your-code-for-flow",
    languages: ["js"], kinds: ["line", "block"], where: "head", body: /^\*?\s*@(?:flow(?:\s+strict(?:-local)?)?|noflow)\s*$/ },
  { id: "format-pragma", tool: "Prettier pragmas", cite: "prettier.io/docs/options#require-pragma",
    languages: ["js"], kinds: ["block"], where: "head", body: /^\*?\s*@(?:format|prettier)\s*$/ },
  { id: "test-environment", tool: "Jest and Vitest environments", cite: "jestjs.io/docs/configuration#testenvironment-string; vitest.dev/guide/environment.html#environments-for-specific-files",
    languages: ["js"], kinds: ["line", "block"], where: "any", body: /^\*?\s*@(?:jest|vitest)-environment\s+[\w./@-]+\s*$/ },
  { id: "clang-format", tool: "clang-format", cite: "clang.llvm.org/docs/ClangFormatStyleOptions.html#disabling-formatting-on-a-piece-of-code",
    languages: ["js", "c", "cpp", "java"], kinds: ["line", "block"], where: "any", pattern: /^(?:\/\/ clang-format (?:off|on)(?<tail>:.*)?[ \t]*|\/\* clang-format (?:off|on) \*\/)$/ },
  { id: "biome", tool: "Biome", cite: "biomejs.dev/analyzer/suppressions/",
    languages: ["js", "css"], kinds: ["line", "block"], where: "any", body: /^\s*biome-ignore(?:-all|-start|-end)?(?:\s+[\w/()-]+)+\s*:(?<tail>[\s\S]*)$/ },
  { id: "deno", tool: "Deno", cite: "docs.deno.com/runtime/reference/cli/lint/#ignore-directives; docs.deno.com/runtime/reference/cli/fmt/#ignoring-code",
    languages: ["js"], kinds: ["line"], where: "any", pattern: /^\/\/\s*deno-(?:lint-ignore(?:-file)?(?:[ \t]+[\w-]+)*|fmt-ignore(?:-file)?)[ \t]*$/ },

  { id: "go-generate", tool: "go generate", cite: "pkg.go.dev/cmd/go#hdr-Generate_Go_files_by_processing_source",
    languages: ["go"], kinds: ["line"], where: "own", pattern: /^\/\/go:generate[ \t]+\S.*$/ },
  { id: "go-embed", tool: "Go embed", cite: "pkg.go.dev/embed#hdr-Directives",
    languages: ["go"], kinds: ["line"], where: "own", pattern: /^\/\/go:embed[ \t]+\S.*$/ },
  { id: "go-build", tool: "Go build constraints", cite: "pkg.go.dev/go/build#hdr-Build_Constraints; pkg.go.dev/cmd/go#hdr-Build_constraints",
    languages: ["go"], kinds: ["line"], where: "head",
    pattern: re(String.raw`^(?:\/\/go:build[ \t]+(?<expr>${GO_BUILD_EXPR})|\/\/[ \t]+\+build[ \t]+${GO_PLUS_BUILD})[ \t]*$`),
    accept: groups => !groups.expr || balancedParens(groups.expr) },
  { id: "go-nolint", tool: "golangci-lint", cite: "golangci-lint.run/usage/false-positives/#nolint-directive",
    languages: ["go"], kinds: ["line"], where: "any",
    pattern: re(String.raw`^\/\/[ \t]*nolint(?::[ \t]*${GO_LINTERS})?(?:(?:[ \t]*\/\/|[ \t]+--)[ \t]*(?<tail>.*))?[ \t]*$`) },

  { id: "clang-tidy-nolint", tool: "clang-tidy", cite: "clang.llvm.org/extra/clang-tidy/#suppressing-undesired-diagnostics",
    languages: ["c", "cpp"], kinds: ["line", "block"], where: "any",
    body: re(String.raw`^\s*NOLINT(?:NEXTLINE|BEGIN|END)?(?:\s*\(\s*${CLANG_TIDY_CHECKS}\s*\))?(?<tail>(?:[\s:;/-][\s\S]*)?)$`) },

  { id: "ktlint", tool: "ktlint", cite: "pinterest.github.io/ktlint/latest/faq/#how-do-i-suppress-an-error-for-a-lineblockfile",
    languages: ["kotlin"], kinds: ["line", "block"], where: "any",
    body: re(String.raw`^\s*ktlint-(?:disable|enable)(?:[ \t]+${KTLINT_RULE}(?:[ \t]+${KTLINT_RULE})*)?(?:[ \t]+-{2,}[ \t]+(?<tail>[\s\S]*?))?\s*$`) },
  { id: "checkstyle", tool: "Checkstyle", cite: "checkstyle.org/filters/suppressioncommentfilter.html",
    languages: ["java"], kinds: ["line", "block"], where: "any",
    body: re(String.raw`^\s*(?:CHECKSTYLE:(?:OFF|ON)|checkstyle:(?:off|on))(?::[ \t]*${CHECKSTYLE_CHECKS}|[ \t]+${CHECKSTYLE_CHECKS})?(?:[ \t]+-{2,}[ \t]+(?<tail>[\s\S]*?))?\s*$`) },

  { id: "rustfmt-skip", tool: "rustfmt", cite: "rust-lang.github.io/rustfmt/#tips",
    languages: ["rust"], kinds: ["line"], where: "any",
    pattern: /^\/\/\s*rustfmt::skip(?:[ \t]+-{2,}[ \t]+(?<tail>.*?))?[ \t]*$/ },

  { id: "swift-tools-version", tool: "Swift Package Manager", cite: "github.com/swiftlang/swift-package-manager/blob/main/Documentation/Usage.md#swift-tools-version-specification",
    languages: ["swift"], kinds: ["line"], where: "line1", files: /(?:^|\/)Package(?:@swift-[\d.]+)?\.swift$/, pattern: /^\/\/\s*swift-tools-version\s*:\s*\d+(?:\.\d+){0,2}(?:\s*;\s*[\w.-]+)?\s*$/i },
  { id: "swiftlint", tool: "SwiftLint", cite: "github.com/realm/SwiftLint#disable-rules-in-code",
    languages: ["swift"], kinds: ["line"], where: "any", pattern: /^\/\/\s*swiftlint:(?:disable|enable)(?::(?:next|this|previous))?\s+(?:all|\w+(?:\s+\w+)*)(?:\s+-\s+(?<tail>.*?))?\s*$/ },
  { id: "swift-format", tool: "swift-format", cite: "github.com/swiftlang/swift-format/blob/main/Documentation/IgnoringSource.md",
    languages: ["swift"], kinds: ["line"], where: "any", pattern: /^\/\/\s*swift-format-ignore(?:-file)?(?:\s*:\s*\w+(?:\s*,\s*\w+)*)?\s*$/ },
  { id: "swiftformat", tool: "SwiftFormat", cite: "github.com/nicklockwood/SwiftFormat#comment-directives",
    languages: ["swift"], kinds: ["line"], where: "any", pattern: /^\/\/\s*swiftformat:(?:(?:disable|enable)(?::(?:next|this))?\s+(?:all|\w+(?:\s+\w+)*)|options(?:\s+--[\w-]+(?:\s+[^\s-]\S*)?)+|sort(?::(?:begin|end))?)\s*$/ },

  { id: "periphery", tool: "Periphery", cite: "github.com/peripheryapp/periphery#comment-commands",
    languages: ["swift"], kinds: ["line"], where: "any", pattern: /^\/\/\s*periphery:ignore(?::all|:parameters\s+\w+(?:\s*,\s*\w+)*)?(?:\s+-\s+(?<tail>.*?))?\s*$/ },

  { id: "shellcheck", tool: "ShellCheck", cite: "shellcheck.net/wiki/Directive; shellcheck.net/wiki/SC1126 (directives go before commands, not after)",
    languages: ["shell"], kinds: ["line"], where: "own", segment: "first", pattern: re(String.raw`^#\s*shellcheck\s+${SHELLCHECK_KEY}(?:\s+${SHELLCHECK_KEY})*\s*$`) },

  { id: "pep263", tool: "CPython source encoding (PEP 263)", cite: "peps.python.org/pep-0263/",
    languages: ["python"], kinds: ["line"], where: "coding", segment: "whole",
    pattern: /^#\s*(?:-\*-\s*(?:[\w-]+\s*:\s*[\w.-]+\s*;\s*)*coding[:=]\s*[-\w.]+\s*(?:;\s*[\w-]+\s*:\s*[\w.-]+\s*)*;?\s*-\*-|coding[:=]\s*[-\w.]+|vim?:\s*set\s+fileencoding=[-\w.]+\s*:)\s*$/ },
  { id: "type-ignore", tool: "mypy and pyright type: ignore", cite: "mypy.readthedocs.io/en/stable/error_codes.html#silencing-errors-based-on-error-codes; microsoft.github.io/pyright/#/comments",
    languages: ["python"], kinds: ["line"], where: "any", segment: "any", pattern: /^#\s*type:\s*ignore(?:\[[\w\s,-]*\])?\s*$/ },
  { id: "type-comment", tool: "PEP 484 type comments", cite: "peps.python.org/pep-0484/#type-comments",
    languages: ["python"], kinds: ["line"], where: "any", segment: "first", pattern: /^#\s*type:\s*(?!ignore\b)(?<type>[^#]*?)\s*$/,
    accept: groups => TYPE_COMMENT.test(groups.type) && !/\w\s+\w/.test(groups.type) },
  { id: "noqa", tool: "flake8 and Ruff noqa", cite: "flake8.pycqa.org/en/latest/user/violations.html#in-line-ignoring-errors; docs.astral.sh/ruff/linter/#error-suppression",
    languages: ["python"], kinds: ["line"], where: "any", segment: "any", pattern: re(String.raw`^#\s*${NOQA}(?:\s*:\s*${PY_CODES})?\s*$`) },
  { id: "file-noqa", tool: "flake8 and Ruff file exemptions", cite: "flake8.pycqa.org/en/latest/user/violations.html#ignoring-entire-files; docs.astral.sh/ruff/linter/#error-suppression",
    languages: ["python"], kinds: ["line"], where: "own", segment: "whole", pattern: re(String.raw`^#\s*(?:[fF][lL][aA][kK][eE]8|ruff)[:=]\s*${NOQA}(?:\s*:\s*${PY_CODES})?\s*$`) },
  { id: "pylint", tool: "Pylint", cite: "pylint.readthedocs.io/en/stable/user_guide/messages/message_control.html",
    languages: ["python"], kinds: ["line"], where: "any", segment: "any", pattern: re(String.raw`^#\s*pylint:\s*${PYLINT}(?:\s*;\s*${PYLINT})*\s*$`) },
  { id: "mypy-inline", tool: "mypy inline configuration", cite: "mypy.readthedocs.io/en/stable/inline_config.html (a line that starts with # mypy:)",
    languages: ["python"], kinds: ["line"], where: "col0", segment: "whole", pattern: re(String.raw`^# mypy: ${MYPY_FLAG}(?:\s*,\s*${MYPY_FLAG})*\s*$`) },
  { id: "pyright", tool: "Pyright", cite: "microsoft.github.io/pyright/#/comments",
    languages: ["python"], kinds: ["line"], where: "any", segment: "any", pattern: /^#\s*pyright:\s*(?:ignore(?:\[[\w\s,-]*\])?|basic|standard|strict|\w+\s*=\s*[\w"]+(?:\s*,\s*\w+\s*=\s*[\w"]+)*)\s*$/ },
  { id: "fmt", tool: "Black and the Ruff formatter", cite: "black.readthedocs.io/en/stable/the_black_code_style/current_style.html#code-style; docs.astral.sh/ruff/formatter/#format-suppression",
    languages: ["python"], kinds: ["line"], where: "any", segment: "any", pattern: /^#\s*fmt:\s*(?:off|on|skip)\s*$/ },
  { id: "isort", tool: "isort", cite: "pycqa.github.io/isort/docs/configuration/action_comments.html",
    languages: ["python"], kinds: ["line"], where: "any", segment: "any", pattern: /^#\s*(?:ruff:\s*)?isort:\s*(?:skip_file|skip|off|on|split|dont-add-imports(?::\s*\[.*\])?|dont-add-import:\s*\S.*)\s*$/ },
  { id: "nosec", tool: "Bandit", cite: "bandit.readthedocs.io/en/latest/config.html#exclusions",
    languages: ["python"], kinds: ["line"], where: "any", segment: "any", pattern: /^#\s*nosec(?::?\s*B\d{3}(?:\s*,\s*B\d{3})*)?\s*$/ },
  { id: "coverage-pragma", tool: "coverage.py", cite: "coverage.readthedocs.io/en/latest/excluding.html",
    languages: ["python"], kinds: ["line"], where: "any", segment: "any", pattern: /^#\s*(?:pragma|PRAGMA)[:\s]?\s*(?:no|NO)\s*(?:cover|COVER|branch|BRANCH)\s*$/ },

  { id: "yaml-language-server", tool: "the YAML language server", cite: "github.com/redhat-developer/yaml-language-server#using-a-modeline; src/languageservice/services/modelineUtil.ts isModeline over parser/yamlParser07.ts getDocumentHeaderComments at bf8ebb5 (since 1.24.0 a modeline after YAML content is ignored)",
    languages: ["yaml"], kinds: ["line"], where: "head", segment: "first", pattern: /^#\s+(?:yaml-language-server\s*:\s*\$schema(?:=|:[ \t]*)|\$schema:[ \t]*)\S+\s*$/ },
  { id: "yamllint", tool: "yamllint", cite: "yamllint.readthedocs.io/en/stable/disable_with_comments.html",
    languages: ["yaml"], kinds: ["line"], where: "any", segment: "whole", pattern: /^# yamllint (?:disable|enable|disable-line)(?: rule:\S+)*\s*$/ },
  { id: "yamllint-file", tool: "yamllint", cite: "yamllint.readthedocs.io/en/stable/disable_with_comments.html#disabling-all-checks-for-a-file",
    languages: ["yaml"], kinds: ["line"], where: "line1", segment: "whole", pattern: /^#\s*yamllint disable-file\s*$/ },
  { id: "prettier-ignore-yaml", tool: "Prettier", cite: "prettier.io/docs/ignore#yaml and #range-ignore",
    languages: ["yaml"], kinds: ["line"], where: "own", segment: "whole", pattern: /^#\s*prettier-ignore(?:-start|-end)?\s*$/ },

  { id: "stylelint", tool: "Stylelint", cite: "stylelint.io/user-guide/ignore-code",
    languages: ["css"], kinds: ["block"], where: "any", pattern: re(String.raw`^\/\*\s*stylelint-(?:disable|enable)(?:-line|-next-line)?(?:\s+${RULES})?${JUSTIFY}\s*\*\/$`) },
  { id: "prettier-ignore-css", tool: "Prettier", cite: "prettier.io/docs/ignore#css",
    languages: ["css"], kinds: ["block"], where: "any", pattern: /^\/\*\s*prettier-ignore\s*\*\/$/ },
  { id: "prettier-ignore-html", tool: "Prettier", cite: "prettier.io/docs/ignore#html",
    languages: ["html"], kinds: ["block"], where: "any", pattern: /^<!--\s*prettier-ignore(?:-attribute(?:\s+[^\s>]+)*)?\s*-->$/ },

  { id: "sqlfluff-noqa", tool: "SQLFluff", cite: "docs.sqlfluff.com/en/stable/configuration/ignoring_configuration.html#ignoring-types-of-errors",
    languages: ["sql"], kinds: ["line", "block"], where: "any", body: re(String.raw`^\s*${SQLFLUFF_NOQA}\s*$`) },
  { id: "sqlfluff-config", tool: "SQLFluff", cite: "docs.sqlfluff.com/en/stable/configuration/setting_configuration.html#in-file-configuration-directives",
    languages: ["sql"], kinds: ["line"], where: "col0", pattern: /^--\s?sqlfluff(?::[\w.,-]+)+\s*$/ },

  { id: "vim-modeline", tool: "Vim modelines", cite: "vimhelp.org/options.txt.html#modeline (the first and last 5 lines)",
    languages: ALL_LANGUAGES, kinds: ["line", "block"], where: "vim", segment: "whole",
    body: /^\s+(?:vim?|Vim|ex):\s*(?:set?\s+[^:]*:|\w+(?:=[^\s:]*)?(?:[\s:]+\w+(?:=[^\s:]*)?)*:?)\s*$/ },
  { id: "emacs-file-variables", tool: "Emacs file variables", cite: "gnu.org/software/emacs/manual/html_node/emacs/Specifying-File-Variables.html (the first line, or the second after an interpreter line)",
    languages: ALL_LANGUAGES, kinds: ["line", "block"], where: "emacs", segment: "whole",
    body: /^\s*-\*-\s*(?:[\w-]+|(?:[\w-]+\s*:\s*[^;\s][^;]*?\s*;\s*)*[\w-]+\s*:\s*[^;\s][^;]*?\s*;?)\s*-\*-\s*$/ },
  { id: "spdx", tool: "SPDX and REUSE file tags", cite: "spdx.github.io/spdx-spec/v2.3/using-SPDX-short-identifiers-in-source-files/; spdx.github.io/spdx-spec/v2.3/SPDX-license-expressions/; reuse.software/spec-3.3/ (comment headers, snippets, ignore blocks); D-0029",
    languages: ALL_LANGUAGES, kinds: ["line", "block"], where: "any", segment: "whole",
    lines: re(String.raw`^(?:SPDX-(?:License-Identifier:\s*${SPDX_EXPRESSION}|(?:File|Snippet)CopyrightText:\s*\S.*|FileContributor:\s*\S.*|Snippet(?:Begin|End))|REUSE-Ignore(?:Start|End))\s*$`) },
  { id: "noinspection", tool: "JetBrains IDE inspections", cite: "jetbrains.com/help/idea/disabling-and-enabling-inspections.html#suppress-in-editor",
    languages: LINE_LANGUAGES, kinds: ["line"], where: "own", segment: "whole", body: /^\s*noinspection\s+\w+(?:\s*,\s*\w+)*\s*$/ },
  { id: "cspell", tool: "CSpell", cite: "cspell.org/docs/Configuration/document-settings",
    languages: ALL_LANGUAGES, kinds: ["line", "block"], where: "any", segment: "whole",
    body: /^\s*(?:cspell|spell-checker):\s*(?:disable|enable|disable-next-line|disable-line|(?:ignore|words|flagWords|ignoreRegExp|locale|dictionaries)\s+\S.*)\s*$/ },
];

const MODELINE_LINES = 5;

function placed(where, ctx) {
  switch (where) {
    case "any": return true;
    case "line1": return ctx.line === 1;
    case "head": return ctx.head;
    case "own": return ctx.own;
    case "col0": return ctx.column === 0;
    case "coding": return ctx.line === 1 || (ctx.line === 2 && /^[ \t\f]*(?:#.*)?\r?$/.test(ctx.firstLine));
    case "emacs": return ctx.line === 1 || (ctx.line === 2 && ctx.firstLine.startsWith("#!"));
    case "vim": return ctx.line <= MODELINE_LINES || ctx.line > ctx.lines - MODELINE_LINES;
    default: return false;
  }
}

const bodyOf = (raw, open, close) => {
  let text = open && raw.startsWith(open) ? raw.slice(open.length) : raw;
  if (close && text.endsWith(close)) text = text.slice(0, -close.length);
  return text;
};

function matches(rule, text, open, close) {
  if (rule.lines) {
    const parts = bodyOf(text, open, close).split("\n").map(line => line.replace(/^\s*\*?/, "").trim()).filter(Boolean);
    return parts.some(part => rule.lines.test(part)) && parts.every(part => rule.lines.test(part) || isPointer(part));
  }
  const found = rule.pattern ? rule.pattern.exec(text) : rule.body.exec(bodyOf(text, open, close));
  if (!found) return false;
  const groups = found.groups ?? {};
  if (!Object.entries(groups).every(([name, value]) => !/^(?:tail|head)/.test(name) || value === undefined || isPointer(value))) return false;
  return !rule.accept || rule.accept(groups, text);
}

const applies = (rule, ctx, kind) => rule.languages.includes(ctx.language) && rule.kinds.includes(kind) && (!rule.files || rule.files.test(ctx.path)) && placed(rule.where, ctx);

const HASH_LANGUAGES = new Set(["shell", "python", "yaml", "toml"]);

export function directiveOf(span, raw, ctx) {
  const candidates = DIRECTIVES.filter(rule => applies(rule, ctx, span.kind));
  if (!candidates.length) return null;
  if (span.kind === "line" && span.open === "#" && HASH_LANGUAGES.has(ctx.language)) {
    const segments = raw.split(/(?<=\s)(?=#)/).map(segment => segment.trim());
    let found = null;
    for (const [index, segment] of segments.entries()) {
      const rule = candidates.find(r => (r.segment === "any" || (r.segment === "first" && index === 0) || ((r.segment ?? "whole") === "whole" && segments.length === 1))
        && matches(r, segment, "#", ""));
      if (rule) found ??= rule;
      else if (!isPointer(segment.slice(1))) return null;
    }
    return found;
  }
  return candidates.find(rule => matches(rule, raw, span.open, span.close)) ?? null;
}
