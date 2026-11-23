// The heartbeat (design §2.6, §6.1): the OS scheduler runs `tick` every HEARTBEAT_MINUTES with nobody in a session and
// no harness involved; launchd on macOS, cron elsewhere. Every path it runs is in the release worktree (D-0002, D-0004:
// live commands run a reviewed release, never the development clone a round is editing). A release worktree is a
// checkout whose HEAD is detached at the tag v<VERSION> of its own VERSION file, a plain X.Y.Z (a prerelease such as
// 0.4.4-v1.5 is a round's candidate, never installed; D-0008, D-0015 item 4), whose tagged commit holds
// scripts/self-loop.mjs, and whose tracked files have no local changes: what runs is what was tagged.
import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { UsageError } from "./args.mjs";
import { real } from "./registry.mjs";
import { HEARTBEAT_MINUTES } from "./thresholds.mjs";
import { isRelease, parseVersion } from "./version.mjs";

export const LABEL = "self-loop.heartbeat";
export const CRON_TAG = "# self-loop heartbeat";
export const ENTRY = join("scripts", "self-loop.mjs");
const SYSTEM_PATH = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];

const git = (dir, ...argv) => spawnSync("git", ["-C", dir, ...argv], { encoding: "utf8" });

/** Why `dir` is not a release worktree; null when it is. */
export function releaseProblem(dir) {
  const top = git(dir, "rev-parse", "--show-toplevel");
  if (top.status !== 0) return "not a Git checkout";
  if (real(top.stdout.trim()) !== real(dir)) return "not the top of its checkout";
  if (git(dir, "symbolic-ref", "-q", "HEAD").status === 0) return `HEAD is on branch ${git(dir, "symbolic-ref", "--short", "HEAD").stdout.trim()}, not detached at a release tag`;
  const shown = git(dir, "show", "HEAD:VERSION");
  const version = shown.status === 0 ? parseVersion(shown.stdout) : null;
  if (!version) return "HEAD has no X.Y.Z VERSION";
  if (!isRelease(version)) return `HEAD's VERSION ${version.text} is a prerelease; only X.Y.Z releases are installed`;
  const tag = `v${version.text}`;
  const tags = git(dir, "tag", "--points-at", "HEAD").stdout.split("\n").map(t => t.trim());
  if (!tags.includes(tag)) return `HEAD is not tagged ${tag}`;
  if (git(dir, "cat-file", "-e", `HEAD:${ENTRY}`).status !== 0) return `${tag} has no ${ENTRY} (it predates the heartbeat; upgrade the release first)`;
  const changes = git(dir, "--no-optional-locks", "status", "--porcelain", "--untracked-files=no"); // reads, never refreshes the index
  if (changes.status !== 0 || changes.stdout.trim()) return `tracked files have local changes, so it does not run ${tag}`;
  if (!existsSync(join(dir, ENTRY))) return `${ENTRY} is missing from the working tree`;
  return null;
}

/**
 * The release the heartbeat runs: --release (which must be one), else the running skill checkout when it is a release,
 * else the one release worktree of the skill's repository. None or several is a usage error naming them.
 */
export function resolveRelease({ skill, release }) {
  if (release) {
    const problem = releaseProblem(release);
    if (problem) throw new UsageError(`${real(release)} is not a release worktree: ${problem}`);
    return real(release);
  }
  if (!releaseProblem(skill)) return real(skill);
  const list = git(skill, "worktree", "list", "--porcelain");
  if (list.status !== 0) throw new UsageError(`${skill} is not a release worktree and not in a Git repository; pass --release <release worktree>`);
  const worktrees = list.stdout.split("\n\n").map(block => /^worktree (.+)$/m.exec(block)?.[1]).filter(Boolean);
  const releases = [...new Set(worktrees.filter(wt => !releaseProblem(wt)).map(real))];
  if (releases.length === 1) return releases[0];
  if (!releases.length) throw new UsageError(`no release worktree of ${real(skill)}'s repository (a worktree detached at the tag v<VERSION> holding ${ENTRY}); pass --release <release worktree>`);
  throw new UsageError(`several release worktrees: ${releases.join(", ")}; pass --release <release worktree>`);
}

/** The first executable named `name` on the PATH. */
function which(name, path = process.env.PATH ?? "") {
  for (const dir of path.split(delimiter).filter(Boolean)) {
    try { accessSync(join(dir, name), constants.X_OK); return join(dir, name); } catch { /* next */ }
  }
  return null;
}

/** The facts of one heartbeat entry: node, the release entry point, the owner store, the log and a PATH holding git and gh. */
export function heartbeatEntry({ release, store, home = homedir(), node = process.execPath }) {
  const tools = [dirname(node), ...["git", "gh"].map(t => which(t)).filter(Boolean).map(dirname)];
  return { release, store, node, log: join(home, ".self-loop", "heartbeat.log"), path: [...new Set([...tools, ...SYSTEM_PATH])].join(":") };
}

const xml = text => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
const argv = ({ release, store, node }) => [node, join(release, ENTRY), "tick", "--owner-store", store];

/** A launchd agent that runs tick every `minutes`. */
export function launchdPlist({ release, store, node, log, path, minutes = HEARTBEAT_MINUTES }) {
  const string = value => `<string>${xml(value)}</string>`;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    `  <key>Label</key>`, `  ${string(LABEL)}`,
    "  <key>ProgramArguments</key>", "  <array>", ...argv({ release, store, node }).map(a => `    ${string(a)}`), "  </array>",
    "  <key>WorkingDirectory</key>", `  ${string(release)}`,
    "  <key>EnvironmentVariables</key>", "  <dict>", "    <key>PATH</key>", `    ${string(path)}`, "  </dict>",
    "  <key>StartInterval</key>", `  <integer>${minutes * 60}</integer>`,
    "  <key>StandardOutPath</key>", `  ${string(log)}`,
    "  <key>StandardErrorPath</key>", `  ${string(log)}`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

const quote = text => "'" + String(text).replace(/'/g, "'\\''") + "'";
const schedule = minutes => minutes < 60 && 60 % minutes === 0 ? `*/${minutes} * * * *`
  : minutes % 60 === 0 && 24 % (minutes / 60) === 0 ? `0 ${minutes === 60 ? "*" : `*/${minutes / 60}`} * * *`
  : (() => { throw new Error(`HEARTBEAT_MINUTES ${minutes} has no cron schedule`); })();

/** One crontab line that runs tick every `minutes`, tagged so install and uninstall find it. `%` is escaped for cron. */
export function cronLine({ release, store, node, log, path, minutes = HEARTBEAT_MINUTES }) {
  const [bin, entry, ...rest] = argv({ release, store, node });
  const command = `cd ${quote(release)} && PATH=${quote(path)} ${quote(bin)} ${quote(entry)} ${rest.slice(0, 2).join(" ")} ${quote(rest[2])} >> ${quote(log)} 2>&1`;
  return `${schedule(minutes)} ${command.replace(/%/g, "\\%")} ${CRON_TAG}`;
}

const plistFile = home => join(home, "Library", "LaunchAgents", `${LABEL}.plist`);
const domain = () => `gui/${process.getuid()}`;

function run(cmd, args, input) {
  const r = spawnSync(cmd, args, { encoding: "utf8", input });
  if (r.error) throw new Error(`${cmd}: ${r.error.message}`);
  return r;
}

function readCrontab() {
  const r = run("crontab", ["-l"]);
  if (r.status === 0) return r.stdout;
  if (/no crontab/i.test(r.stderr)) return "";
  throw new Error(`crontab -l: ${r.stderr.trim() || `exit ${r.status}`}`);
}

function writeCrontab(lines) {
  const r = run("crontab", ["-"], lines.length ? lines.join("\n") + "\n" : "");
  if (r.status !== 0) throw new Error(`crontab -: ${r.stderr.trim() || `exit ${r.status}`}`);
}

const untagged = text => text.split("\n").filter(line => line && !line.endsWith(CRON_TAG));

/** Install (or replace) the heartbeat. Returns what it did, one line each. */
export function install(entry, { platform, home = homedir() }) {
  mkdirSync(dirname(entry.log), { recursive: true });
  if (platform === "launchd") {
    const file = plistFile(home);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, launchdPlist(entry));
    run("launchctl", ["bootout", `${domain()}/${LABEL}`]);
    const r = run("launchctl", ["bootstrap", domain(), file]);
    if (r.status !== 0) throw new Error(`launchctl bootstrap: ${r.stderr.trim() || `exit ${r.status}`}`);
    return [`wrote ${file}`, `launchctl bootstrap ${domain()} ${file}`];
  }
  writeCrontab([...untagged(readCrontab()), cronLine(entry)]);
  return ["crontab: one tagged heartbeat line"];
}

/** Remove the heartbeat; other launchd agents and crontab lines stay. */
export function uninstall({ platform, home = homedir() }) {
  if (platform === "launchd") {
    run("launchctl", ["bootout", `${domain()}/${LABEL}`]);
    rmSync(plistFile(home), { force: true });
    return [`launchctl bootout ${domain()}/${LABEL}`, `removed ${plistFile(home)}`];
  }
  writeCrontab(untagged(readCrontab()));
  return ["crontab: heartbeat line removed"];
}

/** The dry run: both entries, as the scheduler would get them. */
export function dryRun(entry, { home = homedir() } = {}) {
  return [`# launchd agent, written to ${plistFile(home)} and loaded with launchctl bootstrap ${domain()}`, launchdPlist(entry).trimEnd(),
    "", "# cron line, added to the crontab", cronLine(entry)].join("\n");
}
