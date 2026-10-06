import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { placed, visibleStep } from "../src/novel/corkboard-order.ts";

describe("reordering a filtered corkboard", () => {
  it("swaps a card with its visible neighbour, and leaves every hidden card where it was", () => {
    fc.assert(
      fc.property(fc.uniqueArray(fc.integer({ min: 0, max: 40 }), { minLength: 2, maxLength: 20 }), fc.array(fc.boolean(), { minLength: 20, maxLength: 20 }), fc.nat(), fc.boolean(), (ids, show, pick, left) => {
        const book = ids.map(String);
        const visible = book.filter((_, i) => show[i]);
        if (visible.length < 2) return;
        const id = visible[pick % visible.length]!;
        const step = visibleStep(visible, id, left ? -1 : 1);
        const i = visible.indexOf(id);
        if (!step) return void expect(left ? i === 0 : i === visible.length - 1).toBe(true);
        const after = placed(book, id, step.target, step.after);
        // On the board: the card and its neighbour swapped.
        const expected = [...visible];
        const j = i + (left ? -1 : 1);
        [expected[i], expected[j]] = [expected[j]!, expected[i]!];
        expect(after.filter((x) => visible.includes(x))).toEqual(expected);
        // In the book: every other scene keeps its order, and the card sits right beside its neighbour.
        expect(after.filter((x) => x !== id)).toEqual(book.filter((x) => x !== id));
        expect(Math.abs(after.indexOf(id) - after.indexOf(step.target))).toBe(1);
      }),
    );
  });

  it("places a dropped card immediately before the card it's dropped on", () => {
    expect(placed(["a", "b", "c", "d", "e"], "e", "b", false)).toEqual(["a", "e", "b", "c", "d"]);
    expect(placed(["a", "b", "c", "d", "e"], "a", "d", true)).toEqual(["b", "c", "d", "a", "e"]);
  });
});
