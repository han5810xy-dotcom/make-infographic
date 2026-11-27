import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readJsonOr, shaBytes, replaceFileAtomic, withFileLock, writeAtomic, writeBinaryAtomic, inspectLock, pidAlive } from './safeio.mjs';
import { startCli, checkFlags, workdir, wantsHelp, WORKDIR_HELP, WORKDIR_FLAGS } from './console.mjs';

const MANIFEST = '.knowledge/artifacts.json';
const MAX_VERSIONS = 50;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const manifestPath = (workspace) => join(resolve(workspace), MANIFEST);
const outputDir = (workspace, directory = 'infographics') => resolve(workspace, directory || 'infographics');

async function readManifest(workspace) {
  const data = await readJsonOr(manifestPath(workspace), {
    what: '产物登记',
    fix: '先保留这份文件；它只记录产物发布到哪一步，确认后再修复。',
  });
  if (!data) return { version: 1, artifacts: [] };
  if (data.version !== 1 || !Array.isArray(data.artifacts))
    throw new Error(`${manifestPath(workspace)} 不像一份可用的产物登记——先把它改名留下，别让下一条命令覆盖。`);
  return data;
}

async function writeManifest(workspace, data) {
  await writeAtomic(manifestPath(workspace), JSON.stringify(data, null, 2));
}

export async function withArtifactLock(workspace, fn) {
  return withFileLock(manifestPath(workspace), fn, { label: '产物登记与投影发布' });
}

async function listOutputs(workspace, directory = 'infographics') {
  const dir = outputDir(workspace, directory);
  try {
    return (await readdir(dir)).sort();
  } catch (e) {
    if (e && e.code === 'ENOENT') return [];
    throw new Error(`列不出产物目录 ${dir}：${e.message || e}\n  本次没有选择或覆盖任何产物名。`);
  }
}

function relatedNames(stem, names, extraNames = []) {
  const sidecar = new RegExp(`^${escapeRe(stem)}-\\d+\\.(?:png|svg|pdf|html|json)$`);
  return names.filter((name) =>
    name === `${stem}.json` || name === `${stem}.png` || name === `${stem}.svg` || name === `${stem}.pdf` || name === `${stem}.html` || name === `${stem}.md` ||
    name === `${stem}.source.md` || extraNames.includes(name) || sidecar.test(name));
}

async function existingFingerprint(workspace, stem, names, directory = 'infographics') {
  if (!names.includes(`${stem}.json`)) return '';
  const file = join(outputDir(workspace, directory), `${stem}.json`);
  let spec;
  try {
    spec = JSON.parse(await readFile(file, 'utf8'));
  } catch (e) {
    throw new Error(`已有内容记录读不懂，不能把它当成空名字继续写：${file}\n  ${e.message || e}\n  先保留这份文件并检查，再重跑。`);
  }
  return shaBytes(Buffer.from(JSON.stringify(spec), 'utf8'));
}

export async function reserveArtifact({ workspace, base, fingerprint, directory = 'infographics', extraNames = [], replace = false }) {
  if (!workspace || !base || !fingerprint) throw new Error('预留产物名缺少工作目录、名字或内容指纹。');
  const dir = outputDir(workspace, directory);
  const extras = [...new Set(extraNames)];
  for (const name of extras) {
    if (!name || basename(name) !== name || name.includes('\0')) throw new Error(`附加产物名不能包含目录：${name}`);
  }
  return withArtifactLock(workspace, async () => {
    await mkdir(dir, { recursive: true });
    const data = await readManifest(workspace);
    const names = await listOutputs(workspace, dir);
    const sameBundle = (a, s) => a.stem === s && (a.directory || outputDir(workspace)) === dir;
    let chosen = null;
    let note = '';
    for (let version = 1; version <= MAX_VERSIONS; version++) {
      const stem = version === 1 ? base : `${base}-v${version}`;
      const related = relatedNames(stem, names, extras);
      const active = data.artifacts.find((a) => sameBundle(a, stem) && ['generating', 'committing'].includes(a.state));
      if (active) continue;
      const recorded = data.artifacts.find((a) => sameBundle(a, stem) && a.state === 'complete');
      const same = related.length
        ? await existingFingerprint(workspace, stem, names, dir) === fingerprint
        : !!recorded && recorded.fingerprint === fingerprint;
      if (replace || !related.length || same) {
        chosen = { stem, related, version };
        note = version > 1 ? `同名位置被上一版占着：这一版另存为「${stem}」，上一版没有被覆盖。` : '';
        break;
      }
    }
    if (!chosen) throw new Error(`同名产物已经攒到 ${MAX_VERSIONS} 版（${base}）。\n  先整理旧产物，或者换一个 --out 名字；本次没有覆盖任何文件。`);

    const token = randomUUID();
    const previous = data.artifacts.find((a) => sameBundle(a, chosen.stem) && a.state === 'complete');
    const reservedFiles = [];
    for (const name of chosen.related) {
      const bytes = await readFile(join(dir, name));
      reservedFiles.push({ name, bytes: bytes.length, sha: shaBytes(bytes) });
    }
    const record = {
      stem: chosen.stem,
      directory: dir,
      extraNames: extras,
      fingerprint,
      state: 'generating',
      token,
      ownerPid: process.pid,
      startedAt: new Date().toISOString(),
      files: [],
      reservedFiles,
      previousFiles: previous?.files || [],
    };
    data.artifacts = data.artifacts.filter((a) => !(a.stem === chosen.stem && (a.directory || outputDir(workspace)) === dir));
    data.artifacts.push(record);
    await writeManifest(workspace, data);

    const stage = await mkdtemp(join(dir, '.artifact-'));
    record.stage = stage;
    await writeManifest(workspace, data);
    const added = [];
    let finished = false;
    const tx = {
      workspace,
      stem: chosen.stem,
      note,
      stage,
      path(name) {
        if (!name || basename(name) !== name || name.includes('\0')) throw new Error(`产物名不能包含目录：${name}`);
        return join(stage, name);
      },
      async add(name, content, { kind = 'text', media = '', widthPx = 0, heightPx = 0 } = {}) {
        if (added.some((f) => f.name === name)) throw new Error(`同一组产物里重复加入文件：${name}`);
        if (!relatedNames(chosen.stem, [name], extras).length)
          throw new Error(`文件不属于这次预留的产物组：${name}\n  这一组只发布「${chosen.stem}」及其编号投影；本次没有写盘。`);
        const staged = tx.path(name);
        if (kind === 'binary') {
          await writeBinaryAtomic(staged, content);
        } else {
          await writeAtomic(staged, String(content));
        }
        const bytes = await readFile(staged);
        const item = { name, kind, media: media || kind, bytes: bytes.length, sha: shaBytes(bytes), widthPx, heightPx };
        added.push(item);
        return { ...item, file: join(dir, name) };
      },
      async commit() {
        return withArtifactLock(workspace, async () => {
          const current = await readManifest(workspace);
          const rec = current.artifacts.find((a) => a.token === token && a.stem === chosen.stem && (a.directory || outputDir(workspace)) === dir);
          if (!rec || rec.state !== 'generating') throw new Error('这次产物预留已经被别处改变或结束，拒绝发布到旧名字。');
          const live = await listOutputs(workspace, dir);
          const reserved = new Map((rec.reservedFiles || []).map((f) => [f.name, f]));
          for (const item of added) {
            if (live.includes(item.name) && !reserved.has(item.name))
              throw new Error(`发布前出现了同名文件：${item.name}\n  本次没有覆盖它；请重跑，程序会另存一个新版本。`);
          }
          for (const [name, before] of reserved) {
            if (!live.includes(name))
              throw new Error(`预留后被别处移走：${name}\n  本次没有继续发布，也没有补造这一份。`);
            const nowBytes = await readFile(join(dir, name));
            if (shaBytes(nowBytes) !== before.sha)
              throw new Error(`预留后被别处改过：${name}\n  本次没有覆盖那份改动；请先确认它，再重跑。`);
          }
          const previousDir = join(stage, '.previous');
          await mkdir(previousDir, { recursive: true });
          for (const name of chosen.related) {
            if (!live.includes(name)) continue;
            await copyFile(join(dir, name), join(previousDir, name));
          }
          rec.state = 'committing';
          rec.files = added.map(({ name, kind, media, bytes, sha, widthPx, heightPx }) => ({ name, kind, media, bytes, sha, widthPx, heightPx }));
          await writeManifest(workspace, current);
          const published = [];
          const removed = [];
          let keepStage = false;
          try {
            for (const item of added) {
              await replaceFileAtomic(join(stage, item.name), join(dir, item.name));
              published.push(item.name);
            }
            for (const name of chosen.related) {
              if (added.some((f) => f.name === name)) continue;
              await rm(join(dir, name), { force: true });
              removed.push(name);
            }
            rec.state = 'complete';
            rec.completedAt = new Date().toISOString();
            delete rec.error;
            await writeManifest(workspace, current);
            finished = true;
            return { stem: chosen.stem, files: rec.files.map((f) => ({ ...f, file: join(dir, f.name) })) };
          } catch (e) {
            const rollbackErrors = [];
            for (const name of [...published].reverse()) {
              try {
                const old = join(previousDir, name);
                if (live.includes(name)) await replaceFileAtomic(old, join(dir, name));
                else await rm(join(dir, name), { force: true });
              } catch (rollbackError) {
                keepStage = true;
                rollbackErrors.push(`${name}: ${rollbackError.message || rollbackError}`);
              }
            }
            for (const name of removed) {
              try {
                await replaceFileAtomic(join(previousDir, name), join(dir, name));
              } catch (rollbackError) {
                keepStage = true;
                rollbackErrors.push(`${name}: ${rollbackError.message || rollbackError}`);
              }
            }
            rec.state = 'failed';
            rec.error = String(e.message || e);
            if (keepStage) rec.preserveStage = true;
            try {
              await writeManifest(workspace, current);
            } catch (manifestError) {
              keepStage = true;
              rollbackErrors.push(`产物登记: ${manifestError.message || manifestError}`);
            }
            const detail = rollbackErrors.length ? `\n  回滚也没有全部成功：${rollbackErrors.join('；')}\n  证据保留在 ${stage}` : '\n  上一版已恢复。';
            throw new Error(`整组产物发布失败：${e.message || e}${detail}`);
          } finally {
            if (!keepStage) await rm(stage, { recursive: true, force: true }).catch(() => {});
          }
        });
      },
      async abort(reason = '生成未完成') {
        if (finished) return;
        let preserveStage = false;
        await withArtifactLock(workspace, async () => {
          const current = await readManifest(workspace);
          const rec = current.artifacts.find((a) => a.token === token && a.stem === chosen.stem && (a.directory || outputDir(workspace)) === dir);
          preserveStage = !!rec?.preserveStage;
          if (rec && ['generating', 'committing'].includes(rec.state)) {
            rec.state = 'failed';
            rec.error = String(reason);
            await writeManifest(workspace, current);
          }
        }).catch(() => {});
        const rollbackEvidence = await stat(join(stage, '.previous')).then(() => true, () => false);
        if (!preserveStage && !rollbackEvidence) await rm(stage, { recursive: true, force: true }).catch(() => {});
      },
    };
    return tx;
  });
}

export async function artifactStatus(workspace) {
  const data = await readManifest(workspace);
  return {
    file: manifestPath(workspace),
    total: data.artifacts.length,
    unfinished: data.artifacts.filter((a) => a.state === 'generating' || a.state === 'committing').length,
    failed: data.artifacts.filter((a) => a.state === 'failed').length,
    preserved: data.artifacts.filter((a) => a.preserveStage).length,
  };
}

const STAGE_AGE_MS = 60 * 60 * 1000;

async function stageCandidates(workspace, { now = Date.now(), lockHeld = false } = {}) {
  const ws = resolve(workspace);
  const data = await readManifest(ws);
  const dirs = new Set([outputDir(ws), ...data.artifacts.map((a) => a.directory).filter((d) => typeof d === 'string')]);
  let active = false;
  if (!lockHeld) {
    const owner = await inspectLock(manifestPath(ws));
    active = !!owner?.owner && pidAlive(owner.owner.pid);
  }
  const del = [];
  const keep = [];
  for (const dir of dirs) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); }
    catch (e) { if (e?.code === 'ENOENT') continue; throw e; }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !entry.name.startsWith('.artifact-')) continue;
      const stage = join(dir, entry.name);
      const rec = data.artifacts.find((a) => a.stage && resolve(a.stage) === resolve(stage));
      const mtime = await stat(stage).then((s) => s.mtimeMs, () => 0);
      const evidence = await stat(join(stage, '.previous')).then(() => true, () => false);
      let why = '';
      if (!rec) why = '登记表里没有这份暂存目录，不敢自动删';
      else if (rec.preserveStage || evidence) why = '里面有回滚证据，必须保留';
      else if (active) why = '产物发布锁正被进程占用';
      else if ((rec.state === 'generating' || rec.state === 'committing') && rec.ownerPid && pidAlive(rec.ownerPid)) why = `生成进程 PID ${rec.ownerPid} 还在`;
      else if (!mtime || now - mtime < STAGE_AGE_MS) why = '还没过期（默认一小时内不动）';
      if (why) keep.push({ stage, state: rec?.state || '未登记', why });
      else del.push({ stage, state: rec?.state || '未知', mtimeMs: mtime });
    }
  }
  return { del, keep, active };
}

export async function inspectArtifacts(workspace) {
  const ws = resolve(workspace);
  const data = await readManifest(ws);
  const stages = await stageCandidates(ws);
  const dirs = new Set([outputDir(ws), ...data.artifacts.map((a) => a.directory).filter((d) => typeof d === 'string')]);
  const conflicts = [];
  for (const dir of dirs) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); }
    catch (e) { if (e?.code === 'ENOENT') continue; throw e; }
    for (const entry of entries) {
      if (entry.isFile() && /\.conflict-.+\.json$/.test(entry.name)) conflicts.push(join(dir, entry.name));
    }
  }
  return { ...stages, conflicts };
}

export async function cleanArtifactStages(workspace, yes = false) {
  return withArtifactLock(workspace, async () => {
    const { del, keep } = await stageCandidates(workspace, { lockHeld: true });
    console.log(`产物暂存目录检查：可清 ${del.length} 份，保留 ${keep.length} 份。`);
    for (const item of del) console.log(`  可清 ${item.stage}（${item.state}）`);
    for (const item of keep) console.log(`  不动 ${item.stage}：${item.why}`);
    if (!yes) {
      console.log('以上是预演，一个目录都没动。真清：node scripts/artifacts.mjs clean --cwd "<工作目录>" --yes');
      return 0;
    }
    let removed = 0;
    for (const item of del) {
      const evidence = await stat(join(item.stage, '.previous')).then(() => true, () => false);
      const data = await readManifest(workspace);
      const rec = data.artifacts.find((a) => a.stage && resolve(a.stage) === resolve(item.stage));
      if (!rec || rec.preserveStage || evidence) {
        console.log(`  这份已经有了回滚证据或登记变化，跳过：${item.stage}`);
        continue;
      }
      await rm(item.stage, { recursive: true, force: true });
      removed++;
    }
    console.log(`已清理 ${removed} 份确认过期的产物暂存目录；冲突件和回滚证据一个都没动。`);
    return 0;
  });
}

const FLAGS = ['yes', 'help', ...WORKDIR_FLAGS];
async function main(argv = process.argv.slice(2)) {
  checkFlags(argv, FLAGS);
  const workspace = workdir(argv);
  if (wantsHelp(argv) || !argv.length) {
    console.log('用法：node scripts/artifacts.mjs status [--cwd 目录]\n     node scripts/artifacts.mjs clean [--cwd 目录] [--yes]\nstatus 只读列出未完成发布、暂存目录和冲突件；clean 默认预演，只清确认过期的暂存目录。冲突件与回滚证据永不自动删。\n　' + WORKDIR_HELP);
    return 0;
  }
  if (argv[0] === 'status') {
    const state = await artifactStatus(workspace);
    const inventory = await inspectArtifacts(workspace);
    console.log(`产物登记：${state.total} 条，未完成 ${state.unfinished}，失败 ${state.failed}，保留回滚证据 ${state.preserved}。`);
    console.log(`暂存目录：可清 ${inventory.del.length}，保留 ${inventory.keep.length}。`);
    for (const item of inventory.keep) console.log(`  保留 ${item.stage}：${item.why}`);
    console.log(`冲突件：${inventory.conflicts.length} 份。这些是用户内容，只列不删。`);
    for (const file of inventory.conflicts) console.log(`  ${file}`);
    return 0;
  }
  if (argv[0] === 'clean') return cleanArtifactStages(workspace, argv.includes('--yes'));
  throw new Error('artifacts.mjs 只认 status 或 clean；要看作废版本请用 ledger.mjs show。');
}
startCli(import.meta.url, 'artifacts', main);

