# gh-writer

**Plan and write a novel with GitHub.** gh-writer is a writing app that runs on your own computer and keeps your book as plain Markdown and YAML files in a git repository. You write in a calm, distraction-free editor; your story bible, outline and diagrams sit beside the text; and GitHub keeps every version, backs it up, and tracks the work around the book (plot holes, research, revision notes) as issues. You never have to type a git command.

![Writing a chapter in gh-writer, the manuscript tree on the left](docs/screenshots/writing.png)

## Features

### Write

- **A distraction-free editor** for scenes, or a whole chapter as one continuous text while each scene stays its own file. Focus mode, typewriter scrolling, word counts for the scene, chapter and session, and today's words against a daily goal.
- **Mentions.** Type `@` and a few letters to mention a character, place or anything else in the story bible. Hover over a mention (or press Alt+Enter) for a card showing who they are and how they relate to everyone else *at that point in the story*.
- **A sidebar beside the text**: the scene the caret is in as a readable card, each detail edited in place, with what the rest of the book says about it ("8 h after “The Station”", "First appearance of Ben Varn"); details pinned under every scene's title; and any story bible entry as its profile, with Back and Forward. Ctrl+Shift+\\ hides and shows it.
- **Quick entry.** Create a new character, location or entry of your own type straight from the `@` menu or the Scene card, without leaving the scene.
- **Spell check** that knows your characters' names, with a per-novel dictionary.
- **Progress** from the book's own history: words added and cut each day, the length against a target and deadline with a projected finish, a daily goal with a streak, and which chapters and scenes run long or short.
- **Find and replace** across the scene, the chapter or the whole manuscript, with one Undo for everything.
- **Autosave that doesn't lose words**, even if the app or the browser crashes, and conflicts shown side by side if a file changes elsewhere.

![A mention card: Ada Varn, her details, and her relationships at "The Station"](docs/screenshots/mention-card.png)

<table>
  <tr>
    <td><img src="docs/screenshots/scene-card.png" alt="The Scene card beside a chapter, with point of view and story time pinned under each scene's title"></td>
    <td><img src="docs/screenshots/entry-tab.png" alt="The Entry tab: Ada Varn's sheet beside the text"></td>
  </tr>
</table>

![Progress: the book against its target, today's words and streak, and the words per day](docs/screenshots/progress.png)

### Plan

- **Manuscript structure**: parts, chapters and scenes in a tree you can rearrange with the keyboard or by dragging, and an **outline** of every scene as a table or as index cards, filtered by point of view, character, plotline or status.
- **A story bible** of characters, locations, plotlines, themes and types you invent, as a gallery of cards and a profile for each entry, read first and edited in place: where it is across the book, scene by scene; a plotline's beats (and the ones still to write); and its relationships as arcs that start and end at particular scenes, in colours you choose from a palette that stays readable for colour-blind readers. The same relationships are drawn as a **relationship graph** with a slider to step through the story and watch alliances change.
- **A story map** of the story's elements against its scenes, all exportable as SVG (and some as Mermaid):
  - **plotlines** showing each one's beats scene by scene, and where one goes quiet;
  - **presence** of characters and themes in each scene;
  - a **timeline** setting story time against reading order, flashbacks and off-page events included.

<table>
  <tr>
    <td><img src="docs/screenshots/gallery.png" alt="The story bible as a gallery of cards, each with a strip of the scenes the entry is in"></td>
    <td><img src="docs/screenshots/bible.png" alt="Ada Varn's profile: her scenes in reading order and her relationships as arcs"></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/outline-cards.png" alt="The outline as cards: scenes grouped by chapter"></td>
    <td><img src="docs/screenshots/relationships.png" alt="The relationship graph at the first scene"></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/plotlines.png" alt="The story map's plotlines: beats by scene"></td>
    <td><img src="docs/screenshots/timeline.png" alt="The timeline: story time against reading order"></td>
  </tr>
</table>

### Revise

- **Drafts** hold the book's history in one place: its versions, each with its checkpoints.
- **Checkpoints** are named moments in a version ("Before the big cut") to restore the whole manuscript, or one scene, from. Every restore can be undone.
- **Versions** let you try a different ending or a big cut alongside the main book, prose and story bible both. Switch between them whenever you like, then **adopt** one into the main version (what changed in the main version meanwhile is kept) or **bring single scenes across**, or discard it, kept in a checkpoint in case you want it back.
- **Compare** any two of now, a version and a checkpoint, the way an editor marks up a manuscript: deleted words struck through, inserted words underlined, scene by scene, with what changed in each scene's details, the story bible and the relationships, and word counts before and after.

<table>
  <tr>
    <td><img src="docs/screenshots/drafts.png" alt="Drafts: the open version with its checkpoint, and the main version with its own"></td>
    <td><img src="docs/screenshots/compare.png" alt="Comparing a version with the main one: changed words marked in the scene's text"></td>
  </tr>
</table>

### Work with GitHub

- **Sync** with a GitHub repository in the background: the manuscript, its checkpoints and its versions, so every computer you write on has them.
- **Sign in once in the app**; the token stays in your OS keychain. Start a new novel, clone one, or put a local novel on GitHub, all from the app.
- **Issues for the work around the book**: plot holes, continuity errors, research questions and revision notes, with kinds, labels for the characters, plotlines and themes involved, and milestones. Select a passage to raise an issue about it; a marker in the margin leads back to it. Changes made offline go to GitHub when it can be reached.
- **Diagram snapshots on github.com**: a workflow redraws the diagrams into the repository on every push, so they show up when you browse it.

![Issues in the app: kinds, labels for characters and plotlines, milestones](docs/screenshots/issues.png)

### Compile

- **Compile the manuscript**, or a range of chapters, to **Word** in standard manuscript format (ready for agents and editors), **EPUB** (checked by epubcheck) and **PDF**. Presets in `compile.yaml` set the title page, chapter headings, scene breaks, and front and back matter.
- **A Release for every named checkpoint**: a workflow in the novel's repository compiles the book and attaches the files. The same commit gives byte-identical files in the app and on GitHub.

### Your files, your way

Everything is in plain files: one Markdown file per scene, one per bible entry, YAML for structure and relationships. You can edit them on github.com or in any text editor, and a validator (run on every push) catches broken references. The format is specified in [docs/format/v2.md](docs/format/v2.md).

The app stays calm as it grows: a sidebar grouped by what you're doing (write, plan, world, revise) that folds away to icons, and a top bar with just the book, its version, save and sync status, and a ⋯ menu for the rest. It's keyboard-first and accessible: a command palette (Ctrl+K / ⌘K) reaches everything, every view works without a mouse, it follows your light or dark setting, and its screens are checked with axe in the test suite.

## Getting started

You need [Node.js](https://nodejs.org) 22.18 or later and [git](https://git-scm.com).

```sh
git clone https://github.com/heffrey78/gh-writer
cd gh-writer
npm install
npm run build
npx gh-writer serve
```

Your browser opens on your library, where you can start a new novel, open a folder or clone one from GitHub. To try the sample novel, *The Bridge at Varn*: `npx gh-writer serve examples/sample-novel`.

- **[USER.md](USER.md)**: the guide for writers: the library, writing, the story bible, diagrams, GitHub, compiling and the command line.
- **[DEVELOPER.md](DEVELOPER.md)**: the guide for contributors: architecture, packages, tests and conventions.

## Roadmap

Built so far: the repository format and template, local-first saving and sync, manuscript structure, the editor, the story bible, mentions, the app shell, GitHub sign-in, issues and passage notes, entity labels, quick entry, all four diagrams and their snapshots on github.com, compiling to DOCX, EPUB and PDF, versions with word-by-word comparison, and writing progress and goals.

Next, as tracked in [the project's issues](https://github.com/heffrey78/gh-writer/issues):

| Feature | What it adds |
|---|---|
| [Drafting pipeline on a GitHub Projects board](https://github.com/heffrey78/gh-writer/issues/11) | Each scene's status (outlined, drafted, revised, final), point of view and word count on a board, table and roadmap, kept in sync with the scene files. |
| [Editorial review through pull requests](https://github.com/heffrey78/gh-writer/issues/18) | Open a revision pass for review; editors comment on lines on github.com, and the comments appear in the editor's margin beside the passage. |

gh-writer isn't packaged yet: for now it runs from a clone of this repository, as above.

## License

[MIT](LICENSE.md). The bundled Liberation Serif fonts, used for PDFs, are under the SIL Open Font License 1.1.
