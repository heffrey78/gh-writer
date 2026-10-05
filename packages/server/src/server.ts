import { randomBytes } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { getRequestListener } from "@hono/node-server";
import type { Hono } from "hono";
import { createApp } from "./app.ts";
import { Library } from "./library.ts";
import { TOKEN_PARAM } from "./security.ts";
import { Workspaces } from "./workspace.ts";

export interface ServerOptions {
  /** The author's novels. Default: the library in the user config directory. */
  library?: Library;
  /** The per-launch secret. A fresh random one by default. */
  token?: string;
  /** 0 (the default) picks a free port. */
  port?: number;
  /** How long `close()` waits for in-flight requests before cutting their connections (ms). */
  shutdownTimeout?: number;
}

export interface RunningServer {
  /** The app: routes added before the first request go through the security middleware. */
  app: Hono;
  /** http://127.0.0.1:<port> */
  url: string;
  /** The URL to open in the browser: it carries the token, which the browser trades for a session cookie. */
  launchUrl: string;
  /** The launch URL for a page of the app, e.g. "/novels/lib_4k8h2c". */
  launchUrlFor(path: string): string;
  library: Library;
  port: number;
  token: string;
  /** Stops accepting connections, ends event streams, and resolves once in-flight requests have finished. */
  close(): Promise<void>;
}

const HOST = "127.0.0.1";

/** Starts the server on 127.0.0.1 only. */
export async function createServer({ library, token = newToken(), port = 0, shutdownTimeout = 10_000 }: ServerOptions = {}): Promise<RunningServer> {
  library ??= await Library.open();
  let boundPort = port;
  const workspaces = new Workspaces(library);
  const app = createApp({ token, port: () => boundPort, library, workspaces });
  const server = createHttpServer(getRequestListener(app.fetch));

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, HOST, () => {
      server.off("error", reject);
      resolve();
    });
  });
  boundPort = (server.address() as AddressInfo).port;

  let closing: Promise<void> | undefined;
  // A keep-alive connection that was busy when close() began goes idle once its response is sent: close it then.
  server.on("request", (_req, res) => res.once("finish", () => closing && setImmediate(() => server.closeIdleConnections())));
  const close = () =>
    (closing ??= new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => server.closeAllConnections(), shutdownTimeout).unref();
      server.close((err) => {
        clearTimeout(timer);
        if (err) reject(err);
        else resolve();
      });
      server.closeIdleConnections();
      // Ends the event streams and file watchers; writes in flight finish as ordinary requests.
      void workspaces.close();
    }));

  const url = `http://${HOST}:${boundPort}`;
  const launchUrlFor = (path: string) => `${url}${path}?${TOKEN_PARAM}=${token}`;
  return { app, url, launchUrl: launchUrlFor("/"), launchUrlFor, library, port: boundPort, token, close };
}

/** A 256-bit secret, URL-safe. */
export function newToken(): string {
  return randomBytes(32).toString("base64url");
}
