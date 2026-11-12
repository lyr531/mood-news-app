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