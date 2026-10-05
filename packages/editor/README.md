# @gh-writer/editor

The prose editor's document model: a ProseMirror schema for scene prose, and a lossless round-trip between it and the Markdown in a novel repository ([format spec](../../docs/format/v1.md)).

```ts
import { joinSceneFile, parseProse, serializeProse, splitSceneFile } from "@gh-writer/editor";

const scene = splitSceneFile(fileText);          // front matter is kept byte for byte
const doc = parseProse(scene.body);              // ProseMirror document
// ... edit doc ...
const saved = joinSceneFile({ ...scene, body: serializeProse(doc) });
```

## Schema

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

## Round-trip guarantees

**Unedited content is saved byte for byte**, whatever syntax it uses. Each top-level block keeps its original source and the whitespace before it, and is written back verbatim while its content is unchanged. This is tested against every Markdown file in the sample novel, the template and the format spec, a fixture for each github.com-style variation, and random Markdown.

Blocks parsed by `parseProse` are recognised as unchanged by node identity, which ProseMirror keeps for untouched nodes. A document rebuilt from JSON loses that, and each block's source is re-parsed to check it instead. That is slower and, in rare context-dependent cases (such as a block that is only `-`), treats a block as edited. **Hand the editor the parsed `Node`, not its JSON.**

**Edited and new blocks are written in canonical syntax.** They parse back to the same content, which is tested on random documents, and they keep the block's emphasis markers (`*` or `_`) and hard-break style, falling back to the scene's. Editing a block normalises it:

- A hard-wrapped paragraph becomes one line.
- Escapes and character references are rewritten as needed (`&mdash;` becomes `—`, `\_` may become `_` where it's safe).
- Whitespace Markdown can't keep is dropped: at the start and end of a paragraph, around line breaks, and line breaks at a paragraph's edges.
- Spaces at the edges of emphasis move outside it.
- Backslashes in text are escaped (`\\`).
- Empty paragraphs aren't written.
- A section break is always written `***`.
- A link whose text equals its URL may become `<url>`.

Lines that weren't edited are never touched, so a one-word change shows up as a one-line diff.
