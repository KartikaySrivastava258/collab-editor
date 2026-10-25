import { test, expect, newRoom, openRoom, newPeer, editor, expectText } from './helpers.ts';

test('F: suggestion is private until inserted; insertion syncs and is undoable', async ({ page, browser }) => {
  const room = newRoom('ai');
  await openRoom(page, room);
  const b = await newPeer(browser, room);
  await editor(page).click();
  await page.keyboard.type('It was a dark night.');
  await page.getByTestId('ai-suggest').click();
  await expect(page.getByTestId('ai-text')).toHaveText('and then the rain stopped.');
  await expect(b.page.getByTestId('ai-panel')).toHaveCount(0);
  await expectText(b.page, 'It was a dark night.');          // nothing inserted automatically
  await page.getByRole('button', { name: 'Insert at cursor' }).click();
  await expectText(page, 'It was a dark night.and then the rain stopped.');
  await expectText(b.page, 'It was a dark night.and then the rain stopped.');
  await page.keyboard.press('ControlOrMeta+Z');
  await expectText(b.page, 'It was a dark night.');
});

test('F: cancel while generating', async ({ page }) => {
  await openRoom(page, newRoom('ai'));
  await editor(page).click();
  await page.keyboard.type('SLOWAI please');
  await page.getByTestId('ai-suggest').click();
  await expect(page.getByTestId('ai-panel')).toContainText('Generating a suggestion');
  await expect(page.getByTestId('ai-suggest')).toBeDisabled();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByTestId('ai-panel')).toContainText('Suggestion cancelled');
  await page.getByRole('button', { name: 'Dismiss' }).click();
  await expect(page.getByTestId('ai-panel')).toHaveCount(0);
});

test('F: provider timeout and provider failure are shown, editing keeps working', async ({ page }) => {
  await openRoom(page, newRoom('ai'));
  await editor(page).click();
  await page.keyboard.type('SLOWAI');
  await page.getByTestId('ai-suggest').click();
  await expect(page.getByTestId('ai-panel')).toContainText('did not respond in time', { timeout: 10_000 });
  await page.getByRole('button', { name: 'Dismiss' }).click();
  await editor(page).fill('');
  await editor(page).click();
  await page.keyboard.type('FAILAI');
  await page.getByTestId('ai-suggest').click();
  await expect(page.getByTestId('ai-panel')).toContainText('Suggestion failed');
  await editor(page).click();          // the toolbar button had focus
  await page.keyboard.press('End');
  await page.keyboard.type(' still editable');
  await expectText(page, 'FAILAI still editable');
});
