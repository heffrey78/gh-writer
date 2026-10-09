import { defineConfig, devices } from "@playwright/test";

// The README's screenshots (docs/screenshots), taken of the sample novel: `npm run screenshots -w @gh-writer/web`.
export default defineConfig({
  testDir: "e2e",
  testMatch: /screenshots\.ts$/,
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  timeout: 60_000,
  use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: "light" },
});
