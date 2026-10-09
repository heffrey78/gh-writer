import type { IssueLabel, IssuesStatus, Milestone } from "@gh-writer/client";
import { X } from "lucide-react";
import { useGitHub, useConnect } from "../github/connect.tsx";
import { Button } from "../ui/button.tsx";
import { Picker } from "../ui/picker.tsx";

const time = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
export const when = (iso: string) => time.format(new Date(iso));

/** A label as GitHub colours it, optionally with a button to take it off. */
export function LabelChip({ name, labels, onRemove }: { name: string; labels: IssueLabel[]; onRemove?: () => void }) {
  const color = labels.find((l) => l.name === name)?.color ?? "ededed";
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-rule bg-raised px-2 py-0.5 text-xs">
      <span className="inline-block size-2 rounded-full" style={{ background: `#${color}` }} aria-hidden />
      {name}
      {onRemove && (
        <button type="button" onClick={onRemove} aria-label={`Remove label “${name}”`} className="rounded text-muted hover:text-ink">
          <X className="size-3" aria-hidden />
        </button>
      )}
    </span>
  );
}

/** Labels chosen, as chips, with a picker to add another (an existing label, or a new one by name). */
export function LabelsField({ label, chosen, labels, onChange }: { label: string; chosen: string[]; labels: IssueLabel[]; onChange: (labels: string[]) => void }) {
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
        items={labels.filter((l) => !chosen.includes(l.name)).map((l) => ({ value: l.name, label: l.name, ...(l.description ? { keywords: [l.description] } : {}) }))}
        value={undefined}
        onChange={(v) => v && onChange([...chosen, v])}
        placeholder="Add a label…"
        create={{ noun: "label", create: (name) => name.trim() || undefined }}
      />
    </div>
  );
}

export function MilestoneSelect({ id, value, milestones, onChange, any }: { id: string; value: string; milestones: Milestone[]; onChange: (v: string) => void; any?: boolean }) {
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
