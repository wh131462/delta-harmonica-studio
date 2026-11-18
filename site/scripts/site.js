/* 三角洲口琴工坊 · 官网共享脚本（无依赖）
 *
 * 职责：页头滚动状态与进度、移动端菜单、滚动揭示、导航高亮、截图灯箱、
 * GitHub Star 数量、Release 数据（./release.json）与下载兜底。
 * 页面自己的行为放在 home.js / downloads.js，只通过 window.DHS 取用共享能力。
 */
(() => {
  'use strict';

  const REPO = 'wh131462/delta-harmonica-studio';
  const REPO_URL = `https://github.com/${REPO}`;
  const API_URL = `https://api.github.com/repos/${REPO}`;
  const LATEST_RELEASE_API = `${API_URL}/releases/latest`;
  const RELEASE_CACHE_KEY = 'dhs:release:v1';
  const RELEASE_CACHE_TTL = 15 * 60 * 1000;
  const RELEASE_API_TIMEOUT = 6000;
  const RELEASE_ASSET_PATTERN = /^delta-harmonica-.*\.(exe|dmg|zip|AppImage|deb)$/i;
  const CHECKSUM_ASSET_NAME = 'SHA256SUMS.txt';
  const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)');

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  /* ---------- 工具 ---------- */

  function formatBytes(bytes) {
    const value = Number(bytes);
    if (!Number.isFinite(value) || value <= 0) return '';
    const units = ['B', 'KB', 'MB', 'GB'];
    let size = value;
    let unit = 0;
    while (size >= 1024 && unit < units.length - 1) {
      size /= 1024;
      unit += 1;
    }
    const digits = size >= 100 || unit === 0 ? 0 : 1;
    return `${size.toFixed(digits)} ${units[unit]}`;
  }

  function formatDate(iso) {
    if (!iso) return '';
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    return new Intl.DateTimeFormat('zh-CN', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    }).format(date);
  }

  function detectPlatform() {
    const ua = navigator.userAgent || '';
    if (/Windows/i.test(ua)) return 'windows';
    if (/Macintosh|Mac OS X/i.test(ua)) return 'macos';
    if (/Linux|X11/i.test(ua)) return 'linux';
    return 'unknown';
  }

  function classifyAsset(name) {
    const file = String(name || '').toLowerCase();
    if (file.endsWith('.exe')) {
      return { platform: 'windows', kind: file.includes('portable') ? 'portable' : 'installer' };
    }
    if (file.endsWith('.dmg')) {
      return { platform: 'macos', kind: 'dmg', arch: file.includes('arm64') ? 'arm64' : 'x64' };
    }
    if (file.endsWith('.zip') && file.includes('mac')) {
      return { platform: 'macos', kind: 'zip', arch: file.includes('arm64') ? 'arm64' : 'x64' };
    }
    if (file.endsWith('.appimage')) return { platform: 'linux', kind: 'appimage' };
    if (file.endsWith('.deb')) return { platform: 'linux', kind: 'deb' };
    return { platform: 'other', kind: 'file' };
  }

  function groupAssets(assets) {
    const groups = { windows: [], macos: [], linux: [], checksums: [], other: [] };
    (Array.isArray(assets) ? assets : []).forEach((asset) => {
      if (!asset || !asset.name) return;
      if (/^sha256sums\.txt$/i.test(asset.name)) {
        groups.checksums.push(asset);
        return;
      }
      const meta = classifyAsset(asset.name);
      if (groups[meta.platform]) groups[meta.platform].push({ asset, ...meta });
      else groups.other.push({ asset, ...meta });
    });
    return groups;
  }

  /* ---------- 页头与滚动 ---------- */

  function initHeader() {
    const header = $('[data-header]');
    const progress = $('[data-scroll-progress]');
    if (!header && !progress) return;

    let ticking = false;
    const update = () => {
      ticking = false;
      const y = window.scrollY;
      if (header) header.classList.toggle('is-scrolled', y > 12);
      if (progress) {
        const doc = document.documentElement;
        const max = doc.scrollHeight - window.innerHeight;
        const ratio = max > 0 ? Math.min(1, Math.max(0, y / max)) : 0;
        progress.style.transform = `scaleX(${ratio.toFixed(4)})`;
      }
    };
    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      window.requestAnimationFrame(update);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
    update();
  }

  function initMobileNav() {
    const toggle = $('[data-menu-toggle]');
    const panel = $('[data-mobile-nav]');
    if (!toggle || !panel) return;

    const setOpen = (open) => {
      toggle.setAttribute('aria-expanded', String(open));
      toggle.setAttribute('aria-label', open ? '关闭菜单' : '打开菜单');
      panel.hidden = !open;
    };

    // 不主动抢焦点：面板在 DOM 中紧跟菜单按钮，键盘 Tab 会自然进入菜单
    toggle.addEventListener('click', () => setOpen(panel.hidden));
    panel.addEventListener('click', (event) => {
      if (event.target instanceof Element && event.target.closest('a')) setOpen(false);
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !panel.hidden) {
        setOpen(false);
        toggle.focus();
      }
    });
    const wide = window.matchMedia('(min-width: 961px)');
    const onChange = (event) => {
      if (event.matches) setOpen(false);
    };
    if (typeof wide.addEventListener === 'function') wide.addEventListener('change', onChange);
    else if (typeof wide.addListener === 'function') wide.addListener(onChange);
  }

  /* ---------- 滚动揭示 ---------- */

  function initReveal() {
    const items = $$('[data-reveal]');
    if (!items.length) return;

    if (REDUCED.matches || !('IntersectionObserver' in window)) {
      items.forEach((item) => item.classList.add('is-in'));
      return;
    }

    items.forEach((item) => {
      const delay = Number(item.getAttribute('data-reveal'));
      if (Number.isFinite(delay) && delay > 0) item.style.transitionDelay = `${delay}ms`;
    });

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add('is-in');
          observer.unobserve(entry.target);
        });
      },
      { rootMargin: '0px 0px -6% 0px', threshold: 0.12 },
    );
    items.forEach((item) => observer.observe(item));
  }

  /* ---------- 导航高亮 ---------- */

  function initScrollSpy() {
    const links = $$('.nav__link[href*="#"], .mobile-nav__link[href*="#"]');
    const sections = $$('main > section[id]');
    if (!links.length || !sections.length) return;

    const linkBySection = new Map();
    sections.forEach((section) => {
      const link = links.find(
        (item) => (item.getAttribute('href') || '').split('#')[1] === section.id,
      );
      linkBySection.set(section, link || null);
    });

    let ticking = false;
    const update = () => {
      ticking = false;
      const probe = window.innerHeight * 0.5;
      let activeLink = null;
      for (const section of sections) {
        const rect = section.getBoundingClientRect();
        if (rect.top <= probe && rect.bottom > probe) {
          activeLink = linkBySection.get(section) || null;
          break;
        }
      }
      links.forEach((item) => item.classList.toggle('is-active', item === activeLink));
    };
    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      window.requestAnimationFrame(update);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
    update();
  }

  function initCurrentPageNav() {
    const file = (window.location.pathname.split('/').pop() || 'index.html').toLowerCase();
    $$('.nav__link, .mobile-nav__link').forEach((link) => {
      const href = (link.getAttribute('href') || '').split('#')[0].split('/').pop().toLowerCase();
      if (href && href === file) link.classList.add('is-active');
    });
  }

  /* ---------- 截图灯箱 ---------- */

  function initDialogs() {
    const triggers = $$('[data-dialog-open]');
    const dialogs = $$('dialog[data-dialog]');
    if (!triggers.length || !dialogs.length) return;

    const groups = new Map();
    triggers.forEach((trigger) => {
      const group = trigger.getAttribute('data-shot-group');
      if (!group) return;
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group).push(trigger);
    });

    const openTrigger = (trigger) => {
      const id = trigger.getAttribute('data-dialog-open');
      const dialog = id ? document.getElementById(id) : null;
      if (!dialog) return;

      const img = $('[data-dialog-img]', dialog);
      const caption = $('[data-dialog-caption]', dialog);
      const counter = $('[data-dialog-count]', dialog);
      const group = trigger.getAttribute('data-shot-group');
      const list = group ? (groups.get(group) || [trigger]) : [trigger];
      let index = Math.max(0, list.indexOf(trigger));

      const render = () => {
        const current = list[index] || trigger;
        const src = current.getAttribute('data-shot-src');
        if (img && src) {
          img.src = src;
          img.alt = current.getAttribute('data-shot-alt') || '';
        }
        if (caption) {
          caption.textContent =
            current.getAttribute('data-shot-caption') ||
            current.getAttribute('data-shot-alt') ||
            '';
        }
        if (counter) counter.textContent = list.length > 1 ? `${index + 1} / ${list.length}` : '';
      };

      render();
      dialog._gallery = {
        step(delta) {
          if (list.length < 2) return;
          index = (index + delta + list.length) % list.length;
          render();
        },
      };
      dialog._returnFocus = trigger;
      document.body.classList.add('has-dialog');

      if (typeof dialog.showModal === 'function') {
        if (!dialog.open) dialog.showModal();
      } else {
        dialog.setAttribute('open', '');
      }
      // 让焦点落在对话框本身，避免打开瞬间就在关闭按钮上显示键盘焦点环
      if (typeof dialog.focus === 'function') dialog.focus();
    };

    triggers.forEach((trigger) => {
      trigger.addEventListener('click', (event) => {
        event.preventDefault();
        openTrigger(trigger);
      });
    });

    dialogs.forEach((dialog) => {
      const finish = () => {
        document.body.classList.remove('has-dialog');
        const returnFocus = dialog._returnFocus;
        dialog._returnFocus = null;
        if (returnFocus && typeof returnFocus.focus === 'function') returnFocus.focus();
      };
      const close = () => {
        if (typeof dialog.close === 'function' && dialog.open) dialog.close();
        else {
          dialog.removeAttribute('open');
          finish();
        }
      };

      dialog.addEventListener('close', finish);
      dialog.addEventListener('click', (event) => {
        if (event.target === dialog) close();
      });
      dialog.addEventListener('keydown', (event) => {
        if (event.key === 'Tab') {
          const focusable = Array.from(
            dialog.querySelectorAll(
              'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
            ),
          ).filter((el) => !el.disabled && el.getClientRects().length > 0);
          if (focusable.length > 0) {
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first.focus();
            } else if (
              event.shiftKey &&
              (document.activeElement === first || document.activeElement === dialog)
            ) {
              event.preventDefault();
              last.focus();
            }
          }
        }
        if (!dialog._gallery) return;
        if (event.key === 'ArrowLeft') {
          event.preventDefault();
          dialog._gallery.step(-1);
        } else if (event.key === 'ArrowRight') {
          event.preventDefault();
          dialog._gallery.step(1);
        }
      });

      const closeButton = $('[data-dialog-close]', dialog);
      if (closeButton) closeButton.addEventListener('click', close);
      const prev = $('[data-dialog-prev]', dialog);
      const next = $('[data-dialog-next]', dialog);
      if (prev) prev.addEventListener('click', () => dialog._gallery && dialog._gallery.step(-1));
      if (next) next.addEventListener('click', () => dialog._gallery && dialog._gallery.step(1));
    });
  }

  /* ---------- Release 数据：运行时取最新版，构建快照做兜底 ---------- */

  function fallbackRelease() {
    return {
      repo: REPO,
      version: '',
      tag: '',
      publishedAt: null,
      htmlUrl: `${REPO_URL}/releases`,
      notesUrl: `${REPO_URL}/releases`,
      source: 'fallback',
      assets: [],
    };
  }

  function normalizeAssets(assets) {
    if (!Array.isArray(assets)) return [];
    return assets
      .filter((asset) => {
        if (!asset || typeof asset.name !== 'string' || !asset.browser_download_url) return false;
        return asset.name === CHECKSUM_ASSET_NAME || RELEASE_ASSET_PATTERN.test(asset.name);
      })
      .map((asset) => ({
        name: asset.name,
        size: Number.isFinite(Number(asset.size)) ? Number(asset.size) : 0,
        browser_download_url: asset.browser_download_url,
        content_type: typeof asset.content_type === 'string' ? asset.content_type : '',
      }));
  }

  function normalizeRelease(raw, source) {
    if (!raw) return null;
    const rawVersion = raw.version || raw.tag_name || raw.tag || '';
    const version = String(rawVersion).trim().replace(/^[vV](?=\d)/, '');
    if (!version) return null;
    const tag = String(raw.tag || raw.tag_name || `v${version}`).trim();
    const tagUrl = `${REPO_URL}/releases/tag/${encodeURIComponent(tag)}`;
    const htmlUrl =
      typeof raw.htmlUrl === 'string' && raw.htmlUrl.startsWith('http')
        ? raw.htmlUrl
        : typeof raw.html_url === 'string' && raw.html_url.startsWith('http')
          ? raw.html_url
          : tagUrl;
    return {
      repo: raw.repo || REPO,
      version,
      tag,
      publishedAt: raw.publishedAt || raw.published_at || null,
      htmlUrl,
      notesUrl: raw.notesUrl || htmlUrl,
      source: source || raw.source || 'static',
      assets: normalizeAssets(raw.assets),
    };
  }

  function readReleaseCache() {
    try {
      const raw = sessionStorage.getItem(RELEASE_CACHE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || !parsed.at || Date.now() - parsed.at > RELEASE_CACHE_TTL) {
        sessionStorage.removeItem(RELEASE_CACHE_KEY);
        return null;
      }
      return parsed.release || null;
    } catch {
      return null;
    }
  }

  function writeReleaseCache(release) {
    try {
      sessionStorage.setItem(
        RELEASE_CACHE_KEY,
        JSON.stringify({ release, at: Date.now() }),
      );
    } catch {
      /* 隐私模式下忽略 */
    }
  }

  async function fetchLatestRelease() {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RELEASE_API_TIMEOUT);
    try {
      const response = await fetch(LATEST_RELEASE_API, {
        headers: {
          Accept: 'application/vnd.github+json',
        },
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!response.ok) return null;
      const data = await response.json();
      return normalizeRelease(data, 'api');
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  function applyReleaseUI(release) {
    const version = release && release.version ? String(release.version) : '';
    $$('[data-release-version]').forEach((el) => {
      el.textContent = version ? `v${version}` : '尚未发布';
      el.setAttribute(
        'title',
        version ? '来自 GitHub Releases 的最新版本' : '仓库还没有正式 Release',
      );
    });
    $$('[data-release-date]').forEach((el) => {
      el.textContent = release && release.publishedAt ? formatDate(release.publishedAt) : '尚未发布';
    });
    $$('[data-release-date-iso]').forEach((el) => {
      if (release && release.publishedAt) el.setAttribute('datetime', release.publishedAt);
    });

    const groups = groupAssets(release ? release.assets : []);
    const installer =
      groups.windows.find((item) => item.kind === 'installer') || groups.windows[0] || null;
    const primaryUrl = installer ? installer.asset.browser_download_url : (release && release.htmlUrl) || `${REPO_URL}/releases`;
    $$('[data-download-primary]').forEach((el) => {
      el.setAttribute('href', primaryUrl);
    });
    $$('[data-release-url]').forEach((el) => {
      el.setAttribute('href', (release && release.htmlUrl) || `${REPO_URL}/releases`);
    });
    $$('[data-release-notes]').forEach((el) => {
      el.setAttribute(
        'href',
        (release && (release.notesUrl || release.htmlUrl)) || `${REPO_URL}/releases`,
      );
    });
  }

  async function fetchRelease() {
    if (DHS.release) return DHS.release;
    const emit = (release) => {
      DHS.release = release;
      applyReleaseUI(release);
      document.dispatchEvent(new CustomEvent('dhs:release', { detail: release }));
      return release;
    };

    // 1) 运行时直接取 GitHub 最新 Release：页面无需重新部署即可显示新版本
    const cached = readReleaseCache();
    if (cached) return emit(cached);

    const latest = await fetchLatestRelease();
    if (latest) {
      writeReleaseCache(latest);
      return emit(latest);
    }

    // 2) 回退到构建时快照（CI 构建时带 token 查询，规避浏览器端 API 限流）
    try {
      const response = await fetch('./release.json', { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      const snapshot = normalizeRelease(data, data.source || 'snapshot');
      const trusted =
        snapshot && (data.source === 'api' || snapshot.assets.length > 0);
      if (trusted) return emit(snapshot);
    } catch {
      /* 忽略，走最终兜底 */
    }

    // 3) 没有 Release / API 与快照都不可用：明确「尚未发布」，版本不硬编码
    return emit(fallbackRelease());
  }

  function onRelease(callback) {
    if (typeof callback !== 'function') return;
    if (DHS.release) {
      callback(DHS.release);
      return;
    }
    document.addEventListener(
      'dhs:release',
      (event) => callback(event.detail),
      { once: true },
    );
  }

  /* ---------- 其它 ---------- */

  function initYear() {
    $$('[data-year]').forEach((el) => {
      el.textContent = String(new Date().getFullYear());
    });
  }

  const DHS = {
    repo: REPO,
    repoUrl: REPO_URL,
    releasesUrl: `${REPO_URL}/releases`,
    reducedMotion: REDUCED.matches,
    release: null,
    detectPlatform,
    groupAssets,
    classifyAsset,
    formatBytes,
    formatDate,
    fetchRelease,
    onRelease,
  };
  window.DHS = DHS;

  function boot() {
    document.documentElement.dataset.platform = detectPlatform();
    initHeader();
    initMobileNav();
    initReveal();
    initScrollSpy();
    initCurrentPageNav();
    initDialogs();
    initYear();
    fetchRelease();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
