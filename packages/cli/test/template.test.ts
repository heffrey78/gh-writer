import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { parse } from "yaml";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const template = join(repo, "templates/novel");
const tmp = mkdtempSync(join(tmpdir(), "gh-writer-template-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const node = (args: string[], cwd = repo) => spawnSync("node", args, { cwd, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });

describe("novel template", () => {
  it("validates cleanly with its own vendored validator", () => {
    const r = node([join(template, ".github/gh-writer/validate.mjs"), template]);
    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).toContain("0 errors, 0 warnings");
  });

  it("vendors a validator that matches the current source", () => {
    const fresh = join(tmp, "validate.mjs");
    expect(node([join(repo, "scripts/build-validator.ts"), fresh]).status).toBe(0);
    const vendored = readFileSync(join(template, ".github/gh-writer/validate.mjs"), "utf8");
    expect(vendored === readFileSync(fresh, "utf8"), "run `npm run build:template`").toBe(true);
  }, 30_000);

  it("init.mjs gives a copy fresh IDs and a title, stays valid, and is idempotent", () => {
    const copy = join(tmp, "my-great-novel");
    cpSync(template, copy, { recursive: true });
    const init = join(copy, ".github/gh-writer/init.mjs");

    expect(node([init, "my-great-novel"], copy).status).toBe(0);
    const novel = parse(readFileSync(join(copy, "novel.yaml"), "utf8")) as { id: string; title: string };
    expect(novel.title).toBe("My Great Novel");
    expect(novel.id).toMatch(/^nv_[0-9a-hjkmnp-tv-z]{6}$/);
    expect(novel.id).not.toBe("nv_temp1a");
    const scene = readFileSync(join(copy, "manuscript/01-chapter-one/01-opening.md"), "utf8");
    expect(scene).not.toContain("temp1a");

    expect(node([join(copy, ".github/gh-writer/validate.mjs"), copy]).status).toBe(0);

    const again = node([init, "Something Else"], copy);
    expect(again.stdout).toContain("already set up");
    expect((parse(readFileSync(join(copy, "novel.yaml"), "utf8")) as { id: string }).id).toBe(novel.id);
  });
});
