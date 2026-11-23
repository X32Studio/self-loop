// `--key value` pairs; a flag followed by another flag (or nothing) gets "". Positional words are returned in `_`.
export function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const word = argv[i];
    if (!word.startsWith("--")) { args._.push(word); continue; }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) args[word.slice(2)] = "";
    else { args[word.slice(2)] = next; i++; }
  }
  return args;
}

export function need(args, ...keys) {
  for (const key of keys) if (args[key] === undefined || args[key] === "") throw new UsageError(`missing --${key}`);
}

export class UsageError extends Error {}

/** Run a CLI main; usage errors exit 64, other errors 1. */
export async function cli(main) {
  try { process.exitCode = (await main()) ?? 0; }
  catch (error) {
    console.error(error instanceof UsageError ? `usage: ${error.message}` : error.stack ?? String(error));
    process.exitCode = error instanceof UsageError ? 64 : 1;
  }
}
