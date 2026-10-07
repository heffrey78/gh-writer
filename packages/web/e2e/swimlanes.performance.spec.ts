import { join } from "node:path";
import { writeBigNovel } from "./big-novel.ts";
import { expect, test } from "./fixtures.ts";

/**
 * #78 / #12: a 120-scene book with 12 plotlines (10 generated, the sample's 2) renders its swimlanes
 * in under 500 ms; re-shading every cell for a new gap threshold takes under 100 ms; scrolling and
 * hovering keep frames under 50 ms at the 95th percentile. A cell edit end to end (save, model
 * reload, render) is measured and reported, within a second. Runs alone, after the other tests.
 */
test("swimlanes for 120 scenes and 12 plotlines render and update without lag", async ({ page, app }) => {
  const dir = join(app.home, "novels", "threads");
  const { scenes } = writeBigNovel(dir, { total: 60_000, parts: 3, chapters: 10, scenes: 4, extraCharacters: 0, plotlines: 10 });
  expect(scenes).toBe(120);
  app.git(dir, "init", "-q");
  app.git(dir, "add", "-A");
  app.git(dir, "commit", "-qm", "Start");
  await app.restart(dir);
  await page.goto(app.launchUrl);
  await expect(page.getByRole("textbox", { name: "Chapter text" })).toBeVisible({ timeout: 15_000 });
  const views = page.getByRole("navigation", { name: "Views" });
  // Warm: the route's code, then back to the writing view.
  await views.getByRole("link", { name: "Plotlines" }).click();
  await expect(page.locator("tbody tr")).toHaveCount(12);
  await page.goBack();
  await expect(page.getByRole("textbox", { name: "Chapter text" })).toBeVisible();

  // First render: from the click to every cell in the DOM, timed in the page, frame by frame.
  const render = await page.evaluate(async () => {
    const link = [...document.querySelectorAll<HTMLAnchorElement>('nav[aria-label="Views"] a')].find((a) => a.textContent === "Plotlines")!;
    const start = performance.now();
    link.click();
    await new Promise<void>((done) => {
      const check = () => (document.querySelectorAll('tbody [role="gridcell"]').length === 12 * 120 ? done() : requestAnimationFrame(check));
      requestAnimationFrame(check);
    });
    return performance.now() - start;
  });

  // A new threshold re-shades every cell (pure UI: gaps worked out again across the book).
  const reshade = await page.evaluate(async () => {
    const input = document.querySelector<HTMLInputElement>('input[aria-label="How many"]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    const before = document.querySelectorAll("tbody .bg-warn-soft").length;
    const start = performance.now();
    setter.call(input, "0");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise<void>((done) => {
      const check = () => (document.querySelectorAll("tbody .bg-warn-soft").length !== before ? done() : requestAnimationFrame(check));
      requestAnimationFrame(check);
    });
    return performance.now() - start;
  });
  expect(await page.locator("tbody .bg-warn-soft").count()).toBeGreaterThan(0);

  // Frames while scrolling across the book and hovering cells.
  await page.evaluate(() => {
    const w = window as unknown as { frames: number[]; recording: boolean };
    w.frames = [];
    w.recording = true;
    let last = performance.now();
    const tick = (t: number) => {
      w.frames.push(t - last);
      last = t;
      if (w.recording) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const box = (await page.getByRole("grid").boundingBox())!;
  for (let i = 0; i < 40; i++) {
    await page.mouse.move(box.x + 300 + (i % 10) * 40, box.y + 200 + (i % 4) * 40);
    await page.mouse.wheel(i < 20 ? 120 : -120, 0);
    await page.evaluate(() => new Promise(requestAnimationFrame));
  }
  const frames = await page.evaluate(() => {
    const w = window as unknown as { frames: number[]; recording: boolean };
    w.recording = false;
    return w.frames.slice(1);
  });
  const sorted = [...frames].sort((a, b) => a - b);
  const p95 = sorted[Math.floor(sorted.length * 0.95)]!;

  // An edit, end to end: click an empty cell until it shows its marker.
  const cell = page.locator('tbody [role="gridcell"][aria-label^="Scene 1.1.1: doesn\'t advance"]').first();
  const label = (await cell.getAttribute("aria-label"))!;
  const lane = label.replace(/^Scene 1\.1\.1: doesn't advance /, "").replace(/, in a quiet.*$/, "");
  const start = Date.now();
  await cell.click();
  await expect(page.locator(`tbody [role="gridcell"][aria-label="Scene 1.1.1: major beat in ${lane}"]`)).toHaveCount(1, { timeout: 5000 });
  const edit = Date.now() - start;

  const result = `first render ${render.toFixed(0)} ms; re-shade ${reshade.toFixed(0)} ms; scroll/hover p95 ${p95.toFixed(1)} ms over ${frames.length} frames; cell edit end to end ${edit} ms`;
  console.log(result);
  test.info().annotations.push({ type: "performance", description: result });
  expect(render).toBeLessThan(500);
  expect(reshade).toBeLessThan(100);
  expect(p95).toBeLessThan(50);
  expect(edit).toBeLessThan(1000);
});
