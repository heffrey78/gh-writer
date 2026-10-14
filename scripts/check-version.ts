// A release tag must name the version the app says it is: in tauri.conf.json, Cargo.toml and the Arch
// PKGBUILD alike. A tag like v0.2.0-rc.1 (a pre-release) names 0.2.0.
// Usage: node scripts/check-version.ts <tag>   (e.g. v0.2.0)
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const tag = process.argv[2] ?? "";
const wanted = /^v(\d+\.\d+\.\d+)(-[0-9A-Za-z.-]+)?$/.exec(tag)?.[1];
if (!wanted) {
  console.error(`"${tag}" isn't a release tag: v1.2.3, or v1.2.3-rc.1 for a pre-release.`);
  process.exit(1);
}
const read = (path: string) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8");
const found = {
  "packages/desktop/src-tauri/tauri.conf.json": (JSON.parse(read("packages/desktop/src-tauri/tauri.conf.json")) as { version: string }).version,
  "packages/desktop/src-tauri/Cargo.toml": /^version = "([^"]+)"/m.exec(read("packages/desktop/src-tauri/Cargo.toml"))?.[1],
  "packages/desktop/arch/PKGBUILD": /^pkgver=(.+)$/m.exec(read("packages/desktop/arch/PKGBUILD"))?.[1],
};
const wrong = Object.entries(found).filter(([, version]) => version !== wanted);
for (const [file, version] of wrong) console.error(`${file} says ${version}, not ${wanted}.`);
if (wrong.length) process.exit(1);
console.log(`${tag}: the app is ${wanted} everywhere.`);
