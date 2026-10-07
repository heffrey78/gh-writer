import { expect, test } from "@playwright/test";
import { open, savedContains, textbox } from "./helpers.ts";

const STATION = "scene=manuscript/01-return/01-arrival/01-the-station.md";

test("with link suggestions on, unmarked names are underlined and Alt+Enter links one", async ({ page }) => {
  await open(page, STATION);
  const toggle = page.getByRole("button", { name: "Suggest links for names written without a mention" });
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  const bridge = textbox(page).locator(".ghw-unlinked", { hasText: "the bridge" });
  await expect(bridge).toBeVisible();
  await bridge.click();
  // ProseMirror reads the click's selection on selectionchange, after the click.
  await page.waitForFunction(() => {
    const e = window.editor!;
    const plugin = e.state.plugins.find((p) => (p as unknown as { key: string }).key.startsWith("linkSuggest"))!;
    const set = plugin.getState(e.state) as { find: (from: number, to: number) => unknown[] };
    return set.find(e.state.selection.head, e.state.selection.head).length > 0;
  });
  await page.keyboard.press("Alt+Enter");
  await savedContains(page, "could see [the bridge](#loc_br1dg3), the long");
  await toggle.click();
  await expect(textbox(page).locator(".ghw-unlinked")).toHaveCount(0);
});
