import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser, closeBrowser } from './browser.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const web = join(root, 'site/web');
const outDir = join(root, 'site/eval/browser-repair');
await mkdir(outDir, { recursive: true });
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const file = resolve(web, `.${pathname === '/' ? '/index.html' : pathname}`);
    if (!file.startsWith(`${web}${sep}`) && file !== web) throw new Error('invalid path');
    const body = await readFile(file);
    response.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream' });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end('not found');
  }
});
await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await launchBrowser();
const results = [];
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('response', (response) => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
  for (const width of [375, 1080]) {
    await page.setViewport({ width, height: 900 });
    for (const name of ['index', 'demo', 'published', 'library', 'structure', 'profile', 'ambient', 'import']) {
      await page.goto(`${base}/${name}.html`, { waitUntil: 'networkidle0' });
      const metrics = await page.evaluate(() => ({
        title: document.title,
        width: innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        main: !!document.querySelector('main'),
        cards: document.querySelectorAll('.card, .timeline-item').length,
      }));
      assert.ok(metrics.main, `${name} 缺少 main：${JSON.stringify(metrics)}`);
      assert.ok(metrics.title, `${name} 缺少标题`);
      assert.ok(metrics.scrollWidth <= width + 1, `${name}/${width} 横向溢出 ${metrics.scrollWidth}`);
      if (name === 'import') {
        await page.click('#sample');
        assert.match(await page.$eval('#status', (element) => element.textContent), /已解析 2 轮/);
        assert.equal(await page.$$eval('#turns .turn', (nodes) => nodes.length), 2);
      }
      if (name === 'index') {
        await page.click('.shot');
        assert.equal(await page.$eval('#lb', (element) => element.hidden), false);
        await page.keyboard.press('Escape');
        assert.equal(await page.$eval('#lb', (element) => element.hidden), true);
      }
      await page.screenshot({ path: join(outDir, `${name}-${width}.png`), fullPage: true });
      results.push({ page: name, width, ...metrics });
    }
  }
  assert.deepEqual(errors, [], `浏览器错误：${errors.join('；')}`);
} finally {
  await closeBrowser(browser);
  await new Promise((resolvePromise) => server.close(resolvePromise));
}
await writeFile(join(outDir, 'results.json'), `${JSON.stringify({ pass: true, results }, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ pass: true, page_checks: results.length, widths: [375, 1080] }, null, 2));
console.log('SITE BROWSER OK');
