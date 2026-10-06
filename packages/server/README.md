# @gh-writer/server

The local gh-writer server: a [Hono](https://hono.dev) API on Node that reads and writes a novel repository on the author's machine. `gh-writer serve` starts it.

```ts
import { createServer, Library } from "@gh-writer/server";

const library = await Library.open(); // library.json in the user config directory
const novel = await library.add("/path/to/novel");
const server = await createServer({ library }); // token and port: random by default
console.log(server.launchUrlFor(`/novels/${novel.id}`)); // http://127.0.0.1:41234/novels/lib_…?token=…
await server.close();
```

| Endpoint | Session needed | Returns |
|---|---|---|
| `GET /api/health` | yes | `{ status: "ok" }` |
| `GET /api/session` | no | `{ authenticated }`: whether the request carries a valid session cookie |
| `GET /api/library` | yes | `{ novels, notices }` |
| `POST /api/library` | yes | `{ path }` → `201 { novel }`, or `400 { code, error }` |
| `DELETE /api/library/:id` | yes | `204`: forgets the novel; its folder is left alone |
| `POST /api/library/clone` | yes | `{ repo, path? }` → an event stream (below) |
| `GET /api/novels/:id` | yes | `{ novel, files }`: the story model (core `loadNovel`) and the hash of each file it was read from |
| `GET /api/novels/:id/files/<path>` | yes | `{ path, content, hash }` |
| `PUT /api/novels/:id/files/<path>` | yes | `{ content, base }` → `{ hash }`, or `409 { current }` |
| `GET /api/novels/:id/events` | yes | an event stream of changes made outside the app, and of the sync status (below) |
| `GET /api/novels/:id/sync` | yes | the sync status: `{ state, remote, branch, ahead, behind, lastSync, conflict?, error?, commit }` |
| `POST /api/novels/:id/sync` | yes | syncs now, then answers with the status |
| `GET /api/novels/:id/checkpoints` | yes | `{ checkpoints }`, newest first |
| `POST /api/novels/:id/checkpoints` | yes | `{ name }` → `201 { checkpoint }` |
| `POST /api/novels/:id/checkpoints/:checkpoint/restore` | yes | `{ sceneId? }` → `{ undo, commit, files }` |
| `GET /api/novels/:id/conflicts` | yes | `{ conflicts }`: what a sync conflict leaves to settle, or `null` |
| `POST /api/novels/:id/conflicts/resolve` | yes | `{ upstream, files }` → the sync status, or `409 STALE { conflicts }` |

Routes added to `server.app` (before its first request) or in `createApp` sit behind the same security middleware.

`createServer({ web })` serves the built app ([packages/web](../web/README.md)) from that folder at every other path. Hashed files under `/assets/` are cached for good. Every other path gets `index.html`, never cached and sent with a strict Content Security Policy (`CONTENT_SECURITY_POLICY`), and the app routes itself. Unknown `/api` paths and missing build files are 404s, and nothing outside the folder is ever served. Without `web`, a placeholder page answers. `gh-writer serve` passes `packages/web/dist` when it has been built.

## Library

The library is the author's list of novels: `library.json` in the user config directory. That's `$XDG_CONFIG_HOME/gh-writer` (or `~/.config/gh-writer`) on Linux, `~/Library/Application Support/gh-writer` on macOS and `%APPDATA%\gh-writer` on Windows. `GH_WRITER_CONFIG_DIR` overrides it. Each entry has an `id` (`lib_…`), its `path`, the `title` from novel.yaml, the `remote` (origin, with any credentials stripped out of the URL) and `lastOpened`. `list()` returns the most recently opened first. The file is replaced atomically on every change.

- **Adding** a folder checks that it's a folder (`NOT_A_DIRECTORY`), inside a git work tree (`NOT_A_REPO`) and holds novel.yaml (`NOT_A_NOVEL`). Adding a folder that's already there refreshes its entry.
- **Missing folders** are dropped whenever the library is read, at startup or later. Each drop leaves a `MISSING` notice in `notices` for the server's lifetime. An unreadable library.json is set aside (`UNREADABLE` notice, with the backup's path) and the library starts empty.
- **Cloning** takes `owner/name` (GitHub over https), an `https://`, `ssh://`, `git://` or `file://` URL, or `git@host:path`. Anything else, including anything git could read as an option, is `BAD_REPO`. The clone goes to `path`, or by default to `~/gh-writer/<name>`. A destination with files in it is refused (`DESTINATION_EXISTS`) and never touched. A failed clone, or a clone that turns out not to be a novel, leaves no folder behind.

The clone endpoint answers with `text/event-stream`. It sends `progress` events (`{ stage, progress, processed, total }`, from git's own progress), then either `done` with `{ novel }`, or `error` with `{ code, error, detail? }`. Closing the request aborts the clone.

### git and credentials

The library uses the system git through simple-git and the author's own git setup: credential helpers (`gh auth setup-git`, Git Credential Manager) and SSH keys. GitHub sign-in inside the app comes with #8. The author's environment passes to git whole. simple-git would otherwise strip `GIT_*` variables such as `GIT_SSH_COMMAND`. git must never wait for input in the terminal the server runs in. So `GIT_TERMINAL_PROMPT=0`, and ssh runs with `BatchMode=yes` unless the author set `GIT_SSH_COMMAND` or `GIT_SSH`. That means a missing credential fails at once.

Failures are classified into stable codes with a message that says what to do; git's own output is in `detail`:

| Code | When | Message says |
|---|---|---|
| `AUTH` | no or rejected credentials, publickey denied, HTTP 401/403 | run `gh auth setup-git`, or add an SSH key to GitHub |
| `NOT_FOUND` | no repository at the address | check the owner and name, and access |
| `NETWORK` | DNS, refused or timed-out connections | check the connection |
| `REJECTED` | a push refused because the remote has newer commits | (sync brings them in and pushes again) |
| `DESTINATION_EXISTS` | the target folder has files | choose another folder |
| `GIT_MISSING` | git isn't installed | install git |
| `GIT` | anything else | git's last line |

## Novel files

Files are addressed by their repository-relative path, percent-encoded after `/files/`. A path must be plain and relative. Anything else is a `400 BAD_PATH`:

- absolute paths, drive letters and backslashes
- empty, `.` or `..` segments
- hidden segments (`.git`, `.github`, temp files) and `node_modules`
- NUL characters
- symlinks, and folders that resolve outside the novel

Reading serves any such file that is UTF-8 (`415 NOT_TEXT` otherwise). Writing takes `.md`, `.markdown`, `.yaml`, `.yml`, `.txt` and `.json` only, as well-formed Unicode. Files are limited to 2 MB (`413 TOO_LARGE`).

**Stale-write protection.** A file's `hash` is the SHA-256 of its bytes, in hex. A PUT sends `base`: the hash the client last read, or `null` for a file it expects not to exist. If the file on disk differs, nothing is written. The answer is `409 CONFLICT` with `current` (the file's `content` and `hash`, or `null` if it's gone), for the client to merge. Writes to one path run one at a time, so two writes from the same base can't both succeed.

**Atomic writes.** The text goes to a temp file in the same folder (`.<name>.<random>.ghw-tmp`) and is fsynced. The temp file is renamed over the target, then the folder is fsynced so the rename itself is durable (Windows skips the folder fsync). A crash leaves the old file or the new one, never a truncated one. A crash between the two steps can leave the temp file behind; it's hidden from the API and the watcher. The file keeps its permissions, and missing folders are created.

**Live changes.** `GET /api/novels/:id/events` starts a chokidar watcher on the novel (one per novel, shared, closed when the last stream ends). It sends `ready` once the watcher is live. Read anything you need after `ready`, so no change can slip between the read and the stream. Each change to a visible file is then a `file` event: `{ type: "add" | "change" | "unlink", path, hash }`, with `hash` null once the file is gone. The server's own writes aren't echoed: a change whose content matches what the server last wrote to that path is dropped. A `sync` event carries the [sync status](#sync), right after `ready` and whenever it changes. A comment line every 25 s keeps the stream open. Closing the server ends every stream.

## Background commits

Each novel has a committer that turns saved work into git history without the author running git. Every successful write restarts a quiet timer. After 2 minutes without a save, or at the latest 10 minutes after the first save since the last commit, it commits:

1. **Merges and rebases.** It doesn't commit while a merge, rebase, cherry-pick or revert is in progress (`MERGE_HEAD`, `rebase-merge`… or unmerged index entries). It waits, and tries again after the next quiet period.
2. **Identity.** It doesn't commit without a git identity (`user.name` and `user.email`, or the `GIT_AUTHOR_*` variables). The status asks the author to set one.
3. **Staging.** `git add -A` stages the novel's folder only, respecting `.gitignore`. Leftover `.*.ghw-tmp` files are excluded.
4. **Committing.** `git commit --no-verify -- .` commits the folder only. Anything the author staged elsewhere in the repository stays staged. Nothing is committed when nothing changed. The author's identity and signing settings apply; their commit hooks don't, so a background save can't be stopped by them.

The summary line names what changed and the net change in manuscript words, from core's `countWords`, for example:

- `Draft: The Station, Walking the Span (+214 words)`
- `New scene: Dawn (+40 words)`
- `Remove scene: The Station (-312 words)`
- `Bible: Ada Varn`
- `Update novel.yaml`

Several kinds join with `; `, and more than three names become "and N more". The body lists each file with its status and word change.

The [sync status](#sync) reports it as `commit`:

- `idle`: nothing waiting.
- `pending`: saves are waiting for the timer.
- `committing`: a commit is under way.
- `blocked`: a commit was refused. `blocked` holds `MERGE`, `IDENTITY` or `ERROR`, and a message.

It also reports `pendingChanges`, the number of files in the novel that differ from the last commit, and `lastCommit` (`{ hash, summary, date }`). Closing the server commits whatever is still waiting, after the last write has finished. `createServer({ commit: { quietMs, maxMs } })` changes the timing, and `commit: false` turns background commits off.

## Sync

Each novel with a remote is kept in step with it: once when it's opened, every 5 minutes, and on `POST /sync`. One sync runs at a time per novel; a request during one waits for it. A sync:

1. **Commits** saved work (the [committer](#background-commits) above, without waiting for its timer).
2. **Fetches** from the remote. It's the branch's upstream remote, or `origin`, or the only remote. With none, the state is `local` and nothing else happens.
3. **Brings remote changes in.** Writes to the novel wait for this step, and saves made during the fetch are committed first. With no local commits to keep, it fast-forwards. Otherwise the merge is tried in memory first (`git merge-tree`):
   - **Clean:** local commits are rebased onto the remote's, so a solo author's history stays linear. If the rebase stops on a commit, it's aborted and the two tips are merged instead.
   - **Conflicts for git:** each file git couldn't merge is merged again by core's `merge3`, paragraph by paragraph and front matter field by field. If that settles every file, the result is committed as a merge (both sides as parents), with a message naming the files.
   - **Real conflicts**, the same paragraph or field changed on both sides: nothing in the work tree is touched. The state is `conflict`, with the files, until the author [resolves](#conflicts) it. Local commits are always kept.
4. **Pushes** to the branch's upstream, setting it up on the first push. If the remote moved during the sync, its changes are brought in and the push is tried again, up to three times.

[Checkpoint](#checkpoints) tags are fetched with the branch every time. They're pushed with it on the first sync of a session and after a checkpoint is made, even when there are no commits to push.

The work tree changes in step 3 reach the editor as `file` events, like any outside change. A save based on the old version gets a `409`, so unsaved text is never overwritten.

| State | Means |
|---|---|
| `synced` | the remote has everything, and this copy has everything from the remote |
| `syncing` | a sync is under way |
| `ahead`, `behind` | `ahead` local commits aren't pushed yet, or `behind` remote commits aren't brought in (as of the last fetch) |
| `local` | there's no remote |
| `offline` | the remote couldn't be reached. Writing and committing go on, and the sync is retried after 15 s, doubling up to the interval. |
| `needs-sign-in` | the remote refused the credentials (`AUTH`, with what to do). Retried at the normal interval. |
| `conflict` | the same paragraph or field changed on both sides; `conflict.files` lists the files |
| `error` | anything else, in `error`: `DETACHED` (not on a branch), `BUSY` (a merge or rebase of the author's is in progress), or a [git code](#git-and-credentials) |

`ahead` and `behind` are always counted, whatever the state. `lastSync` is when the last sync finished cleanly. `createServer({ sync: { intervalMs, retryMs } })` changes the timing. `intervalMs: 0` syncs only on demand (`gh-writer serve --sync-every 0`), and `sync: false` turns syncing off: the state is then `off`.

## Conflicts

While the state is `conflict`, `GET /conflicts` merges again, against the remote as last fetched, and returns what's left to settle:

```json
{ "upstream": "<remote commit>", "files": [{ "path": "manuscript/…/01-the-station.md", "ours": "<hash>", "inOurs": true, "inTheirs": true, "binary": false, "chunks": [] }] }
```

`chunks` is core's `merge3` result: `same` text, and `conflict` chunks with `base`, `ours` and `theirs` (and `field` for a front matter field). `ours` is the hash of this copy's file, as the files API reports it. A file one side deleted, or one that isn't text, has a single whole-file conflict. The editor's `ConflictResolver` shows them.

`POST /conflicts/resolve` takes `{ upstream, files }`, with a resolution for every file listed, by path:

- `{ ours, content }`: the file's new text (core's `resolveMerge(chunks, choices)`), or `null` to delete it.
- `{ ours, keep: "ours" | "theirs" }`: one side's file as it is, deleted if that side deleted it. The only choice for a binary file.

The merge is committed with both sides as parents, the branch and work tree move to it, and a sync pushes it. The answer is the sync status. Nothing happens if things changed since the conflicts were read. That covers the remote moving on, or a listed file changing because the author kept writing. The answer is then `409 STALE` with the fresh `conflicts`, to show again. Other answers: `400 BAD_RESOLUTION` (a file missing or extra, text for a binary file) and `409 NO_CONFLICT`.

Leaving a conflict alone is safe: local work stays committed, the remote's is in the remote-tracking branch, and every sync checks again. Writing goes on meanwhile; files outside the conflict sync as soon as it's resolved.

## Checkpoints

A checkpoint is a named point to come back to before a risky revision: an annotated tag `checkpoint/<time>-<slug>` with the name and the manuscript's word count (format spec v1, "Checkpoints").

- **Making one** commits saved work first, so the checkpoint holds everything written up to it. It's refused (`409 BLOCKED`) when that commit can't be made: no git identity, or a merge in progress. The name is 1 to 200 characters (`400 BAD_NAME`).
- **The list** is newest first: `{ id, name, date, words, auto, commit }`. `id` is the tag without `checkpoint/`, used in URLs. `auto` marks the ones taken before a restore.
- **Restoring** brings back `manuscript/` and `bible/` as they were at the checkpoint. Files added since are removed, and everything else in the repository is left alone. With `sceneId`, only that scene comes back. It's found by its ID, so a scene that moved to another chapter since is restored where it is now, with the chapters' order files untouched. A scene deleted since comes back where it was. The restore is committed as `Restore the manuscript from checkpoint “…”` or `Restore scene “…” from checkpoint “…”`. Writes wait while it runs. The changed files reach the editor as `file` events.
- **Undo.** Every restore first takes an automatic checkpoint, "Before restoring … from “…”", and returns it as `undo`. Restoring `undo` returns the manuscript to exactly where it was, including work saved but not yet committed. That restore takes its own checkpoint, so it can be undone too.

`404 NOT_FOUND` is an unknown checkpoint, and `404 SCENE_NOT_FOUND` a scene the checkpoint doesn't have.

## Operations

Changes to the story's structure touch several files and must land whole. `transaction(root, writes, message)` (`src/operations.ts`) is how they do:

1. **No identity, no change.** Without a git identity it changes nothing (`409 BLOCKED`).
2. **Checks first.** Each file is checked against the hash its caller read (`409 STALE { path }`).
3. **Writes.** Each file is written atomically. If any write fails, the ones already made are put back.
4. **One commit.** Only those paths are committed, with a message naming the change. Other saved work is left for the background committer.

Operations run in the workspace's exclusive section, so saves wait for them. They read the novel afresh, and edit YAML and front matter with core's `editYaml`/`editFrontMatter`, which change only the fields involved.

### Story bible

| Endpoint | Does | Commit |
|---|---|---|
| `POST /bible/entities` `{ type, name, …fields, notes? }` | Adds an entity of any type, built-in or custom, with a new ID, as `bible/<folder>/<slug>.md` | `Bible: add Ilse Varn` |
| `PATCH /bible/entities/:id` `{ base, changes }` | Edits fields (`null` removes one). A new name moves the file to match, and nothing else changes. | `Bible: rename Ada Varn to Ada Kost` / `Bible: edit …` |
| `POST /bible/entities/:id/delete` `{ base, confirm? }` | Deletes the file. If anything refers to the entity, it's refused (`409 REFERENCED { references }`: scenes and how, relationships, events) unless `confirm`. References are then left for the validator to report. | `Bible: remove …` |
| `POST /bible/relationships` `{ from, to, type, since?, until?, note? }` | Adds a relationship (checked: entities, type, scenes, `since` before `until`) | `Bible: Ada Varn allies Mirela Kost` |
| `PATCH /bible/relationships/:id` `{ changes }` | Edits it in place | |
| `POST /bible/relationships/:id/change` `{ at, type?, note? }` | From scene `at` on, it's different: the record ends there and a new one starts there, running as long as the old one did | `… becomes rivals at “The Betrayal”` |
| `POST /bible/relationships/:id/end` `{ at }` | It no longer holds from scene `at` | |
| `POST /bible/relationships/:id/delete` | Removes the record | |
| `POST /bible/entity-types`, `PATCH /bible/entity-types/:key` | Custom entity types in novel.yaml: key, prefix (unique, not reserved), label, folder, colour | `Bible: add the Vehicle type` |
| `POST /bible/relationship-types`, `PATCH /bible/relationship-types/:key` | Relationship types: label, inverse label, symmetric, the entity types at each end | |

All are under `/api/novels/:id`. Other refusals are `400 BAD_REQUEST` (with what's wrong) and `404 NOT_FOUND`.

### Manuscript

| Endpoint | Does | Commit |
|---|---|---|
| `POST /manuscript/scenes` `{ chapter, title, after? }` | A new scene (status `idea`) after `after` (`null`: first; omitted: last) | `Manuscript: add scene “…”` |
| `POST /manuscript/chapters` `{ part, title?, after? }`, `POST /manuscript/parts` `{ title, after? }` | A new, empty chapter (in a part, or at the top of a book in chapters) or part | `Manuscript: add chapter “…”` |
| `POST /manuscript/items/:id/rename` `{ title }` | A new title; the file or folder name follows (its number stays) | `Manuscript: rename scene to “…”` |
| `POST /manuscript/items/:id/move` `{ to?, index }` | To position `index` in a chapter (a scene), a part (a chapter), or among parts; `to` omitted: a reorder in place | `Manuscript: move scene “…”` |
| `POST /manuscript/scenes/:id/split` `{ paragraph, title }` | Before paragraph `paragraph` (0-based): the rest becomes a new scene right after, keeping status, point of view, people, places, plotlines, themes and tags | `Manuscript: split “…”, the rest as “…”` |
| `POST /manuscript/scenes/:id/merge` | With the next scene in its chapter: its prose follows, its people and places join, and relationships that started or ended at it move to the merged scene | `Manuscript: merge “…” into “…”` |
| `POST /manuscript/items/:id/delete` | Deletes a scene, or a chapter or part with everything in it | `Manuscript: delete scene “…”` |
| `GET /manuscript/deleted` | `{ deleted }`: scenes, chapters and parts deleted from the manuscript (by any commit), newest first, that aren't back already | |
| `POST /manuscript/deleted/restore` `{ commit, id }` | Brings one back, from just before `commit` deleted it, after the sibling it followed (if that's still there) | `Manuscript: restore scene “…”` |

IDs never change, so references never break. Order files are edited in place. After each operation, the numbered names of the files and folders involved follow the order. Only the number changes, except for a renamed item, which takes its new slug. So moving a scene to another chapter edits two order files, and every other change is a pure rename (git's similarity 100%). Reading order (core's `novel.scenes`) is the order files' order; that's the order a compiled manuscript (#19) will use.

## Security model

The server can read and write the author's files, and a git push from it reaches GitHub. Its job is to answer only the author's own gh-writer tab. The threats are other web pages open in the same browser and other machines on the network. Local processes are out of scope: they can read the files directly.

**Bound to loopback.** The server listens on `127.0.0.1` only, so other machines can't connect. The port is random by default (`--port` fixes it).

**A per-launch secret.** Each launch makes a fresh 256-bit token (`crypto.randomBytes`), which only the printed and opened launch URL carries. The first request with `?token=` trades it for a session cookie, then redirects to the same URL without the token, so it leaves the address bar and history. Before the redirect the server sets `Referrer-Policy: no-referrer` and `Cache-Control: no-store`. The cookie is:

- `HttpOnly`, so page scripts can't read it.
- `SameSite=Strict`, so a cross-site page can't make the browser send it.
- Named `ghw_session_<port>`. Cookies aren't scoped by port, so two servers mustn't overwrite each other's session.

The token stays valid for the server's lifetime: opening the launch URL again (another browser, a restored tab) starts another session. Tokens are compared in constant time.

Every request then passes these checks, in order. Each failure is a `403` with `{ error }`:

1. **Host allow-list.** The `Host` header must be exactly `127.0.0.1:<port>` or `localhost:<port>`. This defeats DNS rebinding: a page on `evil.example` whose name is re-pointed at 127.0.0.1 still sends `Host: evil.example`. No path is exempt, including the token exchange and `/api/session`.
2. **Fetch metadata.** A `Sec-Fetch-Site` header other than `same-origin` or `none` (a navigation the user started, such as the launch URL) is rejected. `same-site` is rejected too, since every port on localhost is the same site. This stops a page on another localhost port from sending no-cors requests that would carry the session cookie.
3. **Origin.** A present `Origin` must be `http://127.0.0.1:<port>` or `http://localhost:<port>`. `Origin` is *required* on every request except GET and HEAD, and on every WebSocket handshake (`Upgrade`): browsers always send it there, so a missing one means a page we can't vouch for. Same-origin GETs, including `EventSource` streams, carry no `Origin`; those rely on checks 1, 2 and 4, and a cross-origin stream request, which does carry `Origin`, is rejected here.
4. **Session.** Every path except `/api/session` needs the session cookie. An unknown path without one gets a 403, not a 404.

GET and HEAD must not change state: the server doesn't require `Origin` on them, because browsers leave it out of same-origin GETs.

## Shutdown

`close()` stops accepting connections, lets in-flight requests finish (a write in progress completes), then resolves. Idle keep-alive connections are closed at once, and busy ones as soon as their response is sent. After `shutdownTimeout` (10 s by default), any remaining connections are cut. `gh-writer serve` calls it on SIGINT or SIGTERM. A second signal exits at once.
