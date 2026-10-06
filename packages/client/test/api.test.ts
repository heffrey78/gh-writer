import { describe, expect, it } from "vitest";
import { ApiError, createApi } from "../src/index.ts";

/** An API whose server answers every request with `status` and `body`. */
const answering = (status: number, body: unknown) => createApi({ fetch: async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }) });

describe("409 answers", () => {
  it("hands a stale write or resolution back to the caller", async () => {
    const current = { content: "Newer.\n", hash: "h" };
    expect(await answering(409, { code: "CONFLICT", current }).writeFile("n", "a.md", "Mine.\n", "old")).toEqual({ ok: false, current });
    const conflicts = { upstream: "abc", files: [] };
    expect(await answering(409, { code: "STALE", conflicts }).resolveConflicts("n", "old", {})).toEqual({ ok: false, conflicts });
  });

  it("throws for any other refusal", async () => {
    await expect(answering(409, { code: "BLOCKED", error: "No identity." }).createCheckpoint("n", "Before")).rejects.toMatchObject({ status: 409, code: "BLOCKED" });
    await expect(answering(409, { code: "NO_CONFLICT", error: "Nothing to resolve." }).resolveConflicts("n", "abc", {})).rejects.toBeInstanceOf(ApiError);
  });
});

describe("bible", () => {
  it("returns a refused delete's references instead of throwing", async () => {
    const references = [{ kind: "scene", id: "sc_5tat1n", title: "The Station", via: ["pov"] }];
    expect(await answering(409, { code: "REFERENCED", references }).bible.deleteEntity("n", "char_x", "h")).toEqual({ ok: false, references });
    await expect(answering(409, { code: "STALE", error: "Changed." }).bible.deleteEntity("n", "char_x", "h")).rejects.toMatchObject({ code: "STALE" });
    expect(await answering(200, { commit: "abc", files: ["bible/characters/x.md"] }).bible.deleteEntity("n", "char_x", "h", true)).toEqual({ ok: true, commit: "abc", files: ["bible/characters/x.md"] });
  });
});
