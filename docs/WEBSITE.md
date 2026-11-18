# 静态官网：构建与 GitHub Pages 部署

官网源码在 `site/`（纯 HTML / CSS / JS，无框架），由 `scripts/build-site.mjs` 零依赖构建到 `dist-site/`，
再由 [`.github/workflows/pages.yml`](../.github/workflows/pages.yml) 部署到 GitHub Pages。

- 线上地址：<https://wh131462.github.io/delta-harmonica-studio/>
- 构建产物 `dist-site/` 已 gitignore，不要手改，也不要提交。

## 目录一览

```text
site/                    # 官网源码（唯一需要编辑的地方）
  index.html             # 首页
  downloads.html         # 下载页
  styles/                # tokens.css / base.css / components.css / 页面级样式
  scripts/               # site.js / home.js / downloads.js
  assets/shots/          # 界面截图（webp），构建时原样复制
  assets/audio/          # 试听素材（wav / mp3）
  assets/og-cover.png    # 社交分享封面
  release.json           # 兜底数据：API 失败时供构建脚本参考（构建时会重新生成）
dist-site/               # 构建产物（gitignore，Pages 上传的就是它）

scripts/build-site.mjs   # 构建脚本（零依赖）
scripts/serve-site.mjs   # 本地预览服务器（零依赖）
.github/workflows/pages.yml  # 构建 → 上传 → 部署 Pages
```

> 站点部署在 `https://wh131462.github.io/delta-harmonica-studio/` **子路径**下，
> 所以页面里的资源引用必须用相对路径（`./assets/shots/ui-play.webp`、`./styles/home.css`、`./release.json`），
> 构建脚本不会重写 HTML 里的链接。

## 本地预览

```bash
# 1. 构建到 dist-site/
npm run site:build

# 2. 启动本地静态服务器，打开 http://127.0.0.1:4173/
npm run site:preview
```

两条命令都支持传参（`--help` 可查全部选项）：

```bash
node scripts/build-site.mjs --site site --out dist-site --repo wh131462/delta-harmonica-studio
node scripts/serve-site.mjs --dist dist-site --port 4173
```

预览服务器行为贴近线上：`/` → `index.html`，无扩展名路径先尝试 `<path>.html`（`/downloads` → `downloads.html`），
所有响应带 `Cache-Control: no-store`，并拒绝目录穿越。修改 `site/` 之后需要重新执行 `npm run site:build`。

## 截图与冒烟诊断（设计验收用，可选）

```bash
node scripts/build-site.mjs
node scripts/screenshot-site.cjs
# 只截某个区块、换端口或输出目录：
node scripts/screenshot-site.cjs --only home-workflow --port 4181 --out artifacts/site-review
```

`scripts/screenshot-site.cjs` 用本机 Chrome / Edge 的 headless 模式（CDP，无第三方依赖）加载 `dist-site/`，
在 1440×900、1120×720、390×844 三档视口截取首屏、三步流程、练习演示、页面巡览、下载页与页脚，
并写出 `artifacts/site-review/diagnostics.json`（横向溢出、缺图、h1 数量、控制台错误、当前导航高亮等）。
需要本机安装 Chrome 或 Edge；也可用 `CHROME_PATH` 指定浏览器可执行文件。该脚本只用于本地自查，不参与 Pages 构建。

## 构建做了什么

`node scripts/build-site.mjs` 会按顺序执行：

1. 校验 `site/index.html` 存在，否则报中文错误并退出码 1；
2. 清空并重建输出目录（默认 `dist-site/`）。删除前会校验路径，拒绝仓库根目录、`site/`、磁盘根目录等危险目标；
3. 递归复制 `site/**` 到输出目录（**跳过** `site/release.json`，由第 6 步重新生成）；
4. 复制仓库根目录的 `assets/icon.png` → `dist-site/assets/icon.png`（favicon / apple-touch-icon）；
5. 解析版本号与 Release 数据（来源见下一节）；
6. 生成 `dist-site/release.json`；
7. 把产物里所有 HTML 的 `{{SITE_VERSION}}` 占位符替换为版本号（没有占位符也不报错），并写入空文件 `dist-site/.nojekyll`；
8. 校验 `index.html`、`downloads.html`、`release.json`、`.nojekyll` 都存在，打印版本 / 数据来源 / 资产数量 / 输出目录摘要；任何未捕获异常都会打印中文错误并以退出码 1 结束。

## 版本数据从哪来

页面里的版本号**不在 HTML 里硬编码**，而是由 `site/scripts/site.js` 在运行时按下面的优先级获取：

1. **浏览器直接请求 GitHub API** `https://api.github.com/repos/<repo>/releases/latest`（6 秒超时）；
   成功后把 Release（tag、发布日期、安装包列表）写入 `sessionStorage`，缓存 15 分钟，避免匿名 API 限流。
   这是「不重新部署也能看到最新版本」的主路径。
2. 请求失败（断开网络、403/429 限流、仓库无 Release）时，回退到构建产物里的 `./release.json` 快照。
   该快照由 CI 构建时的 `scripts/build-site.mjs` 生成（构建环境带 `GITHUB_TOKEN`，不受浏览器限流影响）；
   只有快照的 `source` 为 `api` 或确实包含下载资产时才被视为有效 Release。
3. 两者都没有时，页面显示「尚未发布」，下载卡显示「首次发布后在此直接下载」并链接 GitHub Releases；
   **不会把 `package.json` 里的开发版本号冒充成最新版本**。

`dist-site/release.json` 的构建流程如下（`scripts/build-site.mjs` 优先向 GitHub API 取真实 Release）：

- `GITHUB_REF` 为 `refs/tags/<tag>` 时请求 `https://api.github.com/repos/<repo>/releases/tags/<tag>`；
- 否则（push / workflow_dispatch / 线上默认分支）请求 `/releases/latest`；
- 请求头带 `User-Agent: delta-harmonica-studio-site` 与 `Accept: application/vnd.github+json`；
  环境变量有 `GITHUB_TOKEN` 时附带 `Authorization: Bearer <token>`（避免匿名访问被限流）；
- 8 秒超时；**任何失败（无网络、403/429 限流、Release 不存在、超时）都只打印警告，构建继续**。

只保留两类资产：文件名匹配 `^delta-harmonica-.*\.(exe|dmg|zip|AppImage|deb)$` 的安装包，以及 `SHA256SUMS.txt`，
字段截断为 `name / size / browser_download_url / content_type`。

产出的 `dist-site/release.json` 结构：

```json
{
  "repo": "wh131462/delta-harmonica-studio",
  "version": "0.3.0",
  "tag": "v0.3.0",
  "publishedAt": "2026-11-18T00:00:00Z",
  "htmlUrl": "https://github.com/wh131462/delta-harmonica-studio/releases/tag/v0.3.0",
  "notesUrl": "https://github.com/wh131462/delta-harmonica-studio/releases/tag/v0.3.0",
  "source": "api",
  "assets": [
    {
      "name": "delta-harmonica-0.3.0-x64.exe",
      "size": 123456789,
      "browser_download_url": "https://github.com/.../releases/download/v0.3.0/delta-harmonica-0.3.0-x64.exe",
      "content_type": "application/x-msdownload"
    }
  ]
}
```

**构建快照的降级行为**（`source: "fallback"`）：

- 版本号取 `package.json` 的 `version`，`tag` 取 `v<version>`，仅作为构建元数据；
- 若仓库里提交的 `site/release.json` 版本与 `package.json` 一致，沿用其中的 `assets`、`publishedAt`、`htmlUrl`
  （相当于上一次发布留下的兜底数据）；版本不一致时只保留版本号，下载列表留空；
- 页面会忽略没有资产的 fallback 快照，显示「尚未发布」，避免把未发布版本当作最新版；
- 页面必须能处理 `assets: []`（显示「暂无下载 / 去 GitHub Releases 查看」之类的兜底文案）。

> 发版时请让 tag（如 `v0.3.0`）与 `package.json` 的 `version` 一致，这样版本号注入、release.json 与下载页展示才是同一个版本。

## 下载按钮行为

- **首页主下载按钮**在 Windows / Linux 上直接指向最新 Release 的安装包文件（`releases/download/...`，GitHub 返回附件，
  浏览器直接开始下载，不会进入 Release 页面）；macOS 因为有 arm64 / x64 两种架构，会跳到下载页让用户选择。
- **下载页平台卡片**直接列出每个安装包的下载直链（带 `download` 属性、显示文件名与体积），不再提供
  「前往 GitHub Releases」的兜底按钮；拿不到资产时显示禁用占位而不是跳转 GitHub。
- 只有「发布记录 / 查看全部发布」这类文字链接会打开 GitHub Release 页面，它们不承载下载动作。

## 第一次开启 GitHub Pages

Pages 由 `pages.yml` 负责，仓库管理员需要手动开启一次：

1. 把 `pages.yml` 合入 `master` / `main`；
2. 仓库 **Settings → Pages → Build and deployment → Source** 选择 **GitHub Actions**
   （不要选 “Deploy from a branch”，否则 `actions/configure-pages` 会失败）；
3. 在 **Actions → Pages → Run workflow** 手动跑一次，或推送任意 `site/**` 改动触发；
4. `build` 成功后会进入 `github-pages` Environment 部署，部署完成后 Actions 摘要与
   Settings → Pages 都会显示站点地址：<https://wh131462.github.io/delta-harmonica-studio/> 。

工作流已声明所需权限（`contents: read` / `pages: write` / `id-token: write`），不需要配置任何 Secret；
`GITHUB_TOKEN` 由 Actions 自动提供，仅用于读取 Release 数据。

## 发版后自动刷新下载页

两条路径都会让下载页更新：

- **运行时**：页面每次加载会向 GitHub API 取 `/releases/latest`（按 IP 限流，sessionStorage 缓存 15 分钟），
  发版后访客刷新页面即可看到新版本与安装包，无需等站点重新部署；
- **构建时**：`pages.yml` 监听 `release: published`，发布后重新构建并部署一次，
  用带 token 的 API 结果刷新 `dist-site/release.json` 快照，给匿名 API 被限流的访客兜底：
  1. `release.yml` 发布 GitHub Release（推 tag 或 workflow_dispatch）后触发 Pages 工作流；
  2. 构建脚本拿到 `GITHUB_REF=refs/tags/v0.3.0`，按该 tag 请求 `/releases/tags/v0.3.0`；
  3. 下载页的版本号与安装包列表自动更新，无需手动改 `site/release.json`。

注意：

- 只创建 tag、没有创建 Release 时不会触发，可手动 **Actions → Pages → Run workflow**；
- draft Release 不会触发 `published`，正式发布后才触发；
- Pre-release 不会被 `/releases/latest` 返回，发正式版后会自动刷新；
- 并发配置是 `group: pages` + `cancel-in-progress: false`：连续触发会排队，不会打断进行中的部署。

## 自定义域名的注意事项

1. **域名与 CNAME**：先在 Settings → Pages 配置 Custom domain 与 DNS；并把 `CNAME` 文件放到 `site/` 根目录
   （内容是域名，如 `dh.example.com`），构建会把它复制到 `dist-site/CNAME`，避免后续部署丢域名配置。
2. **绝对地址要改**：社交平台的抓取器要求绝对 URL，站点换上自定义域名后需要更新：
   - `og:url`、`og:image`、`twitter:image`、`canonical` 等 meta；
   - 如果页面里有 `sitemap.xml` / `robots.txt` 中的域名，也要同步。
3. **站内资源不用改**：`./styles/...`、`./assets/...`、`./release.json` 这类相对路径在自定义域名下依然有效；
4. `release.json` 里的下载链接是 GitHub 绝对地址，不受域名影响。

## 常见问题

| 现象 | 排查 |
| --- | --- |
| 线上图片 / 样式 404 | 是否先跑过 `npm run site:build`；`site/assets/shots` 等目录是否已提交；**路径大小写**（Pages 是 Linux，区分大小写，Windows 本地可能不敏感）；引用是否误写成以 `/` 开头的绝对路径（会丢掉 `/delta-harmonica-studio/` 子路径） |
| 本地正常、线上 404 | 多半是绝对路径或漏了 `./` 前缀；确认资源确实在 `dist-site/` 里且被复制（构建日志有文件数） |
| `release.json` 是 fallback / 下载列表为空 | GitHub API 返回 403/429（匿名限流）或目标 Release 不存在。本地重新构建看 `[site] 警告`；CI 里确认 `GITHUB_TOKEN` 已传入；用 `gh release list` / GitHub Releases 页面确认版本号 |
| 部署失败提示 Pages 未启用 | Settings → Pages → Source 选 **GitHub Actions**；确认 `deploy` 作业的 `github-pages` Environment 没被保护规则拦截 |
| `deploy-pages` 报权限/403 | 确认 `pages.yml` 的 `permissions` 含 `pages: write` 与 `id-token: write`；仓库 Actions 权限没有被组织策略限制 |
| 版本号显示成旧版本 | 检查 `package.json` 的 `version`、Release 的 tag、`site/release.json` 三者是否一致；发版提交里有没有 bump `package.json` |
| 构建失败退出码 1 | 看以 `[site] 构建失败：` 开头的日志；常见原因是 `site/index.html` 或 `site/downloads.html` 缺失、输出目录参数指向了危险路径 |
| 本地预览端口被占用 | `npm run site:preview -- --port 4174`（或 `node scripts/serve-site.mjs --port 4174`） |

## 维护者手动事项清单

- [ ] Settings → Pages → Source 选 **GitHub Actions**，并记录首次部署后的线上地址；
- [ ] 确定是否使用自定义域名：决定后更新 `og:url` / `og:image` / `canonical` 等绝对地址，并添加 `site/CNAME`；
- [ ] 发版流程保持 tag 与 `package.json` 版本号一致，Release 正式发布（非 draft）以触发下载页自动刷新。
