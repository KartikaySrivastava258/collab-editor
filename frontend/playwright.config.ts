import { defineConfig, devices } from '@playwright/test';

/**
 * By default Playwright builds the app and serves it from the TS test server
 * with a fake LLM. Set E2E_BASE_URL to test an already-running server instead
 * (CI points it at the Go binary, configured with the same fake LLM).
 */
const external = process.env.E2E_BASE_URL;
const PORT = 8290;
const LLM_PORT = 8299;

export default defineConfig({
  testDir: 'e2e',
  timeout: 45_000,
  expect: { timeout: 8_000 },
  workers: 1,
  retries: 0,
  reporter: [['list'], ['json', { outputFile: 'test-results/e2e-results.json' }]],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: external ?? `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: external ? undefined : [
    { command: 'node e2e/fake-llm.mjs', url: `http://127.0.0.1:${LLM_PORT}/health`, env: { FAKE_LLM_PORT: String(LLM_PORT) } },
    {
      command: 'node scripts/build.mjs && node test-server/server.ts',
      url: `http://127.0.0.1:${PORT}/health`,
      timeout: 60_000,
      env: {
        PORT: String(PORT), STATIC_DIR: 'dist', LLM_API_KEY: 'e2e-key', LLM_MODEL: 'fake-model',
        LLM_API_URL: `http://127.0.0.1:${LLM_PORT}`, AI_TIMEOUT_MS: '2500',
      },
    },
  ],
});
