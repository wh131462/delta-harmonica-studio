#!/usr/bin/env node
/**
 * 本地预览静态官网：零依赖静态文件服务器（只用 node:http / node:fs）。
 *
 * 用法：
 *   node scripts/serve-site.mjs [--dist dist-site] [--port 4173]
 *
 * 先运行 npm run site:build 生成 dist-site/，再运行本脚本，默认访问
 * http://127.0.0.1:4173/ 。行为尽量贴近 GitHub Pages：
 *   /            → index.html
 *   无扩展名路径 → 先尝试 <path>.html（/downloads → downloads.html）
 *   所有响应带 Cache-Control: no-store，避免预览时改完刷新还是旧文件
 *   拒绝目录穿越；端口被占用时给出明确提示
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import process from 'node:process';

const DEFAULT_DIST_DIR = 'dist-site';
const DEFAULT_PORT = 4173;
const HOST = '127.0.0.1';

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
};

const USAGE = `用法：node scripts/serve-site.mjs [选项]

  --dist <dir>   构建产物目录（默认 dist-site，需先运行 npm run site:build）
  --port <port>  监听端口（默认 ${DEFAULT_PORT}；0 表示由系统分配空闲端口）

预览地址默认是 http://${HOST}:${DEFAULT_PORT}/ ，按 Ctrl+C 停止。
`;

const log = (...parts) => console.log('[site]', ...parts);

function parseArgs(argv) {
  const options = { dist: DEFAULT_DIST_DIR, port: DEFAULT_PORT };
  const names = { '--dist': 'dist', '--port': 'port' };
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
    options[key] = key === 'port' ? parsePort(value) : value;
    i += 1;
  }
  return options;
}

function parsePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`端口不合法：${value}（应为 0-65535 的整数）`);
  }
  return port;
}

async function statOrNull(filePath) {
  try {
    return await stat(filePath);
  } catch {
    return null;
  }
}

/** child 是否等于 parent 或位于 parent 内部（用于防目录穿越）。 */
function isSameOrInside(parent, child) {
  const parentResolved = path.resolve(parent);
  const childResolved = path.resolve(child);
  const normalize = (value) => (process.platform === 'win32' ? value.toLowerCase() : value);
  if (normalize(parentResolved) === normalize(childResolved)) return true;
  const relative = path.relative(parentResolved, childResolved);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function assertDistDir(distDir) {
  const info = await statOrNull(distDir);
  if (!info || !info.isDirectory()) {
    throw new Error(
      `站点目录不存在：${distDir}\n请先运行 npm run site:build（或 node scripts/build-site.mjs）生成构建产物。`,
    );
  }
  const indexInfo = await statOrNull(path.join(distDir, 'index.html'));
  if (!indexInfo || !indexInfo.isFile()) {
    throw new Error(`站点目录里没有 index.html：${distDir}\n请先运行 npm run site:build 重新构建。`);
  }
}

/**
 * 把请求路径解析为文件：
 *   - 目录（且路径带 /）→ 目录下的 index.html；目录不带 / → 301 补斜杠，保证相对链接正确
 *   - 普通文件 → 直接返回
 *   - 无扩展名路径 → 尝试同名 .html
 *   - 越出 dist 目录 → forbidden
 */
async function resolveTarget(distDir, pathname) {
  const normalizedPath = String(pathname || '/').replace(/\\/g, '/');
  const relative = normalizedPath.replace(/^\/+/, '');
  if (relative.includes('\0')) return { type: 'forbidden' };
  const resolved = path.resolve(distDir, relative);
  if (!isSameOrInside(distDir, resolved)) return { type: 'forbidden' };

  const info = await statOrNull(resolved);
  if (info && info.isDirectory()) {
    if (!normalizedPath.endsWith('/')) return { type: 'redirect', location: `${normalizedPath}/` };
    const indexInfo = await statOrNull(path.join(resolved, 'index.html'));
    return indexInfo && indexInfo.isFile()
      ? { type: 'file', filePath: path.join(resolved, 'index.html') }
      : { type: 'not-found' };
  }
  if (info && info.isFile()) return { type: 'file', filePath: resolved };
  if (!path.extname(resolved)) {
    const htmlFile = `${resolved}.html`;
    const htmlInfo = await statOrNull(htmlFile);
    if (htmlInfo && htmlInfo.isFile()) return { type: 'file', filePath: htmlFile };
  }
  return { type: 'not-found' };
}

function sendText(response, statusCode, message, headers = {}) {
  const body = Buffer.from(`${message}\n`, 'utf8');
  response.writeHead(statusCode, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    ...headers,
  });
  response.end(body);
}

async function sendFile(request, response, filePath) {
  const info = await stat(filePath);
  if (!info.isFile()) {
    sendText(response, 404, '404 未找到');
    return;
  }
  const contentType = CONTENT_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
  response.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': info.size,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  log(`${request.method} ${request.url} 200 ${contentType}`);
  if (request.method === 'HEAD') {
    response.end();
    return;
  }
  const stream = createReadStream(filePath);
  stream.on('error', () => response.destroy());
  stream.pipe(response);
}

async function handleRequest(request, response, distDir) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    sendText(response, 405, '405 只支持 GET / HEAD 请求', { Allow: 'GET, HEAD' });
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url || '/', `http://${HOST}`).pathname);
  } catch {
    sendText(response, 400, '400 请求路径无法解码');
    return;
  }

  const target = await resolveTarget(distDir, pathname);
  if (target.type === 'redirect') {
    log(`${request.method} ${pathname} 301 → ${target.location}`);
    response.writeHead(301, { Location: target.location, 'Cache-Control': 'no-store' });
    response.end();
    return;
  }
  if (target.type === 'forbidden') {
    log(`${request.method} ${pathname} 403`);
    sendText(response, 403, '403 禁止访问站点目录之外的路径');
    return;
  }
  if (target.type === 'not-found') {
    log(`${request.method} ${pathname} 404`);
    sendText(response, 404, `404 未找到：${pathname}`);
    return;
  }
  await sendFile(request, response, target.filePath);
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, HOST);
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const distDir = path.resolve(process.cwd(), options.dist);
  await assertDistDir(distDir);

  const server = createServer((request, response) => {
    handleRequest(request, response, distDir).catch((error) => {
      log(`处理请求失败：${request.url}（${error.message}）`);
      if (!response.headersSent) {
        sendText(response, 500, '500 服务器内部错误');
      } else {
        response.destroy();
      }
    });
  });

  try {
    await listen(server, options.port);
  } catch (error) {
    if (error && error.code === 'EADDRINUSE') {
      throw new Error(`端口 ${options.port} 已被占用：请关闭占用它的程序，或用 --port <其它端口> 重新启动。`);
    }
    if (error && error.code === 'EACCES') {
      throw new Error(`没有权限监听端口 ${options.port}：请改用 1024 以上的端口（如 --port 4173）。`);
    }
    throw error;
  }

  const address = server.address();
  const port = address && typeof address === 'object' ? address.port : options.port;
  log(`站点目录：${distDir}`);
  log(`本地预览已启动：http://${HOST}:${port}/`);
  log('按 Ctrl+C 停止');

  const shutdown = () => {
    log('正在停止本地预览服务器…');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[site] 预览服务器启动失败：${message}`);
  process.exitCode = 1;
});
