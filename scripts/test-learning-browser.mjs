import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { finalizeStructure } from './knowledge-contract.mjs';
import { syncLearning } from './learning-core.mjs';
import { startLearningServer } from './learn-server.mjs';
import { launchBrowser, closeBrowser } from './browser.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const outDir = join(root, 'eval/learning-browser');
await mkdir(outDir, { recursive: true });
const workspace = await mkdtemp(join(tmpdir(), 'make-infographic-learn-browser-'));
let running;
let browser;
try {
  const structure = finalizeStructure({
    topic: '理解与熟悉', headline: '熟悉不是理解',
    propositions: [
      { id: 'p1', kind: '主张', layer: 'main', text: '重读只让文字更熟悉', evidence: [{ quote_id: 'q1', speaker: 'assistant', turn_index: 0, verbatim: true }], weight: 0.9, provenance: 'quote' },
      { id: 'p2', kind: '步骤', layer: 'main', text: '先独立回忆再看答案', evidence: [{ quote_id: 'q2', speaker: 'assistant', turn_index: 0, verbatim: true }], weight: 0.8, provenance: 'quote' },
      { id: 'p3', kind: '主张', layer: 'branch', text: '能独立回忆才是掌握', evidence: [{ quote_id: 'q3', speaker: 'assistant', turn_index: 0, verbatim: true }], weight: 0.7, provenance: 'quote' },
    ],
    relations: [{ id: 'r1', from: 'p2', to: 'p3', kind: '支持', evidence: [{ quote_id: 'q1', speaker: 'assistant', turn_index: 0, verbatim: true }], strength: 0.9 }],
    topo: 'chain', backbone: ['p1', 'p2', 'p3'], gaps: [],
  });
  structure.source_hash = 'browser-document';
  await mkdir(join(workspace, 'infographics'), { recursive: true });
  await writeFile(join(workspace, 'infographics/a.json'), JSON.stringify(structure));
  await writeFile(join(workspace, 'infographics/a.source.md'), '助手：重读只让文字更熟悉。先独立回忆再看答案。能独立回忆才是掌握。');
  await writeFile(join(workspace, 'infographics/a.evidence.json'), JSON.stringify(Object.fromEntries(['q1', 'q2', 'q3'].map((id, index) => [id, { quote_id: id, speaker: 'assistant', turn_index: 0, text: structure.propositions[index].text }]))));
  await syncLearning(workspace);
  running = await startLearningServer({ workspace, port: 0 });
  browser = await launchBrowser();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => { errors.push(error.message); console.error('PAGEERROR', error.message); });
  page.on('console', (message) => { if (message.type() === 'error') { errors.push(message.text()); console.error('CONSOLE', message.text()); } });
  for (const width of [375, 1080]) {
    await page.setViewport({ width, height: 900 });
    await page.goto(running.url.replace('/#', `/?v=${width}#`), { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => document.querySelector('#answer') || document.querySelector('#review-content .empty'));
    assert.ok(await page.$('#answer'), await page.$eval('#review-content', (element) => element.textContent));
    assert.equal(new URL(page.url()).hash, '');
    const prompt = await page.$eval('#prompt-title', (element) => element.textContent);
    assert.ok(!prompt.includes('重读只让文字更熟悉'));
    assert.ok(!prompt.includes('先独立回忆再看答案'));
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    assert.ok(overflow <= 1, `学习工作台 ${width} 横向溢出 ${overflow}`);
    if (width === 375) {
      await page.type('#answer', '重读之后我觉得更熟了，但这不等于能脱离材料回忆。');
      await page.click('#answer-form button[type=submit]');
      await page.waitForSelector('.reveal');
      const reveal = await page.$eval('.reveal', (element) => element.textContent);
      assert.ok(reveal.includes('原对话里的判断'));
      assert.ok(reveal.includes('来源证据'));
      assert.ok(reveal.includes('重读只让文字更熟悉') || reveal.includes('先独立回忆再看答案') || reveal.includes('能独立回忆才是掌握'));
      await page.click('#tab-graph');
      await page.waitForSelector('.graph-node');
      assert.equal(await page.$$eval('.graph-node', (nodes) => nodes.length), 3);
      await page.click('#tab-explanations');
      await page.waitForSelector('.timeline li');
      assert.match(await page.$eval('.timeline', (element) => element.textContent), /重读之后我觉得更熟了/);
      await page.click('#tab-archive');
      await page.waitForSelector('.counts');
      assert.match(await page.$eval('.counts', (element) => element.textContent), /学习记录/);
    }
    await page.screenshot({ path: join(outDir, `learn-${width}.png`), fullPage: true });
  }
  assert.deepEqual(errors, []);
} finally {
  await closeBrowser(browser);
  if (running) await new Promise((resolvePromise) => running.server.close(resolvePromise));
  await rm(workspace, { recursive: true, force: true, maxRetries: 5 });
}
console.log(JSON.stringify({ pass: true, widths: [375, 1080], flow: 'prompt → own answer → evidence → graph → timeline → archive' }, null, 2));
console.log('LEARNING BROWSER OK');
