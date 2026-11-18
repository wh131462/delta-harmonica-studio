#!/usr/bin/env node
/**
 * 构建静态官网：把 site/ 复制为 dist-site/，注入版本号并生成 release.json。
 *
 * 用法：
 *   node scripts/build-site.mjs [--site site] [--out dist-site]
 *                              [--repo owner/name] [--package package.json]
 *
 * 环境变量：
 *   GITHUB_TOKEN       可选，访问 GitHub API 时带上以避免匿名限流
 *   GITHUB_REPOSITORY  仓库标识，默认 wh131462/delta-harmonica-studio
 *   GITHUB_REF         触发 ref；refs/tags/v0.3.0 时按该 tag 查询 Release
 *
 * 流程：
 *   1. 校验 site/index.html；
 *   2. 清空并重建输出目录（只允许专用产物目录，默认 dist-site/）；
 *   3. 递归复制 site/**（跳过 site/release.json，由本脚本重新生成）；
 *   4. 复制仓库根目录 assets/icon.png → <out>/assets/icon.png；
 *   5. 通过 GitHub API 解析版本与 Release 资产，失败只警告并降级；
 *   6. 写出 <out>/release.json；
 *   7. 把 HTML 里的 {{SITE_VERSION}} 替换为版本号，并写空文件 .nojekyll；
 *   8. 校验关键产物并打印摘要。
 *
 * 约束：零依赖（只用 Node 内置模块与全局 fetch），失败时退出码 1。
 */
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const DEFAULT_SITE_DIR = 'site';
const DEFAULT_OUT_DIR = 'dist-site';
const DEFAULT_PACKAGE_FILE = 'package.json';
const DEFAULT_REPO = 'wh131462/delta-harmonica-studio';
const RELEASE_FILE = 'release.json';
const SITE_VERSION_PLACEHOLDER = '{{SITE_VERSION}}';
const API_TIMEOUT_MS = 8000;
const API_USER_AGENT = 'delta-harmonica-studio-site';
/** Release 里只关心安装包与校验清单；其余字段（id、下载计数等）站点用不到。 */
const RELEASE_ASSET_PATTERN = /^delta-harmonica-.*\.(exe|dmg|zip|AppImage|deb)$/;
const CHECKSUM_ASSET_NAME = 'SHA256SUMS.txt';
/** 构建产物必须存在的关键文件（缺一个就失败，避免把坏站点发上线）。 */
const REQUIRED_OUTPUT_FILES = ['index.html', 'downloads.html', RELEASE_FILE, '.nojekyll'];
/** 站点契约里约定存在、但允许暂缺的目录；缺失时告警而不是中断。 */
const EXPECTED_SITE_DIRS = ['assets', 'assets/shots', 'assets/audio', 'styles', 'scripts'];

const USAGE = `用法：node scripts/build-site.mjs [选项]

  --site <dir>        站点源码目录（默认 site）
  --out <dir>         构建产物目录，构建前会被清空重建（默认 dist-site）
  --repo <owner/repo> GitHub 仓库（默认读 GITHUB_REPOSITORY，否则 ${DEFAULT_REPO}）
  --package <file>    读取版本号的 package.json（默认 package.json）

环境变量：
  GITHUB_TOKEN        可选，调用 GitHub API 的令牌（避免匿名限流）
  GITHUB_REPOSITORY   仓库标识，--repo 未指定时生效
  GITHUB_REF          触发 ref，refs/tags/<tag> 时按该 tag 查询 Release
`;

const log = (...parts) => console.log('[site]', ...parts);
const warn = (...parts) => console.warn('[site] 警告：', ...parts);

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 统一大小写后比较路径，避免 Windows 下 E:\\a 与 e:\\a 被当成两个目录。 */
function normalizeForCompare(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** child 是否等于 parent 或位于 parent 内部（两者都会先 path.resolve）。 */
function isSameOrInside(parent, child) {
  const parentResolved = path.resolve(parent);
  const childResolved = path.resolve(child);
  if (normalizeForCompare(parentResolved) === normalizeForCompare(childResolved)) return true;
  const relative = path.relative(parentResolved, childResolved);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function statOrNull(filePath) {
  try {
    return await stat(filePath);
  } catch {
    return null;
  }
}

function parseArgs(argv) {
  const options = {
    site: DEFAULT_SITE_DIR,
    out: DEFAULT_OUT_DIR,
    repo: '',
    package: DEFAULT_PACKAGE_FILE,
  };
  const names = {
    '--site': 'site',
    '--out': 'out',
    '--repo': 'repo',
    '--package': 'package',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(USAGE);
      process.exit(0);
    }
    const key = names[arg];
    if (!key) throw new Error(`未知参数：${arg}\n\n${USAGE}`);
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) throw new Error(`参数 ${arg} 缺少取值\n\n${USAGE}`);
    options[key] = value;
    i += 1;
  }
  return options;
}

function resolveRepo(cliRepo) {
  const repo = String(cliRepo || process.env.GITHUB_REPOSITORY || DEFAULT_REPO).trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new Error(
      `仓库标识「${repo}」不合法：需要 owner/name 形式（用 --repo 或环境变量 GITHUB_REPOSITORY 指定）`,
    );
  }
  return repo;
}

async function readPackageVersion(packagePath) {
  let raw;
  try {
    raw = await readFile(packagePath, 'utf8');
  } catch (error) {
    throw new Error(`读取 package.json 失败：${packagePath}\n${error.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`package.json 不是合法 JSON：${packagePath}\n${error.message}`);
  }
  const version = String(isRecord(parsed) ? parsed.version ?? '' : '')
    .trim()
    .replace(/^[vV](?=\d)/, '');
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`package.json 的 version 不是合法版本号：${version || '（空）'}（${packagePath}）`);
  }
  return version;
}

async function assertSiteDir(siteDir) {
  const indexFile = path.join(siteDir, 'index.html');
  const info = await statOrNull(indexFile);
  if (!info || !info.isFile()) {
    throw new Error(
      `站点入口不存在：${indexFile}\n请确认站点源码目录（--site，默认 site/）里包含 index.html。`,
    );
  }
}

/**
 * 删除前校验输出目录：绝不能是仓库根目录、仓库内源码目录、站点目录、磁盘根目录，
 * 也不能包住它们。注意 --site 可能指向仓库外的临时 fixture（本地测试），因此这里
 * 同时保护仓库自带的 site/ 目录，避免 --site 指到别处时把仓库站点源码误删。
 */
function assertSafeOutputDir({ outDir, siteDir, cwd }) {
  const reject = (reason) => {
    throw new Error(
      `拒绝清理输出目录「${outDir}」：${reason}。\n` +
        '请把 --out 指向专用构建产物目录（默认 dist-site/），构建脚本每次都会先清空该目录。',
    );
  };
  const repoRoot = path.resolve(cwd);
  const protectedDirs = [
    path.join(repoRoot, 'site'),
    path.join(repoRoot, 'assets'),
    path.join(repoRoot, 'src'),
    path.join(repoRoot, 'scripts'),
    path.join(repoRoot, 'docs'),
    path.join(repoRoot, 'resources'),
    path.join(repoRoot, 'tests'),
    path.join(repoRoot, '.github'),
    path.join(repoRoot, '.git'),
    path.join(repoRoot, 'node_modules'),
  ];
  if (isSameOrInside(outDir, repoRoot)) reject('它包含（或等于）仓库根目录');
  for (const protectedDir of protectedDirs) {
    const label = path.relative(repoRoot, protectedDir) || protectedDir;
    if (isSameOrInside(protectedDir, outDir)) {
      reject(`它指向仓库源码目录 ${label}（或其子目录）`);
    }
    if (isSameOrInside(outDir, protectedDir)) {
      reject(`它包含仓库源码目录 ${label}（或是其父目录）`);
    }
  }
  // --site 指向仓库外（如临时 fixture）时，同样保护传入的站点源码目录
  if (isSameOrInside(siteDir, outDir)) reject('它指向站点源码目录（或其子目录）');
  if (isSameOrInside(outDir, siteDir)) reject('它包含站点源码目录（或是其父目录）');
  if (normalizeForCompare(outDir) === normalizeForCompare(path.parse(outDir).root)) {
    reject('不能是磁盘根目录');
  }
}

/** 输出路径若已存在必须是目录；否则 rm -r 可能删掉一个普通文件。 */
async function assertOutputDirReplaceable(outDir) {
  const info = await statOrNull(outDir);
  if (info && !info.isDirectory()) {
    throw new Error(
      `输出路径已存在但不是目录：${outDir}\n脚本只会清空目录，请改用别的 --out 目录或在确认后手动删除该文件。`,
    );
  }
}

/** 对约定中应存在、但可能还没提交的站点目录给出提示，不中断构建。 */
async function warnMissingExpectedDirs(siteDir) {
  for (const relative of EXPECTED_SITE_DIRS) {
    const info = await statOrNull(path.join(siteDir, relative));
    if (!info || !info.isDirectory()) {
      warn(`站点目录 ${relative}/ 不存在，已跳过（若页面引用其中资源会 404；站点可能尚未完整）`);
    }
  }
}

/** 递归复制 site/**；跳过根目录的 release.json（构建时由 GitHub API / 兜底数据重新生成）。 */
async function copySiteTree(siteDir, outDir) {
  const stats = { files: 0, dirs: 0, skipped: [] };

  async function copyDirectory(sourceDir, targetDir, relativeBase) {
    await mkdir(targetDir, { recursive: true });
    let entries;
    try {
      entries = await readdir(sourceDir, { withFileTypes: true });
    } catch (error) {
      warn(`读取目录失败，已跳过：${sourceDir}（${error.message}）`);
      return;
    }
    for (const entry of entries) {
      const relative = relativeBase ? path.join(relativeBase, entry.name) : entry.name;
      if (relative === RELEASE_FILE) {
        stats.skipped.push(relative);
        continue;
      }
      const from = path.join(sourceDir, entry.name);
      const to = path.join(targetDir, entry.name);
      if (entry.isDirectory()) {
        stats.dirs += 1;
        await copyDirectory(from, to, relative);
      } else if (entry.isFile()) {
        await copyFile(from, to);
        stats.files += 1;
      } else {
        warn(`跳过不支持的文件类型（符号链接或特殊文件）：${relative}`);
      }
    }
  }

  await copyDirectory(siteDir, outDir, '');
  return stats;
}

/** 仓库根目录的 assets/icon.png 构建时复制到站点内，供 favicon / apple-touch-icon 使用。 */
async function copyRepoIcon(repoRoot, outDir) {
  const source = path.join(repoRoot, 'assets', 'icon.png');
  const target = path.join(outDir, 'assets', 'icon.png');
  const info = await statOrNull(source);
  if (!info || !info.isFile()) {
    warn('仓库根目录 assets/icon.png 不存在，站点图标（favicon / apple-touch-icon）会 404');
    return false;
  }
  try {
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(source, target);
    return true;
  } catch (error) {
    warn(`复制 assets/icon.png 失败，站点图标会 404：${error.message}`);
    return false;
  }
}

/** 从 GITHUB_REF 里取 tag 名；不是 refs/tags/* 时返回空串。 */
function parseTagFromRef(ref) {
  const raw = String(ref || '').trim();
  const prefix = 'refs/tags/';
  if (!raw.startsWith(prefix)) return '';
  return raw.slice(prefix.length);
}

/** 去掉可选的 v 前缀，并校验是否为语义化版本；不合法返回空串。 */
function normalizeVersion(value) {
  const version = String(value || '')
    .trim()
    .replace(/^[vV](?=\d)/, '');
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version) ? version : '';
}

function extractApiMessage(text) {
  try {
    const parsed = JSON.parse(text);
    if (isRecord(parsed) && typeof parsed.message === 'string') return parsed.message.slice(0, 200);
  } catch {
    // 响应可能不是 JSON，退回截断后的原始文本
  }
  return String(text || '')
    .replace(/\s+/g, ' ')
    .slice(0, 200);
}

/** 请求 GitHub API；8 秒超时，失败时抛出带中文说明的错误（由调用方降级）。 */
async function fetchGitHubJson(url, token) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    const headers = {
      'User-Agent': API_USER_AGENT,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch(url, { headers, signal: controller.signal });
    const text = await response.text();
    if (!response.ok) {
      const detail = extractApiMessage(text);
      throw new Error(`HTTP ${response.status}${detail ? `（${detail}）` : ''}`);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error('GitHub API 返回的内容不是合法 JSON');
    }
  } catch (error) {
    if (error && error.name === 'AbortError') {
      throw new Error(`请求超时（超过 ${API_TIMEOUT_MS / 1000} 秒）`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** 只保留安装包 + SHA256SUMS.txt，字段截断为站点需要的四项。 */
function selectReleaseAssets(assets) {
  if (!Array.isArray(assets)) return [];
  const selected = [];
  for (const asset of assets) {
    if (!isRecord(asset) || typeof asset.name !== 'string') continue;
    if (asset.name !== CHECKSUM_ASSET_NAME && !RELEASE_ASSET_PATTERN.test(asset.name)) continue;
    selected.push({
      name: asset.name,
      size: Number.isFinite(Number(asset.size)) ? Number(asset.size) : 0,
      browser_download_url:
        typeof asset.browser_download_url === 'string' ? asset.browser_download_url : '',
      content_type: typeof asset.content_type === 'string' ? asset.content_type : '',
    });
  }
  return selected;
}

/** 读取仓库里提交的 site/release.json（站点兜底数据），仅供 API 失败时参考。 */
async function readLocalReleaseData(fallbackFile) {
  let raw;
  try {
    raw = await readFile(fallbackFile, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    warn(`读取站点兜底数据失败，已忽略：${fallbackFile}（${error.message}）`);
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!isRecord(parsed)) {
      warn(`站点兜底数据不是 JSON 对象，已忽略：${fallbackFile}`);
      return null;
    }
    return parsed;
  } catch (error) {
    warn(`站点兜底数据不是合法 JSON，已忽略：${fallbackFile}（${error.message}）`);
    return null;
  }
}

/** API 失败时的降级数据：版本号取 package.json，资产只在兜底数据版本一致时沿用。 */
async function buildFallbackRelease({ repo, version, siteDir }) {
  const tag = `v${version}`;
  const local = await readLocalReleaseData(path.join(siteDir, RELEASE_FILE));
  const localVersion = local ? normalizeVersion(local.version) || normalizeVersion(local.tag) : '';
  const sameVersion = localVersion === version;
  const releasePageUrl = `https://github.com/${repo}/releases/tag/${encodeURIComponent(tag)}`;
  const localHtmlUrl = sameVersion && typeof local.htmlUrl === 'string' && local.htmlUrl.startsWith('http')
    ? local.htmlUrl
    : '';
  const htmlUrl = localHtmlUrl || releasePageUrl;
  if (local && !sameVersion) {
    log(
      `站点兜底数据的版本（${localVersion || '未知'}）与 package.json（${version}）不一致，` +
        '只使用版本号、下载列表留空',
    );
  }
  return {
    repo,
    version,
    tag,
    publishedAt: sameVersion && typeof local.publishedAt === 'string' ? local.publishedAt : null,
    htmlUrl,
    notesUrl: htmlUrl,
    source: 'fallback',
    assets: sameVersion ? selectReleaseAssets(local.assets) : [],
  };
}

/**
 * 解析 Release 数据：
 *   1. 优先 GitHub API（tag 构建查 /releases/tags/<tag>，否则查 /releases/latest）；
 *   2. 任何失败（无网络 / 403 限流 / 8 秒超时 / 无 Release）都只警告并降级，不中断构建。
 */
async function resolveRelease({ repo, token, ref, fallbackVersion, siteDir }) {
  const tagFromRef = parseTagFromRef(ref);
  const endpoint = tagFromRef
    ? `https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(tagFromRef)}`
    : `https://api.github.com/repos/${repo}/releases/latest`;
  try {
    log(`查询 Release 数据：${endpoint}`);
    const payload = await fetchGitHubJson(endpoint, token);
    if (!isRecord(payload)) throw new Error('GitHub API 返回的不是 Release 对象');
    const apiTag = String(payload.tag_name || '').trim();
    const tag = apiTag || tagFromRef || `v${fallbackVersion}`;
    const version = normalizeVersion(apiTag) || normalizeVersion(tagFromRef) || fallbackVersion;
    const releasePageUrl = `https://github.com/${repo}/releases/tag/${encodeURIComponent(tag)}`;
    const htmlUrl =
      typeof payload.html_url === 'string' && payload.html_url.startsWith('http')
        ? payload.html_url
        : releasePageUrl;
    return {
      repo,
      version,
      tag,
      publishedAt: typeof payload.published_at === 'string' ? payload.published_at : null,
      htmlUrl,
      notesUrl: htmlUrl,
      source: 'api',
      assets: selectReleaseAssets(payload.assets),
    };
  } catch (error) {
    warn(`GitHub API 获取 Release 失败，已降级为本地数据（构建继续）：${error.message}`);
    return buildFallbackRelease({ repo, version: fallbackVersion, siteDir });
  }
}

/** 递归遍历产物目录里的文件（用于注入版本号）。 */
async function forEachFile(dir, visitor) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    warn(`读取目录失败，已跳过：${dir}（${error.message}）`);
    return;
  }
  for (const entry of entries) {
    const filePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await forEachFile(filePath, visitor);
    } else if (entry.isFile()) {
      await visitor(filePath);
    }
  }
}

/** 把产物里所有 HTML 的 {{SITE_VERSION}} 替换为版本号；没有占位符不报错。 */
async function injectSiteVersion(outDir, version) {
  let files = 0;
  let occurrences = 0;
  await forEachFile(outDir, async (filePath) => {
    if (path.extname(filePath).toLowerCase() !== '.html') return;
    const html = await readFile(filePath, 'utf8');
    if (!html.includes(SITE_VERSION_PLACEHOLDER)) return;
    const count = html.split(SITE_VERSION_PLACEHOLDER).length - 1;
    await writeFile(filePath, html.split(SITE_VERSION_PLACEHOLDER).join(version), 'utf8');
    files += 1;
    occurrences += count;
  });
  if (files === 0) {
    log(`HTML 中未发现 ${SITE_VERSION_PLACEHOLDER} 占位符，跳过版本号注入`);
  } else {
    log(`已注入版本号 ${version}：${files} 个 HTML，共 ${occurrences} 处`);
  }
}

async function verifyOutput(outDir) {
  const missing = [];
  for (const relative of REQUIRED_OUTPUT_FILES) {
    const info = await statOrNull(path.join(outDir, relative));
    if (!info || !info.isFile()) missing.push(relative);
  }
  if (missing.length > 0) {
    throw new Error(
      `构建产物缺少关键文件：${missing.join('、')}\n` +
        `输出目录：${outDir}\n请检查 site/ 是否完整（至少需要 index.html 与 downloads.html）。`,
    );
  }
}

function printSummary({ release, outDir, iconCopied }) {
  log('');
  log('构建完成');
  log(`  站点版本：${release.version}（${release.source === 'api' ? 'GitHub API' : '本地降级数据'}）`);
  log(`  Release：${release.tag}，${release.assets.length} 个可下载资产`);
  log(`  输出目录：${outDir}`);
  log(`  关键文件：${REQUIRED_OUTPUT_FILES.join('、')} 均存在`);
  log(`  品牌图标：${iconCopied ? 'assets/icon.png 已复制' : '缺失（见上方警告）'}`);
  log('  本地预览：npm run site:preview');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const cwd = process.cwd();
  const siteDir = path.resolve(cwd, options.site);
  const outDir = path.resolve(cwd, options.out);
  const packagePath = path.resolve(cwd, options.package);
  const repo = resolveRepo(options.repo);

  log(`仓库：${repo}`);
  log(`站点源码：${siteDir}`);
  log(`输出目录：${outDir}`);

  // 1. 站点入口是硬性要求
  await assertSiteDir(siteDir);
  // 2. 删除前做路径安全校验，并读取版本号（降级数据要用）
  assertSafeOutputDir({ outDir, siteDir, cwd });
  await assertOutputDirReplaceable(outDir);
  const packageVersion = await readPackageVersion(packagePath);

  // 3. 清空并重建输出目录
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  log('已清空并重建输出目录');

  // 4. 复制站点源码（跳过 release.json）
  await warnMissingExpectedDirs(siteDir);
  const copyStats = await copySiteTree(siteDir, outDir);
  const skippedRelease = copyStats.skipped.includes(RELEASE_FILE);
  log(
    `已复制站点：${copyStats.files} 个文件、${copyStats.dirs} 个目录` +
      (skippedRelease ? `（跳过 ${RELEASE_FILE}，构建时重新生成）` : ''),
  );

  // 5. 品牌图标
  const iconCopied = await copyRepoIcon(cwd, outDir);

  // 6. 解析 Release 数据并写出 release.json
  const release = await resolveRelease({
    repo,
    token: process.env.GITHUB_TOKEN || '',
    ref: process.env.GITHUB_REF || '',
    fallbackVersion: packageVersion,
    siteDir,
  });
  await writeFile(path.join(outDir, RELEASE_FILE), `${JSON.stringify(release, null, 2)}\n`, 'utf8');
  log(
    `已生成 ${RELEASE_FILE}：版本 ${release.version}，来源 ${release.source}，资产 ${release.assets.length} 个`,
  );

  // 7. 注入版本号 + 写 .nojekyll
  await injectSiteVersion(outDir, release.version);
  await writeFile(path.join(outDir, '.nojekyll'), '');
  log('已写入 .nojekyll（跳过 GitHub Pages 的 Jekyll 处理）');

  // 8. 校验关键产物并打印摘要
  await verifyOutput(outDir);
  printSummary({ release, outDir, iconCopied });
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[site] 构建失败：${message}`);
  if (process.env.SITE_BUILD_DEBUG && error instanceof Error && error.stack) {
    console.error(error.stack);
  }
  process.exitCode = 1;
});
