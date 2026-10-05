// Bundle the validator into one dependency-free ES module for novel repositories.
// Usage: node scripts/build-validator.ts [outfile]   (default: dist/validate.mjs)
import { build } from "esbuild";
import { readFileSync } from "node:fs";

const outfile = process.argv[2] ?? "dist/validate.mjs";
const { version } = JSON.parse(readFileSync(new URL("../packages/cli/package.json", import.meta.url), "utf8")) as { version: string };

await build({
  entryPoints: [new URL("../packages/cli/src/standalone.ts", import.meta.url).pathname],
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
      `// gh-writer novel validator ${version}. Generated file, do not edit.`,
      "// Source: https://github.com/heffrey78/gh-writer. Usage: node validate.mjs [dir] [--json]",
      'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);',
    ].join("\n"),
  },
});
console.log(`Built ${outfile}`);
