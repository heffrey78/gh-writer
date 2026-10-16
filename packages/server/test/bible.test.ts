import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadNovel, relationshipsAt, relationshipStyle, validateNovel } from "@gh-writer/core";
import { nodeSource } from "@gh-writer/core/node";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BibleOperations, createServer, hashText, Library, ManuscriptOperations, sessionCookie, transaction } from "../src/index.ts";
import { asFormatV1, gitIn, novelRepo, scratch } from "./fixtures.ts";
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

  it("gives a new relationship type the first colour no type uses, and changes only its style's lines", async () => {
    const model0 = await model();
    const before = model0.relationshipTypes.map((t) => [t.key, relationshipStyle(model0, t.key)]);
    // Used in the sample: series-1, 4, 5, 6, 7 and 8 (some by their place in the list); 2 is free.
    await bible.createRelationshipType({ key: "loves", label: "Loves" });
    const novel = await model();
    expect(novel.relationshipTypes.find((t) => t.key === "loves")?.style).toEqual({ color: "series-2", line: "solid" });
    // Nobody else repainted.
    expect(novel.relationshipTypes.filter((t) => t.key !== "loves").map((t) => [t.key, relationshipStyle(novel, t.key)])).toEqual(before);

    const yaml = read("novel.yaml");
    await bible.updateRelationshipType("rivals", { style: { color: "series-7", line: "dotted" } });
    expect(read("novel.yaml")).toBe(yaml.replace("style: { color: series-8, line: dashed }", "style: { color: series-7, line: dotted }"));
    await bible.updateRelationshipType("sibling", { style: { color: "series-3" } });
    expect(relationshipStyle(await model(), "sibling")).toEqual({ slot: "series-3", line: "solid" });
    await valid();

    // Only the palette: never the status colours, nor a colour of its own.
    await expect(bible.updateRelationshipType("rivals", { style: { color: "danger" as never } })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(bible.createRelationshipType({ key: "hates", label: "Hates", style: { color: "#ff0000" as never } })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(bible.updateRelationshipType("rivals", { style: { line: "wavy" as never } })).rejects.toMatchObject({ code: "BAD_REQUEST" });
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
      await expect(bible.createEntity("character", { name: "Nobody" })).rejects.toMatchObject({ code: "BLOCKED", message: expect.stringContaining("Your name and email") });
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
  const FLOOD = "bible/events/the-flood-of-09.md";
  const LEAVING = "bible/events/ada-leaves-for-the-polytechnic.md";

  it("adds an event as a file of its own, its note as prose, as one commit", async () => {
    const { id, file } = await bible.createEvent({ title: "Ben meets Mirela", when: { day: 2, time: "22:00" }, duration: "PT1H", characters: [BEN, "char_m1re1a"], locations: ["loc_br1dg3"], note: "At the [toll house](#loc_br1dg3)." });
    expect(id).toMatch(/^evt_[0-9a-hjkmnp-tv-z]{6}$/);
    expect(file).toBe("bible/events/ben-meets-mirela.md");
    expect(read(file)).toBe(`---\nid: ${id}\ntitle: Ben meets Mirela\nwhen:\n  day: 2\n  time: "22:00"\nduration: PT1H\ncharacters:\n  - ${BEN}\n  - char_m1re1a\nlocations:\n  - loc_br1dg3\n---\n\nAt the [toll house](#loc_br1dg3).\n`);
    expect(lastCommit()).toBe("Bible: add event “Ben meets Mirela”");
    expect(changedInLastCommit()).toEqual([`A\t${file}`]);
    clean();
    expect((await valid()).events.find((e) => e.id === id)?.body).toBe("\nAt the [toll house](#loc_br1dg3).\n");
  });

  it("edits an event's fields in its front matter, and its note as the prose, checked against the file it was read from", async () => {
    const before = read(LEAVING);
    await bible.updateEvent("evt_1eave5", { when: { at: "2012-09-03" }, scene: "sc_5tat1n", note: "By the night train." }, { base: hashText(before) });
    expect(read(LEAVING)).toBe(before.replace("at: 2012-09-01", "at: 2012-09-03").replace(/---\n$/, "scene: sc_5tat1n\n---\n\nBy the night train.\n"));
    expect(lastCommit()).toBe("Bible: edit event “Ada leaves for the polytechnic”");
    await bible.updateEvent("evt_1eave5", { note: null, scene: null });
    expect(read(LEAVING)).toBe(before.replace("at: 2012-09-01", "at: 2012-09-03"));
    await expect(bible.updateEvent("evt_1eave5", { duration: "P1D" }, { base: hashText(before) })).rejects.toMatchObject({ code: "STALE", details: { path: LEAVING } });
    clean();
    await valid();
  });

  it("a new title moves the file to match", async () => {
    const before = read(FLOOD);
    const { file } = await bible.updateEvent("evt_9ab3kd", { title: "The great flood" });
    expect(file).toBe("bible/events/the-great-flood.md");
    expect(existsSync(join(dir, FLOOD))).toBe(false);
    expect(read(file)).toBe(before.replace("title: The flood of '09", "title: The great flood"));
    expect(lastCommit()).toBe("Bible: rename event “The flood of '09” to “The great flood”");
    expect(gitIn(dir, "show", "--no-renames", "--name-status", "--format=", "HEAD").trim().split("\n").sort()).toEqual([`A\t${file}`, `D\t${FLOOD}`]);
    clean();
    await valid();
  });

  it("removes an event; one that prose mentions only once confirmed", async () => {
    await bible.deleteEvent("evt_1eave5");
    expect(existsSync(join(dir, LEAVING))).toBe(false);
    expect(lastCommit()).toBe("Bible: remove event “Ada leaves for the polytechnic”");

    const scene = "manuscript/01-return/01-arrival/01-the-station.md";
    writeFileSync(join(dir, scene), `${read(scene).trimEnd()}\n\nShe thought of [the flood](#evt_9ab3kd).\n`);
    writeFileSync(join(dir, "bible/characters/ada.md"), `${read("bible/characters/ada.md").trimEnd()}\n\nShe was eleven at [the flood](#evt_9ab3kd).\n`);
    gitIn(dir, "commit", "-qam", "Mentions");
    await expect(bible.deleteEvent("evt_9ab3kd")).rejects.toMatchObject({
      code: "REFERENCED",
      details: {
        references: [
          { kind: "scene", id: "sc_5tat1n", title: "The Station", via: ["mention"] },
          { kind: "entity", id: ADA, title: "Ada Varn" },
          { kind: "note", id: "note_w1fben", title: "What if Ben never sold the plans?" },
        ],
      },
    });
    expect(existsSync(join(dir, FLOOD))).toBe(true);
    await bible.deleteEvent("evt_9ab3kd", { confirm: true });
    expect(existsSync(join(dir, FLOOD))).toBe(false);
    clean();
  });

  it("writes an event as a scene at a chapter's end, keeping the event (naming the scene) or removing it, in one commit", async () => {
    const manuscript = new ManuscriptOperations(dir, (fn) => fn());
    const { scene, file } = await bible.writeAsScene("evt_p1an5t", { chapter: "ch_01dde6", keep: true }, manuscript);
    expect(file).toMatch(/^manuscript\/01-return\/02-[a-z-]+\/0\d-the-plans-are-stolen\.md$/);
    expect(read(file)).toBe(`---\nid: ${scene}\ntitle: The plans are stolen\nsynopsis: Off page. Ben uses Tomas's key.\nstatus: idea\ncharacters:\n  - char_b3n0vs\nlocations:\n  - loc_w0rk5p\nplotlines:\n  - plot_h315tz\n  - plot_gr1efa\nwhen:\n  day: -5\n---\n`);
    expect(read("bible/events/the-plans-are-stolen.md")).toContain(`\nscene: ${scene}\n---\n`);
    expect(lastCommit()).toBe("Manuscript: write “The plans are stolen” as a scene");
    clean();
    const novel = await valid();
    expect(novel.chapters.find((c) => c.id === "ch_01dde6")?.sceneIds.at(-1)).toBe(scene);

    await bible.writeAsScene("evt_1eave5", { chapter: "ch_01dde6", keep: false }, manuscript);
    expect(existsSync(join(dir, LEAVING))).toBe(false);
    expect(lastCommit()).toBe("Manuscript: write “Ada leaves for the polytechnic” as a scene, removing the event");
    clean();
    await valid();
  });

  it("won't remove an event the prose mentions when writing it as a scene", async () => {
    const scene = "manuscript/01-return/01-arrival/01-the-station.md";
    writeFileSync(join(dir, scene), `${read(scene).trimEnd()}\n\nShe thought of [the flood](#evt_9ab3kd).\n`);
    gitIn(dir, "commit", "-qam", "Mention");
    const head = gitIn(dir, "rev-parse", "HEAD");
    await expect(bible.writeAsScene("evt_9ab3kd", { chapter: "ch_01dde6", keep: false }, new ManuscriptOperations(dir, (fn) => fn()))).rejects.toMatchObject({ code: "REFERENCED" });
    expect(gitIn(dir, "rev-parse", "HEAD")).toBe(head);
  });

  describe("in a novel in format v1", () => {
    beforeEach(() => {
      asFormatV1(dir);
      gitIn(dir, "add", "-A");
      gitIn(dir, "commit", "-qm", "Format v1");
    });

    it("refuses an event change with NEEDS_MIGRATION, writing nothing", async () => {
      const head = gitIn(dir, "rev-parse", "HEAD");
      await expect(bible.createEvent({ title: "Storm" })).rejects.toMatchObject({ code: "NEEDS_MIGRATION", details: { from: 1, to: 2 } });
      await expect(bible.updateEvent("evt_1eave5", { duration: "P1D" })).rejects.toMatchObject({ code: "NEEDS_MIGRATION" });
      await expect(bible.deleteEvent("evt_1eave5")).rejects.toMatchObject({ code: "NEEDS_MIGRATION" });
      expect(gitIn(dir, "rev-parse", "HEAD")).toBe(head);
      clean();
    });

    it("with migrate, moves the novel to v2 and makes the change, in one commit", async () => {
      const { file } = await bible.updateEvent("evt_1eave5", { duration: "P1D", note: "By the night train." }, { migrate: true });
      expect(file).toBe(LEAVING);
      expect(lastCommit()).toBe("Format v2: off-page events as files; Bible: edit event “Ada leaves for the polytechnic”");
      expect(changedInLastCommit()).toEqual([
        `A\t${LEAVING}`,
        `A\t${FLOOD}`,
        "A\tbible/events/the-plans-are-stolen.md",
        "D\tbible/events.yaml",
        "M\tnovel.yaml",
      ].sort());
      expect(read(LEAVING)).toBe("---\nid: evt_1eave5\ntitle: Ada leaves for the polytechnic\nwhen:\n  at: 2012-09-01\ncharacters:\n  - char_7f3k2q\nlocations:\n  - loc_5tat10\nduration: P1D\n---\n\nBy the night train.\n");
      clean();
      const novel = await valid();
      expect(novel.config?.schema_version).toBe(2);
      expect(validateNovel(novel)).toEqual([]);
    });

    it("migrates on its own, from POST /migrate", async () => {
      expect(await bible.migrate()).toMatchObject({ migrated: true });
      expect(lastCommit()).toBe("Format v2: off-page events as files");
      expect(await bible.migrate()).toEqual({ commit: null, files: [], migrated: false });
      clean();
    });
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

describe("notes (D12)", () => {
  const IDEA = "notes/what-if-ben-never-sold.md";
  const today = new Date().toLocaleDateString("en-CA");
  const now = (text: string) => /\ncreated: (\d{4}-\d{2}-\d{2})T\d{2}:\d{2}:\d{2}\n/.exec(text)?.[1];

  it("adds a note dated today, its prose the note, as one commit", async () => {
    const { id, file } = await bible.createNote({ title: "A toll on the bridge", tags: ["money"], note: "Who sets it? [Ben](#char_b3n0vs)?" });
    expect(id).toMatch(/^note_[0-9a-hjkmnp-tv-z]{6}$/);
    expect(file).toBe("notes/a-toll-on-the-bridge.md");
    expect(read(file).replace(/T\d{2}:\d{2}:\d{2}\n/, "\n")).toBe(`---\nid: ${id}\ntitle: A toll on the bridge\ntags:\n  - money\ncreated: ${today}\n---\n\nWho sets it? [Ben](#char_b3n0vs)?\n`);
    expect(now(read(file))).toBe(today);
    expect(lastCommit()).toBe("Notes: add “A toll on the bridge”");
    clean();
    expect((await valid()).notes.map((n) => n.id)).toContain(id);
  });

  it("edits tags and prose against the file as read, renames with a new title, and removes it", async () => {
    const before = read(IDEA);
    await bible.updateNote("note_w1fben", { tags: null, note: "Then the bridge stands." }, { base: hashText(before) });
    expect(read(IDEA)).toBe("---\nid: note_w1fben\ntitle: What if Ben never sold the plans?\ncreated: 2026-10-15\n---\n\nThen the bridge stands.\n");
    await expect(bible.updateNote("note_w1fben", { tags: ["x"] }, { base: hashText(before) })).rejects.toMatchObject({ code: "STALE" });
    const { file } = await bible.updateNote("note_w1fben", { title: "Ben keeps the plans" });
    expect(file).toBe("notes/ben-keeps-the-plans.md");
    expect(existsSync(join(dir, IDEA))).toBe(false);
    expect(lastCommit()).toBe("Notes: rename “What if Ben never sold the plans?” to “Ben keeps the plans”");
    await bible.deleteNote("note_w1fben");
    expect(existsSync(join(dir, file))).toBe(false);
    expect(lastCommit()).toBe("Notes: remove “Ben keeps the plans”");
    clean();
  });

  it("promotes a note to an off-page event, keeping it (became names the event)", async () => {
    const { id, file } = await bible.promoteNote("note_w1fben", { to: "event" }, { keep: true }, new ManuscriptOperations(dir, (fn) => fn()));
    expect(file).toBe("bible/events/what-if-ben-never-sold-the-plans.md");
    expect(read(file)).toBe(`---\nid: ${id}\ntitle: What if Ben never sold the plans?\n---\n\nThen [Ada](#char_7f3k2q) has no reason to come home, and the bridge stands. Unless the debt goes back to [the flood](#evt_9ab3kd).\n`);
    expect(read(IDEA)).toContain(`\nbecame: ${id}\n---\n`);
    expect(lastCommit()).toBe("Notes: promote “What if Ben never sold the plans?” to an off-page event");
    clean();
    await valid();
  });

  it("writes a note as a scene, removing the note", async () => {
    const { id, file } = await bible.promoteNote("note_w1fben", { to: "scene", chapter: "ch_h01d50" }, { keep: false }, new ManuscriptOperations(dir, (fn) => fn()));
    expect(read(file)).toBe(`---\nid: ${id}\ntitle: What if Ben never sold the plans?\nsynopsis: Then Ada has no reason to come home, and the bridge stands. Unless the debt goes back to the flood.\nstatus: idea\n---\n`);
    expect(existsSync(join(dir, IDEA))).toBe(false);
    expect(lastCommit()).toBe("Notes: write “What if Ben never sold the plans?” as a scene, removing the note");
    clean();
    await valid();
  });

  it("an entry a note mentions is only deleted once confirmed", async () => {
    await expect(bible.deleteEntity(ADA, hash(ADA_FILE))).rejects.toMatchObject({ code: "REFERENCED", details: { references: expect.arrayContaining([{ kind: "note", id: "note_w1fben", title: "What if Ben never sold the plans?" }]) } });
  });
});

describe("scene notes (#222)", () => {
  const STATION = "sc_5tat1n";
  const SPAN = "sc_br1dg3";
  const manuscript = () => new ManuscriptOperations(dir, (fn) => fn());
  const front = (path: string) => read(path).split("---\n")[1]!;

  it("makes a note on a scene, and pins one note per scene, unpinning the other in the same commit", async () => {
    const a = await bible.createNote({ title: "Flags", scenes: [STATION] });
    expect(read(a.file)).toContain(`scenes:\n  - ${STATION}\n`);
    await bible.updateNote("note_w1fben", { scenes: [STATION, SPAN] });
    await bible.pinNote(a.id, STATION, true);
    expect(front(a.file)).toContain(`pinned:\n  - ${STATION}\n`);
    await bible.pinNote("note_w1fben", STATION, true);
    expect(lastCommit()).toBe("Notes: pin “What if Ben never sold the plans?” in “The Station”");
    expect(changedInLastCommit()).toEqual([`M\t${a.file}`, "M\tnotes/what-if-ben-never-sold.md"].sort());
    expect(front(a.file)).not.toContain("pinned");
    expect(front("notes/what-if-ben-never-sold.md")).toContain(`pinned:\n  - ${STATION}\n`);
    // Taking the scene off the note takes its pin too.
    await bible.updateNote("note_w1fben", { scenes: [SPAN] });
    expect(front("notes/what-if-ben-never-sold.md")).not.toContain("pinned");
    clean();
    expect(validateNovel(await valid()).filter((d) => d.code === "W_NOTE_PIN")).toEqual([]);
  });

  it("deleting a scene takes it off its notes; notes left on no scene are kept or deleted as asked", async () => {
    const only = await bible.createNote({ title: "Flags", scenes: [STATION] });
    await bible.updateNote("note_w1fben", { scenes: [STATION, SPAN] });
    await bible.pinNote("note_w1fben", STATION, true);
    const head = gitIn(dir, "rev-parse", "HEAD");
    await expect(manuscript().delete(STATION)).rejects.toMatchObject({ code: "NOTES_LEFT", details: { notes: [{ id: only.id, title: "Flags" }] } });
    expect(gitIn(dir, "rev-parse", "HEAD")).toBe(head);

    await manuscript().delete(STATION, { notes: "keep" });
    expect(front(only.file)).not.toContain("scenes");
    expect(front("notes/what-if-ben-never-sold.md")).toContain(`scenes:\n  - ${SPAN}\n`);
    expect(front("notes/what-if-ben-never-sold.md")).not.toContain("pinned");
    clean();
    await valid();

    await bible.updateNote(only.id, { scenes: [SPAN] });
    await manuscript().delete("ch_arr1va", { notes: "delete" });
    expect(existsSync(join(dir, only.file))).toBe(false);
    expect(existsSync(join(dir, "notes/what-if-ben-never-sold.md"))).toBe(false);
    clean();
    await valid();
  });

  it("merging scenes puts the merged one's notes on the scene that stays", async () => {
    await bible.updateNote("note_w1fben", { scenes: [SPAN] });
    await bible.pinNote("note_w1fben", SPAN, true);
    await manuscript().merge(STATION);
    expect(front("notes/what-if-ben-never-sold.md")).toContain(`scenes:\n  - ${STATION}\npinned:\n  - ${STATION}\n`);
    clean();
    await valid();
  });
});
