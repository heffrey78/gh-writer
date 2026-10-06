# @gh-writer/web

The gh-writer app: what the author sees in the browser. `gh-writer serve` serves its build (`dist/`) from the local server ([packages/server](../server/README.md)), at every path outside `/api`.

```sh
npm run build              # build the app (gh-writer serve serves dist/)
npm run dev                # Vite on http://localhost:5180, with a real gh-writer server inside
npm run test:e2e -w @gh-writer/web   # build, then Playwright against real servers
```

## Structure

| Path | What |
|---|---|
| `src/main.tsx` | Routes: `/` the library, `/novels/:novelId/*` a novel's workspace |
| `src/layout.tsx` | The frame: skip link, top bar, theme choice |
| `src/library/` | The library page: novels, open a folder, clone from GitHub |
| `src/novel/` | A novel's workspace: navigation, the writing view, save and sync state, conflicts, spell check |
| `src/commands.ts`, `src/palette.tsx` | The command registry, the palette (Mod+K) and the shortcut reference (Mod+/) |
| `src/ui/` | Shared controls (button, field, alert, confirmation dialog), in the shadcn/ui manner |
| `src/api.ts` | The `@gh-writer/client` API on the page's origin, and the TanStack Query client and keys |
| `e2e/` | Playwright tests; `fixtures.ts` starts `gh-writer serve` for each test |

Server state goes through TanStack Query, UI state through Zustand. Components are Radix primitives (via `radix-ui`) styled with Tailwind.

## The writing workspace

`/novels/:id` shows the manuscript on the left (parts, chapters with word counts, scenes) and the editor on the right: a chapter as one continuous text (`chapter/:chapterId`, the default is the first chapter) or one scene (`scene/:sceneId`). The top bar shows whether the text is saved, and the sync state. Focus mode (Mod+Shift+F) hides everything but the text.

`src/novel/workspace.ts` holds what isn't rendering, so it's tested headless against a real server (`test/workspace.test.ts`):

- **Files.** Each open scene file, split into its front matter (kept byte for byte) and the body the editor edits, with the text and hash last known on disk.
- **Saving.** Edits go through `@gh-writer/client`'s autosave, which writes after a 2 s pause with the hash they build on.
- **Changes on disk** arrive from the server's event stream. A scene with no unsaved text reloads in place, in the editor too. That includes text typed but not yet reported by the editor, which the workspace asks for. A scene with unsaved text is left alone: its next save is refused (409), and the workspace then merges it paragraph by paragraph (core's `merge3`) with the disk version, against the text it started from. A clean merge applies by itself. A clash opens the conflict resolver ("Yours" and "On disk"), and nothing is written until the author chooses.
- **Other files** (new scenes, order files, the bible) reload the novel's model and the navigation.

**Sync.** The badge follows the sync status from the event stream: Synced, Syncing…, n ahead or behind, Offline, Sign-in needed, Conflict, Local only. Its popover explains the state, shows the last sync and the commit status, and has Sync now, which saves pending text first. A conflict opens the resolver on the server's conflicts. Finishing commits the merge and pushes it. If the conflicts changed meanwhile, the fresh ones are shown.

If the server stops answering, a banner says so. The unsaved text stays in the tab (session storage) and is saved when gh-writer is back.

**Spell check** uses the English Hunspell dictionary, fetched on first use and checked in a worker, the bible's names, and the novel's `dictionary.txt`. "Add to dictionary" writes that file. **Find and replace** searches the open chapter live and every other scene from the model; replacements in closed scenes are written to their files.

**Checkpoints.** The Checkpoints button opens a panel:

- **Make a checkpoint** by naming it. Unsaved text is saved first, so it's included. A refusal shows the server's reason, such as no git identity or a merge in progress.
- **The list** is newest first, with date and word count, and the word change against the latest. Automatic checkpoints, the ones taken before a restore, are hidden unless asked for.
- **Restore** the manuscript, or the scene being written (the open scene, or in a chapter the one holding the caret). A confirmation says what will change. Afterwards a notice offers **Undo**, which restores the automatic checkpoint; it stays until dismissed. Open editors show the restored text as the files change on disk.

## Commands

Every action is a command in the palette (Mod+K, from anywhere). Type to search titles, groups and keywords; the commands used last come first. Choosing one closes the palette, puts focus back where it was (usually the text), then runs it. Mod+/ opens the shortcut reference: the palette's keys, the editor's formatting keys, and every command that has a shortcut.

Views own their commands. `useCommands(() => [...], deps)` offers them for as long as the component is mounted, and a later view's command replaces an earlier one with the same id:

```tsx
useCommands(() => [{ id: "novel.syncNow", title: "Sync now", group: "Sync", run: () => syncNow.mutate() }], [syncNow]);
```

A command has an `id`, `title` and `group`, and optionally `keys` (TipTap style, shown but not bound: the owner binds them), `keywords` and `isActive` (for toggles, shown as On or Off). Today these views register commands:

- **The root:** your novels, open each novel, theme, keyboard shortcuts.
- **The workspace:** Sync now, resolve conflicts (during one), checkpoints, and go to every chapter and scene by title.
- **The writing view:** the editor's commands (writing modes, session, find, spelling) run on the open editor.

The outline, bible and mention views (#3, #5, #6) add theirs the same way.

## Theming

One palette for the app and the editor. The editor's stylesheet defines the `--ghw-*` custom properties (ink, paper, muted, accent, rule…) for light and dark, and `src/styles.css` adds the app's few (panel, raised, danger, ok, warn) in the same three places: the light defaults, the `prefers-color-scheme: dark` block, and `[data-theme="dark"]`. Tailwind's theme maps onto them (`bg-paper`, `text-muted`, `border-rule`…), so every utility follows the theme and there are no `dark:` variants.

The theme follows the OS. Choosing Light or Dark in the top bar sets `data-theme` on the root element and keeps the choice in this browser's local storage.

## Dev loop

`npm run dev` starts Vite with a plugin that runs a gh-writer server in the same process, using the author's library (or `GH_WRITER_CONFIG_DIR`'s). The plugin proxies `/api` to it, with the session cookie attached. Host and Origin are rewritten to the server's own, so its security checks run as in production. Open http://localhost:5180; there's no token to copy. That convenience is the catch: any request to the dev server's `/api` gets the session, so keep `npm run dev` for development. Vite listens on localhost only, and its own host check stays on.

## Resilience

`e2e/resilience.spec.ts` checks #2's promises the way an author would meet them: the real app on real servers, git run by the tests only to look, and every check made on disk and in git history.

| Promise | Test |
|---|---|
| Draft, close the app, reopen: all work is there, no git by hand | Close the tab straight after typing (it saves on the way out), quit gh-writer (it commits as it stops), start it again: the text is on disk, committed as "Draft: …", and in the editor. |
| A crash loses at most the autosave interval | Type, let it save, type more, and SIGKILL the server about 0.1 s later. Only the last moment's typing is missing from disk. Starting gh-writer again on the same address and opening it in the same tab saves even that, from the tab's session storage. |
| A session with the network down syncs once it's back | The remote is unreachable from the start ("Offline"). Write in two chapters, then bring the remote back and touch nothing: the retry syncs. The remote has both edits, and another clone pulls identical files. |
| The same scene on two machines gives a resolvable conflict, not a corrupted file | Two servers on two clones, the same ending rewritten in both apps. One syncs, the other meets the conflict and keeps both in the resolver, then the first syncs again. One file, the same on both machines and the remote, with both endings, no conflict markers, one merge commit, and a novel that validates. |
| Restoring a checkpoint can be undone | `e2e/checkpoints.spec.ts` |

## Keyboard and accessibility

Everything in the app can be done from the keyboard. `e2e/a11y.spec.ts` walks the whole path mouse-free, once at a 13-inch laptop's 1280×800 and once at a 2560×1440 monitor:

1. The skip link, then the library's controls.
2. Clone a novel.
3. Write in it.
4. Sync into a conflict with another machine.
5. Resolve it.
6. Make a checkpoint, restore it, and undo.
7. Switch the theme, open the shortcut reference, and return to the library.

At each stop it checks:

- **No axe violations**, in light and dark. The audits wait for colour transitions to settle, and axe covers WCAG 2.2 AA text contrast.
- **Visible focus.** Every element Tab reaches shows it, through the accent outline from `:focus-visible`. The writing surface is the one exception: its caret shows focus.
- **No sideways scrolling.**

Actions that live in a passing notice (Undo after a restore) are also palette commands, so they're never a long Tab away.

## Performance

The target (#7) is a 150,000-word novel editable within 2 seconds of opening, and typing within the editor's budget, 50 ms from keystroke to paint at the 95th percentile. `e2e/big-novel.ts` writes a full-length test novel: 3 parts, 60 chapters, 240 scenes and 153,080 words of prose cycled from the sample novel, plus a 49-entry bible. It validates cleanly. `e2e/performance.spec.ts` runs as its own Playwright project, after the other tests, so nothing competes for the CPU:

| Measured (dev machine, Chromium) | Result |
|---|---|
| Open the novel, app files cached: launch URL to the first chapter focused and editable | about 745 ms (the novel's model: about 335 ms, 1.9 MB) |
| First launch, nothing cached | about 865 ms |
| Typing in a chapter of that novel | p50 4 ms, p95 16–19 ms |

The tests fail at 2 s and 50 ms. The time is spent mostly on the server reading the novel. Loading the workspace's code on demand was tried: it made the library lighter but opening a novel about 300 ms slower, because the code and the novel then load one after the other, so the app stays one bundle.

## Security

The server answers the page only with its session cookie (see the server's security model). It serves the page with a Content Security Policy allowing only its own scripts, styles, workers and connections (`CONTENT_SECURITY_POLICY` in the server). Hashed files under `/assets/` are cached for good, and `index.html` is never cached.

## Tests

`e2e/fixtures.ts` gives each test a temporary home: its own git identity, config folder (library.json) and clone folder. It starts `gh-writer serve --no-open` there and reads the launch URL from its output. The library tests cover:

- the token exchange
- opening a folder by keyboard
- cloning from a local bare repository
- the guidance for refused credentials (an HTTP remote answering 401)
- notices for folders that have gone
- removing with confirmation
- theme choice
- an axe audit, empty and with novels, in light and dark

The workspace tests (`e2e/workspace.spec.ts`) use two clones of a local bare remote, "here" (served) and "the other machine":

- writing reaches the disk, then Sync now commits and pushes it
- a change pushed from the other machine reaches the open chapter
- a same-paragraph conflict resolved by keyboard, with the merge on the remote
- a save that meets newer text on disk asks, and keeps the author's choice
- keyboard navigation and focus mode
- the banner when the server stops
- axe audits while writing and with the sync details open, light and dark

`e2e/checkpoints.spec.ts` covers making a checkpoint, restoring a scene and undoing it, and restoring the whole manuscript with unsaved text kept in the automatic checkpoint. Every app test also fails on a Content Security Policy violation in the console, and attaches the server's output when it fails.
