// Node 24 resolves a test directory to index.js.
const { readdirSync } = require("node:fs");
for (const file of readdirSync(__dirname).filter(name => name.endsWith(".test.mjs")).sort()) import("./" + file);
