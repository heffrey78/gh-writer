# @gh-writer/server

The local gh-writer server: a [Hono](https://hono.dev) API on Node that reads and writes a novel repository on the author's machine. `gh-writer serve` starts it.

```ts
import { createServer } from "@gh-writer/server";

const server = await createServer({ root: "/path/to/novel" }); // token and port: random by default
console.log(server.launchUrl); // http://127.0.0.1:41234/?token=…
await server.close();
```

| Endpoint | Session needed | Returns |
|---|---|---|
| `GET /api/health` | yes | `{ status: "ok", root }` |
| `GET /api/session` | no | `{ authenticated }`: whether the request carries a valid session cookie |

Routes added to `server.app` (before its first request) or in `createApp` sit behind the same security middleware.

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
