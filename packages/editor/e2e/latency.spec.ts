import { expect, test } from "@playwright/test";
import { open } from "./helpers.ts";

/**
 * Keystroke-to-render latency on a 10,000-word chapter (#4: under 50 ms). Each keydown is timed
 * from the event's timestamp to just after the next animation frame, when the browser has
 * applied the edit and is about to paint.
 */
test("keystroke latency on a 10,000-word chapter is under 50 ms at the 95th percentile", async ({ page }) => {
  await open(page, "chapter=generated/10k-words");
  const words = await page.evaluate(() => {
    let n = 0;
    window.editor!.state.doc.descendants((node) => {
      if (node.isTextblock) n += node.textContent.split(/\s+/).filter(Boolean).length;
      return !node.isTextblock;
    });
    return n;
  });
  expect(words).toBeGreaterThanOrEqual(10_000);

  await page.evaluate(() => {
    const editor = window.editor!;
    const middle = editor.state.doc.content.size / 2;
    let pos = -1;
    editor.state.doc.descendants((node, at) => {
      if (pos < 0 && node.isText && at > middle) pos = at + 1;
      return pos < 0;
    });
    editor.chain().focus().setTextSelection(pos).run();
    const w = window as unknown as { latencies: number[] };
    w.latencies = [];
    document.addEventListener(
      "keydown",
      (e) => {
        const start = e.timeStamp;
        requestAnimationFrame(() => setTimeout(() => w.latencies.push(performance.now() - start)));
      },
      true,
    );
  });

  const sentence = "The wind came off the river hard enough to lean on. ";
  for (let i = 0; i < 4; i++) {
    await page.keyboard.type(sentence, { delay: 20 });
    await page.keyboard.press("Enter");
  }
  for (let i = 0; i < 20; i++) await page.keyboard.press("Backspace", { delay: 20 });
  await page.waitForTimeout(500);

  const latencies = await page.evaluate(() => (window as unknown as { latencies: number[] }).latencies.sort((a, b) => a - b));
  const at = (q: number) => latencies[Math.min(latencies.length - 1, Math.floor(q * latencies.length))]!;
  const result = `${latencies.length} keystrokes on ${words} words: p50 ${at(0.5).toFixed(1)} ms, p95 ${at(0.95).toFixed(1)} ms, max ${latencies.at(-1)!.toFixed(1)} ms`;
  console.log(result);
  test.info().annotations.push({ type: "latency", description: result });
  expect(latencies.length).toBeGreaterThan(200);
  expect(at(0.95)).toBeLessThan(50);
});
