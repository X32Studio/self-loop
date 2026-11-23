import { basename } from "node:path";

const assignment = /^[A-Za-z_][A-Za-z0-9_]*=/;
const leading = new Set(["if", "then", "elif", "else", "while", "until", "do", "!", "{"]);
const globalValue = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env"]);
const globalFlag = new Set(["-p", "-P", "--paginate", "--no-pager", "--no-replace-objects", "--no-optional-locks",
  "--no-advice", "--bare", "--literal-pathspecs", "--glob-pathspecs", "--noglob-pathspecs", "--icase-pathspecs"]);

function isGitPush(words) {
  let i = 0;
  while (words[i]?.assignment || words[i]?.plain && leading.has(words[i].value)) i++;
  const is = value => words[i]?.value === value;
  if (is("command") || is("exec")) {
    i++;
    if (is("--")) i++;
  }
  if (words[i] && basename(words[i].value) === "env") {
    i++;
    while (words[i]) {
      const arg = words[i].value;
      if (arg === "-u" || arg === "--unset") i += 2;
      else if (assignment.test(arg) || ["-i", "--ignore-environment"].includes(arg) || arg.startsWith("--unset=")) i++;
      else break;
    }
    if (is("--")) i++;
  }
  if (!words[i] || basename(words[i++].value) !== "git") return false;
  while (words[i]) {
    const arg = words[i].value;
    if (arg === "push") return !["-h", "--help"].includes(words[i + 1]?.value);
    if (globalValue.has(arg)) i += 2;
    else if (globalFlag.has(arg) || globalValue.has(arg.split("=")[0]) && arg.includes("=")) i++;
    else return false;
  }
  return false;
}

// Return the offset just after a here-document, or the end of the input if its delimiter is missing.
function skipHereDocument(command, start, { delimiter, stripTabs, quoted }) {
  let continued = "";
  while (start < command.length) {
    const end = command.indexOf("\n", start);
    if (end === -1) return command.length;
    const line = command.slice(start, end);
    start = end + 1;
    // In an unquoted here-document Bash joins backslash-newline pairs before matching the delimiter.
    if (!quoted && /(?:^|[^\\])(?:\\\\)*\\$/.test(line)) {
      continued += line.slice(0, -1);
      continue;
    }
    const logicalLine = continued + line;
    if ((stripTabs ? logicalLine.replace(/^\t+/, "") : logicalLine) === delimiter) return start;
    continued = "";
  }
  return start;
}

/**
 * Recognize direct Git invocations in simple shell commands. Shell programs with nested substitutions,
 * or grouping are outside this grammar. Here-document bodies are opaque.
 */
export function hasGitPush(command) {
  let words = [], value = "", quote = null, plain = true, started = false, assigns = false, redirect = false;
  const heredocs = [];
  let stripTabs = null;
  const finishWord = () => {
    if (!started) return;
    if (stripTabs !== null) {
      heredocs.push({ delimiter: value, stripTabs, quoted: !plain });
      stripTabs = null;
    } else if (!redirect) words.push({ value, plain, assignment: assigns });
    value = "";
    started = false;
    plain = true;
    assigns = false;
    redirect = false;
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i], next = command[i + 1];
    if (c === quote) { quote = null; continue; }
    if (quote !== "'" && c === "\\" && next && (!quote || /[\\"$`\n]/.test(next))) {
      i++;
      if (next !== "\n") { value += next; started = true; plain = false; }
      continue;
    }
    if (quote !== "'" && (c === "`" || c === "$" && (next === "(" || next === "{"))) return false;
    if (quote) { value += c; continue; }
    if (c === "'" || c === '"') { quote = c; started = true; plain = false; continue; }
    if (c === "#" && !started) {
      const end = command.indexOf("\n", i);
      i = end < 0 ? command.length : end - 1;
      continue;
    }
    if (c === "(" || c === ")") return false;
    if (c === "<" || c === ">" || c === "&" && next === ">") {
      // A number next to the operator is a file descriptor, not a command word.
      if (started && plain && /^\d+$/.test(value) && c !== "&") started = false;
      else finishWord();
      value = "";
      if (stripTabs !== null) return false;
      if (c === "<" && next === "<") {
        i++;
        if (command[i + 1] === "<") return false; // Here-string.
        stripTabs = command[i + 1] === "-";
        if (stripTabs) i++;
      } else {
        if (c === "&") i++;
        if (["&", ">", "|"].includes(command[i + 1])) i++;
      }
      redirect = true;
      continue;
    }
    if (/[\t \r]/.test(c)) { finishWord(); continue; }
    if (/[\n;|&]/.test(c)) {
      finishWord();
      if (isGitPush(words)) return true;
      words = [];
      redirect = false;
      if (stripTabs !== null) return false;
      if (c === "\n" && heredocs.length) {
        let start = i + 1;
        for (const heredoc of heredocs) start = skipHereDocument(command, start, heredoc);
        heredocs.length = 0;
        i = start - 1;
      }
      continue;
    }
    if (c === "=" && plain && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) assigns = true;
    started = true;
    value += c;
  }
  if (quote) return false;
  finishWord();
  return isGitPush(words);
}
