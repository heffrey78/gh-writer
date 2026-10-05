import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The playground loads scenes from examples/, outside this package.
const repo = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig({
  root: fileURLToPath(new URL("playground", import.meta.url)),
  plugins: [react()],
  server: { port: 5179, strictPort: true, fs: { allow: [repo] } },
});
