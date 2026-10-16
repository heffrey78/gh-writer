import type { SyncStatus } from "@gh-writer/client";
import { useEffect, useRef, useState } from "react";
import type { FileEvent } from "./workspace.ts";

export interface NovelEventHandlers {
  file?: (e: FileEvent) => void;
  sync?: (status: SyncStatus) => void;
  /** The novel's cached GitHub issues changed. */
  issues?: () => void;
  /** The drafting board's status on GitHub changed. */
  board?: () => void;
}

/** How often, while gh-writer isn't answering, it's asked again; and how long each ask may take. */
export const RECHECK_MS = 3_000;
const ASK_TIMEOUT_MS = 5_000;

/** Whether gh-writer answers this tab (with its session): the health check, cheap and never cached. */
async function answers(): Promise<boolean> {
  try {
    return (await fetch("/api/health", { cache: "no-store", signal: AbortSignal.timeout(ASK_TIMEOUT_MS) })).ok;
  } catch {
    return false;
  }
}

/**
 * The novel's live events (server: GET /events): files changed outside the app, and the sync status.
 * Returns whether gh-writer is answering; EventSource reconnects by itself. An error on the stream
 * alone doesn't say it isn't (WebKit can report one while the stream holds, #197), so it's asked:
 * not answering, it's asked again until it does, or until the stream is back.
 */
export function useNovelEvents(novelId: string, handlers: NovelEventHandlers): boolean {
  const latest = useRef(handlers);
  latest.current = handlers;
  const [connected, setConnected] = useState(true);
  useEffect(() => {
    const source = new EventSource(`/api/novels/${encodeURIComponent(novelId)}/events`);
    let asking = false;
    let again: ReturnType<typeof setTimeout> | undefined;
    let gone = false;
    const back = () => {
      clearTimeout(again);
      again = undefined;
      setConnected(true);
    };
    const ask = async () => {
      if (asking || again) return;
      asking = true;
      const ok = await answers();
      asking = false;
      if (gone) return;
      if (ok) return back();
      setConnected(false);
      again = setTimeout(() => {
        again = undefined;
        void ask();
      }, RECHECK_MS);
    };
    // Anything from the stream (the server's ping included) says it holds.
    for (const name of ["ready", "ping", "file", "sync", "issues", "board"]) source.addEventListener(name, back);
    source.addEventListener("file", (e) => latest.current.file?.(JSON.parse((e as MessageEvent<string>).data) as FileEvent));
    source.addEventListener("sync", (e) => latest.current.sync?.(JSON.parse((e as MessageEvent<string>).data) as SyncStatus));
    source.addEventListener("issues", () => latest.current.issues?.());
    source.addEventListener("board", () => latest.current.board?.());
    source.onerror = () => void ask();
    return () => {
      gone = true;
      clearTimeout(again);
      source.close();
    };
  }, [novelId]);
  return connected;
}
