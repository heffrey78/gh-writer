import { SCHEMA_VERSION, type Novel } from "@gh-writer/core";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, keys } from "../api.ts";
import { useNotice } from "../novel/notice.tsx";
import { Confirm } from "../ui/confirm.tsx";

/** What moving a novel to format v2 means, said where the writer is asked (D11). */
export const FORMAT_MOVE = "gh-writer now keeps each off-page event in a file of its own. The novel moves to the new format in one commit: every event, and its GitHub tools. Copies of gh-writer from before this one won't open it afterwards.";

/** Whether a novel is in an older format than this app writes: an event change moves it first. */
export const needsFormatMove = (novel: Novel) => (novel.config?.schema_version ?? 1) < SCHEMA_VERSION;

/**
 * Moving a novel in format v1 to v2 before an event is changed (D11). `ensure(then)` runs `then` at once
 * in a novel already moved; otherwise it asks, once, and runs it after the move. Cancelling changes nothing.
 * Show `dialog` somewhere on the page.
 */
export function useFormatMove(novelId: string, novel: Novel) {
  const queryClient = useQueryClient();
  const show = useNotice((n) => n.show);
  const [waiting, setWaiting] = useState<(() => void) | null>(null);
  const move = async (then: () => void) => {
    try {
      await api.migrate(novelId);
      await queryClient.invalidateQueries({ queryKey: keys.novel(novelId) });
      then();
    } catch (e) {
      show({ message: `Couldn't move the novel to the new format: ${e instanceof Error ? e.message : String(e)}` });
    }
  };
  const ensure = (then: () => void) => (needsFormatMove(novel) ? setWaiting(() => then) : then());
  const dialog = (
    <Confirm
      open={waiting !== null}
      onOpenChange={(o) => !o && setWaiting(null)}
      title="Move this novel to the new format?"
      description={FORMAT_MOVE}
      action="Move it"
      onConfirm={() => waiting && void move(waiting)}
    />
  );
  return { ensure, dialog };
}
