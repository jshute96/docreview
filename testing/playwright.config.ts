import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: 'content-script.spec.ts',
  timeout: 30_000,
  use: {
    baseURL: 'http://localhost:8889',
    channel: 'chrome',
  },
  webServer: {
    command: 'python3 -m http.server 8889 -d snapshots',
    port: 8889,
    reuseExistingServer: true,
  },
});
