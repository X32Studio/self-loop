// `node --test scripts/test` resolves the directory to this file (Node 24 does not expand directories); it loads every
// test file here, so one command runs the whole suite.
const { readdirSync } = require("node:fs");
for (const file of readdirSync(__dirname).filter(f => f.endsWith(".test.mjs")).sort()) import(`./${file}`);
