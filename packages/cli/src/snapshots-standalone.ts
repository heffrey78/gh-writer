// Entry point for the single-file snapshot writer vendored into novel repositories as
// .github/gh-writer/snapshots.mjs. Usage: node snapshots.mjs [dir] [--check]
import { parseArgs } from "node:util";
import { runSnapshots } from "./snapshots-command.ts";

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: { check: { type: "boolean" } },
});

runSnapshots(positionals[0] ?? ".", { check: values.check ?? false }).then(
  (code) => (process.exitCode = code),
  (e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 2;
  },
);
