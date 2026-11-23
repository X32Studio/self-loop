# Round 7 package B acceptance

```ts
type SourceWitness = {
  accepted: Record<string, string>;
  refused: Record<string, string>;
  finding: { file: string; line: number; text: string };
};
type HostWitness = {
  snapshot: { cores: number; load: number; availableGB: number; freeGB?: number };
  registry: { maxLoadRatio?: number; minAvailableMemoryGB?: number; heavyBudget?: number };
  heavyWorkDue: boolean;
  expectedHeavySuggestion: boolean;
};
type BlockerHistory = {
  opened: string[];
  closed: string[];
  shelved: string[];
  expectedOpen: string[];
};
```

Source witnesses run through the actor's prepared `call.mjs record`. The refusal must identify the real
comment, leave the product ref intact and keep the worktree for a retry. The accepted retry must publish
the exact fixture bytes. Host witnesses run through `self-loop.mjs next` and `start`. A preload only
models host readings at Node's built-in OS boundaries and the Linux counters. The test inspects the
commands offered rather than coupling to the driver's policy or intermediate state. The blocker fixture
uses the documented C4 rows to test the reader independently of C4's append command.

The directory suite discovers the three `round7-b-*.test.mjs` files. Use the existing runner for timings
and repeatability across seeds.

```sh
node --test --test-name-pattern='R7-B[4-8]-' acceptance
node acceptance/run.mjs --seeds 101,202,303 acceptance/index.js '--test-name-pattern=R7-B[4-8]-'
```

| ID | Surface | Label | flow: realistic attack | loss: | Expected property |
| --- | --- | --- | --- | --- | --- |
| R7-B4-01 | Literals | fresh | An actor records a display string with a continued line in a CRLF source file. | false-verdict | The literal slashes pass and an actual JS comment is refused. |
| R7-B4-02 | Literals | ordered | An actor records a multiline template of release notes. | false-verdict | Template text passes and an actual JS comment is refused. |
| R7-B4-03 | Literals | fresh | An actor records a slash-matching regex in a streaming loop. | false-verdict | The for-await loop body is recognized as a regex. |
| R7-B4-04 | Literals | fresh | An actor records a shell script that emits a release note beginning with a Markdown heading. | false-verdict | Quote removal yields the complete here-document delimiter and the heading remains data. |
| R7-B4-05 | Literals | ordered | An actor records a generated YAML list of references containing hash suffixes. | false-verdict | Plain scalar values pass and a separate YAML comment is refused. |
| R7-B4-06 | Literals | fresh | An actor records reusable labels using a YAML anchor and an explicit string tag. | false-verdict | Quoted scalars remain strings after both kinds of node property. |
| R7-B4-07 | Literals | fresh | An actor records a reusable, indented YAML block of display text. | false-verdict | The block after an anchor is scalar data. |
| R7-B4-08 | Literals | ordered | An actor records a Python tool whose module help has a heading. | false-verdict | The docstring passes and a separate Python comment is refused. |
| R7-B4-09 | Literals | fresh | An actor records a Python 3.12 display label using a dict key in an f-string. | false-verdict | A hash inside the nested string is data. |
| R7-B4-10 | Literals | fresh | An actor records a PostgreSQL query that returns multiline text using a localized delimiter tag. | false-verdict | Both SQL string forms pass and a real SQL comment is refused. |
| R7-B4-11 | Literals | fresh | An actor records CSS display text split across Windows line endings. | false-verdict | The continuation keeps the marker inside the string. |
| R7-B4-12 | Literals | fresh | An actor records an HTML editor with a default textarea value containing markup-like text. | false-verdict | Textarea and title data pass. |
| R7-B4-13 | Literals | ordered | An actor records default values in HTML attributes. | false-verdict | Quoted attribute data passes and an HTML comment is refused. |
| R7-B4-14 | Literals | fresh | An actor records an HTML document with inline JavaScript and a continued display label. | false-verdict | Script data passes while an actual JS comment in the element is refused. |
| R7-B4-15 | Literals | fresh | An actor records an HTML document with inline CSS and a continued display label. | false-verdict | Style data passes while an actual CSS comment in the element is refused. |
| R7-B5-01 | Directives | ordered | An actor records a new shell entry point or moves its interpreter line down during an edit. | false-verdict | Only the starting interpreter line passes. |
| R7-B5-02 | Directives | ordered | An actor disables a JS lint rule in a helper and encounters an old copied suppression in CSS. | false-verdict | ESLint's disable block passes in its source language. |
| R7-B5-03 | Directives | ordered | An actor restores the rule after one call and carries a copied marker into a stylesheet. | false-verdict | ESLint's enable block passes in its source language. |
| R7-B5-04 | Directives | ordered | An actor adds a next-line suppression for a fixture and links the decision. | false-verdict | A pointer description passes and a prose reason is refused. |
| R7-B5-05 | Directives | ordered | An actor suppresses lint on one JS statement while porting a similar helper to Python. | false-verdict | ESLint's same-line form passes in JS and is refused in Python. |
| R7-B5-06 | Directives | fresh | An actor links a TypeScript negative test to a decision and another edit moves the marker into a block's middle. | false-verdict | The colon and pointer are accepted in the consumed line. The marker in the middle of a block is prose. |
| R7-B5-07 | Directives | ordered | An actor adds a TypeScript suppression and copies a similar fixture to Python. | false-verdict | TypeScript's ignore form is refused in Python. |
| R7-B5-08 | Directives | ordered | An actor opts a JS module into TypeScript checking. | false-verdict | The comment passes before code and is refused after it. |
| R7-B5-09 | Directives | ordered | An actor opts a fixture out of TypeScript checking. | false-verdict | The comment passes before code and is refused after it. |
| R7-B5-10 | Directives | ordered | An actor adds a file dependency for a TypeScript test. | false-verdict | A leading triple-slash reference passes. A trailing one is refused. |
| R7-B5-11 | Directives | fresh | An actor preserves a TypeScript library directive across declaration emit and encounters a two-slash typo. | false-verdict | The documented preserve attribute passes and the two-slash form is refused. |
| R7-B5-12 | Directives | ordered | An actor adds a TypeScript declaration package reference and moves it while rearranging declarations. | false-verdict | Only a leading triple-slash reference passes. |
| R7-B5-13 | Directives | ordered | An actor writes a default-library marker for declarations. | false-verdict | Only a leading triple-slash mark passes. |
| R7-B5-14 | Directives | ordered | An actor suppresses two lines of platform-specific coverage in a Node test. | false-verdict | A block comment passes and the same text in a line comment is refused. |
| R7-B5-15 | Directives | ordered | An actor brackets a platform-specific coverage range in Node. | false-verdict | Both coverage control blocks pass and the line-comment enable is refused. |
| R7-B5-16 | Directives | ordered | An actor excludes an environment-only JS statement from Istanbul. | false-verdict | Istanbul's ignore-next passes and the CSS copy is refused. |
| R7-B5-17 | Directives | ordered | An actor excludes the next two lines from converted V8 coverage. | false-verdict | The counted directive passes in JS and is refused in CSS. |
| R7-B5-18 | Directives | ordered | An actor maintains a repository using the older c8 coverage spelling. | false-verdict | The original c8 spelling passes in JS and is refused in CSS. |
| R7-B5-19 | Directives | ordered | An actor suppresses a deliberate shell word split and tries moving the comment inline. | false-verdict | ShellCheck consumes the preceding comment and the suffix is refused. |
| R7-B5-20 | Directives | ordered | An actor suppresses two Ruff import checks in Python and encounters the same marker in ported JS. | false-verdict | A coded inline noqa passes only in the Python fixture. |
| R7-B5-21 | Directives | ordered | An actor suppresses all Ruff checks for an import in a fixture. | false-verdict | Bare inline noqa passes in Python and is refused in JS. |
| R7-B5-22 | Directives | ordered | An actor suppresses a specific mypy assignment diagnostic in a Python fixture. | false-verdict | The coded ignore passes in Python and is refused in JS. |
| R7-B5-23 | Directives | ordered | An actor suppresses an inline mypy diagnostic while maintaining Python and shell wrappers. | false-verdict | The uncoded ignore passes in Python and is refused in shell. |
| R7-B5-24 | Directives | ordered | An actor configures a YAML schema and moves the modeline down during an edit. | false-verdict | The modeline passes before YAML content and is refused after it. |
| R7-B5-25 | Directives | ordered | An actor brackets a deliberate cast with SwiftLint suppressions. | false-verdict | SwiftLint's range forms pass in Swift and are refused in JS. |
| R7-B5-26 | Directives | ordered | An actor suppresses the next Swift line. | false-verdict | The scoped SwiftLint form passes in Swift and is refused in JS. |
| R7-B5-27 | Directives | ordered | An actor suppresses a cast inline in Swift. | false-verdict | The scoped SwiftLint form passes in Swift and is refused in JS. |
| R7-B5-28 | Directives | ordered | An actor suppresses the preceding Swift line. | false-verdict | The scoped SwiftLint form passes in Swift and is refused in JS. |
| R7-B5-29 | Directives | ordered | An actor records equivalent JS and CSS fixtures and a suppression was copied to CSS. | false-verdict | ESLint's next-line form passes in JS and is refused in CSS. |
| R7-B5-30 | Directives | fresh | An actor moves a TypeScript suppression between the first and last lines of a block comment. | false-verdict | The marker passes on the last line and is refused on the first. |
| R7-B5-31 | Directives | fresh | An actor checks in a schema modeline shared by IntelliJ and YAML Language Server users. | false-verdict | YAML Language Server's alternate spelling passes before YAML content only. |
| R7-B5-32 | Directives | ordered | An actor excludes the platform-specific if branch from Istanbul. | false-verdict | Istanbul's branch hint passes in the JS condition's leading comment. |
| R7-B5-33 | Directives | ordered | An actor excludes the fallback else branch from Istanbul. | false-verdict | Istanbul's branch hint passes in the JS condition's leading comment. |
| R7-B5-34 | Directives | ordered | An actor excludes a platform-only file from Istanbul. | false-verdict | A file-level block passes in JS and is refused in CSS. |
| R7-B5-35 | Directives | ordered | An actor excludes a range of generated branches under the old c8 spelling. | false-verdict | The start and stop blocks pass in JS and are refused in CSS. |
| R7-B5-36 | Directives | ordered | An actor excludes a range from converted V8 coverage. | false-verdict | The start and stop blocks pass in JS and are refused in CSS. |
| R7-B6-01 | Budget | ordered | The lead requests next steps while the one-minute load is just under the configured core-scaled limit. | false-verdict | Heavy steps remain offered. |
| R7-B6-02 | Budget | ordered | The lead requests next steps at the default one-minute limit with 16 GiB available. | false-verdict | The load boundary is inclusive. |
| R7-B6-03 | Budget | ordered | The lead requests next steps when host load first exceeds the default. | wrong-result | No critic, judge or suite launch is suggested. |
| R7-B6-04 | Budget | ordered | The lead requests next steps while a quiet host is short of available memory. | wrong-result | A low load reading does not admit heavy work under the memory floor. |
| R7-B6-05 | Budget | ordered | The lead returns when the memory floor is cleared. | false-verdict | Heavy steps become available. |
| R7-B6-06 | Budget | fresh | The lead starts work on a host with a large reclaimable cache. | false-verdict | Available memory determines admission even when immediately free memory is low. |
| R7-B6-07 | Budget | ordered | The lead upgrades a store with a legacy numeric budget while roles and suites are live. | false-verdict | Both active items are counted and the old field does not cap launches. |
| R7-B6-08 | Budget | ordered | The lead runs a product registered on a host with both thresholds overridden. | false-verdict | Each override changes the launch decision independently. |
| R7-B6-09 | Budget | ordered | A child finishes while the host is busy and the last CI query is pending. | wrong-result | The lead can still record the child and check CI while heavy work waits. |
| R7-B7-01 | Start | ordered | A new session passes a store different from its inherited default while another product is active. | wrong-result | The embedded and direct next see the same registered active work. |
| R7-B8-01 | Convergence | ordered | A lead reads next after a judge shelves one blocker and closes another. | false-verdict | Only the unrelated surviving blocker remains open. |

## Consumer references

- B5-01 uses the Linux interpreter-script entry point. [execve(2)](https://man7.org/linux/man-pages/man2/execve.2.html)
- B5-02 through -05 and -29 use ESLint's inline configuration, including its description separator. [ESLint rules configuration](https://eslint.org/docs/latest/use/configure/rules#using-configuration-comments)
- B5-06 through -09 and -30 use TypeScript's checker pragmas and diagnostic suppressions. The scanner reads a block suppression from the block's last line. [TypeScript handbook](https://www.typescriptlang.org/docs/handbook/intro-to-js-ts.html) and [TypeScript 5.9.3 scanner](https://github.com/microsoft/TypeScript/blob/v5.9.3/src/compiler/scanner.ts#L343)
- B5-10 through -13 use the compiler's leading triple-slash forms and optional preserve attribute. [TypeScript triple-slash directives](https://www.typescriptlang.org/docs/handbook/triple-slash-directives.html)
- B5-14 and -15 use the Node 24 coverage reader's block-comment syntax. [Node 24.21.0 coverage reader](https://github.com/nodejs/node/blob/v24.21.0/lib/internal/test_runner/coverage.js#L43)
- B5-16 and -32 through -34 use Istanbul's next, branch and file hints. [nyc parsing hints](https://github.com/istanbuljs/nyc#parsing-hints-ignoring-lines)
- B5-17, -18, -35 and -36 use the live and historical names from the coverage converter. [v8-to-istanbul ignore hints](https://github.com/istanbuljs/v8-to-istanbul#ignoring-uncovered-lines)
- B5-19 uses ShellCheck's command-scoped directive. [ShellCheck directive manual](https://github.com/koalaman/shellcheck/blob/master/shellcheck.1.md#directives) and [SC1126](https://github.com/koalaman/shellcheck/wiki/SC1126)
- B5-20 and -21 use Ruff's Python inline suppressions. [Ruff linter](https://docs.astral.sh/ruff/linter/#error-suppression)
- B5-22 and -23 use mypy's diagnostic-specific and general suppressions. [mypy documentation](https://mypy.readthedocs.io/en/stable/common_issues.html#spurious-errors-and-locally-silencing-the-checker)
- B5-24 and -31 use the two YAML Language Server modelines. Releases since 1.24.0 ignore a modeline after YAML content. [YAML Language Server README](https://github.com/redhat-developer/yaml-language-server#using-a-modeline) and [1.24.0 changelog](https://github.com/redhat-developer/yaml-language-server/blob/main/CHANGELOG.md#1240)
- B5-25 through -28 use SwiftLint's range and scoped suppressions. [SwiftLint](https://realm.github.io/SwiftLint/#disable-rules-in-code)
