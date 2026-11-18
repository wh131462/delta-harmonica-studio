#!/usr/bin/env node
/**
 * 生成 GitHub Release 描述（Markdown）。
 *
 * 用法：
 *   node scripts/release-notes.mjs [--version 0.4.0] [--from v0.3.0] [--to HEAD]
 *                                  [--scan origin/v0.3.0..HEAD] [--out release-notes.md]
 *                                  [--rules rules.json] [--repo https://github.com/owner/repo]
 *
 * 版本号解析顺序（--version 优先级最高）：
 *   1. --version 参数（CI 里对应 workflow_dispatch 的 version 输入）
 *   2. 触发 ref 的 tag 名（push tag 时是 refs/tags/v1.2.3）
 *   3. 提交信息规则检索：feat: v1.2.3 / chore(release): v1.2.3 / feat(v1.2.3): ...（取最新一条命中）
 *   4. package.json 的 version
 *
 * 解析结果会写入 GITHUB_OUTPUT：version / tag / previous / source / features / fixes。
 * source 取值 input | tag | commit | package，auto-release 工作流据此判断本次推送是否带版本标记。
 *
 * 变更区间取「上一个 tag → 当前 ref」，按 Conventional Commits 规则归类为
 * 新特性 / 问题修复 / 其他变更三张表，再附上版本信息、下载清单与平台支持说明。
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

const USAGE = `用法：node scripts/release-notes.mjs [选项]

  --version <x.y.z>   指定发布版本号（可带 v 前缀）；留空则按 tag / 提交规则 / package.json 推导
  --from <ref>        变更起点（默认自动取上一个 v* tag）
  --to <ref>          变更终点（默认 HEAD）
  --scan <ref..ref>   只在指定区间内做版本号规则检索（默认扫描 --to 最近 200 条提交）
  --out <file>        输出文件（默认 release-notes.md）
  --rules <file>      覆盖默认检索规则的 JSON（可选，示例见 docs/RELEASE.md）
  --repo <url>        仓库地址，用于生成提交链接（默认读 GITHUB_REPOSITORY / git remote）
`;

/** 默认检索规则，可被 --rules 指定的 JSON 局部覆盖。 */
const DEFAULT_RULES = {
  /** 版本号检索规则：按「从新到旧」扫描提交标题，第一条命中的即为本次版本。 */
  versionPatterns: [
    '^chore\\(release\\):\\s*v?(\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?)\\s*$',
    '^feat(?:\\([^)]*\\))?!?:\\s*v?(\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?)\\s*$',
    '^release:\\s*v?(\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?)\\s*$',
    '^feat\\(v?(\\d+\\.\\d+\\.\\d+)\\)',
  ],
  /** 提交类型规则：命中第一条即归类。 */
  typeRules: [
    { pattern: '^feat', label: '新特性', section: 'features' },
    { pattern: '^fix', label: '问题修复', section: 'fixes' },
    { pattern: '^perf', label: '性能优化', section: 'others' },
    { pattern: '^refactor', label: '重构', section: 'others' },
    { pattern: '^revert', label: '回滚', section: 'others' },
    { pattern: '^docs', label: '文档', section: 'others' },
    { pattern: '^test', label: '测试', section: 'others' },
    { pattern: '^(build|ci)', label: '构建与流水线', section: 'others' },
    { pattern: '^(style|ui)', label: '样式与界面', section: 'others' },
    { pattern: '^(chore|release)', label: '杂项', section: 'others' },
  ],
  /** 模块标签：给提交 scope 起个中文名，未命中的原样展示。 */
  scopeLabels: {
    app: '应用外壳',
    renderer: '渲染层',
    main: '主进程',
    preload: '预加载层',
    shared: '共享类型',
    core: '核心逻辑',
    platform: '平台适配',
    practice: '练习模式',
    'practice-ui': '练习界面',
    audio: '音频与采样',
    samples: '采样资源',
    score: '乐谱与简谱',
    recorder: '实时录入',
    components: '通用组件',
    macro: '宏导出',
    input: '键鼠注入',
    hotkey: '全局热键',
    midi: 'MIDI 解析',
    assets: '品牌资源',
    scripts: '构建脚本',
    packaging: '打包配置',
    workflows: '流水线',
    ci: '流水线',
    docs: '文档',
    readme: '说明文档',
    screenshots: '界面截图',
    'ui-design': '设计系统',
    'ui-design-skill': '设计系统',
    styles: '样式令牌',
    tests: '测试',
    test: '测试',
    e2e: '端到端测试',
  },
};

const FIELD_SEP = '\u001f';
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
const PLATFORM_DOC = 'docs/PLATFORM_SUPPORT.md';

function parseArgs(argv) {
  const opts = { version: '', from: '', to: 'HEAD', scan: '', out: 'release-notes.md', rules: '', repo: '' };
  const alias = {
    '--version': 'version',
    '-v': 'version',
    '--from': 'from',
    '--to': 'to',
    '--scan': 'scan',
    '--out': 'out',
    '-o': 'out',
    '--rules': 'rules',
    '--repo': 'repo',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--help' || key === '-h') {
      process.stdout.write(USAGE);
      process.exit(0);
    }
    const field = alias[key];
    if (!field) throw new Error(`未知参数：${key}\n\n${USAGE}`);
    opts[field] = argv[i + 1] ?? '';
    i += 1;
  }
  return opts;
}

function git(args, { allowFailure = false } = {}) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (error) {
    if (allowFailure) return '';
    const detail = (error.stderr || '').toString().trim() || error.message;
    throw new Error(`git ${args.join(' ')} 执行失败：${detail}`);
  }
}

function normalizeVersion(raw) {
  return String(raw).trim().replace(/^v/i, '');
}

function isSemver(version) {
  return SEMVER.test(version);
}

function compareVersions(a, b) {
  const [, aMajor, aMinor, aPatch] = SEMVER.exec(a) ?? [];
  const [, bMajor, bMinor, bPatch] = SEMVER.exec(b) ?? [];
  const left = [Number(aMajor), Number(aMinor), Number(aPatch)];
  const right = [Number(bMajor), Number(bMinor), Number(bPatch)];
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  }
  return 0;
}

function loadRules(file) {
  if (!file) return DEFAULT_RULES;
  const raw = JSON.parse(readFileSync(resolvePath(file), 'utf8'));
  return {
    versionPatterns: raw.versionPatterns ?? DEFAULT_RULES.versionPatterns,
    typeRules: raw.typeRules ?? DEFAULT_RULES.typeRules,
    scopeLabels: { ...DEFAULT_RULES.scopeLabels, ...(raw.scopeLabels ?? {}) },
  };
}

/** 当前 ref 可达的 tag 列表（版本号从大到小）。 */
function listReachableTags(ref) {
  const tags = git(['tag', '--list', 'v*', '--sort=-v:refname'], { allowFailure: true })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return tags.filter((tag) => isSemver(normalizeVersion(tag)) && isAncestor(tag, ref));
}

function isAncestor(ancestor, descendant) {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

function resolveVersion(opts, rules) {
  if (opts.version) {
    const version = normalizeVersion(opts.version);
    if (!isSemver(version)) throw new Error(`--version 不是合法的语义化版本号：${opts.version}`);
    return { version, source: 'input', detail: '--version 参数' };
  }

  const ref = process.env.GITHUB_REF ?? '';
  if (ref.startsWith('refs/tags/')) {
    const tagVersion = normalizeVersion(ref.slice('refs/tags/'.length));
    if (isSemver(tagVersion)) return { version: tagVersion, source: 'tag', detail: `tag v${tagVersion}` };
  }

  const patterns = rules.versionPatterns.map((pattern) => new RegExp(pattern));
  // --scan 用于只在「本次推送的提交」里找版本标记（auto-release 工作流），避免误用历史提交
  const scanArgs = opts.scan
    ? opts.scan.includes('..')
      ? [opts.scan]
      : ['-n', '200', opts.scan]
    : ['-n', '200', opts.to];
  const subjects = git(['log', '--no-merges', '--format=%s', ...scanArgs], { allowFailure: true })
    .split('\n')
    .filter(Boolean);
  for (const subject of subjects) {
    for (const pattern of patterns) {
      const matched = pattern.exec(subject);
      if (matched?.[1]) {
        const version = normalizeVersion(matched[1]);
        if (isSemver(version)) return { version, source: 'commit', detail: `提交信息「${subject}」` };
      }
    }
  }

  const pkgPath = resolvePath('package.json');
  if (existsSync(pkgPath)) {
    const version = normalizeVersion(JSON.parse(readFileSync(pkgPath, 'utf8')).version ?? '');
    if (isSemver(version)) return { version, source: 'package', detail: 'package.json' };
  }

  throw new Error('无法确定发布版本号：请通过 --version 指定，或提交一条 feat: vX.Y.Z 形式的提交信息。');
}

function resolveRange(opts, version) {
  const to = opts.to;
  const currentTag = `v${version}`;
  if (opts.from) return { from: opts.from, to, currentTag };

  const candidate = listReachableTags(to)
    .filter((tag) => tag !== currentTag)
    .filter((tag) => compareVersions(normalizeVersion(tag), version) < 0)
    .at(0);
  return { from: candidate ?? '', to, currentTag };
}

function resolveRepo(opts) {
  if (opts.repo) return opts.repo.replace(/\.git$/, '');
  if (process.env.GITHUB_REPOSITORY) return `https://github.com/${process.env.GITHUB_REPOSITORY}`;
  const remote = git(['config', '--get', 'remote.origin.url'], { allowFailure: true });
  if (!remote) return '';
  const ssh = /^git@([^:]+):(.+?)(?:\.git)?$/.exec(remote);
  if (ssh) return `https://${ssh[1]}/${ssh[2]}`;
  return remote.replace(/\.git$/, '');
}

function parseCommits(range, rules) {
  const args = ['log', '--no-merges', `--format=%H${FIELD_SEP}%h${FIELD_SEP}%cs${FIELD_SEP}%s`];
  if (range.from) args.push(`${range.from}..${range.to}`);
  else args.push('-n', '500', range.to);
  const raw = git(args, { allowFailure: true });
  if (!raw) return [];

  const typeRules = rules.typeRules.map((rule) => ({ ...rule, regex: new RegExp(rule.pattern) }));
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [hash, short, date, subject = ''] = line.split(FIELD_SEP);
      const conventional = /^([a-zA-Z]+)(?:\(([^)]*)\))?(!)?:\s*(.*)$/.exec(subject);
      const scope = conventional?.[2]?.trim() ?? '';
      // feat(v0.2): ... 这类用版本号当 scope 的提交，scope 等同于「全局」
      const scopeIsVersion = /^v?\d+\.\d+/.test(scope);
      const type = (conventional?.[1] ?? '').toLowerCase();
      const rule = typeRules.find((item) => item.regex.test(type || subject));
      const description = conventional?.[4]?.trim() || subject;
      return {
        hash,
        short,
        date,
        subject,
        description,
        label: rule?.label ?? '其他',
        section: rule?.section ?? 'others',
        scope: scopeIsVersion ? '' : scope,
        breaking: Boolean(conventional?.[3]),
      };
    });
}

function escapeCell(text) {
  return String(text ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\s*\n\s*/g, ' ')
    .trim() || '—';
}

function scopeLabel(scope, rules) {
  if (!scope) return '全局';
  return rules.scopeLabels[scope.toLowerCase()] ?? scope;
}

function commitCell(commit, repo) {
  if (!repo) return `\`${commit.short}\``;
  return `[\`${commit.short}\`](${repo}/commit/${commit.hash})`;
}

function renderTable(commits, rules, repo, { withType = false } = {}) {
  if (commits.length === 0) return '（无）\n';
  const head = withType
    ? '| 类型 | 模块 | 说明 | 提交 |\n| :--- | :--- | :--- | :--- |\n'
    : '| 模块 | 说明 | 提交 |\n| :--- | :--- | :--- |\n';
  const rows = commits.map((commit) => {
    const cells = withType ? [commit.label, scopeLabel(commit.scope, rules)] : [scopeLabel(commit.scope, rules)];
    cells.push(commit.description, commitCell(commit, repo));
    return `| ${cells.map(escapeCell).join(' | ')} |`;
  });
  return head + rows.join('\n') + '\n';
}

function downloadRows(version) {
  const base = `delta-harmonica-${version}`;
  return [
    ['Windows 10 / 11', 'x64', `${base}-x64.exe`, 'NSIS 安装包（推荐）：可选安装目录，含开始菜单与桌面快捷方式'],
    ['Windows 10 / 11', 'x64', `${base}-portable.exe`, '免安装单文件，双击即用'],
    [
      'macOS 12+',
      'Intel (x64)',
      `${base}-mac-x64.dmg`,
      '拖入「应用程序」；首次打开请右键「打开」，或到「系统设置 → 隐私与安全性」放行',
    ],
    [
      'macOS 12+',
      'Apple Silicon (arm64)',
      `${base}-mac-arm64.dmg`,
      '拖入「应用程序」；首次打开请右键「打开」，或到「系统设置 → 隐私与安全性」放行',
    ],
    ['macOS 12+', 'x64 / arm64', `${base}-mac-{x64,arm64}.zip`, '免安装压缩包，解压后直接运行'],
    // Linux 的 ${arch} 由 electron-builder 映射成 AppImage 的 x86_64 与 deb 的 amd64
    ['Linux', 'x64', `${base}-linux-x86_64.AppImage`, '`chmod +x` 后直接运行'],
    ['Linux', 'x64', `${base}-linux-amd64.deb`, '`sudo apt install ./<文件>`'],
    ['通用', '—', 'SHA256SUMS.txt', '`sha256sum -c SHA256SUMS.txt` 校验全部产物'],
  ];
}

function render({ version, previous, range, commits, rules, repo, date }) {
  const features = commits.filter((commit) => commit.section === 'features');
  const fixes = commits.filter((commit) => commit.section === 'fixes');
  const others = commits.filter((commit) => commit.section === 'others');
  const rangeText = range.from
    ? `\`${range.from}..${range.to}\`（${commits.length} 个提交）`
    : `首次发布 · 最近 ${commits.length} 个提交`;
  const lines = [];

  lines.push('<!-- 由 scripts/release-notes.mjs 自动生成，请勿手工编辑 -->', '');
  lines.push('## 📌 版本信息', '');
  lines.push('| 项目 | 内容 |', '| :--- | :--- |');
  lines.push(`| 版本号 | \`v${version}\` |`);
  lines.push(`| 发布日期 | ${date} |`);
  lines.push(`| 上一个版本 | ${previous ? `\`${previous}\`` : '—（首次发布）'} |`);
  lines.push(`| 变更范围 | ${rangeText} |`);
  lines.push(`| 变更统计 | ✨ 新特性 ${features.length} · 🐛 修复 ${fixes.length} · 🔧 其他 ${others.length} |`);
  lines.push('');
  if (repo && range.from) {
    const compare = `${repo}/compare/${range.from}...${range.to === 'HEAD' ? `v${version}` : range.to}`;
    lines.push(`> 🔍 完整差异：[\`${range.from}...v${version}\`](${compare})`, '');
  }

  const breaking = commits.filter((commit) => commit.breaking);
  if (breaking.length > 0) {
    lines.push(`## 💥 不兼容变更（${breaking.length}）`, '');
    lines.push(renderTable(breaking, rules, repo, { withType: true }));
  }

  lines.push(`## ✨ 新增特性（${features.length}）`, '');
  lines.push(renderTable(features, rules, repo));
  lines.push(`## 🐛 问题修复（${fixes.length}）`, '');
  lines.push(renderTable(fixes, rules, repo));

  if (others.length > 0) {
    lines.push('<details>', `<summary>🔧 其他变更（${others.length}）</summary>`, '');
    lines.push(renderTable(others, rules, repo, { withType: true }));
    lines.push('</details>', '');
  }

  lines.push('## 📦 下载', '');
  lines.push('| 平台 | 架构 | 文件 | 安装 / 使用 |', '| :--- | :--- | :--- | :--- |');
  for (const [platform, arch, file, note] of downloadRows(version)) {
    lines.push(`| ${escapeCell(platform)} | ${escapeCell(arch)} | \`${escapeCell(file)}\` | ${escapeCell(note)} |`);
  }
  lines.push('');

  lines.push('## 🖥 平台支持说明', '');
  lines.push('- **Windows 10 / 11 x64**：完整功能，含向《三角洲行动》注入键鼠（需以管理员身份运行）。');
  lines.push(
    '- **macOS 12+（Intel / Apple Silicon）**：编辑、导入、练习、试听、宏导出可用；游戏注入不可用，演奏以排练模式运行。',
  );
  lines.push('- **Linux x64**：同上；Wayland 下悬浮窗的位置与置顶由桌面合成器决定。');
  lines.push('');

  lines.push('## 🍎 macOS 首次打开放行', '');
  lines.push(
    '本项目的 macOS 包**未使用开发者证书签名，也未做公证**（Apple Silicon 版本仅做了 ad-hoc 签名以保证能启动），因此首次打开会被 Gatekeeper 拦截。以下任一方式即可放行：',
  );
  lines.push('');
  lines.push('**方式一：右键打开（最省事）**');
  lines.push('');
  lines.push('1. 在「应用程序」里**右键**（或按住 Control 点击）三角洲口琴工坊 → 「打开」。');
  lines.push('2. 弹窗里再点一次「打开」。');
  lines.push('3. 若提示「无法打开，因为 Apple 无法检查其是否包含恶意软件」，到「系统设置 → 隐私与安全性」页面底部点「仍要打开」。');
  lines.push('');
  lines.push('**方式二：清除隔离属性（适合提示「已损坏，无法打开」）**');
  lines.push('');
  lines.push('```bash');
  lines.push('xattr -cr "/Applications/三角洲口琴工坊.app"');
  lines.push('```');
  lines.push('');
  lines.push('从 `.dmg` 直接运行未拖入「应用程序」时，把路径换成实际的 `.app` 位置即可。');
  lines.push('');
  lines.push('**方式三：允许「任何来源」的应用**');
  lines.push('');
  lines.push('```bash');
  lines.push('sudo spctl --master-disable   # 打开「任何来源」');
  lines.push('```');
  lines.push('');
  lines.push(
    '执行后到「系统设置 → 隐私与安全性 → 安全性」，「允许从以下位置下载的应用程序」会多出「任何来源」并自动选中；安装完成、确认应用能正常打开后，建议用 `sudo spctl --master-enable` 恢复默认设置。',
  );
  lines.push('');
  lines.push(
    '> macOS 15（Sequoia）起系统移除了图形界面里的「任何来源」选项，`spctl --master-disable` 在该版本上也不再生效；请改用方式一或方式二。',
  );
  lines.push('');

  lines.push('Linux 侧：AppImage 需要 `chmod +x` 后才能运行，部分发行版还需要 `libfuse2`；`.deb` 用 `sudo apt install ./<文件>` 安装。');
  lines.push('');
  lines.push(
    `详细构建与平台差异见 ${
      repo ? `[${PLATFORM_DOC}](${repo}/blob/HEAD/${PLATFORM_DOC})` : `\`${PLATFORM_DOC}\``
    }。`,
  );
  lines.push('');
  return lines.join('\n');
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const rules = loadRules(opts.rules);
  const { version, source, detail } = resolveVersion(opts, rules);
  const range = resolveRange(opts, version);
  const repo = resolveRepo(opts);
  const commits = parseCommits(range, rules);
  const date = git(['log', '-1', '--format=%cs', range.to], { allowFailure: true }) || new Date().toISOString().slice(0, 10);
  const body = render({ version, previous: range.from, range, commits, rules, repo, date });

  const outPath = resolvePath(opts.out);
  writeFileSync(outPath, body, 'utf8');

  const features = commits.filter((commit) => commit.section === 'features').length;
  const fixes = commits.filter((commit) => commit.section === 'fixes').length;
  console.log(`[release-notes] 版本 v${version}（来源：${detail}）`);
  console.log(`[release-notes] 区间 ${range.from || '（首次发布）'}..${range.to}，共 ${commits.length} 个提交`);
  console.log(`[release-notes] 新特性 ${features} · 修复 ${fixes} · 其他 ${commits.length - features - fixes}`);
  console.log(`[release-notes] 已写入 ${outPath}`);

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `version=${version}\ntag=v${version}\nprevious=${range.from}\nsource=${source}\nfeatures=${features}\nfixes=${fixes}\n`,
    );
  }
}

// 错误统一转成 GitHub Actions 注释 + 非零退出码，避免 CI 里只剩一坨堆栈
try {
  main();
} catch (error) {
  console.error(`::error title=生成发布说明失败::${error.message}`);
  process.exit(1);
}
