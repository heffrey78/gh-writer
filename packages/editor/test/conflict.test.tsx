// @vitest-environment jsdom
import "./dom.ts";
import { merge2, merge3 } from "@gh-writer/core";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ConflictResolver, type ConflictFileView } from "../src/react.tsx";

const scene = (status: string, ...paragraphs: string[]) => `---\nid: sc_5tat1n\ntitle: The Station\nstatus: ${status}\n---\n\n${paragraphs.join("\n\n")}\n`;
const BASE = scene("drafted", "The train was late.", "Ada stepped down.", "She counted the flags.");
/** One prose conflict (second paragraph) and one field conflict (status). */
const station: ConflictFileView = {
  path: "manuscript/01-return/01-arrival/01-the-station.md",
  title: "The Station",
  chunks: merge3(
    BASE,
    scene("revised", "The train was late.", "Ada *jumped* down.", "She counted the flags."),
    scene("final", "The train was late.", "Ada climbed down.", "She counted the flags twice."),
  ).chunks,
};

afterEach(cleanup);

function mount(files: ConflictFileView[] = [station], props: Partial<Parameters<typeof ConflictResolver>[0]> = {}) {
  const onResolve = vi.fn();
  const view = render(<ConflictResolver files={files} onResolve={onResolve} {...props} />);
  const region = view.getByRole("region", { name: "Resolve conflicts" });
  const key = (key: string, init: KeyboardEventInit = {}) => fireEvent.keyDown(document.activeElement ?? region, { key, ...init });
  return { ...view, region, key, onResolve, status: () => view.getByRole("status").textContent };
}

describe("ConflictResolver", () => {
  test("shows one conflict at a time, both sides as prose, with its context", () => {
    const { region, status, getByRole } = mount();
    expect(document.activeElement).toBe(region);
    expect(status()).toBe("Conflict 1 of 2 · 0 resolved");
    // Front matter conflicts come first, field by field.
    expect(region.textContent).toContain("The Station: the “status” field");
    expect(within(getByRole("group", { name: "Mine" })).getByText("status: revised")).toBeTruthy();
    expect(within(getByRole("group", { name: "Theirs" })).getByText("status: final")).toBeTruthy();
    expect(region.querySelector("[aria-keyshortcuts='3']")).toBeNull();
  });

  test("resolves by keyboard and reports each file's text", () => {
    const { key, status, getByRole, onResolve } = mount();
    key("2"); // status: theirs
    expect(status()).toBe("Conflict 2 of 2 · 1 resolved");
    const mine = getByRole("group", { name: "Mine" });
    expect(mine.querySelector("em")?.textContent).toBe("jumped");
    expect(getByRole("group", { name: "Before" }).textContent).toBe("The train was late.");
    key("3"); // both paragraphs
    expect(status()).toBe("Conflict 2 of 2 · 2 resolved");
    key("Enter", { ctrlKey: true });
    expect(onResolve).toHaveBeenCalledWith({
      [station.path]: { content: scene("final", "The train was late.", "Ada *jumped* down.", "Ada climbed down.", "She counted the flags twice.") },
    });
  });

  test("edits a conflict in place, keeping the paragraph's spacing", () => {
    const { key, getByLabelText, onResolve } = mount();
    key("1");
    key("e");
    const box = getByLabelText("Your version") as HTMLTextAreaElement;
    expect(document.activeElement).toBe(box);
    expect(box.value).toBe("Ada *jumped* down.");
    fireEvent.change(box, { target: { value: "Ada stepped carefully down." } });
    key("Enter", { metaKey: true });
    key("Enter", { ctrlKey: true });
    expect(onResolve.mock.calls[0]![0][station.path].content).toBe(scene("revised", "The train was late.", "Ada stepped carefully down.", "She counted the flags twice."));
  });

  test("Escape leaves an edit, then the resolver; finishing waits for every conflict", () => {
    const onCancel = vi.fn();
    const { key, queryByLabelText, getByRole, onResolve } = mount([station], { onCancel });
    key("e");
    key("Escape");
    expect(queryByLabelText("Your version")).toBeNull();
    key("1");
    key("Enter", { ctrlKey: true });
    expect(onResolve).not.toHaveBeenCalled();
    expect((getByRole("button", { name: "Finish" }) as HTMLButtonElement).disabled).toBe(true);
    key("Escape");
    expect(onCancel).toHaveBeenCalledOnce();
  });

  test("moves between conflicts with the arrow keys, and changes a choice", () => {
    const { key, status, getByRole } = mount();
    key("ArrowRight");
    expect(status()).toBe("Conflict 2 of 2 · 0 resolved");
    key("1");
    key("ArrowLeft");
    key("ArrowLeft");
    expect(status()).toBe("Conflict 1 of 2 · 1 resolved");
    key("1");
    key("ArrowLeft");
    key("2");
    expect(getByRole("button", { name: /Keep theirs/ }).getAttribute("aria-pressed")).toBe("true");
  });

  test("offers a whole-file choice for a file one side deleted", () => {
    const deleted: ConflictFileView = { path: "bible/characters/ben.md", chunks: [{ type: "conflict", base: "x", ours: "x\ny\n", theirs: "" }], inTheirs: false };
    const { key, region, onResolve } = mount([deleted]);
    expect(region.textContent).toContain("The file was deleted.");
    expect(region.querySelector("[aria-keyshortcuts='3']")).toBeNull();
    key("2");
    key("Enter", { ctrlKey: true });
    expect(onResolve).toHaveBeenCalledWith({ "bible/characters/ben.md": { keep: "theirs" } });
  });

  test("works across files, and with merge2 for a save refused by newer text on disk", () => {
    const disk = merge2("One.\n\nTwo, mine.\n", "One.\n\nTwo, on disk.\n");
    const { key, status, onResolve } = mount([station, { path: "notes.md", chunks: disk.chunks }]);
    expect(status()).toBe("Conflict 1 of 3 · 0 resolved");
    key("1");
    key("1");
    key("2");
    key("Enter", { ctrlKey: true });
    expect(onResolve.mock.calls[0]![0]["notes.md"]).toEqual({ content: "One.\n\nTwo, on disk.\n" });
  });
});
