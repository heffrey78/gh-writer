// Bundle the desktop smoke test (scripts/smoke-desktop.ts) with the fake GitHub it serves, and copy the
// sample novel beside it: what a clean test machine, with only the packaged Node, needs to run it.
// Usage: node scripts/build-smoke.ts [outdir]   (default: dist/smoke)
import { build } from "esbuild";
import { cpSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("..", import.meta.url));
const out = process.argv[2] ?? join(repo, "dist/smoke");
rmSync(out, { recursive: true, force: true });
await build({
  entryPoints: [join(repo, "scripts/smoke-desktop.ts")],
  outfile: join(out, "smoke-desktop.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  banner: { js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);' },
});
cpSync(join(repo, "examples/sample-novel"), join(out, "sample-novel"), { recursive: true });
console.log(`Built ${join(out, "smoke-desktop.mjs")}`);
