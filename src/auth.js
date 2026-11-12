// 访问口令校验：口令只存在服务端环境变量 ACCESS_TOKEN 里
// 前端 POST /api/auth 提交口令，校验通过后下发 HttpOnly Cookie

export const AUTH_COOKIE = 'mna_token';

export function accessToken() {
  return String(process.env.ACCESS_TOKEN || '').trim();
}

export function authEnabled() {
  return accessToken().length > 0;
}

/** 从 header / query / cookie 里取出口令 */
export function readToken(req) {
  const h = req.headers['x-access-token'];
  if (h) return String(h).trim();

  const auth = req.headers['authorization'];
  if (auth && auth.startsWith('Bearer ')) return auth.slice(7).trim();

  try {
    const u = new URL(req.url, 'http://localhost');
    const q = u.searchParams.get('token');
    if (q) return q.trim();
  } catch {
    /* 忽略 */
  }

  const cookie = req.headers.cookie || '';
  const m = cookie.match(new RegExp(`${AUTH_COOKIE}=([^;]+)`));
  if (m) return decodeURIComponent(m[1]);

  return '';
}

export function isAuthorized(req) {
  if (!authEnabled()) return true;
  const t = readToken(req);
  // 简单等长比较即可，口令本身不敏感到需要防侧信道
  return t.length > 0 && t === accessToken();
}

/** 校验通过后下发 Cookie，有效期 30 天 */
export function buildAuthCookie(req) {
  const https = (req.headers['x-forwarded-proto'] || '').includes('https');
  const parts = [
    `${AUTH_COOKIE}=${encodeURIComponent(accessToken())}`,
    'Path=/',
    'Max-Age=2592000',
    'SameSite=Lax',
    'HttpOnly',
  ];
  if (https) parts.push('Secure');
  return parts.join('; ');
}

export function unauthorized(res) {
  res.writeHead(401, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify({ error: '需要访问口令', authRequired: true }));
}