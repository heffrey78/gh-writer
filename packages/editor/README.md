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

### Writing modes

| Keys | Mode |
|---|---|
| Mod+Shift+F | Focus mode: the app hides everything but the text |
| Mod+Shift+L | Typewriter scrolling: the caret line stays 40% of the way down |

Both editors include `WritingModesExtension`. The modes live in one store, `writingModes` (Zustand), shared by every editor and the app shell, and persist in local storage (they just don't persist where storage is blocked). React code reads them with `useWritingModes()`. The editor marks itself (`ghw-focus`, `ghw-typewriter`), but hiding chrome in focus mode is the app's job: `const focus = useWritingModes((m) => m.focus)`.

`writingModeCommands` describes each toggle for the command palette: an `id`, a `title`, default `keys`, `run(editor)` and `isActive()`. Running one returns focus to the text with the selection unchanged. A third command, with no default shortcut, dims every paragraph but the current one in focus mode. Dimming is off by default, because dimmed text falls below WCAG contrast.

Typewriter scrolling follows typing and keyboard movement, but not clicks, so the text doesn't jump out from under the pointer; the next keystroke recentres. Scrolling is instant, never animated. Ctrl+Shift+T and Ctrl+Alt+T were avoided as shortcuts: browsers reserve the first (reopen tab), and Linux desktops use the second for a terminal.

### Word counts

```tsx
import { WordCount } from "@gh-writer/editor/react";

<WordCount chapterWords={chapterTotal} />; // chapterWords only for a single-scene editor
```

`WordCount` shows the scene, chapter and session counts for the editor the writer last used, plus an optional session goal with a progress bar. When the goal is reached it shows a quiet "Goal reached", also announced once to screen readers. It hides in focus mode unless the count is pinned (the "Show the word count in focus mode" command). Give `SceneEditor` a `sceneId` so its scene is tracked in the session; chapter scenes carry their own IDs.

- **Words** are counted as core's `countWords` counts a scene's Markdown, so the editor, CLI and progress history agree. Punctuation and Markdown syntax never count, a mention counts as its visible name, a hyphenated word counts once, and words joined by dashes count separately. The count uses `Intl.Segmenter`, so non-Latin scripts split properly.
- **Live counting is incremental.** Counts are cached per node, and ProseMirror reuses untouched nodes, so a keystroke recounts one paragraph. Counts are published at most once per frame.
- **The session** lasts as long as the browser tab and survives reloads (`sessionStorage`). Session words are the net change since each scene was first opened in the session, so they go negative after cutting. `sessionCommands` has "Start a new writing session". The goal carries over to new sessions (`localStorage`).

The counts are also available headless: `countNode`, `documentCounts`, and the `liveCounts` and `writingSession` stores.

### Find and replace

```tsx
import { FindReplace } from "@gh-writer/editor/react";

<FindReplace
  manuscript={chapters.map((c) => ({ id: c.id, title: c.title, scenes: c.scenes.map((s) => ({ id: s.id, title: s.title, markdown: s.body })) }))}
  editor={editor}
  onReplace={(changed) => changed.forEach(({ id, markdown }) => save(id, markdown))}
  onOpenScene={(sceneId) => openSceneOrItsChapter(sceneId)}
/>;
```

| Keys | Does |
|---|---|
| Mod+F | Find in the scene, starting from the selected text |
| Mod+Shift+H | Find and replace in the whole manuscript |
| Enter, Shift+Enter | Next and previous match |
| Alt+Enter | Replace all |
| Escape | Close and return to the text |

The panel searches the scene holding the caret, its chapter or the whole manuscript, with options for case, whole words and regular expressions (`$1`, `$<name>` and `$&` in replacements). Results are grouped by chapter and scene in reading order. Choosing a result in a scene that isn't open calls `onOpenScene`, and the panel selects the match once the editor holds that scene.

- **What is searched:** each paragraph's visible text, so a match can run across italics or bold, and a mention matches on its name. Front matter, mention IDs and raw inline Markdown never match.
- **Open scenes are searched live** in the editor's document, including unsaved edits. Other scenes are parsed from the Markdown in `manuscript`.
- **Replacing in the open document** is a single editor transaction, undone with Mod+Z. Closed scenes get new Markdown through `onReplace`. "Replace all" also offers one Undo for everything, which restores the closed scenes and undoes the editor's step if nothing has happened there since. Scenes without matches aren't touched, and within a changed scene only the matching paragraphs are rewritten.
- **Mentions:** replacing a mention's whole name renames the mention and keeps its link to the entity. A match on part of a name can be found but not replaced.

`findCommands` has "Find in scene", "Find in chapter" and "Find and replace in manuscript" for the palette, and both editors include `FindExtension` (the shortcuts) and `SearchHighlightExtension`. Headless, `searchManuscript`, `replaceAll`, `replaceInMarkdown` and `replaceInEditor` do the work.

### Spell check

```tsx
import { createWorkerSpellService } from "@gh-writer/editor";
import { addToDictionary, knownWords, readDictionary } from "@gh-writer/core/dictionary";

const spell = createWorkerSpellService({ aff, dic }, knownWords(novel, await readDictionary(source)));
<SceneEditor spell={{ service: spell, onAddWord: (word) => saveDictionary(addToDictionary(dictionaryText, word)) }} />;
```

Misspelled words are underlined as an inline decoration with `aria-invalid="spelling"`. Mod+. (or a right-click) opens a menu of suggestions, with "Add to dictionary" and "Ignore". In the menu, arrows move, Enter chooses and Escape returns to the text. The "Spell check" command turns checking off and on; the setting persists with the writing modes.

- **Engine:** nspell, a Hunspell-compatible checker, running in a Web Worker. The browser's own checker can't learn the story's names, has no API for suggestions and differs between webviews. The app supplies the Hunspell dictionary (`aff` and `dic` text); the playground uses `dictionary-en`, which is US English. `createLocalSpellService` runs the same engine on the main thread, for tests.
- **Known words:** every word of the bible's names and aliases, plus the novel's `dictionary.txt` (see the [format spec](../../docs/format/v1.md)), from `knownWords` in `@gh-writer/core/dictionary`. "Add to dictionary" calls `onAddWord`, for the app to save with `addToDictionary`, which inserts in sorted order so the change is one line. "Ignore" lasts the session. Possessives of known words ("Mirela's") are accepted.
- **Not checked:** mention labels, raw Markdown, words with digits, underscores or dots (numbers, IDs, abbreviations), and single letters.
- **Cost:** paragraphs are checked after typing pauses (500 ms), and only those that changed, because results are cached per node. On the 10,600-word chapter benchmark, the 95th-percentile keystroke latency with spell check on is 21 ms.

### Chapter view

```tsx
import { ChapterEditor } from "@gh-writer/editor/react";

<ChapterEditor
  key={chapter.id}
  scenes={chapter.scenes.map((s) => ({ id: s.id, title: s.title, markdown: s.body }))}
  onChange={(changed) => changed.forEach(({ id, markdown }) => save(id, markdown))}
/>;
```

`ChapterEditor` shows a chapter's scenes as one continuous text, with each scene's title at its boundary, while every scene stays its own file. `onChange` receives only the scenes whose body changed. Untouched scenes aren't even serialized, because ProseMirror reuses their nodes, and their files stay byte-identical.

The caret moves freely across scene boundaries, but ordinary editing can't merge, split or delete scenes:
- Backspace at a scene's start and Delete at its end do nothing (scene nodes are isolating).
- Deleting or typing over a selection that spans scenes edits each scene's part separately. A scene that is entirely selected keeps one empty paragraph.
- Any other transaction that would change which scenes there are is rejected, unless it carries the `SCENE_STRUCTURE` meta. That covers cutting, pasting or Enter over a multi-scene selection, which therefore do nothing.

A changed `markdown` for one scene (say the file changed on disk) replaces that scene in place, keeping the rest of the chapter, the selection and the undo history. A different set or order of scenes reloads the chapter.

The headless pieces are `chapterContent` (the extensions, with `chapter` as the top node), `parseChapter`, `serializeChapter`, `touchedScenes`, `loadChapter`, `replaceScene` and `deleteAcrossScenes`.

**Performance:** the target is under 50 ms from keystroke to render on a 10,000-word chapter. `e2e/latency.spec.ts` types into the middle of a generated 10,600-word chapter in the dev build and fails if the 95th percentile reaches 50 ms. Measured: p50 4.4 ms and p95 18.6 ms, or p50 14.3 ms and p95 22.4 ms with the CPU throttled 4×. Opening a chapter parses every scene (about 140 ms for 10,000 words), and serializing happens only after typing pauses, only for touched scenes.

### Playground

`npm run playground -w @gh-writer/editor` serves a test page with every sample-novel scene and chapter, a formatting sampler and a generated 10,000-word chapter, beside a live view of each file as it would be saved. `npm run test:e2e` runs the Playwright tests against it, including an axe accessibility audit. Run `npx playwright install chromium` in this package once first.

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
