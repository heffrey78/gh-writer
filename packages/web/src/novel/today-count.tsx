import { useWritingModes } from "@gh-writer/editor/react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { Link } from "react-router";
import { useStore } from "zustand";
import { keys } from "../api.ts";
import { localToday, useStats } from "./progress-page.tsx";
import type { Workspace } from "./workspace.ts";

const format = new Intl.NumberFormat();

/**
 * Words added today beside the editor's counts (#20), against the daily goal: from the history and
 * saved work not committed yet, read again after each save. Opens Progress.
 */
export function TodayCount({ novelId, workspace }: { novelId: string; workspace: Workspace }) {
  const stats = useStats(novelId);
  const queryClient = useQueryClient();
  const status = useStore(workspace.autosave.store, (s) => s.status);
  const hidden = useWritingModes((m) => m.focus && !m.pinCount);
  // Each save lands on disk: what's saved counts, so read the stats again (once things settle).
  useEffect(() => {
    if (status !== "saved") return;
    const timer = setTimeout(() => void queryClient.invalidateQueries({ queryKey: keys.stats(novelId) }), 500);
    return () => clearTimeout(timer);
  }, [status, novelId, queryClient]);
  if (!stats.data || hidden) return null;
  const today = localToday();
  const added = (stats.data.days.find((d) => d.day === today)?.added ?? 0) + stats.data.pending.added;
  const daily = stats.data.target?.daily;
  return (
    <Link
      to={`/novels/${novelId}/progress`}
      className="text-sm text-muted hover:text-ink"
      aria-label={`Today: ${format.format(added)} words added${daily ? ` of ${format.format(daily)} a day` : ""}. Open Progress.`}
    >
      Today <strong className="font-semibold text-ink">{format.format(added)}</strong>
      {daily ? ` of ${format.format(daily)}` : ""}
      {daily && added >= daily ? " ✓" : ""}
    </Link>
  );
}
