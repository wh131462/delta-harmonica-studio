---
name: ui-design
description: 三角洲口琴工坊（delta-harmonica-studio）的界面设计系统与 UX 规范：色彩/字体/间距令牌，组件契约，交互与可访问性规则，截图验收流程。凡是新增、修改、评审本仓库 Electron 渲染层界面（src/renderer）的样式、组件、页面布局、文案或状态呈现，都先加载本 skill。
whenToUse: 修改 src/renderer 下的 .tsx/.css、调整布局或视觉、评审界面截图、为页面新增控件/状态/空态、统一多页面观感时使用。
metadata:
  version: 2.0.0
  owner: delta-harmonica-studio
  scope: src/renderer
---

# 口琴工坊 · UI 设计系统

本项目是一个**夜间使用的乐器级工作台**：用户在游戏旁快速选谱、校验、然后按下 F9。界面要在 1 秒内回答三个问题：**我在哪、当前这首曲子是什么、下一步按哪里**。设计目标是「安静的专业工具」——信息密度高但不喧闹，强调色只出现在真正需要动作的地方。

## 设计语言一句话

> 深色石墨底、单一琥珀聚光灯、青蓝色只用于系统信号；用排版和留白分层，而不是用卡片和描边堆叠。

## 工作流程（必须按顺序）

1. **先读令牌**：`references/tokens.md` 是唯一色彩/字号/间距来源。不要在新代码里写死颜色、字号、圆角、阴影。
2. **再读组件契约**：`references/components.md` 给出可复用的类名与标记结构。优先复用，缺什么先补基元，不要在页面里发明一次性的变体。
3. **交互按 UX 规则**：`references/ux-patterns.md` 规定了主操作唯一性、状态呈现、反馈、空态、快捷键与无障碍要求。
4. **改完自检**：按 `references/review-checklist.md` 逐项勾选，并生成截图对比（见该文件末尾的截图流程）。
5. 视觉判断拿不准时读 `references/design-language.md`，里面写了每条规则的**理由**和反例。

## 不可协商的规则（违反即返工）

1. **一个任务区一个主操作**：页面主操作使用 `.btn--primary`（琥珀色调：浅底 + 描边），全应用**唯一**的实心琥珀按钮 `.btn--accent` 只属于播放条的「开始演奏」。页面内不得再出现与播放条同权重的开始/停止按钮。
2. **状态只说一次**：同一状态（如管理员权限、输入通道、未保存）在一个持久界面里只出现一次；详细解释放进「设置与校准」，其他地方用紧凑徽标 + `title`/`aria-label` 提示。
3. **强调色预算**：琥珀色只用于主操作、当前选中、正在播放/录制。次要按钮、图标、标签一律用中性色。青蓝色只用于「系统信号」（输入通道、焦点、链接型诊断），禁止用于装饰。
4. **禁止卡片套卡片**：一个页面区块最多一层 `.card`。分组用分隔线、间距和 `.section-label`，不要用嵌套容器。
5. **所有颜色/尺寸走令牌**：`var(--...)`。任何 `#hex`、`rgba(...)`、`px` 字号直接写进组件样式都视为缺陷（透明度叠层、1px 描边、SVG 内部坐标除外）。
6. **键盘可达**：所有交互元素可 Tab 到、有可见 `:focus-visible` 环、图标按钮有 `aria-label`；弹窗内 Esc 关闭且焦点不逃逸。
7. **不删功能**：重构只改变呈现与结构，不改变 IPC 调用、状态机、快捷键语义。任何行为变化必须单独说明。
8. **中文文案规范**：界面用中文；动词开头、不用书名号堆叠、数字与单位间不加空格（`127.9 BPM` 例外：数字与拉丁单位之间保留一个空格）。同类概念只有一个叫法（演奏 / 试听 / 导入 / 方案库 / 简谱）。
9. **不装饰**：没有页面眉标、卡片标题图标、统计条、品牌 slogan、侧栏版本行、"仅供娱乐" 这类装饰信息；一个数据只在它真正被使用的地方出现一次，其余用 `title` / tooltip / 设置页承接。新增任何常驻元素前先问：删掉它，用户会做错什么？答不上来就不加。

## 结构约定

```
src/renderer/src/styles/
├── tokens.css        # 令牌：色彩 / 字号 / 间距 / 圆角 / 阴影 / 动效 / 层级
├── base.css          # reset、排版默认值、焦点环、滚动条、选区、动效降级
├── layout.css        # 应用外壳：侧栏 / 顶栏 / 页面框架 / 播放条 / 启动页
├── components.css    # 基元：按钮、输入、开关、标签、面板、空态、弹窗、Toast…
└── global.css        # 只做 @import 汇总 + 极少量全局定义（唯一入口）
```

页面/功能级样式放在各自的 CSS 文件里（`styles/page-*.css`、`overlay/overlay.css`、`components/score/ScoreView.css`），只允许定义**本页专属**的结构类（如 `.editor-layout`），不得重新定义基元外观。基元外观改动只在 `components.css` 改一次。

## 常用命令

```powershell
npm run typecheck          # 类型检查（重构后必跑）
npm test                   # 核心算法回归（不得因 UI 改动失败）
npm run build              # electron-vite 构建，截图前置
node scripts/screenshot.cjs play artifacts/ui-refactor/play.png   # 单页截图（需先 build）
```

截图会以 2169×1355 的真实窗口渲染，是判断留白、对齐、对比度的唯一可靠依据；改完必须看图，不要只凭 CSS 想象。验证最小窗口时用 `DFH_WINDOW_WIDTH=1024`、`DFH_WINDOW_HEIGHT=720`（图标轨侧栏），再补一轮 `DFH_WINDOW_WIDTH=1120`、`DFH_WINDOW_HEIGHT=720`。

## 参考文件

| 文件 | 内容 |
|---|---|
| `references/tokens.md` | 全部设计令牌与取值、语义映射、无障碍对比度要求 |
| `references/components.md` | 组件类名契约、标记示例、变体与禁用/加载态 |
| `references/ux-patterns.md` | 布局骨架、状态呈现、反馈、空态、表单、快捷键、文案 |
| `references/design-language.md` | 设计目标、动效、图标、分级与留白原则、常见反例 |
| `references/review-checklist.md` | 验收清单 + 截图回归流程 |
