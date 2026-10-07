import { expect, test } from "./fixtures.ts";

/**
 * #68 / D4: React Flow handles a 60-node, 200-edge relationship graph smoothly. Dragging a node keeps
 * frames under 50 ms at the 95th percentile, and changing every edge at once (as moving the story
 * slider can) paints in under 100 ms. Runs alone, after the other tests.
 */
test("a 60-node, 200-edge graph drags smoothly and updates every edge quickly", async ({ page, app }) => {
  await page.goto(app.launchUrl);
  await page.goto(new URL("/bench/graph?nodes=60&edges=200", app.launchUrl).href);
  await expect(page.locator(".react-flow__node")).toHaveCount(60);
  await expect(page.locator(".react-flow__edge")).toHaveCount(200);
  await page.evaluate(() => new Promise((done) => setTimeout(done, 500))); // fitView and fonts settle

  // Frame times while dragging a node across the canvas.
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
  const dragged = page.locator(".react-flow__node").nth(27);
  const before = await dragged.getAttribute("style");
  const box = (await dragged.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 90; i++) {
    await page.mouse.move(box.x + box.width / 2 + i * 4, box.y + box.height / 2 + Math.sin(i / 8) * 60);
    await page.evaluate(() => new Promise(requestAnimationFrame));
  }
  await page.mouse.up();
  expect(await dragged.getAttribute("style")).not.toBe(before); // it really moved
  const frames = await page.evaluate(() => {
    const w = window as unknown as { frames: number[]; recording: boolean };
    w.recording = false;
    return w.frames.slice(1);
  });
  const sorted = [...frames].sort((a, b) => a - b);
  const p95 = sorted[Math.floor(sorted.length * 0.95)]!;
  const worst = sorted[sorted.length - 1]!;

  // Every edge changes type, colour and line at once.
  const updates: number[] = [];
  for (let i = 0; i < 6; i++) {
    await page.getByRole("button", { name: "Change every edge" }).click();
    const out = page.getByTestId("update");
    await expect(out).not.toHaveAttribute("data-update-ms", "");
    updates.push(Number(await out.getAttribute("data-update-ms")));
  }
  updates.sort((a, b) => a - b);
  const median = updates[Math.floor(updates.length / 2)]!;

  const result = `drag: ${frames.length} frames, p95 ${p95.toFixed(1)} ms, worst ${worst.toFixed(1)} ms; update all 200 edges: median ${median} ms, worst ${updates.at(-1)} ms`;
  console.log(result);
  test.info().annotations.push({ type: "performance", description: result });
  expect(p95).toBeLessThan(50);
  expect(median).toBeLessThan(100);
});
