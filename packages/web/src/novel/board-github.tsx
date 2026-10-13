import { type BoardConflict, type BoardStatus, type SceneStatusName } from "@gh-writer/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import { api, keys } from "../api.ts";
import { GitHubMark, useConnect, useGitHub } from "../github/connect.tsx";
import { useGitHubRepo } from "../github/repo.ts";
import { when } from "../issues/parts.tsx";
import { ErrorAlert } from "../ui/alert.tsx";
import { Button } from "../ui/button.tsx";

/*
 * The drafting board on GitHub (#11, D8), above the board in the app: putting it there, how it
 * stands (when it last synced, what that did), and the scenes whose status differs between the
 * file and GitHub, each settled by the author. Shown only for a novel on GitHub.
 */

const LABEL: Record<SceneStatusName, string> = { idea: "Idea", outlined: "Outlined", drafted: "Drafted", revised: "Revised", final: "Final" };

/** The board's status on GitHub, for a novel on GitHub; undefined otherwise or while it loads. */
export function useBoardStatus(novelId: string) {
  const repo = useGitHubRepo(novelId);
  return useQuery({ queryKey: keys.board(novelId), queryFn: () => api.board.status(novelId), enabled: !!repo }).data;
}

export function BoardOnGitHub({ novelId }: { novelId: string }) {
  const repo = useGitHubRepo(novelId);
  const github = useGitHub().data;
  const status = useBoardStatus(novelId);
  const queryClient = useQueryClient();
  const keep = (next: BoardStatus) => queryClient.setQueryData(keys.board(novelId), next);
  const setUp = useMutation({ mutationFn: () => api.board.setUp(novelId), onSuccess: keep });
  const sync = useMutation({ mutationFn: () => api.board.sync(novelId), onSuccess: keep });
  const resolve = useMutation({ mutationFn: ({ scene, side }: { scene: string; side: "file" | "board" }) => api.board.resolve(novelId, scene, side), onSuccess: keep });
  // Opened without a board here: one sync looks for a board another computer made (the server asks GitHub once a session).
  const looked = useRef(false);
  const signedIn = !!github?.signedIn;
  useEffect(() => {
    if (looked.current || !signedIn || !status || status.project || status.gone) return;
    looked.current = true;
    sync.mutate();
  }, [signedIn, status, sync]);

  if (!repo) return null;
  const reconnect = (label: string, then: () => void) => (
    <Button size="sm" variant="primary" onClick={() => useConnect.getState().show(then)}>
      {label}
    </Button>
  );
  const refresh = () => void queryClient.invalidateQueries({ queryKey: keys.board(novelId) });

  let body;
  if (!github || !status) body = <p className="text-muted">Opening…</p>;
  else if (!github.signedIn) {
    body = (
      <Row text="Connect gh-writer to GitHub to put this board on GitHub, for its board, table and roadmap views.">{reconnect("Connect GitHub", refresh)}</Row>
    );
  } else if (github.missingBoardScopes?.length && !status.project) {
    body = <Row text="gh-writer's GitHub sign-in doesn't allow it to use Projects yet. Reconnect to grant it, then put the board on GitHub.">{reconnect("Reconnect GitHub", refresh)}</Row>;
  } else if (!status.project) {
    body = (
      <Row
        text={
          status.gone
            ? "The board on GitHub has been deleted. Nothing in the novel was lost: make a new one to carry on."
            : "Put this board on GitHub as a project: every scene a card, with its status, POV, part, chapter and words, in GitHub's board, table and roadmap views. Move a card there and the scene follows here."
        }
      >
        <Button size="sm" variant="primary" disabled={setUp.isPending} onClick={() => setUp.mutate()}>
          {setUp.isPending ? "Putting it on GitHub…" : status.gone ? "Make a new board on GitHub" : "Put this board on GitHub"}
        </Button>
      </Row>
    );
  } else {
    body = (
      <>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p>
            On GitHub as{" "}
            <a href={status.project.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-medium text-accent underline-offset-2 hover:underline">
              {status.project.title}
              <ExternalLink className="size-3.5" aria-hidden />
              <span className="sr-only">(opens GitHub)</span>
            </a>
            . <span className="text-muted">{status.syncedAt ? `Synced ${when(status.syncedAt)}.` : "Not synced yet."}</span>
          </p>
          <Button size="sm" disabled={sync.isPending} onClick={() => sync.mutate()}>
            {sync.isPending ? "Syncing…" : "Sync board now"}
          </Button>
        </div>
        <Summary status={status} />
        {github.missingBoardScopes?.length ? (
          <Row text="gh-writer's GitHub sign-in no longer allows it to use Projects, so the board can't be kept up to date.">{reconnect("Reconnect GitHub", () => sync.mutate())}</Row>
        ) : null}
        <Problem status={status} />
        {status.conflicts.length > 0 && (
          <div role="alert" className="grid gap-2 rounded-md border border-warn/40 bg-warn-soft px-3 py-2">
            <p className="font-medium">
              {status.conflicts.length === 1 ? "A scene's status was changed both here and on GitHub." : `${status.conflicts.length} scenes' statuses were changed both here and on GitHub.`} Neither has been
              overwritten: choose which to keep.
            </p>
            <ul className="grid gap-1.5">
              {status.conflicts.map((c) => (
                <ConflictRow key={c.scene} conflict={c} busy={resolve.isPending} onKeep={(side) => resolve.mutate({ scene: c.scene, side })} />
              ))}
            </ul>
          </div>
        )}
      </>
    );
  }

  const failure = setUp.error ?? sync.error ?? resolve.error;
  return (
    <section aria-labelledby="board-github" className="grid gap-2 rounded-md border border-rule bg-raised px-3 py-2.5 text-sm">
      <h2 id="board-github" className="flex items-center gap-1.5 font-semibold">
        <GitHubMark className="size-4" />
        Board on GitHub
      </h2>
      {body}
      {failure && <ErrorAlert title={setUp.error ? "The board couldn't be put on GitHub." : "The board couldn't be synced."}>{failure instanceof Error ? failure.message : String(failure)}</ErrorAlert>}
    </section>
  );
}

function Row({ text, children }: { text: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="max-w-prose">{text}</p>
      {children}
    </div>
  );
}

function ConflictRow({ conflict, busy, onKeep }: { conflict: BoardConflict; busy: boolean; onKeep: (side: "file" | "board") => void }) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-2">
      <span>
        “{conflict.title}” is <strong>{LABEL[conflict.file]}</strong> here and <strong>{LABEL[conflict.board]}</strong> on GitHub.
      </span>
      <span className="flex gap-2">
        <Button size="sm" disabled={busy} onClick={() => onKeep("file")} aria-label={`Keep ${LABEL[conflict.file]} for “${conflict.title}”`}>
          Keep {LABEL[conflict.file]}
        </Button>
        <Button size="sm" disabled={busy} onClick={() => onKeep("board")} aria-label={`Use GitHub's ${LABEL[conflict.board]} for “${conflict.title}”`}>
          Use GitHub's: {LABEL[conflict.board]}
        </Button>
      </span>
    </li>
  );
}

/** What the last sync brought from GitHub, and what it put back. */
function Summary({ status }: { status: BoardStatus }) {
  const last = status.last;
  if (!last || (!last.fromBoard.length && !last.putBack.length)) return null;
  return (
    <div role="status" className="grid gap-0.5 text-muted">
      {last.fromBoard.length > 0 && <p>From GitHub: {last.fromBoard.map((m) => `“${m.title}” to ${LABEL[m.status]}`).join(", ")}.</p>}
      {last.putBack.length > 0 && (
        <p>
          Put back from the novel (these come from its files): {last.putBack.map((p) => `“${p.title}” ${p.fields.join(" and ")}`).join("; ")}.
        </p>
      )}
    </div>
  );
}

/** Why the board isn't up to date, when it isn't. */
function Problem({ status }: { status: BoardStatus }) {
  const error = status.error;
  if (!error || error.code === "NOT_SET_UP" || error.code === "NEEDS_SCOPE") return null;
  const message =
    error.code === "RATE_LIMITED"
      ? `GitHub's request limit is reached${error.resetAt ? ` until ${when(error.resetAt)}` : ""}: the board catches up then.`
      : error.code === "OFFLINE"
        ? "GitHub can't be reached: the board catches up once it can."
        : error.message;
  return <p className="text-warn">{message}</p>;
}

/** A card's note when its status differs on GitHub. */
export function ConflictNote({ conflict }: { conflict: BoardConflict | undefined }) {
  if (!conflict) return null;
  return <p className="text-xs font-medium text-warn">{LABEL[conflict.board]} on GitHub: choose above</p>;
}
