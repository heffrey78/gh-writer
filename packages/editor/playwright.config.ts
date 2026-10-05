import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: { baseURL: "http://localhost:5179", trace: "retain-on-failure" },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] }, testIgnore: /latency/ },
    // The latency benchmark runs alone, after the rest, so other tests don't compete for the CPU.
    { name: "latency", use: { ...devices["Desktop Chrome"] }, testMatch: /latency/, dependencies: ["chromium"] },
  ],
  webServer: {
    command: "npx vite --config vite.config.ts",
    url: "http://localhost:5179",
    reuseExistingServer: !process.env.CI,
  },
});
