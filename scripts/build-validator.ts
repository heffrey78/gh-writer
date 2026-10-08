// Bundle the validator (or, with --snapshots, the diagram snapshot writer) into one dependency-free
// ES module for novel repositories.
// Usage: node scripts/build-validator.ts [--snapshots] [outfile]   (default: dist/validate.mjs or dist/snapshots.mjs)
import { build } from "esbuild";
import { readFileSync } from "node:fs";

const snapshots = process.argv.includes("--snapshots");
const outfile = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? (snapshots ? "dist/snapshots.mjs" : "dist/validate.mjs");
const entry = snapshots ? "snapshots-standalone.ts" : "standalone.ts";
const what = snapshots ? "diagram snapshot writer" : "novel validator";
const usage = snapshots ? "node snapshots.mjs [dir] [--check]" : "node validate.mjs [dir] [--json]";
const { version } = JSON.parse(readFileSync(new URL("../packages/cli/package.json", import.meta.url), "utf8")) as { version: string };

await build({
  entryPoints: [new URL(`../packages/cli/src/${entry}`, import.meta.url).pathname],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  minify: true,
  legalComments: "none",
  banner: {
    js: [
      "#!/usr/bin/env node",
      `// gh-writer ${what} ${version}. Generated file, do not edit.`,
      `// Source: https://github.com/heffrey78/gh-writer. Usage: ${usage}`,
      'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);',
    ].join("\n"),
  },
});
console.log(`Built ${outfile}`);
