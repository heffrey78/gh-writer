import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));

describe("cli", () => {
  it("runs under plain node", () => {
    expect(execFileSync("node", [main], { encoding: "utf8" })).toContain("gh-writer");
  });
});
