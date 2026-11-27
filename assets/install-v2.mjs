import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

const VERSION = "2.0.0";
const ZIP_NAME = `make-infographic-${VERSION}.zip`;
const scriptDirectory = (() => {
  try { return dirname(fileURLToPath(import.meta.url)); } catch { return process.cwd(); }
})();

function say(message) {
  console.log(message);
}

function fail(message) {
  console.error(`没装好：${message}`);
  process.exitCode = 1;
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: "utf8",
    shell: process.platform === "win32",
    ...options,
  });
}

async function pathExists(path) {
  try { await readFile(path); return true; } catch { return existsSync(path); }
}

async function findZip() {
  const explicit = process.env.MAKE_INFOGRAPHIC_ZIP;
  if (explicit) {
    const path = resolve(explicit);
    if (!(await pathExists(path))) throw new Error(`找不到安装包：${path}`);
    return path;
  }
  const candidates = [join(process.cwd(), ZIP_NAME), join(scriptDirectory, ZIP_NAME)];
  for (const path of candidates) if (await pathExists(path)) return path;
  for (const directory of [process.cwd(), scriptDirectory]) {
    let names = [];
    try { names = await readdir(directory); } catch {}
    const match = names.find((name) => /^make-infographic-.*\.zip$/i.test(name));
    if (match) return join(directory, match);
  }
  throw new Error(`当前文件夹里没有 ${ZIP_NAME}。把安装包和 install.mjs 放在一起再运行。`);
}

async function chooseTarget() {
  const argumentIndex = process.argv.indexOf("--target");
  if (argumentIndex >= 0) {
    const value = process.argv[argumentIndex + 1];
    if (!value) throw new Error("--target 后面要写技能目录。");
    return resolve(value);
  }
  const home = homedir();
  const candidates = [
    join(home, ".qoder-cn", "skills"),
    join(home, ".claude", "skills"),
    join(home, ".dsh", "skills"),
  ];
  return candidates.find((path) => existsSync(path)) || candidates[0];
}

function checkNode() {
  const major = Number(process.versions.node.split(".")[0]);
  if (!Number.isFinite(major) || major < 20) {
    throw new Error("这台电脑没有 Node 20 或更高版本，装好再来。");
  }
}

function detectInstaller() {
  const direct = run("pnpm", ["--version"]);
  if (direct.status === 0 && direct.stdout.trim()) {
    return { command: "pnpm", args: ["add", "puppeteer-core"], how: "pnpm" };
  }
  const corepack = run("corepack", ["pnpm", "--version"]);
  if (corepack.status === 0 && corepack.stdout.trim()) {
    return { command: "corepack", args: ["pnpm", "add", "puppeteer-core"], how: "corepack" };
  }
  for (const npm of ["npm", "npm.cmd"]) {
    const probe = run(npm, ["--version"]);
    if (probe.status === 0 && probe.stdout.trim()) {
      return {
        command: npm,
        args: ["install", "--no-save", "--no-audit", "--no-fund", "puppeteer-core"],
        how: "npm",
      };
    }
  }
  throw new Error(
    "这台电脑找不到 pnpm / corepack / npm，没办法装截图依赖。三条路任选一条，然后重跑本脚本：\n" +
      "  1) npm i -g pnpm      （Node 官方安装包自带 npm，最省事）\n" +
      "  2) corepack enable    （Node 16.9 及以上自带 corepack）\n" +
      "  3) 一条都不装：把 zip 手动解压到技能目录，出图时加 --html-only，再用浏览器把 HTML 打印成 PNG",
  );
}

function browserCandidates() {
  const paths = [];
  if (process.env.BROWSER_PATH) paths.push(process.env.BROWSER_PATH);
  if (process.platform === "win32") {
    paths.push(
      "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
      "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
      "C:/Program Files/Google/Chrome/Application/chrome.exe",
      "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    );
  } else if (process.platform === "darwin") {
    paths.push(
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    );
  } else {
    paths.push("/usr/bin/microsoft-edge", "/usr/bin/google-chrome", "/usr/bin/chromium-browser");
  }
  return paths.filter(Boolean);
}

function checkBrowser() {
  const found = browserCandidates().find((path) => existsSync(path));
  if (!found) throw new Error("这台电脑没有 Edge 或 Chrome，装好再来。");
  return found;
}

function endOfCentralDirectory(buffer) {
  for (let index = buffer.length - 22; index >= Math.max(0, buffer.length - 65557); index--) {
    if (buffer.readUInt32LE(index) === 0x06054b50) return index;
  }
  throw new Error("安装包损坏了，没有找到 ZIP 目录。");
}

function safeEntryName(name) {
  const normalized = name.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) {
    throw new Error("安装包里有不安全的文件路径。");
  }
  const parts = normalized.split("/");
  if (parts.includes("..") || parts.includes(".")) throw new Error("安装包里有不安全的文件路径。");
  return parts;
}

async function extractZip(zipPath, destination) {
  const buffer = await readFile(zipPath);
  const eocd = endOfCentralDirectory(buffer);
  const entries = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  let cursor = centralOffset;
  const centralEnd = centralOffset + centralSize;

  for (let index = 0; index < entries; index++) {
    if (cursor + 46 > centralEnd || buffer.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error("安装包目录不完整，请重新下载。");
    }
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const size = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    const parts = safeEntryName(name);
    const target = join(destination, ...parts);

    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error(`安装包里的 ${name} 损坏了。`);
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buffer.length) throw new Error(`安装包里的 ${name} 不完整。`);
    const compressed = buffer.subarray(dataStart, dataEnd);
    let data;
    if (method === 0) data = compressed;
    else if (method === 8) data = inflateRawSync(compressed);
    else throw new Error(`安装包使用了不支持的压缩方式：${method}`);
    if (data.length !== size) throw new Error(`安装包里的 ${name} 大小不对。`);
    if (name.endsWith("/")) {
      await mkdir(target, { recursive: true });
    } else {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, data);
    }
    cursor += 46 + nameLength + extraLength + commentLength;
  }
}

async function main() {
  checkNode();
  const installer = detectInstaller();
  const browser = checkBrowser();
  const zipPath = await findZip();
  const targetRoot = await chooseTarget();
  const target = join(targetRoot, "make-infographic");
  await mkdir(targetRoot, { recursive: true });

  if (existsSync(target)) {
    const backup = `${target}.backup-${Date.now()}`;
    await rename(target, backup);
    say(`发现旧版，已备份到 ${backup}`);
  }

  await extractZip(zipPath, target);
  say(`技能文件已放进 ${target}`);
  say(`浏览器：${browser}`);
  say(`装依赖用的：${installer.how}`);
  const install = run(installer.command, installer.args, {
    cwd: target,
    stdio: "inherit",
  });
  if (install.status !== 0) throw new Error("依赖没装上。请检查网络后重跑。");
  say("装好了。在 Qoder 里选中一段文字，说『出图』。");
}

main().catch((error) => {
  fail(error?.message || "发生了未知问题。");
});
