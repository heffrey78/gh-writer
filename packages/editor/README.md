# @gh-writer/editor

The scene prose editor: a TipTap (ProseMirror) schema for scene prose, a lossless round-trip between it and the Markdown in a novel repository ([format spec](../../docs/format/v1.md)), and a React editor component.

## React component

```tsx
import { SceneEditor } from "@gh-writer/editor/react";
import "@gh-writer/editor/styles.css";

<SceneEditor key={scene.id} markdown={scene.body} onChange={(body) => save(scene.id, body)} />;
```

`markdown` is the scene body: the Markdown after the front matter (`splitSceneFile` separates them). `onChange` receives the new body once typing pauses (`changeDelay`, 300 ms by default), and straight away on blur, page hide and unmount. A new `markdown` value that isn't the editor's own output loads as a new document. Give each scene its own `key`, so that switching scenes reports pending edits for the scene they belong to. `onReady` hands you the TipTap editor for commands.

| Keys | Does |
|---|---|
| Mod+I, Mod+B | Italic, bold |
| Mod+Shift+B | Block quote |
| Mod+Enter | Section break |
| Shift+Enter | Line break |
| Mod+Z, Mod+Shift+Z | Undo, redo |

Mod is Cmd on macOS and Ctrl elsewhere. Typing Markdown also formats: `*word*` or `_word_` and a space for italic, `**word**` or `__word__` for bold, `> ` at the start of a paragraph for a quote, and `***`, `---` or `___` and a space for a section break. New emphasis is written with the scene's own markers (`*` unless the scene uses `_`).

Mentions are atoms: the caret steps over them, typing can't split them, and Backspace removes one whole. Raw Markdown blocks are edited as plain text.

The typography uses CSS custom properties (`--ghw-prose-font`, `--ghw-prose-measure`, `--ghw-ink`…) and follows the OS light or dark setting, or `data-theme` on the root element.

### Playground

`npm run playground -w @gh-writer/editor` serves a test page with every sample-novel scene and a formatting sampler, beside a live view of the file as it would be saved. `npm run test:e2e` runs the Playwright tests against it, including an axe accessibility audit. Run `npx playwright install chromium` in this package once first.

## Headless API

```ts
import { joinSceneFile, parseProse, serializeProse, splitSceneFile } from "@gh-writer/editor";

const scene = splitSceneFile(fileText);          // front matter is kept byte for byte
const doc = parseProse(scene.body);              // ProseMirror document
// ... edit doc ...
const saved = joinSceneFile({ ...scene, body: serializeProse(doc) });
```

### Schema

The TipTap extensions in `proseContent` define the schema, and `proseSchema` is built from them. An editor builds its own copy from the same extensions, so parse with `editor.schema` for documents it will hold.

| Node / mark | Markdown |
|---|---|
| `paragraph` | One paragraph per line |
| `blockquote` | `> ` |
| `horizontal_rule` | `***`, an in-scene section break |
| `hard_break` | Line ending with `\` or two spaces |
| `mention` (`id`, `label`) | `[Ada](#char_7f3k2q)`, a link to a bible entity ID |
| `em`, `strong`, `link` marks | `*em*`, `**strong**`, `[text](url)` |
| `raw_block` | Any other block (lists, headings, tables, code, HTML, footnote definitions…), edited as plain Markdown text |
| `raw_inline` | Any other inline syntax (code, images, strikethrough, HTML, reference links…), kept as an atom |

### Round-trip guarantees

**Unedited content is saved byte for byte**, whatever syntax it uses. Each top-level block keeps its original source and the whitespace before it, and is written back verbatim while its content is unchanged. This is tested against every Markdown file in the sample novel, the template and the format spec, a fixture for each github.com-style variation, and random Markdown.

Blocks parsed by `parseProse` are recognised as unchanged by node identity, which ProseMirror keeps for untouched nodes. A document rebuilt from JSON loses that, and each block's source is re-parsed to check it instead. That is slower and, in rare context-dependent cases (such as a block that is only `-`), treats a block as edited. **Hand the editor the parsed `Node`, not its JSON or HTML**: `loadMarkdown(editor, body)` and `setInitialMarkdown` (from `onBeforeCreate`) do this. `setContent` doesn't.

**Edited and new blocks are written in canonical syntax.** They parse back to the same content, which is tested on random documents, and they keep the block's emphasis markers (`*` or `_`) and hard-break style, falling back to the scene's. Editing a block normalises it:

- A hard-wrapped paragraph becomes one line.
- Escapes and character references are rewritten as needed (`&mdash;` becomes `—`, `\_` may become `_` where it's safe).
- Whitespace Markdown can't keep is dropped: at the start and end of a paragraph, around line breaks, and line breaks at a paragraph's edges.
- Spaces at the edges of emphasis move outside it.
- Backslashes in text are escaped (`\\`).
- Empty paragraphs aren't written.
- The file ends with a newline once its last block is edited, even if it had none.
- A section break is always written `***`.
- A link whose text equals its URL may become `<url>`.

Lines that weren't edited are never touched, so a one-word change shows up as a one-line diff.
