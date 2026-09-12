import { defineConfig } from '@playwright/test';

/**
 * The promoted regression suite (VISION §9, phase 8).
 *
 * This config governs only `tests/generated/` — specs codegen'd from missions
 * that passed consistently. The missions themselves do not run through
 * Playwright's runner at all; they run through the executor
 * (`npm run run-mission`), which needs the discovery, budget and evidence
 * machinery this runner knows nothing about.
 *
 * Keeping the two separate is deliberate. A generated spec is meant to be
 * fast and dumb: no model, no discovery, no near-miss reporting. If it needs
 * any of that, it should not have been promoted.
 */
export default defineConfig({
  testDir: './tests/generated',
  // Deterministic specs that still need a retry are not deterministic, and
  // hiding that behind a retry is how a flaky suite becomes load-bearing.
  retries: 0,
  reporter: [['list'], ['html', { outputFolder: 'reports/regression', open: 'never' }]],
  use: {
    // Promoted specs carry absolute URLs from the run they were generated on,
    // so baseURL is a convenience for hand-edited ones rather than a
    // requirement. BASE_URL overrides it the same way it does everywhere else.
    baseURL: process.env.BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  // One place, so a promoted spec and a mission time out the same way and a
  // difference between them is never just impatience.
  timeout: 60_000,
  expect: { timeout: 10_000 },
});
