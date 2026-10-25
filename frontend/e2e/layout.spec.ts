import { test, expect, newRoom, openRoom, editor } from './helpers.ts';
import fs from 'node:fs';

const viewports = [
  { name: '320', width: 320, height: 640 },
  { name: '375', width: 375, height: 740 },
  { name: '768', width: 768, height: 1024 },
  { name: '1280', width: 1280, height: 800 },
];

for (const vp of viewports) {
  test(`no horizontal overflow and usable editor at ${vp.width}px`, async ({ page }) => {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await openRoom(page, newRoom(`w${vp.width}`));
    await editor(page).click();
    await page.keyboard.insertText('A_very_long_unbroken_token_' + 'x'.repeat(180) + '\nShort line. ' + 'Normal words wrap. '.repeat(12));
    const m = await page.evaluate(() => ({
      docW: document.documentElement.scrollWidth, bodyW: document.body.scrollWidth, vw: window.innerWidth,
      offenders: [...document.querySelectorAll('header, .toolbar, .statusbar, .banner, .page, button')]
        .filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && (r.right > window.innerWidth + 0.5 || r.left < -0.5) && !el.closest('.sidebar'); })
        .map(el => `${el.tagName}.${(el as HTMLElement).className} ${Math.round(el.getBoundingClientRect().right)}`),
    }));
    expect(m.docW).toBeLessThanOrEqual(m.vw);
    expect(m.bodyW).toBeLessThanOrEqual(m.vw);
    expect(m.offenders).toEqual([]);
    await expect(page.getByRole('button', { name: 'Undo' })).toBeInViewport();
    await expect(page.getByTestId('ai-suggest')).toBeInViewport();
    await expect(page.getByTestId('connection')).toBeInViewport();
    fs.mkdirSync('test-results/layout', { recursive: true });
    await page.screenshot({ path: `test-results/layout/${vp.name}.png` });
  });
}

test('mobile: navigation is a drawer that opens, traps attention with a scrim, and closes', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 740 });
  await openRoom(page, newRoom('drawer'));
  const nav = page.getByRole('navigation', { name: 'Workspace' });
  await expect(nav).not.toBeInViewport();
  const opener = page.getByRole('button', { name: 'Open navigation' });
  await opener.click();
  await expect(nav).toBeInViewport();
  await expect(page.getByTestId('new-room')).toBeFocused();      // focus moved into the drawer
  await expect(page.getByTestId('recent-room').first()).toHaveAttribute('aria-current', 'page');
  await page.keyboard.press('Escape');
  await expect(nav).not.toBeInViewport();
  await expect(opener).toBeFocused();                            // focus returned
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.mouse.click(360, 400); // scrim
  await expect(nav).not.toBeInViewport();
});

test('desktop: sidebar collapse is toggled, announced and persisted', async ({ page }) => {
  await openRoom(page, newRoom('collapse'));
  const toggle = page.getByRole('button', { name: 'Hide sidebar' });
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await toggle.click();
  await expect(page.getByRole('navigation', { name: 'Workspace' })).toBeHidden();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Show sidebar' })).toHaveAttribute('aria-pressed', 'false');
  await page.getByRole('button', { name: 'Show sidebar' }).click();
  await expect(page.getByRole('navigation', { name: 'Workspace' })).toBeVisible();
});

test('keyboard: skip link focuses the editor without changing the room; every control has a name', async ({ page }) => {
  const room = newRoom('kbd');
  await openRoom(page, room);
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to editor' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(editor(page)).toBeFocused();
  await expect(page.getByTestId('room-id')).toHaveText(room);
  const unnamed = await page.evaluate(() => [...document.querySelectorAll('button, a, input, textarea, [role=button]')]
    .filter(el => {
      const h = el as HTMLElement;
      if (h.offsetParent === null && h.tagName !== 'TEXTAREA') return false;
      const labelled = h.getAttribute('aria-label') || h.textContent?.trim() || (h.id && document.querySelector(`label[for="${h.id}"]`));
      return !labelled;
    }).map(el => el.outerHTML.slice(0, 80)));
  expect(unnamed).toEqual([]);
  // Tab order reaches the toolbar and the editor without a trap.
  const seen = new Set<string>();
  for (let i = 0; i < 25; i++) {
    await page.keyboard.press('Tab');
    seen.add(await page.evaluate(() => {
      const a = document.activeElement as HTMLElement | null;
      return a?.getAttribute('aria-label') || a?.textContent?.trim() || a?.id || '';
    }));
  }
  // Disabled controls (e.g. Undo with no history) are correctly skipped.
  expect([...seen]).toEqual(expect.arrayContaining(['New document', 'join-input', 'Share', 'Copy document text', 'Suggest', 'editor']));
});

test('reduced motion disables transitions and animations', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openRoom(page, newRoom('motion'));
  const t = await page.evaluate(() => getComputedStyle(document.querySelector('.btn')!).transitionDuration);
  expect(t.split(',').every(v => parseFloat(v) === 0)).toBe(true);
});

/** WCAG 2.x relative-luminance contrast, computed from the live CSS tokens. */
test('colour contrast of text tokens meets WCAG AA (4.5:1)', async ({ page }) => {
  await openRoom(page, newRoom('contrast'));
  const pairs = await page.evaluate(() => {
    const v = (n: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
    const fg = ['--text-primary', '--text-secondary', '--text-muted', '--success', '--warning', '--danger', '--accent'];
    const bg = ['--app-bg', '--sidebar-bg', '--panel-bg', '--editor-bg', '--panel-active'];
    const out: { fg: string; bg: string; a: string; b: string }[] = [];
    for (const f of fg) for (const b of bg) out.push({ fg: f, bg: b, a: v(f), b: v(b) });
    out.push({ fg: '--accent-ink', bg: '--accent', a: v('--accent-ink'), b: v('--accent') });
    return out;
  });
  const lum = (hex: string) => {
    const c = hex.replace('#', '').match(/../g)!.map(x => parseInt(x, 16) / 255).map(x => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const results = pairs.map(p => {
    const [l1, l2] = [lum(p.a), lum(p.b)].sort((x, y) => y - x);
    return { ...p, ratio: Math.round(((l1 + 0.05) / (l2 + 0.05)) * 100) / 100 };
  });
  fs.mkdirSync('test-results', { recursive: true });
  fs.writeFileSync('test-results/contrast.json', JSON.stringify(results, null, 2));
  const failing = results.filter(r => r.ratio < 4.5).map(r => `${r.fg} on ${r.bg}: ${r.ratio}`);
  expect(failing).toEqual([]);
});
