# 对话 → 知识结构（make-infographic）2.1.0

先立命题与关系，再决定它长成什么图。每个结论、每条边、每个缺口都能回到原句。

## 安装

把 `install.mjs` 和 `make-infographic-2.1.0.zip` 放在同一个文件夹，运行：

```powershell
node install.mjs
```

安装器会查找 Qoder／Claude／DSH 技能目录，检查 Node 20+ 和 Edge／Chrome，并安装截图依赖。不会自动下载 Chromium。

## 使用

在 Qoder／DSH 中选中一段对话，说「出图」。也可以直接运行：

```bat
node "%USERPROFILE%\.qoder-cn\skills\make-infographic\scripts\make.mjs" --in "对话.md" --out "主题"
```

零 key 示例：

```bat
node "%USERPROFILE%\.qoder-cn\skills\make-infographic\scripts\make.mjs" --demo
```

成功时最后一行是 `OK`。产物在 `infographics/`：

- `*-v1.png`：主图；
- `*-v2.png`：分支细节图；
- `*-v3.png`：知识总览；
- 对应的 `.svg`、`.html`；
- `.json`：完整 Structure；
- `.evidence.json`：quote_id 到原句的索引；
- `.source.md`：归档原文。

旧版 turn card 保留在 `scripts/make-turn-card.mjs`，不再是默认入口。

## 学习

```bat
node "%USERPROFILE%\.qoder-cn\skills\make-infographic\scripts\learn.mjs" due
node "%USERPROFILE%\.qoder-cn\skills\make-infographic\scripts\learn.mjs" serve --port 5279
```

先写自己的解释，再揭示原对话证据。工作台只监听本机；不自动判分，不生成掌握率。 `.knowledge/` 是私有学习数据，不进入公开包。

## 作者结构

模型先读完整对话，写 Proposition／Relation／Structure；脚本只做证据解析、校验、降级与渲染。作者稿示例：

```json
{
  "topic": "分数与理解",
  "propositions": [
    {
      "id": "p1",
      "kind": "主张",
      "text": "分数高说明学习有效",
      "evidence": [{ "speaker": "user", "turn_index": 0, "text": "我以为分数高就说明学习有效。", "verbatim": true }],
      "provenance": "summary"
    }
  ],
  "relations": [],
  "gaps": [],
  "key_conclusions": ["我以为分数高就说明学习有效。"]
}
```

用 `scripts/knowledge.mjs resolve` 解析证据，用 `scripts/knowledge.mjs workflow` 跑八步工作流。

## 复习与卡片库

已有 101 张卡、探针排期、关键词／日期／主题／状态检索继续保留。网站源码在 `site/web/`，提供卡片库、知识结构、个人档案、时间线与独立意境图页面。

## 边界

- 命题最多 30 条，超限按主题拆分。
- 每条关系必须有讲述它的原句；弱关系不进主图。
- 主图最多 7 个节点，细节图最多 12 个。
- 失败时换视图、拆图或只出 HTML，禁止把校验失败当成交付。
- 工程验收不等于学习效果验证。
