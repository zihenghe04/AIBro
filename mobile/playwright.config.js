import { defineConfig } from "@playwright/test";
export default defineConfig({
  testMatch: "**/*.spec.js",
  use: { channel: "chrome" },
  webServer: {
    command: "npm run dev",
    url: "http://127.0.0.1:8899",
    reuseExistingServer: true,
  },
  timeout: 20000,
});
