#!/usr/bin/env node
import { parseArgs } from "node:util";
import { newId, SCHEMA_VERSION } from "@gh-writer/core";
import { runValidate } from "./validate-command.ts";

const USAGE = `Usage: gh-writer <command> [options]

Commands:
  validate [dir] [--json]   Check a novel repository (default: current directory)
  new-id <prefix>           Print a new random ID, e.g. "gh-writer new-id char"

Options:
  -h, --help                Show this help
  -v, --version             Show version
`;

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
  const [command, ...rest] = positionals;

  if (values.version) {
    console.log(`gh-writer 0.1.0 (format v${SCHEMA_VERSION})`);
    return 0;
  }
  if (values.help || !command) {
    console.log(USAGE);
    return command || values.help ? 0 : 1;
  }

  switch (command) {
    case "validate":
      return runValidate(rest[0] ?? ".", { json: values.json });
    case "new-id": {
      const prefix = rest[0];
      if (!prefix || !/^[a-z]{2,8}$/.test(prefix)) {
        console.error("new-id needs a prefix of 2-8 lowercase letters, e.g. char, loc, sc");
        return 1;
      }
      console.log(newId(prefix));
      return 0;
    }
    default:
      console.error(`Unknown command "${command}"\n\n${USAGE}`);
      return 1;
  }
}

main(process.argv.slice(2)).then(
  (code) => (process.exitCode = code),
  (e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 2;
  },
);
