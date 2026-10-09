import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createApi } from "@gh-writer/client";
import { createServer, hashText, Library, sessionCookie, type RunningServer } from "@gh-writer/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createWorkspace, type Workspace } from "../src/novel/workspace.ts";

const sample = fileURLToPath(new URL("../../../examples/sample-novel", import.meta.url));
const SCENE = "manuscript/01-return/01-arrival/01-the-station.md";

let tmp: string;
let n = 0;
let root: string;
let server: RunningServer;
let ws: Workspace;
let api: ReturnType<typeof createApi>;
let novelId: string;

const disk = () => readFileSync(join(root, SCENE), "utf8");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await sleep(10);
  }
}
const file = () => ws.store.getState().files[SCENE]!;
/** The scene's paragraphs: [0] is the first. */
const paragraphs = (text: string) => text.slice(text.indexOf("\n---\n") + 5).split("\n\n");
const replaceParagraph = (text: string, i: number, by: string) => text.replace(paragraphs(text)[i]!.trim(), by);

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "gh-writer-ws-"));
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

beforeEach(async () => {
  root = join(tmp, `novel-${++n}`);
  cpSync(sample, root, { recursive: true });
  execFileSync("git", ["init", "-q", root]);
  const library = await Library.open({ configDir: join(tmp, `config-${n}`) });
  const { id } = await library.add(root);
  server = await createServer({ library, token: "t", commit: false, sync: false });
  novelId = id;
  api = createApi({ baseUrl: server.url, headers: { cookie: `${sessionCookie(server.port)}=t`, origin: server.url } });
  ws = createWorkspace({ api, novelId, interval: 30, storage: null });
  await ws.open([SCENE]);
});

afterEach(async () => {
  ws.dispose();
  await server.close();
});

describe("workspace", () => {
  it("opens a scene split into front matter and body, and saves edits to the body", async () => {
    expect(file().frontMatter).toMatch(/^---\nid: sc_5tat1n\n[\s\S]*\n---\n$/);
    ws.change(SCENE, `${file().body}One more line.\n`);
    await until(() => disk().endsWith("One more line.\n"));
    expect(disk().startsWith(file().frontMatter)).toBe(true);
    await until(() => file().hash === hashText(disk()));
  });

  it("reloads a scene changed on disk when it has no unsaved text", async () => {
    const changed = replaceParagraph(disk(), 1, "Changed in another editor.");
    writeFileSync(join(root, SCENE), changed);
    expect(await ws.fileChanged({ type: "change", path: SCENE, hash: hashText(changed) })).toBe(true);
    expect(file().body).toContain("Changed in another editor.");
  });

  it("leaves a scene with text being typed alone, and merges the change into its next save", async () => {
    const typed = replaceParagraph(file().body, 0, "Typed here, not reported yet.");
    const off = ws.live(SCENE, () => typed);
    const other = replaceParagraph(disk(), 3, "Changed on disk meanwhile.");
    writeFileSync(join(root, SCENE), other);
    await ws.fileChanged({ type: "change", path: SCENE, hash: hashText(other) });
    expect(file().body).not.toContain("Changed on disk meanwhile.");

    // The editor reports its text; the save is refused, merged paragraph by paragraph, and saved.
    ws.change(SCENE, typed);
    await until(() => disk().includes("Typed here") && disk().includes("Changed on disk meanwhile."));
    expect(ws.store.getState().conflicts).toEqual([]);
    expect(file().body).toContain("Changed on disk meanwhile.");
    off();
  });

  it("hands a clash in the same paragraph to the author, then saves the resolution", async () => {
    const theirs = replaceParagraph(disk(), 1, "Their version of the paragraph.");
    writeFileSync(join(root, SCENE), theirs);
    ws.change(SCENE, replaceParagraph(file().body, 1, "My version of the paragraph."));
    await until(() => ws.store.getState().conflicts.length === 1);
    const [conflict] = ws.store.getState().conflicts;
    expect(conflict!.chunks.filter((c) => c.type === "conflict")).toEqual([
      expect.objectContaining({ ours: expect.stringContaining("My version"), theirs: expect.stringContaining("Their version") }),
    ]);
    expect(disk()).toBe(theirs);

    const resolved = replaceParagraph(theirs, 1, "My version of the paragraph.\n\nTheir version of the paragraph.");
    ws.resolve(SCENE, resolved);
    await until(() => disk() === resolved);
    expect(file().body).toContain("My version of the paragraph.\n\nTheir version");
    expect(ws.store.getState().conflicts).toEqual([]);
  });

  it("asks before writing back a scene deleted on disk, and closes it if told to", async () => {
    unlinkSync(join(root, SCENE));
    ws.change(SCENE, `${file().body}Mine.\n`);
    await until(() => ws.store.getState().conflicts.length === 1);
    expect(ws.store.getState().conflicts[0]).toMatchObject({ deleted: true });
    ws.resolve(SCENE, null);
    expect(ws.store.getState().files[SCENE]).toBeUndefined();
    await sleep(100);
    expect(() => disk()).toThrow();
  });

  it("reports whether a change was to an open file", async () => {
    expect(await ws.fileChanged({ type: "change", path: "bible/characters/ada.md", hash: "x" })).toBe(false);
  });
});

describe("editing the front matter of a scene that isn't open", () => {
  const hold = () => {
    let release!: () => void;
    return { gate: new Promise<void>((r) => (release = r)), release: () => release() };
  };
  const status = (value: string) => [{ path: ["status"], value }];
  let other: Workspace;
  afterEach(() => other?.dispose());

  it("writes the file, and a scene opened mid-write shows the edit", async () => {
    const { gate, release } = hold();
    other = createWorkspace({ api: { ...api, writeFile: async (...a) => (await gate, api.writeFile(...a)) }, novelId, interval: 30, storage: null });
    const editing = other.editFrontMatter(SCENE, status("revised"));
    const opening = other.open([SCENE]);
    await sleep(50);
    release();
    await Promise.all([editing, opening]);
    expect(disk()).toContain("status: revised");
    expect(other.store.getState().files[SCENE]!.frontMatter).toContain("status: revised");
  });

  it("edits a scene being opened once it's open, through its autosave", async () => {
    const { gate, release } = hold();
    other = createWorkspace({ api: { ...api, readFile: async (...a) => (await gate, api.readFile(...a)) }, novelId, interval: 30, storage: null });
    const opening = other.open([SCENE]);
    const editing = other.editFrontMatter(SCENE, status("revised"));
    release();
    await Promise.all([opening, editing]);
    expect(other.store.getState().files[SCENE]!.frontMatter).toContain("status: revised");
    await other.autosave.flush();
    expect(disk()).toContain("status: revised");
  });

  it("makes edits one after another, each on the last one's file", async () => {
    other = createWorkspace({ api, novelId, interval: 30, storage: null });
    await Promise.all([other.editFrontMatter(SCENE, status("revised")), other.editFrontMatter(SCENE, [{ path: ["synopsis"], value: "Both kept." }])]);
    expect(disk()).toContain("status: revised");
    expect(disk()).toContain("synopsis: Both kept.");
  });
});
