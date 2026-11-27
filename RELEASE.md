# Release 1.0.0

## 这一版是什么

`make-infographic` 把一段对话收敛成一张四块转弯图：

**原以为 → 撞车 → 正解 → 一句带走**

默认只有这一种版式。旧版树图、因果图、流程、矩阵、关系图和卡片图不进入安装包。

## 安装

下载：

- `make-infographic-1.0.0.zip`
- `install.mjs`

把两个文件放在同一文件夹，运行：

```powershell
node install.mjs
```

成功时输出：

```text
装好了。在 Qoder 里选中一段文字，说『出图』。
```

## 本版边界

- 单张可见正文不超过 300 字。
- 超限自动裁剪，并打印「未上图」清单。
- 不缩字号、不截断、不用省略号。
- 1080px 主稿正文 38px；600px 宽约 21.1px。
- 缺少「原以为」「撞车」或「正解」时拒绝出图。
- 非逐字内容标为「归纳」，只进入 JSON 和终端。
- 使用本机 Edge 或 Chrome，不自动下载 Chromium。
- 不需要 API key，对话不上传。

## 验证

- 隔离目录真实安装成功。
- 安装后 `--demo` 成功生成 PNG、HTML、JSON 和归档原文。
- 终端最后一行：`OK`。
- 三段真实对话示例随仓库提供。

## 文件

- `dist/make-infographic-1.0.0.zip`
- `dist/install.mjs`
- `dist/README.md`
- `examples/01-curiosity/`
- `examples/02-skip-signal/`
- `examples/03-repeat-node/`
