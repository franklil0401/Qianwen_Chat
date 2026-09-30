import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/desktop",
  outputDir: "./.local/desktop-e2e",
  fullyParallel: false,
  workers: 1, // Desktop profiles share the application's fixed loopback port.
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
});
