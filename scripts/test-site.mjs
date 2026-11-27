import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, access, readdir, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { reserveArtifact } from './artifacts.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const web = join(root, 'site/web');
const utils = (await import(pathToFileURL(join(web, 'site-utils.js')))).default;
const exists = async (file) => access(file, constants.F_OK).then(() => true, () => false);

test('dynamic text is HTML-escaped in source-page titles and headings', async () => {
  const context = { window: {} };
  vm.runInNewContext(await readFile(join(web, 'data/library.js'), 'utf8'), context);
  const { items } = context.window.LIBRARY;
  assert.equal(items.length, 101);
  for (const item of items) {
    const html = await readFile(join(web, item.source), 'utf8');
    assert.equal(html.match(/<title>(.*?) · 来源<\/title>/)?.[1], utils.escapeHtml(item.title), item.source);
    assert.equal(html.match(/<h1>(.*?)<\/h1>/)?.[1], utils.escapeHtml(item.title), item.source);
  }
  assert.equal(utils.escapeHtml(`<img src=x onerror="alert(1)">&'`), '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&amp;&#39;');
});

test('mixed ISO, timezone and naive dates sort deterministically', () => {
  const values = ['2026-11-20T08:00:00.000Z', '2026-11-20 09:00', '2026-11-20T10:00:00+02:00', '2026-11-28 02:01'];
  assert.deepEqual([...values].sort(utils.compareDates), ['2026-11-20T08:00:00.000Z', '2026-11-20T10:00:00+02:00', '2026-11-20 09:00', '2026-11-28 02:01']);
  assert.equal(utils.timestamp('2026-02-30 10:00'), NaN);
  assert.equal(utils.timestamp('not-a-date'), NaN);
});

class Element {
  constructor(tag = 'div') { this.tag = tag; this.children = []; this.value = ''; this.dataset = {}; this.attributes = {}; this.hidden = false; this.textContent = ''; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener() {}
}

test('card rendering labels examples and sorts by parsed dates', async () => {
  const ids = Object.fromEntries(['grid', 'query', 'topic', 'status', 'sort', 'count', 'timing', 'more'].map((id) => [id, new Element()]));
  const context = {
    window: {
      SiteUtils: utils,
      LIBRARY: { items: [
        { id: 'old', title: '<script>alert(1)</script>', date: '2026-11-20T08:00:00.000Z', text: '', topics: [], status: 'draft', image: 'cards/old.svg', source: 'sources/old.html', synthetic: true },
        { id: 'new', title: '技能实测', date: '2026-11-28 02:01', text: '', topics: [], status: 'draft', image: 'cards/new.svg', source: 'sources/new.html', synthetic: false },
      ] },
    },
    document: { getElementById: (id) => ids[id], createElement: (tag) => new Element(tag) },
    performance: { now: () => 0 },
  };
  vm.runInNewContext(await readFile(join(web, 'library.js'), 'utf8'), context);
  assert.deepEqual(ids.grid.children.map((card) => card.children[1].children[0].textContent), ['技能实测', '<script>alert(1)</script>']);
  assert.match(ids.grid.children[1].children[1].children[1].textContent, /示例（合成测试数据，非你的真实历史）/);
  assert.match(ids.grid.children[0].children[1].children[1].textContent, /技能实测示例（非你的真实历史）/);
  const library = await readFile(join(web, 'library.html'), 'utf8');
  assert.match(library, /均不是你的真实历史/);
  const profile = await readFile(join(web, 'profile.html'), 'utf8');
  assert.match(profile, /非真实出图历史/);
});

test('manifest-owned orphans are pruned, arbitrary user files are preserved', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'site-export-test-'));
  try {
    const out = join(workspace, 'infographics');
    await mkdir(out, { recursive: true });
    await writeFile(join(out, 'user-notes.txt'), 'keep me');
    await writeFile(join(out, 'bundle-notes.txt'), 'also keep me');
    const first = await reserveArtifact({ workspace, base: 'bundle', fingerprint: 'one' });
    await first.add('bundle.json', '{"version":1}');
    await first.add('bundle-1.png', 'old', { kind: 'binary' });
    await first.add('bundle.source.md', 'old source');
    await first.commit();
    const second = await reserveArtifact({ workspace, base: 'bundle', fingerprint: 'two', replace: true });
    await second.add('bundle.json', '{"version":2}');
    await second.add('bundle.source.md', 'new source');
    await second.commit();
    assert.equal(await exists(join(out, 'bundle-1.png')), false, 'manifest-owned orphan should be removed');
    assert.equal(await readFile(join(out, 'user-notes.txt'), 'utf8'), 'keep me');
    assert.equal(await readFile(join(out, 'bundle-notes.txt'), 'utf8'), 'also keep me');
    const manifest = JSON.parse(await readFile(join(workspace, '.knowledge/artifacts.json'), 'utf8'));
    assert.equal(manifest.artifacts[0].state, 'complete');
    assert.deepEqual(manifest.artifacts[0].files.map((file) => file.name).sort(), ['bundle.json', 'bundle.source.md']);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('site exporter preserves escaping, deterministic dates, and ownership-based cleanup', async () => {
  const exporter = await readFile(join(root, 'site/tools/export-library.mjs'), 'utf8');
  assert.ok(exporter.includes('const escapeHtml = SiteUtils.escapeHtml;'));
  assert.ok(exporter.includes('escapeHtml(meta.title)'));
  assert.ok(exporter.includes('SiteUtils.compareDates(b.date, a.date)'));
  assert.ok(exporter.includes('for (const relative of previous)'));
  assert.ok(exporter.includes('if (generated.includes(relative)'));
  assert.ok(exporter.includes("relative.split('/').includes('..')"));
});

test('mobile keeps CTAs and lightbox/form have accessibility hooks', async () => {
  const css = await readFile(join(web, 'styles.css'), 'utf8');
  assert.doesNotMatch(css, /\.topnav a:not\(:last-child\)\s*\{\s*display:\s*none/);
  assert.match(css, /\.hero-actions\s*\{\s*flex-wrap:\s*wrap/);
  const app = await readFile(join(web, 'app.js'), 'utf8');
  for (const token of ["e.key === 'Escape'", "e.key === 'Tab'", 'node.inert = true', 'lastFocus?.isConnected']) assert.ok(app.includes(token), token);
  const form = await readFile(join(web, 'import.html'), 'utf8');
  for (const id of ['file', 'source', 'token']) assert.match(form, new RegExp(`for="${id}"`));
  assert.match(form, /aria-describedby="token-help"/);
});

function pathToFileURL(file) { return new URL(`file:///${file.replace(/\\/g, '/')}`); }
