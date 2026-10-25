import { test, expect, newRoom, openRoom, newPeer, editor, expectText, serverText, Proxy, awaitRecovery, expectRetryButtonStartsAttempt } from './helpers.ts';

test.describe('D: network interruption', () => {
  test.beforeEach(() => { test.info().annotations.push({ type: 'expected-network-errors' }); });

  test('outage → honest offline state → offline edits → recovery → convergence without duplicates', async ({ page, browser, baseURL }) => {
    const proxy = new Proxy(new URL(baseURL!));
    const origin = await proxy.start();
    try {
      const room = newRoom('net');
      await openRoom(page, room, origin);             // A goes through the cuttable proxy
      const b = await newPeer(browser, room);         // B connects directly
      await editor(page).click();
      await page.keyboard.type('before');
      await expectText(b.page, 'before');

      proxy.cut();
      await expect(page.getByTestId('connection')).not.toHaveText('Connected');
      await expect(page.getByTestId('offline-banner')).toBeVisible();
      await expect(page.getByTestId('ai-suggest')).toBeDisabled();
      await page.keyboard.type(' offline');
      await expect(page.getByTestId('sync-status')).toHaveText(/8 changes waiting to sync/);
      await expect(page.getByTestId('offline-banner')).toContainText('8 unsynced changes are kept in this tab');
      await editor(b.page).click();
      await b.page.keyboard.press('Home');
      await b.page.keyboard.type('B: ');             // concurrent edit during the outage
      await page.waitForTimeout(400);
      await expectText(page, 'before offline');       // A did not falsely receive anything

      await expectRetryButtonStartsAttempt(page);
      proxy.restore();
      await awaitRecovery(page);
      await expect(page.getByTestId('toast').filter({ hasText: 'Reconnected' })).toBeVisible();
      await expectText(page, 'B: before offline');
      await expectText(b.page, 'B: before offline');
      expect(await serverText(baseURL!, room)).toBe('B: before offline');

      // Typing after recovery works and does not duplicate earlier ops / listeners.
      await editor(page).click();
      await page.keyboard.press('End');
      await page.keyboard.type('!');
      await expectText(b.page, 'B: before offline!');
      await page.waitForTimeout(300);
      expect(await serverText(baseURL!, room)).toBe('B: before offline!');
    } finally {
      await proxy.stop();
    }
  });

  test('leaving a room with unsynced edits asks for confirmation', async ({ page, baseURL }) => {
    const proxy = new Proxy(new URL(baseURL!));
    const origin = await proxy.start();
    try {
      const room = newRoom('leave');
      await openRoom(page, room, origin);
      proxy.cut();
      await expect(page.getByTestId('connection')).not.toHaveText('Connected');
      await editor(page).click();
      await page.keyboard.type('unsaved');
      await page.getByTestId('new-room').click();
      const dialog = page.getByRole('dialog', { name: 'Leave with unsynced changes?' });
      await expect(dialog).toBeVisible();
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      await expect(dialog).toBeHidden();
      await expect(page.getByTestId('room-id')).toHaveText(room);
      await page.getByTestId('new-room').click();
      await page.getByRole('button', { name: 'Leave and discard' }).click();
      await expect(page.getByTestId('room-id')).not.toHaveText(room);
    } finally {
      await proxy.stop();
    }
  });
});

test('refresh reloads the document from the server', async ({ page }) => {
  const room = newRoom('refresh');
  await openRoom(page, room);
  await editor(page).click();
  await page.keyboard.type('survives a reload');
  await expect(page.getByTestId('sync-status')).toHaveText('All changes synced to server memory');
  await page.reload();
  await expect(page.getByTestId('connection')).toHaveText('Connected');
  await expectText(page, 'survives a reload');
});

test('first load shows a loading state, then an unreachable server shows a retrying state', async ({ page, baseURL }) => {
  test.info().annotations.push({ type: 'expected-network-errors' });
  const proxy = new Proxy(new URL(baseURL!));
  const origin = await proxy.start();
  try {
    await page.goto(`${origin}/`);               // load app shell while reachable
    proxy.cut();
    const room = newRoom('unreachable');                // unique: rooms persist in server memory across tests
    await page.evaluate(id => { location.hash = id; }, room);
    await expect(page.getByTestId('connection')).toHaveText(/Connecting…|Can’t reach server/);
    await expect(page.getByTestId('connection')).toHaveText('Can’t reach server', { timeout: 15_000 });
    await expect(page.getByTestId('offline-banner')).toContainText('Next attempt in');
    // Local editing is still possible and clearly marked as unsynced.
    await editor(page).click();
    await page.keyboard.type('draft');
    await expect(page.getByTestId('sync-status')).toHaveText(/5 changes waiting/);
    await expectRetryButtonStartsAttempt(page);
    proxy.restore();
    await awaitRecovery(page);
    await expectText(page, 'draft');
  } finally {
    await proxy.stop();
  }
});
