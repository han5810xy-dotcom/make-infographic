# 对话 → 知识结构 → 学习证据

默认流程不是“文字直接变像素”，也不是把每次对话压成一张转弯卡。完整原文先变成有证据的知识结构，再成为跨对话积累、可以复习和迁移的学习资产。

## 1. 完整归档

把选中的对话完整存成 `<工作目录>/.source.md`。保留发言者、轮次、标点、代码、可见思考和原始措辞；不要先概括，不要补写原文没有的内容。

## 2. 完整通读

数清用户与助手轮次，通读全文。标出定义、旧判断、反例、纠正、结论、追问和例外。可见思考保留在 Trace 与归档中，不冒充用户已经掌握的证据。

## 3. 写作者结构

先逐条写 Proposition，再写 Relation：

- 一条命题只断言一件事，可见字数不超过 60。
- 每条命题附一至两条逐字 evidence；作者稿写 `{speaker, turn_index, text, verbatim:true}`。
- 关系只用因果、递进、对比、条件、转折、包含、支持、反驳，并引用讲述关系的原句。
- 没有证据的内容进入 `gaps`，不进入正式结构。
- `key_conclusions` 写最主要的三至五条逐字结论，用于覆盖检查。

作者稿格式见 `knowledge-workflow.md` 与 `examples/knowledge-ioed-authored.json`。

## 4. 校验并出图

```bash
SKILL="$HOME/.qoder-cn/skills/make-infographic"
node "$SKILL/scripts/make.mjs" --spec .spec.json --in .source.md --out 主题
```

没有作者稿时，以下命令只生成自动候选，并明确标记待复核：

```bash
node "$SKILL/scripts/make.mjs" --in .source.md --out 主题
```

程序输出主图、分支细节、知识总览、SVG／HTML／PNG、Structure JSON、证据索引与归档原文。整套产物位于 `<工作目录>/infographics/`。校验失败只写诊断报告并返回非零退出码，不打印 `OK`。

## 5. 同步为跨对话概念

每次成功出图会自动同步 `.knowledge/`。同一条命题在不同对话中得到同一个 `concept_id`；改写后的命题是新内容版本，可用合并命令归并到同一概念：

```bash
node "$SKILL/scripts/learn.mjs" sync
node "$SKILL/scripts/learn.mjs" merge <旧concept_id> <保留concept_id>
```

结构 ID 标识一份具体资产；概念 ID 标识可跨对话积累的学习对象。来源对话、证据与学习事件保留各自身份，不互相覆盖。

## 6. 先提取，后揭示

```bash
node "$SKILL/scripts/learn.mjs" due
node "$SKILL/scripts/learn.mjs" prompt <concept_id> --route explain
node "$SKILL/scripts/learn.mjs" answer <concept_id> --route explain --self-report without_looking --answer "自己的话"
node "$SKILL/scripts/learn.mjs" reveal <event_id>
```

题目只给线索，不给原命题答案。提交前先写自己的解释，再选择怎样完成：没看资料、看了提示、不确定或需要重学。系统不自动判分，不把词面重合当理解，也不把自述当正确率。

## 7. 本机学习工作台

```bash
node "$SKILL/scripts/learn.mjs" serve --port 5279
```

打开命令行打印的完整地址，包括 `#` 后面的本机令牌。工作台提供：

- 当前到期题目与自己的回答；
- 提交后揭示的原命题、原句证据与来源；
- 跨对话概念图谱；
- 自己的解释时间线；
- 分路径学习证据档案与完整学习包导出。

令牌只保存在当前浏览器会话，服务只监听 `127.0.0.1`，不向外部网站开放接口。

## 8. 导出、迁移与隐私

```bash
node "$SKILL/scripts/learn.mjs" export --out 学习包.json
node "$SKILL/scripts/learn.mjs" import --in 学习包.json
```

学习包包含来源结构、证据、概念映射与学习事件；重复导入不会重复写入。`.knowledge/`、`.bridge-token` 与本地 `infographics/` 已列入 Git 忽略规则。

确需公开知识产物时，使用白名单导出，不直接复制私有目录：

```bash
node "$SKILL/scripts/publish.mjs" --structure 结构.json --out 公开目录 --consent "我确认发布"
```

公开产物只含命题、关系与可选图片，不含原句 evidence、来源路径、学习事件或自述答案。

学习状态是私有数据，不进入公开网站或发布包。工程检查只能证明结构、证据与链路没有退化，不能证明学习效果。

## 旧版转弯卡

`make-turn-card.mjs` 与 `library.mjs`／`review.mjs` 仅保留读取和回归用途，不再是默认学习入口。旧卡的词面诊断与人工确认不能替代新的学习证据账本。
