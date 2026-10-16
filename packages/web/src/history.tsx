import { ArrowLeft, ArrowRight } from "lucide-react";
import { useEffect } from "react";
import { useLocation, useNavigate, useNavigationType } from "react-router";
import { create } from "zustand";
import { useCommands } from "./commands.ts";
import { desktop } from "./desktop.ts";

/*
 * Back and Forward through the app's own pages (#224), for the desktop app's window, which has no
 * browser buttons, and the same in a browser. Where we are comes from the router's history index; how
 * far Forward reaches is the furthest index a new page was opened at, kept for this tab.
 */

const KEY = "ghw.historyTop";
const index = () => ((window.history.state as { idx?: number } | null)?.idx ?? 0);

function storedTop(): number {
  try {
    return Number(sessionStorage.getItem(KEY)) || 0;
  } catch {
    return 0;
  }
}

const useReach = create<{ at: number; top: number }>(() => ({ at: index(), top: Math.max(index(), storedTop()) }));

/** Whether there's a page to go back or forward to. */
export const useCanGo = () => ({ back: useReach((s) => s.at > 0), forward: useReach((s) => s.at < s.top) });

const editable = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

/**
 * Follows the app's history, and goes back and forward on Alt+Left/Right (not in text, where those
 * move the caret on a Mac, nor where a view has used the keys) and, in the desktop app, on the mouse's
 * back and forward buttons (browsers do that themselves). Mounted once, inside the router.
 */
export function HistoryKeeper() {
  const location = useLocation();
  const type = useNavigationType();
  const navigate = useNavigate();
  useEffect(() => {
    const at = index();
    const top = type === "PUSH" ? at : Math.max(at, useReach.getState().top);
    useReach.setState({ at, top });
    try {
      sessionStorage.setItem(KEY, String(top));
    } catch {
      // Forward is forgotten on reload where storage is blocked.
    }
  }, [location, type]);

  const canBack = useReach((s) => s.at > 0);
  const canForward = useReach((s) => s.at < s.top);
  useCommands(
    () => [
      ...(canBack ? [{ id: "app.back", title: "Go back", group: "Go to", keys: "Alt-ArrowLeft", keywords: ["previous page", "history"], run: () => void navigate(-1) }] : []),
      ...(canForward ? [{ id: "app.forward", title: "Go forward", group: "Go to", keys: "Alt-ArrowRight", keywords: ["next page", "history"], run: () => void navigate(1) }] : []),
    ],
    [canBack, canForward, navigate],
  );

  useEffect(() => {
    const go = (by: -1 | 1) => {
      const { at, top } = useReach.getState();
      if (by < 0 ? at > 0 : at < top) void navigate(by);
    };
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
      if (e.defaultPrevented || editable(e.target)) return;
      e.preventDefault();
      go(e.key === "ArrowLeft" ? -1 : 1);
    };
    const onMouse = (e: MouseEvent) => {
      if (e.button !== 3 && e.button !== 4) return;
      e.preventDefault();
      go(e.button === 3 ? -1 : 1);
    };
    window.addEventListener("keydown", onKey);
    if (desktop) window.addEventListener("mouseup", onMouse);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mouseup", onMouse);
    };
  }, [navigate]);
  return null;
}

/** The top bar's Back and Forward. */
export function HistoryButtons() {
  const navigate = useNavigate();
  const can = useCanGo();
  const button = "rounded-md p-1.5 text-muted hover:bg-paper hover:text-ink disabled:opacity-40 disabled:hover:bg-transparent";
  return (
    <div role="group" aria-label="History" className="flex shrink-0 items-center">
      <button type="button" disabled={!can.back} onClick={() => void navigate(-1)} aria-label="Back" title="Back (Alt+←)" aria-keyshortcuts="Alt+ArrowLeft" className={button}>
        <ArrowLeft className="size-4" aria-hidden />
      </button>
      <button type="button" disabled={!can.forward} onClick={() => void navigate(1)} aria-label="Forward" title="Forward (Alt+→)" aria-keyshortcuts="Alt+ArrowRight" className={button}>
        <ArrowRight className="size-4" aria-hidden />
      </button>
    </div>
  );
}
