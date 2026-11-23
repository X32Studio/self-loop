import { existsSync } from "node:fs";
import { join } from "node:path";
import { json, jsonl, put, status, writeGh } from "./fixture.mjs";

export function rulingWorld(w, edits, { log = true, verdict = "CONVERGED" } = {}) {
  const product = w.repo(join(w.projects, "release-target"), { "VERSION": "0.4.3\n", "README.md": "# Release target\n\n## Acceptance\n", "src/result.js": "export const result = 1;\n" });
  w.git(product, "remote", "add", "origin", "https://github.com/example/fixture.git");
  const ruled = w.git(product, "rev-parse", "HEAD");
  for (const [path, contents] of Object.entries(edits)) put(product, path, contents);
  const tip = edits && Object.keys(edits).length ? w.commit(product, "Candidate release") : ruled;
  const record = "rounds/0001-judge.md";
  const sealed = "sealed/judge/0001/judge-1.md";
  const records = join(w.projects, "release-target-records");
  w.repo(records, {
    "records.json": json({}),
    "loop.json": json({
      product, records, workDir: join(w.dir, "work"), branch: "loop/v1", phase: "v1", briefs: {}, agents: {},
      protected: ["main"], gates: { remote: "origin", require: ["github-actions/verify"] },
    }),
    [record]: "# R-0001-judge\n",
    [sealed]: `# Sealed\n\n## Report (verbatim)\n\nVERDICT: ${verdict}\nACCEPTANCE: ${verdict === "CONVERGED" ? "pass" : "fail"}\n`,
    "metrics/handoffs.jsonl": jsonl({
      id: "R-0001-judge", round: 1, phase: "v1", role: "judge", step: "judge",
      attempt: 1, record, files: [record, sealed], view: "a".repeat(40),
      product: { base: ruled, commit: ruled }, audit: { violations: 0 }, agent: { runner: "claude" },
    }),
    ...(log ? { "metrics/trajectory.jsonl": jsonl({
      round: 1, phase: "v1", role: "judge", verdict, commit: ruled, ...(tip === ruled ? {} : { tip }), suite: "10/0", ci: "success",
    }) } : {}),
  });
  const ownerStore = w.repo(join(w.dir, "promotion-owner-store"), {
    "README.md": "# Owner store\n",
    "products.json": json({ products: [{ name: "release-target", records }] }),
  });
  const suite = join(w.dir, "suite");
  const receipt = suite + ".json";
  const green = { id: 1, app: "github-actions", name: "verify", status: "completed", conclusion: "success" };
  const prepare = runs => writeGh(w, runs);
  prepare({ [tip]: [green] });
  const promote = () => {
    if (!existsSync(receipt)) {
      status(w.run([
        "--repo", product, "--sha", tip, "--command",
        "node --input-type=module -e 'import assert from \"node:assert/strict\"; import { result } from \"./src/result.js\"; assert.ok(Number.isInteger(result))'",
        "--out", suite,
      ], { entry: "suite-green.mjs" }), 0);
    }
    return w.run([
      "--repo", product, "--owner-store", ownerStore, "--branch", "main",
      "--sha", tip, "--suite-receipt", receipt, "--dry-run",
    ], { entry: "gated-push.mjs" });
  };
  return { ruled, tip, product, records, green, prepare, promote };
}
