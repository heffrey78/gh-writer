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

Routes added to `server.app` (before its first request) or in `createApp` sit behind the same security middleware.

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
| `DESTINATION_EXISTS` | the target folder has files | choose another folder |
| `GIT_MISSING` | git isn't installed | install git |
| `GIT` | anything else | git's last line |

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
