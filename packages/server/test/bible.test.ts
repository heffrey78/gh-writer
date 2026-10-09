import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadNovel, relationshipsAt, validateNovel } from "@gh-writer/core";
import { nodeSource } from "@gh-writer/core/node";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BibleOperations, createServer, hashText, Library, sessionCookie, transaction } from "../src/index.ts";
import { gitIn, novelRepo, scratch } from "./fixtures.ts";
import { send } from "./http.ts";

const ADA = "char_7f3k2q";
const BEN = "char_b3n0vs";
const ADA_FILE = "bible/characters/ada.md";

let fresh: (name: string) => string;
let cleanUp: () => void;
let tmp: string;
let dir: string;
let bible: BibleOperations;

beforeAll(() => ({ fresh, cleanUp, tmp } = scratch("bible")));
afterAll(() => cleanUp());

beforeEach(() => {
  dir = novelRepo(fresh("novel"));
  bible = new BibleOperations(dir, (fn) => fn());
});

const read = (path: string) => readFileSync(join(dir, path), "utf8");
const hash = (path: string) => hashText(readFileSync(join(dir, path)));
const lastCommit = () => gitIn(dir, "log", "-1", "--format=%s").trim();
const changedInLastCommit = () => gitIn(dir, "show", "--name-status", "--format=", "HEAD").trim().split("\n").sort();
const clean = () => expect(gitIn(dir, "status", "--porcelain")).toBe("");
const model = () => loadNovel(nodeSource(dir));
async function valid() {
  const novel = await model();
  expect(validateNovel(novel).filter((d) => d.severity === "error")).toEqual([]);
  return novel;
}

describe("entities", () => {
  it("adds an entity in its type's folder, with a new ID, as one commit", async () => {
    const { id, file, commit } = await bible.createEntity("character", { name: "Ilse Varn", aliases: ["Ilse"], summary: "Ada's aunt." }, "Lives above the toll house.");
    expect(id).toMatch(/^char_[0-9a-hjkmnp-tv-z]{6}$/);
    expect(file).toBe("bible/characters/ilse-varn.md");
    expect(read(file)).toBe(`---\nid: ${id}\nname: Ilse Varn\naliases:\n  - Ilse\nsummary: Ada's aunt.\n---\n\nLives above the toll house.\n`);
    expect(commit).toBe(gitIn(dir, "rev-parse", "HEAD").trim());
    expect(lastCommit()).toBe("Bible: add Ilse Varn");
    clean();
    expect((await valid()).entities.find((e) => e.id === id)?.name).toBe("Ilse Varn");
  });

  it("takes an ID the app picked, if it's new and of the type; a retry returns what was made", async () => {
    const { id, file, commit } = await bible.createEntity("character", { name: "Mira Kostova" }, "", "char_m1rak0");
    expect([id, file]).toEqual(["char_m1rak0", "bible/characters/mira-kostova.md"]);
    expect(read(file)).toBe("---\nid: char_m1rak0\nname: Mira Kostova\n---\n");
    expect(commit).not.toBeNull();
    // The same again (a response lost on the way): nothing new, the same entry.
    const head = gitIn(dir, "rev-parse", "HEAD").trim();
    expect(await bible.createEntity("character", { name: "Mira Kostova" }, "", "char_m1rak0")).toEqual({ commit: null, files: [], id, file });
    expect(gitIn(dir, "rev-parse", "HEAD").trim()).toBe(head);
    // Taken by something else, the wrong type's prefix, or not an ID at all.
    for (const [type, name, wanted] of [["character", "Someone Else", "char_m1rak0"], ["character", "Ada Again", ADA], ["location", "Mira's House", "char_zzzzzz"], ["character", "Odd", "nonsense"]] as const) {
      await expect(bible.createEntity(type, { name }, "", wanted)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
    clean();
    await valid();
  });

  it("renames by changing one file and no references", async () => {
    const before = read(ADA_FILE);
    const { file } = await bible.updateEntity(ADA, hash(ADA_FILE), { name: "Ada Kost" });
    expect(file).toBe("bible/characters/ada-kost.md");
    expect(existsSync(join(dir, ADA_FILE))).toBe(false);
    expect(read(file)).toBe(before.replace("name: Ada Varn", "name: Ada Kost"));
    expect(lastCommit()).toBe("Bible: rename Ada Varn to Ada Kost");
    // git sees one file renamed, and nothing else.
    expect(gitIn(dir, "show", "-M", "--name-status", "--format=", "HEAD").trim()).toMatch(/^R\d+\tbible\/characters\/ada\.md\tbible\/characters\/ada-kost\.md$/);
    const novel = await valid();
    expect(novel.entities.find((e) => e.id === ADA)?.name).toBe("Ada Kost");
  });

  it("edits fields in place, and refuses an edit based on an old version", async () => {
    const base = hash(ADA_FILE);
    await bible.updateEntity(ADA, base, { summary: "Engineer.", tags: ["protagonist", "engineer"], fields: { age: 32, occupation: "Structural engineer" } });
    expect(lastCommit()).toBe("Bible: edit Ada Varn");
    const novel = await valid();
    expect(novel.entities.find((e) => e.id === ADA)).toMatchObject({ summary: "Engineer.", tags: ["protagonist", "engineer"], fields: { age: 32 } });
    await expect(bible.updateEntity(ADA, base, { summary: "Again." })).rejects.toMatchObject({ code: "STALE" });
    await expect(bible.updateEntity(ADA, hash(ADA_FILE), { name: " " })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("refuses to delete an entity that's referred to, listing every reference, until confirmed", async () => {
    const head = gitIn(dir, "rev-parse", "HEAD").trim();
    const refusal = await bible.deleteEntity(ADA, hash(ADA_FILE)).catch((e: unknown) => e);
    expect(refusal).toMatchObject({ code: "REFERENCED" });
    const references = (refusal as { details: { references: { kind: string; id: string }[] } }).details.references;
    expect(references).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "scene", id: "sc_5tat1n" }), expect.objectContaining({ kind: "relationship" })]));
    expect(gitIn(dir, "rev-parse", "HEAD").trim()).toBe(head);
    expect(existsSync(join(dir, ADA_FILE))).toBe(true);

    await bible.deleteEntity(ADA, hash(ADA_FILE), true);
    expect(existsSync(join(dir, ADA_FILE))).toBe(false);
    expect(lastCommit()).toBe("Bible: remove Ada Varn");
    expect(changedInLastCommit()).toEqual([`D\t${ADA_FILE}`]);
  });

  it("deletes an entity nobody refers to without asking", async () => {
    const { id, file } = await bible.createEntity("location", { name: "The Old Mill" });
    await bible.deleteEntity(id, hash(file));
    expect(existsSync(join(dir, file))).toBe(false);
    await valid();
  });
});

describe("relationships", () => {
  it("adds, changes at a scene, ends and removes a relationship", async () => {
    const before = (await model()).relationships.length;
    const { id } = await bible.createRelationship({ from: ADA, to: "char_m1re1a", type: "allies", note: "Against the council." });
    expect(lastCommit()).toBe("Bible: Ada Varn allies Mirela Kost");
    let novel = await valid();
    expect(novel.relationships).toHaveLength(before + 1);

    // From "The Betrayal" on, they're rivals.
    const { id: next } = await bible.changeRelationship(id, "sc_0d9wm4", { type: "rivals" });
    novel = await valid();
    expect(novel.relationships.find((r) => r.id === id)).toMatchObject({ type: "allies", until: "sc_0d9wm4" });
    expect(novel.relationships.find((r) => r.id === next)).toMatchObject({ type: "rivals", since: "sc_0d9wm4", note: "Against the council." });
    const between = (scene: string) => relationshipsAt(novel, scene).filter((r) => [r.from, r.to].includes("char_m1re1a") && [r.from, r.to].includes(ADA)).map((r) => r.type);
    expect(between("sc_br1dg3")).toContain("allies");
    expect(between("sc_br1dg3")).not.toContain("rivals");
    expect(between("sc_f100d0")).toContain("rivals");
    expect(between("sc_f100d0")).not.toContain("allies");

    await bible.endRelationship(next, "sc_r1vet8");
    expect((await valid()).relationships.find((r) => r.id === next)?.until).toBe("sc_r1vet8");
    await bible.updateRelationship(next, { note: null });
    expect((await model()).relationships.find((r) => r.id === next)?.note).toBeUndefined();
    await bible.deleteRelationship(id);
    expect((await valid()).relationships.some((r) => r.id === id)).toBe(false);
    clean();
  });

  it("refuses relationships that don't fit the novel", async () => {
    await expect(bible.createRelationship({ from: ADA, to: "char_zzzzzz", type: "allies" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(bible.createRelationship({ from: ADA, to: BEN, type: "enemies" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(bible.createRelationship({ from: ADA, to: BEN, type: "allies", since: "sc_f100d0", until: "sc_5tat1n" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("writes the first relationship of an empty file as a block list", async () => {
    writeFileSync(join(dir, "bible/relationships.yaml"), "# Every relationship, once.\nrelationships: []\n");
    gitIn(dir, "commit", "-qam", "Empty");
    const { id } = await bible.createRelationship({ from: ADA, to: BEN, type: "sibling" });
    expect(read("bible/relationships.yaml")).toBe(`# Every relationship, once.\nrelationships:\n  - id: ${id}\n    from: ${ADA}\n    to: ${BEN}\n    type: sibling\n`);
  });
});

describe("types", () => {
  it("adds a custom entity type, then entries of it, without code changes", async () => {
    await bible.createEntityType({ key: "vehicle", prefix: "veh", label: "Vehicle", color: "17becf" });
    expect(lastCommit()).toBe("Bible: add the Vehicle type");
    const { file, id } = await bible.createEntity("vehicle", { name: "The Night Train" });
    expect(file).toBe("bible/vehicles/the-night-train.md");
    expect(id).toMatch(/^veh_/);
    const novel = await valid();
    expect(novel.entities.find((e) => e.id === id)?.type).toBe("vehicle");
    await expect(bible.createEntityType({ key: "vehicle", prefix: "vhc", label: "Again" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(bible.createEntityType({ key: "boat", prefix: "char", label: "Boat" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await bible.updateEntityType("vehicle", { label: "Vehicles and craft" });
    expect((await model()).entityTypes.find((t) => t.key === "vehicle")?.label).toBe("Vehicles and craft");
  });

  it("adds a relationship type and uses it at once", async () => {
    await bible.createRelationshipType({ key: "owes-favour", label: "Owes a favour to", inverse_label: "Is owed a favour by", from_types: ["character"], to_types: ["character"] });
    await bible.createRelationship({ from: BEN, to: ADA, type: "owes-favour" });
    await valid();
    await bible.updateRelationshipType("owes-favour", { label: "Owes one to" });
    expect((await model()).relationshipTypes.find((t) => t.key === "owes-favour")?.label).toBe("Owes one to");
  });
});

describe("transactions", () => {
  it("puts back every file it changed when one change fails, and commits nothing", async () => {
    const head = gitIn(dir, "rev-parse", "HEAD").trim();
    const before = read(ADA_FILE);
    await expect(
      transaction(dir, [{ path: ADA_FILE, content: "changed\n" }, { path: "bible/characters/new.md", content: "new\n" }, { path: "bible/../../escape.md", content: "x" }], "Never"),
    ).rejects.toThrow();
    expect(read(ADA_FILE)).toBe(before);
    expect(existsSync(join(dir, "bible/characters/new.md"))).toBe(false);
    expect(gitIn(dir, "rev-parse", "HEAD").trim()).toBe(head);
    clean();
  });

  it("changes nothing without a git identity", async () => {
    const global = process.env.GIT_CONFIG_GLOBAL;
    const empty = join(tmp, "no-identity");
    writeFileSync(empty, "");
    process.env.GIT_CONFIG_GLOBAL = empty;
    try {
      await expect(bible.createEntity("character", { name: "Nobody" })).rejects.toMatchObject({ code: "BLOCKED", message: expect.stringContaining("git config --global user.name") });
      expect(existsSync(join(dir, "bible/characters/nobody.md"))).toBe(false);
    } finally {
      process.env.GIT_CONFIG_GLOBAL = global;
    }
  });
});

describe("through the server", () => {
  it("answers each operation, and its refusals with their codes", async () => {
    const library = await Library.open({ configDir: fresh("config") });
    const novel = await library.add(dir);
    const server = await createServer({ library, token: "t", sync: false, commit: false });
    const headers = { cookie: `${sessionCookie(server.port)}=t`, origin: server.url, "content-type": "application/json" };
    const call = (method: string, path: string, body: unknown = {}) => send(server.port, `/api/novels/${novel.id}/bible${path}`, { method, headers, body: JSON.stringify(body) });
    try {
      const created = await call("POST", "/entities", { type: "location", name: "The Toll House" });
      expect(created.status).toBe(201);
      const { id, file } = JSON.parse(created.body) as { id: string; file: string };
      // An ID in the body is the one asked for, never a field written unchecked.
      const picked = await call("POST", "/entities", { type: "location", name: "The Weir", id: "loc_we1r00" });
      expect(JSON.parse(picked.body)).toMatchObject({ id: "loc_we1r00", file: "bible/locations/the-weir.md" });
      expect(read("bible/locations/the-weir.md")).toBe("---\nid: loc_we1r00\nname: The Weir\n---\n");
      expect((await call("POST", "/entities", { type: "location", name: "Bad", id: ADA })).status).toBe(400);
      expect((await call("PATCH", `/entities/${id}`, { base: hash(file), changes: { summary: "By the bridge." } })).status).toBe(200);
      expect(JSON.parse((await call("PATCH", `/entities/${id}`, { base: "0".repeat(64), changes: { summary: "x" } })).body)).toMatchObject({ code: "STALE", path: file });
      const refused = await call("POST", `/entities/${ADA}/delete`, { base: hash(ADA_FILE) });
      expect(refused.status).toBe(409);
      expect(JSON.parse(refused.body)).toMatchObject({ code: "REFERENCED", references: expect.any(Array) });
      const rel = await call("POST", "/relationships", { from: ADA, to: BEN, type: "rivals" });
      expect(rel.status).toBe(201);
      const relId = (JSON.parse(rel.body) as { id: string }).id;
      expect((await call("POST", `/relationships/${relId}/end`, { at: "sc_f100d0" })).status).toBe(200);
      expect((await call("POST", "/relationships", { from: ADA, to: BEN, type: "nope" })).status).toBe(400);
      expect((await call("POST", "/relationships/rel_zzzzzz/delete")).status).toBe(404);
    } finally {
      await server.close();
    }
  });
});

describe("events", () => {
  const EVENTS = "bible/events.yaml";

  it("adds an event as one commit, changing only the end of the list", async () => {
    const before = read(EVENTS);
    const { id } = await bible.createEvent({ title: "Ben meets Mirela", when: { day: 2, time: "22:00" }, duration: "PT1H", characters: [BEN, "char_m1re1a"], locations: ["loc_br1dg3"] });
    expect(id).toMatch(/^evt_[0-9a-hjkmnp-tv-z]{6}$/);
    expect(read(EVENTS)).toBe(`${before}  - id: ${id}\n    title: Ben meets Mirela\n    when:\n      day: 2\n      time: "22:00"\n    duration: PT1H\n    characters:\n      - ${BEN}\n      - char_m1re1a\n    locations:\n      - loc_br1dg3\n`);
    expect(lastCommit()).toBe("Bible: add event “Ben meets Mirela”");
    clean();
    await valid();
  });

  it("edits an event's fields in place, and removes it", async () => {
    const before = read(EVENTS);
    await bible.updateEvent("evt_1eave5", { when: { at: "2012-09-03" }, note: "By the night train." });
    const after = read(EVENTS);
    expect(after.replace("      at: 2012-09-03\n    characters", "      at: 2012-09-01\n    characters").replace("    note: By the night train.\n", "")).toBe(before);
    expect(lastCommit()).toBe("Bible: edit event “Ada leaves for the polytechnic”");
    await bible.updateEvent("evt_1eave5", { note: null });
    expect(read(EVENTS)).not.toContain("By the night train.");
    await bible.deleteEvent("evt_1eave5");
    expect(read(EVENTS)).not.toContain("evt_1eave5");
    expect(lastCommit()).toBe("Bible: remove event “Ada leaves for the polytechnic”");
    clean();
    await valid();
  });

  it("refuses an event without a title, with a bad time or duration, or naming the wrong kind of entry", async () => {
    await expect(bible.createEvent({ title: " " })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(bible.createEvent({ title: "X", when: { day: 2, time: "25:00" } })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(bible.createEvent({ title: "X", when: { at: "yesterday" } })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(bible.createEvent({ title: "X", duration: "an hour" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(bible.createEvent({ title: "X", characters: ["loc_br1dg3"] })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(bible.updateEvent("evt_zzzzzz", { title: "Y" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
