import { defineConfig, devices } from "@playwright/test";

// Each test starts its own gh-writer server (e2e/fixtures.ts) on the built app: `npm run test:e2e` builds first.
export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: { trace: "retain-on-failure" },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] }, testIgnore: /performance/ },
    // The benchmarks run alone, after the rest, so other tests don't compete for the CPU.
    { name: "performance", use: { ...devices["Desktop Chrome"] }, testMatch: /performance/, dependencies: ["chromium"], fullyParallel: false },
  ],
});
