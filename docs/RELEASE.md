# 发布流程

发布由 `.github/workflows/release.yml` 负责，产物为 Windows / macOS / Linux 三平台安装包 + 一份自动生成的 GitHub Release。另有 `.github/workflows/auto-release.yml` 负责「提交即发版」的自动化。

## 触发方式

### 1. 推 tag（常规发版）

```bash
git tag v0.4.0
git push origin v0.4.0
```

版本号取自 tag 名，构建完成后自动创建 GitHub Release。

### 2. 手动触发（Actions → Release → Run workflow）

| 输入 | 说明 |
| --- | --- |
| `version` | 发布版本号，如 `0.4.0` 或 `v0.4.0`。留空则按下方「版本号解析」自动推导 |
| `ref` | 要构建的 tag / 分支 / commit，留空取当前分支最新提交 |
| `publish` | 是否创建 Release，默认 `true`；设为 `false` 只出包不发版（演练用） |
| `prerelease` | 是否标记为 Pre-release |

手动触发且 `publish=true` 时，如果目标 tag 还不存在，会按 `v<版本号>` 在该提交上创建 tag 并发布。适合「先验证产物，再补发版本」的场景。

### 3. 提交即发版（自动）

把带版本标记的提交合进 `master` / `main`，`auto-release.yml` 会：

1. 用 `--scan <before>..<after>` 只在**本次推送的提交**里检索版本标记，命中 `feat: v1.2.3` / `chore(release): v1.2.3` 才继续（普通提交直接跳过）；
2. 若 `v1.2.3` 这个 tag 已存在则跳过，不会重复发版；
3. 在推送的提交上创建 tag 并 `workflow_dispatch` 触发 `release.yml`（推 tag 用的 `GITHUB_TOKEN` 不会触发其它工作流，而 `workflow_dispatch` 是官方允许的例外）；
4. `release.yml` 按常规流程构建三平台产物并发布。

等价于「写完版本标记提交、merge 进主干就自动发版」，不需要再手工打 tag。

- 想临时关掉：仓库 Settings → Variables 增加 `AUTO_RELEASE=false`。
- 若希望发版由专门的身份发起（避免作者显示为 github-actions[bot]），配置 `RELEASE_DISPATCH_TOKEN`（PAT）Secret，工作流会自动优先使用它。

> 三条路径共用同一套构建与描述生成逻辑，产物文件名里的版本号与 Release 标题、描述中的版本号始终一致（由 `prepare` 作业统一下发）。

## 版本号解析顺序

`scripts/release-notes.mjs` 按以下顺序确定版本号，先命中者生效：

1. `workflow_dispatch` 的 `version` 输入
2. 触发 ref 的 tag 名（`refs/tags/v1.2.3`）
3. **提交信息规则检索**：从新到旧扫描最近 200 个提交标题，命中即取（详见下节）
4. `package.json` 的 `version`

tag 推送时会额外校验「tag 名 == `v` + 解析出的版本号」，不一致直接失败，避免把 0.3.0 的包挂在 v0.4.0 下。

## 规则检索

默认规则写在 `scripts/release-notes.mjs` 的 `DEFAULT_RULES` 中，分三组：

**版本号检索**（提交标题匹配到捕获组 1 即为本次版本）

| 规则 | 示例提交 |
| --- | --- |
| `chore(release): vX.Y.Z` | `chore(release): v0.4.0` |
| `feat: vX.Y.Z` / `feat(scope): vX.Y.Z` | `feat: v0.4.0` |
| `release: vX.Y.Z` | `release: v0.4.0` |
| `feat(vX.Y.Z): ...` | `feat(v0.4.0): 新增练习评分` |

**提交类型 → 段落归类**（Conventional Commits）

| 前缀 | 段落 | 表格类型列 |
| --- | --- | --- |
| `feat` | 新增特性 | — |
| `fix` | 问题修复 | — |
| `perf` | 其他变更 | 性能优化 |
| `refactor` | 其他变更 | 重构 |
| `revert` | 其他变更 | 回滚 |
| `docs` | 其他变更 | 文档 |
| `test` | 其他变更 | 测试 |
| `build` / `ci` | 其他变更 | 构建与流水线 |
| `style` / `ui` | 其他变更 | 样式与界面 |
| `chore` / `release` | 其他变更 | 杂项 |
| 其他 / 无前缀 | 其他变更 | 其他 |

**模块标签**：把提交 scope 映射成中文模块名（`feat(renderer)` → 渲染层），未命中则原样展示；`feat(v0.2)` 这类用版本号当 scope 的提交按「全局」处理。

需要临时改规则时，用 `--rules` 传入 JSON 做局部覆盖（只写想改的字段）：

```json
{
  "versionPatterns": ["^chore\\(release\\):\\s*v?(\\d+\\.\\d+\\.\\d+)"],
  "scopeLabels": { "newscope": "新模块" }
}
```

```bash
node scripts/release-notes.mjs --rules ./my-rules.json --out notes.md
```

## 发布描述的内容

描述完全由脚本生成，`generate_release_notes` 已关闭以免与表格重复：

1. **📌 版本信息**：版本号、发布日期、上一个版本、变更区间与提交数、特性/修复/其他数量，以及指向 `compare` 的「完整差异」链接
2. **💥 不兼容变更**：仅在出现 `feat(scope)!:` / `fix(scope)!:` 这类破坏性提交时出现
3. **✨ 新增特性**：`| 模块 | 说明 | 提交 |` 表格，提交为可点击的 commit 链接
4. **🐛 问题修复**：同上
5. **🔧 其他变更**：折叠区里的同类表格，含变更类型列
6. **📦 下载**：`| 平台 | 架构 | 文件 | 安装 / 使用 |` 表格，列出本次版本的 `.exe` / `.dmg` / `.zip` / `.AppImage` / `.deb` 与 `SHA256SUMS.txt`
7. **🖥 平台支持说明**：注入能力差异与各平台限制
8. **🍎 macOS 首次打开放行**：因为不做签名与公证，这里给出三种放行方式——右键「打开」、「系统设置 → 隐私与安全性 → 仍要打开」、`xattr -cr <app>` 清除隔离属性、以及 `sudo spctl --master-disable` 打开「任何来源」（并注明 macOS 15 起该开关已移除）

变更区间为「上一个 `v*` tag .. 当前 ref」；首次发布（没有上一个 tag）时取最近 500 个提交。

## 签名策略

本项目**不做代码签名、不做公证**：

- Windows / Linux 产物未签名，安装时可能有 SmartScreen / 发行版提示。
- macOS 未做开发者签名与公证，仅对 Apple Silicon 产物做 ad-hoc 签名（`scripts/after-pack.cjs`），否则系统会直接判定为「已损坏」。首次打开需要用户按描述里的「macOS 首次打开放行」操作。
- 仓库不需要配置任何签名相关 Secret；后续若要接入证书，重新引入 `CSC_LINK` / `CSC_KEY_PASSWORD` 并在 `electron-builder.yml` 里配置 `mac.notarize` 即可。

## 本地预览

```bash
# 预览下一个版本的描述（不推任何东西）
npm run release:notes -- --version 0.4.0 --out release-notes.md

# 指定区间重新生成历史说明
npm run release:notes -- --from v0.3.0 --to v0.4.0 --out release-notes.md
```

`node scripts/release-notes.mjs --help` 可查全部参数。
