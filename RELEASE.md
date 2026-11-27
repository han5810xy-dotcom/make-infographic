# Release 1.0.1

## 这一版只改安装器

**出图、校验、模板和版式逻辑一字未变。**

v1.0.0 的外部实测暴露了两个安装链路问题：只检测 pnpm / corepack，漏掉 npm；解压后若依赖没有真正安装，直接运行会找不到 `puppeteer-core`。v1.0.1 只修复这两件事。

## 安装器变化

- 检测顺序改为：`pnpm` → `corepack pnpm` → `npm` → `npm.cmd`。
- 有 npm 时自动执行 `npm install --no-save --no-audit --no-fund puppeteer-core`。
- 三个包管理器都没有时，不再只说“装好再来”，而是打印三条路线：
  1. `npm i -g pnpm`
  2. `corepack enable`
  3. 手动解压，出图时加 `--html-only`，再用浏览器把 HTML 打印成 PNG。
- 成功时额外打印实际使用的安装器：`装依赖用的：pnpm / corepack / npm`。
- 原来的 pnpm 路径保持不变。

## 下载

- `make-infographic-1.0.1.zip`
- `install.mjs`

把两个文件放在同一文件夹，运行：

```powershell
node install.mjs
```

成功时最后一行是：

```text
装好了。在 Qoder 里选中一段文字，说『出图』。
```

## 产品边界不变

- 单张可见正文不超过 300 字。
- 超限自动裁剪，并打印「未上图」清单。
- 不缩字号、不截断、不用省略号。
- 1080px 主稿正文 38px；600px 宽约 21.1px。
- 缺少「原以为」「撞车」或「正解」时拒绝出图。
- 非逐字内容标为「归纳」，只进入 JSON 与终端。
- 使用本机 Edge 或 Chrome，不自动下载 Chromium。
- 不需要 API key，对话不上传。

## 文件

- `dist/make-infographic-1.0.1.zip`
- `dist/install.mjs`
- `dist/README.md`
- `examples/01-curiosity/`
- `examples/02-skip-signal/`
- `examples/03-repeat-node/`
