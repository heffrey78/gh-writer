# Untitled Novel

This novel uses the [gh-writer](https://github.com/heffrey78/gh-writer) format: plain Markdown and YAML files that you can edit in the gh-writer app, on github.com, or in any text editor.

## Where things go

| Path | What it holds |
|---|---|
| `novel.yaml` | Title, author, word target, and the kinds of relationships your story uses. |
| `dictionary.txt` | Words the spell checker should accept: invented words, dialect. Character and place names are known already. |
| `manuscript/` | The book. Each chapter is a folder with a `_chapter.yaml`; each scene is a `.md` file inside it. Add part folders with a `_part.yaml` if your book has parts. |
| `manuscript/_order.yaml`, `_part.yaml`, `_chapter.yaml` | **Reading order.** Moving a scene means moving its ID in these lists. The `01-` numbers in file names are just for tidy browsing. |
| `bible/characters/`, `locations/`, `plotlines/`, `themes/` | One file per character, place, plotline or theme. |
| `bible/relationships.yaml` | Who is related to whom, and from which scene a relationship starts or ends. |
| `bible/events.yaml` | Things that happen off the page: backstory, events between scenes. |
| `diagrams/layouts.yaml` | Positions of hand-arranged diagrams (maintained by the app). |
| `diagrams/README.md`, `diagrams/*.svg` | **Generated** snapshots of the diagrams: relationships, plotlines, who is in which scene, the timeline. Browse [diagrams/](diagrams/) to see them. |

GitHub **Issues** are for the work around the book: plot holes, continuity errors, research questions, ideas and revision notes. Story facts belong in the files above.

## Writing by hand

- Start every scene and bible file with a `---` front matter block, like the [opening scene](manuscript/01-chapter-one/01-opening.md).
- Keep each paragraph on **one line**, with a blank line between paragraphs. This keeps change history and review comments readable.
- Every record has an ID such as `char_7f3k2q`. Never change an ID; rename files and titles freely.
- Mention a character in prose as `[Ada](#char_7f3k2q)`.
- Don't use the letters `i`, `l`, `o` or `u` in the part after the underscore. The validator will tell you if an ID is malformed.

## Checking your work

Every push runs the **Validate novel** workflow, which reports broken references, files missing from the reading order, and similar problems. To run it locally:

```sh
node .github/gh-writer/validate.mjs
```

When you create a repository from this template, the **Set up novel** workflow replaces the template's placeholder IDs with fresh ones and sets the title from the repository name. If it didn't run, start it from the Actions tab, or run `node .github/gh-writer/init.mjs "Your Title"` and commit.

Every push that changes the story also runs the **Diagrams** workflow, which redraws the snapshots in `diagrams/` and commits them, so they stay current on github.com. To draw them locally: `node .github/gh-writer/snapshots.mjs`.

## Compiling the book

The **Compile** workflow makes the manuscript into a Word file in standard manuscript format, an EPUB e-book and a PDF. It runs for every named checkpoint you make in the gh-writer app, attaching the files to a Release named after it (under Releases on the repository page), and on demand from the Actions tab (choose a preset and a range of chapters; the files are kept with the run). Presets live in `compile.yaml`. To compile locally: `node .github/gh-writer/compile.mjs` (files go to `compiled/`).

The full format is specified in [docs/format/v1.md](https://github.com/heffrey78/gh-writer/blob/main/docs/format/v1.md).
