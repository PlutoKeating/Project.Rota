import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: ".",
  testMatch: "agent-import.spec.ts",
  workers: 1,
  reporter: "list",
  use: { baseURL: "http://127.0.0.1:5178" },
  webServer: {
    command: "pnpm exec vite --config test/browser/vite.config.ts",
    url: "http://127.0.0.1:5178",
    reuseExistingServer: !process.env.CI,
    timeout: 30000,
  },
});
