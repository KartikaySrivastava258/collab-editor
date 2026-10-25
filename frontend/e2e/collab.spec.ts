import { test, expect, newRoom, openRoom, newPeer, editor, expectText, serverText } from './helpers.ts';

test('A: first launch → landing → new document → connected, empty state, typing works', async ({ page, baseURL }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Write together, in real time.' })).toBeVisible();
  await page.getByTestId('landing-new').click();
  await expect(page).toHaveURL(/#doc-[a-z0-9]{8}$/);
  await expect(page.getByTestId('connection')).toHaveText('Connected');
  await expect(editor(page)).toHaveAttribute('placeholder', /Start writing/);
  await expect(page.getByTestId('sync-status')).toHaveText('All changes synced to server memory');
  await editor(page).click();
  await page.keyboard.type('First words.');
  await expect(page.getByTestId('sync-status')).toHaveText('All changes synced to server memory');
  const room = new URL(page.url()).hash.slice(1);
  expect(await serverText(baseURL!, room)).toBe('First words.');
  await expect(page.getByTestId('recent-room').first()).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('stats')).toHaveText('2 words · 12 characters');
});

test('B: two clients see each other’s edits and presence updates on leave', async ({ page, browser }) => {
  const room = newRoom();
  await openRoom(page, room);
  const b = await newPeer(browser, room);
  await expect(page.getByTestId('presence')).toHaveAttribute('aria-label', /^2 connected/);
  await editor(page).click();
  await page.keyboard.type('Hello');
  await expectText(b.page, 'Hello');
  await editor(b.page).click();
  await b.page.keyboard.press('End');
  await b.page.keyboard.type(', world');
  await expectText(page, 'Hello, world');
  await expect(page.getByTestId('stats')).toHaveText('2 words · 12 characters');
  await b.ctx.close();
  await expect(page.getByTestId('presence')).toHaveAttribute('aria-label', /^1 connected/);
});

test('C: simultaneous typing in two browsers converges with the server, nothing lost', async ({ page, browser, baseURL }) => {
  const room = newRoom();
  await openRoom(page, room);
  const b = await newPeer(browser, room);
  await editor(page).click();
  await page.keyboard.type('[]');
  await expectText(b.page, '[]');
  await page.keyboard.press('ArrowLeft');
  await editor(b.page).click();
  await b.page.keyboard.press('End');
  await b.page.keyboard.press('ArrowLeft');
  // both type at the same position at the same time
  await Promise.all([
    page.keyboard.type('alpha-alpha-alpha', { delay: 15 }),
    b.page.keyboard.type('bravo-bravo-bravo', { delay: 15 }),
  ]);
  await expect.poll(async () => {
    const [x, y, srv] = [await editor(page).inputValue(), await editor(b.page).inputValue(), await serverText(baseURL!, room)];
    return x === y && y === srv ? x : `diverged: ${x} | ${y} | ${srv}`;
  }, { timeout: 10_000 }).toMatch(/^\[(alpha-alpha-alphabravo-bravo-bravo|bravo-bravo-bravoalpha-alpha-alpha)\]$/);
  // Every keystroke from both users survived exactly once, and the runs did not interleave.
});

test('E: switching rooms does not leak events between rooms', async ({ page, browser }) => {
  const r1 = newRoom('one'); const r2 = newRoom('two');
  await openRoom(page, r1);
  await editor(page).click();
  await page.keyboard.type('room one text');
  await page.getByLabel('Room ID or link').fill(r2);
  await page.getByRole('button', { name: 'Join', exact: true }).click();
  await expect(page.getByTestId('room-id')).toHaveText(r2);
  await expect(page.getByTestId('connection')).toHaveText('Connected');
  await expectText(page, '');
  const other = await newPeer(browser, r1);
  await expectText(other.page, 'room one text');
  await editor(other.page).click();
  await other.page.keyboard.type(' more');
  await page.waitForTimeout(500);
  await expectText(page, '');
  await page.reload();
  await expect(page.getByTestId('connection')).toHaveText('Connected');
  await expectText(page, '');
  await page.getByTestId('recent-room').filter({ hasText: r1 }).click();
  await expectText(page, 'room one text more');
});

test('join box accepts a pasted link and rejects invalid ids with an inline error', async ({ page }) => {
  await page.goto('/');
  const input = page.getByLabel('Room ID or link');
  await input.fill('not a valid room!');
  await page.getByRole('button', { name: 'Join', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('letters, numbers');
  await expect(input).toHaveAttribute('aria-invalid', 'true');
  await input.fill('http://example.com/#pasted-room');
  await page.getByRole('button', { name: 'Join', exact: true }).click();
  await expect(page.getByTestId('room-id')).toHaveText('pasted-room');
});

test('rooms opened via links / hash navigation appear in Recent with the active one marked', async ({ page }) => {
  const r1 = newRoom('hash1'), r2 = newRoom('hash2');
  await openRoom(page, r1);
  await page.evaluate(id => { location.hash = id; }, r2);       // e.g. a pasted link or back/forward
  await expect(page.getByTestId('room-id')).toHaveText(r2);
  const recent = page.getByTestId('recent-room');
  await expect(recent.filter({ hasText: r2 })).toHaveAttribute('aria-current', 'page');
  await expect(recent.filter({ hasText: r1 })).not.toHaveAttribute('aria-current', 'page');
  await page.goBack();
  await expect(page.getByTestId('room-id')).toHaveText(r1);
  await expect(recent.filter({ hasText: r1 })).toHaveAttribute('aria-current', 'page');
});
