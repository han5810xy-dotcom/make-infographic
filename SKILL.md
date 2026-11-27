---
name: make-infographic
description: 把一段 AI 对话先解析成有证据的知识结构，再投影成主图、分支细节图与知识总览。用户说「出图」、给对话文件、要求命题关系图/知识结构/多视图/意境图时使用。保留 turn card 作为实验图种；不需要 API key。
---

# 对话 → 知识结构

默认产物不是“文字直接变像素”。先写 Proposition／Relation／Structure，程序校验通过后才能建 View 和渲染。

## 一、三种入口

1. Qwen 扩展：捕获可见对话与可见思考，生成 Trace。
2. Qoder／DSH Skill：选中对话，说「出图」。
3. 导入：Markdown、纯文本或常见 JSON 导出。

三条路都先归档完整原文，保留发言者与 turn_index。

## 二、八步工作流（不许跳步）

1. **完整浏览**：数清用户与助手轮次，通读全文。
2. **注意力权重**：分析重复度、追问度、纠正度、位置度。
3. **理解内容**：逐条抽出单命题，附原句 evidence。
4. **逻辑提炼**：只在命题之间建八种关系，每条边引用讲述关系的原句。
5. **构建框架**：抽出 3~5 条 backbone；并列清单明确输出「这段对话是并列清单，没有单一骨架」。
6. **按拓扑选图**：chain→flow，tree→tree，matrix→matrix，network→network，cycle→network，forest→多张 tree。
7. **检查**：来源、方向、层级、节点数、内部字段、省略号、多图一致性、缺口显式呈现。
8. **输出**：主图 + 每个分支最多一张细节图；需要时加知识总览。

## 三、数据契约

```js
Proposition = {
  id, kind, text, // kind: 定义|主张|因果|条件|对比|步骤|例子|例外|数据
  evidence: [{ quote_id, speaker, turn_index, verbatim }],
  weight, provenance // quote|summary|inferred
}
Relation = {
  id, from, to, kind, // 因果|递进|对比|条件|转折|包含|支持|反驳
  evidence: [{ quote_id, verbatim: true }], strength
}
Structure = {
  id, topic, propositions, relations, topo, backbone, gaps
}
View = {
  id, target: 'backbone'|'branch:p3',
  graphic: 'flow'|'tree'|'matrix'|'network'|'timeline'|'pyramid'|'turn-band',
  props
}
```

作者稿里的 evidence 先写 `{speaker, turn_index, text, verbatim:true}`，由 `knowledge-authoring.mjs` 解析成稳定 `quote_id`。

## 四、证据规则

- 命题文字是原文逐字片段才标 `quote`；压缩或改写标 `summary`。
- 旧判断不能逐字引用时标 `inferred`，画面显示「推断」。
- 关系 evidence 必须逐字引用讲述关系的原句，不能拿“看起来像”凑。
- 条件→结果、原因→结果、具体→一般的箭头方向必须与原文一致。
- 例子不能与主结论连成因果或条件。
- 没有证据的命题或关系删掉，并写进 `gaps`，禁止脑补。

## 五、可视化语法

- 矩形＝命题；圆＝概念；菱形＝判断／条件；六边形＝例子；虚线框＝推断／缺口。
- 实线箭头＝因果；虚线箭头＝支持；双向箭头＝对比；方括号＝包含；折线＝条件分支。
- 蓝＝正解／主干；橙＝冲突／例外；灰＝背景；红＝错误或被推翻。
- 主干粗线重色，枝叶细线淡色；一张图不超过三个视觉层级。
- 角标只用小字：原话／归纳／推断。
- 转折带保留为一种图种：原以为 → 撞车 → 正解 → 一句带走。

## 六、命令

```bash
SKILL="$HOME/.qoder-cn/skills/make-infographic"
node "$SKILL/scripts/make.mjs" --in .source.md --out 主题
node "$SKILL/scripts/make.mjs" --spec 作者结构.json --in .source.md --out 主题
node "$SKILL/scripts/make.mjs" --demo
```

默认输出 PNG、SVG、HTML、Structure JSON、证据索引与归档原文。`--html-only` 只出 HTML，明确标注未做浏览器截图。

旧版 turn card：

```bash
node "$SKILL/scripts/make-turn-card.mjs" --in .source.md --out 主题
```

## 七、校验与降级

出图前执行 12 条检查：节点来源、边证据、悬空节点、孤立关系、箭头方向、例子层级、骨架、节点上限、内部字段、省略号、多图一致、缺口可见。

失败顺序：换视图 → 拆图 → 只出 HTML。禁止以“校验失败”结束，禁止把 PNG 当唯一资产。

## 八、网站与意境图

网站源码在 `site/web/`：卡片库、知识结构、个人档案、时间线。每张图都能点回来源对话。

意境图是第二出口，与信息图分开生成、分开存储：

```bash
node "$SKILL/scripts/ambient.mjs" prepare --source .source.md --out 意境图brief.json
node "$SKILL/scripts/ambient.mjs" import --brief 意境图brief.json --image 生成图.png --out-dir ambient
```

意境图只做装饰与纪念，不承载证据、关系或结论。

## Resources

- `scripts/make.mjs`：结构优先出图入口。
- `scripts/collect.mjs`：完整对话收集。
- `scripts/knowledge-authoring.mjs`：作者稿证据解析。
- `scripts/propositionize.mjs`：自动命题候选。
- `scripts/relations.mjs`：关系抽取与语义校验。
- `scripts/attention.mjs`：注意力权重、骨架与拓扑。
- `scripts/views.mjs`：主图、分支细节与知识总览。
- `scripts/output-checks.mjs`：12 条检查与降级。
- `scripts/render-structure.mjs` / `scripts/visual-syntax.mjs`：结构化 SVG／HTML／PNG。
- `scripts/ambient.mjs`：独立意境图出口。
- `scripts/make-turn-card.mjs`：旧版实验入口。
