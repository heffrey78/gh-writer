// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { allCommands, keyCaps, useCommandRegistry, useCommands, type Command } from "../src/commands.ts";

const titles = () => allCommands(useCommandRegistry.getState().owners).map((c) => c.title);

function Owner({ commands }: { commands: Command[] }) {
  useCommands(() => commands, [commands]);
  return null;
}

const command = (id: string, title = id): Command => ({ id, title, group: "Test", run: vi.fn() });

afterEach(cleanup);

describe("command registry", () => {
  it("offers a view's commands while it's mounted, and updates them with it", () => {
    const first = [command("a", "Alpha")];
    const view = render(<Owner commands={first} />);
    expect(titles()).toEqual(["Alpha"]);
    view.rerender(<Owner commands={[command("a", "Alpha"), command("b", "Beta")]} />);
    expect(titles()).toEqual(["Alpha", "Beta"]);
    view.unmount();
    expect(titles()).toEqual([]);
  });

  it("lets a later view replace a command with the same id", () => {
    render(
      <>
        <Owner commands={[command("x", "From the shell")]} />
        <Owner commands={[command("x", "From the editor")]} />
      </>,
    );
    expect(titles()).toEqual(["From the editor"]);
  });
});

describe("keyCaps", () => {
  it("spells shortcuts for this platform", () => {
    expect(keyCaps("Mod-Shift-f")).toEqual(navigator.platform.startsWith("Mac") ? ["⌘", "⇧", "F"] : ["Ctrl", "Shift", "F"]);
    expect(keyCaps("Mod-/")).toHaveLength(2);
  });
});
