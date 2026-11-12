import { config } from './config.js';
import { buildBrief, collectNews } from './news.js';
import { hasApiKey } from './config.js';
import { readNewsCache, writeNewsCache, todayKey } from './store.js';

let pending = null;

/** 生成一次快报。并发调用会复用同一个 Promise。 */
export function refreshBrief({ force = false } = {}) {
  if (pending) return pending;

  pending = (async () => {
    const cached = readNewsCache();
    if (!force && cached && cached.date === todayKey()) {
      return cached;
    }

    const { items, sourceStatus } = await collectNews();
    if (!items.length) {
      throw new Error('所有新闻源都抓取失败，请检查网络');
    }

    let payload;
    if (hasApiKey()) {
      try {
        const brief = await buildBrief(items, config.briefCount);
        payload = {
          date: todayKey(),
          generatedAt: new Date().toISOString(),
          headline: brief.headline,
          items: brief.items,
          sourceStatus,
          rawCount: items.length,
          degraded: false,
        };
      } catch (err) {
        // 模型失败 → 原始标题兜底，页面不至于空白
        payload = {
          date: todayKey(),
          generatedAt: new Date().toISOString(),
          headline: '今日要闻',
          items: items.slice(0, config.briefCount).map((it, i) => ({
            title: it.title,
            summary: it.desc || '',
            category: '其他',
            source: it.source,
            rank: i + 1,
          })),
          sourceStatus,
          rawCount: items.length,
          degraded: true,
          note: `模型整理失败：${String(err.message).slice(0, 120)}`,
        };
      }
    } else {
      payload = {
        date: todayKey(),
        generatedAt: new Date().toISOString(),
        headline: '今日要闻',
        items: items.slice(0, config.briefCount).map((it, i) => ({
          title: it.title,
          summary: it.desc || '',
          category: '其他',
          source: it.source,
          rank: i + 1,
        })),
        sourceStatus,
        rawCount: items.length,
        degraded: true,
        note: '未配置 API Key，当前为原始标题模式',
      };
    }

    writeNewsCache(payload);
    return payload;
  })().finally(() => {
    pending = null;
  });

  return pending;
}

/** 启动每日定时：到点生成 + 电脑休眠唤醒后补生成 */
export function startScheduler() {
  const run = async (reason) => {
    try {
      const data = await refreshBrief({ force: reason === 'manual' });
      console.log(`[快报] ${reason} 生成完成：${data.items?.length ?? 0} 条`);
    } catch (err) {
      console.error(`[快报] ${reason} 生成失败：${err.message}`);
    }
  };

  // 启动时：缓存不是今天的就先生成
  const cached = readNewsCache();
  if (!cached || cached.date !== todayKey()) {
    setTimeout(() => run('启动补生成'), 800);
  } else {
    console.log(`[快报] 今日缓存已存在（${cached.items?.length ?? 0} 条），跳过`);
  }

  // 每 15 分钟检查一次，跨天或休眠唤醒后自动补
  let lastDate = cached?.date || todayKey();
  setInterval(async () => {
    const now = new Date();
    const today = todayKey(now);
    if (today !== lastDate) {
      lastDate = today;
      await run('跨天');
      return;
    }
    // 今天还没生成过，且已过设定时间
    const cache = readNewsCache();
    if ((!cache || cache.date !== today) && now.getHours() >= config.briefHour) {
      lastDate = today;
      await run('到点');
    }
  }, 15 * 60 * 1000);

  console.log(
    `[定时] 每天 ${String(config.briefHour).padStart(2, '0')}:00 后自动生成快报（每 15 分钟检查）`,
  );
}