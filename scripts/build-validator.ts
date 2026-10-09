// Bundle the validator (or, with --snapshots, the diagram snapshot writer; with --compile, the
// compiler, its type copied alongside in fonts/) into one dependency-free ES module for novel repositories.
// Usage: node scripts/build-validator.ts [--snapshots|--compile] [outfile]   (default: dist/<name>.mjs)
import { build } from "esbuild";
import { cpSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const TOOLS = {
  validate: { entry: "standalone.ts", what: "novel validator", usage: "node validate.mjs [dir] [--json]" },
  snapshots: { entry: "snapshots-standalone.ts", what: "diagram snapshot writer", usage: "node snapshots.mjs [dir] [--check]" },
  compile: { entry: "compile-standalone.ts", what: "manuscript compiler", usage: "node compile.mjs [dir] [--format docx,epub,pdf] [--preset <name>] [--from <chapter>] [--to <chapter>] [--out <dir>]" },
};
const name = process.argv.includes("--snapshots") ? "snapshots" : process.argv.includes("--compile") ? "compile" : "validate";
const { entry, what, usage } = TOOLS[name];
const outfile = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? `dist/${name}.mjs`;
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
if (name === "compile") cpSync(new URL("../packages/export/fonts", import.meta.url), join(dirname(outfile), "fonts"), { recursive: true });
console.log(`Built ${outfile}`);
