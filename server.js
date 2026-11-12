import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { config, hasApiKey } from './src/config.js';
import { readNewsCache, todayKey } from './src/store.js';
import { refreshBrief } from './src/scheduler.js';
import { analyzeMood } from './src/mood.js';
import { accessToken, authEnabled, isAuthorized, buildAuthCookie, unauthorized } from './src/auth.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/* ---------- 简易限流：每个 IP 10 分钟内最多 25 次情绪分析 ---------- */
const buckets = new Map();
function rateLimit(ip, max = 25, windowMs = 10 * 60 * 1000) {
  const now = Date.now();
  const arr = (buckets.get(ip) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) return false;
  arr.push(now);
  buckets.set(ip, arr);
  return true;
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.join(config.publicDir, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));

  if (!filePath.startsWith(config.publicDir)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname } = url;
  const ip = req.socket.remoteAddress || 'unknown';

  try {
    /* 口令登录 */
    if (pathname === '/api/auth' && req.method === 'POST') {
      const raw = await readBody(req);
      let token = '';
      try {
        token = String(JSON.parse(raw)?.token ?? '');
      } catch {
        return sendJson(res, 400, { error: '请求格式错误' });
      }
      if (!authEnabled()) return sendJson(res, 200, { ok: true, authRequired: false });
      if (token.trim() !== accessToken()) {
        await new Promise((r) => setTimeout(r, 400));
        return sendJson(res, 401, { error: '口令不对' });
      }
      res.setHeader('Set-Cookie', buildAuthCookie(req));
      return sendJson(res, 200, { ok: true });
    }

    /* 其余 /api 接口一律需要口令 */
    if (pathname.startsWith('/api/') && !isAuthorized(req)) {
      return unauthorized(res);
    }

    /* 健康检查 */
    if (pathname === '/api/status') {
      const cache = readNewsCache();
      return sendJson(res, 200, {
        ok: true,
        hasApiKey: hasApiKey(),
        model: config.model,
        today: todayKey(),
        cache: cache
          ? { date: cache.date, generatedAt: cache.generatedAt, count: cache.items?.length ?? 0, degraded: !!cache.degraded }
          : null,
      });
    }

    /* 新闻快报 */
    if (pathname === '/api/news' && req.method === 'GET') {
      const force = url.searchParams.get('refresh') === '1';
      // 强制刷新已由访问口令保护，不再限制来源 IP（云端 IP 不是 127.0.0.1）
      const data = await refreshBrief({ force });
      return sendJson(res, 200, data);
    }

    /* 情绪分析 + 音乐推荐 */
    if (pathname === '/api/mood' && req.method === 'POST') {
      if (!rateLimit(ip)) {
        return sendJson(res, 429, { error: '请求太频繁，歇一会儿再来' });
      }
      const raw = await readBody(req);
      let text = '';
      try {
        text = JSON.parse(raw)?.text ?? '';
      } catch {
        return sendJson(res, 400, { error: '请求格式错误' });
      }
      if (!text || !String(text).trim()) {
        return sendJson(res, 400, { error: '说点什么吧' });
      }
      const result = await analyzeMood(text);
      return sendJson(res, 200, result);
    }

    /* 静态资源 */
    if (req.method === 'GET') {
      return serveStatic(req, res, pathname);
    }

    sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    const code = err.code === 'NO_API_KEY' ? 500 : 502;
    console.error(`[错误] ${pathname}: ${err.message}`);
    sendJson(res, code, {
      error: err.code === 'NO_API_KEY' ? '服务端还没填智谱 API Key，请编辑 .env 后重启' : err.message,
    });
  }
});

server.listen(config.port, config.host, () => {
  const url = `http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`;
  console.log('');
  console.log('  情绪新闻台已启动（腾讯云 SCF Web 函数）');
  console.log(`  监听: ${url}`);
  console.log(`  模型: ${config.model}${hasApiKey() ? '' : '  (未配置 API Key，情绪功能降级)'}`);
  console.log(`  缓存目录: ${config.dataDir}`);
  console.log('');
  // 云函数实例会被冻结，不用进程内定时器；
  // 改为请求时按日期惰性判断，见 refreshBrief 内的 todayKey 比对
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`端口 ${config.port} 被占用，改一下 .env 里的 PORT`);
    process.exit(1);
  }
  throw err;
});