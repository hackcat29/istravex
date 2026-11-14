import { expect, test, type Page } from '@playwright/test';
import corpus from '../src/data/corpus.json' with { type: 'json' };

const SECTIONS = ['problem', 'kit', 'anatomy', 'fixtures', 'milestones', 'open-source', 'cta'];

function collectErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  return errors;
}

async function visitAll(page: Page) {
  for (const id of SECTIONS) {
    await page.locator(`#${id}`).scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
  }
}

test('renders every section with no errors or horizontal overflow', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('XDR conformance');
  await visitAll(page);
  for (const id of SECTIONS) await expect(page.locator(`#${id}`)).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  expect(errors).toEqual([]);
});

test('all three GPU scenes mount', async ({ page }) => {
  await page.goto('/');
  await visitAll(page);
  for (const id of ['top', 'anatomy', 'cta']) {
    await expect(page.locator(`#${id} [data-backend]`).first()).toHaveAttribute('data-state', 'ready', { timeout: 20_000 });
  }
});

test('scenes fall back when WebGPU is unavailable', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'gpu', { value: undefined }));
  const errors = collectErrors(page);
  await page.goto('/');
  await visitAll(page);
  await expect(page.locator('#top [data-backend]')).toHaveAttribute('data-backend', 'webgl2', { timeout: 20_000 });
  await expect(page.locator('#anatomy [data-backend]')).toHaveAttribute('data-backend', 'webgl2', { timeout: 20_000 });
  await expect(page.locator('#cta [data-backend]')).toHaveAttribute('data-backend', 'canvas2d', { timeout: 20_000 });
  expect(errors).toEqual([]);
});

test('problem tab shows the real muxed ID and its Number() corruption', async ({ page }) => {
  const id = corpus.anatomy.values.id;
  await page.goto('/#problem');
  await expect(page.locator('#problem')).toContainText(id);
  await expect(page.locator('#problem')).toContainText(String(Number(id)));
});

test('hero stats and fixtures come from the corpus', async ({ page }) => {
  const s = corpus.stats;
  await page.goto('/');
  await expect(page.locator('#top')).toContainText(`${s.sdk_checks_passed}/${s.sdk_checks}`);
  await expect(page.locator('#top')).toContainText(`${s.provenance_passed}/${s.provenance_checks}`);
  await expect(page.locator('#top')).toContainText(`${s.pilot_correct}/${s.pilot_fixtures}`);
  await page.locator('#fixtures').scrollIntoViewIfNeeded();
  await page.getByRole('tab', { name: /xdr\.b64/ }).click();
  await expect(page.locator('#fixtures pre')).toContainText(corpus.fixtures[0].primary.b64.slice(0, 40));
});

test('anatomy field picker updates the detail panel', async ({ page }) => {
  await page.goto('/#anatomy');
  await page.getByRole('option', { name: 'amount' }).click();
  await expect(page.locator('#anatomy h3')).toHaveText('amount');
});

test('mobile menu opens and navigates', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'mobile only');
  await page.goto('/');
  await page.getByRole('button', { name: 'Open menu' }).click();
  await page.locator('#mobile-menu').getByRole('link', { name: 'Milestones' }).click();
  await expect(page.locator('#mobile-menu')).toHaveCount(0);
  await expect(page.locator('#milestones')).toBeInViewport();
});

test('kit cards show the real audit, lint finding and pilot', async ({ page }) => {
  await page.goto('/#kit');
  const covered = corpus.coverage.xdr_caps.filter((c) => c.covered).length;
  await expect(page.locator('#kit-corpus')).toContainText(`${covered}/${corpus.coverage.xdr_caps.length}`);
  const f = corpus.pilot.lint.findings[0];
  await expect(page.locator('#kit-linter')).toContainText(`${f.file.split('/').pop()}:${f.line}`);
  await expect(page.locator('#kit-pilot')).toContainText(`wallet-backend@${corpus.pilot.ref.slice(0, 7)}`);
});

test('agent-readable files are served', async ({ request }) => {
  expect((await request.get('/llms.txt')).ok()).toBeTruthy();
  expect(await (await request.get('/proposal.md')).text()).toContain('Istravex');
});
