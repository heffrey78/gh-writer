import { readFileSync } from "node:fs";
import { join } from "node:path";
import { axe, expect, test } from "./fixtures.ts";

test("a new, empty chapter opens with a way to add its first scene, from every route to it", async ({ page, app }) => {
  const dir = app.novelRepo("varn");
  await app.restart(dir);
  await page.goto(app.launchUrl);
  await expect(page.getByRole("textbox", { name: "Chapter text" })).toBeFocused();
  const tree = page.getByRole("tree", { name: "Manuscript" });

  await tree.getByRole("treeitem").first().focus();
  await page.getByRole("toolbar", { name: "Manuscript actions" }).getByRole("button", { name: "Chapter" }).click();
  await page.getByRole("dialog").getByRole("textbox", { name: "Title (optional)" }).fill("The Crossing");
  await page.keyboard.press("Enter");

  // Not a blank page: the app, the chapter's title, and what to do next.
  await expect(page.getByRole("heading", { level: 1, name: "The Crossing" })).toBeVisible();
  await expect(tree).toBeVisible();
  await expect(page.getByText("This chapter has no scenes yet.")).toBeVisible();
  const add = page.getByRole("button", { name: "Add a scene" });
  await expect(add).toBeFocused();
  await axe(page);

  // Away and back by each route: the tree, the outline, the palette.
  await tree.getByRole("treeitem", { name: /^Arrival,/ }).click();
  await tree.getByRole("treeitem", { name: /^The Crossing,/ }).click();
  await expect(page.getByText("This chapter has no scenes yet.")).toBeVisible();
  await page.getByRole("navigation", { name: "Views" }).getByRole("link", { name: "Outline" }).click();
  await page.getByRole("table").getByRole("link", { name: "The Crossing" }).click();
  await expect(page.getByText("This chapter has no scenes yet.")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.type("chapter: the crossing");
  await page.keyboard.press("Enter");
  await expect(page.getByText("This chapter has no scenes yet.")).toBeVisible();

  // The first scene, and the chapter is written into like any other.
  await page.getByRole("button", { name: "Add a scene" }).click();
  await page.getByRole("dialog").getByRole("textbox", { name: "Title" }).fill("On the Ferry");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 1, name: "On the Ferry" })).toBeVisible();
  await tree.getByRole("treeitem", { name: /^The Crossing,/ }).click();
  await expect(page.getByRole("textbox", { name: "Chapter text" })).toBeVisible();
  const chapter = readFileSync(join(dir, "manuscript/01-return/02-the-crossing/_chapter.yaml"), "utf8");
  expect(chapter).toMatch(/scenes:(?: \[sc_[0-9a-z]{6}\]|\n {2}- sc_[0-9a-z]{6})\n/);
});
