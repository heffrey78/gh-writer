import type { SceneSource } from "../src/index.ts";

/**
 * A chapter of at least `words` words for performance work, built by cycling through the
 * paragraphs of the given scene bodies: `scenes` scenes of roughly equal length.
 */
export function generatedChapter(bodies: string[], words = 10_000, scenes = 12): SceneSource[] {
  const paragraphs = bodies.flatMap((b) => b.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean));
  const count = (p: string) => p.split(/\s+/).length;
  const perScene = Math.ceil(words / scenes);
  const out: SceneSource[] = [];
  let next = 0;
  for (let i = 1; i <= scenes; i++) {
    const scene: string[] = [];
    let n = 0;
    while (n < perScene) {
      const p = paragraphs[next++ % paragraphs.length]!;
      scene.push(p);
      n += count(p);
    }
    const id = `generated-${String(i).padStart(2, "0")}`;
    out.push({ id, title: `Generated scene ${i}`, markdown: scene.join("\n\n") + "\n" });
  }
  return out;
}
