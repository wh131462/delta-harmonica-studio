# 平台支持与发布

本文说明 Windows / macOS / Linux 三端的能力边界、构建命令、签名与 CI 发布流程。安装与使用步骤见 [README](../README.md)。

## 1. 目标与边界

《三角洲行动》PC 端只有 Windows 客户端；游戏注入依赖 Win32 的 `SendInput`、UIPI 提权、`AttachThreadInput` 与前台窗口切换，这些在 macOS / Linux 上没有对等实现。因此三端共用同一套界面、核心算法与数据模型，但只有 Windows 版提供「向游戏发送按键」。

- **Windows**：完整功能，含游戏注入、输入通道自检、管理员提权。
- **macOS / Linux**：编辑、导入、方案库、练习、试听、宏导出与悬浮窗可用；输入方式固定为排练模式，界面明确说明游戏注入不可用。
- 不做「跨平台注入」：即使实现 `CGEvent` / `uinput`，游戏本体也不在这些平台上运行，属于无效复杂度。

平台能力集中定义在 [`src/shared/platform.ts`](../src/shared/platform.ts)，主进程通过 `getPlatformCapabilities()` 读取，渲染层通过 `AppInfo.capabilities` 读取，避免各页面各自判断 `process.platform`。

## 2. 能力矩阵

| 能力 | Windows | macOS | Linux |
|---|---|---|---|
| 简谱编辑 / 实时录入 | ✅ | ✅ | ✅ |
| MIDI / 音频导入与转谱 | ✅ | ✅ | ✅ |
| 方案库、收藏、导入导出 | ✅ | ✅ | ✅ |
| 跟谱练习（滚动 / 下落） | ✅ | ✅ | ✅ |
| 双音色采样试听 | ✅ | ✅ | ✅ |
| 宏导出（AHK v1/v2、G HUB Lua、CSV、触发表） | ✅ | ✅ | ✅ |
| 向游戏注入键鼠 | ✅ 需管理员 | — | — |
| 输入通道自检 | ✅ | — | — |
| 管理员提权（UAC） | ✅ | — | — |
| 全局快捷键 | ✅ | ✅ | ✅（Wayland 取决于桌面） |
| 悬浮控制窗 | ✅ | ✅ | ✅（透明/置顶依赖合成器） |
| 系统托盘 | ✅ | ✅（模板图标） | ✅（依赖桌面托盘实现） |

**为什么 macOS / Linux 的演奏仍可点「开始演奏」**：它走的是排练模式，只按时间轴推进并显示进度，不发送任何系统事件。这样练习、校验节奏与宏导出的体验与 Windows 一致。

## 3. 平台差异与实现

| 主题 | Windows | macOS | Linux |
|---|---|---|---|
| 原生输入桥 | koffi + `user32` / `winmm` | 不加载 koffi，桥降级为空实现 | 不加载 koffi，桥降级为空实现 |
| 菜单 | 隐藏菜单栏 | 保留 `appMenu` / `editMenu` / `viewMenu` / `windowMenu`，否则 Cmd+C/V/Q 失效 | 隐藏菜单栏 |
| 关闭窗口 | 有托盘时隐藏到托盘 | 有托盘时隐藏；无托盘时保留 Dock，`activate` 重开窗口 | 有托盘时隐藏；无托盘时退出 |
| 托盘图标 | 18px | 16px 模板图（跟随菜单栏明暗） | 22px |
| 悬浮窗 | `screen-saver` 置顶 | `type: 'panel'` + `screen-saver` 层级 + 跨桌面/全屏可见 | `screen-saver` 置顶；Wayland 下定位可能被忽略 |
| 默认输入方式 | 模拟按键注入 | 首次启动自动设为排练模式 | 首次启动自动设为排练模式 |
| 提权入口 | 显示「以管理员重启」 | 不显示 | 不显示 |

macOS / Linux 启动时会自动把 `input.backend` 调整为 `dry-run` 并清除目标窗口句柄，避免把「没有 Win32 桥」误报成故障；用户仍可在设置页看到置灰的注入选项与原因。

## 4. 构建

```bash
npm ci
npm run typecheck
npm test
npm run build

npm run dist:win     # Windows：NSIS 安装包 + 便携版（x64）
npm run dist:mac     # macOS：dmg + zip（默认当前架构）
npm run dist:linux   # Linux：AppImage + deb（默认当前架构）
```

- 打包必须在目标系统上执行：dmg 依赖 macOS 工具链，AppImage / deb 依赖 Linux 工具链。
- 同时构建双架构：`npm run dist:mac -- --x64 --arm64`。`koffi` 是 N-API 预编译模块，配置里已关闭 `npmRebuild`，因此可以在同一台机器上产出 Intel 与 Apple Silicon 两套包；macOS 版不会加载 koffi，所以不存在架构不匹配的运行问题。
- Linux arm64：在 arm64 机器（或 `ubuntu-24.04-arm` runner）上执行 `npm run dist:linux -- --arm64`，同时把 `electron-builder.yml` 的 `linux.target` 保持在 AppImage / deb 即可。
- 产物命名：`delta-harmonica-<version>-mac-<arch>.dmg|zip`、`delta-harmonica-<version>-linux-<arch>.AppImage|deb`、Windows 见 `electron-builder.yml`。
- `resources/audio-samples` 是安装包的一部分；缺失时应用仍能启动，但试听没有真实采样。发布工作流会显式校验该目录。

### 图标

`assets/icon.png`（512×512）是 electron-builder 的 buildResources，同时用于 Linux 图标与 macOS `.icns`、Windows `.ico` 的自动转换。若替换为更高分辨率（1024×1024）可获得更清晰的 Retina / 高分屏图标。

## 5. macOS 签名与首次打开

本项目**不做代码签名与公证**，仓库不需要任何签名相关 Secret：

- Windows / Linux 产物未签名；macOS 产物未做开发者签名与公证。
- `scripts/after-pack.cjs` 会执行 `codesign --force --deep --sign -` 做 ad-hoc 签名，保证 Apple Silicon 上可以启动（ad-hoc 不是开发者签名，不会改变 Gatekeeper 的拦截行为）。
- 用户首次打开需要按以下任一方式放行（发布描述里的「🍎 macOS 首次打开放行」一节会原样给出这些步骤）：
  1. 右键应用 → 「打开」→ 再点「打开」；若提示「无法检查是否包含恶意软件」，到「系统设置 → 隐私与安全性」点「仍要打开」。
  2. 清除隔离属性：

     ```bash
     xattr -cr "/Applications/三角洲口琴工坊.app"
     ```

  3. 允许「任何来源」：

     ```bash
     sudo spctl --master-disable   # 打开
     sudo spctl --master-enable    # 恢复默认
     ```

     macOS 15（Sequoia）起系统移除了图形界面中的「任何来源」，该命令在 15 及之后版本也不再生效，请改用方式 1 或 2。

若以后要接入正式签名与公证，在发布工作流里重新引入 `CSC_LINK` / `CSC_KEY_PASSWORD` Secrets，并在 `electron-builder.yml` 的 `mac` 段配置 `notarize: true`，同时设置 `APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`。

## 6. Linux 运行说明

- **AppImage**：

  ```bash
  chmod +x delta-harmonica-<version>-linux-x64.AppImage
  ./delta-harmonica-<version>-linux-x64.AppImage
  ```

  Ubuntu 22.04+ 若提示缺少 FUSE：安装 `libfuse2`，或改用 `--appimage-extract-and-run`。

- **deb**：`sudo dpkg -i delta-harmonica-<version>-linux-x64.deb`，依赖缺失时执行 `sudo apt-get -f install`。
- **Wayland**：全局快捷键与悬浮窗可用，但窗口定位、透明背景与置顶由桌面合成器决定；若悬浮窗位置异常，可在设置页重置位置或改用 X11 会话。
- **托盘**：部分桌面（如未安装 AppIndicator 扩展的 GNOME）不显示托盘图标；此时关闭主窗口会直接退出应用，属于桌面环境限制。

## 7. CI 与发布

仓库内置三个 GitHub Actions 工作流：

### CI（`.github/workflows/ci.yml`）

- 矩阵：`windows-latest`、`macos-latest`、`ubuntu-latest`
- 步骤：`npm ci` → `npm run typecheck` → `npm test` → `npm run build` → `npm run dist:dir`
- 三端都执行未打包目录构建，提前暴露 electron-builder 的平台配置错误；失败时上传 `out/` 与 `release/` 便于排查。

### Release（`.github/workflows/release.yml`）

- 触发：推送 `v*` 标签；或在 Actions 里手动触发（可填版本号、可选只出包不发布）
- 矩阵与产线：

  | 名称 | Runner | 参数 | 产物 |
  |---|---|---|---|
  | windows-x64 | `windows-latest` | `--win --x64` | `*.exe`（NSIS + portable） |
  | macos-x64-and-arm64 | `macos-latest` | `--mac --x64 --arm64` | `*.dmg` / `*.zip`（两种架构） |
  | linux-x64 | `ubuntu-latest` | `--linux --x64` | `*.AppImage` / `*.deb` |

- `prepare` 作业先解析版本号（显式输入 → tag 名 → 提交信息规则 `feat: vX.Y.Z` → `package.json`）并用 `scripts/release-notes.mjs` 生成发布描述，三端构建统一采用该版本号。
- 每个构建任务先校验 `resources/audio-samples` 存在，再执行类型检查、单元测试与打包。
- 发布任务汇总所有产物，生成 `SHA256SUMS.txt`，通过 `softprops/action-gh-release` 创建 GitHub Release，描述即自动生成的「版本信息 + 特性/修复表格 + 下载清单 + 平台说明」。

发布新版本：

```bash
npm version patch          # 或 minor / major
git push --follow-tags
```

也可在 Actions → Release → Run workflow 手动指定版本号发布。完整触发方式、规则检索与本地预览见 [发布流程](RELEASE.md)。

### Auto Release（`.github/workflows/auto-release.yml`）

- 触发：向 `master` / `main` 推送提交。
- 只在本次推送的提交里检索版本标记（`feat: v1.2.3` / `chore(release): v1.2.3`）；命中且 tag 不存在时创建 tag，再 `workflow_dispatch` 触发 Release 工作流（`GITHUB_TOKEN` 推 tag 不会触发其它工作流，`workflow_dispatch` 是官方例外）。
- 关掉自动发版：仓库 Variables 设置 `AUTO_RELEASE=false`。

## 8. 验收清单

Windows（完整功能）：

- [ ] `npm run dist:win` 生成安装包与便携版，安装后以普通权限可启动。
- [ ] 管理员身份下「输入通道自检」能收到全部注入事件。
- [ ] 实机演奏、焦点保护、急停、悬浮窗、全局快捷键正常。

macOS（Intel 与 Apple Silicon）：

- [ ] `npm run dist:mac -- --x64` / `--arm64` 生成 dmg 与 zip，安装后能启动。
- [ ] 设置页显示「游戏注入不可用」，输入方式为排练模式，注入相关控件置灰。
- [ ] 编辑、导入、练习、试听、宏导出正常；「开始演奏」以排练模式走完时间轴。
- [ ] Cmd+C / Cmd+V / Cmd+Q、托盘模板图标、Dock 图标正常。
- [ ] 若未签名：右键「打开」可启动；ad-hoc 签名存在（`codesign -dv <app>`）。

Linux（X11 与 Wayland 各一次）：

- [ ] `npm run dist:linux` 生成 AppImage 与 deb；AppImage `chmod +x` 后可启动。
- [ ] 设置页显示「游戏注入不可用」，排练模式可用。
- [ ] 悬浮窗可显示/隐藏；Wayland 下若无法定位，记录为已知限制而不是缺陷。
- [ ] 全局快捷键注册成功（若被桌面占用，设置页给出原因）。

## 9. 故障排查

| 现象 | 原因 / 处理 |
|---|---|
| macOS 提示「已损坏，无法打开」 | 未签名/隔离属性：右键「打开」，或 `xattr -cr <app>`；确认 ad-hoc 签名存在 |
| macOS 菜单里没有复制/粘贴 | 不应发生：macOS 必须保留系统菜单（见 `src/main/menu.ts`） |
| Linux AppImage 无法启动 | 缺少 FUSE：安装 `libfuse2` 或加 `--appimage-extract-and-run` |
| Linux 悬浮窗透明背景变黑 | 桌面合成器不支持透明窗口；改用支持合成的桌面或 X11 |
| Linux 没有托盘图标 | 桌面未启用 AppIndicator；关闭窗口会退出应用 |
| 非 Windows 平台仍显示「权限受限」 | 旧版本界面缓存：确认 `AppInfo.capabilities.gameInjection === false`，并清理用户数据目录后重启 |
| CI 打包缺少音源 | `resources/audio-samples` 未提交；按 README 说明补齐采样或使用 LFS |

## 10. 开发提示

- 平台判断只写在 `src/shared/platform.ts` 与 `src/main/native/index.ts`；页面统一读 `AppInfo.capabilities`，不要直接判断 `navigator.platform`。
- 截图 / 自动化验收可用 `DFH_FORCE_PLATFORM=darwin|linux` 在 Windows 上预览降级界面（见 `scripts/screenshot.cjs` 与 `src/main/native/index.ts`）。该变量只影响能力判断，不改变真实平台。
- 新增平台相关能力时，同步更新 `src/shared/platform.ts`、`tests/platform-support.test.ts` 与本文能力矩阵。
