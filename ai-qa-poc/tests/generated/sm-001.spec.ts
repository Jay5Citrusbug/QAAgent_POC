/**
 * SM-001 — Verify the top navigation Home link displays the correct spelling 'Home'.
 *
 * GENERATED from an approved mission that passed consistently. Do not edit by
 * hand: re-run `npm run promote -- --promote SM-001` and this file is
 * rewritten. The mission remains the source of truth — it carries the
 * requirement link, the human sentence for each assertion, and the approval.
 *
 *   mission      missions/approved/SM-001.json
 *   requirement  input/feature/requirement.md
 *   promoted by  jay.r on 2026-09-12
 *   from run     20260912122224-a4vg (build unknown)
 *
 * These locators are a snapshot of what resolved on that build. When this test
 * breaks, it has done its job — but decide which thing broke before fixing it:
 * re-run the mission, and if the mission still passes, the page moved and this
 * file should be regenerated rather than patched.
 */
import { expect, test } from '@playwright/test';

test('SM-001 — Verify the top navigation Home link displays the correct spelling \\\'Home\\\'.', async ({ page }) => {
  // Preconditions assumed by this test:
  //   - Application is loaded at the home page

  await test.step('actions', async () => {
    await page.goto('https://buggyqa.vercel.app/');
  });

  await test.step('assertions', async () => {
    // A1: The top navigation link reads 'Home', not 'Hoem'.
    await expect(page.getByRole('link', { name: 'Home' })).toHaveText('Home');
  });
});
