import { appendFileSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { strFromU8, unzipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, Library, sessionCookie } from "../src/index.ts";
import { gitIn, novelRepo, scratch } from "./fixtures.ts";

let fresh: (name: string) => string;
let cleanUp: () => void;
beforeAll(() => ({ fresh, cleanUp } = scratch("compile")));
afterAll(() => cleanUp());

/** POST /compile, as raw bytes. */
async function compile(port: number, id: string, body: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}/api/novels/${id}/compile`, {
    method: "POST",
    headers: { cookie: `${sessionCookie(port)}=t`, origin: `http://127.0.0.1:${port}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, headers: res.headers, bytes: new Uint8Array(await res.arrayBuffer()) };
}

describe("POST /api/novels/:id/compile", () => {
  it("answers each format as a file named for the book (and its range), dated from the commit", async () => {
    const dir = novelRepo(fresh("novel"));
    const library = await Library.open({ configDir: fresh("config") });
    const novel = await library.add(dir);
    const server = await createServer({ library, token: "t", sync: false, commit: false });
    try {
      const docx = await compile(server.port, novel.id, { format: "docx" });
      expect(docx.status).toBe(200);
      expect(docx.headers.get("content-type")).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
      expect(docx.headers.get("content-disposition")).toBe('attachment; filename="the-bridge-at-varn.docx"');
      const committed = gitIn(dir, "log", "-1", "--format=%cI").trim();
      expect(strFromU8(unzipSync(docx.bytes)["docProps/core.xml"]!)).toContain(new Date(committed).toISOString().replace(/\.\d{3}Z$/, "Z"));

      const epub = await compile(server.port, novel.id, { format: "epub", from: "ch_arr1va", to: "ch_01dde6" });
      expect(epub.headers.get("content-disposition")).toBe('attachment; filename="the-bridge-at-varn-chapters-1-2.epub"');
      expect(Object.keys(unzipSync(epub.bytes)).filter((f) => f.includes("chapter-"))).toEqual(["OEBPS/chapter-001.xhtml", "OEBPS/chapter-002.xhtml"]);

      const pdf = await compile(server.port, novel.id, { format: "pdf" });
      expect(strFromU8(pdf.bytes.subarray(0, 5))).toBe("%PDF-");
      expect(pdf.headers.get("x-missing-characters")).toBe("");

      expect((await compile(server.port, novel.id, { format: "odt" })).status).toBe(400);
      const bad = await compile(server.port, novel.id, { format: "docx", preset: "nope" });
      expect(bad.status).toBe(400);
      expect(JSON.parse(strFromU8(bad.bytes))).toMatchObject({ code: "BAD_REQUEST", error: expect.stringContaining("nope") });
    } finally {
      await server.close();
    }
  });

  it("puts novel.yaml's cover on the EPUB and the PDF, not the Word file, and says when it can't", async () => {
    const dir = novelRepo(fresh("novel"));
    mkdirSync(join(dir, "images"));
    copyFileSync(new URL("../../export/test/fixtures/cover.jpg", import.meta.url), join(dir, "images/cover.jpg"));
    appendFileSync(join(dir, "novel.yaml"), "cover: images/cover.jpg\n");
    const library = await Library.open({ configDir: fresh("config") });
    const novel = await library.add(dir);
    const server = await createServer({ library, token: "t", sync: false, commit: false });
    try {
      const epub = await compile(server.port, novel.id, { format: "epub" });
      expect(epub.headers.get("x-cover-problem")).toBeNull();
      expect(Object.keys(unzipSync(epub.bytes))).toContain("OEBPS/images/cover.jpg");
      expect(Object.keys(unzipSync((await compile(server.port, novel.id, { format: "docx" })).bytes)).some((f) => f.includes("cover"))).toBe(false);

      const yaml = join(dir, "novel.yaml");
      writeFileSync(yaml, readFileSync(yaml, "utf8").replace("cover: images/cover.jpg", "cover: images/gone.jpg"));
      const pdf = await compile(server.port, novel.id, { format: "pdf" });
      expect(pdf.status).toBe(200);
      expect(decodeURIComponent(pdf.headers.get("x-cover-problem")!)).toBe("The cover, images/gone.jpg, isn't there, so the book goes out without it.");
    } finally {
      await server.close();
    }
  });
});
