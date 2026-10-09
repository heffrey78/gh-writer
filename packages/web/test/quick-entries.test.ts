import { ApiError, type Api, type StorageLike } from "@gh-writer/client";
import { afterEach, describe, expect, it } from "vitest";
import { createQuickEntries, type QuickEntries, type QuickEntry } from "../src/bible/quick-entries.ts";

function memoryStorage(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get length() {
      return data.size;
    },
    key: (i) => [...data.keys()][i] ?? null,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

/** A server that answers each create with the next of `answers` ("ok", or an error to throw), then "ok". */
function server(...answers: (Error | "ok")[]) {
  const calls: unknown[][] = [];
  const api = {
    bible: {
      createEntity: async (...args: unknown[]) => {
        calls.push(args);
        const answer = answers.shift() ?? "ok";
        if (answer !== "ok") throw answer;
        return { commit: "c", files: [], id: args[4] as string, file: "f" };
      },
    },
  } as unknown as Pick<Api, "bible">;
  return { api, calls };
}

const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(check()).toBe(true);
};

const MIRA: QuickEntry = { id: "char_m1rak0", type: "character", name: "Mira Kostova" };
let entries: QuickEntries | undefined;
afterEach(() => entries?.dispose());

describe("quick entries", () => {
  it("sends each entry with its ID, keeps it until the server has it, then reports it made", async () => {
    const { api, calls } = server();
    const storage = memoryStorage();
    const made: QuickEntry[] = [];
    entries = createQuickEntries({ api, novelId: "n", storage, onMade: (e) => made.push(e) });
    entries.add(MIRA);
    expect(entries.ids()).toEqual(new Set([MIRA.id]));
    expect(JSON.parse(storage.data.get("ghw:entries:n")!)).toEqual([MIRA]);
    await until(() => made.length === 1);
    expect(calls).toEqual([["n", "character", { name: "Mira Kostova" }, undefined, MIRA.id]]);
    expect(made).toEqual([MIRA]);
    expect(entries.store.getState().pending).toEqual([]);
    expect(storage.data.has("ghw:entries:n")).toBe(false);
  });

  it("tries again, waiting longer, while the server can't be reached", async () => {
    const { api, calls } = server(new ApiError(0, "NETWORK", "gh-writer isn't answering"), new ApiError(503, "UNAVAILABLE", "busy"));
    const made: QuickEntry[] = [];
    entries = createQuickEntries({ api, novelId: "n", storage: null, retryDelay: 5, onMade: (e) => made.push(e) });
    entries.add(MIRA);
    await until(() => made.length === 1);
    expect(calls).toHaveLength(3);
  });

  it("holds a refused entry for the author: why, then try again", async () => {
    const { api, calls } = server(new ApiError(409, "BLOCKED", "Git doesn't know who you are."));
    const refused: string[] = [];
    const made: QuickEntry[] = [];
    entries = createQuickEntries({ api, novelId: "n", storage: null, retryDelay: 5, onRefused: (_e, why) => refused.push(why), onMade: (e) => made.push(e) });
    entries.add(MIRA);
    await until(() => refused.length === 1);
    expect(refused).toEqual(["Git doesn't know who you are."]);
    expect(entries.store.getState().pending).toEqual([{ ...MIRA, refused: "Git doesn't know who you are." }]);
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).toHaveLength(1); // not retried by itself
    entries.retry(MIRA.id);
    await until(() => made.length === 1);
    expect(entries.store.getState().pending).toEqual([]);
  });

  it("picks up entries left unsent by a reload, and sends them", async () => {
    const storage = memoryStorage();
    storage.setItem("ghw:entries:n", JSON.stringify([MIRA, { id: "x" }]));
    const { api, calls } = server();
    const made: QuickEntry[] = [];
    entries = createQuickEntries({ api, novelId: "n", storage, onMade: (e) => made.push(e) });
    expect(entries.ids()).toEqual(new Set([MIRA.id]));
    await until(() => made.length === 1);
    expect(calls).toHaveLength(1);
    expect(storage.data.has("ghw:entries:n")).toBe(false);
  });

  it("forgets a discarded entry: not sent again, not kept", async () => {
    const storage = memoryStorage();
    const { api } = server(new ApiError(400, "BAD_REQUEST", "taken"));
    entries = createQuickEntries({ api, novelId: "n", storage, onRefused: () => {} });
    entries.add(MIRA);
    await until(() => entries!.store.getState().pending[0]?.refused !== undefined);
    entries.discard(MIRA.id);
    expect(entries.ids().size).toBe(0);
    expect(storage.data.has("ghw:entries:n")).toBe(false);
  });
});
