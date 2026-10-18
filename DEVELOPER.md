# Developing gh-writer

This guide is for people working on gh-writer itself. For using it, see [USER.md](USER.md).

## Setup

You need Node.js 22.18 or later (it runs TypeScript directly, so there's no build step for the server or CLI) and git.

```sh
npm install
npm run build                      # the web app, into packages/web/dist
npx gh-writer serve examples/sample-novel
```

For working on the UI, `npm run dev` serves the web app with hot reload through Vite, with a real gh-writer server inside it. That server uses your own library unless you point `GH_WRITER_CONFIG_DIR` at another folder, which is wise while experimenting. `npm run playground -w @gh-writer/editor` serves the editor on its own, with every sample scene and a 10,000-word chapter.

## Architecture

gh-writer is a local-first web app (decision [D2](https://github.com/heffrey78/gh-writer/issues/22)). `gh-writer serve` starts a server on 127.0.0.1 that reads and writes the novel's git repository on disk, and opens the browser on it with a token made for that launch, traded for a session cookie. The browser app talks only to that server; the server talks to git and to GitHub.

```
browser ── web (React) ── client (API, autosave) ──HTTP──► server (Hono) ── core (format, model)
                                                             │  ├── git (system git, simple-git)
                                                             │  ├── GitHub (REST API, device-flow sign-in)
                                                             │  └── export (DOCX, EPUB, PDF)
cli ── serve / validate / snapshots / compile ───────────────┘
```

The novel itself is the source of truth: plain Markdown and YAML files ([format spec](docs/format/v2.md), decision [D3](https://github.com/heffrey78/gh-writer/issues/23)). Story facts live in files and GitHub Issues hold work and discussion ([D1](https://github.com/heffrey78/gh-writer/issues/21)). The stack is TypeScript throughout, React, TipTap/ProseMirror, React Flow, Hono and the system git ([D4](https://github.com/heffrey78/gh-writer/issues/24)). Signing in to GitHub and using that for git is [D5](https://github.com/heffrey78/gh-writer/issues/91); compiling with our own TypeScript and pure-JavaScript libraries is [D6](https://github.com/heffrey78/gh-writer/issues/122); versions as branches, adopted by merging, compared commit to commit, are [D7](https://github.com/heffrey78/gh-writer/issues/129).

## Packages

| Package | What it is |
|---|---|
| [`core`](packages/core) | The novel format: JSON Schemas, types, the loader (`loadNovel`) and story model, the validator, word counts, IDs, edits to YAML that keep comments and layout, three-way merge, diagram data and SVG snapshots, issue anchors and labels, the compiler's book model (`compileBook`), and comparing two states of a novel with a word-level diff (`compareNovels`). Runs in the browser and in Node. |
| [`editor`](packages/editor/README.md) | The prose editor: TipTap schema, lossless Markdown round-trip, the scene and chapter editors, mentions, find and replace, spell check, word counts and the conflict resolver. |
| [`client`](packages/client/README.md) | The browser side of the server: a typed API client and autosave. |
| [`server`](packages/server/README.md) | The local server: Hono API, library, file writes, background commits, sync, checkpoints, versions, comparisons, GitHub connection, issue cache and outbox, compile route. Its README documents the API. |
| [`web`](packages/web) | The app: library, writing view, story bible, diagrams, issues, command palette. React, react-query, zustand, Radix, cmdk and Tailwind. |
| [`export`](packages/export) | DOCX (hand-written WordprocessingML), EPUB 3 and PDF (pdfkit, with Liberation Serif) from a compiled book; zipped with fflate. |
| [`cli`](packages/cli) | `gh-writer serve`, `validate`, `snapshots`, `compile`, `migrate` and `new-id`, and the entry points bundled into novel repositories. |
| [`desktop`](packages/desktop) | The desktop app: a Tauri shell that runs the server bundle on its own Node and git, and opens a window on it. |

Other folders:

- `templates/novel`: the template every new novel starts from, including its workflows and vendored tools.
- `examples/sample-novel`: *The Bridge at Varn*, the sample used by tests, screenshots and the playground.
- `docs/format/v2.md`: the format spec.
- `scripts/`: the bundler for vendored tools and the sample compile.

## Checks

| Command | Runs |
|---|---|
| `npm run typecheck` | TypeScript on every package |
| `npm test` | Vitest unit and integration tests (`packages/*/test`) |
| `npm run test:e2e` | Playwright: the editor playground, then the built web app against real servers |
| `npm run check` | typecheck and unit tests |

Run `npx playwright install chromium` in `packages/editor` once before the first e2e run. The e2e tests also run in WebKit, the engine of the desktop app's window on macOS and Linux. CI runs both (`E2E_BROWSERS=chromium,webkit` is the default there); elsewhere only Chromium runs unless you set `E2E_BROWSERS`. Playwright's WebKit needs Ubuntu's libraries: on Ubuntu, `npx playwright install --with-deps webkit`; elsewhere, its Docker image (`mcr.microsoft.com/playwright`). On other Linux distributions (Arch, say), Playwright's WebKit is missing only Ubuntu 24.04's `libicu74` and `libflite1`. Fetch those packages from archive.ubuntu.com and check them against the archive's `Packages` index. Copy their libraries into `~/.cache/ms-playwright/webkit-*/minibrowser-{wpe,gtk}/sys/lib`, since Playwright's launcher ignores `LD_LIBRARY_PATH`. Then run with `PLAYWRIGHT_SKIP_VALIDATE_HOST_DEPENDENCIES=1 E2E_BROWSERS=chromium,webkit`. The web e2e tests run against the **built** app, so `npm run test:e2e` builds it first; if you run Playwright directly, run `npx vite build` in `packages/web` after changing the UI.

Each web e2e test starts its own `gh-writer serve` on a temp copy of the sample novel (`packages/web/e2e/fixtures.ts`), with a fake GitHub (`packages/server/test/fake-github.ts`) that serves the REST API, the device flow and git over HTTP. Most views also run an [axe](https://github.com/dequelabs/axe-core) audit, many in both light and dark themes; new UI should too. Performance benchmarks (`*.performance.spec.ts`) run after the rest, one at a time.

CI (`.github/workflows/ci.yml`) runs typecheck, unit tests, validation of the sample novel, epubcheck on the sample's EPUB, and every e2e test.

## The novel template's tools

Novel repositories can't install gh-writer, so the template carries its tools as single-file esbuild bundles in `templates/novel/.github/gh-writer/`: `validate.mjs`, `snapshots.mjs`, and `compile.mjs` with its fonts. **After changing `core`, `export` or the CLI entry points, run `npm run build:template`**, which rebuilds them and redraws the template's and the sample's diagram snapshots. A test fails if the vendored bundles don't match the source.

The compiled files must be the same bytes in the app, on the command line and in a novel's GitHub Action. A test compiles a committed copy of the sample both ways, in different time zones, and compares them. Keep anything time-, zone- or platform-dependent out of the output: dates come from the commit, IDs from the novel, zip timestamps are written in UTC, and PDFs are compressed with fflate rather than Node's zlib.

`npm run screenshots -w @gh-writer/web` retakes the README's screenshots (`docs/screenshots/`) from the sample novel.

## The server bundle

The desktop app runs the server on Node's official binary, as one script ([D9](https://github.com/heffrey78/gh-writer/issues/170)). `npm run build:server` builds the web app, then bundles the `gh-writer` command into `dist/server/gh-writer.mjs` with what it reads at run time beside it: the keychain's native module (`node_modules/@napi-rs/keyring*`, for this platform), the web app (`web/`), the novel template (`template/`) and the compiler's type (`fonts/`). The bundle's entry point (`packages/cli/src/bundle.ts`) points `GH_WRITER_WEB`, `GH_WRITER_TEMPLATE` and `GH_WRITER_FONTS` at those folders, unless they're already set; from the source tree, each falls back to its place in the checkout. A test builds the bundle and checks it serves, and compiles the same bytes as the source.

`npm run fetch:runtime [target]` fetches what the bundle runs on for one platform (`linux-x64`, `darwin-arm64`, `darwin-x64` or `win32-x64`; by default this machine's) into `dist/runtime/<target>/`. That's Node's official binary and GitHub's portable git (dugite-native), each checked against a checksum pinned in `scripts/fetch-runtime.ts`, plus their licences and where git's source is. Git Credential Manager, Git LFS, Perl, gitweb and translations are left out, which takes git from about 150 MB to about 40 MB. It has no symbolic links, since app bundlers copy what a link points to. git runs its built-ins itself, so their dashed links are dropped, as Git for Windows does. The transport commands git runs by name (`git-upload-pack` and friends) and `git-remote-https` become copies. The app answers git's credential prompts itself, and reads git's messages in English. This portable git doesn't find its own parts unaided: it needs `GIT_EXEC_PATH` (`libexec/git-core`) and `GIT_TEMPLATE_DIR` (`share/git-core/templates`), and on Linux `GIT_SSL_CAINFO` (`ssl/cacert.pem`). On Linux, its https helper uses the system's `libcurl.so.4`. To bump Node or git, change the version and its checksums at the top of the script. For this machine's own target, the script checks that node and git run with nothing else on PATH.

## The desktop app

`packages/desktop` is a Tauri 2 app ([D2](https://github.com/heffrey78/gh-writer/issues/22), [D9](https://github.com/heffrey78/gh-writer/issues/170)) around the same server and web app. Building it needs Rust, and on Linux WebKitGTK 4.1 (see [Tauri's prerequisites](https://v2.tauri.app/start/prerequisites/)). `npm run desktop` builds the server bundle, fetches this machine's runtime, then runs the app in development. The bundle and runtime are its resources (`server/` and `runtime/`, from `tauri.conf.json` and `tauri.linux.conf.json`).

The shell (`src-tauri/src`) does the following:
- **Starting.** It starts the server: `runtime/node/node server/gh-writer.mjs serve --sidecar`, with `GH_WRITER_GIT` set to `runtime/git` and `GH_WRITER_ASKPASS` set to its own executable. Neither is set when the writer has chosen *Use This Computer's git* (`settings.json` in the app's config folder).
- **Windows.** The library has a window of its own (`main`), and each novel gets one (`novel-<library id>`). Every window starts on the loading page and, once the server is up, is sent to its page there. Windows stay on the server's pages, and other links, `target=_blank` included, open in the writer's browser. Each window's title follows its page. Sizes and positions are remembered.
- **Signing in.** The shell sets the server's session cookie itself, as `SameSite=Lax`, rather than using the `?token=` redirect. WebKitGTK counts the navigation from the loading page as cross-site, so it would withhold the server's `Strict` cookie.
- **Commands for pages.** The server's pages may call ten commands, and only these (`capabilities/default.json`): `flushed`, `page_ready`, `pick_folder`, `open_novel`, `show_library`, `set_recent`, `edit` (the webview's own Cut, Copy, Paste and Select all, on Linux; false elsewhere), `clipboard_text`, `can_inspect` and `inspect` (the inspector, in a debug build). The page's side is `packages/web/src/desktop.ts`. The shell runs commands in a page through `window.ghWriter.run` (`go` to a path, `about`), keeping them until the page says it's ready.
- **Right-click.** The page draws its own menu (`packages/web/src/context-menu.tsx`, [#243](https://github.com/heffrey78/gh-writer/issues/243)) and the webview's never shows. What was clicked can add items to it through `contributeMenuItems` (`@gh-writer/editor`): the spelling suggestions, Raise an issue…. A page can't read the clipboard, so Paste asks the shell: on Linux `edit` runs WebKitGTK's own Paste, which keeps formatting; elsewhere the page pastes `clipboard_text` itself.
- **Menu.** File has New Novel…, Open Folder… and Clone from GitHub… (the library's own dialogs, in its window), Open Recent, Your Novels, Use This Computer's git (which restarts the server; every window comes back where it was), Close Window and Quit. Edit and Help (About gh-writer) complete it.
- **One copy.** A second launch hands its arguments to the running one and exits. A folder passed on the command line, or dropped on the library window, opens through `/?add=open&path=…`: added and opened, or the dialog says why not. Only the library window takes drops; a novel's window leaves them to its page (pictures on portraits).
- **Closing and quitting.** Closing a window, quitting, or SIGTERM, SIGINT or SIGHUP (logging out) has each page save what's typed: the shell calls `window.ghWriter.flushAll()`, and the page answers with `flushed`. Then the shell closes the server's stdin and waits for it to commit and exit, killing it after 15 seconds.
- **Askpass.** The executable doubles as git's askpass program (`src/askpass.rs`). Started with one of git's username or password prompts as its only argument, it prints `x-access-token` or the token from `GH_WRITER_GIT_TOKEN` and exits before opening any window.
- **Crashes.** If the app itself dies, the closed pipe stops the server. If the server stops on its own, the app offers to restart it.

`e2e/desktop.spec.ts` in the web app checks the page's side, with a stand-in for the shell.

Installers for Linux:

| Command | Makes | Size |
|---|---|---|
| `npm run desktop:arch` | an Arch package (`packages/desktop/arch/gh-writer-*.pkg.tar.zst`; install with `sudo pacman -U`), repackaged from the .deb by `arch/PKGBUILD` | about 58 MB |
| `npm run build:server && npm run fetch:runtime`, then `npx tauri build` in `packages/desktop` | the .deb (`src-tauri/target/release/bundle/deb/`) | about 82 MB |

Both use the system's WebKitGTK. There's no AppImage: it has to carry WebKitGTK itself, which comes to 165 MB. `arch/build.sh` fails if the package is over the 100 MB budget.

Updates: on Linux the app can't replace itself (Tauri updates only AppImages there). The server checks GitHub's latest release once a day (`GET /api/app`), and the top bar says when a newer one is out. About gh-writer shows its notes and links to its download. The updater signing key, for the macOS and Windows updaters to come, is `~/.tauri/gh-writer.key` on the maintainer's machine. Its password is in the keychain (`secret-tool lookup service gh-writer-updater key ~/.tauri/gh-writer.key`), and the public key is `src-tauri/updater.key.pub`. For CI, both go into Actions secrets (`TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`).

About gh-writer also shows the versions of the app, Node and git. In the desktop app it shows the licences of what it ships, from the `licenses/` resource folder (gh-writer's, Node's, git's, and where git's source is).

Cutting a release:

1. Set the version in `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` and `arch/PKGBUILD` (setting `pkgrel=1` again).
2. Commit, then tag `v1.2.3` (or `v1.2.3-rc.1` for a pre-release) and push the tag.
3. The Desktop workflow (`.github/workflows/desktop.yml`) checks that the tag names that version. It builds the .deb on Ubuntu 22.04 and makes the Arch package from it.
4. It installs each on a clean container with no git and runs `scripts/smoke-desktop.ts` on the packaged Node, against a fake GitHub. The smoke test signs in, clones, takes the account's name and email, writes, syncs (pushing through the app's askpass) and quits, then starts the app under Xvfb and quits it with SIGTERM.
5. It drafts a GitHub Release with both packages and git's source (git and dugite-native, at the pinned versions; GPL-2.0).
6. Publish the draft when it's right. The app offers the latest published release, never a draft or a pre-release.

The workflow also runs on pull requests that touch the desktop app or its scripts, without the release, and by hand (*Run workflow*). To run the smoke test on this machine against an installed package: `node scripts/build-smoke.ts`, then `/usr/lib/gh-writer/runtime/node/node dist/smoke/smoke-desktop.mjs --sample dist/smoke/sample-novel`. Set `GH_WRITER_SMOKE_ALLOW_GIT=1` if this machine has git.

The server's messages go to `server.log` in the app's log folder (`~/.local/share/io.github.heffrey78.ghwriter/logs` on Linux). The previous run's are in `server.previous.log`. `cargo test` in `src-tauri` runs the shell's unit tests.

## Conventions

- **Writers, not developers, use the app.** No git terms in the UI: "checkpoint", not "tag"; "sync", not "push". Messages say what happened and what to do next.
- **Never lose words.** Writes are atomic, refused when the file changed underneath (with a conflict to resolve), and unsaved text survives a crash. Edits to YAML keep the author's comments and layout. Untouched Markdown is saved byte for byte.
- **Keyboard and screen readers first.** Everything works without a mouse and is in the command palette; dialogs trap and restore focus; live regions announce what changed.
- **Code style.** Match the surrounding code: its comment density, naming and idiom. Comments explain why. Prefer plain, specific names.
- **Tests with the change.** A bug fix comes with the test that would have caught it.

## Project tracking

Work is tracked as GitHub issues in this repository: requirements, decisions (D1–D7) and tasks, grouped into milestones. A requirement goes Draft → Approved → Implemented → Validated; approving and validating are the owner's decisions. Tasks link to their requirement, and a task is done when it's committed, pushed and CI is green. Commit messages say what changed and why, and refer to their task (`Refs #127`).

## License

[MIT](LICENSE.md). The Liberation Serif fonts are under the SIL Open Font License 1.1.
