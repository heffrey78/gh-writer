import type { IssueFilter } from "@gh-writer/client";
import type { Novel } from "@gh-writer/core";
import { useQueryClient } from "@tanstack/react-query";
import { MessageSquare, Plus, RefreshCw, Search } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { Link, useNavigate } from "react-router";
import { api, keys } from "../api.ts";
import { useNotice } from "../novel/notice.tsx";
import { Button } from "../ui/button.tsx";
import { Modal } from "../ui/dialog.tsx";
import { Field } from "../ui/field.tsx";
import { Picker } from "../ui/picker.tsx";
import { useViewParams } from "../ui/view-params.ts";
import { displayLabel, ensureKind, IssuesState, KindSelect, LabelChip, labelChoices, LabelsField, MilestoneField, MilestoneSelect, MilestonesDialog, when, withKind } from "./parts.tsx";
import type { Workspace } from "../novel/workspace.ts";
import { passageOf } from "./anchors.ts";
import { useIssueChanges, useIssueList, useIssueMeta } from "./use-issues.ts";

/** The novel's GitHub issues: filtered by state, labels, milestone and words, with the filter in the address. */
export function IssuesPage({ novelId, novel, workspace }: { novelId: string; novel: Novel; workspace: Workspace }) {
  const [params, setParams] = useViewParams();
  const queryClient = useQueryClient();
  const show = useNotice((n) => n.show);
  const ids = { search: useId(), state: useId(), milestone: useId(), kind: useId() };
  const meta = useIssueMeta(novelId);
  const [managing, setManaging] = useState(false);
  const choices = labelChoices(meta, novel);
  const state = (params.get("state") ?? "open") as NonNullable<IssueFilter["state"]>;
  const labels = (params.get("labels") ?? "").split(",").filter(Boolean);
  const milestone = params.get("milestone") ?? "";
  const q = params.get("q") ?? "";
  const kind = params.get("kind") ?? "";
  const filter: IssueFilter = { state, ...(labels.length || kind ? { labels: withKind(labels, kind) } : {}), ...(milestone ? { milestone: milestone === "none" ? "none" : Number(milestone) } : {}), ...(q ? { q } : {}) };
  const list = useIssueList(novelId, filter);
  const [creating, setCreating] = useState(params.get("new") === "1");

  const refresh = () =>
    void api.issues
      .refresh(novelId)
      .catch(() => {})
      .finally(() => void queryClient.invalidateQueries({ queryKey: keys.issues(novelId) }));
  // Fresh from GitHub when the view opens (the sync keeps it so afterwards).
  useEffect(refresh, [novelId]); // eslint-disable-line react-hooks/exhaustive-deps

  const discard = (id: string) =>
    void api.issues
      .discard(novelId, id)
      .catch((e: unknown) => show({ message: e instanceof Error ? e.message : String(e) }))
      .finally(() => void queryClient.invalidateQueries({ queryKey: keys.issues(novelId) }));

  const data = list.data;
  return (
    <div className="mx-auto grid w-full max-w-4xl gap-4 px-6 py-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Issues</h1>
        <div className="flex gap-2">
          <Button onClick={() => setManaging(true)}>Milestones</Button>
          <Button onClick={refresh} aria-label="Refresh from GitHub">
            <RefreshCw className="size-4" aria-hidden /> Refresh
          </Button>
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Plus className="size-4" aria-hidden /> New issue
          </Button>
        </div>
      </div>
      <IssuesState status={data?.status} onRefresh={refresh} onDiscard={discard} />

      <search className="grid gap-3 rounded-lg border border-rule bg-panel p-3 sm:grid-cols-[1fr_auto_auto]">
        <div className="relative">
          <label htmlFor={ids.search} className="sr-only">
            Search issues
          </label>
          <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-muted" aria-hidden />
          <input
            id={ids.search}
            type="search"
            placeholder="Words in the title, description or comments"
            value={q}
            onChange={(e) => setParams({ q: e.target.value })}
            className="h-9 w-full rounded-md border border-rule bg-raised pr-3 pl-9 text-sm"
          />
        </div>
        <div className="flex items-center gap-2">
          <label htmlFor={ids.state} className="text-sm font-medium">
            State
          </label>
          <select id={ids.state} value={state} onChange={(e) => setParams({ state: e.target.value === "open" ? undefined : e.target.value })} className="h-9 rounded-md border border-rule bg-raised px-2 text-sm">
            <option value="open">Open</option>
            <option value="closed">Closed</option>
            <option value="all">All</option>
          </select>
        </div>
        <div className="flex items-center gap-2">
          <label htmlFor={ids.milestone} className="text-sm font-medium">
            Milestone
          </label>
          <MilestoneSelect id={ids.milestone} value={milestone} milestones={data?.milestones ?? []} onChange={(v) => setParams({ milestone: v })} any />
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:col-span-3">
          <label htmlFor={ids.kind} className="text-sm font-medium">
            Kind
          </label>
          <KindSelect id={ids.kind} value={kind} onChange={(v) => setParams({ kind: v })} any />
          {labels.map((l) => (
            <LabelChip key={l} name={l} labels={choices} onRemove={() => setParams({ labels: labels.filter((x) => x !== l).join(",") })} />
          ))}
          <Picker
            className="w-56"
            label="Filter by label"
            items={[...new Set([...choices.map((l) => l.name), ...labels])].map((name) => ({ value: name, label: displayLabel(name, choices), group: choices.find((c) => c.name === name)?.group ?? "Other labels", keywords: [name] }))}
            value={undefined}
            chosen={labels}
            onChange={(v) => v && setParams({ labels: (labels.includes(v) ? labels.filter((x) => x !== v) : [...labels, v]).join(",") })}
            placeholder="Any label"
          />
        </div>
      </search>

      {!data ? (
        <p className="text-muted">Loading issues…</p>
      ) : !data.issues.length ? (
        <p className="text-muted">{q || labels.length || milestone || kind ? "No issues match." : state === "closed" ? "No closed issues." : "No open issues."}</p>
      ) : (
        <ul aria-label="Issues" className="grid divide-y divide-rule rounded-lg border border-rule bg-raised">
          {data.issues.map((i) => (
            <li key={i.number} className="grid gap-1 px-4 py-3">
              <div className="flex flex-wrap items-baseline gap-2">
                <Link to={`/novels/${novelId}/issues/${i.number}`} className="font-medium hover:underline">
                  {i.title}
                </Link>
                {i.labels.map((l) => (
                  <LabelChip key={l} name={l} labels={data.labels} />
                ))}
              </div>
              <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted">
                <span>{i.number > 0 ? `#${i.number}` : "New"}</span>
                <span>{i.state === "closed" ? `closed ${when(i.closedAt ?? i.updatedAt)}` : `opened ${when(i.createdAt)}${i.author ? ` by ${i.author}` : ""}`}</span>
                {i.milestone !== null && <span>{data.milestones.find((m) => m.number === i.milestone)?.title}</span>}
                {i.commentCount > 0 && (
                  <span className="inline-flex items-center gap-1">
                    <MessageSquare className="size-3" aria-hidden /> {i.commentCount === 1 ? "1 comment" : `${i.commentCount} comments`}
                  </span>
                )}
                {i.pending && <span className="text-warn">Not on GitHub yet</span>}
              </p>
              <PassageLine novelId={novelId} passage={passageOf(i, novel, (f) => workspace.current(f))} />
            </li>
          ))}
        </ul>
      )}
      {managing && <MilestonesDialog novelId={novelId} milestones={meta?.milestones ?? []} onClose={() => setManaging(false)} />}
      {creating && (
        <NewIssue
          novelId={novelId}
          novel={novel}
          onClose={() => {
            setCreating(false);
            if (params.get("new")) setParams({ new: undefined });
          }}
        />
      )}
    </div>
  );
}

/** Where an issue's passage is, or that it's orphaned (the passage gone), with what it read. */
export function PassageLine({ novelId, passage }: { novelId: string; passage: ReturnType<typeof passageOf> }) {
  if (!passage) return null;
  const quote = passage.anchor.quote.length > 120 ? `${passage.anchor.quote.slice(0, 117)}…` : passage.anchor.quote;
  if (!passage.found) {
    return (
      <p className="text-xs text-warn">
        Orphaned: the passage it's about is gone{passage.scene ? ` from “${passage.scene.title}”` : ""}. It read: “{quote}”
      </p>
    );
  }
  return (
    <p className="text-xs text-muted">
      About “{quote}” in{" "}
      <Link to={`/novels/${novelId}/scene/${passage.scene!.id}`} className="underline">
        {passage.scene!.title}
      </Link>
    </p>
  );
}

/** A new issue: its title, details, labels and milestone. */
function NewIssue({ novelId, novel, onClose }: { novelId: string; novel: Novel; onClose: () => void }) {
  const navigate = useNavigate();
  const meta = useIssueMeta(novelId);
  const changes = useIssueChanges(novelId);
  const [kind, setKind] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [labels, setLabels] = useState<string[]>([]);
  const [milestone, setMilestone] = useState("none");
  const ids = { body: useId(), milestone: useId(), kind: useId() };
  return (
    <Modal title="New issue" onClose={onClose} className="w-[min(36rem,calc(100vw-2rem))]">
      <form
        className="grid gap-3"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!title.trim()) return;
          if (kind) await ensureKind(novelId, kind);
          const made = await changes.create({ title, body, labels: withKind(labels, kind), ...(milestone !== "none" ? { milestone: Number(milestone) } : {}) });
          if (!made) return;
          onClose();
          void navigate(`/novels/${novelId}/issues/${made.number}`);
        }}
      >
        <Field label="Title" value={title} onChange={(e) => setTitle(e.target.value)} required autoFocus />
        <div className="grid gap-1.5">
          <label htmlFor={ids.body} className="text-sm font-medium">
            Details
          </label>
          <textarea id={ids.body} value={body} onChange={(e) => setBody(e.target.value)} rows={6} className="rounded-md border border-rule bg-raised px-3 py-2 text-sm" placeholder="Markdown, as on GitHub" />
        </div>
        <div className="flex items-center gap-2">
          <label htmlFor={ids.kind} className="text-sm font-medium">
            Kind
          </label>
          <KindSelect id={ids.kind} value={kind} onChange={setKind} />
        </div>
        <LabelsField label="Labels" chosen={labels} labels={labelChoices(meta, novel)} onChange={setLabels} />
        <div className="flex items-center gap-2">
          <label htmlFor={ids.milestone} className="text-sm font-medium">
            Milestone
          </label>
          <MilestoneField novelId={novelId} id={ids.milestone} value={milestone} milestones={(meta?.milestones ?? []).filter((m) => m.state === "open")} onChange={setMilestone} />
        </div>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={!title.trim() || changes.busy}>
            Create issue
          </Button>
        </div>
      </form>
    </Modal>
  );
}
