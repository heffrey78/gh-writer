import { defineConfig, devices } from "@playwright/test";

// Each test starts its own gh-writer server (e2e/fixtures.ts) on the built app: `npm run test:e2e` builds first.
export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: { trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
