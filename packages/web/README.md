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

## Theming

One palette for the app and the editor. The editor's stylesheet defines the `--ghw-*` custom properties (ink, paper, muted, accent, rule…) for light and dark, and `src/styles.css` adds the app's few (panel, raised, danger, ok, warn) in the same three places: the light defaults, the `prefers-color-scheme: dark` block, and `[data-theme="dark"]`. Tailwind's theme maps onto them (`bg-paper`, `text-muted`, `border-rule`…), so every utility follows the theme and there are no `dark:` variants.

The theme follows the OS. Choosing Light or Dark in the top bar sets `data-theme` on the root element and keeps the choice in this browser's local storage.

## Dev loop

`npm run dev` starts Vite with a plugin that runs a gh-writer server in the same process, using the author's library (or `GH_WRITER_CONFIG_DIR`'s). The plugin proxies `/api` to it, with the session cookie attached. Host and Origin are rewritten to the server's own, so its security checks run as in production. Open http://localhost:5180; there's no token to copy. That convenience is the catch: any request to the dev server's `/api` gets the session, so keep `npm run dev` for development. Vite listens on localhost only, and its own host check stays on.

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
