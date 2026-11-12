import { UA } from './config.js';

const NETEASE_HEADERS = {
  'User-Agent': UA,
  Referer: 'https://music.163.com/',
  Origin: 'https://music.163.com',
  Cookie: 'appver=2.0.2; os=pc; osver=Microsoft-Windows-10; channel=netease;',
  Accept: '*/*',
};

/* ---------------- 热歌榜 ---------------- */

const CHARTS = {
  hot: { id: 3778678, name: '热歌榜' },
  new: { id: 3779629, name: '新歌榜' },
  rising: { id: 19723756, name: '飙升榜' },
};

const HOT_TTL = 2 * 60 * 60 * 1000;
let hotCache = { at: 0, songs: [], chart: '热歌榜' };

/**
 * 拉取网易云热歌榜（当前流行曲目），缓存 2 小时。
 * 拿不到时返回上一次的缓存，甚至空数组，调用方需自行降级。
 */
export async function getHotChart(limit = 100) {
  if (hotCache.songs.length >= Math.min(limit, 30) && Date.now() - hotCache.at < HOT_TTL) {
    return hotCache.songs.slice(0, limit);
  }

  const { id, name } = CHARTS.hot;
  try {
    const res = await fetch(
      `https://music.163.com/api/v6/playlist/detail?id=${id}&n=${limit}&s=0`,
      { headers: NETEASE_HEADERS, signal: AbortSignal.timeout(12000) },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const tracks = json?.playlist?.tracks || [];
    const songs = tracks
      .map((s, i) => {
        const norm = normalizeSong(s);
        return norm ? { ...norm, chartRank: i + 1, chart: name } : null;
      })
      .filter(Boolean);

    if (songs.length) {
      hotCache = { at: Date.now(), songs, chart: name };
    }
    return songs.slice(0, limit);
  } catch {
    return hotCache.songs.slice(0, limit);
  }
}

/** 供提示词使用的榜单文本 */
export function formatChartForPrompt(songs, max = 60) {
  return songs
    .slice(0, max)
    .map((s, i) => `${i + 1}. ${s.name} - ${s.artist}`)
    .join('\n');
}

/** 按 1 开始的序号从榜单里取歌 */
export function pickFromChart(songs, indexes, max = 6) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(indexes) ? indexes : []) {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > songs.length) continue;
    const song = songs[n - 1];
    if (!song || seen.has(song.id)) continue;
    seen.add(song.id);
    out.push({ ...song, keyword: '热歌榜', fallback: false });
    if (out.length >= max) break;
  }
  return out;
}

/**
 * 网易云搜「职场 汇报 焦虑」这类词时，会把讲座、课程、有声书也当歌返回。
 * 用标题关键词 + 时长做过滤：正常歌曲 45 秒到 10 分钟。
 */
const NON_MUSIC_RE =
  /(第[一二三四五六七八九十百\d]+[讲課课节集]|[讲課课]程|播客|有声书|有声剧|评书|电台|朗诵|背诵|听力|连载|讲座|公开课|脱口秀|相声|讲坛|专栏)/;

function isLikelyMusic(song) {
  const name = `${song.name} ${song.album || ''}`;
  if (NON_MUSIC_RE.test(name)) return false;
  if (song.duration > 0) {
    if (song.duration < 45 * 1000) return false;
    if (song.duration > 10 * 60 * 1000) return false;
  }
  return true;
}

function hasCJK(s) {
  return /[\u4e00-\u9fa5]/.test(String(s || ''));
}

/**
 * 网易云搜索。依次尝试多个公开端点，任一成功即返回。
 * 返回 [{ id, name, artist, album, duration, cover, playerUrl, source }]
 */
export async function searchNetease(keyword, limit = 4) {
  const attempts = [
    async () => {
      const url =
        'https://music.163.com/api/cloudsearch/pc?csrf_token=' +
        `&s=${encodeURIComponent(keyword)}&type=1&offset=0&total=true&limit=${limit * 3}`;
      const res = await fetch(url, {
        headers: NETEASE_HEADERS,
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    async () => {
      const url =
        'https://music.163.com/api/search/get/web?csrf_token=' +
        `&s=${encodeURIComponent(keyword)}&type=1&offset=0&total=true&limit=${limit * 3}`;
      const res = await fetch(url, {
        headers: NETEASE_HEADERS,
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
  ];

  for (const attempt of attempts) {
    try {
      const json = await attempt();
      const songs = json?.result?.songs;
      if (Array.isArray(songs) && songs.length) {
        const cleaned = songs
          .map(normalizeSong)
          .filter(Boolean)
          .filter(isLikelyMusic)
          // 中文歌优先：抽象关键词（成功、梦想）容易搜出日韩纯音乐合辑
          .sort((a, b) => Number(hasCJK(b.name)) - Number(hasCJK(a.name)))
          .slice(0, limit);
        if (cleaned.length) return cleaned;
      }
    } catch {
      /* 换下一个端点 */
    }
  }
  return [];
}

function normalizeSong(s) {
  if (!s || !s.id) return null;
  const id = Number(s.id);
  const artists = (s.ar || s.artists || []).map((a) => a?.name).filter(Boolean).join(' / ');
  const albumName = s.al?.name || s.album?.name || '';
  const cover = s.al?.picUrl || s.album?.picUrl || '';
  return {
    id,
    name: String(s.name || '').trim(),
    artist: artists || '未知歌手',
    album: albumName,
    duration: Number(s.dt || s.duration || 0) || 0,
    cover,
    // 网易云官方外链播放器，iframe 内嵌即可播放整首
    playerUrl: `https://music.163.com/outchain/player?type=2&id=${id}&auto=0&height=66`,
    webUrl: `https://music.163.com/song?id=${id}`,
    source: 'netease',
  };
}

/** 网易云搜不到时，用 iTunes 兜底（30 秒试听，无需 key） */
export async function searchItunes(keyword, limit = 3) {
  try {
    const url =
      'https://itunes.apple.com/search?term=' +
      `${encodeURIComponent(keyword)}&media=music&limit=${limit}&country=CN`;
    const res = await fetch(url, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return [];
    const json = await res.json();
    return (json?.results || [])
      .filter((r) => r.previewUrl)
      .map((r) => ({
        id: `itunes-${r.trackId}`,
        name: r.trackName || '',
        artist: r.artistName || '',
        album: r.collectionName || '',
        duration: r.trackTimeMillis || 0,
        cover: r.artworkUrl100 || '',
        previewUrl: r.previewUrl,
        webUrl: r.trackViewUrl || '',
        source: 'itunes',
      }));
  } catch {
    return [];
  }
}

/**
 * 按多个关键词批量搜歌，去重后返回
 */
export async function findSongs(keywords, { perKeyword = 3, total = 8 } = {}) {
  const list = (Array.isArray(keywords) ? keywords : [])
    .map((k) => String(k || '').trim())
    .filter(Boolean)
    .slice(0, 4);

  if (!list.length) return [];

  const batches = await Promise.all(
    list.map(async (kw) => {
      let songs = await searchNetease(kw, perKeyword + 1);
      let fallback = false;
      if (!songs.length) {
        songs = await searchItunes(kw, perKeyword);
        fallback = songs.length > 0;
      }
      return songs.map((s) => ({ ...s, keyword: kw, fallback }));
    }),
  );

  const seen = new Set();
  const out = [];
  // 轮转取样，保证每个关键词都有代表
  const maxLen = Math.max(...batches.map((b) => b.length), 0);
  for (let i = 0; i < maxLen && out.length < total; i++) {
    for (const batch of batches) {
      const song = batch[i];
      if (!song) continue;
      const key = `${song.name}|${song.artist}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(song);
      if (out.length >= total) break;
    }
  }
  return out;
}