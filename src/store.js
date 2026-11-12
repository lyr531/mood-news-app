import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export function readNewsCache() {
  try {
    const txt = fs.readFileSync(config.newsCacheFile, 'utf8');
    return JSON.parse(txt);
  } catch {
    return null;
  }
}

export function writeNewsCache(payload) {
  ensureDir(config.dataDir);
  const tmp = config.newsCacheFile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
  fs.renameSync(tmp, config.newsCacheFile);
}

export function todayKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function isToday(iso) {
  if (!iso) return false;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return false;
  return todayKey(d) === todayKey();
}

export function humanTime(d = new Date()) {
  return new Date(d).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
  });
}

/* ---------------- 已展示历史 ----------------
   用来避免每次刷新都给同样那几条。
   只存标题，最多 300 条，够轮换一两天。 */

const HISTORY_MAX = 300;
const historyFile = () => path.join(config.dataDir, 'shown-history.json');

const normKey = (s) =>
  String(s || '')
    .replace(/[\s\u3000\u3001-\u303f，。！？；：""''（）()《》]/g, '')
    .slice(0, 40);

export function readHistory() {
  try {
    const arr = JSON.parse(fs.readFileSync(historyFile(), 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export function appendHistory(titles) {
  try {
    ensureDir(config.dataDir);
    const seen = new Set(readHistory());
    for (const t of titles) {
      const k = normKey(t);
      if (k) seen.add(k);
    }
    // 保留最近 300 条
    const list = [...seen].slice(-HISTORY_MAX);
    fs.writeFileSync(historyFile(), JSON.stringify(list), 'utf8');
  } catch {
    /* 历史写不进去不影响主流程 */
  }
}

export { normKey };