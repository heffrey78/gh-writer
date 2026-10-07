import type { GapThreshold } from "../swimlanes/swimlane-model.ts";

const number = new Intl.NumberFormat();

/** A threshold in words: "3 scenes", "5,000 words". */
export const amount = (t: GapThreshold) => ("scenes" in t ? `${t.scenes} scene${t.scenes === 1 ? "" : "s"}` : `${number.format(t.words)} words`);

/** The threshold in the address: "3" scenes, or "5000w" words. */
export const readGap = (v: string | null): GapThreshold | undefined => {
  const m = v ? /^(\d+)(w?)$/.exec(v) : null;
  return m ? (m[2] ? { words: Number(m[1]) } : { scenes: Number(m[1]) }) : undefined;
};
export const writeGap = (t: GapThreshold) => ("scenes" in t ? String(t.scenes) : `${t.words}w`);
