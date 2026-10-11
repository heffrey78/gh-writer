import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { addDays, countWords, markdownWords, median, unbalanced, projection, sceneWords, streak, wordChange, writingDays, type WritingDay } from "../src/index.ts";

describe("wordChange", () => {
  it("counts a reworded sentence as words removed and added, and a mention as its name", () => {
    expect(wordChange("She counted them twice.", "She counted them three times.")).toEqual({ added: 2, removed: 1 });
    expect(wordChange(undefined, "[Ada Varn](#char_7f3k2q) stood.")).toEqual({ added: 3, removed: 0 });
    expect(wordChange("A well-known bridge.", undefined)).toEqual({ added: 0, removed: 3 });
    expect(wordChange("Same words.", "Same   words!")).toEqual({ added: 0, removed: 0 });
  });

  it("reads a scene paragraph by paragraph exactly as it reads the whole", () => {
    const pieces = fc.constantFrom("the", "well-", "-known", "bridge", "\n\n", "\n", " \n \n", "[Ada](#char_x)", "<!-- note\n\nstill -->", "*rivet*", "—", " ");
    fc.assert(
      fc.property(
        fc.array(pieces, { maxLength: 40 }).map((p) => p.join("")),
        (text) => {
          expect(sceneWords(text)).toEqual(markdownWords(text));
        },
      ),
    );
  });

  it("nets out to the change in the editor's word count, always", () => {
    const words = fc.constantFrom("the", "bridge", "Ada", "well-known", "fell", ",", ".", " ", "\n\n", "—", "[Ben](#char_b3n0vs)", "*rivet*");
    const text = fc.array(words, { maxLength: 40 }).map((w) => w.join(" "));
    fc.assert(
      fc.property(text, text, (a, b) => {
        const { added, removed } = wordChange(a, b);
        expect(added - removed).toBe(countWords(b) - countWords(a));
      }),
    );
  });
});

describe("writingDays", () => {
  it("gathers commits by the writer's own date, and runs the length to the book's count now", () => {
    const days = writingDays(
      [
        { commit: "a", date: "2026-10-01T23:30:00-04:00", added: 100, removed: 0 },
        { commit: "b", date: "2026-10-02T00:10:00-04:00", added: 50, removed: 20 },
        { commit: "c", date: "2026-10-02T09:00:00-04:00", added: 10, removed: 0 },
      ],
      1000,
    );
    expect(days).toEqual([
      { day: "2026-10-01", added: 100, removed: 0, net: 100, words: 960 },
      { day: "2026-10-02", added: 60, removed: 20, net: 40, words: 1000 },
    ]);
  });
});

const day = (d: string, added: number, removed = 0): WritingDay => ({ day: d, added, removed, net: added - removed, words: 0 });

describe("streak", () => {
  const days = [day("2026-10-01", 600), day("2026-10-02", 500, 400), day("2026-10-03", 200), day("2026-10-04", 700), day("2026-10-05", 800)];
  it("counts days whose words added reach the goal, however much was cut", () => {
    expect(streak(days, 500, "2026-10-05")).toEqual({ current: 2, best: 2, today: 800, todayMet: true });
  });
  it("keeps today's streak alive until today is over, and counts unsaved words", () => {
    expect(streak(days, 500, "2026-10-06")).toMatchObject({ current: 2, todayMet: false, today: 0 });
    expect(streak(days, 500, "2026-10-06", 520)).toMatchObject({ current: 3, todayMet: true, today: 520 });
    expect(streak(days, 500, "2026-10-07")).toMatchObject({ current: 0 });
  });
});

describe("projection", () => {
  const today = "2026-10-28";
  const steady = Array.from({ length: 28 }, (_, i) => day(addDays(today, -i), 500));
  it("projects the finish at the last four weeks' pace, against the deadline", () => {
    expect(projection(steady, 60_000, today, { words: 70_000, date: "2026-12-31" })).toEqual({
      pace: 500,
      remaining: 10_000,
      finish: "2026-11-17",
      spare: 44,
      needed: 154,
    });
  });
  it("says nothing of a finish without a target, or without progress", () => {
    expect(projection(steady, 60_000, today)).toEqual({ pace: 500, remaining: 0 });
    expect(projection([], 60_000, today, { words: 70_000 })).toEqual({ pace: 0, remaining: 10_000 });
  });
  it("is done once the target is reached", () => {
    expect(projection(steady, 72_000, today, { words: 70_000, date: "2026-11-01" })).toMatchObject({ remaining: 0, finish: today, spare: 4 });
  });
});

describe("unbalanced", () => {
  it("names parts under half or over one and a half times the median", () => {
    const parts = [100, 220, 230, 240, 400].map((words, i) => ({ id: `c${i}`, words }));
    expect(median(parts.map((p) => p.words))).toBe(230);
    const u = unbalanced(parts);
    expect([u.median, u.long.map((p) => p.id), u.short.map((p) => p.id)]).toEqual([230, ["c4"], ["c0"]]);
  });
  it("says nothing with too few to tell what's usual", () => {
    expect(unbalanced([{ words: 10 }, { words: 1000 }])).toEqual({ median: 505, long: [], short: [] });
  });
});
