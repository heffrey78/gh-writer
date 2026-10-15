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
| `GET /api/app` | yes | `{ desktop, version, node, git: { version, bundled }, update }`: what's running; `update` is a newer release (`{ version, url, notes }`) or null. Only the desktop app (`GH_WRITER_APP_VERSION` set) checks, against GitHub's latest release, at most once a day (an hour after a failure) |
| `GET /api/app/licenses` | yes | `{ licenses: [{ name, text }] }`: the licence texts in `GH_WRITER_LICENSES`, which the desktop app sets; none otherwise |
| `GET /api/identity` | yes | `{ identity, suggestion }`: the name and email git signs with on this computer (`git config --global`), or null; and, signed in, the GitHub account's name (or login) and noreply address (`<id>+<login>@users.noreply.github.com`), or null |
| `PUT /api/identity` | yes | `{ name, email }`: set as git's global `user.name` and `user.email`, then any commit blocked for want of them (`IDENTITY`) is made; `400 BAD_IDENTITY` without a name or a valid address |
| `GET /api/library` | yes | `{ novels, notices, folder }`: `folder` is where new novels and clones go, with `~` for home; a novel with a cover has its version as `coverVersion` |
| `GET /api/library/:id/cover` | yes | the novel's cover image, for the shelf: read from its folder without opening the novel (which would start syncing it) |
| `POST /api/library` | yes | `{ path }` → `201 { novel }`, or `400 { code, error }` |
| `POST /api/library/new` | yes | `{ title, author?, path?, identity?: { name, email } }` → `201 { novel }`, or `400 { code, error }` |
| `DELETE /api/library/:id` | yes | `204`: forgets the novel; its folder is left alone |
| `POST /api/library/clone` | yes | `{ repo, path? }` → an event stream (below) |
| `GET /api/novels/:id` | yes | `{ novel, files, images }`: the story model (core `loadNovel`), the hash of each file it was read from, and a version of each picture it shows from `images/` (see [Pictures](#pictures)) |
| `GET /api/novels/:id/files/<path>` | yes | `{ path, content, hash }` |
| `PUT /api/novels/:id/files/<path>` | yes | `{ content, base }` → `{ hash }`, or `409 { current }` |
| `GET /api/novels/:id/images/<path>` | yes | the image at `images/<path>` (see [Pictures](#pictures)) |
| `GET /api/novels/:id/events` | yes | an event stream of changes made outside the app, and of the sync status (below) |
| `GET /api/novels/:id/sync` | yes | the sync status: `{ state, remote, branch, ahead, behind, lastSync, conflict?, error?, commit }` |
| `POST /api/novels/:id/sync` | yes | syncs now, then answers with the status |
| `GET /api/novels/:id/checkpoints` | yes | `{ checkpoints }`, newest first |
| `POST /api/novels/:id/checkpoints` | yes | `{ name }` → `201 { checkpoint }` |
| `POST /api/novels/:id/checkpoints/:checkpoint/restore` | yes | `{ sceneId? }` → `{ undo, commit, files }` |
| `GET /api/novels/:id/versions` | yes | `{ versions }`: the main version first, each with `{ id, name, main, current, remoteOnly, words, date, commit }` |
| `POST /api/novels/:id/versions` | yes | `{ name, from? }` → `201 { version }`: started from the open version (or checkpoint `from`) and opened |
| `POST /api/novels/:id/versions/:version/switch` | yes | `{ version }`: opened, saved work committed first |
| `DELETE /api/novels/:id/versions/:version` | yes | `{ checkpoint, current }`: kept as an automatic checkpoint, then deleted (on the remote at the next sync) |
| `POST /api/novels/:id/versions/:version/adopt` | yes | `{ checkpoint, commit, conflicts? }`: merged into the main version, which opens |
| `POST /api/novels/:id/versions/:version/adopt/resolve` | yes | `{ upstream, files }` → `{ commit }`, or `409 STALE { conflicts }` |
| `POST /api/novels/:id/versions/:version/scenes/:sceneId/bring` | yes | `{ undo, commit, files }`: the scene from that version, into the open one |
| `GET /api/novels/:id/compare?from=&to=` | yes | `{ comparison }`: each side `now`, `version:<id>` or `checkpoint:<id>` (core's `compareNovels`) |
| `GET /api/novels/:id/compare/scene/:sceneId?from=&to=` | yes | `{ paragraphs }`: the scene's text, word by word where reworded |
| `GET /api/novels/:id/conflicts` | yes | `{ conflicts }`: what a sync conflict leaves to settle, or `null` |
| `POST /api/novels/:id/conflicts/resolve` | yes | `{ upstream, files }` → the sync status, or `409 STALE { conflicts }` |

Routes added to `server.app` (before its first request) or in `createApp` sit behind the same security middleware.

`createServer({ web })` serves the built app ([packages/web](../web/README.md)) from that folder at every other path. Hashed files under `/assets/` are cached for good. Every other path gets `index.html`, never cached and sent with a strict Content Security Policy (`CONTENT_SECURITY_POLICY`), and the app routes itself. Unknown `/api` paths and missing build files are 404s, and nothing outside the folder is ever served. Without `web`, a placeholder page answers. `gh-writer serve` passes `packages/web/dist` when it has been built.

## Library

The library is the author's list of novels: `library.json` in the user config directory. That's `$XDG_CONFIG_HOME/gh-writer` (or `~/.config/gh-writer`) on Linux, `~/Library/Application Support/gh-writer` on macOS and `%APPDATA%\gh-writer` on Windows. `GH_WRITER_CONFIG_DIR` overrides it. Each entry has an `id` (`lib_…`), its `path`, the `title`, `author` and `cover` from novel.yaml (read again whenever the novel is opened, and when its cover changes), the `remote` (origin, with any credentials stripped out of the URL) and `lastOpened`. `list()` returns the most recently opened first. The file is replaced atomically on every change.

- **Adding** a folder checks that it's a folder (`NOT_A_DIRECTORY`), inside a git work tree (`NOT_A_REPO`) and holds novel.yaml (`NOT_A_NOVEL`). Adding a folder that's already there refreshes its entry.
- **Missing folders** are dropped whenever the library is read, at startup or later. Each drop leaves a `MISSING` notice in `notices` for the server's lifetime. An unreadable library.json is set aside (`UNREADABLE` notice, with the backup's path) and the library starts empty.
- **Cloning** takes `owner/name` (GitHub over https), an `https://`, `ssh://`, `git://` or `file://` URL, or `git@host:path`. Anything else, including anything git could read as an option, is `BAD_REPO`. The clone goes to `path`, or by default to `~/gh-writer/<name>`. A destination with files in it is refused (`DESTINATION_EXISTS`) and never touched. A failed clone, or a clone that turns out not to be a novel, leaves no folder behind.

- **Starting** a novel copies the novel template (`templates/novel` in this repository, `DEFAULT_TEMPLATE`; `Library.open({ templateDir })` overrides it) into `path`, by default `~/gh-writer/<slug of the title>`. The folder must be new or empty (`NOT_EMPTY`). The template's placeholder IDs get fresh ones, as its `init.mjs` does on GitHub. novel.yaml gets the title and author, the README its heading, and `diagrams/` is drawn for the new title. Then `git init` on `main` and one commit, "Start <title>". If git has no name and email (config or `GIT_AUTHOR_*`), it fails with `NEEDS_IDENTITY`; given `identity`, they are set in the new repository's config only. Any failure leaves nothing behind.

The clone endpoint answers with `text/event-stream`. It sends `progress` events (`{ stage, progress, processed, total }`, from git's own progress), then either `done` with `{ novel }`, or `error` with `{ code, error, detail? }`. Closing the request aborts the clone.

### git and credentials

The library uses the system git through simple-git and the author's own git setup: credential helpers (`gh auth setup-git`, Git Credential Manager) and SSH keys. Signing in to GitHub inside the app is described under [GitHub connection](#github-connection). The author's environment passes to git whole. simple-git would otherwise strip `GIT_*` variables such as `GIT_SSH_COMMAND`. git must never wait for input in the terminal the server runs in. So `GIT_TERMINAL_PROMPT=0`, and ssh runs with `BatchMode=yes` unless the author set `GIT_SSH_COMMAND` or `GIT_SSH`. That means a missing credential fails at once.

The desktop app ships its own git, GitHub's portable build ([D9](https://github.com/heffrey78/gh-writer/issues/170)), and names its folder in `GH_WRITER_GIT`. Every git command then runs that git (`bin/git`, or `cmd/git.exe` on Windows). It gets `GIT_EXEC_PATH` and `GIT_TEMPLATE_DIR` for its parts, since that build can't find them unaided, and on Linux `GIT_SSL_CAINFO` for its certificates. `GET /api/health` says which git runs: `git: "bundled"` or `"system"`. Writers who'd rather use their own git are served by the app leaving `GH_WRITER_GIT` unset.

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

## GitHub connection

The author signs in to GitHub once, in the app (D5, #90). `GitHub` (in `github.ts`) holds the connection; `createServer({ github })` takes one, and by default builds it with `GitHub.fromEnv()`.

- **Device flow**: `POST /api/github/device` asks github.com for a code, with the scopes `repo`, `workflow` (GitHub refuses a push that adds or changes `.github/workflows` without it, and every novel has workflows), `read:user` and `project` (the drafting board). A sign-in without `repo` or `workflow` (an older one, or gh's) is reported in the status as `missingScopes`; one without `project` as `missingBoardScopes`, which only the drafting board asks to reconnect for. Reconnecting grants them. The app shows the code and the address where the author enters it. It then calls `POST /api/github/device/poll` every `interval` seconds, which answers `pending` (with the interval, longer after a `slow_down`), `expired`, `denied`, `none` (no sign-in waiting) or `done` with the status. The device code stays on the server. It uses the gh-writer OAuth App's public client ID (`GITHUB_CLIENT_ID`, registered by the owner in #100); `GH_WRITER_GITHUB_CLIENT_ID` overrides it. Without a client ID (`clientId: ""`), it fails with `NO_CLIENT_ID`.
- **gh shortcut**: while signed out, the status names the gh CLI's account (`gh auth token`, checked against `GET /user`) if there is one, and `POST /api/github/gh` signs in with it.
- **The token** lives in the OS keychain (`keychainStore()`, @napi-rs/keyring: the macOS Keychain, Windows Credential Manager, or a Secret Service keyring on Linux). It is never written to a file and never sent to the browser. If the keychain can't be reached, the status says why (`keychain`) and signing in fails with `NO_KEYCHAIN`; there is no plain-text fallback. `GH_WRITER_TOKEN_STORE=memory` keeps it in memory instead, for tests.
- **Status**: `GET /api/github/account` returns `{ signedIn, account?: { login, name?, avatarUrl? }, deviceFlow, gh?, expired?, offline?, keychain? }`. Who the author is gets asked once and then remembered. When GitHub refuses the token (401: revoked or expired), it is forgotten and the next status says `expired: true`, once. If GitHub can't be reached, the author stays signed in (`offline: true`).
- **Sign out**: `DELETE /api/github/account` forgets the token. gh-writer has no client secret, so it can't revoke the token; the author can do that on github.com under Settings → Applications.
- `GitHub.api(path)` calls the REST API as the author. A 401 forgets the token and throws `NO_SIGN_IN`.
- `GitHub.graphql(query, variables)` calls the GraphQL API (Projects have no REST API) and resolves to its data. An error in the answer is thrown as a `GitHubError`: `NEEDS_SCOPE` (the token lacks a scope), `NOT_FOUND`, `RATE_LIMITED` (with `resetAt`), `OFFLINE`, `NO_SIGN_IN` (as for `api`), or `GITHUB`.
- **git**: clone and sync give git the token for http(s) remotes on GitHub only (`GitHub.gitAuth(url)`), for that one command. `git -c credential.<origin>.helper=` clears the author's own helpers for that host (so a stale stored credential can't win), and a second `-c credential.<origin>.helper=!…` answers `x-access-token` and the token, read from the command's environment (`GH_WRITER_GIT_TOKEN`). Nothing is written to any git config file, and the token is never in git's arguments. git runs that helper through `sh`, which MinGit may not have. So when `GH_WRITER_ASKPASS` names a program (the desktop app's own executable), only the clearing `-c` is given, and `GIT_ASKPASS` is set to that program for the command. git, finding no helper, asks it for the username (`x-access-token`) and the password (the token from `GH_WRITER_GIT_TOKEN`). Signed out, or for any other host or an ssh remote, git uses the author's own setup as before. When GitHub refuses the token during a sync, the status is `needs-sign-in`, and the connection checks the token (forgetting it if GitHub no longer accepts it).

- **Repositories**: `GET /api/github/repos` → `{ repos: [{ fullName, description?, private, pushedAt?, cloneUrl }] }`, the author's own and those they collaborate on, most recently pushed first (up to 300), for the Clone dialog.
- **Publishing** (`POST /api/novels/:id/publish { name, description?, private? }` → `{ remote, status }`): creates a repository on the author's account (`POST /user/repos`, private unless `private: false`), adds it as `origin`, and pushes through the novel's own sync, which then keeps syncing with it. A name already used on the account is `NAME_TAKEN`; a novel that already has an `origin` is `HAS_REMOTE`, except the repository this publish made: after a failed push (`PUSH_FAILED`), trying again pushes there instead of creating another.

`GH_WRITER_GITHUB_URL` and `GH_WRITER_GITHUB_API_URL` point the connection at another GitHub; the tests use a fake one (`test/fake-github.ts`), whose Projects (`test/fake-projects.ts`) are a subset of GitHub's GraphQL schema run by graphql-js.

## Novel files

Files are addressed by their repository-relative path, percent-encoded after `/files/`. A path must be plain and relative. Anything else is a `400 BAD_PATH`:

- absolute paths, drive letters and backslashes
- empty, `.` or `..` segments
- hidden segments (`.git`, `.github`, temp files) and `node_modules`
- NUL characters
- symlinks, and folders that resolve outside the novel

Reading serves any such file that is UTF-8 (`415 NOT_TEXT` otherwise). Writing takes `.md`, `.markdown`, `.yaml`, `.yml`, `.txt` and `.json` only, as well-formed Unicode. Files are limited to 2 MB (`413 TOO_LARGE`).

**Stale-write protection.** A file's `hash` is the SHA-256 of its bytes, in hex. A PUT sends `base`: the hash the client last read, or `null` for a file it expects not to exist. If the file on disk differs, nothing is written. The answer is `409 CONFLICT` with `current` (the file's `content` and `hash`, or `null` if it's gone), for the client to merge. Writes to one path run one at a time, so two writes from the same base can't both succeed.

**A newer format.** A novel whose `schema_version` is newer than this server reads ([D11](https://github.com/heffrey78/gh-writer/issues/206)) is read only: every request but a GET or a sync is refused with `409 TOO_NEW`, so it's never written as an older format. Its model carries only `E_SCHEMA_VERSION`, which the app shows as "needs a newer gh-writer".

**Atomic writes.** The text goes to a temp file in the same folder (`.<name>.<random>.ghw-tmp`) and is fsynced. The temp file is renamed over the target, then the folder is fsynced so the rename itself is durable (Windows skips the folder fsync). A crash leaves the old file or the new one, never a truncated one. A crash between the two steps can leave the temp file behind; it's hidden from the API and the watcher. The file keeps its permissions, and missing folders are created.

**Live changes.** `GET /api/novels/:id/events` starts a chokidar watcher on the novel (one per novel, shared, closed when the last stream ends). It sends `ready` once the watcher is live. Read anything you need after `ready`, so no change can slip between the read and the stream. Each change to a visible file is then a `file` event: `{ type: "add" | "change" | "unlink", path, hash }`, with `hash` null once the file is gone. The server's own writes aren't echoed: a change whose content matches what the server last wrote to that path is dropped, except a scene status written from the [drafting board](#drafting-board), which open editors must take in. A `sync` event carries the [sync status](#sync), right after `ready` and whenever it changes. `issues` and `board` events (with no data) say the issue cache or the board's status changed. A comment line every 25 s keeps the stream open. Closing the server ends every stream.

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

### Pictures

The bible's pictures and the book's cover live in `images/` (format spec, "`images/`"). The app crops and resizes a picture in the browser and sends the result's bytes, JPEG or PNG, as the request body with its `Content-Type`; the server needs no image library. A body over GitHub's 100 MB limit is refused (`413 TOO_LARGE`) from its `Content-Length`, before any of it is read; bytes that aren't JPEG or PNG are `400 BAD_REQUEST`.

| Endpoint | Does | Commit |
|---|---|---|
| `PUT /bible/entities/:id/picture?base=&focus=x,y` | Saves the picture as `images/<slug of the name>.jpg` (or `.png`; `-2`, `-3`… if another file has the name) and sets the entry's `image` and `image_focus` (or removes `image_focus` without `focus`). A picture it had in `images/` is replaced: the same file when the name and format match, otherwise deleted. `base` is the entry file's hash. → `{ image, file, commit }` | `Bible: add a picture of Ada Varn` / `Bible: change the picture of …` |
| `POST /bible/entities/:id/picture/delete` `{ base }` | Clears `image` and `image_focus` and deletes the file | `Bible: remove the picture of …` |
| `PUT /cover` | Saves `images/cover.jpg` (or `.png`) and sets `cover:` in novel.yaml; the library entry is read again, for the shelf. → `{ cover, commit }` | `Add a cover to the book` / `Change the book's cover` |
| `POST /cover/delete` | Removes `cover:` and deletes the file | `Remove the book's cover` |

Only files in `images/` that nothing else shows are deleted: a picture the author keeps elsewhere (`bible/images/…`), or one another entry or the cover also shows, stays. Deleting an entry deletes its picture in the same commit. `transaction` writes bytes as well as text, so each of these is one commit like any other operation.

`GET /images/<path>` serves `images/<path>` with its media type by extension: `.jpg`, `.jpeg`, `.png`, `.webp` and `.gif`, never SVG (it can carry script), with `X-Content-Type-Options: nosniff`. Anything else, any path outside `images/` (the path rules of [Novel files](#novel-files) apply) and symbolic links are `400 BAD_PATH`. The `ETag` is the file's size and modification time, with `Cache-Control: no-cache`: the browser checks it each time, and gets `304` while it's unchanged. The model's `images` gives the same version for each picture the cover and entries name in `images/`, so the app puts it in the URL and a replaced picture is never shown from the cache.

### Events

Each off-page event is a file of its own, `bible/events/<slug>.md`: its fields as front matter and its note as the prose ([D11](https://github.com/heffrey78/gh-writer/issues/206)). Its note can also be edited as the file's text, like an entry's notes.

| Endpoint | Does | Commit |
|---|---|---|
| `POST /bible/events` `{ title, when?, duration?, characters?, locations?, plotlines?, scene?, note?, migrate? }` → `{ id, file }` | Adds an event, named from its title; `when` is `{ at }` (a date, optionally with a time) or `{ day, time? }`, `duration` ISO 8601, the lists must name characters, locations and plotlines, and `scene` (the scene that dramatizes it) a scene | `Bible: add event “…”` |
| `PATCH /bible/events/:id` `{ changes, base?, migrate? }` → `{ file }` | Edits its fields (null removes one; `note` replaces the prose). A new title moves the file. With `base`, the file must be as it was read (`409 STALE`) | `Bible: edit event “…”`, or `Bible: rename event “…” to “…”` |
| `POST /bible/events/:id/delete` `{ base?, confirm?, migrate? }` | Removes the file. If prose mentions it (scenes, entries, other events), it's refused (`409 REFERENCED { references }`) unless `confirm` | `Bible: remove event “…”` |
| `POST /bible/events/:id/scene` `{ chapter, keep, migrate? }` → `{ scene, file }` | Writes the event as a new scene at the end of the chapter: its title, `when`, `duration`, characters, locations and plotlines, and its note as the synopsis (plain text). The event is kept, its `scene` naming the new one, or removed; removing one that prose mentions is refused (`409 REFERENCED`) | `Manuscript: write “…” as a scene` (`, removing the event`) |
| `POST /migrate` → `{ migrated }` | Moves the novel to the newest format, with the template's tools if it has any (`migrated` false when it was already) | `Format v2: off-page events as files` |

**Format v1.** In a novel in format 1 (events in `bible/events.yaml`), each of these is refused with `409 NEEDS_MIGRATION { from, to }`, for the app to ask the writer. With `migrate: true`, the novel is moved to format 2 first, in the same commit: `Format v2: off-page events as files; Bible: …`.

### Notes

The writer's notes ([D12](https://github.com/heffrey78/gh-writer/issues/215)) are files of their own, `notes/<slug>.md`. A note's prose can also be edited as the file's text.

| Endpoint | Does | Commit |
|---|---|---|
| `POST /notes` `{ title, tags?, scenes?, note? }` → `{ id, file }` | Adds a note, dated today, named from its title, on the scenes given (#222) | `Notes: add “…”` |
| `PATCH /notes/:id` `{ changes: { title?, tags?, scenes?, note? }, base? }` → `{ file }` | Edits it (null removes tags or scenes; a scene taken off takes its pin; `note` replaces the prose). A new title moves the file. With `base`, the file must be as it was read (`409 STALE`) | `Notes: edit “…”`, or `Notes: rename “…” to “…”` |
| `POST /notes/:id/pin` `{ scene, pinned }` | Pins it to the top of a scene's notes (putting it on the scene if it isn't), unpinning the scene's other pinned note in the same commit; or unpins it | `Notes: pin “…” in “…”`, or `Notes: unpin …` |
| `POST /notes/:id/delete` `{ base? }` | Removes the file | `Notes: remove “…”` |
| `POST /notes/:id/promote` `{ to: "event" \| "scene", chapter?, keep, migrate? }` → `{ id, file }` | Makes an off-page event of it (its prose the event's note) or a scene at the end of `chapter` (its prose the synopsis). The note is kept, `became` naming what it became, or removed. To an event in a novel in format 1: as for events, `409 NEEDS_MIGRATION` unless `migrate` | `Notes: promote “…” to an off-page event`, or `Notes: write “…” as a scene` (`, removing the note`) |

Deleting a scene, chapter or part takes its scenes off the notes on them, in the same commit; merging scenes puts the merged one's notes on the scene that stays. A note left on no scene is kept unattached or deleted as the delete's `{ notes: "keep" | "delete" }` says; without it, such a delete is refused with `409 NOTES_LEFT { notes }` for the app to ask.

Deleting an entry or an event that a note mentions is refused (`409 REFERENCED`) like one that prose mentions.

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

### Diagrams

| Endpoint | Does |
|---|---|
| `PUT /diagrams/:name/layout` `{ positions: { <id>: { x, y } } }` | Saves hand-placed positions for diagram `:name` in `diagrams/layouts.yaml`, rounded to whole pixels. Each node is one line (`char_7f3k2q: { x: 120, y: 40 }`), so moving one changes one line; a new node or diagram is added the same way, and the file is created if it isn't there. |

Unlike the operations above, a layout is saved like typing: through the workspace's ordinary writes (retrying if another write got there first), and committed with the next autosave, so dragging nodes around doesn't add a commit per drag.

## Drafting board

The novel's scenes on a GitHub Project (#11, decision [D8](https://github.com/heffrey78/gh-writer/issues/177)), for GitHub's board, table and roadmap views of drafting progress. `BoardStore` (in `board.ts`) keeps it; the scene files stay authoritative.

| Endpoint | Returns |
|---|---|
| `GET /api/novels/:id/board` | the status: `{ repo, project: { number, title, url } \| null, syncedAt, last, conflicts, error?, gone? }` |
| `POST /api/novels/:id/board` | makes the novel's project, or adopts the one it has, and syncs: the status |
| `POST /api/novels/:id/board/sync` | syncs now: the status, with why it couldn't in `error` |
| `POST /api/novels/:id/board/conflicts/:scene` | `{ keep: "file" \| "board" }` → settles a status conflict and syncs: the status |

Refusals: `400 BAD_REQUEST`, `403 NO_SIGN_IN` / `NEEDS_SCOPE` (the sign-in lacks `project`), `404 NOT_ON_GITHUB` / `NOT_SET_UP` / `NOT_FOUND`, `409 NOT_MAIN`, `410 GONE`, `429 RATE_LIMITED { resetAt }`, `503 OFFLINE`, `502 GITHUB`.

- **The project** belongs to the repository's owner, is linked to the repository, and is marked as the novel's by `<!-- gh-writer-board: nv_… -->` in its README, so another clone finds it (a sync looks once a session, while there's no board). Each scene of the main version is a draft item with Status, POV, Part, Chapter, Words, Order and Scene ID. The project's own Status field gets the scene statuses as options (GitHub's stock ones go, the author's own stay); where GitHub won't change it, a field of gh-writer's, `Scene status`, holds them.
- **Status flows both ways**, merged three ways against what was last synced from this clone: a change on one side is copied to the other. A change on both, to different values, is a conflict: neither side is written until the author keeps one. A fresh clone knows no last-synced status, so every difference is a conflict there. A status from the board is written with the workspace's conflict-checked write and announced on the event stream as an outside change, so an open editor takes it in; it's committed like any other save.
- **Everything else comes from the files.** Board edits to POV, part, chapter, words, order or a card's title are put back, and `last.putBack` says which. Cards for deleted scenes are removed; cards gh-writer didn't make are left alone.
- **When**: after every sync with GitHub once the board is set up, and on demand. Until then nothing is asked of GitHub in the background: the app syncs once when the board is opened, which finds a board another clone made. The board follows the main version: on another, sync waits (`NOT_MAIN`). Mutations go twenty to a GraphQL request.
- **What's kept**: the project, the last-synced values and the conflicts, in `.git/gh-writer/board.json` (never committed). Deleting it, or the project, loses no story data; a deleted project is reported (`gone`, `GONE`) and setting up again makes a new one.

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

`gh-writer serve --sidecar` is for the desktop app, which starts the server as a child process. It opens no browser and prints one JSON line on stdout: `{ url, token, launchUrl }` once listening, or `{ error }` (exit 1) if it can't start. Its messages go to stderr. It also calls `close()` when stdin reaches its end, so a server whose app quits, crashes or is killed stops too (Windows has no SIGTERM to send). The app keeps stdin open as a pipe for as long as it wants the server.
