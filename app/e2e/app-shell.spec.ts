import { expect, test } from '@playwright/test'

test('renders app shell and library sidebar', async ({ page }) => {
  await page.goto('/')

  await expect(page.getByRole('heading', { name: 'ModAudio' })).toBeVisible()
  await expect(page.locator('.app-shell')).toBeVisible()
  await expect(page.locator('.library-sidebar')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Library' })).toBeVisible()
})
