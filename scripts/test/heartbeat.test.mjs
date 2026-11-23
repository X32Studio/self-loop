// The heartbeat: an OS scheduler entry that runs `tick` from the release worktree, never the development clone (design
// §2.6, §7.2; D-0002: live hooks and commands run a pinned release).
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { cronLine, launchdPlist, resolveRelease } from "../lib/heartbeat.mjs";
import { git, isolatedEnv, ownerStore, repo, selfLoop, skill, temp } from "./helpers.mjs";

/** A development clone on a branch, tagged v1.2.3, with release worktrees detached at the given tags. */
function skillRepo({ releases = ["v1.2.3"] } = {}) {
  const dir = temp("self-loop-skill-");
  const dev = join(dir, "dev");
  mkdirSync(dev);
  repo({ "VERSION": "1.2.3\n", "scripts/self-loop.mjs": "// entry\n" }, dev);
  git(dev, "tag", "-a", "v1.2.3", "-m", "release");
  writeFileSync(join(dev, "VERSION"), "1.3.0\n");
  git(dev, "commit", "-qam", "next version, not tagged");
  const worktrees = releases.map((tag, i) => {
    const wt = join(dir, `release-${i}`);
    git(dev, "worktree", "add", "-q", "--detach", wt, tag);
    return realpathSync(wt);
  });
  return { dev, worktrees };
}

test("the release is the running checkout when it is a release, else the one release worktree of its repository", () => {
  const { dev, worktrees: [release] } = skillRepo();
  assert.equal(resolveRelease({ skill: release }), release);
  assert.equal(resolveRelease({ skill: dev }), release, "found through the repository's worktrees");
  assert.equal(resolveRelease({ skill: dev, release }), release);
  assert.throws(() => resolveRelease({ skill: dev, release: dev }), /not a release/);
  const none = skillRepo({ releases: [] });
  assert.throws(() => resolveRelease({ skill: none.dev }), /--release/);
  const two = skillRepo({ releases: ["v1.2.3", "v1.2.3"] });
  assert.throws(() => resolveRelease({ skill: two.dev }), error => two.worktrees.every(wt => error.message.includes(wt)));
  const untagged = skillRepo({ releases: [] });
  const detached = join(untagged.dev, "..", "detached");
  git(untagged.dev, "worktree", "add", "-q", "--detach", detached, "HEAD");
  assert.throws(() => resolveRelease({ skill: untagged.dev, release: detached }), /not a release/);
  const old = skillRepo({ releases: [] });
  git(old.dev, "rm", "-q", "scripts/self-loop.mjs");
  git(old.dev, "commit", "-qm", "an older layout");
  writeFileSync(join(old.dev, "VERSION"), "0.4.3\n");
  git(old.dev, "commit", "-qam", "0.4.3");
  git(old.dev, "tag", "-a", "v0.4.3", "-m", "release");
  const pre = join(old.dev, "..", "pre");
  git(old.dev, "worktree", "add", "-q", "--detach", pre, "v0.4.3");
  assert.throws(() => resolveRelease({ skill: old.dev, release: pre }), /self-loop\.mjs/);
  mkdirSync(join(pre, "scripts"), { recursive: true });
  writeFileSync(join(pre, "scripts", "self-loop.mjs"), "// an untracked copy is not the release\n");
  assert.throws(() => resolveRelease({ skill: pre }), /--release/, "a candidate's files copied into an old release");
  const edited = skillRepo();
  writeFileSync(join(edited.worktrees[0], "VERSION"), "9.9.9\n");
  assert.throws(() => resolveRelease({ skill: edited.worktrees[0], release: edited.worktrees[0] }), /local changes/);
  assert.throws(() => resolveRelease({ skill: edited.dev }), /--release/);
});

test("a worktree detached at a prerelease tag is a round's candidate, never the installed release", () => {
  const { dev } = skillRepo({ releases: [] });
  writeFileSync(join(dev, "VERSION"), "1.3.0-v1.5\n");
  git(dev, "commit", "-qam", "a round's candidate");
  git(dev, "tag", "-a", "v1.3.0-v1.5", "-m", "candidate");
  const candidate = join(dev, "..", "candidate");
  git(dev, "worktree", "add", "-q", "--detach", candidate, "v1.3.0-v1.5");
  assert.throws(() => resolveRelease({ skill: dev, release: candidate }), /1\.3\.0-v1\.5 is a prerelease; only X\.Y\.Z releases are installed/);
  assert.throws(() => resolveRelease({ skill: candidate }), /no release worktree/);
});

test("the plist and the cron line run tick from the release with the owner store", () => {
  const release = "/opt/self loop/release", store = "/home/o/owner store", node = "/usr/local/bin/node";
  const plist = launchdPlist({ release, store, node, log: "/home/o/.self-loop/heartbeat.log", path: "/usr/bin:/bin" });
  assert.match(plist, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<!DOCTYPE plist/);
  assert.match(plist, /<string>\/opt\/self loop\/release\/scripts\/self-loop\.mjs<\/string>\s*<string>tick<\/string>\s*<string>--owner-store<\/string>\s*<string>\/home\/o\/owner store<\/string>/);
  assert.match(plist, /<key>StartInterval<\/key>\s*<integer>3600<\/integer>/);
  assert.match(plist, /<key>WorkingDirectory<\/key>\s*<string>\/opt\/self loop\/release<\/string>/);
  const cron = cronLine({ release, store, node, log: "/home/o/.self-loop/heartbeat.log", path: "/usr/bin:/bin" });
  assert.equal(cron.split("\n").length, 1);
  assert.match(cron, /^0 \* \* \* \* /);
  assert.ok(cron.includes("'/opt/self loop/release/scripts/self-loop.mjs' tick --owner-store '/home/o/owner store'"), cron);
  assert.match(cron, /# self-loop heartbeat$/);
  assert.ok(launchdPlist({ release: "/a&b<c", store, node, log: "/l", path: "/p" }).includes("/a&amp;b&lt;c"));
});

test("heartbeat install --dry-run prints both entries pointing at the release and writes nothing", () => {
  const { dev, worktrees: [release] } = skillRepo();
  const store = ownerStore([]);
  const env = isolatedEnv();
  const result = selfLoop(["heartbeat", "install", "--dry-run", "--release", release, "--owner-store", store], { env });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /<plist version="1.0">/);
  assert.match(result.stdout, /# self-loop heartbeat/);
  const paths = [...result.stdout.matchAll(/(\/[^\s<>'"]*\/scripts\/[\w.-]+)/g)].map(m => m[1]);
  assert.ok(paths.length >= 2, result.stdout);
  for (const path of paths) assert.ok(path.startsWith(release), `${path} is outside the release ${release}`);
  for (const forbidden of [skill, realpathSync(dev)]) assert.ok(!result.stdout.includes(forbidden), `the output names ${forbidden}`);
  assert.ok(!existsSync(join(env.HOME, "Library")) && !existsSync(join(env.HOME, ".self-loop")), "a dry run writes nothing");
  const refused = selfLoop(["heartbeat", "install", "--dry-run", "--release", dev, "--owner-store", store], { env });
  assert.equal(refused.status, 64);
  assert.match(refused.stderr, /not a release/);
  const noStore = selfLoop(["heartbeat", "install", "--dry-run", "--release", release, "--owner-store", join(temp(), "none")], { env });
  assert.equal(noStore.status, 64);
});

test("install and uninstall drive launchctl and crontab idempotently", () => {
  const { worktrees: [release] } = skillRepo();
  const store = ownerStore([]);
  const bin = temp("self-loop-bin-");
  const calls = join(bin, "calls.log"), table = join(bin, "crontab.txt");
  writeFileSync(join(bin, "launchctl"), `#!/bin/sh\necho "launchctl $*" >> '${calls}'\n`);
  writeFileSync(join(bin, "crontab"), `#!/bin/sh\nif [ "$1" = "-l" ]; then [ -f '${table}' ] && cat '${table}' || { echo "no crontab" >&2; exit 1; }; exit 0; fi\nif [ "$1" = "-" ]; then cat > '${table}'; exit 0; fi\nexit 2\n`);
  chmodSync(join(bin, "launchctl"), 0o755);
  chmodSync(join(bin, "crontab"), 0o755);
  const env = isolatedEnv({ PATH: `${bin}:${process.env.PATH}` });
  const run = (...args) => selfLoop(["heartbeat", ...args, "--release", release, "--owner-store", store], { env });

  const launchd = run("install", "--platform", "launchd");
  assert.equal(launchd.status, 0, launchd.stderr);
  const plist = join(env.HOME, "Library", "LaunchAgents", "self-loop.heartbeat.plist");
  assert.ok(readFileSync(plist, "utf8").includes(`${release}/scripts/self-loop.mjs`));
  assert.ok(existsSync(join(env.HOME, ".self-loop")), "the log folder exists for launchd");
  assert.match(readFileSync(calls, "utf8"), /launchctl bootstrap gui\/\d+ .*self-loop\.heartbeat\.plist/);
  assert.equal(run("uninstall", "--platform", "launchd").status, 0);
  assert.ok(!existsSync(plist));
  assert.match(readFileSync(calls, "utf8"), /launchctl bootout gui\/\d+\/self-loop\.heartbeat/);

  writeFileSync(table, "15 3 * * * /usr/bin/true # the owner's own job\n");
  assert.equal(run("install", "--platform", "cron").status, 0);
  assert.equal(run("install", "--platform", "cron").status, 0);
  const lines = readFileSync(table, "utf8").trim().split("\n");
  assert.equal(lines.length, 2, lines.join("\n"));
  assert.equal(lines[0], "15 3 * * * /usr/bin/true # the owner's own job");
  assert.ok(lines[1].includes(`${release}/scripts/self-loop.mjs`));
  assert.equal(run("uninstall", "--platform", "cron").status, 0);
  assert.equal(readFileSync(table, "utf8"), "15 3 * * * /usr/bin/true # the owner's own job\n");
});
