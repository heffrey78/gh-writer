import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, GitFailure, Library, LibraryError, type LibraryEntry, type RunningServer } from "@gh-writer/server";

export interface ServeOptions {
  /** 0 picks a free port. */
  port?: number;
  /** Open the launch URL in the default browser. */
  open?: boolean;
  /** Minutes between background syncs with the remote; 0 syncs only on demand. Default 5. */
  syncEvery?: number;
  /**
   * Run for the desktop app: no browser, and on stdout only one JSON line, {url, token, launchUrl} once
   * listening or {error} if it can't start; messages go to stderr. It also stops when stdin closes,
   * so the server goes with the app however the app goes (and on Windows there's no SIGTERM to send).
   */
  sidecar?: boolean;
}

/**
 * Serve the library until SIGINT or SIGTERM (or, as a sidecar, stdin closing), then shut down cleanly
 * and return the exit code. `dir`, or the current directory when it holds a novel, is added to the
 * library and opened.
 */
export async function runServe(dir: string | undefined, { port = 0, open = true, syncEvery, sidecar = false }: ServeOptions = {}, out: (s: string) => void = console.log): Promise<number> {
  const say = sidecar ? (s: string) => console.error(s) : out;
  const fail = (message: string) => {
    if (sidecar) out(JSON.stringify({ error: message }));
    else console.error(message);
    return 1;
  };

  let server: RunningServer;
  let launchUrl: string;
  try {
    const library = await Library.open();
    const target = dir ?? (existsSync(join(process.cwd(), "novel.yaml")) ? "." : undefined);
    let novel: LibraryEntry | undefined;
    if (target !== undefined) {
      try {
        novel = await library.add(resolve(target));
      } catch (e) {
        if (!(e instanceof LibraryError || e instanceof GitFailure)) throw e;
        return fail(e.message);
      }
    }
    for (const notice of library.notices) say(notice.message);

    const web = webApp();
    if (!web) say("The web app isn't built yet: run `npm run build` first. Serving the API only.");
    server = await createServer({ library, port, ...(web ? { web } : {}), ...(syncEvery !== undefined ? { sync: { intervalMs: syncEvery * 60_000 } } : {}) });
    launchUrl = novel ? server.launchUrlFor(`/novels/${novel.id}`) : server.launchUrl;
    say(novel ? `gh-writer is serving ${novel.title} (${novel.path})` : `gh-writer is serving your library (${library.file})`);
  } catch (e) {
    // The desktop app reads failures from the JSON line; on the command line they surface as before.
    if (!sidecar) throw e;
    return fail(e instanceof Error ? e.message : String(e));
  }

  if (sidecar) {
    out(JSON.stringify({ url: server.url, token: server.token, launchUrl }));
  } else {
    out(`  ${launchUrl}`);
    out("Press Ctrl+C to stop.");
    if (open) openBrowser(launchUrl, () => out("Could not open a browser: open the URL above."));
  }

  const reason = await new Promise<string>((done) => {
    const stop = (why: string) => {
      process.off("SIGINT", stop).off("SIGTERM", stop);
      // Nothing more to read, and an open stdin would keep the process alive after the server stops.
      if (sidecar) process.stdin.destroy();
      // A second signal stops at once, without waiting for in-flight work.
      process.once("SIGINT", force).once("SIGTERM", force);
      done(why);
    };
    process.on("SIGINT", stop).on("SIGTERM", stop);
    if (sidecar) process.stdin.once("end", () => stop("stdin closed")).resume();
  });

  say(`${reason}: stopping…`);
  await server.close();
  say("Stopped.");
  return 0;
}

/** The built web app (packages/web/dist, or beside the server bundle: GH_WRITER_WEB), if it has been built. */
function webApp(): string | undefined {
  const dir = process.env.GH_WRITER_WEB || fileURLToPath(new URL("../../web/dist", import.meta.url));
  return existsSync(join(dir, "index.html")) ? dir : undefined;
}

function force(): never {
  process.exit(1);
}

function openBrowser(url: string, onError: () => void): void {
  const [command, args] =
    process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", '""', url]] : ["xdg-open", [url]];
  // Verbatim, so cmd sees start's empty title as "" (the URL has no characters cmd treats specially).
  const child = spawn(command, args, { stdio: "ignore", detached: true, windowsVerbatimArguments: true });
  child.once("error", onError);
  child.unref();
}
