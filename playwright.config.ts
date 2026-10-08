import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end smoke tests. They run against the dev server with seeded demo data
 * and DEMO_LOGIN_ENABLED=true (one-click demo sign-in).
 *   npm run seed && npm run test:e2e
 */
export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  retries: 0,
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : { command: "npm run dev", url: "http://localhost:3000/login", reuseExistingServer: true, timeout: 120_000 },
});
