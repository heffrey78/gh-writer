// Bundle the gh-writer command (serve and the rest) into one ES module for Node's official binary,
// with what it reads at run time beside it (D9):
//   gh-writer.mjs   the CLI and server, every dependency inlined but the keychain's native module
//   node_modules/   @napi-rs/keyring and its prebuilt module for this platform
//   web/            the built web app
//   template/       the novel template
//   fonts/          the compiler's type
// Usage: node scripts/build-server.ts [outdir] [--web <dir>]   (default: dist/server, packages/web/dist)
import { build } from "esbuild";
import { cpSync, existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const repo = fileURLToPath(new URL("..", import.meta.url));
const { values, positionals } = parseArgs({ allowPositionals: true, options: { web: { type: "string" } } });
const out = positionals[0] ?? join(repo, "dist/server");
const web = values.web ?? join(repo, "packages/web/dist");
if (!existsSync(join(web, "index.html"))) {
  console.error(`The web app isn't built in ${web}: run \`npm run build\` first.`);
  process.exit(1);
}
const { version } = JSON.parse(readFileSync(join(repo, "packages/cli/package.json"), "utf8")) as { version: string };

rmSync(out, { recursive: true, force: true });
await build({
  entryPoints: [join(repo, "packages/cli/src/bundle.ts")],
  outfile: join(out, "gh-writer.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  // The keychain loads a native module for the platform: it ships beside the bundle, not in it.
  external: ["@napi-rs/keyring"],
  legalComments: "linked",
  banner: {
    js: [
      `// gh-writer ${version}. Generated file, do not edit. Source: https://github.com/heffrey78/gh-writer`,
      'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);',
    ].join("\n"),
  },
});

// The keychain's loader, and its prebuilt modules installed here (this platform's; other platforms'
// come from scripts/fetch-runtime.ts).
const napi = join(repo, "node_modules/@napi-rs");
for (const pkg of readdirSync(napi).filter((name) => name === "keyring" || name.startsWith("keyring-"))) {
  cpSync(join(napi, pkg), join(out, "node_modules/@napi-rs", pkg), { recursive: true });
}
cpSync(web, join(out, "web"), { recursive: true });
cpSync(join(repo, "templates/novel"), join(out, "template"), { recursive: true });
cpSync(join(repo, "packages/export/fonts"), join(out, "fonts"), { recursive: true });
console.log(`Built ${join(out, "gh-writer.mjs")}`);
