import type { SyncStatus } from "@gh-writer/client";
import type { Novel } from "@gh-writer/core";
import { useWritingModes } from "@gh-writer/editor/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Link, Navigate, NavLink, Route, Routes, useLocation, useNavigate, useParams } from "react-router";
import { api, keys } from "../api.ts";
import { useCommands, type Command } from "../commands.ts";
import { Shell } from "../layout.tsx";
import { ErrorAlert } from "../ui/alert.tsx";
import { ErrorBoundary } from "../ui/error-boundary.tsx";
import { BiblePage } from "../bible/bible-page.tsx";
import { EntryPage } from "../bible/entry-page.tsx";
import { NewEntryDialog } from "../bible/new-entry.tsx";
import { plural } from "../bible/types.ts";
import { CheckpointsButton } from "./checkpoints.tsx";
import { SaveConflicts, SyncConflicts } from "./conflicts.tsx";
import { useNovelEvents } from "./events.ts";
import { ManuscriptSidebar } from "./manuscript-tree.tsx";
import { chapterTitle } from "./navigation.tsx";
import { NoticeBar } from "./notice.tsx";
import { CorkboardPage } from "./corkboard.tsx";
import { OutlinePage } from "./outline.tsx";
import { SwimlanesPage } from "../swimlanes/swimlanes-page.tsx";
import { PresencePage } from "../presence/presence-page.tsx";
import { TimelinePage } from "../timeline/timeline-page.tsx";
import { SaveStatus } from "./save-status.tsx";
import { useSpell } from "./spell.ts";
import { usePublish } from "../github/publish.tsx";
import { SyncBadge } from "./sync-badge.tsx";
import { createWorkspace, type Workspace } from "./workspace.ts";
import { WritingView } from "./writing-view.tsx";

// React Flow comes with the graph, loaded when it's first opened.
const GraphPage = lazy(() => import("../graph/graph-page.tsx").then((m) => ({ default: m.GraphPage })));

/** A novel's workspace: the manuscript on the left, the editor on the right, save and sync state on top. */
export function NovelPage() {
  const { novelId = "" } = useParams();
  // The open chapter or scene, for the tree.
  const { pathname } = useLocation();
  const current = /\/(chapter|scene)\/([^/]+)$/.exec(pathname)?.[2];
  const queryClient = useQueryClient();
  const novel = useQuery({ queryKey: keys.novel(novelId), queryFn: () => api.novel<Novel>(novelId) });
  const sync = useQuery({ queryKey: keys.sync(novelId), queryFn: () => api.sync(novelId) });
  const library = useQuery({ queryKey: keys.library, queryFn: api.library, staleTime: 30_000 });
  const folder = library.data?.novels.find((n) => n.id === novelId)?.path;
  const [workspace, setWorkspace] = useState<Workspace>();
  const [resolving, setResolving] = useState(false);
  const [checkpointsOpen, setCheckpointsOpen] = useState(false);
  const [newEntry, setNewEntry] = useState<string | null>(null);
  const focus = useWritingModes((m) => m.focus);
  const spell = useSpell(api, novelId, novel.data?.novel);

  useEffect(() => {
    const ws = createWorkspace({ api, novelId, onFrontMatterSaved: () => void queryClient.invalidateQueries({ queryKey: keys.novel(novelId) }) });
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

  const navigate = useNavigate();
  const model = novel.data?.novel;
  const conflict = sync.data?.state === "conflict";
  useCommands(
    (): Command[] => [
      { id: "novel.syncNow", title: "Sync now", group: "Sync", run: () => syncNow.mutate() },
      ...(conflict ? [{ id: "novel.resolve", title: "Resolve sync conflicts", group: "Sync", run: () => setResolving(true) }] : []),
      { id: "novel.checkpoints", title: "Checkpoints: make or restore one", group: "Checkpoints", run: () => setCheckpointsOpen(true) },
      { id: "novel.bible", title: "Story bible", group: "Go to", run: () => void navigate(`/novels/${novelId}/bible`) },
      { id: "novel.outline", title: "Outline", group: "Go to", run: () => void navigate(`/novels/${novelId}/outline`) },
      { id: "novel.corkboard", title: "Corkboard", group: "Go to", run: () => void navigate(`/novels/${novelId}/corkboard`) },
      { id: "novel.timeline", title: "Timeline", group: "Go to", keywords: ["chronology", "story time", "flashback", "diagram"], run: () => void navigate(`/novels/${novelId}/timeline`) },
      { id: "novel.presence", title: "Presence matrix", group: "Go to", keywords: ["diagram", "characters", "themes", "locations"], run: () => void navigate(`/novels/${novelId}/presence`) },
      { id: "novel.swimlanes", title: "Plotline swimlanes", group: "Go to", keywords: ["diagram", "plotlines"], run: () => void navigate(`/novels/${novelId}/swimlanes`) },
      { id: "novel.graph", title: "Relationship graph", group: "Go to", keywords: ["diagram", "characters"], run: () => void navigate(`/novels/${novelId}/graph`) },
      ...(model?.entityTypes ?? []).map((t) => ({ id: `novel.newEntry.${t.key}`, title: `New ${t.label.toLowerCase()}`, group: "Story bible", run: () => setNewEntry(t.key) })),
      ...(model?.entities ?? []).map((e) => ({
        id: `novel.entry.${e.id}`,
        title: `${model!.entityTypes.find((t) => t.key === e.type)?.label ?? e.type}: ${e.name}`,
        group: "Go to",
        keywords: e.aliases,
        run: () => void navigate(`/novels/${novelId}/bible/${e.id}`),
      })),
      ...(model?.chapters ?? []).flatMap((c): Command[] => [
        { id: `novel.chapter.${c.id}`, title: `Chapter: ${chapterTitle(model!, c)}`, group: "Go to", run: () => void navigate(`/novels/${novelId}/chapter/${c.id}`) },
        ...c.sceneIds.flatMap((id): Command[] => {
          const s = model!.allScenes.find((x) => x.id === id);
          return s
            ? [{ id: `novel.scene.${s.id}`, title: `Scene: ${s.title}`, group: "Go to", keywords: [chapterTitle(model!, c)], run: () => void navigate(`/novels/${novelId}/scene/${s.id}`) }]
            : [];
        }),
      ]),
    ],
    [model, conflict, novelId, navigate],
  );

  const actions = workspace && (
    <>
      <SaveStatus autosave={workspace.autosave} />
      <CheckpointsButton novelId={novelId} workspace={workspace} open={checkpointsOpen} onOpenChange={setCheckpointsOpen} />
      <SyncBadge
        status={sync.data}
        onSyncNow={() => syncNow.mutate()}
        syncing={syncNow.isPending}
        onResolve={() => setResolving(true)}
        {...(folder ? { onPublish: () => usePublish.getState().show({ id: novelId, folder }) } : {})}
      />
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

  const book = novel.data.novel;
  return (
    <Shell wide actions={actions} chrome={!focus} title={book.config?.title ?? "Untitled"}>
      {!connected && (
        <p role="alert" className="border-b border-warn/40 bg-warn-soft px-4 py-2 text-sm">
          gh-writer isn't answering. Your unsaved text is kept in this tab; start gh-writer again and it will be saved.
        </p>
      )}
      <div className={focus ? "h-full" : "grid h-full md:grid-cols-[16rem_minmax(0,1fr)]"}>
        {!focus && (
          <aside className="border-rule bg-panel p-3 md:overflow-y-auto md:border-r">
            <p className="mb-3 px-2 font-semibold">{book.config?.title ?? "Untitled"}</p>
            <nav aria-label="Views" className="mb-3 flex flex-wrap gap-1 text-sm">
              {[
                ["outline", "Outline"],
                ["corkboard", "Corkboard"],
                ["swimlanes", "Plotlines"],
                ["presence", "Presence"],
                ["timeline", "Timeline"],
                ["graph", "Graph"],
              ].map(([path, label]) => (
                <NavLink key={path} to={`/novels/${novelId}/${path}`} className={({ isActive }) => `rounded-md px-2 py-1 hover:bg-paper ${isActive ? "bg-accent-soft font-medium" : ""}`}>
                  {label}
                </NavLink>
              ))}
            </nav>
            <ManuscriptSidebar novelId={novelId} novel={book} workspace={workspace} current={current} />
            <nav aria-label="Story bible" className="mt-2 border-t border-rule pt-3 text-sm">
              <NavLink to={`/novels/${novelId}/bible`} end className={({ isActive }) => `block rounded-md px-2 py-1 font-semibold hover:bg-paper ${isActive ? "bg-accent-soft" : ""}`}>
                Story bible
              </NavLink>
              <ul className="mt-1 grid gap-0.5">
                {book.entityTypes.map((t) => (
                  <li key={t.key} className="flex justify-between px-2 py-0.5 text-muted">
                    <span>{plural(t.label)}</span>
                    <span className="tabular-nums">{book.entities.filter((e) => e.type === t.key).length}</span>
                  </li>
                ))}
              </ul>
            </nav>
          </aside>
        )}
        <div className="md:overflow-y-auto">
          <ErrorBoundary what="this view" remount>
            <Routes>
              <Route index element={book.chapters[0] ? <Navigate to={`/novels/${novelId}/chapter/${book.chapters[0].id}`} replace /> : <EmptyManuscript />} />
              <Route path="chapter/:chapterId" element={<ChapterRoute novelId={novelId} novel={book} workspace={workspace} spell={spell} />} />
              <Route path="scene/:sceneId" element={<SceneRoute novelId={novelId} novel={book} workspace={workspace} spell={spell} />} />
              <Route
                path="graph"
                element={
                  <Suspense fallback={<p className="px-6 py-6 text-muted">Opening the graph…</p>}>
                    <GraphPage novelId={novelId} novel={book} />
                  </Suspense>
                }
              />
              <Route path="timeline" element={<TimelinePage novelId={novelId} novel={book} />} />
              <Route path="presence" element={<PresencePage novelId={novelId} novel={book} workspace={workspace} />} />
              <Route path="swimlanes" element={<SwimlanesPage novelId={novelId} novel={book} workspace={workspace} />} />
              <Route path="corkboard" element={<CorkboardPage novelId={novelId} novel={book} workspace={workspace} />} />
              <Route path="outline" element={<OutlinePage novelId={novelId} novel={book} workspace={workspace} />} />
              <Route path="bible" element={<BiblePage novelId={novelId} novel={book} />} />
              <Route path="bible/:entityId" element={<EntryRoute novelId={novelId} novel={book} workspace={workspace} spell={spell} />} />
              <Route path="*" element={<Missing what="page" />} />
            </Routes>
          </ErrorBoundary>
        </div>
      </div>
      <SyncConflicts novelId={novelId} novel={book} workspace={workspace} open={resolving} onClose={() => setResolving(false)} />
      <SaveConflicts novel={book} workspace={workspace} />
      <NoticeBar />
      <NewEntryDialog novelId={novelId} novel={book} type={newEntry ?? undefined} open={newEntry !== null} onOpenChange={(o) => !o && setNewEntry(null)} />
    </Shell>
  );
}

type RouteProps = { novelId: string; novel: Novel; workspace: Workspace; spell: ReturnType<typeof useSpell> };

function ChapterRoute(props: RouteProps) {
  const { chapterId } = useParams();
  const chapter = props.novel.chapters.find((c) => c.id === chapterId) ?? props.novel.allChapters.find((c) => c.id === chapterId);
  return chapter ? <WritingView {...props} view={{ chapter }} /> : <Missing what="chapter" />;
}

function EntryRoute(props: RouteProps) {
  const { entityId } = useParams();
  const entity = props.novel.entities.find((e) => e.id === entityId);
  return entity ? <EntryPage {...props} entity={entity} /> : <Missing what="entry" />;
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
