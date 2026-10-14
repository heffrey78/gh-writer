import { defineConfig, devices } from "@playwright/test";

// The browsers to test in (E2E_BROWSERS=chromium,webkit): both in CI; Chromium alone elsewhere unless
// asked, since Playwright's WebKit needs Ubuntu's libraries (or its Docker image).
const browsers = (process.env.E2E_BROWSERS ?? (process.env.CI ? "chromium,webkit" : "chromium")).split(",");

// Each test starts its own gh-writer server (e2e/fixtures.ts) on the built app: `npm run test:e2e` builds first.
export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: { trace: "retain-on-failure" },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] }, testIgnore: /performance/ },
    // WebKit: the engine of the desktop app's window on macOS and Linux (#187). Its own Linux user
    // agent, like the Linux webview's (a Safari one would make the app use the Mac's shortcuts).
    ...(browsers.includes("webkit") ? [{ name: "webkit", use: { browserName: "webkit" as const, viewport: { width: 1280, height: 720 } }, testIgnore: /performance/, timeout: 60_000, expect: { timeout: 10_000 } }] : []),
    // The benchmarks run alone, after the rest and one at a time, so nothing competes with them for the CPU.
    { name: "performance", use: { ...devices["Desktop Chrome"] }, testMatch: /performance/, dependencies: ["chromium"], fullyParallel: false, workers: 1 },
  ],
});
