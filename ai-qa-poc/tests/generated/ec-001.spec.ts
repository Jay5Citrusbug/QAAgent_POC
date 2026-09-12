/**
 * EC-001 — Verify the top navigation bar shows links to all four core pages.
 *
 * GENERATED from an approved mission that passed consistently. Do not edit by
 * hand: re-run `npm run promote -- --promote EC-001` and this file is
 * rewritten. The mission remains the source of truth — it carries the
 * requirement link, the human sentence for each assertion, and the approval.
 *
 *   mission      missions/approved/EC-001.json
 *   requirement  input/feature-ecommerce/requirement.md#r-1--global-navigation
 *   promoted by  jay.r on 2026-09-12
 *   from run     20260912122207-7e1n (build unknown)
 *
 * These locators are a snapshot of what resolved on that build. When this test
 * breaks, it has done its job — but decide which thing broke before fixing it:
 * re-run the mission, and if the mission still passes, the page moved and this
 * file should be regenerated rather than patched.
 */
import { expect, test } from '@playwright/test';

test('EC-001 — Verify the top navigation bar shows links to all four core pages.', async ({ page }) => {
  // Preconditions assumed by this test:
  //   - STAGE is reachable and the home page loads

  await test.step('actions', async () => {
    await page.goto('https://buggyqa.vercel.app/');
  });

  await test.step('assertions', async () => {
    // A1: A link to the Products page is present in the top navigation.
    await expect(page.getByRole('navigation').getByRole('link', { name: 'Products' })).toBeVisible();
    // A2: A link to the Checkout page is present in the top navigation.
    await expect(page.getByRole('navigation').getByRole('link', { name: 'Checkout' })).toBeVisible();
    // A3: A link to the Cart is present in the top navigation.
    await expect(page.getByRole('navigation').getByRole('link', { name: 'Cart' })).toBeVisible();
  });
});
