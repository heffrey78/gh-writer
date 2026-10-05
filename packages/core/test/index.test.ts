import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION } from "../src/index.ts";

describe("core", () => {
  it("exposes the supported schema version", () => {
    expect(SCHEMA_VERSION).toBe(1);
  });
});
