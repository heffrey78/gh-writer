import { defineConfig, devices } from "@playwright/test";

// The browsers to test in (E2E_BROWSERS=chromium,webkit): both in CI; Chromium alone elsewhere unless
// asked, since Playwright's WebKit needs Ubuntu's libraries (or its Docker image).
const browsers = (process.env.E2E_BROWSERS ?? (process.env.CI ? "chromium,webkit" : "chromium")).split(",");

export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: { baseURL: "http://localhost:5179", trace: "retain-on-failure" },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] }, testIgnore: /latency/ },
    // WebKit: the engine of the desktop app's window on macOS and Linux (#187). Its own Linux user
    // agent, like the Linux webview's (a Safari one would make the app use the Mac's shortcuts).
    ...(browsers.includes("webkit") ? [{ name: "webkit", use: { browserName: "webkit" as const, viewport: { width: 1280, height: 720 } }, testIgnore: /latency/, timeout: 60_000, expect: { timeout: 10_000 } }] : []),
    // The latency benchmark runs alone, after the rest, so other tests don't compete for the CPU.
    { name: "latency", use: { ...devices["Desktop Chrome"] }, testMatch: /latency/, dependencies: ["chromium"] },
  ],
  webServer: {
    command: "npx vite --config vite.config.ts",
    url: "http://localhost:5179",
    reuseExistingServer: !process.env.CI,
  },
});
