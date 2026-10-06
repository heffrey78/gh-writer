import { join } from "node:path";
import { expect, test, type App } from "./fixtures.ts";
import { writeBigNovel } from "./big-novel.ts";

/**
 * #54 / #7: a 150,000-word novel opens to an editable state in under 2 seconds, and typing in it
 * stays within the editor's budget (50 ms at the 95th percentile). Runs alone, after the other tests.
 */

function bigNovel(app: App): string {
  const dir = join(app.home, "novels", "long-crossing");
  const { words } = writeBigNovel(dir);
  expect(words).toBeGreaterThanOrEqual(150_000);
  app.git(dir, "init", "-q");
  app.git(dir, "add", "-A");
  app.git(dir, "commit", "-qm", "Start");
  return dir;
}

test("a 150,000-word novel opens to an editable state in under 2 seconds", async ({ page, app }) => {
  await app.restart(bigNovel(app));
  // Warm the browser's cache of the app's own files, as a second launch would have it; the novel itself is cold.
  await page.goto(`${app.launchUrl.replace(/\/novels\/[^?]+/, "/no-such-page")}`);
  await expect(page.getByRole("heading", { name: "Nothing here" })).toBeVisible();

  const novelUrl = app.launchUrl.replace(/\?token=.*/, "");
  const start = Date.now();
  await page.goto(novelUrl, { waitUntil: "commit" });
  // Checked every frame: expect's polling would round the time up.
  await page.waitForFunction(() => {
    const el = document.activeElement;
    return el?.getAttribute("aria-label") === "Chapter text" && el.getAttribute("contenteditable") === "true";
  }, undefined, { polling: "raf", timeout: 10_000 });
  const elapsed = Date.now() - start;

  const api = await page.evaluate(() =>
    performance
      .getEntriesByType("resource")
      .filter((e) => /\/api\/novels\/[^/]+$/.test(e.name))
      .map((e) => ({ ms: Math.round(e.duration), kb: Math.round((e as PerformanceResourceTiming).decodedBodySize / 1024) })),
  );
  const result = `cold open ${elapsed} ms; model request ${JSON.stringify(api)}`;
  console.log(result);
  test.info().annotations.push({ type: "performance", description: result });
  expect(elapsed).toBeLessThan(2000);
});

test("a 150,000-word novel opens on a first launch, nothing cached, in under 2 seconds", async ({ page, app }) => {
  await app.restart(bigNovel(app));
  // Trade the token for the session on a page that loads nothing of the novel, then clear the cache.
  await page.goto(app.launchUrl.replace(/\/novels\/[^?]+/, "/api/health"));
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.clearBrowserCache");
  const start = Date.now();
  await page.goto(app.launchUrl.replace(/\?token=.*/, ""), { waitUntil: "commit" });
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Chapter text", undefined, { polling: "raf", timeout: 10_000 });
  const elapsed = Date.now() - start;
  const result = `first launch ${elapsed} ms`;
  console.log(result);
  test.info().annotations.push({ type: "performance", description: result });
  expect(elapsed).toBeLessThan(2000);
});

test("typing in a chapter of the 150,000-word novel stays under 50 ms at the 95th percentile", async ({ page, app }) => {
  await app.restart(bigNovel(app));
  await page.goto(app.launchUrl);
  const text = page.getByRole("textbox", { name: "Chapter text" });
  await expect(text).toBeFocused({ timeout: 10_000 });
  await page.evaluate(() => {
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
  await page.keyboard.press("Control+End");
  const sentence = "The wind came off the river hard enough to lean on. ";
  for (let i = 0; i < 4; i++) {
    await page.keyboard.type(sentence, { delay: 20 });
    await page.keyboard.press("Enter");
  }
  await page.waitForTimeout(500);
  const latencies = await page.evaluate(() => (window as unknown as { latencies: number[] }).latencies.sort((a, b) => a - b));
  const at = (q: number) => latencies[Math.min(latencies.length - 1, Math.floor(q * latencies.length))]!;
  const result = `${latencies.length} keystrokes: p50 ${at(0.5).toFixed(1)} ms, p95 ${at(0.95).toFixed(1)} ms, max ${latencies.at(-1)!.toFixed(1)} ms`;
  console.log(result);
  test.info().annotations.push({ type: "latency", description: result });
  expect(latencies.length).toBeGreaterThan(200);
  expect(at(0.95)).toBeLessThan(50);
});
