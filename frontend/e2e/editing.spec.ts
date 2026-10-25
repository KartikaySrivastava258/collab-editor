import { test, expect, newRoom, openRoom, newPeer, editor, expectText, serverText } from './helpers.ts';

test('U1 regression: typing over a selection replaces it (local and remote)', async ({ page, browser }) => {
  const room = newRoom();
  await openRoom(page, room);
  const b = await newPeer(browser, room);
  await editor(page).click();
  await page.keyboard.type('hello');
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('X');
  await expectText(page, 'X');
  await expectText(b.page, 'X');
});

test('U2 regression: paste / IME-style insertText is kept and synced', async ({ page, browser, baseURL }) => {
  const room = newRoom();
  await openRoom(page, room);
  const b = await newPeer(browser, room);
  await editor(page).click();
  await page.keyboard.type('ab');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.insertText('PASTED');
  await page.keyboard.type('c');
  await expectText(page, 'aPASTEDcb');
  await expectText(b.page, 'aPASTEDcb');
  expect(await serverText(baseURL!, room)).toBe('aPASTEDcb');
});

test('U3 regression: emoji and other non-BMP text round-trip between clients', async ({ page, browser }) => {
  const room = newRoom();
  await openRoom(page, room);
  const b = await newPeer(browser, room);
  await editor(page).click();
  await page.keyboard.type('a😀b');
  await page.keyboard.insertText(' 👩‍👩‍👧 é 漢字');
  await expectText(b.page, 'a😀b 👩‍👩‍👧 é 漢字');
  await page.keyboard.press('Backspace'); // removes 字
  await expectText(b.page, 'a😀b 👩‍👩‍👧 é 漢');
});

test('IME composition is committed once and is not clobbered by concurrent remote edits', async ({ page, browser }) => {
  const room = newRoom();
  await openRoom(page, room);
  const b = await newPeer(browser, room);
  await editor(page).click();
  await page.keyboard.type('end');
  await page.keyboard.press('Home');
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.imeSetComposition', { text: 'ni', selectionStart: 2, selectionEnd: 2 });
  await cdp.send('Input.imeSetComposition', { text: 'nih', selectionStart: 3, selectionEnd: 3 });
  // A remote edit arrives mid-composition.
  await editor(b.page).click();
  await b.page.keyboard.press('End');
  await b.page.keyboard.type('!');
  await page.waitForTimeout(300);
  await cdp.send('Input.insertText', { text: '你好' }); // commit
  await expectText(page, '你好end!');
  await expectText(b.page, '你好end!');
});

test('caret stays anchored mid-document when collaborators insert before and after it', async ({ page, browser }) => {
  const room = newRoom();
  await openRoom(page, room);
  const b = await newPeer(browser, room);
  await editor(page).click();
  await page.keyboard.type('world');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');            // A's caret: "wor|ld"
  await expectText(b.page, 'world');
  await editor(b.page).click();
  await b.page.keyboard.press('Home');
  await b.page.keyboard.type('Hello ');              // before A's caret
  await b.page.keyboard.press('End');
  await b.page.keyboard.type('!!');                  // after A's caret
  await expectText(page, 'Hello world!!');
  await page.keyboard.type('X');                     // must land where A's caret was
  await expectText(page, 'Hello worXld!!');
  await expectText(b.page, 'Hello worXld!!');
});

test('undo/redo affect only my edits; toolbar and keyboard both work', async ({ page, browser }) => {
  const room = newRoom();
  await openRoom(page, room);
  const b = await newPeer(browser, room);
  const undo = page.getByRole('button', { name: 'Undo' });
  const redo = page.getByRole('button', { name: 'Redo' });
  await expect(undo).toBeDisabled();
  await editor(page).click();
  await page.keyboard.type('mine');
  await expectText(b.page, 'mine');
  await editor(b.page).click();
  await b.page.keyboard.press('End');
  await b.page.keyboard.type(' theirs');
  await expectText(page, 'mine theirs');
  await page.keyboard.press('ControlOrMeta+Z');
  await expectText(page, ' theirs');
  await expectText(b.page, ' theirs');
  await expect(redo).toBeEnabled();
  await redo.click();
  await expectText(page, 'mine theirs');
  await undo.click();
  await expectText(b.page, ' theirs');
});

test('large paste is chunked under the message limit and fully delivered', async ({ page, browser, baseURL }) => {
  const room = newRoom();
  await openRoom(page, room);
  const b = await newPeer(browser, room);
  const big = 'lorem ipsum dolor sit amet '.repeat(400); // 10,800 chars > 1000 ops/message
  await editor(page).click();
  await page.keyboard.insertText(big);
  await expect(page.getByTestId('sync-status')).toHaveText('All changes synced to server memory', { timeout: 15_000 });
  await expect.poll(() => editor(b.page).inputValue(), { timeout: 15_000 }).toBe(big);
  expect(await serverText(baseURL!, room)).toBe(big);
});

test('copy and download actions produce the document text', async ({ page }) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await openRoom(page, newRoom());
  await editor(page).click();
  await page.keyboard.type('export me');
  await page.getByRole('button', { name: 'Copy document text' }).click();
  await expect(page.getByTestId('toast').last()).toContainText('copied');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('export me');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download as .txt' }).click()]);
  const path = await dl.path();
  const fs = await import('node:fs');
  expect(fs.readFileSync(path!, 'utf8')).toBe('export me');
});

test('randomized editing (typing, selections, deletes, paste, emoji, undo) keeps the binding consistent and converges', async ({ page, browser, baseURL }) => {
  test.setTimeout(90_000);
  const room = newRoom('fuzz');
  await openRoom(page, room);
  const b = await newPeer(browser, room);
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const consistent = (p: typeof page) => p.evaluate(() => (window as unknown as { __collabBinding: { checkConsistency(): boolean } }).__collabBinding.checkConsistency());
  for (let step = 0; step < 120; step++) {
    const p = rnd() < 0.7 ? page : b.page;
    const ed = editor(p);
    await ed.focus();
    const len = (await ed.inputValue()).length;
    const a = Math.floor(rnd() * (len + 1)), c = Math.min(len, a + Math.floor(rnd() * 4));
    await ed.evaluate((el: HTMLTextAreaElement, [s, e]) => el.setSelectionRange(s, e), [a, c]);
    const r = rnd();
    if (r < 0.45) await p.keyboard.type(['x', 'yz', ' ', 'é', '😀'][Math.floor(rnd() * 5)]);
    else if (r < 0.65) await p.keyboard.press('Backspace');
    else if (r < 0.8) await p.keyboard.insertText(['PASTE', '漢字', '👩‍👩‍👧', 'line\nbreak'][Math.floor(rnd() * 4)]);
    else if (r < 0.9) await p.keyboard.press('Delete');
    else await p.keyboard.press(rnd() < 0.5 ? 'ControlOrMeta+Z' : 'ControlOrMeta+Shift+Z');
    if (step % 10 === 0) expect(await consistent(p), `binding consistent at step ${step}`).toBe(true);
  }
  await expect.poll(async () => {
    const [x, y, s] = [await editor(page).inputValue(), await editor(b.page).inputValue(), await serverText(baseURL!, room)];
    return x === y && y === s;
  }, { timeout: 15_000 }).toBe(true);
  expect(await consistent(page)).toBe(true);
  expect(await consistent(b.page)).toBe(true);
});
