# 验收清单与截图流程

## 代码层（不通过即返工）

- [ ] 没有裸写的颜色/圆角/字号/间距（`#hex`、`rgba()`、`13px`、`padding: 18px`）；透明度叠层与 SVG 内部坐标除外。
- [ ] 使用的类名都来自 `components.css` / `layout.css` / 本页 CSS；没有为单个元素发明一次性样式类。
- [ ] 没有 `<label>` 嵌套 `<label>`；图标按钮都有 `aria-label`。
- [ ] 页面内没有 `.btn--accent`（该样式只属于播放条），页面主操作使用 `.btn--primary`。
- [ ] 没有页面眉标、卡片标题图标、统计条、slogan、版本行等装饰；同一数据不在两处出现。
- [ ] `npm run typecheck` 通过；`npm test` 通过；`npm run build` 通过。
- [ ] 没有删除或改变 IPC 调用、状态机、快捷键语义（行为变化必须单独说明）。

## 视觉层（看截图判断）

- [ ] 页面头部：标题 26px、说明不超过一行、操作区右对齐且不同时出现两个同等权重的按钮。
- [ ] 卡片层级：一层卡片、无描边、无装饰图标；分组用 `.section-label` / 间距；没有"卡片套卡片"。
- [ ] 强调色面积 ≤ 视口 5%；除主按钮外没有大片琥珀。
- [ ] 正文对比度 ≥ 4.5:1；`--text-4` 没有承载关键信息。
- [ ] 所有控件高度一致（同一行内 34px 或 28px），没有参差的按钮/输入框。
- [ ] 长标题/长曲名截断并带 `title`，没有把工具栏撑成两行。
- [ ] 空态/加载/错误三态都有；空态有一个明确的下一步按钮。
- [ ] 同一状态信息在整屏只出现一次；没有为「看起来丰富」而保留的数字与标签。
- [ ] 1440 宽与 1120 宽下首屏都没有被裁切的常驻信息（统计行/页脚/工具条）。

## 交互层（手动或脚本验证）

- [ ] Tab 能走完所有可交互元素，焦点环可见，顺序与视觉一致。
- [ ] Esc 关闭弹窗，焦点回到触发按钮；Tab 不逃出弹窗。
- [ ] 主按钮在无曲谱/无音符时 disabled，并说明原因。
- [ ] 演奏中：侧栏 `LIVE` + 顶栏状态 + 播放条进度同时出现且一致。
- [ ] 断网/无设备等异常：错误信息说明"哪一步失败 + 怎么办"，不是原始异常字符串。
- [ ] 窗口宽度 1024 / 1120 / 1460 下都不出现横向滚动条和重叠；1024 起始为图标轨侧栏，720 高窗口使用紧凑纵向密度。

## 截图回归流程

```powershell
npm.cmd run build
node scripts/screenshot.cjs play     artifacts/ui-refactor/play.png
node scripts/screenshot.cjs editor   artifacts/ui-refactor/editor.png
node scripts/screenshot.cjs import   artifacts/ui-refactor/import.png
node scripts/screenshot.cjs library  artifacts/ui-refactor/library.png
node scripts/screenshot.cjs settings artifacts/ui-refactor/settings.png
node scripts/screenshot.cjs practice artifacts/ui-refactor/practice.png
# 下落式 / 全屏练习
$env:DFH_CLICK_SELECTOR='.practice-config .practice-note-style .segmented__item:nth-child(2)'; node scripts/screenshot.cjs practice artifacts/ui-refactor/practice-fall.png
$env:DFH_CLICK_SELECTOR='button[title^="全屏专注练习"]'; node scripts/screenshot.cjs practice artifacts/ui-refactor/practice-fullscreen.png
```

- 截图默认使用独立用户目录 `artifacts/screenshot-user-data`（首次会写入 `disclaimerAccepted`），不会改动正在运行的主实例或真实设置；需要干净环境时加 `$env:DFH_SCREENSHOT_RESET='1'`；要截首次启动的风险提示，再加 `$env:DFH_SCREENSHOT_KEEP_DISCLAIMER='1'`。
- 截图分辨率 2169×1355（DPR 1.5 的 1460×940 窗口），是判断留白、对齐、对比度的唯一可靠依据。
- 最小窗口（1024×720）另截一轮：确认侧栏切为图标轨、播放条只保留首要操作、单列表单控件不拉成整行长条；再截 1120×720 确认图标轨上方的完整侧栏布局。
- 每张截图都要**实际打开看**，对照上表逐项检查；只跑构建不算验证。
- 需要特定状态时可用环境变量：`DFH_CLICK_SELECTOR`（先点某个元素）、`DFH_EVAL_JS`（注入脚本）、`DFH_START_PAGE`。
- 悬浮窗截图：`$env:DFH_OVERLAY_SCREENSHOT='artifacts/ui-refactor/overlay.png'`，需在设置里先打开悬浮窗（或直接改设置文件）。
- 改完把 `docs/screenshots/` 下的对应截图一并更新。

## 复查顺序

1. 先用 60% 缩放看整体节奏（明暗、密度、焦点）。
2. 再 100% 看对齐与间距（同一行基线、卡片内边距、图标视觉重量）。
3. 最后看交互态（hover / focus / disabled / playing）——静态截图里没有的，用 `DFH_EVAL_JS` 注入状态再截。
