import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { createServer, GitFailure, Library, LibraryError, type LibraryEntry } from "@gh-writer/server";

export interface ServeOptions {
  /** 0 picks a free port. */
  port?: number;
  /** Open the launch URL in the default browser. */
  open?: boolean;
  /** Minutes between background syncs with the remote; 0 syncs only on demand. Default 5. */
  syncEvery?: number;
}

/**
 * Serve the library until SIGINT or SIGTERM, then shut down cleanly and return the exit code.
 * `dir`, or the current directory when it holds a novel, is added to the library and opened.
 */
export async function runServe(dir: string | undefined, { port = 0, open = true, syncEvery }: ServeOptions = {}, out: (s: string) => void = console.log): Promise<number> {
  const library = await Library.open();
  const target = dir ?? (existsSync(join(process.cwd(), "novel.yaml")) ? "." : undefined);
  let novel: LibraryEntry | undefined;
  if (target !== undefined) {
    try {
      novel = await library.add(resolve(target));
    } catch (e) {
      if (!(e instanceof LibraryError || e instanceof GitFailure)) throw e;
      console.error(e.message);
      return 1;
    }
  }
  for (const notice of library.notices) out(notice.message);

  const server = await createServer({ library, port, ...(syncEvery !== undefined ? { sync: { intervalMs: syncEvery * 60_000 } } : {}) });
  const launchUrl = novel ? server.launchUrlFor(`/novels/${novel.id}`) : server.launchUrl;
  out(novel ? `gh-writer is serving ${novel.title} (${novel.path})` : `gh-writer is serving your library (${library.file})`);
  out(`  ${launchUrl}`);
  out("Press Ctrl+C to stop.");
  if (open) openBrowser(launchUrl, () => out("Could not open a browser: open the URL above."));

  const signal = await new Promise<NodeJS.Signals>((done) => {
    const stop = (s: NodeJS.Signals) => {
      process.off("SIGINT", stop).off("SIGTERM", stop);
      // A second signal stops at once, without waiting for in-flight work.
      process.once("SIGINT", force).once("SIGTERM", force);
      done(s);
    };
    process.on("SIGINT", stop).on("SIGTERM", stop);
  });

  out(`${signal}: stopping…`);
  await server.close();
  out("Stopped.");
  return 0;
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
