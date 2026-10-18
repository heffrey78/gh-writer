import { useCallback } from "react";
import { useNavigate } from "react-router";

/**
 * The page's side of the desktop app (D9). In the app, a page can ask the shell for what a browser
 * page can't do: choose a folder, open a novel in a window of its own, bring the library forward. The
 * shell in turn runs commands in the page (`window.ghWriter.run`: its menu's New novel…, a folder
 * dropped on the library or passed on the command line), and before it quits asks the page to save
 * (`window.ghWriter.flushAll`). In a browser none of this is there, and the app works as a web page.
 */

interface Invoke {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
}

/** A command from the shell, by name: "go" (a path in the app) or "about". */
export interface ShellCommand {
  name: string;
  arg?: string | null;
}

const shell = (window as unknown as { __TAURI__?: { core?: Invoke } }).__TAURI__?.core;

/** Whether this page is in the desktop app. */
export const desktop = shell !== undefined;

declare global {
  interface Window {
    ghWriter?: { flushAll(): Promise<void>; run(command: ShellCommand): void };
  }
}

const flushes = new Set<() => Promise<void>>();
const handlers = new Map<string, (arg: string | undefined) => void>();
// Commands that came before their handler did (the shell's first ones arrive as the page loads).
const waiting: ShellCommand[] = [];

function run(command: ShellCommand): void {
  const handler = handlers.get(command.name);
  if (handler) handler(command.arg ?? undefined);
  else waiting.push(command);
}

window.ghWriter = {
  async flushAll() {
    await Promise.allSettled([...flushes].map((flush) => flush()));
  },
  run,
};

// Tell the shell the page is ready for commands, and run any it kept for it.
if (shell) void shell.invoke<ShellCommand[]>("page_ready").then((commands) => commands.forEach(run));

/** Save with `flush` when the desktop app quits or the window closes. Returns a function that stops it. */
export function flushOnQuit(flush: () => Promise<void>): () => void {
  flushes.add(flush);
  return () => void flushes.delete(flush);
}

/** Run `handler` for the shell's command `name`, including one that came earlier. Returns a function that stops it. */
export function onShellCommand(name: string, handler: (arg: string | undefined) => void): () => void {
  handlers.set(name, handler);
  const mine = waiting.filter((c) => c.name === name);
  waiting.splice(0, waiting.length, ...waiting.filter((c) => c.name !== name));
  for (const command of mine) handler(command.arg ?? undefined);
  return () => {
    if (handlers.get(name) === handler) handlers.delete(name);
  };
}

/** The folder the writer chooses in the system's dialog, or null if they cancel. Desktop only. */
export function chooseFolder(title: string): Promise<string | null> {
  return shell ? shell.invoke<string | null>("pick_folder", { title }) : Promise.resolve(null);
}

export type EditAction = "cut" | "copy" | "paste" | "select_all";

/**
 * Have the shell run the webview's own editing command on what has the focus. False where it can't
 * (in a browser, and in the desktop app on macOS and Windows for now): the page does it itself.
 */
export function shellEdit(action: EditAction): Promise<boolean> {
  return shell ? shell.invoke<boolean>("edit", { action }).catch(() => false) : Promise.resolve(false);
}

/** The clipboard's text, which a page can't read on its own: from the shell, or null. */
export function clipboardText(): Promise<string | null> {
  return shell ? shell.invoke<string | null>("clipboard_text").catch(() => null) : Promise.resolve(null);
}

/** Whether the shell can open the inspector on this page (a debug build). */
export function canInspect(): Promise<boolean> {
  return shell ? shell.invoke<boolean>("can_inspect").catch(() => false) : Promise.resolve(false);
}

/** Open the inspector on this page. */
export function inspect(): void {
  void shell?.invoke("inspect");
}

/** Tell the shell the novels most recently opened, for its Open Recent menu. */
export function reportRecent(novels: { id: string; title: string }[]): void {
  void shell?.invoke("set_recent", { novels });
}

/** Open a novel: in the desktop app, in a window of its own (or bring that window forward); in a browser, here. */
export function useOpenNovel(): (id: string) => void {
  const navigate = useNavigate();
  return useCallback((id: string) => (shell ? void shell.invoke("open_novel", { id }) : void navigate(`/novels/${id}`)), [navigate]);
}

/**
 * Go to the library, at `path` ("/?add=new", say): in the desktop app, in its own window (unless this
 * is it); in a browser, here.
 */
export function useShowLibrary(): (path?: string) => void {
  const navigate = useNavigate();
  return useCallback(
    (path = "/") => {
      if (!shell) return void navigate(path);
      void shell.invoke<boolean>("show_library", { path }).then((elsewhere) => elsewhere || navigate(path));
    },
    [navigate],
  );
}
