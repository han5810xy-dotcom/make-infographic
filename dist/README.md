# 对话出图（make-infographic）

把一段 AI 对话变成一张竖图：**原以为 → 撞车 → 正解 → 一句带走**。

不是摘要配图，而是记录你怎样想通。所有内容只留在本机，不需要 API key，也不会上传对话。

## 最简单安装

下载这个文件夹里的两个文件：

- `install.mjs`
- `make-infographic-1.0.0.zip`

打开 PowerShell，进入下载文件所在文件夹，运行：

```powershell
node install.mjs
```

安装脚本会自动找到 Qoder、Claude 或 DSH 的技能目录，检查 Node、pnpm、Edge / Chrome，并装好截图依赖。缺什么会用一句人话告诉你。

装成功后，最后一行是：

```text
装好了。在 Qoder 里选中一段文字，说『出图』。
```

## 手动安装

1. 把 `make-infographic-1.0.0.zip` 解压。
2. 将里面的 `make-infographic` 文件夹放进下面任意一个目录：
   - `C:\Users\你的名字\.qoder-cn\skills\`
   - `C:\Users\你的名字\.claude\skills\`
   - `C:\Users\你的名字\.dsh\skills\`
3. 在 Qoder 终端里进入技能目录，运行：

```bat
cd /d "%USERPROFILE%\.qoder-cn\skills\make-infographic"
pnpm add puppeteer-core
```

没有 pnpm 时，可改用 `npm install puppeteer-core`。

## 怎么用

回到任意 Qoder 对话，选中一段问答、讨论或笔记，对它说：**出图**。

也可以直接运行：

```bat
node "%USERPROFILE%\.qoder-cn\skills\make-infographic\scripts\make.mjs" --in "对话.md" --out "主题"
```

成功时终端最后一行是 `OK`，当前工作目录的 `infographics/` 中会有：

- `<主题>.png`：唯一默认图；
- `<主题>.html`：同版式网页投影；
- `<主题>.json`：完整转弯记录、来源标记、未上图清单与检查结果；
- `<主题>.source.md`：归档原文。

## 它会自动处理什么

- 缺「原以为」「撞车」或「正解」：不出图，并说清缺哪一块。
- 正文超过 300 字：自动裁剪，终端打印「未上图」清单；不缩字、不截断、不用省略号。
- 原话不逐字：自动标为「归纳」，只写进 JSON 和终端，不画到图上。
- 传入旧版式：自动换成四块转弯图。
- 1080px 主稿正文 38px，缩到 600px 宽约 21.1px。

## 常见问题

- **没有 Node**：先安装 Node 20 或更高版本，再重跑 `node install.mjs`。
- **没有 pnpm**：先安装 pnpm，再重跑；也可以手动进入技能目录运行 `npm install puppeteer-core`。
- **没有 Edge 或 Chrome**：安装其中一个，再重跑。脚本不会自动下载 Chromium。
- **找不到浏览器**：设置 `BROWSER_PATH` 指向 `msedge.exe` 或 `chrome.exe`。
- **浏览器暂时打不开**：可加 `--html-only`，只生成 HTML 并明确标注「未实测」。

完整 JSON 与归档原文是主资产；只剩 PNG 时可以看，但不能可靠地改措辞或重出。
