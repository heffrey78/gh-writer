// Entry point for the single-file compiler vendored into novel repositories as
// .github/gh-writer/compile.mjs, with its type in .github/gh-writer/fonts/.
// Usage: node compile.mjs [dir] [--format docx,epub,pdf] [--preset <name>] [--from <chapter>] [--to <chapter>] [--out <dir>]
import { parseArgs } from "node:util";
import { readFonts } from "@gh-writer/export";
import { runCompile } from "./compile-command.ts";

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: { format: { type: "string" }, preset: { type: "string" }, from: { type: "string" }, to: { type: "string" }, out: { type: "string" } },
});

runCompile(positionals[0] ?? ".", { ...values, fonts: readFonts(new URL("./fonts/", import.meta.url)) }).then(
  (code) => (process.exitCode = code),
  (e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 2;
  },
);
