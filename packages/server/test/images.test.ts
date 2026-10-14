import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { loadNovel, validate } from "@gh-writer/core";
import { nodeSource } from "@gh-writer/core/node";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BibleOperations, createServer, hashText, Library, NovelWorkspace, sessionCookie } from "../src/index.ts";
import { gitIn, novelRepo, scratch } from "./fixtures.ts";
import { send } from "./http.ts";

const ADA = "char_7f3k2q";
const ADA_FILE = "bible/characters/ada.md";
const BEN = "char_b3n0vs";
const BEN_FILE = "bible/characters/ben.md";

/** A real PNG of `width` × `height` grey pixels. */
function png(width = 2, height = 2, shade = 128): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const out = Buffer.alloc(8 + data.length + 4);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc(body), 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 0, 0, 0, 0], 8); // 8-bit greyscale
  const rows = Buffer.concat(Array.from({ length: height }, () => Buffer.from([0, ...Array<number>(width).fill(shade)])));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}
/** Enough of a JPEG for the server, which goes by the first bytes. */
const jpeg = (fill = 1) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, fill), Buffer.from([0xff, 0xd9])]);

let fresh: (name: string) => string;
let cleanUp: () => void;
let dir: string;
let bible: BibleOperations;

beforeAll(() => ({ fresh, cleanUp } = scratch("images")));
afterAll(() => cleanUp());

beforeEach(() => {
  dir = novelRepo(fresh("novel"));
  bible = new BibleOperations(dir, (fn) => fn());
});

const read = (path: string) => readFileSync(join(dir, path), "utf8");
const hash = (path: string) => hashText(readFileSync(join(dir, path)));
const lastCommit = () => gitIn(dir, "log", "-1", "--format=%s").trim();
const changedInLastCommit = () => gitIn(dir, "show", "--name-status", "--format=", "HEAD").trim().split("\n").sort();
const commits = () => Number(gitIn(dir, "rev-list", "--count", "HEAD").trim());
const clean = () => expect(gitIn(dir, "status", "--porcelain")).toBe("");
const images = () => (existsSync(join(dir, "images")) ? gitIn(dir, "ls-files", "images").trim().split("\n").filter(Boolean) : []);
const warnings = async () => (await validate(nodeSource(dir))).diagnostics.filter((d) => d.code === "W_MISSING_IMAGE");

describe("an entry's picture", () => {
  it("is saved in images/ under the entry's name, with its focal point, as one commit", async () => {
    const before = commits();
    const { image, file, commit } = await bible.setPicture(ADA, hash(ADA_FILE), jpeg(), [0.52, 0.3]);
    expect([image, file]).toEqual(["images/ada-varn.jpg", ADA_FILE]);
    expect(readFileSync(join(dir, image))).toEqual(jpeg());
    expect(read(ADA_FILE)).toMatch(/\nimage: images\/ada-varn\.jpg\nimage_focus:\n  - 0\.52\n  - 0\.3\n/);
    expect(commit).toBe(gitIn(dir, "rev-parse", "HEAD").trim());
    expect(commits()).toBe(before + 1);
    expect(lastCommit()).toBe("Bible: add a picture of Ada Varn");
    expect(changedInLastCommit()).toEqual(["A\timages/ada-varn.jpg", `M\t${ADA_FILE}`]);
    clean();
    const novel = await loadNovel(nodeSource(dir));
    expect(novel.entities.find((e) => e.id === ADA)).toMatchObject({ image: "images/ada-varn.jpg", imageFocus: [0.52, 0.3] });
    expect(await warnings()).toEqual([]);
  });

  it("replaces the file when the picture changes, and takes a PNG's extension, leaving nothing behind", async () => {
    await bible.setPicture(ADA, hash(ADA_FILE), jpeg(1));
    await bible.setPicture(ADA, hash(ADA_FILE), jpeg(2), [0.5, 0.5]);
    expect(lastCommit()).toBe("Bible: change the picture of Ada Varn");
    expect(changedInLastCommit()).toEqual([`M\t${ADA_FILE}`, "M\timages/ada-varn.jpg"]);
    expect(readFileSync(join(dir, "images/ada-varn.jpg"))).toEqual(jpeg(2));
    // A PNG now (a picture with transparency): the JPEG goes.
    const { image } = await bible.setPicture(ADA, hash(ADA_FILE), png());
    expect(image).toBe("images/ada-varn.png");
    expect(images()).toEqual(["images/ada-varn.png"]);
    expect(read(ADA_FILE)).not.toContain("image_focus");
    clean();
  });

  it("is named with a suffix when another file has the name", async () => {
    mkdirSync(join(dir, "images"));
    writeFileSync(join(dir, "images/ada-varn.jpg"), jpeg(9));
    gitIn(dir, "add", "-A");
    gitIn(dir, "commit", "-qm", "Someone else's picture");
    const { image } = await bible.setPicture(ADA, hash(ADA_FILE), jpeg());
    expect(image).toBe("images/ada-varn-2.jpg");
    expect(readFileSync(join(dir, "images/ada-varn.jpg"))).toEqual(jpeg(9));
  });

  it("is removed with its file, as one commit", async () => {
    await bible.setPicture(ADA, hash(ADA_FILE), jpeg(), [0.5, 0.2]);
    const { commit } = await bible.removePicture(ADA, hash(ADA_FILE));
    expect(commit).not.toBeNull();
    expect(lastCommit()).toBe("Bible: remove the picture of Ada Varn");
    expect(changedInLastCommit()).toEqual(["D\timages/ada-varn.jpg", `M\t${ADA_FILE}`]);
    expect(read(ADA_FILE)).not.toMatch(/image/);
    expect(existsSync(join(dir, "images"))).toBe(false);
    clean();
  });

  it("leaves a picture kept elsewhere, or shown by another entry, where it is", async () => {
    mkdirSync(join(dir, "bible/images"), { recursive: true });
    writeFileSync(join(dir, "bible/images/ada.jpg"), jpeg(7));
    gitIn(dir, "add", "-A");
    gitIn(dir, "commit", "-qm", "A picture by hand");
    await bible.updateEntity(ADA, hash(ADA_FILE), { image: "bible/images/ada.jpg" });
    await bible.setPicture(ADA, hash(ADA_FILE), jpeg());
    expect(existsSync(join(dir, "bible/images/ada.jpg"))).toBe(true);

    // Ben shows Ada's picture too: removing hers keeps the file for him.
    await bible.updateEntity(BEN, hash(BEN_FILE), { image: "images/ada-varn.jpg" });
    await bible.removePicture(ADA, hash(ADA_FILE));
    expect(existsSync(join(dir, "images/ada-varn.jpg"))).toBe(true);
    clean();
  });

  it("goes with its entry when the entry is deleted", async () => {
    const { id } = await bible.createEntity("character", { name: "Ilse Varn" });
    const file = "bible/characters/ilse-varn.md";
    await bible.setPicture(id, hash(file), jpeg());
    await bible.deleteEntity(id, hash(file));
    expect(changedInLastCommit()).toEqual([`D\t${file}`, "D\timages/ilse-varn.jpg"]);
    clean();
  });

  it("is refused when the entry changed, the bytes aren't an image or the focal point is outside it", async () => {
    await expect(bible.setPicture(ADA, "0".repeat(64), jpeg())).rejects.toMatchObject({ code: "STALE" });
    await expect(bible.setPicture(ADA, hash(ADA_FILE), Buffer.from("GIF89a…"))).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(bible.setPicture(ADA, hash(ADA_FILE), jpeg(), [0.5, 1.5])).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(bible.setPicture("char_zzzzzz", "", jpeg())).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(images()).toEqual([]);
    clean();
  });
});

describe("the book's cover", () => {
  it("is saved as images/cover.jpg and named in novel.yaml, changed and removed, one commit each", async () => {
    const yaml = read("novel.yaml");
    const { cover } = await bible.setCover(jpeg());
    expect(cover).toBe("images/cover.jpg");
    expect(lastCommit()).toBe("Add a cover to the book");
    expect(changedInLastCommit()).toEqual(["A\timages/cover.jpg", "M\tnovel.yaml"]);
    expect(read("novel.yaml")).toBe(`${yaml}cover: images/cover.jpg\n`);
    expect((await loadNovel(nodeSource(dir))).config?.cover).toBe("images/cover.jpg");

    await bible.setCover(png());
    expect(lastCommit()).toBe("Change the book's cover");
    expect(images()).toEqual(["images/cover.png"]);

    await bible.removeCover();
    expect(lastCommit()).toBe("Remove the book's cover");
    expect(read("novel.yaml")).toBe(yaml);
    expect(images()).toEqual([]);
    clean();
    expect(await warnings()).toEqual([]);
  });
});

describe("a picture in the prose (#203)", () => {
  const STATION = "manuscript/01-return/01-arrival/01-the-station.md";
  const BRIDGE = "manuscript/01-return/01-arrival/02-the-bridge.md";
  let ws: NovelWorkspace;
  beforeEach(() => {
    ws = new NovelWorkspace(dir, { commit: false, sync: false });
  });
  const save = async (path: string, edit: (text: string) => string) => {
    const result = await ws.write(path, edit(read(path)), hash(path));
    expect(result.ok).toBe(true);
  };
  const add = (path: string, line: string) => save(path, (t) => `${t.trimEnd()}\n\n${line}\n`);
  const without = (path: string, line: string) => save(path, (t) => t.replace(`\n\n${line}\n`, "\n"));

  it("is saved under a name from its description, with a suffix if taken, and committed with the scene that names it", async () => {
    const committed = new NovelWorkspace(dir, { commit: { quietMs: 60_000 }, sync: false });
    try {
      const before = commits();
      const { path } = await committed.addPicture("A map of Varn", jpeg());
      expect(path).toBe("images/a-map-of-varn.jpg");
      expect(readFileSync(join(dir, path))).toEqual(jpeg());
      expect((await committed.addPicture("A map of Varn", jpeg(2))).path).toBe("images/a-map-of-varn-2.jpg");
      expect((await committed.addPicture("", jpeg())).path).toBe("images/picture.jpg");
      expect(commits()).toBe(before);
      const scene = read(STATION);
      expect((await committed.write(STATION, `${scene}\n![A map of Varn](/images/a-map-of-varn.jpg "The valley")\n`, hash(STATION))).ok).toBe(true);
      await committed.committer!.commit();
      expect(commits()).toBe(before + 1);
      expect(changedInLastCommit()).toEqual(expect.arrayContaining(["A\timages/a-map-of-varn.jpg", `M\t${STATION}`]));
    } finally {
      await committed.close();
    }
  });

  it("refuses bytes that aren't JPEG or PNG", async () => {
    await expect(ws.addPicture("x", Buffer.from("GIF89a"))).rejects.toMatchObject({ code: "NOT_IMAGE" });
    expect(existsSync(join(dir, "images"))).toBe(false);
  });

  it("goes with the last scene that names it, and comes back with an Undo that names it again", async () => {
    const { path } = await ws.addPicture("The seal", jpeg(7));
    const line = `![The seal](/${path})`;
    await add(STATION, line);
    await add(BRIDGE, line);
    await without(STATION, line);
    expect(existsSync(join(dir, path)), "still named by the bridge").toBe(true);
    await without(BRIDGE, line);
    expect(existsSync(join(dir, path))).toBe(false);
    // Its name stays taken while it might come back.
    expect((await ws.addPicture("The seal", jpeg(8))).path).toBe("images/the-seal-2.jpg");
    await add(BRIDGE, line);
    expect(readFileSync(join(dir, path))).toEqual(jpeg(7));
    expect(await warnings()).toEqual([]);
  });

  it("stays while an entry or the cover shows it, and a picture outside images/ is never touched", async () => {
    await bible.setPicture(ADA, hash(ADA_FILE), jpeg());
    await add(STATION, "![Ada](/images/ada-varn.jpg)");
    await without(STATION, "![Ada](/images/ada-varn.jpg)");
    expect(existsSync(join(dir, "images/ada-varn.jpg"))).toBe(true);
    writeFileSync(join(dir, "map.png"), png());
    await add(STATION, "![Map](/map.png)");
    await without(STATION, "![Map](/map.png)");
    expect(existsSync(join(dir, "map.png"))).toBe(true);
  });
});

describe("through the server", () => {
  async function serve() {
    const library = await Library.open({ configDir: fresh("config") });
    const novel = await library.add(dir);
    const server = await createServer({ library, token: "t", sync: false, commit: false });
    const cookie = `${sessionCookie(server.port)}=t`;
    const url = (path: string) => `${server.url}/api/novels/${novel.id}${path}`;
    const upload = (path: string, bytes: Uint8Array, type = "image/jpeg") => fetch(url(path), { method: "PUT", headers: { cookie, origin: server.url, "content-type": type }, body: new Uint8Array(bytes) });
    const get = (path: string, headers: Record<string, string> = {}) => fetch(url(path), { headers: { cookie, ...headers } });
    const post = (path: string, body: unknown = {}) => fetch(url(path), { method: "POST", headers: { cookie, origin: server.url, "content-type": "application/json" }, body: JSON.stringify(body) });
    return { server, library, novel, url, upload, get, post };
  }

  it("takes a picture's bytes, serves it from images/ with its type, and shows its version in the model", async () => {
    const { server, upload, get, post } = await serve();
    try {
      const put = await upload(`/bible/entities/${ADA}/picture?base=${hash(ADA_FILE)}&focus=0.5,0.25`, png(3, 4));
      expect(put.status).toBe(200);
      expect(await put.json()).toMatchObject({ image: "images/ada-varn.png", file: ADA_FILE, commit: expect.any(String) });

      const image = await get("/images/ada-varn.png");
      expect(image.status).toBe(200);
      expect(image.headers.get("content-type")).toBe("image/png");
      expect(image.headers.get("x-content-type-options")).toBe("nosniff");
      expect(Buffer.from(await image.arrayBuffer())).toEqual(png(3, 4));
      const etag = image.headers.get("etag")!;
      expect((await get("/images/ada-varn.png", { "if-none-match": etag })).status).toBe(304);

      const model = (await (await get("")).json()) as { images: Record<string, string> };
      expect(Object.keys(model.images)).toEqual(["images/ada-varn.png"]);

      expect((await post(`/bible/entities/${ADA}/picture/delete`, { base: hash(ADA_FILE) })).status).toBe(200);
      expect((await get("/images/ada-varn.png")).status).toBe(404);
    } finally {
      await server.close();
    }
  });

  it("serves nothing outside images/, nothing that isn't an image, and no links", async () => {
    const { server, get } = await serve();
    mkdirSync(join(dir, "images"));
    writeFileSync(join(dir, "images/notes.md"), "# not an image\n");
    writeFileSync(join(dir, "images/logo.svg"), "<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>");
    symlinkSync(join(dir, "novel.yaml"), join(dir, "images/link.png"));
    try {
      for (const path of ["/images/notes.md", "/images/logo.svg", "/images/link.png", "/images/..%2Fnovel.yaml", "/images/.hidden.png"]) {
        expect((await get(path)).status, path).toBe(400);
      }
      expect((await get("/images/missing.jpg")).status).toBe(404);
      // The route is behind the session like everything else.
      expect((await fetch(`${server.url}/api/novels/x/images/a.jpg`)).status).toBe(403);
    } finally {
      await server.close();
    }
  });

  it("refuses an upload over GitHub's limit before reading it, and bytes that aren't JPEG or PNG", async () => {
    const { server, url, upload } = await serve();
    try {
      // Only the header claims 101 MB: the refusal comes before any of it is read.
      const big = await send(server.port, `${new URL(url(`/bible/entities/${ADA}/picture`)).pathname}?base=${hash(ADA_FILE)}`, {
        method: "PUT",
        headers: { cookie: `${sessionCookie(server.port)}=t`, origin: server.url, "content-type": "image/jpeg", "content-length": String(101 * 1024 * 1024) },
      });
      expect(big.status).toBe(413);
      expect(JSON.parse(big.body)).toMatchObject({ code: "TOO_LARGE" });

      const gif = await upload(`/bible/entities/${ADA}/picture?base=${hash(ADA_FILE)}`, Buffer.from("GIF89a"), "image/gif");
      expect(gif.status).toBe(400);
      expect((await upload(`/bible/entities/${ADA}/picture?base=${hash(ADA_FILE)}&focus=2,0`, jpeg())).status).toBe(400);
      expect(images()).toEqual([]);
      clean();
    } finally {
      await server.close();
    }
  });

  it("takes a picture for the prose, and refuses one that isn't JPEG or PNG", async () => {
    const { server, upload, get } = await serve();
    try {
      const put = await upload("/images?name=A%20letter", png(2, 3), "image/png");
      expect(put.status).toBe(200);
      expect(await put.json()).toEqual({ path: "images/a-letter.png" });
      expect((await get("/images/a-letter.png")).status).toBe(200);
      const gif = await upload("/images?name=x", Buffer.from("GIF89a"), "image/gif");
      expect([gif.status, ((await gif.json()) as { code: string }).code]).toEqual([400, "BAD_REQUEST"]);
    } finally {
      await server.close();
    }
  });

  it("sets and removes the cover, and the library shelf shows it", async () => {
    const { server, library, novel, upload, post } = await serve();
    try {
      const put = await upload("/cover", jpeg());
      expect(await put.json()).toMatchObject({ cover: "images/cover.jpg" });
      expect(library.get(novel.id)?.cover).toBe("images/cover.jpg");

      // The shelf: the cover's version in the list, and the cover itself, read without opening the novel.
      const cookie = `${sessionCookie(server.port)}=t`;
      const list = (await (await fetch(`${server.url}/api/library`, { headers: { cookie } })).json()) as { novels: { id: string; cover?: string; coverVersion?: string }[] };
      expect(list.novels.find((n) => n.id === novel.id)).toMatchObject({ cover: "images/cover.jpg", coverVersion: expect.any(String) });
      const shelf = await fetch(`${server.url}/api/library/${novel.id}/cover`, { headers: { cookie } });
      expect(shelf.headers.get("content-type")).toBe("image/jpeg");
      expect(Buffer.from(await shelf.arrayBuffer())).toEqual(jpeg());
      expect((await post("/cover/delete")).status).toBe(200);
      expect(library.get(novel.id)?.cover).toBeUndefined();
      expect((await fetch(`${server.url}/api/library/${novel.id}/cover`, { headers: { cookie } })).status).toBe(404);
      clean();
    } finally {
      await server.close();
    }
  });
});
