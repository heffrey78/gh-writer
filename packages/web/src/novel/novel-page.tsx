import type { SyncStatus } from "@gh-writer/client";
import type { Novel } from "@gh-writer/core";
import { useWritingModes } from "@gh-writer/editor/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Link, Navigate, Route, Routes, useParams } from "react-router";
import { api, keys } from "../api.ts";
import { Shell } from "../layout.tsx";
import { ErrorAlert } from "../ui/alert.tsx";
import { SaveConflicts, SyncConflicts } from "./conflicts.tsx";
import { useNovelEvents } from "./events.ts";
import { Navigation } from "./navigation.tsx";
import { SaveStatus } from "./save-status.tsx";
import { useSpell } from "./spell.ts";
import { SyncBadge } from "./sync-badge.tsx";
import { createWorkspace, type Workspace } from "./workspace.ts";
import { WritingView } from "./writing-view.tsx";

/** A novel's workspace: the manuscript on the left, the editor on the right, save and sync state on top. */
export function NovelPage() {
  const { novelId = "" } = useParams();
  const queryClient = useQueryClient();
  const novel = useQuery({ queryKey: keys.novel(novelId), queryFn: () => api.novel<Novel>(novelId) });
  const sync = useQuery({ queryKey: keys.sync(novelId), queryFn: () => api.sync(novelId) });
  const [workspace, setWorkspace] = useState<Workspace>();
  const [resolving, setResolving] = useState(false);
  const focus = useWritingModes((m) => m.focus);
  const spell = useSpell(api, novelId, novel.data?.novel);

  useEffect(() => {
    const ws = createWorkspace({ api, novelId });
    const detach = ws.autosave.attach(window);
    setWorkspace(ws);
    return () => {
      detach();
      ws.dispose();
    };
  }, [novelId]);

  // Changes to files that aren't open (new scenes, order files, the bible) reload the model, once things settle.
  const reload = useRef<ReturnType<typeof setTimeout>>(undefined);
  const connected = useNovelEvents(novelId, {
    file: (e) => {
      void workspace?.fileChanged(e).then((open) => {
        if (open && e.type === "change") return;
        clearTimeout(reload.current);
        reload.current = setTimeout(() => void queryClient.invalidateQueries({ queryKey: keys.novel(novelId) }), 300);
      });
    },
    sync: (status) => queryClient.setQueryData(keys.sync(novelId), status),
  });

  const syncNow = useMutation({
    mutationFn: async () => {
      await workspace?.autosave.flush();
      return api.syncNow(novelId);
    },
    onSuccess: (status: SyncStatus) => queryClient.setQueryData(keys.sync(novelId), status),
  });

  const actions = workspace && (
    <>
      <SaveStatus autosave={workspace.autosave} />
      <SyncBadge status={sync.data} onSyncNow={() => syncNow.mutate()} syncing={syncNow.isPending} onResolve={() => setResolving(true)} />
    </>
  );

  if (novel.isError) {
    return (
      <Shell>
        <h1 className="text-2xl font-semibold">Couldn't open this novel</h1>
        <ErrorAlert title={novel.error.message} className="mt-4">
          <Link to="/" className="text-accent underline">
            Back to your novels
          </Link>
        </ErrorAlert>
      </Shell>
    );
  }
  if (novel.isPending || !workspace) {
    return (
      <Shell>
        <h1 className="text-2xl font-semibold text-muted" aria-busy="true">
          Opening…
        </h1>
      </Shell>
    );
  }

  const model = novel.data.novel;
  return (
    <Shell wide actions={actions} chrome={!focus} title={model.config?.title ?? "Untitled"}>
      {!connected && (
        <p role="alert" className="border-b border-warn/40 bg-warn-soft px-4 py-2 text-sm">
          gh-writer isn't answering. Your unsaved text is kept in this tab; start gh-writer again and it will be saved.
        </p>
      )}
      <div className={focus ? "h-full" : "grid h-full md:grid-cols-[16rem_minmax(0,1fr)]"}>
        {!focus && (
          <aside className="border-rule bg-panel p-3 md:overflow-y-auto md:border-r">
            <p className="mb-3 px-2 font-semibold">{model.config?.title ?? "Untitled"}</p>
            <Navigation novelId={novelId} novel={model} />
          </aside>
        )}
        <div className="md:overflow-y-auto">
          <Routes>
            <Route index element={model.chapters[0] ? <Navigate to={`/novels/${novelId}/chapter/${model.chapters[0].id}`} replace /> : <EmptyManuscript />} />
            <Route path="chapter/:chapterId" element={<ChapterRoute novelId={novelId} novel={model} workspace={workspace} spell={spell} />} />
            <Route path="scene/:sceneId" element={<SceneRoute novelId={novelId} novel={model} workspace={workspace} spell={spell} />} />
            <Route path="*" element={<Missing what="page" />} />
          </Routes>
        </div>
      </div>
      <SyncConflicts novelId={novelId} novel={model} workspace={workspace} open={resolving} onClose={() => setResolving(false)} />
      <SaveConflicts novel={model} workspace={workspace} />
    </Shell>
  );
}

type RouteProps = { novelId: string; novel: Novel; workspace: Workspace; spell: ReturnType<typeof useSpell> };

function ChapterRoute(props: RouteProps) {
  const { chapterId } = useParams();
  const chapter = props.novel.chapters.find((c) => c.id === chapterId) ?? props.novel.allChapters.find((c) => c.id === chapterId);
  return chapter ? <WritingView {...props} view={{ chapter }} /> : <Missing what="chapter" />;
}

function SceneRoute(props: RouteProps) {
  const { sceneId } = useParams();
  const scene = props.novel.allScenes.find((s) => s.id === sceneId);
  const chapter = props.novel.allChapters.find((c) => c.id === scene?.chapterId);
  return scene ? <WritingView {...props} view={{ scene, chapter }} /> : <Missing what="scene" />;
}

function Missing({ what }: { what: string }) {
  return (
    <div className="p-8">
      <h1 className="text-xl font-semibold">No such {what}</h1>
      <p className="mt-2 text-muted">It may have been moved or deleted. Choose another from the manuscript.</p>
    </div>
  );
}

function EmptyManuscript() {
  return (
    <div className="p-8">
      <h1 className="text-xl font-semibold">No chapters yet</h1>
      <p className="mt-2 text-muted">This novel's manuscript is empty.</p>
    </div>
  );
}
