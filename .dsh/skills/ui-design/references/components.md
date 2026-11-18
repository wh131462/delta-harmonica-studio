# 组件契约

所有类名都定义在 `src/renderer/src/styles/components.css`（基元）或 `layout.css`（外壳）。页面只能组合，不得重写外观。

## 按钮

```html
<button class="btn btn--primary">开始演奏</button>
<button class="btn">导入文件</button>
<button class="btn btn--quiet btn--sm">立即解析</button>
<button class="btn btn--danger btn--sm"><svg…/> 停止</button>
<button class="btn btn--icon" aria-label="关闭"><svg…/></button>
```

| 类 | 用途 | 规则 |
|---|---|---|
| `.btn` | 次级操作（默认形态） | 一个操作区最多 1 个主按钮，其余用它 |
| `.btn--primary` | 页面主操作（琥珀色调：浅底 + 描边） | 每个任务区最多 1 个 |
| `.btn--accent` | **全应用唯一**：播放条「开始演奏」 | 任何页面内都不得使用 |
| `.btn--quiet` | 低权重操作（页面头工具、卡片内联） | 不用于关键路径 |
| `.btn--danger` | 停止 / 删除 | 必须带图标或明确动词 |
| `.btn--sm` / `.btn--lg` | 尺寸 | 页面头用 `--sm`，主操作用默认 |
| `.btn--icon` | 纯图标 | 必须有 `aria-label` + `title` |
| `.btn.is-active` | 开关型按钮的激活态 | 配合 `aria-pressed` |

禁用用 `disabled` 属性（不要只加 class）。加载中：`disabled` + `.btn--loading`，同时把文案改成「准备中…」这类进行时。

## 表单

```html
<label class="field">
  <span class="field-label">速度（BPM）</span>
  <input class="input number" type="number" />
</label>

<div class="field">
  <span class="field-label">拍号</span>
  <div class="field-inline">
    <select class="select">…</select><span class="muted">/</span><select class="select">…</select>
  </div>
</div>

<label class="switch"><input type="checkbox" /><span>焦点保护</span></label>
```

- `.field` 是纵向「标签 + 控件」；`.field-inline` 横排同组控件；`.field-row` 是整行字段容器。
- **禁止 `<label>` 套 `<label>`**：开关放在 `.field` 的 `div` 里，开关自身仍是 `<label>`。
- 数字输入统一 `.input.number`（等宽、居中、88px）。
- 密集工具条里用 `.select.compact`。
- 占位符只写格式示例，不写解释；解释放 `.field-hint`。
- 必需/错误信息放在控件下方 `.inline-error`，颜色之外必须有文字。

## 面板（卡片）

```html
<section class="card">
  <div class="card-title-row">
    <h2 class="card-title"><Icon name="edit" size={15} /> 简谱文本</h2>
    <div class="inline-actions">…</div>
  </div>
  …内容…
</section>
```

- 一个页面区块只允许一层 `.card`；卡内不要再套卡。
- 分组优先用 `.section-label`（10px 大写字距标签）+ 间距 + `.divider`，而不是新容器。
- 卡与卡之间由 `.page` 的 `gap` 控制，不要在卡片上加 margin。

## 标签与徽标

```html
<span class="badge badge--ok">已就绪</span>
<span class="badge badge--warn">未保存</span>
<span class="chip"><span class="chip-label">速度</span><span class="chip-value">127.9 BPM</span></span>
<kbd>F9</kbd>
```

- `.badge` 表达**状态**（就绪/未保存/异常）；`.chip` 表达**只读数据**（速度/调号/音符数）。
- 徽标最多 4 个字；不要用徽标承载句子。
- 颜色语义：绿=正常、琥珀=需要留意/未完成、红=失败/破坏性、青=系统信息。

## 提示条

```html
<div class="notice notice--warn">
  <div class="notice__icon"><Icon name="warning" size={15} /></div>
  <div class="notice__body">
    <strong class="notice__title">尚未以管理员权限运行</strong>
    <span class="notice__desc">向游戏注入按键可能被系统拦截。</span>
  </div>
  <div class="notice__actions"><button class="btn btn--sm">以管理员重启</button></div>
</div>
```

- 页面级提示最多 1 条；同一事实不要在页面、侧栏、顶栏同时出现。
- 成功提示不要用提示条常驻，用 Toast 或状态徽标。

## 空态

```html
<div class="empty-state">
  <div class="empty-icon"><Icon name="library" size={20} /></div>
  <h3>还没有音乐方案</h3>
  <p>导入 MIDI / 音频，或在编辑器里手写一份简谱。</p>
  <div class="empty-actions"><button class="btn btn--primary btn--sm">智能导入</button></div>
</div>
```

空态三要素：**是什么 + 为什么空 + 下一步**。一个主操作即可。

## 标签页

```html
<div class="tabs" role="tablist">
  <button class="tab" role="tab" aria-selected="true">演奏设置</button>
  <button class="tab" role="tab" aria-selected="false">演奏计划</button>
</div>
```

用 `aria-selected` 表达选中；不要用 `.active` 单独表达语义。

## 进度

```html
<div class="progress"><div class="progress-bar" style="width:42%"></div></div>
```

进度条必须有外层尺寸约束；不确定进度用文字「准备中…」而不是卡住的条。

## 谱面

```html
<div class="score-surface score-surface--compact">
  <ScoreView score={score} … />
</div>
```

- 谱面统一放在 `.score-surface`（暖色纸面 + `--sv-*` 主题变量）中；不要再用旧 `.score-paper`。
- 纸面是唯一的暖色区域，页面别处不要出现米色/暖色块。
- 高度受限时给容器 `max-height` + `overflow:auto`，不要把页面撑出滚动条。

## 弹窗与 Toast

- 用 `components/Modal.tsx` 的 `Modal` / `Toast`，不要手写遮罩。
- 弹窗标题 = 动作/对象（「导出键位谱」），副标题 = 一句说明；底部按钮右对齐，危险操作靠左。
- Toast 只用于**用户刚做的动作**的结果；后台轮询/自动状态不要弹 Toast。

## 已废弃别名（迁移期）

`.button`、`.button.primary/ghost/danger/small`、`.icon-button.bordered` 仍可用但不再扩展；新代码一律用 `.btn` 体系。迁移完成后删除。
