import type { Novel } from "@gh-writer/core";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ExternalLink } from "lucide-react";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Link, useNavigate } from "react-router";
import { api, keys } from "../api.ts";
import { useNotice } from "../novel/notice.tsx";
import { Button } from "../ui/button.tsx";
import { Field } from "../ui/field.tsx";
import { Markdown } from "./markdown.tsx";
import { ensureKind, IssuesState, kindIn, KindSelect, LabelsField, MilestoneField, pickableLabels, when, withKind } from "./parts.tsx";
import type { Workspace } from "../novel/workspace.ts";
import { passageOf } from "./anchors.ts";
import { PassageLine } from "./issues-page.tsx";
import { useIssue, useIssueChanges, useIssueMeta } from "./use-issues.ts";

/** One issue: its description and comments, and everything that can be changed about it. */
export function IssuePage({ novelId, novel, workspace, number }: { novelId: string; novel: Novel; workspace: Workspace; number: number }) {
  const issue = useIssue(novelId, number);
  const meta = useIssueMeta(novelId);
  const changes = useIssueChanges(novelId);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const show = useNotice((n) => n.show);
  const [editing, setEditing] = useState(false);
  const [comment, setComment] = useState("");
  const commentBox = useRef<HTMLTextAreaElement>(null);
  const ids = { comment: useId(), milestone: useId(), body: useId(), kind: useId() };
  const back = `/novels/${novelId}/issues`;

  // Made offline and since sent: its address becomes its number on GitHub.
  const data = issue.data;
  useEffect(() => {
    if (data && data.number !== number) void navigate(`${back}/${data.number}`, { replace: true });
  }, [data?.number, number]); // eslint-disable-line react-hooks/exhaustive-deps

  const refresh = () => void api.issues.refresh(novelId).finally(() => void queryClient.invalidateQueries({ queryKey: keys.issues(novelId) }));
  const discard = (id: string) => void api.issues.discard(novelId, id).finally(() => void queryClient.invalidateQueries({ queryKey: keys.issues(novelId) }));

  if (issue.isError) {
    return (
      <div className="mx-auto grid w-full max-w-3xl gap-3 px-6 py-6">
        <h1 className="text-xl font-semibold">No such issue</h1>
        <Link to={back} className="text-accent underline">
          All issues
        </Link>
      </div>
    );
  }
  if (!data) return <p className="px-6 py-6 text-muted">Loading the issue…</p>;

  const labels = pickableLabels(meta);
  const kind = kindIn(data.labels);
  const submitComment = async () => {
    if (!comment.trim()) return;
    if (await changes.comment(data.number, comment)) {
      setComment("");
      // The Comment button disables itself when the box empties: keep the focus here.
      commentBox.current?.focus();
      show({ message: data.number > 0 ? `Commented on #${data.number}.` : "Comment kept; it's sent with the issue." });
    }
  };

  return (
    <div className="mx-auto grid w-full max-w-5xl gap-6 px-6 py-6 lg:grid-cols-[minmax(0,1fr)_16rem]">
      <article className="grid content-start gap-4" aria-labelledby="issue-title">
        <Link to={back} className="inline-flex items-center gap-1 text-sm text-muted hover:text-ink">
          <ArrowLeft className="size-4" aria-hidden /> All issues
        </Link>
        <IssuesState status={meta?.status} onRefresh={refresh} onDiscard={discard} />
        {editing ? (
          <EditIssue
            title={data.title}
            body={data.body}
            onCancel={() => setEditing(false)}
            onSave={async (title, body) => {
              if (await changes.update(data.number, { title, body })) setEditing(false);
            }}
          />
        ) : (
          <>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <h1 id="issue-title" className="text-xl font-semibold">
                {data.title} <span className="font-normal text-muted">{data.number > 0 ? `#${data.number}` : ""}</span>
              </h1>
              <Button size="sm" onClick={() => setEditing(true)}>
                Edit
              </Button>
            </div>
            <p className="flex flex-wrap items-center gap-2 text-sm text-muted">
              <span className={data.state === "open" ? "rounded-full bg-ok/15 px-2 py-0.5 font-medium text-ok" : "rounded-full bg-panel px-2 py-0.5 font-medium"}>{data.state === "open" ? "Open" : "Closed"}</span>
              <span>
                {data.author ? `${data.author} opened it` : "Opened"} {when(data.createdAt)}
              </span>
              {data.pending && <span className="text-warn">Changes not on GitHub yet</span>}
            </p>
            <PassageLine novelId={novelId} passage={passageOf(data, novel, (f) => workspace.current(f))} />
            {data.body.trim() ? <Markdown text={data.body} className="rounded-lg border border-rule bg-raised p-4" /> : <p className="text-muted">No description.</p>}
          </>
        )}

        <section aria-labelledby="comments-heading" className="grid gap-3">
          <h2 id="comments-heading" className="font-semibold">
            Comments
          </h2>
          {data.comments.length ? (
            <ol className="grid gap-3">
              {data.comments.map((c) => (
                <li key={c.id} className="rounded-lg border border-rule bg-raised">
                  <p className="border-b border-rule px-4 py-2 text-xs text-muted">
                    {c.author || "You"} · {when(c.createdAt)}
                    {c.pending && <span className="text-warn"> · not on GitHub yet</span>}
                  </p>
                  <Markdown text={c.body} className="px-4 py-3" />
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-sm text-muted">No comments yet.</p>
          )}
          <form
            className="grid gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void submitComment();
            }}
          >
            <label htmlFor={ids.comment} className="text-sm font-medium">
              Add a comment
            </label>
            <textarea
              ref={commentBox}
              id={ids.comment}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              onKeyDown={(e: KeyboardEvent) => {
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  void submitComment();
                }
              }}
              rows={4}
              placeholder="Markdown, as on GitHub (Ctrl+Enter to send)"
              className="rounded-md border border-rule bg-raised px-3 py-2 text-sm"
            />
            <div className="flex justify-end gap-2">
              <Button onClick={() => void changes.update(data.number, { state: data.state === "open" ? "closed" : "open" })}>{data.state === "open" ? "Close issue" : "Reopen issue"}</Button>
              <Button type="submit" variant="primary" disabled={!comment.trim() || changes.busy}>
                Comment
              </Button>
            </div>
          </form>
        </section>
      </article>

      <aside aria-label="About this issue" className="grid content-start gap-4 text-sm">
        <div className="grid gap-1.5">
          <label htmlFor={ids.kind} className="font-medium">
            Kind
          </label>
          <KindSelect
            id={ids.kind}
            value={kind}
            onChange={async (k) => {
              if (k) await ensureKind(novelId, k);
              void changes.update(data.number, { labels: withKind(data.labels, k) });
            }}
          />
        </div>
        <LabelsField
          label="Labels"
          chosen={data.labels.filter((l) => !l.startsWith("kind/"))}
          labels={labels}
          onChange={(next) => void changes.update(data.number, { labels: withKind(next, kind) })}
        />
        <div className="grid gap-1.5">
          <label htmlFor={ids.milestone} className="font-medium">
            Milestone
          </label>
          <MilestoneField
            novelId={novelId}
            id={ids.milestone}
            value={data.milestone === null ? "none" : String(data.milestone)}
            milestones={meta?.milestones ?? []}
            onChange={(v) => void changes.update(data.number, { milestone: v === "none" ? null : Number(v) })}
          />
        </div>
        {data.url && (
          <a href={data.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent underline">
            <ExternalLink className="size-4" aria-hidden /> Open on GitHub
          </a>
        )}
      </aside>
    </div>
  );
}

function EditIssue({ title: initialTitle, body: initialBody, onSave, onCancel }: { title: string; body: string; onSave: (title: string, body: string) => void; onCancel: () => void }) {
  const [title, setTitle] = useState(initialTitle);
  const [body, setBody] = useState(initialBody);
  const bodyId = useId();
  return (
    <form
      className="grid gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (title.trim()) onSave(title, body);
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") onCancel();
      }}
    >
      <Field label="Title" value={title} onChange={(e) => setTitle(e.target.value)} required autoFocus />
      <div className="grid gap-1.5">
        <label htmlFor={bodyId} className="text-sm font-medium">
          Description
        </label>
        <textarea id={bodyId} value={body} onChange={(e) => setBody(e.target.value)} rows={8} className="rounded-md border border-rule bg-raised px-3 py-2 text-sm" />
      </div>
      <div className="flex justify-end gap-2">
        <Button onClick={onCancel}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={!title.trim()}>
          Save
        </Button>
      </div>
    </form>
  );
}
