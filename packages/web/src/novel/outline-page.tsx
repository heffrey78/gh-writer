import type { Novel } from "@gh-writer/core";
import { useEffect, useRef } from "react";
import { Navigate, useLocation, useNavigate, useParams } from "react-router";
import { cn } from "../ui/cn.ts";
import { OutlineCards } from "./corkboard.tsx";
import { OutlineTable } from "./outline.tsx";
import type { Workspace } from "./workspace.ts";

/*
 * The outline (#136): every scene in reading order, as a table or as cards (the corkboard), switched
 * in place. The choice is in the address (/outline/table, /outline/cards) and remembered for /outline.
 */

const VIEWS = [
  { key: "table", label: "Table" },
  { key: "cards", label: "Cards" },
] as const;
type View = (typeof VIEWS)[number]["key"];
const KEY = "ghw.outlineView";

function remembered(): View {
  try {
    return localStorage.getItem(KEY) === "cards" ? "cards" : "table";
  } catch {
    return "table";
  }
}

function remember(view: View) {
  try {
    localStorage.setItem(KEY, view);
  } catch {
    // Not remembered where storage is blocked.
  }
}

export function OutlinePage({ novelId, novel, workspace }: { novelId: string; novel: Novel; workspace: Workspace }) {
  const { view } = useParams();
  const navigate = useNavigate();
  const { state } = useLocation() as { state: { focusSwitch?: boolean } | null };
  const group = useRef<HTMLDivElement>(null);
  // The switch keeps the focus: the view may have been drawn afresh for its address.
  useEffect(() => {
    if (state?.focusSwitch) group.current?.querySelector<HTMLInputElement>("input:checked")?.focus();
  }, [state, view]);
  if (view !== "table" && view !== "cards") return <Navigate to={`/novels/${novelId}/outline/${remembered()}`} replace />;
  const choose = (next: View) => {
    remember(next);
    void navigate(`/novels/${novelId}/outline/${next}`, { replace: true, state: { focusSwitch: true } });
  };
  return (
    <div className="grid gap-4 px-6 py-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Outline</h1>
        <div ref={group} role="radiogroup" aria-label="Show the outline as" className="inline-flex rounded-md border border-rule bg-raised p-0.5 text-sm">
          {VIEWS.map((v) => (
            <label key={v.key} className={cn("cursor-pointer rounded px-3 py-1 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent", view === v.key ? "bg-accent-soft font-medium" : "text-muted hover:text-ink")}>
              <input type="radio" name="outline-view" value={v.key} checked={view === v.key} onChange={() => choose(v.key)} className="sr-only" />
              {v.label}
            </label>
          ))}
        </div>
      </div>
      {view === "cards" ? <OutlineCards novelId={novelId} novel={novel} workspace={workspace} /> : <OutlineTable novelId={novelId} novel={novel} workspace={workspace} />}
    </div>
  );
}
