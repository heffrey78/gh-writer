import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { createServer } from "@gh-writer/server";

export interface ServeOptions {
  /** 0 picks a free port. */
  port?: number;
  /** Open the launch URL in the default browser. */
  open?: boolean;
}

/** Serve the novel in `dir` until SIGINT or SIGTERM, then shut down cleanly and return the exit code. */
export async function runServe(dir: string, { port = 0, open = true }: ServeOptions = {}, out: (s: string) => void = console.log): Promise<number> {
  const root = resolve(dir);
  if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
    console.error(`Not a directory: ${root}`);
    return 1;
  }

  const server = await createServer({ root, port });
  out(`gh-writer is serving ${root}`);
  out(`  ${server.launchUrl}`);
  out("Press Ctrl+C to stop.");
  if (open) openBrowser(server.launchUrl, () => out("Could not open a browser: open the URL above."));

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
