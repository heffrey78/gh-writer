import type { SyncStatus } from "@gh-writer/client";
import type { Novel } from "@gh-writer/core";
import { writingModes } from "@gh-writer/editor";
import { useWritingModes } from "@gh-writer/editor/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import { Link, Navigate, Route, Routes, useLocation, useNavigate, useParams } from "react-router";
import { api, keys } from "../api.ts";
import { useCommands, type Command } from "../commands.ts";
import { flushOnQuit } from "../desktop.ts";
import { FileDown, History } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { MENU_ITEM, Shell } from "../layout.tsx";
import { ErrorAlert } from "../ui/alert.tsx";
import { ErrorBoundary } from "../ui/error-boundary.tsx";
import { BiblePage } from "../bible/bible-page.tsx";
import { useNewEvent } from "../events/new-event.tsx";
import { useNewNote } from "../notes/new-note.tsx";
import { NotesPage } from "../notes/notes-page.tsx";
import { NotesLeftDialog } from "../notes/notes-left.tsx";
import { EntryOver, EventOver, NoteOver } from "./item-modals.tsx";
import { cn } from "../ui/cn.ts";
import { DraftsButton, useDrafts } from "./drafts.tsx";
import { CompileDialog } from "./compile.tsx";
import { ComparePage } from "./compare-page.tsx";
import { StoryMapPage } from "./story-map.tsx";
import { ProgressPage } from "./progress-page.tsx";
import { AdoptConflicts, useSwitchVersion, useVersions } from "./versions.tsx";
import { SaveConflicts, SyncConflicts } from "./conflicts.tsx";
import { useNovelEvents } from "./events.ts";
import { Sidebar, useSidebar } from "./sidebar.tsx";
import { chapterTitle } from "./navigation.tsx";
import { NoticeBar } from "./notice.tsx";
import { OutlinePage } from "./outline-page.tsx";
import { SaveStatus } from "./save-status.tsx";
import { useSpell } from "./spell.ts";
import { usePublish } from "../github/publish.tsx";
import { SyncBadge } from "./sync-badge.tsx";
import { createWorkspace, type Workspace } from "./workspace.ts";
import { createQuickEntries, type QuickEntries } from "../bible/quick-entries.ts";
import { unlink } from "../bible/quick-entry.ts";
import { useEntryPanel } from "./entry-tab.tsx";
import { useNotice } from "./notice.tsx";
import { useWritingEditor } from "./writing-view.tsx";
import { useGitHubRepo } from "../github/repo.ts";
import { IssuePage } from "../issues/issue-page.tsx";
import { IssuesPage } from "../issues/issues-page.tsx";
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
  const [entries, setEntries] = useState<QuickEntries>();
  const [resolving, setResolving] = useState(false);
  const [compiling, setCompiling] = useState(false);
  const newEvent = useNewEvent((s) => s.open);
  const newNote = useNewNote((s) => s.open);
  // Focus mode is for writing: elsewhere (the Outline, say) the chrome stays, or there'd be no way
  // out, since only the editor turns it off. Back in a chapter or scene, it's on again.
  const focus = useWritingModes((m) => m.focus) && current !== undefined;
  const collapsed = useSidebar((s) => s.collapsed);
  const spell = useSpell(api, novelId, novel.data?.novel);

  // What the entries made in place report with: the latest model and navigation.
  const latest = useRef({ novel: novel.data?.novel, navigate: (_to: string) => {} });
  latest.current.novel = novel.data?.novel;

  useEffect(() => {
    const ws = createWorkspace({ api, novelId, onModelSaved: () => void queryClient.invalidateQueries({ queryKey: keys.novel(novelId) }) });
    const detach = ws.autosave.attach(window);
    const unflush = flushOnQuit(() => ws.flush());
    const show = useNotice.getState().show;
    const label = (type: string) => latest.current.novel?.entityTypes.find((t) => t.key === type)?.label.toLowerCase() ?? "entry";
    const made = createQuickEntries({
      api,
      novelId,
      onMade: async (e) => {
        await queryClient.invalidateQueries({ queryKey: keys.novel(novelId) });
        show({
          message: `Added ${label(e.type)} “${e.name}” to the story bible.`,
          action: {
            label: "Add details",
            run: () => {
              // On the right sidebar's Entry tab when writing; otherwise its page.
              const editor = useWritingEditor.getState().editor;
              if (editor && !editor.isDestroyed && !writingModes.getState().focus) useEntryPanel.getState().open(e.id, { edit: true });
              else latest.current.navigate(`/novels/${novelId}/bible/${e.id}`);
            },
          },
        });
      },
      onRefused: (e, why) =>
        show({
          message: `Couldn't add “${e.name}” to the story bible: ${why}`,
          action: { label: "Try again", run: () => made.retry(e.id) },
          secondary: {
            label: "Unlink",
            run: () => {
              unlink(ws, e.id);
              made.discard(e.id);
            },
          },
        }),
    });
    setWorkspace(ws);
    setEntries(made);
    return () => {
      detach();
      unflush();
      made.dispose();
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
    issues: () => void queryClient.invalidateQueries({ queryKey: keys.issues(novelId) }),
    board: () => void queryClient.invalidateQueries({ queryKey: keys.board(novelId) }),
  });

  const syncNow = useMutation({
    mutationFn: async () => {
      await workspace?.autosave.flush();
      return api.syncNow(novelId);
    },
    onSuccess: (status: SyncStatus) => queryClient.setQueryData(keys.sync(novelId), status),
  });

  const navigate = useNavigate();
  latest.current.navigate = (to) => void navigate(to);
  /** A new note, event or entry, in its modal over its gallery (#233): closed, back to the gallery if it was opened there. */
  const openNew = (path: string, gallery: string) => void navigate(`/novels/${novelId}/${path}`, { state: { fromGallery: pathname === `/novels/${novelId}/${gallery}` } });
  // New note and New off-page event, asked for from the palette, a gallery or the Timeline.
  useEffect(() => {
    if (!newNote) return;
    useNewNote.getState().set(false);
    openNew("note/new", "notes");
  }, [newNote]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!newEvent) return;
    useNewEvent.getState().set(false);
    openNew("event/new", "bible");
  }, [newEvent]); // eslint-disable-line react-hooks/exhaustive-deps
  // GitHub work tracking shows only for a novel on GitHub (#8).
  const repo = useGitHubRepo(novelId);
  const model = novel.data?.novel;
  const conflict = sync.data?.state === "conflict";
  const versions = useVersions(novelId);
  const switchVersion = useSwitchVersion(novelId, workspace);
  useCommands(
    (): Command[] => [
      { id: "novel.syncNow", title: "Sync now", group: "Sync", run: () => syncNow.mutate() },
      ...(conflict ? [{ id: "novel.resolve", title: "Resolve sync conflicts", group: "Sync", run: () => setResolving(true) }] : []),
      { id: "novel.drafts", title: "Drafts: versions and checkpoints", group: "Drafts", keywords: ["alternate", "ending", "try", "history", "restore"], run: () => useDrafts.getState().set(true) },
      { id: "novel.checkpoints", title: "Checkpoints: make or restore one", group: "Drafts", run: () => useDrafts.getState().set(true) },
      ...(versions.data ?? [])
        .filter((v) => !v.current)
        .map((v) => ({ id: `novel.version.${v.id}`, title: `Open version: ${v.name}`, group: "Drafts", run: () => switchVersion.mutate(v) })),
      { id: "novel.compile", title: "Compile the manuscript…", group: "Novel", keywords: ["export", "docx", "word", "epub", "pdf", "e-book", "manuscript"], run: () => setCompiling(true) },
      { id: "novel.bible", title: "Story bible", group: "Go to", run: () => void navigate(`/novels/${novelId}/bible`) },
      { id: "novel.outline", title: "Outline", group: "Go to", keywords: ["table"], run: () => void navigate(`/novels/${novelId}/outline/table`) },
      { id: "novel.outlineCards", title: "Outline: cards", group: "Go to", keywords: ["corkboard", "index cards"], run: () => void navigate(`/novels/${novelId}/outline/cards`) },
      { id: "novel.outlineBoard", title: "Outline: drafting board", group: "Go to", keywords: ["board", "kanban", "status", "progress", "projects"], run: () => void navigate(`/novels/${novelId}/outline/board`) },
      { id: "novel.timeline", title: "Story map: Timeline", group: "Go to", keywords: ["chronology", "story time", "flashback", "diagram"], run: () => void navigate(`/novels/${novelId}/story-map/timeline`) },
      { id: "novel.presence", title: "Story map: Presence", group: "Go to", keywords: ["diagram", "characters", "themes", "locations", "matrix"], run: () => void navigate(`/novels/${novelId}/story-map/presence`) },
      { id: "novel.swimlanes", title: "Story map: Plotlines", group: "Go to", keywords: ["diagram", "plotlines", "swimlanes"], run: () => void navigate(`/novels/${novelId}/story-map/plotlines`) },
      { id: "novel.progress", title: "Progress", group: "Go to", keywords: ["stats", "statistics", "goal", "target", "deadline", "streak", "words a day"], run: () => void navigate(`/novels/${novelId}/progress`) },
      { id: "novel.compare", title: "Compare: what changed between drafts", group: "Go to", keywords: ["diff", "changes"], run: () => void navigate(`/novels/${novelId}/compare`) },
      { id: "novel.graph", title: "Relationships", group: "Go to", keywords: ["diagram", "characters", "graph"], run: () => void navigate(`/novels/${novelId}/relationships`) },
      ...(repo
        ? [
            { id: "novel.issues", title: "Issues", group: "Go to", keywords: ["github", "notes", "to do", "plot holes"], run: () => void navigate(`/novels/${novelId}/issues`) },
            { id: "novel.newIssue", title: "New issue", group: "GitHub", keywords: ["github", "note", "plot hole"], run: () => void navigate(`/novels/${novelId}/issues?new=1`) },
          ]
        : []),
      { id: "novel.notes", title: "Notes", group: "Go to", keywords: ["ideas", "brainstorm", "cards"], run: () => void navigate(`/novels/${novelId}/notes`) },
      { id: "novel.newNote", title: "New note", group: "Notes", keywords: ["idea", "brainstorm", "what if"], run: () => useNewNote.getState().set(true) },
      ...(model?.notes ?? []).map((n) => ({ id: `novel.note.${n.id}`, title: `Note: ${n.title}`, group: "Go to", keywords: n.tags, run: () => void navigate(`/novels/${novelId}/note/${n.id}`) })),
      { id: "novel.newEvent", title: "New off-page event", group: "Story bible", keywords: ["event", "backstory", "timeline"], run: () => useNewEvent.getState().set(true) },
      ...(model?.entityTypes ?? []).map((t) => ({ id: `novel.newEntry.${t.key}`, title: `New ${t.label.toLowerCase()}`, group: "Story bible", run: () => openNew(`bible/new?type=${encodeURIComponent(t.key)}`, "bible") })),
      ...(model?.entities ?? []).map((e) => ({
        id: `novel.entry.${e.id}`,
        title: `${model!.entityTypes.find((t) => t.key === e.type)?.label ?? e.type}: ${e.name}`,
        group: "Go to",
        keywords: e.aliases,
        run: () => void navigate(`/novels/${novelId}/bible/${e.id}`),
      })),
      ...(model?.events ?? []).map((e) => ({ id: `novel.event.${e.id}`, title: `Off the page: ${e.title}`, group: "Go to", keywords: ["event"], run: () => void navigate(`/novels/${novelId}/event/${e.id}`) })),
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
    [model, conflict, novelId, navigate, repo, versions.data, switchVersion.mutate],
  );

  const heading = workspace && novel.data && (
    <>
      <span className="truncate px-1 font-semibold">{novel.data.novel.config?.title ?? "Untitled"}</span>
      <DraftsButton novelId={novelId} workspace={workspace} />
    </>
  );
  const menu = workspace && (
    <>
      <DropdownMenu.Item className={MENU_ITEM} onSelect={() => useDrafts.getState().set(true)}>
        <History className="size-4" aria-hidden /> Checkpoints…
      </DropdownMenu.Item>
      <DropdownMenu.Item className={MENU_ITEM} onSelect={() => setCompiling(true)}>
        <FileDown className="size-4" aria-hidden /> Compile…
      </DropdownMenu.Item>
    </>
  );
  const actions = workspace && (
    <>
      <SaveStatus autosave={workspace.autosave} entries={entries?.store} />
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
  if (book.diagnostics.some((d) => d.code === "E_SCHEMA_VERSION")) {
    return (
      <Shell heading={heading} actions={actions} title={book.config?.title ?? "Untitled"}>
        <TooNew />
      </Shell>
    );
  }
  return (
    <Shell wide heading={heading} actions={actions} menu={menu} chrome={!focus} title={book.config?.title ?? "Untitled"}>
      {!connected && (
        <p role="alert" className="border-b border-warn/40 bg-warn-soft px-4 py-2 text-sm">
          gh-writer isn't answering. Your unsaved text is kept in this tab; start gh-writer again and it will be saved.
        </p>
      )}
      <div className={focus ? "h-full" : cn("grid h-full", collapsed ? "grid-cols-[3.25rem_minmax(0,1fr)]" : "grid-cols-[3.25rem_minmax(0,1fr)] md:grid-cols-[16rem_minmax(0,1fr)]")}>
        {!focus && (
          <Sidebar novelId={novelId} novel={book} workspace={workspace} current={current} onGitHub={!!repo} />
        )}
        <div className="md:overflow-y-auto">
          <ErrorBoundary what="this view" remount={sameView}>
            <Routes>
              <Route index element={book.chapters[0] ? <Navigate to={`/novels/${novelId}/chapter/${book.chapters[0].id}`} replace /> : <EmptyManuscript />} />
              <Route path="chapter/:chapterId" element={<ChapterRoute novelId={novelId} novel={book} workspace={workspace} spell={spell} entries={entries} />} />
              <Route path="scene/:sceneId" element={<SceneRoute novelId={novelId} novel={book} workspace={workspace} spell={spell} entries={entries} />} />
              <Route
                path="relationships"
                element={
                  <Suspense fallback={<p className="px-6 py-6 text-muted">Opening the graph…</p>}>
                    <GraphPage novelId={novelId} novel={book} />
                  </Suspense>
                }
              />
              <Route path="story-map" element={<Navigate to={`/novels/${novelId}/story-map/plotlines`} replace />} />
              <Route path="story-map/:tab" element={<StoryMapPage novelId={novelId} novel={book} workspace={workspace} />} />
              <Route path="outline" element={<OutlinePage novelId={novelId} novel={book} workspace={workspace} />} />
              <Route path="outline/:view" element={<OutlinePage novelId={novelId} novel={book} workspace={workspace} />} />
              <Route path="bible" element={<BiblePage novelId={novelId} novel={book} />} />
              {/* An entry or an event opens over the Story bible, a note over Notes (#233): the gallery stays as it was underneath. */}
              <Route path="bible/:entityId" element={<BiblePage novelId={novelId} novel={book} over={<EntryOver novelId={novelId} novel={book} workspace={workspace} spell={spell} />} />} />
              <Route path="event/:eventId" element={<BiblePage novelId={novelId} novel={book} over={<EventOver novelId={novelId} novel={book} workspace={workspace} spell={spell} />} />} />
              <Route path="note/:noteId" element={<NotesPage novelId={novelId} novel={book} over={<NoteOver novelId={novelId} novel={book} workspace={workspace} spell={spell} />} />} />
              <Route path="progress" element={<ProgressPage novelId={novelId} novel={book} />} />
              <Route path="compare" element={<ComparePage novelId={novelId} workspace={workspace} />} />
              <Route path="issues" element={<GitHubOnly repo={repo} novelId={novelId}>{() => <IssuesPage novelId={novelId} novel={book} workspace={workspace} />}</GitHubOnly>} />
              <Route path="issues/:number" element={<GitHubOnly repo={repo} novelId={novelId}>{() => <IssueRoute novelId={novelId} novel={book} workspace={workspace} />}</GitHubOnly>} />
              <Route path="notes" element={<NotesPage novelId={novelId} novel={book} />} />
              <Route path="*" element={<Missing what="page" />} />
            </Routes>
          </ErrorBoundary>
        </div>
      </div>
      <SyncConflicts novelId={novelId} novel={book} workspace={workspace} open={resolving} onClose={() => setResolving(false)} />
      <AdoptConflicts novelId={novelId} novel={book} workspace={workspace} />
      {compiling && <CompileDialog novelId={novelId} novel={book} workspace={workspace} onClose={() => setCompiling(false)} />}
      <SaveConflicts novel={book} workspace={workspace} />
      <NoticeBar />
      <NotesLeftDialog />
    </Shell>
  );
}

/** A view's address: an item in its modal is its gallery's view, which stays as it was underneath (#233). */
const sameView = (pathname: string) => pathname.replace(/\/note\/[^/]+$/, "/notes").replace(/\/(bible|event)\/[^/]+$/, "/bible");

type RouteProps = { novelId: string; novel: Novel; workspace: Workspace; spell: ReturnType<typeof useSpell>; entries?: QuickEntries | undefined };

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

/** A view only a novel on GitHub has: until that's known, a moment's wait; not on GitHub, the manuscript. */
function GitHubOnly({ repo, novelId, children }: { repo: ReturnType<typeof useGitHubRepo>; novelId: string; children: () => ReactNode }) {
  if (repo === undefined) return <p className="px-6 py-6 text-muted">Opening…</p>;
  if (!repo) return <Navigate to={`/novels/${novelId}`} replace />;
  return <>{children()}</>;
}

function IssueRoute({ novelId, novel, workspace }: { novelId: string; novel: Novel; workspace: Workspace }) {
  const { number } = useParams();
  const n = Number(number);
  return Number.isInteger(n) && n !== 0 ? <IssuePage key={n} novelId={novelId} novel={novel} workspace={workspace} number={n} /> : <Missing what="issue" />;
}

function Missing({ what }: { what: string }) {
  return (
    <div className="p-8">
      <h1 className="text-xl font-semibold">No such {what}</h1>
      <p className="mt-2 text-muted">It may have been moved or deleted. Choose another from the manuscript.</p>
    </div>
  );
}

const LATEST_RELEASE = "https://github.com/heffrey78/gh-writer/releases/latest";

/** A novel in a newer format than this copy reads: shown, never written, lest it be written wrong (D11). */
function TooNew() {
  return (
    <div className="mx-auto max-w-xl px-6 py-10">
      <h1 className="text-2xl font-semibold">This novel needs a newer gh-writer</h1>
      <p className="mt-3">
        It was saved in a newer format than this copy of gh-writer can read, probably by a newer copy on another computer. To keep from saving it wrongly, this copy won't open it.
      </p>
      <p className="mt-3">
        <a href={LATEST_RELEASE} target="_blank" rel="noreferrer" className="text-accent underline">
          Get the latest gh-writer
        </a>
        , then open the novel again. Nothing in it has changed.
      </p>
      <p className="mt-6">
        <Link to="/" className="text-accent underline">
          Back to your novels
        </Link>
      </p>
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
