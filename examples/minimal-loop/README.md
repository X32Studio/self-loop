# Minimal Runnable Demo

This self-contained demo creates two disposable Git repositories in a temporary directory (`/tmp/self-loop-demo-*`) and walks through four core mechanical guarantees of `self-loop` in ~2 seconds—no API keys or network calls required:

1. **Managed Records Layout (`records-check.mjs`)**: Validates declared record kinds (`purpose/`, `decisions/`, `metrics/`), generates `INDEX.md`, and catches undeclared stray files.
2. **Trajectory Alarms & Diagnosis Gate (`trajectory.mjs` + `call.mjs`)**: Appends a recurring blocker to `metrics/trajectory.jsonl`, triggers `blocker-recurring` and `ci-absent` alarms, and shows `call.mjs --dry-run` **refusing** an adversarial call (exit `7`) until the alarms are diagnosed.
3. **Exact-Tree Suite Receipt (`suite-green.mjs`)**: Runs tests in a clean detached worktree on an exact commit SHA and records a tree-bound receipt.
4. **Protected Push Gate (`gated-push.mjs`)**: Refuses to push an unverified or un-converged commit to `main` (exit `2`).

## Run It

```bash
npm run demo
# or directly:
node examples/minimal-loop/demo.mjs
```
