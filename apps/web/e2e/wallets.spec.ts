import { test, expect, type Page } from '@playwright/test';
import { dismissWelcome } from './helpers';

/**
 * Wallets & accounts — several wallets in one vault (lib/vault.ts).
 *
 * The reported bug: a wallet imported from a private key had no "Add
 * account" and no way to add or create another wallet. Now every wallet
 * type opens Wallets & accounts, where wallets are added (created, or
 * imported as a phrase or a key) next to the first, each with its accounts.
 *
 * Public test values only (Hardhat account 0; the all-zero-entropy phrase).
 */
const HARDHAT_KEY_0 = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const ABANDON_PHRASE =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PASSWORD = 'wallets-test-pw-321';

async function importKeyAsFirstWallet(page: Page) {
  await page.goto('/app');
  await page.getByRole('button', { name: 'I already have a wallet' }).click();
  await page.getByRole('button', { name: /private key/i }).click();
  await page.getByPlaceholder('0xabc123…').fill(HARDHAT_KEY_0);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByPlaceholder('Password', { exact: true }).fill(PASSWORD);
  await page.getByPlaceholder('Confirm password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Import key' }).click();
  await expect(page.getByRole('button', { name: 'Send' }).first()).toBeVisible({ timeout: 30_000 });
  await dismissWelcome(page);
}

async function openWalletsPanel(page: Page) {
  await page.locator('.account-chip').click();
  await page.getByRole('button', { name: /Wallets & accounts/ }).click();
  const panel = page.getByRole('dialog', { name: 'Wallets & accounts' });
  await expect(panel).toBeVisible();
  return panel;
}

test.describe('Wallets & accounts', () => {
  test('a private-key wallet can add a recovery phrase and switch between them', async ({ page }) => {
    await importKeyAsFirstWallet(page);

    let panel = await openWalletsPanel(page);
    await expect(panel.getByRole('heading', { name: 'Imported · private key' })).toBeVisible();
    // A private key has one account and no "Add account".
    await expect(panel.getByRole('button', { name: /^Add an account to/ })).toHaveCount(0);

    // + Add wallet → Import recovery phrase (no password step: same vault password).
    await panel.getByRole('button', { name: 'Add wallet' }).click();
    await page.getByRole('button', { name: /Import recovery phrase/ }).click();
    await page.getByPlaceholder(/word1 word2 word3/i).fill(ABANDON_PHRASE);
    await page.getByRole('button', { name: 'Add wallet' }).click();

    // The new wallet opens on its first account.
    await expect(page.locator('.chip-name')).toHaveText('Account 1');
    panel = await openWalletsPanel(page);
    await expect(panel.getByRole('heading', { name: 'Imported · recovery phrase' })).toBeVisible();
    await expect(panel.getByRole('heading', { name: 'Imported · private key' })).toBeVisible();
    await expect(panel.getByText('Wallet 2', { exact: true })).toBeVisible();
    // "+ Add account" under the recovery-phrase wallet only.
    await expect(panel.getByRole('button', { name: /^Add an account to/ })).toHaveCount(1);

    // Add an account to the phrase wallet, then go back to the key wallet's account.
    await panel.getByRole('button', { name: 'Add an account to Wallet 2' }).click();
    await expect(page.locator('.chip-name')).toHaveText('Account 2');
    panel = await openWalletsPanel(page);
    await panel.getByRole('button', { name: /^Open Account 1 in Wallet 1/ }).click();
    await expect(page.locator('.account-chip')).toHaveAttribute('title', /^litho1/);
    panel = await openWalletsPanel(page);
    await expect(panel.getByRole('button', { name: 'Account 1 (active)' })).toBeVisible();

    // Survives a reload (session key) and a lock / unlock with the one vault
    // password: both wallets, the open one remembered.
    await page.keyboard.press('Escape');
    await page.reload();
    panel = await openWalletsPanel(page);
    await expect(panel.getByRole('button', { name: 'Account 1 (active)' })).toBeVisible();
    await expect(panel.getByText('Wallet 2', { exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await page.locator('.account-chip').click();
    await page.getByRole('button', { name: 'Lock wallet' }).click();
    await page.getByPlaceholder('Enter password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Unlock' }).click();
    await expect(page.getByRole('button', { name: 'Send' }).first()).toBeVisible({ timeout: 30_000 });
    panel = await openWalletsPanel(page);
    await expect(panel.getByText('Wallet 1', { exact: true })).toBeVisible();
    await expect(panel.getByText('Wallet 2', { exact: true })).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Account 1 (active)' })).toBeVisible();
  });

  test('create a new wallet from the panel (backup + verify, no new password)', async ({ page }) => {
    await importKeyAsFirstWallet(page);
    const panel = await openWalletsPanel(page);
    await panel.getByRole('button', { name: 'Add wallet' }).click();
    await page.getByRole('button', { name: /Create new wallet/ }).click();

    await page.locator('.phrase-len-tile').first().click();
    await page.getByRole('button', { name: 'I understand' }).click();
    await expect(page.locator('.seed-word')).toHaveCount(12);
    const words: string[] = [];
    for (let i = 0; i < 12; i++) words.push((await page.locator('.seed-word').nth(i).innerText()).trim().replace(/^\d+\.\s*/, ''));
    await page.getByRole('button', { name: "I've saved it" }).click();
    const slots = page.locator('.seed-word.seed-slot');
    const missing: number[] = [];
    for (let i = 0; i < await slots.count(); i++) missing.push(parseInt(await slots.nth(i).locator('.seed-num').innerText(), 10) - 1);
    for (const idx of missing.sort((a, b) => a - b)) {
      await page.locator('.seed-pool').getByRole('button', { name: words[idx], exact: true }).first().click();
    }
    await page.getByRole('button', { name: 'Add wallet' }).click();

    const again = await openWalletsPanel(page);
    await expect(again.getByRole('heading', { name: 'Created in Thanos' })).toBeVisible();
    await expect(again.getByRole('heading', { name: 'Imported · private key' })).toBeVisible();
  });
});
