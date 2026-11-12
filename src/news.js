import { UA, config } from './config.js';
import { chat, parseJson } from './llm.js';

const SOURCE_TIMEOUT = 12000;

async function getJson(url, extraHeaders = {}) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      ...extraHeaders,
    },
    signal: AbortSignal.timeout(SOURCE_TIMEOUT),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function getText(url, extraHeaders = {}) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Accept: 'application/rss+xml, application/xml, text/xml, */*',
      ...extraHeaders,
    },
    signal: AbortSignal.timeout(SOURCE_TIMEOUT),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/* ---------------- 各个新闻源 ---------------- */

async function fetchBaiduHot() {
  const json = await getJson('https://top.baidu.com/api/board?platform=wise&tab=realtime', {
    Referer: 'https://top.baidu.com/board?tab=realtime',
  });
  // 百度返回结构会变，递归找出所有带 word 的条目
  const out = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (typeof node.word === 'string' && node.word.trim()) {
      out.push({
        title: node.word.trim(),
        desc: node.desc ? String(node.desc).trim() : '',
        hot: Number(node.hotScore) || 0,
        source: '百度热搜',
        url:
          node.url ||
          node.rawUrl ||
          `https://www.baidu.com/s?wd=${encodeURIComponent(node.word)}`,
      });
      return;
    }
    if (node.content) walk(node.content);
  };
  walk(json?.data?.cards);
  return out;
}

async function fetchWeiboHot() {
  const json = await getJson('https://weibo.com/ajax/side/hotSearch', {
    Referer: 'https://weibo.com/',
  });
  const list = json?.data?.realtime ?? [];
  return list
    .filter((x) => x && x.word && !x.is_ad)
    .map((x) => ({
      title: String(x.word).trim(),
      desc: x.note ? String(x.note).trim() : '',
      hot: Number(x.num) || 0,
      source: '微博热搜',
      url: `https://s.weibo.com/weibo?q=${encodeURIComponent('#' + x.word + '#')}`,
    }));
}

/** 极简 RSS 解析：只取 item 的 title/link/description/pubDate */
function parseRss(xml) {
  const items = [];
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || [];
  for (const block of blocks) {
    const pick = (tag) => {
      const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i');
      const m = block.match(re);
      if (!m) return '';
      return stripCdata(m[1]).trim();
    };
    const title = pick('title');
    if (!title) continue;
    items.push({
      title,
      url: pick('link'),
      desc: stripTags(pick('description')).slice(0, 200),
      pubDate: pick('pubDate') || pick('pubdate'),
      source: '',
    });
  }
  return items;
}

function stripCdata(s) {
  return String(s)
    .replace(/^<!\[CDATA\[/, '')
    .replace(/\]\]>$/, '');
}

function stripTags(s) {
  // 先解 HTML 实体，再剥标签：RSS 里常见 &lt;p&gt; 这种转义标签，
  // 若先剥标签会漏掉，解码后反而变成真标签露在页面上
  let t = String(s || '');
  t = t
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/gi, '&');
  return t
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchRss(url, sourceName, limit = 12) {
  const xml = await getText(url, { Referer: new URL(url).origin });
  return parseRss(xml)
    .slice(0, limit)
    .map((it) => ({ ...it, source: sourceName }));
}

const SOURCES = [
  { name: '百度热搜', run: fetchBaiduHot, weight: 3 },
  { name: '微博热搜', run: fetchWeiboHot, weight: 3 },
  {
    name: '中新网',
    run: () => fetchRss('https://www.chinanews.com.cn/rss/scroll-news.xml', '中新网', 20),
    weight: 2,
  },
  {
    name: '人民网',
    run: () => fetchRss('http://www.people.com.cn/rss/politics.xml', '人民网', 20),
    weight: 2,
  },
  {
    name: 'IT之家',
    run: () => fetchRss('https://www.ithome.com/rss/', 'IT之家', 15),
    weight: 2,
  },
  {
    name: '少数派',
    run: () => fetchRss('https://sspai.com/feed', '少数派', 10),
    weight: 1,
  },
];

/** 抓取全部新闻源，单源失败不影响整体 */
export async function collectNews() {
  const results = await Promise.allSettled(SOURCES.map((s) => s.run()));
  const items = [];
  const sourceStatus = [];

  results.forEach((r, i) => {
    const name = SOURCES[i].name;
    if (r.status === 'fulfilled') {
      const list = r.value || [];
      sourceStatus.push({ name, ok: true, count: list.length });
      items.push(...list);
    } else {
      sourceStatus.push({ name, ok: false, error: String(r.reason?.message || r.reason) });
    }
  });

  // 丢弃明显过期的条目（部分 RSS 里混着几个月前的旧稿）
  const cutoff = Date.now() - 4 * 24 * 3600 * 1000;
  const fresh = items.filter((it) => {
    if (!it.pubDate) return true;
    const t = Date.parse(it.pubDate);
    if (Number.isNaN(t)) return true;
    return t > cutoff;
  });

  return { items: dedupe(fresh), sourceStatus };
}

function dedupe(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const key = normalizeTitle(it.title);
    if (!key || key.length < 4) continue;
    if (seen.has(key)) continue;
    // 子串重复也算重复（热搜标题常被截断）
    let dup = false;
    for (const k of seen) {
      if (k.length >= 6 && (k.includes(key) || key.includes(k))) {
        dup = true;
        break;
      }
    }
    if (dup) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

function normalizeTitle(t) {
  return String(t || '')
    .replace(/[\s\u3000]+/g, '')
    .replace(/[【】\[\]「」《》"'’“”]/g, '');
}

/* ---------------- 用大模型生成「事实快报」 ---------------- */

const briefSystemPrompt = (count) => `你是一名严谨的中文新闻编辑。你的任务是把杂乱的网络热搜标题，整理成一份「今日事实快报」。

要求：
1. 只保留有明确事实信息的事件，剔除广告、纯情绪宣泄、标题党、八卦猜测、无法核实的内容。
2. 每条用一句客观陈述句描述发生了什么，不超过 45 字，不要加评论、不要用感叹号。
3. category 只能从这些里选：时政、经济、科技、社会、国际、文体、民生、其他。
4. 如果原始标题信息量不足，就依据标题本身能确定的事实来写，绝不编造数字、人名、时间。
5. 按重要性排序，最重要的放最前面。
6. 必须覆盖不同来源和领域：同一 category 最多 2 条，同一 source 最多 4 条。宁可换一条没那么热但有价值的，也不要十条全来自同一个平台。
7. 含义模糊、看不出到底发生了什么的热搜（例如口号式、诗意化、只有名词堆砌的），直接跳过，不要收进快报。
8. summary 只能写标题中已有的硬信息（数字、机构、时间、地点、直接后果），**严禁推测和评价**：不要出现"标志着""助力""展现…实力""体现…水平""进一步提升""引发广泛关注"这类套话。没有可补充的内容就写空字符串。
9. headline 只讲最核心的一件事，20 字以内，不要用逗号并列多件事，不要写成宣传语。
10. 尽量凑满 ${count} 条；不足时宁缺勿滥。

只输出 JSON，格式：
{"headline":"今天最核心的一件事，20字以内","items":[{"title":"事实陈述","summary":"硬信息补充或空字符串","category":"科技","source":"微博热搜"}]}`;

/** 按来源轮流取样，避免某个平台霸榜 */
function interleaveBySource(items) {
  const groups = new Map();
  for (const it of items) {
    const key = it.source || '其他';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  }
  const buckets = [...groups.values()];
  const out = [];
  let idx = 0;
  while (out.length < items.length) {
    let added = false;
    for (const b of buckets) {
      if (idx < b.length) {
        out.push(b[idx]);
        added = true;
      }
    }
    if (!added) break;
    idx++;
  }
  return out;
}

/** 促销稿、带货文，不属于「事实快报」 */
const AD_RE =
  /(破冰|新低|到手价|限时|直降|秒杀|优惠|券后|仅售|包邮|预售|抢购|折上折|满减|领券|大促|补贴后)/;

export async function buildBrief(rawItems, count = 10) {
  const pool = interleaveBySource(rawItems.filter((it) => !AD_RE.test(it.title)))
    .slice(0, 60)
    .map((it, i) => `${i + 1}. [${it.source}] ${it.title}${it.desc ? ' —— ' + it.desc : ''}`)
    .join('\n');

  const userPrompt = `下面是今天从各平台抓到的热搜与新闻标题（共 ${Math.min(rawItems.length, 60)} 条），请整理成 ${count} 条事实快报：

${pool}`;

  const content = await chat(
    [
      { role: 'system', content: briefSystemPrompt(count) },
      { role: 'user', content: userPrompt },
    ],
    { temperature: 0.3, maxTokens: 2000, json: true },
  );

  const data = parseJson(content);
  const raw = Array.isArray(data?.items) ? data.items : [];
  if (!raw.length) throw new Error('模型未返回有效条目');

  const cleaned = raw
    .map((it) => ({
      title: String(it?.title || '').trim(),
      summary: String(it?.summary || '').trim(),
      category: String(it?.category || '其他').trim(),
      source: String(it?.source || '综合').trim(),
    }))
    .filter((it) => it.title)
    // 模型可能自己重复输出同一条，按标题去重
    .filter((() => {
      const seen = [];
      return (it) => {
        if (seen.some((t) => t === it.title || similarity(t, it.title) > 0.92)) return false;
        seen.push(it.title);
        return true;
      };
    })())
    // summary 与 title 重复的，直接清空
    .map((it) => ({ ...it, summary: sameText(it.summary, it.title) ? '' : it.summary }))
    // 摘要太薄时，用原始来源的描述补上；最后统一润色（去电头、控长度）
    .map((it) => {
      const src = it.summary && it.summary.length >= 10 ? it.summary : pickRawDesc(it.title, rawItems) || it.summary;
      return { ...it, summary: polishSummary(src, it.title) };
    });

  const items = enforceDiversity(cleaned, count).map((it) => ({
    ...it,
    url: findRawUrl(it.title, rawItems),
  }));
  const headline = await makeHeadline(items).catch(() => items[0]?.title || '');

  return {
    headline,
    items: items.map((it, idx) => ({ ...it, rank: idx + 1 })),
  };
}

function sameText(a, b) {
  const norm = (s) => String(s || '').replace(/[\s\u3000\u3001-\u303f，。！？；：""''（）()《》]/g, '');
  const x = norm(a);
  if (!x) return true;
  return x === norm(b) || similarity(a, b) > 0.8;
}

/** 摘要太短时，回到原始数据里找该条的来源描述 */
function pickRawDesc(title, rawItems) {
  const { match, score } = findRawMatch(title, rawItems, (it) => Boolean(it.desc));
  if (!match || score < 0.5) return '';
  return stripTags(match.desc).slice(0, 200);
}

/** 回填原文链接；实在匹配不上就退化成搜索页 */
function findRawUrl(title, rawItems) {
  const { match, score } = findRawMatch(title, rawItems, (it) => Boolean(it.url));
  if (match?.url && score >= 0.42) return match.url;
  return `https://www.baidu.com/s?wd=${encodeURIComponent(title)}`;
}

function findRawMatch(title, rawItems, predicate = () => true) {
  let best = null;
  let bestScore = 0;
  for (const it of rawItems) {
    if (!predicate(it)) continue;
    const score = similarity(it.title, title);
    if (score > bestScore) {
      bestScore = score;
      best = it;
    }
  }
  return { match: best, score: bestScore };
}

/** 摘要润色：去掉通讯社电头、截到句子边界、控制长度 */
function polishSummary(text, title) {
  let t = stripTags(text);
  if (!t) return '';

  // 去掉「新华社北京11月12日电(记者某某)」「IT之家 11 月 12 日消息」这类电头
  t = t
    .replace(/^(新华社|中新社|人民网|央视新闻|IT之家|快科技)[^。！？]{0,30}?电[（(][^）)]*[）)]?[，,、]?\s*/u, '')
    .replace(/^(IT之家|快科技|少数派)\s*\d+\s*月\s*\d+\s*日消息[，,、]?\s*/u, '')
    .replace(/^(记者|编辑)[^，,。]{0,10}[，,]\s*/u, '')
    .trim();

  if (!t) return '';

  // 取第一句
  const firstSentence = t.split(/(?<=[。！？])/u)[0] || t;
  let out = firstSentence.trim();

  if (out.length > 52) {
    const cut = out.slice(0, 52);
    const lastPunct = Math.max(
      cut.lastIndexOf('，'),
      cut.lastIndexOf('、'),
      cut.lastIndexOf('；'),
    );
    out = (lastPunct > 20 ? cut.slice(0, lastPunct) : cut) + '…';
  }

  if (sameText(out, title)) return '';
  return out;
}

/** 二元组 Jaccard 相似度，用来识别「换汤不换药」的摘要 */
function similarity(a, b) {
  const grams = (s) => {
    const t = String(s || '').replace(/[\s\u3000\u3001-\u303f，。！？；：""''（）()《》]/g, '');
    const set = new Set();
    for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2));
    return set;
  };
  const A = grams(a);
  const B = grams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return inter / Math.max(A.size, B.size);
}

/** 代码层面强制来源与分类均衡，不完全依赖模型的自觉 */
function enforceDiversity(items, count) {
  for (const [maxCat, maxSrc] of [
    [2, 4],
    [3, 5],
    [4, 6],
    [99, 99],
  ]) {
    const catCount = new Map();
    const srcCount = new Map();
    const kept = [];
    for (const it of items) {
      if (kept.length >= count) break;
      const c = catCount.get(it.category) || 0;
      const s = srcCount.get(it.source) || 0;
      if (c >= maxCat || s >= maxSrc) continue;
      catCount.set(it.category, c + 1);
      srcCount.set(it.source, s + 1);
      kept.push(it);
    }
    if (kept.length >= Math.min(count, 8)) return kept;
  }
  return items.slice(0, count);
}

/** 单独生成导语：一件事、一句话。模型不合格就退回首条标题，保证不会出现并列式长句 */
async function makeHeadline(items) {
  if (!items.length) return '';
  const fallback = cleanHeadline(items[0].title);
  const list = items.map((it, i) => `${i + 1}. ${it.title}`).join('\n');
  try {
    const text = await chat(
      [
        {
          role: 'system',
          content:
            '你是新闻编辑。给下面这组今日快报写一句导语：只讲最重要的一件事，20 字以内，一个逗号都不要用，不要口号，不要感叹号。只输出这一句话，不要解释。',
        },
        { role: 'user', content: list },
      ],
      { temperature: 0.2, maxTokens: 60 },
    );
    const line = String(text)
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)[0] || '';
    const cleaned = cleanHeadline(line);
    return isValidHeadline(cleaned) ? cleaned : fallback;
  } catch {
    return fallback;
  }
}

function cleanHeadline(s) {
  return String(s || '')
    .replace(/^["'“”「」『』]|["'“”「」『』]$/g, '')
    .replace(/[。！!]+$/, '')
    .trim();
}

function isValidHeadline(s) {
  if (!s) return false;
  if (s.length > 24) return false;
  if (/[，,]/.test(s)) return false;
  if ((s.match(/、/g) || []).length >= 2) return false;
  // 列举式尾巴，典型失败形态
  if (/等[。]?$/.test(s)) return false;
  return true;
}

export { config };