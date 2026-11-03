import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "test/browser",
  use: { baseURL: "http://127.0.0.1:5173" },
  workers: 1,
  reporter: "list",
});
