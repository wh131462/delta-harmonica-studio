/* 三角洲口琴工坊 · 下载页脚本（无依赖）
 *
 * 职责：按 ./release.json 渲染三平台下载入口、自动识别并高亮当前平台、
 * 平台切换与安装步骤 tablist、无 Release 时的降级。
 * 共享能力（release 数据、分组、体积/日期格式化）全部通过 window.DHS 取用，
 * 本文件只操作下载页自己的 DOM。
 */
(() => {
  'use strict';

  const DHS = window.DHS;
  if (!DHS) return;

  const REPO_RELEASES = 'https://github.com/wh131462/delta-harmonica-studio/releases';
  const PLATFORMS = ['windows', 'macos', 'linux'];
  const PLATFORM_LABELS = { windows: 'Windows', macos: 'macOS', linux: 'Linux' };
  const KIND_LABELS = {
    installer: '安装包',
    portable: '便携版',
    dmg: '磁盘映像',
    zip: '压缩包',
    appimage: 'AppImage',
    deb: 'deb 安装包',
    file: '下载文件',
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  const state = {
    release: null,
    detected: normalizePlatform(DHS.detectPlatform()),
    active: 'windows',
    macArch: null,
  };

  function normalizePlatform(value) {
    return PLATFORMS.includes(value) ? value : 'unknown';
  }

  function platformName(platform) {
    return PLATFORM_LABELS[platform] || '当前系统';
  }

  function createText(tag, className, text) {
    const element = document.createElement(tag);
    element.className = className;
    element.textContent = text;
    return element;
  }

  /* ---------- 平台切换 ---------- */

  function updateHint() {
    const hint = $('[data-platform-hint]');
    if (!hint) return;
    if (state.detected === 'unknown') {
      hint.textContent = `正在查看 ${platformName(state.active)}；未识别你的系统，可手动切换`;
    } else if (state.active === state.detected) {
      hint.textContent = `已按 ${platformName(state.detected)} 高亮你的平台，可手动切换`;
    } else {
      hint.textContent = `正在查看 ${platformName(state.active)}（检测到 ${platformName(state.detected)}），可手动切换`;
    }
  }

  function updateBadges() {
    $$('[data-platform-badge]').forEach((badge) => {
      const card = badge.closest('[data-platform-card]');
      badge.hidden = !card || card.dataset.platformCard !== state.detected;
    });
  }

  function accentAllowed(platform, arch) {
    if (platform === 'windows' || platform === 'linux') return true;
    if (platform === 'macos') return Boolean(state.macArch) && arch === state.macArch;
    return false;
  }

  /* 只有当前强调平台的主下载按钮使用实心琥珀；其余主资产保持 btn--primary */
  function updateAccents() {
    $$('[data-download-primary]').forEach((link) => {
      const card = link.closest('[data-platform-card]');
      const platform = card ? card.dataset.platformCard : '';
      const accent = platform === state.active && accentAllowed(platform, link.dataset.arch || '');
      link.classList.toggle('btn--accent', accent);
      link.classList.toggle('btn--primary', !accent);
    });
  }

  function announcePlatform() {
    const status = $('[data-platform-status]');
    if (status) status.textContent = `已切换到 ${platformName(state.active)} 下载`;
  }

  function setPlatform(platform, options = {}) {
    if (!PLATFORMS.includes(platform)) return;
    state.active = platform;

    $$('[data-platform-switch]').forEach((button) => {
      button.setAttribute('aria-pressed', String(button.dataset.platformSwitch === platform));
    });
    $$('[data-platform-card]').forEach((card) => {
      card.classList.toggle('is-active', card.dataset.platformCard === platform);
    });
    updateHint();
    updateAccents();
    setTab(platform, options.focusTab === true);
    if (options.announce) announcePlatform();
  }

  /* ---------- 安装步骤 tablist ---------- */

  function setTab(platform, focus) {
    $$('[data-install-tab]').forEach((tab) => {
      const active = tab.dataset.installTab === platform;
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
      if (active && focus) tab.focus();
    });
    $$('[data-install-panel]').forEach((panel) => {
      panel.hidden = panel.dataset.installPanel !== platform;
    });
  }

  function initTabs() {
    const tabs = $$('[data-install-tab]');
    if (!tabs.length) return;

    tabs.forEach((tab, index) => {
      tab.addEventListener('click', () => {
        setPlatform(tab.dataset.installTab, { announce: true });
      });
      tab.addEventListener('keydown', (event) => {
        let next = null;
        if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
        else if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = tabs.length - 1;
        if (next === null) return;
        event.preventDefault();
        setPlatform(tabs[next].dataset.installTab, { focusTab: true, announce: true });
      });
    });
  }

  function initSwitches() {
    $$('[data-platform-switch]').forEach((button) => {
      button.addEventListener('click', () => {
        setPlatform(button.dataset.platformSwitch, { announce: true });
      });
    });
    $$('[data-jump-platform]').forEach((link) => {
      link.addEventListener('click', () => {
        setPlatform(link.dataset.jumpPlatform, { announce: true });
      });
    });
  }

  /* ---------- Release 资产渲染 ---------- */

  function kindLabel(kind) {
    return KIND_LABELS[kind] || KIND_LABELS.file;
  }

  function shortenFileName(name) {
    const file = String(name || '');
    const short = file.replace(/^delta-harmonica-[^-]+-/, '');
    return short || file;
  }

  function makeRow(item, options = {}) {
    return {
      asset: item.asset,
      label: options.label || kindLabel(item.kind),
      primary: Boolean(options.primary),
      arch: options.arch || '',
      group: options.group || '',
      note: options.note || '',
    };
  }

  function ensurePrimary(rows) {
    if (rows.length && !rows.some((row) => row.primary)) rows[0].primary = true;
    return rows;
  }

  function buildWindowsRows(items) {
    const installer = items.find((item) => item.kind === 'installer');
    const portable = items.find((item) => item.kind === 'portable');
    const rows = [];
    if (installer) {
      rows.push(
        makeRow(installer, {
          label: KIND_LABELS.installer,
          primary: true,
          note: '推荐 · 完整功能',
        }),
      );
    }
    if (portable) rows.push(makeRow(portable, { label: KIND_LABELS.portable }));
    items
      .filter((item) => item !== installer && item !== portable)
      .forEach((item) => rows.push(makeRow(item, { label: kindLabel(item.kind) })));
    return ensurePrimary(rows);
  }

  function buildMacosRows(items) {
    const rows = [];
    ['arm64', 'x64'].forEach((arch) => {
      const archItems = items.filter((item) => (item.arch || 'x64') === arch);
      if (!archItems.length) return;
      const group = arch === 'arm64' ? 'Apple Silicon · arm64' : 'Intel · x64';
      const dmg = archItems.find((item) => item.kind === 'dmg');
      const zip = archItems.find((item) => item.kind === 'zip');
      if (dmg) rows.push(makeRow(dmg, { label: KIND_LABELS.dmg, primary: true, arch, group }));
      if (zip) rows.push(makeRow(zip, { label: KIND_LABELS.zip, arch, group }));
      archItems
        .filter((item) => item !== dmg && item !== zip)
        .forEach((item) => rows.push(makeRow(item, { label: kindLabel(item.kind), arch, group })));
    });
    if (!rows.length) {
      items.forEach((item, index) => rows.push(makeRow(item, { primary: index === 0 })));
    }
    return ensurePrimary(rows);
  }

  function buildLinuxRows(items) {
    const appimage = items.find((item) => item.kind === 'appimage');
    const deb = items.find((item) => item.kind === 'deb');
    const rows = [];
    if (appimage) rows.push(makeRow(appimage, { label: KIND_LABELS.appimage, primary: true }));
    if (deb) rows.push(makeRow(deb, { label: KIND_LABELS.deb }));
    items
      .filter((item) => item !== appimage && item !== deb)
      .forEach((item) => rows.push(makeRow(item, { label: kindLabel(item.kind) })));
    return ensurePrimary(rows);
  }

  function createArrowIcon() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'dl-dl__arrow');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.7');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M12 4v10m0 0 4-4m-4 4-4-4M5 19h14');
    svg.append(path);
    return svg;
  }

  function createDownloadLink(row) {
    const asset = row.asset;
    const size = DHS.formatBytes(asset.size);
    const meta = size ? `${shortenFileName(asset.name)} · ${size}` : shortenFileName(asset.name);

    const link = document.createElement('a');
    link.className = row.primary
      ? 'btn btn--primary btn--block dl-dl'
      : 'btn btn--ghost btn--block dl-dl dl-dl--sub';
    link.href = asset.browser_download_url;
    link.setAttribute('download', '');
    link.setAttribute('rel', 'noreferrer');
    link.setAttribute('aria-label', `下载${row.label}：${asset.name}${size ? `，${size}` : ''}`);
    link.title = asset.name;
    if (row.primary) {
      link.dataset.downloadPrimary = '';
      if (row.arch) link.dataset.arch = row.arch;
    }

    const body = document.createElement('span');
    body.className = 'dl-dl__body';
    body.append(
      createText('span', 'dl-dl__label', row.label),
      createText('span', 'dl-dl__meta', meta),
    );
    link.append(body, createArrowIcon());
    return link;
  }

  function renderFallback(host, hasAssets) {
    host.replaceChildren();
    host.append(
      createText(
        'p',
        'dl-empty',
        hasAssets ? '这个平台暂时没有可下载的文件。' : '首次发布后在此直接下载。',
      ),
    );
    const link = document.createElement('a');
    link.className = 'btn btn--secondary btn--block';
    link.href = REPO_RELEASES;
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.textContent = '前往 GitHub Releases';
    host.append(link);
  }

  function renderPlatform(platform, rows, hasAssets) {
    const host = $(`[data-assets="${platform}"]`);
    if (!host) return;
    host.replaceChildren();
    if (!rows.length) {
      renderFallback(host, hasAssets);
      return;
    }

    let group = '';
    rows.forEach((row) => {
      if (row.group && row.group !== group) {
        group = row.group;
        host.append(createText('p', 'dl-group', row.group));
      }
      host.append(createDownloadLink(row));
      if (row.note) host.append(createText('p', 'dl-asset__note', row.note));
    });
  }

  function handleRelease(release) {
    state.release = release || null;
    const assets = release && Array.isArray(release.assets) ? release.assets : [];
    const groups = DHS.groupAssets(assets);
    const hasAssets = assets.length > 0;

    renderPlatform('windows', buildWindowsRows(groups.windows), hasAssets);
    renderPlatform('macos', buildMacosRows(groups.macos), hasAssets);
    renderPlatform('linux', buildLinuxRows(groups.linux), hasAssets);
    updateAccents();
  }

  /* ---------- macOS 架构（仅在浏览器主动提供时使用） ---------- */

  async function detectMacArch() {
    if (state.detected !== 'macos') return;
    const uaData = navigator.userAgentData;
    if (!uaData || typeof uaData.getHighEntropyValues !== 'function') return;
    try {
      const values = await uaData.getHighEntropyValues(['architecture']);
      if (values.architecture === 'arm') state.macArch = 'arm64';
      else if (values.architecture === 'x86') state.macArch = 'x64';
    } catch {
      /* 浏览器不支持或用户拒绝时保持未识别，两张架构入口都保留 */
    }
    if (state.macArch) updateAccents();
  }

  /* ---------- 启动 ---------- */

  function init() {
    state.active = state.detected === 'unknown' ? 'windows' : state.detected;
    updateHint();
    updateBadges();
    initSwitches();
    initTabs();
    setPlatform(state.active);
    DHS.onRelease(handleRelease);
    detectMacArch();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
