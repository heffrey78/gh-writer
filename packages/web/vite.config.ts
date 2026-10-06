import { randomBytes } from "node:crypto";
import { request } from "node:http";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/**
 * `npm run dev`: a real gh-writer server (the author's library, or GH_WRITER_CONFIG_DIR's) runs inside
 * Vite, and /api is proxied to it with the session attached. The proxy speaks for the page: it sets
 * Host and Origin to the server's own, so the server's checks pass as they would in production.
 */
function ghWriterServer(): Plugin {
  return {
    name: "gh-writer-server",
    apply: "serve",
    async configureServer(vite) {
      const { createServer, Library, sessionCookie } = await import("@gh-writer/server");
      const token = randomBytes(32).toString("base64url");
      const server = await createServer({ library: await Library.open(), token });
      const cookie = `${sessionCookie(server.port)}=${token}`;
      vite.httpServer?.once("close", () => void server.close());
      vite.config.logger.info(`  gh-writer server: ${server.url} (library: ${server.library.file})`);
      vite.middlewares.use("/api", (req, res) => {
        const headers = { ...req.headers, host: `127.0.0.1:${server.port}`, cookie };
        if (headers.origin) headers.origin = server.url;
        delete headers["sec-fetch-site"];
        const upstream = request({ host: "127.0.0.1", port: server.port, path: req.originalUrl, method: req.method, headers }, (answer) => {
          res.writeHead(answer.statusCode ?? 502, answer.headers);
          answer.pipe(res);
        });
        upstream.on("error", () => res.writeHead(502).end());
        req.pipe(upstream);
        res.on("close", () => upstream.destroy());
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), ghWriterServer()],
  server: { port: 5180, strictPort: true },
  build: { outDir: "dist", emptyOutDir: true, sourcemap: true },
});
