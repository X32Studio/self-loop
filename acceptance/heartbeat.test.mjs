import assert from "node:assert/strict";
import { cpSync, existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { has, lacks, put, skill, status, world } from "./fixture.mjs";

test("HB-01 a dry run prints launchd and cron commands pinned to a detached release", t => {
  const w = world(t);
  const releaseVersion = "1.2.3";
  const dev = w.repo(join(w.projects, "self-loop-development"), {
    "README.md": "# Development checkout\n",
    VERSION: releaseVersion + "\n",
  });
  const release = join(w.home, ".agents", "skills", "self-loop");
  for (const item of ["scripts", "assets", "SKILL.md", "RECORDS.md", "DEBT.md", "README.md"]) {
    cpSync(join(skill, item), join(dev, item), { recursive: true, filter: src => src !== join(skill, "scripts", "test") });
  }
  const releaseSha = w.commit(dev, "Released files");
  w.git(dev, "tag", "v" + releaseVersion, releaseSha);
  w.git(dev, "worktree", "add", "-q", "--detach", release, releaseSha);
  put(dev, "README.md", "# Unreleased development checkout\n");
  const devSha = w.commit(dev, "Development changes after release");
  assert.notEqual(devSha, releaseSha, "the test must distinguish development and release");
  assert.equal(w.git(release, "rev-parse", "HEAD"), releaseSha);

  const installed = w.run(["heartbeat", "install", "--dry-run"], { from: dev, extraEnv: { SELF_LOOP_RELEASE: release } });
  const text = status(installed, 0);
  const plist = /<plist[\s\S]*?<\/plist>/.exec(text)?.[0];
  assert.ok(plist, text);
  has(plist, release + "/");
  assert.match(plist, />tick</);
  const cron = text.split("\n").find(line => /^\s*(?:\S+\s+){5}.*\btick\b/.test(line) && line.includes(release));
  assert.ok(cron, "expected a cron schedule and a release command:\n" + text);
  lacks(text, dev + "/scripts/");
  lacks(text, skill + "/scripts/");
  assert.ok(!existsSync(join(w.home, "Library", "LaunchAgents")), "a dry run must leave the scheduler untouched");
});
