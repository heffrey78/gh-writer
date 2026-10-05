# @gh-writer/client

The browser side of the local server ([packages/server](../server/README.md)): a typed API client and autosave.

```ts
import { createApi, createAutosave } from "@gh-writer/client";
import { useStore } from "zustand";

const api = createApi(); // same origin, session cookie
const { novel, files } = await api.novel(novelId);

const autosave = createAutosave({ api, novelId, onConflict: (c) => openResolver(c) });
autosave.attach(window); // flush on page hide and before unload

const { content, hash } = await api.readFile(novelId, scene.file);
autosave.track(scene.file, hash); // the version the edits build on
const { frontMatter, body } = splitSceneFile(content); // from @gh-writer/editor

<SceneEditor key={scene.id} markdown={body} onChange={(next) => autosave.change(scene.file, joinSceneFile({ frontMatter, body: next }))} />;

const { status, error, conflicts } = useStore(autosave.store); // "saved" | "saving" | "unsaved" | "error"
```

## Autosave

- **One queue per file.** `change()` restarts the file's timer. After `interval` without changes (2 s by default) the latest text is written, so a burst of edits becomes one write. Each file has one request in flight at a time, and text typed during a save follows it.
- **Stale-write protection.** Each write sends the hash of the version it builds on: from `track()`, then from each acknowledged write. The server refuses a write whose base is out of date.
- **Nothing is dropped.** Unsaved text stays in memory and in `sessionStorage` until the server acknowledges it. A new autosave for the same novel (after a reload or a crash of the tab) queues any stored text again. Its base still protects newer text on disk.
- **Failures.** An unreachable server or a 5xx is retried with backoff: 1 s, doubling to 30 s. The status is `error` with the reason until a retry succeeds. A refusal (a bad path, too large) isn't retried; the text is held, and the next change tries again.
- **Conflicts.** A 409 means the file changed on disk since it was read. Nothing more is written to that file. The conflict (`{ path, mine, disk }`) goes to `onConflict` and into `store.conflicts`; typing goes on updating `mine`. Then either:
  - `resolve(path, merged)` writes the resolver's text (#47) over the disk version it was shown, or
  - `discard(path)` takes the disk version.
- **Leaving the page.** `attach(window)` flushes on `pagehide`, `beforeunload` and `visibilitychange` to hidden, with `keepalive` requests. Browsers cap keepalive bodies at 64 kB, so a larger file goes as an ordinary request.

| Status | Means |
|---|---|
| `saved` | everything is on disk |
| `unsaved` | changes are waiting for the pause |
| `saving` | a write is in flight |
| `error` | a save failed (being retried, or held), or there's a conflict; `error` says why |
