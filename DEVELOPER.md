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

The novel itself is the source of truth: plain Markdown and YAML files ([format spec](docs/format/v1.md), decision [D3](https://github.com/heffrey78/gh-writer/issues/23)). Story facts live in files and GitHub Issues hold work and discussion ([D1](https://github.com/heffrey78/gh-writer/issues/21)). The stack is TypeScript throughout, React, TipTap/ProseMirror, React Flow, Hono and the system git ([D4](https://github.com/heffrey78/gh-writer/issues/24)). Signing in to GitHub and using that for git is [D5](https://github.com/heffrey78/gh-writer/issues/91); compiling with our own TypeScript and pure-JavaScript libraries is [D6](https://github.com/heffrey78/gh-writer/issues/122); versions as branches, adopted by merging, compared commit to commit, are [D7](https://github.com/heffrey78/gh-writer/issues/129).

## Packages

| Package | What it is |
|---|---|
| [`core`](packages/core) | The novel format: JSON Schemas, types, the loader (`loadNovel`) and story model, the validator, word counts, IDs, edits to YAML that keep comments and layout, three-way merge, diagram data and SVG snapshots, issue anchors and labels, the compiler's book model (`compileBook`), and comparing two states of a novel with a word-level diff (`compareNovels`). Runs in the browser and in Node. |
| [`editor`](packages/editor/README.md) | The prose editor: TipTap schema, lossless Markdown round-trip, the scene and chapter editors, mentions, find and replace, spell check, word counts and the conflict resolver. |
| [`client`](packages/client/README.md) | The browser side of the server: a typed API client and autosave. |
| [`server`](packages/server/README.md) | The local server: Hono API, library, file writes, background commits, sync, checkpoints, versions, comparisons, GitHub connection, issue cache and outbox, compile route. Its README documents the API. |
| [`web`](packages/web) | The app: library, writing view, story bible, diagrams, issues, command palette. React, react-query, zustand, Radix, cmdk and Tailwind. |
| [`export`](packages/export) | DOCX (hand-written WordprocessingML), EPUB 3 and PDF (pdfkit, with Liberation Serif) from a compiled book; zipped with fflate. |
| [`cli`](packages/cli) | `gh-writer serve`, `validate`, `snapshots`, `compile` and `new-id`, and the entry points bundled into novel repositories. |

Other folders:

- `templates/novel`: the template every new novel starts from, including its workflows and vendored tools.
- `examples/sample-novel`: *The Bridge at Varn*, the sample used by tests, screenshots and the playground.
- `docs/format/v1.md`: the format spec.
- `scripts/`: the bundler for vendored tools and the sample compile.

## Checks

| Command | Runs |
|---|---|
| `npm run typecheck` | TypeScript on every package |
| `npm test` | Vitest unit and integration tests (`packages/*/test`) |
| `npm run test:e2e` | Playwright: the editor playground, then the built web app against real servers |
| `npm run check` | typecheck and unit tests |

Run `npx playwright install chromium` in `packages/editor` once before the first e2e run. The web e2e tests run against the **built** app, so `npm run test:e2e` builds it first; if you run Playwright directly, run `npx vite build` in `packages/web` after changing the UI.

Each web e2e test starts its own `gh-writer serve` on a temp copy of the sample novel (`packages/web/e2e/fixtures.ts`), with a fake GitHub (`packages/server/test/fake-github.ts`) that serves the REST API, the device flow and git over HTTP. Most views also run an [axe](https://github.com/dequelabs/axe-core) audit, many in both light and dark themes; new UI should too. Performance benchmarks (`*.performance.spec.ts`) run after the rest, one at a time.

CI (`.github/workflows/ci.yml`) runs typecheck, unit tests, validation of the sample novel, epubcheck on the sample's EPUB, and every e2e test.

## The novel template's tools

Novel repositories can't install gh-writer, so the template carries its tools as single-file esbuild bundles in `templates/novel/.github/gh-writer/`: `validate.mjs`, `snapshots.mjs`, and `compile.mjs` with its fonts. **After changing `core`, `export` or the CLI entry points, run `npm run build:template`**, which rebuilds them and redraws the template's and the sample's diagram snapshots. A test fails if the vendored bundles don't match the source.

The compiled files must be the same bytes in the app, on the command line and in a novel's GitHub Action. A test compiles a committed copy of the sample both ways, in different time zones, and compares them. Keep anything time-, zone- or platform-dependent out of the output: dates come from the commit, IDs from the novel, zip timestamps are written in UTC, and PDFs are compressed with fflate rather than Node's zlib.

`npm run screenshots -w @gh-writer/web` retakes the README's screenshots (`docs/screenshots/`) from the sample novel.

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
