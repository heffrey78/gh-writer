import type { Editor } from "@tiptap/core";
import { ExternalLink, X } from "lucide-react";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Link } from "react-router";
import { create } from "zustand";
import { Button } from "../ui/button.tsx";
import { cn } from "../ui/cn.ts";
import { Markdown } from "./markdown.tsx";
import { LabelChip, when } from "./parts.tsx";
import { useIssue, useIssueChanges, useIssueMeta } from "./use-issues.ts";

/** The issues opened from a marker beside the text, and the editor to go back to. */
export const useIssuePanel = create<{ numbers: number[]; editor: Editor | undefined; open: (numbers: number[], editor: Editor) => void; close: () => void }>((set, get) => ({
  numbers: [],
  editor: undefined,
  open: (numbers, editor) => set({ numbers, editor }),
  close: () => {
    const editor = get().editor;
    set({ numbers: [], editor: undefined });
    if (editor && !editor.isDestroyed) editor.commands.focus(null, { scrollIntoView: false });
  },
}));

/** Issues about a passage, beside the text: read, comment, close; closing the panel returns to the text. */
export function IssuePanel({ novelId }: { novelId: string }) {
  const { numbers, close } = useIssuePanel();
  if (!numbers.length) return null;
  return <Panel key={numbers.join(",")} novelId={novelId} numbers={numbers} close={close} />;
}

function Panel({ novelId, numbers, close }: { novelId: string; numbers: number[]; close: () => void }) {
  const [chosen, setChosen] = useState(numbers[0]!);
  const ref = useRef<HTMLElement>(null);
  const headingId = useId();
  useEffect(() => ref.current?.focus(), []);
  return (
    <aside
      ref={ref}
      tabIndex={-1}
      aria-labelledby={headingId}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !e.defaultPrevented) {
          e.preventDefault();
          close();
        }
      }}
      className="relative grid content-start gap-3 border-rule bg-panel p-4 text-sm outline-none lg:overflow-y-auto lg:border-l"
    >
      <Button size="sm" variant="ghost" onClick={close} className="justify-self-end">
        <X className="size-4" aria-hidden /> Back to the text
      </Button>
      {numbers.length > 1 && (
        <nav aria-label="Issues about this paragraph" className="flex flex-wrap gap-1.5">
          {numbers.map((n) => (
            <button key={n} type="button" aria-current={n === chosen} onClick={() => setChosen(n)} className={cn("rounded-full border border-rule px-2.5 py-0.5", n === chosen ? "bg-accent-soft font-medium" : "bg-raised")}>
              {n > 0 ? `#${n}` : "New"}
            </button>
          ))}
        </nav>
      )}
      <Brief key={chosen} novelId={novelId} number={chosen} headingId={headingId} />
    </aside>
  );
}

function Brief({ novelId, number, headingId }: { novelId: string; number: number; headingId: string }) {
  const issue = useIssue(novelId, number).data;
  const labels = useIssueMeta(novelId)?.labels ?? [];
  const changes = useIssueChanges(novelId);
  const [comment, setComment] = useState("");
  const commentId = useId();
  const box = useRef<HTMLTextAreaElement>(null);
  if (!issue) return <p id={headingId}>Loading the issue…</p>;
  const send = async () => {
    if (!comment.trim() || changes.busy || !(await changes.comment(issue.number, comment))) return;
    setComment("");
    // The Comment button disables itself when the box empties: keep the focus in the panel.
    box.current?.focus();
  };
  return (
    <div className="grid gap-3">
      <h2 id={headingId} className="text-base font-semibold">
        {issue.title} <span className="font-normal text-muted">{issue.number > 0 ? `#${issue.number}` : ""}</span>
      </h2>
      <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
        <span>{issue.state === "open" ? "Open" : "Closed"}</span>
        {issue.labels.map((l) => (
          <LabelChip key={l} name={l} labels={labels} />
        ))}
        {issue.pending && <span className="text-warn">not on GitHub yet</span>}
      </p>
      {issue.body.trim() && <Markdown text={issue.body} />}
      {issue.comments.length > 0 && (
        <ol aria-label="Comments" className="grid gap-2">
          {issue.comments.map((c) => (
            <li key={c.id} className="rounded-md border border-rule bg-raised p-2">
              <p className="text-xs text-muted">
                {c.author || "You"} · {when(c.createdAt)}
              </p>
              <Markdown text={c.body} />
            </li>
          ))}
        </ol>
      )}
      <label htmlFor={commentId} className="font-medium">
        Add a comment
      </label>
      <textarea
        ref={box}
        id={commentId}
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        onKeyDown={(e: KeyboardEvent) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void send();
          }
        }}
        rows={3}
        className="rounded-md border border-rule bg-raised px-2 py-1.5"
        placeholder="Ctrl+Enter to send"
      />
      <div className="flex flex-wrap justify-end gap-2">
        <Button size="sm" onClick={() => void changes.update(issue.number, { state: issue.state === "open" ? "closed" : "open" })}>
          {issue.state === "open" ? "Close issue" : "Reopen issue"}
        </Button>
        {/* Not disabled while sending: a focused button that disables itself drops the focus out of the panel. */}
        <Button size="sm" variant="primary" disabled={!comment.trim()} aria-busy={changes.busy} onClick={() => void send()}>
          Comment
        </Button>
      </div>
      <p className="flex flex-wrap gap-3">
        <Link to={`/novels/${novelId}/issues/${issue.number}`} className="text-accent underline">
          Open in Issues
        </Link>
        {issue.url && (
          <a href={issue.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent underline">
            <ExternalLink className="size-3.5" aria-hidden /> On GitHub
          </a>
        )}
      </p>
    </div>
  );
}
