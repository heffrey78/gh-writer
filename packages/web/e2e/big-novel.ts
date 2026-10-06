import { cpSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ID_ALPHABET } from "@gh-writer/core";
import { sample } from "./fixtures.ts";

/** IDs that sort and never clash with the sample's: sc_000001, sc_000002… in the format's alphabet. */
function ids(prefix: string): () => string {
  let n = 0;
  return () => {
    let v = ++n;
    let s = "";
    for (let i = 0; i < 6; i++) {
      s = ID_ALPHABET[v % 32]! + s;
      v = Math.floor(v / 32);
    }
    return `${prefix}_${s}`;
  };
}

/** The sample novel's paragraphs (with their mentions), to build prose from. */
function sampleParagraphs(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".md")) {
        const body = readFileSync(path, "utf8").replace(/^---\n[\s\S]*?\n---\n/, "");
        out.push(...body.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean));
      }
    }
  };
  walk(join(sample, "manuscript"));
  return out;
}

const words = (p: string) => p.split(/\s+/).length;

/**
 * A full-length novel in `dir`, for performance work: parts × chapters × scenes of prose cycled from
 * the sample novel (about `total` words), and the sample's bible plus `extraCharacters` more entries.
 * Not a git repository: callers commit it.
 */
export function writeBigNovel(dir: string, { total = 150_000, parts = 3, chapters = 20, scenes = 4, extraCharacters = 40 } = {}): { words: number; scenes: number } {
  const paragraphs = sampleParagraphs();
  const part = ids("pt");
  const chapter = ids("ch");
  const scene = ids("sc");
  const character = ids("char");
  mkdirSync(dir, { recursive: true });
  cpSync(join(sample, "bible"), join(dir, "bible"), { recursive: true });
  cpSync(join(sample, "diagrams"), join(dir, "diagrams"), { recursive: true });
  // The sample's relationships and events point at its own scenes.
  for (const file of ["relationships.yaml", "events.yaml"]) cpSync(join(sample, "../../templates/novel/bible", file), join(dir, "bible", file));
  writeFileSync(join(dir, "novel.yaml"), readFileSync(join(sample, "novel.yaml"), "utf8").replace(/^title: .*$/m, "title: The Long Crossing").replace(/^id: .*$/m, "id: nv_b1gb1g"));
  for (let i = 0; i < extraCharacters; i++) {
    const id = character();
    writeFileSync(join(dir, "bible/characters", `${id}.md`), `---\nid: ${id}\nname: Extra Person ${i + 1}\nsummary: A face in the crowd at Varn.\n---\n\nNotes about Extra Person ${i + 1}.\n`);
  }

  const perScene = Math.ceil(total / (parts * chapters * scenes));
  let next = 0;
  let written = 0;
  const partIds: string[] = [];
  for (let p = 1; p <= parts; p++) {
    const partId = part();
    partIds.push(partId);
    const partDir = join(dir, "manuscript", `${String(p).padStart(2, "0")}-part-${p}`);
    const chapterIds: string[] = [];
    for (let c = 1; c <= chapters; c++) {
      const chapterId = chapter();
      chapterIds.push(chapterId);
      const chapterDir = join(partDir, `${String(c).padStart(2, "0")}-chapter-${c}`);
      mkdirSync(chapterDir, { recursive: true });
      const sceneIds: string[] = [];
      for (let s = 1; s <= scenes; s++) {
        const sceneId = scene();
        sceneIds.push(sceneId);
        const body: string[] = [];
        let n = 0;
        while (n < perScene) {
          const paragraph = paragraphs[next++ % paragraphs.length]!;
          body.push(paragraph);
          n += words(paragraph);
        }
        written += n;
        const title = `Scene ${p}.${c}.${s}`;
        writeFileSync(join(chapterDir, `${String(s).padStart(2, "0")}-scene-${s}.md`), `---\nid: ${sceneId}\ntitle: ${title}\nstatus: drafted\n---\n\n${body.join("\n\n")}\n`);
      }
      writeFileSync(join(chapterDir, "_chapter.yaml"), `id: ${chapterId}\ntitle: Chapter ${(p - 1) * chapters + c}\nscenes: [${sceneIds.join(", ")}]\n`);
    }
    writeFileSync(join(partDir, "_part.yaml"), `id: ${partId}\ntitle: Part ${p}\nchapters: [${chapterIds.join(", ")}]\n`);
  }
  writeFileSync(join(dir, "manuscript/_order.yaml"), `parts: [${partIds.join(", ")}]\n`);
  return { words: written, scenes: parts * chapters * scenes };
}
