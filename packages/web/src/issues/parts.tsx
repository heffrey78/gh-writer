import type { IssueLabel, IssueList, IssuesStatus, Milestone } from "@gh-writer/client";
import { entityLabel, entityOfLabel, ISSUE_KINDS, kindLabel, kindOf, STOCK_LABELS, type Novel } from "@gh-writer/core";
import { plural } from "../bible/types.ts";
import { useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { useId, useState } from "react";
import { api, keys } from "../api.ts";
import { useNotice } from "../novel/notice.tsx";
import { Modal } from "../ui/dialog.tsx";
import { Field } from "../ui/field.tsx";
import { useGitHub, useConnect } from "../github/connect.tsx";
import { Button } from "../ui/button.tsx";
import { Picker } from "../ui/picker.tsx";

const time = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
export const when = (iso: string) => time.format(new Date(iso));

/** A label for the author: a kind by its name ("Plot hole"), a bible entry's by the entry's name ("Ada Varn"). */
export function displayLabel(name: string, labels: readonly IssueLabel[]): string {
  const kind = kindOf(name);
  if (kind) return kind.label;
  const entry = /^(.+) · [a-z]{2,8}_[0-9a-hjkmnp-tv-z]{6}$/.exec(labels.find((l) => l.name === name)?.description ?? "");
  return entry ? entry[1]! : name;
}

/** A label as GitHub colours it, by the name the author knows it by, optionally with a button to take it off. */
export function LabelChip({ name, labels, onRemove }: { name: string; labels: readonly IssueLabel[]; onRemove?: () => void }) {
  const kind = kindOf(name);
  const color = labels.find((l) => l.name === name)?.color ?? kind?.color ?? "ededed";
  const shown = displayLabel(name, labels);
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-rule bg-raised px-2 py-0.5 text-xs">
      <span className="inline-block size-2 rounded-full" style={{ background: `#${color}` }} aria-hidden />
      {shown}
      {onRemove && (
        <button type="button" onClick={onRemove} aria-label={`Remove label “${shown}”`} className="rounded text-muted hover:text-ink">
          <X className="size-3" aria-hidden />
        </button>
      )}
    </span>
  );
}

/**
 * Labels chosen, as chips, and a picker listing every label with the chosen ones checked: choosing
 * one adds it or takes it off; a name no label has can be made a new label.
 */
export function LabelsField({ label, chosen, labels, onChange }: { label: string; chosen: string[]; labels: readonly LabelChoice[]; onChange: (labels: string[]) => void }) {
  // The chosen ones are listed even when they're not among those offered (a stock label already on it).
  const names = [...labels.map((l) => l.name), ...chosen.filter((c) => !labels.some((l) => l.name === c))];
  const groupOf = (name: string) => labels.find((l) => l.name === name)?.group ?? OTHER;
  return (
    <div className="grid gap-1.5">
      {chosen.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label={label}>
          {chosen.map((name) => (
            <li key={name}>
              <LabelChip name={name} labels={labels} onRemove={() => onChange(chosen.filter((x) => x !== name))} />
            </li>
          ))}
        </ul>
      )}
      <Picker
        label={`Add to ${label.toLowerCase()}`}
        items={names
          .map((name) => ({ value: name, label: displayLabel(name, labels), group: groupOf(name), keywords: [name, labels.find((l) => l.name === name)?.description ?? ""] }))
          // Bible entries by type first, then the other labels.
          .sort((a, b) => Number(a.group === OTHER) - Number(b.group === OTHER))}
        value={undefined}
        chosen={chosen}
        onChange={(v) => v && onChange(chosen.includes(v) ? chosen.filter((x) => x !== v) : [...chosen, v])}
        placeholder="Add a label…"
        // A kind is chosen as a kind, not made as a label.
        create={{ noun: "label", create: (name) => (name.trim() && !name.trim().startsWith("kind/") ? name.trim() : undefined) }}
      />
    </div>
  );
}

/** A label to offer, with the group it's listed under: a bible entry's type ("Characters"), or "Other labels". */
export type LabelChoice = IssueLabel & { group: string };
const OTHER = "Other labels";

/**
 * Labels to offer: every bible entry's (whether or not its label is on GitHub yet), by type, then the
 * repository's other labels worth offering (see pickableLabels).
 */
export function labelChoices(meta: Pick<IssueList, "labels" | "issues"> | undefined, novel: Novel): LabelChoice[] {
  const entries = novel.entityTypes.flatMap((t) =>
    novel.entities
      .filter((e) => e.type === t.key)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((e) => ({ ...entityLabel(novel, e), group: plural(t.label) })),
  );
  const others = pickableLabels(meta)
    // An entry's label is offered as the entry (above), under its current name.
    .filter((l) => !entityOfLabel(novel, l))
    .map((l) => ({ ...l, group: OTHER }));
  return [...entries, ...others];
}

/**
 * The labels worth offering: not the kinds (they have their own choice), and not GitHub's stock
 * software labels (bug, enhancement, …) unless an issue uses one.
 */
export function pickableLabels(meta: Pick<IssueList, "labels" | "issues"> | undefined): IssueLabel[] {
  if (!meta) return [];
  const used = new Set(meta.issues.flatMap((i) => i.labels));
  return meta.labels.filter((l) => !kindOf(l.name) && !l.name.startsWith("kind/") && (!STOCK_LABELS.has(l.name) || used.has(l.name)));
}

/** The kind of an issue, from its labels. */
export const kindIn = (labels: string[]) => ISSUE_KINDS.find((k) => labels.includes(kindLabel(k)))?.key ?? "";

/** Labels with the kind changed to `key` ("" for none). */
export const withKind = (labels: string[], key: string) => [...labels.filter((l) => !kindOf(l)), ...(key ? [`kind/${key}`] : [])];

/** Make sure a kind's label is on the repository with its colour (best effort). */
export async function ensureKind(novelId: string, key: string): Promise<void> {
  const kind = ISSUE_KINDS.find((k) => k.key === key);
  if (kind) await api.issues.ensureLabel(novelId, { name: kindLabel(kind), color: kind.color, description: kind.description }).catch(() => {});
}

export function KindSelect({ id, value, onChange, any }: { id: string; value: string; onChange: (key: string) => void; any?: boolean }) {
  return (
    <select id={id} value={value} onChange={(e) => onChange(e.target.value)} className="h-9 rounded-md border border-rule bg-raised px-2 text-sm">
      <option value="">{any ? "Any kind" : "No kind"}</option>
      {ISSUE_KINDS.map((k) => (
        <option key={k.key} value={k.key}>
          {k.label}
        </option>
      ))}
    </select>
  );
}

const NEW = "(new)";

/** A milestone choice that can also make a new milestone ("New milestone…"), then choose it. */
export function MilestoneField({ novelId, id, value, milestones, onChange, any }: { novelId: string; id: string; value: string; milestones: Milestone[]; onChange: (v: string) => void; any?: boolean }) {
  const [naming, setNaming] = useState(false);
  return (
    <>
      <MilestoneSelect id={id} value={value} milestones={milestones} onChange={(v) => (v === NEW ? setNaming(true) : onChange(v))} any={any} canCreate />
      {naming && (
        <NewMilestone
          novelId={novelId}
          onClose={(made) => {
            setNaming(false);
            if (made) onChange(String(made.number));
          }}
        />
      )}
    </>
  );
}

/** Name a new milestone: made on GitHub (it needs GitHub). */
export function NewMilestone({ novelId, onClose }: { novelId: string; onClose: (made?: Milestone) => void }) {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  return (
    <Modal title="New milestone" onClose={() => onClose()}>
      <form
        className="grid gap-3"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!title.trim() || busy) return;
          setBusy(true);
          try {
            const made = await api.issues.createMilestone(novelId, title);
            void queryClient.invalidateQueries({ queryKey: keys.issues(novelId) });
            onClose(made);
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
            setBusy(false);
          }
        }}
      >
        <Field label="Name" placeholder="Second draft" value={title} onChange={(e) => setTitle(e.target.value)} required autoFocus />
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button onClick={() => onClose()}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={!title.trim() || busy}>
            Add milestone
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** The repository's milestones: make, rename, close and reopen them. */
export function MilestonesDialog({ novelId, milestones, onClose }: { novelId: string; milestones: Milestone[]; onClose: () => void }) {
  const queryClient = useQueryClient();
  const show = useNotice((n) => n.show);
  const [adding, setAdding] = useState(false);
  const [renaming, setRenaming] = useState<number>();
  const [name, setName] = useState("");
  const renameId = useId();
  const change = async (number: number, update: { title?: string; state?: "open" | "closed" }) => {
    try {
      await api.issues.updateMilestone(novelId, number, update);
      setRenaming(undefined);
    } catch (e) {
      show({ message: `Couldn't change the milestone: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      void queryClient.invalidateQueries({ queryKey: keys.issues(novelId) });
    }
  };
  return (
    <Modal title="Milestones" onClose={onClose}>
      {milestones.length ? (
        <ul className="grid gap-2" aria-label="Milestones">
          {[...milestones]
            .sort((a, b) => (a.state === b.state ? a.number - b.number : a.state === "open" ? -1 : 1))
            .map((m) => (
              <li key={m.number} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-rule px-3 py-2">
                {renaming === m.number ? (
                  <form
                    className="flex flex-1 items-center gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (name.trim()) void change(m.number, { title: name });
                    }}
                  >
                    <label htmlFor={renameId} className="sr-only">
                      New name for “{m.title}”
                    </label>
                    <input id={renameId} value={name} onChange={(e) => setName(e.target.value)} autoFocus className="h-8 flex-1 rounded-md border border-rule bg-raised px-2 text-sm" />
                    <Button size="sm" type="submit" variant="primary" disabled={!name.trim()}>
                      Save
                    </Button>
                    <Button size="sm" onClick={() => setRenaming(undefined)}>
                      Cancel
                    </Button>
                  </form>
                ) : (
                  <>
                    <span className={m.state === "closed" ? "text-muted line-through" : "font-medium"}>{m.title}</span>
                    <span className="flex gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Rename “${m.title}”`}
                        onClick={() => {
                          setName(m.title);
                          setRenaming(m.number);
                        }}
                      >
                        Rename
                      </Button>
                      <Button size="sm" variant="ghost" aria-label={`${m.state === "open" ? "Close" : "Reopen"} “${m.title}”`} onClick={() => void change(m.number, { state: m.state === "open" ? "closed" : "open" })}>
                        {m.state === "open" ? "Close" : "Reopen"}
                      </Button>
                    </span>
                  </>
                )}
              </li>
            ))}
        </ul>
      ) : (
        <p className="text-sm text-muted">No milestones yet: plan by drafts, say, or by what goes to your editor.</p>
      )}
      <div className="flex justify-between gap-2">
        <Button onClick={() => setAdding(true)}>New milestone…</Button>
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      </div>
      {adding && <NewMilestone novelId={novelId} onClose={() => setAdding(false)} />}
    </Modal>
  );
}

export function MilestoneSelect({ id, value, milestones, onChange, any, canCreate }: { id: string; value: string; milestones: Milestone[]; onChange: (v: string) => void; any?: boolean; canCreate?: boolean }) {
  return (
    <select id={id} value={value} onChange={(e) => onChange(e.target.value)} className="h-9 rounded-md border border-rule bg-raised px-2 text-sm">
      {any && <option value="">Any milestone</option>}
      <option value="none">No milestone</option>
      {milestones.map((m) => (
        <option key={m.number} value={String(m.number)}>
          {m.title}
          {m.state === "closed" ? " (closed)" : ""}
        </option>
      ))}
      {canCreate && <option value={NEW}>New milestone…</option>}
    </select>
  );
}

/**
 * How gh-writer's copy of the issues stands: signed out (it's what was kept), offline or rate limited
 * (changes wait), changes waiting, changes GitHub refused (with a way to drop each).
 */
export function IssuesState({ status, onRefresh, onDiscard }: { status: IssuesStatus | undefined; onRefresh: () => void; onDiscard: (id: string) => void }) {
  const github = useGitHub().data;
  const lapsed = github && (!github.signedIn || (github.missingScopes?.length ?? 0) > 0);
  const error = status?.error;
  return (
    <div className="grid gap-2 text-sm">
      {lapsed && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-warn/40 bg-warn-soft px-3 py-2">
          <span>{github.signedIn ? "gh-writer's GitHub sign-in is missing a permission." : "gh-writer isn't signed in to GitHub."} These are the issues as last seen; changes need GitHub.</span>
          <Button size="sm" variant="primary" onClick={() => useConnect.getState().show(onRefresh)}>
            Reconnect GitHub
          </Button>
        </div>
      )}
      <p role="status" className="text-muted">
        {error?.code === "RATE_LIMITED"
          ? `GitHub's request limit is reached${error.resetAt ? ` until ${when(error.resetAt)}` : ""}: changes are kept and sent then.`
          : error?.code === "OFFLINE"
            ? "GitHub can't be reached: changes are kept and sent once it can."
            : status?.refreshedAt
              ? `Up to date with GitHub as of ${when(status.refreshedAt)}.`
              : "Not fetched from GitHub yet."}
        {status && status.queued > 0 && ` ${status.queued === 1 ? "1 change" : `${status.queued} changes`} waiting to be sent.`}
      </p>
      {status?.failed.map((f) => (
        <div key={f.id} role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-danger/40 bg-danger-soft px-3 py-2">
          <span>
            GitHub refused “{f.description}”: {f.error}
          </span>
          <Button size="sm" onClick={() => onDiscard(f.id)}>
            Drop it
          </Button>
        </div>
      ))}
    </div>
  );
}
