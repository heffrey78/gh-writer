import type { SyncStatus } from "@gh-writer/client";
import { useEffect, useRef, useState } from "react";
import type { FileEvent } from "./workspace.ts";

export interface NovelEventHandlers {
  file?: (e: FileEvent) => void;
  sync?: (status: SyncStatus) => void;
}

/**
 * The novel's live events (server: GET /events): files changed outside the app, and the sync status.
 * Returns whether the stream is connected; EventSource reconnects by itself.
 */
export function useNovelEvents(novelId: string, handlers: NovelEventHandlers): boolean {
  const latest = useRef(handlers);
  latest.current = handlers;
  const [connected, setConnected] = useState(true);
  useEffect(() => {
    const source = new EventSource(`/api/novels/${encodeURIComponent(novelId)}/events`);
    source.addEventListener("ready", () => setConnected(true));
    source.addEventListener("file", (e) => latest.current.file?.(JSON.parse((e as MessageEvent<string>).data) as FileEvent));
    source.addEventListener("sync", (e) => latest.current.sync?.(JSON.parse((e as MessageEvent<string>).data) as SyncStatus));
    source.onerror = () => setConnected(false);
    return () => source.close();
  }, [novelId]);
  return connected;
}
