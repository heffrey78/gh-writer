import type { Novel } from "@gh-writer/core";
import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import { Navigate, useLocation, useNavigate, useParams } from "react-router";
import { PresencePage } from "../presence/presence-page.tsx";
import { SwimlanesPage } from "../swimlanes/swimlanes-page.tsx";
import { TimelinePage } from "../timeline/timeline-page.tsx";
import { cn } from "../ui/cn.ts";
import type { Workspace } from "./workspace.ts";

/*
 * The story map (#136): the views that set the story's elements against its scenes, as tabs of one
 * page. Each tab has its own address (/story-map/plotlines…); each view keeps its controls and export.
 */

export const STORY_MAP_TABS = [
  { key: "plotlines", label: "Plotlines" },
  { key: "presence", label: "Presence" },
  { key: "timeline", label: "Timeline" },
] as const;
type Tab = (typeof STORY_MAP_TABS)[number]["key"];

export function StoryMapPage({ novelId, novel, workspace }: { novelId: string; novel: Novel; workspace: Workspace }) {
  const { tab } = useParams();
  const navigate = useNavigate();
  const { state } = useLocation() as { state: { focusTab?: boolean } | null };
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const current = STORY_MAP_TABS.findIndex((t) => t.key === tab);
  // A tab chosen by keyboard keeps the focus: the view may have been drawn afresh for its address.
  useEffect(() => {
    if (state?.focusTab) tabs.current[current]?.focus();
  }, [state, current]);
  if (current < 0) return <Navigate to={`/novels/${novelId}/story-map/plotlines`} replace />;
  const go = (i: number, focus = false) => {
    const t = STORY_MAP_TABS[(i + STORY_MAP_TABS.length) % STORY_MAP_TABS.length]!;
    void navigate(`/novels/${novelId}/story-map/${t.key}`, focus ? { state: { focusTab: true } } : undefined);
  };
  // The tab pattern: arrows (and Home, End) move between tabs and open them.
  const onKey = (e: KeyboardEvent) => {
    const moves: Record<string, number> = { ArrowRight: current + 1, ArrowLeft: current - 1, Home: 0, End: STORY_MAP_TABS.length - 1 };
    const to = moves[e.key];
    if (to === undefined) return;
    e.preventDefault();
    go(to, true);
  };
  const panels: Record<Tab, ReactNode> = {
    plotlines: <SwimlanesPage novelId={novelId} novel={novel} workspace={workspace} />,
    presence: <PresencePage novelId={novelId} novel={novel} workspace={workspace} />,
    timeline: <TimelinePage novelId={novelId} novel={novel} />,
  };
  const active = STORY_MAP_TABS[current]!;
  return (
    <div className="grid content-start">
      <div className="grid gap-3 px-6 pt-6">
        <h1 className="text-xl font-semibold">Story map</h1>
        <div role="tablist" aria-label="Story map" className="flex gap-1 border-b border-rule" onKeyDown={onKey}>
          {STORY_MAP_TABS.map((t, i) => (
            <button
              key={t.key}
              ref={(el) => void (tabs.current[i] = el)}
              type="button"
              role="tab"
              id={`story-map-tab-${t.key}`}
              aria-selected={i === current}
              aria-controls="story-map-panel"
              tabIndex={i === current ? 0 : -1}
              onClick={() => go(i)}
              className={cn("-mb-px border-b-2 px-3 py-1.5 text-sm", i === current ? "border-accent font-medium" : "border-transparent text-muted hover:text-ink")}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>
      <div role="tabpanel" id="story-map-panel" aria-labelledby={`story-map-tab-${active.key}`}>
        {panels[active.key]}
      </div>
    </div>
  );
}
