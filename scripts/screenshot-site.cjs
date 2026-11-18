#!/usr/bin/env node
/**
 * 官网截图与冒烟诊断（Chrome headless + CDP）。
 *
 * 先构建站点，再运行：
 *   npm run site:build
 *   node scripts/screenshot-site.cjs [--dist dist-site] [--out artifacts/site-review]
 *
 * 脚本自己启动只读静态服务器（127.0.0.1），用本机 Chrome 的 headless 模式加载
 * 首页 / 下载页，在桌面、笔记本、手机三档视口下截取关键区块，并输出：
 *   - artifacts/site-review/<viewport>-<scene>.png
 *   - artifacts/site-review/diagnostics.json（横向溢出、缺图、h1 数量、控制台错误）
 *
 * 需要本机安装 Chrome（可用 CHROME_PATH 指定路径）；headless 渲染与线上 Chromium 一致。
 * 这个脚本只用于本地自查 / 设计验收，不参与 Pages 构建。
 */
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { URL } = require('node:url');

/* ---------- 参数 ---------- */

const argv = process.argv.slice(2);
function argValue(name, fallback) {
  const index = argv.indexOf(`--${name}`);
  if (index >= 0 && argv[index + 1] && !argv[index + 1].startsWith('--')) return argv[index + 1];
  const inline = argv.find((item) => item.startsWith(`--${name}=`));
  if (inline) return inline.slice(`--${name}=`.length);
  return fallback;
}

const root = path.resolve(__dirname, '..');
const distDir = path.resolve(root, argValue('dist', 'dist-site'));
const outDir = path.resolve(root, argValue('out', path.join('artifacts', 'site-review')));
const port = Number(argValue('port', '4180')) || 4180;
const only = argValue('only', '');

if (!fs.existsSync(path.join(distDir, 'index.html'))) {
  console.error(`[site-shot] 找不到 ${distDir}${path.sep}index.html，请先运行 npm run site:build`);
  process.exit(1);
}

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

const chromePath = CHROME_CANDIDATES.find((candidate) => fs.existsSync(candidate));
if (!chromePath) {
  console.error('[site-shot] 未找到 Chrome / Edge，请用 CHROME_PATH 指定浏览器可执行文件。');
  process.exit(1);
}

/* ---------- 工具 ---------- */

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ---------- 静态服务器 ---------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

function startServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((request, response) => {
      try {
        const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
        let relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
        if (relative.endsWith('/')) relative += 'index.html';
        const file = path.resolve(distDir, relative);
        if (file !== distDir && !file.startsWith(distDir + path.sep)) {
          response.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
          response.end('forbidden');
          return;
        }
        fs.readFile(file, (error, data) => {
          if (error) {
            response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            response.end(`not found: ${relative}`);
            return;
          }
          response.writeHead(200, {
            'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
            'Cache-Control': 'no-store',
          });
          response.end(data);
        });
      } catch (error) {
        response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end(String(error));
      }
    });
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

/* ---------- CDP 客户端 ---------- */

class CdpClient {
  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', () => reject(new Error('CDP 连接失败')), { once: true });
    });
    const client = new CdpClient(socket);
    socket.addEventListener('message', (event) => client.handleMessage(event));
    return client;
  }

  constructor(socket) {
    this.socket = socket;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = [];
  }

  handleMessage(event) {
    let message;
    try {
      message = JSON.parse(typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString());
    } catch {
      return;
    }
    if (message.id && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(`${message.error.message} (${message.error.code})`));
      else pending.resolve(message.result);
      return;
    }
    if (message.method) this.listeners.forEach((listener) => listener(message));
  }

  on(method, callback) {
    this.listeners.push((message) => {
      if (message.method === method) callback(message.params, message.sessionId);
    });
  }

  send(method, params = {}, sessionId = undefined) {
    const id = (this.nextId += 1);
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP 超时：${method}`));
      }, 20000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify(payload));
    });
  }

  close() {
    try {
      this.socket.close();
    } catch {
      /* 忽略 */
    }
  }
}

async function waitForDevtools(profileDir) {
  const portFile = path.join(profileDir, 'DevToolsActivePort');
  for (let attempt = 0; attempt < 160; attempt += 1) {
    try {
      const raw = fs.readFileSync(portFile, 'utf8').trim().split(/\r?\n/);
      if (raw[0] && raw[1]) {
        return { port: Number(raw[0]), path: raw[1] };
      }
    } catch {
      /* 还没写出来 */
    }
    await wait(100);
  }
  throw new Error('启动 Chrome 后未等到 DevToolsActivePort，可能 headless 启动失败');
}

async function evaluate(client, sessionId, expression, timeoutLabel) {
  const result = await client.send(
    'Runtime.evaluate',
    {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    },
    sessionId,
  );
  if (result.exceptionDetails) {
    const detail = result.exceptionDetails.exception
      ? result.exceptionDetails.exception.description || result.exceptionDetails.text
      : result.exceptionDetails.text;
    throw new Error(`${timeoutLabel || '脚本'}执行失败：${detail}`);
  }
  return result.result ? result.result.value : undefined;
}

/* ---------- 截图场景 ---------- */

const VIEWPORTS = {
  desktop: { width: 1440, height: 900, dsf: 1.5, label: '1440' },
  laptop: { width: 1120, height: 720, dsf: 1.5, label: '1120' },
  mobile: { width: 390, height: 844, dsf: 2, label: '390' },
};

const SCENES = [
  { name: 'home-hero', url: '/index.html', viewports: ['desktop', 'laptop', 'mobile'], wait: 1500 },
  {
    name: 'home-hero-reduced',
    url: '/index.html',
    viewports: ['desktop'],
    wait: 1500,
    emulateMedia: { 'prefers-reduced-motion': 'reduce' },
  },
  { name: 'home-workflow', url: '/index.html', viewports: ['desktop'], scrollTo: '#workflow' },
  { name: 'home-workflow-2', url: '/index.html', viewports: ['desktop'], scrollTo: '[data-flow-step="1"]' },
  { name: 'home-workflow-3', url: '/index.html', viewports: ['desktop'], scrollTo: '[data-flow-step="2"]' },
  { name: 'home-features', url: '/index.html', viewports: ['desktop'], scrollTo: '#features' },
  { name: 'home-practice', url: '/index.html', viewports: ['desktop', 'mobile'], scrollTo: '#practice' },
  {
    name: 'home-practice-running',
    url: '/index.html',
    viewports: ['desktop'],
    scrollTo: '#practice',
    before: `document.querySelector('[data-practice-start]')?.click()`,
    wait: 1800,
  },
  {
    name: 'home-practice-input',
    url: '/index.html',
    viewports: ['desktop'],
    scrollTo: '#practice',
    before: `document.querySelector('[data-practice-start]')?.click(); window.__keys = ['z','x','c','v','b','n','m',',']; window.__i = 0; window.__timer = setInterval(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: window.__keys[window.__i++ % 8], bubbles: true })), 280);`,
    wait: 4200,
  },
  { name: 'home-ingame', url: '/index.html', viewports: ['desktop'], scrollTo: '#ingame' },
  { name: 'home-gallery', url: '/index.html', viewports: ['desktop', 'mobile'], scrollTo: '#gallery' },
  {
    name: 'home-lightbox',
    url: '/index.html',
    viewports: ['desktop'],
    scrollTo: '#gallery',
    before: `document.querySelector('[data-gallery-panel]:not([hidden]) .gallery__zoom')?.click()`,
    wait: 700,
  },
  { name: 'home-download', url: '/index.html', viewports: ['desktop', 'mobile'], scrollTo: '#download' },
  {
    name: 'home-menu',
    url: '/index.html',
    viewports: ['mobile'],
    before: `document.querySelector('[data-menu-toggle]')?.click()`,
    wait: 500,
  },
  { name: 'downloads-hero', url: '/downloads.html', viewports: ['desktop', 'mobile'] },
  { name: 'downloads-platforms', url: '/downloads.html', viewports: ['desktop', 'laptop', 'mobile'], scrollTo: '#platforms' },
  { name: 'downloads-install', url: '/downloads.html', viewports: ['desktop', 'mobile'], scrollTo: '#install' },
  { name: 'downloads-matrix', url: '/downloads.html', viewports: ['desktop'], scrollTo: '#matrix' },
  { name: 'downloads-faq', url: '/downloads.html', viewports: ['desktop'], scrollTo: '#faq' },
  { name: 'downloads-footer', url: '/downloads.html', viewports: ['desktop', 'mobile'], scrollTo: 'footer' },
];

const IMAGE_WAIT = `(async () => {
  const images = Array.from(document.images);
  images.forEach((img) => { img.loading = 'eager'; });
  await Promise.all(images.map((img) => (img.decode ? img.decode().catch(() => {}) : Promise.resolve())));
  if (document.fonts) await document.fonts.ready;
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  return true;
})()`;

const DIAGNOSTICS = `(() => {
  const brokenImages = Array.from(document.images)
    .filter((img) => !img.complete || img.naturalWidth === 0)
    .map((img) => img.currentSrc || img.src || img.getAttribute('src'));
  const overflow = Math.max(
    document.documentElement ? document.documentElement.scrollWidth : 0,
    document.body ? document.body.scrollWidth : 0,
  ) - window.innerWidth;
  return {
    title: document.title,
    brokenImages,
    horizontalOverflow: overflow,
    h1Count: document.querySelectorAll('h1').length,
    dialogsOpen: document.querySelectorAll('dialog[open]').length,
    activeNav: Array.from(document.querySelectorAll('.nav__link.is-active')).map((el) => el.textContent.trim()),
    practiceAccuracy: (() => {
      const el = document.querySelector('[data-practice-accuracy]');
      return el ? el.textContent.trim() : null;
    })(),
    scrollY: Math.round(window.scrollY),
    docHeight: document.documentElement ? document.documentElement.scrollHeight : 0,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    platform: document.documentElement ? document.documentElement.dataset.platform : '',
  };
})()`;

async function waitForReady(client, sessionId, expectedUrl) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const state = await evaluate(
      client,
      sessionId,
      `(() => {
        const ready = document.readyState;
        const href = location.href;
        return { ready, href };
      })()`,
      '等待页面加载',
    );
    if (state && state.ready === 'complete' && state.href.startsWith(expectedUrl)) return;
    await wait(100);
  }
  throw new Error(`页面加载超时：${expectedUrl}`);
}

async function captureScene(client, sessionId, viewport, scene, filePath) {
  await client.send(
    'Emulation.setDeviceMetricsOverride',
    {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: viewport.dsf,
      mobile: false,
    },
    sessionId,
  );
  await client.send('Page.navigate', { url: scene.url ? undefined : undefined }, sessionId).catch(() => {});
}

/* ---------- 主流程 ---------- */

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  const profileDir = path.join(root, 'artifacts', 'site-shot-chrome-profile');
  fs.rmSync(profileDir, { recursive: true, force: true });
  fs.mkdirSync(profileDir, { recursive: true });

  const server = await startServer();
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`[site-shot] 预览服务：${baseUrl}（${distDir}）`);
  console.log(`[site-shot] Chrome：${chromePath}`);

  const chrome = spawn(
    chromePath,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-sync',
      '--disable-translate',
      '--disable-default-apps',
      '--disable-gpu',
      '--hide-scrollbars',
      '--mute-audio',
      '--no-sandbox',
      '--window-size=1440,900',
      'about:blank',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let chromeStderr = '';
  chrome.stderr.on('data', (chunk) => {
    chromeStderr += String(chunk);
  });
  chrome.on('exit', (code) => {
    if (code && code !== 0) console.log(`[site-shot] Chrome 退出码 ${code}`);
  });

  const consoleErrors = [];
  const report = {
    generatedAt: new Date().toISOString(),
    distDir,
    chrome: path.basename(chromePath),
    viewports: VIEWPORTS,
    scenes: [],
    consoleErrors,
    exceptions: [],
  };
  const scenesToCapture = only
    ? SCENES.filter((scene) => scene.name.includes(only) || scene.url.includes(only))
    : SCENES;
  if (only) {
    console.log(`[site-shot] --only=${only}，捕获 ${scenesToCapture.length} 个场景`);
  }

  let client = null;
  try {
    const devtools = await waitForDevtools(profileDir);
    client = await CdpClient.connect(`ws://127.0.0.1:${devtools.port}${devtools.path}`);

    const { targetId } = await client.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true });
    await client.send('Page.enable', {}, sessionId);
    await client.send('Runtime.enable', {}, sessionId);

    client.on('Runtime.consoleAPICalled', (params) => {
      if (params.type === 'error' || params.type === 'assert') {
        const text = (params.args || [])
          .map((arg) => (arg.value !== undefined ? String(arg.value) : arg.description || ''))
          .join(' ')
          .slice(0, 300);
        report.consoleErrors.push({ type: params.type, text });
      }
    });
    client.on('Runtime.exceptionThrown', (params) => {
      const detail = params.exceptionDetails || {};
      report.exceptions.push({
        text: (detail.exception && detail.exception.description) || detail.text || 'unknown',
      });
    });

    for (const scene of scenesToCapture) {
      for (const viewportName of scene.viewports) {
        const viewport = VIEWPORTS[viewportName];
        const sceneName = `${viewportName}-${scene.name}`;
        try {
          console.log(`[site-shot] 捕获 ${sceneName} …`);
          const url = `${baseUrl}${scene.url}`;
          await client.send(
            'Emulation.setDeviceMetricsOverride',
            {
              width: viewport.width,
              height: viewport.height,
              deviceScaleFactor: viewport.dsf,
              mobile: false,
            },
            sessionId,
          );
          await client.send(
            'Emulation.setEmulatedMedia',
            {
              features: scene.emulateMedia
                ? Object.entries(scene.emulateMedia).map(([name, value]) => ({ name, value }))
                : [],
            },
            sessionId,
          );
          await client.send('Page.navigate', { url }, sessionId);
          await waitForReady(client, sessionId, url);
          await evaluate(client, sessionId, IMAGE_WAIT, `${sceneName} 图片`);
          await wait(400);

          if (scene.scrollTo) {
            const scrolled = await evaluate(
              client,
              sessionId,
              `(() => {
                const el = document.querySelector(${JSON.stringify(scene.scrollTo)});
                if (!el) return false;
                const y = el.getBoundingClientRect().top + window.scrollY - 76;
                window.scrollTo({ top: Math.max(0, y), behavior: 'instant' });
                return true;
              })()`,
              `${sceneName} 滚动`,
            );
            if (!scrolled) console.log(`[site-shot]   未找到锚点 ${scene.scrollTo}`);
            await wait(650);
          }
          if (scene.before) {
            await evaluate(client, sessionId, `(() => { ${scene.before}; return true; })()`, `${sceneName} 交互`);
            await wait(scene.wait || 600);
          } else if (!scene.scrollTo) {
            await wait(scene.wait || 900);
          }

          const shot = await client.send(
            'Page.captureScreenshot',
            { format: 'png', captureBeyondViewport: false },
            sessionId,
          );
          const fileName = `${sceneName}.png`;
          fs.writeFileSync(path.join(outDir, fileName), Buffer.from(shot.data, 'base64'));

          const info = (await evaluate(client, sessionId, DIAGNOSTICS, `${sceneName} 诊断`)) || {};
          report.scenes.push({ scene: scene.name, viewportName, file: fileName, ...info });
          console.log(
            `[site-shot] ${fileName}  overflow=${info.horizontalOverflow} brokenImages=${(info.brokenImages || []).length} h1=${info.h1Count}`,
          );
          if (info.brokenImages && info.brokenImages.length) {
            console.log(`[site-shot]   缺图：${info.brokenImages.join(', ')}`);
          }
        } catch (error) {
          report.scenes.push({
            scene: scene.name,
            viewport: viewportName,
            error: String((error && error.message) || error),
          });
          console.error(`[site-shot] ${sceneName} 失败：${(error && error.message) || error}`);
        }
      }
    }

    fs.writeFileSync(path.join(outDir, 'diagnostics.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(`[site-shot] 诊断写入 ${path.join(outDir, 'diagnostics.json')}`);
    if (report.consoleErrors.length) {
      console.log(`[site-shot] 控制台错误 ${report.consoleErrors.length} 条：`);
      report.consoleErrors.slice(0, 20).forEach((item) => console.log(`  - ${item.text}`));
    }
    if (report.exceptions.length) {
      console.log(`[site-shot] 未捕获异常 ${report.exceptions.length} 条：`);
      report.exceptions.slice(0, 20).forEach((item) => console.log(`  - ${item.text.split('\n')[0]}`));
    }
  } finally {
    if (client) client.close();
    try {
      chrome.kill();
    } catch {
      /* 忽略 */
    }
    await new Promise((resolve) => server.close(resolve));
    if (chromeStderr && !fs.existsSync(path.join(outDir, 'diagnostics.json'))) {
      console.error(chromeStderr.slice(0, 2000));
    }
  }
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error('[site-shot] 失败：', error);
    process.exit(1);
  });
