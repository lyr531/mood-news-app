import { chat, parseJson, sleep } from './llm.js';
import { findSongs, getHotChart, formatChartForPrompt, pickFromChart } from './music.js';

const SYSTEM = `你是一位温暖、专业、不评判的情绪陪伴者，同时懂音乐。用户会向你描述心情，你需要：
1. 准确识别情绪，并用一句话说出你听到的感觉（让他觉得被理解，不要说"我理解你"这种套话）。
2. 给 2-3 条具体、可执行、非说教的小建议。不要喊口号，不要"加油""想开点"。
3. 从用户消息里给出的「热歌榜」中挑选最契合当前心情的歌曲，把序号填进 picks 字段（5-6 个，按契合度排序）。只能填榜单里真实存在的序号，不能编造歌名或序号。
4. 同时再给 3 个中文音乐搜索关键词作为备选，必须是**音乐风格或听感词**，形如"治愈 钢琴""深夜 民谣"。严禁出现事件名词（汇报、面试、分手、考试、工作），也严禁"成功""梦想""成就"这类抽象名词。
4. 如果语句里透露出自伤、自杀、伤害他人的倾向，必须在 "safety" 字段写 "high"，并把 reply 改为温和的求助引导，建议联系心理援助热线 12356。
5. 全程中文，语气像朋友，不要用 Markdown 标题，不要用 emoji 超过 1 个。

只输出 JSON：
{
  "emotion": "情绪名，2-4 字",
  "intensity": "low|medium|high",
  "reply": "共情与回应，60-120 字",
  "advice": ["建议1", "建议2", "建议3"],
  "keywords": ["搜索词1", "搜索词2", "搜索词3"],
  "picks": [3, 12, 27, 41, 55],
  "reason": "为什么推荐这类音乐，20-40 字",
  "safety": "none|high"
}`;

const SAFETY_RE =
  /(自杀|轻生|想死|去死|不想活|活不下去|活着没意思|结束生命|割腕|跳楼|自残|伤害自己|死了算了)/;

const HOTLINES = [
  '全国心理援助热线 12356（24 小时）',
  '北京心理危机干预中心 010-82951332',
  '如果情况紧急，请立即联系身边信任的人或拨打 120',
];

function safetyResult() {
  return {
    emotion: '痛苦',
    intensity: 'high',
    reply:
      '我听见了，你正在承受很重的东西。这句话我不想轻轻带过——你现在需要的不是一首歌，而是一个真正能回应你的人。先别一个人扛着。',
    advice: [...HOTLINES],
    keywords: [],
    reason: '',
    safety: 'high',
    degraded: false,
    degradedReason: '',
    songs: [],
  };
}

const DEFAULT_KEYWORDS = {
  焦虑: ['放松 钢琴', '白噪音 助眠'],
  紧张: ['放松 钢琴', '舒缓 轻音乐'],
  低落: ['治愈 民谣', '温柔 女声'],
  失落: ['治愈 民谣', '安静 钢琴'],
  愤怒: ['舒缓 大提琴', '平静 纯音乐'],
  愉悦: ['轻快 流行', '阳光 民谣'],
  喜悦: ['轻快 流行', '阳光 吉他'],
  兴奋: ['轻快 流行', '节奏 英文歌'],
  疲惫: ['慵懒 爵士', '午后 轻音乐'],
  孤独: ['温暖 人声', '深夜 钢琴'],
  平静: ['轻音乐 安静', '治愈 钢琴'],
};

const FALLBACK_RULES = [
  {
    test: /(焦虑|紧张|慌|压力|睡不着|失眠|担心|不安|怕)/,
    emotion: '焦虑',
    reply: '听起来你现在有点焦虑。这种感觉不需要被马上解决，先让它待一会儿也可以。我在这儿。',
    advice: ['把注意力放到呼吸上，做 4 次缓慢的深呼吸', '把担心的事写下来，只写一句也行', '喝点温水，别空腹扛着'],
    kws: ['放松 钢琴 纯音乐', '白噪音 助眠', '治愈 轻音乐'],
    reason: '节奏平缓、不抢注意力的曲子',
  },
  {
    test: /(难过|伤心|失落|崩溃|哭|委屈|低落|没意义|提不起|空落|沮丧)/,
    emotion: '低落',
    reply: '听起来你最近很沉。不用急着好起来，这种感觉本来就该被允许存在。我在这儿陪你待一会儿。',
    advice: ['允许自己什么都不做，十分钟就够', '找一个能说话的人，说三句也行', '出门走一小段路，晒点太阳'],
    kws: ['温柔 民谣', '治愈 女声', '安静 钢琴'],
    reason: '温柔不喧哗的声音，适合现在',
  },
  {
    test: /(生气|愤怒|烦|暴躁|气死|憋屈|火大|不爽)/,
    emotion: '愤怒',
    reply: '听起来你现在很憋。生气是有道理的，它通常说明有件事越过了你的边界。先不用压着。',
    advice: ['把想说的话写在纸上，不用发出去', '起身做点力气活，把劲用掉', '等心跳慢下来再做决定'],
    kws: ['舒缓 大提琴', '平静 纯音乐', '自然 声音'],
    reason: '低频率的声音能帮身体先松下来',
  },
  {
    test: /(开心|高兴|兴奋|爽|快乐|顺利|满足|幸福|不错)/,
    emotion: '愉悦',
    reply: '听得出来你现在状态不错。这种时刻值得被记住，别急着让它过去。',
    advice: ['把此刻的小事记下来，以后能翻回来', '跟让你开心的人说一句谢谢', '趁状态好，做一件一直拖着的小事'],
    kws: ['轻快 流行', '阳光 英文歌', '夏日 民谣'],
    reason: '轻快的曲子，配得上现在的心情',
  },
  {
    test: /(累|疲惫|倦|没劲|不想动|撑不住|熬)/,
    emotion: '疲惫',
    reply: '听起来你已经很累了。累不是不够努力，是身体在提要求。',
    advice: ['今晚提前半小时放下手机', '把明天的事砍掉一半', '吃点热的，别硬撑'],
    kws: ['慵懒 爵士', '午后 轻音乐', '低音 慢歌'],
    reason: '慢节奏、不费神的音乐',
  },
  {
    test: /(孤独|寂寞|没人|一个人|孤单)/,
    emotion: '孤独',
    reply: '听起来你有点孤单。一个人的时候这种感觉会格外明显，这不是你的问题。',
    advice: ['给一个很久没联系的人发条消息', '去有人的地方待一会儿，不用说话', '把房间的灯调暖一点'],
    kws: ['温暖 人声', '陪伴 民谣', '深夜 钢琴'],
    reason: '有人声的曲子，房间里会暖一些',
  },
];

export async function analyzeMood(text, { withMusic = true } = {}) {
  const userText = String(text || '').trim().slice(0, 800);
  if (!userText) throw new Error('请输入你现在的心情');

  // 高风险表述本地先兜一道，不依赖模型是否识别
  if (SAFETY_RE.test(userText)) {
    return safetyResult();
  }

  let parsed;
  let degradedReason = '';
  // 榜单有 2 小时缓存，通常无额外等待
  const chart = await getHotChart(100).catch(() => []);
  try {
    const content = await chat(
      [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: buildUserPrompt(userText, chart) },
      ],
      { temperature: 0.85, maxTokens: 1100, json: true },
    );
    parsed = parseJson(content);
  } catch (err) {
    // 没配 key 或模型挂了，都要能回话：走本地规则兜底
    parsed = localFallback(userText);
    parsed._degraded = true;
    degradedReason = err.code === 'NO_API_KEY' ? 'nokey' : 'error';
  }

  const result = {
    emotion: String(parsed.emotion || '平静').trim(),
    intensity: ['low', 'medium', 'high'].includes(parsed.intensity) ? parsed.intensity : 'medium',
    reply: String(parsed.reply || '').trim(),
    advice: Array.isArray(parsed.advice)
      ? parsed.advice.map((a) => String(a).trim()).filter(Boolean).slice(0, 3)
      : [],
    keywords: Array.isArray(parsed.keywords)
      ? parsed.keywords.map((k) => String(k).trim()).filter(Boolean).slice(0, 3)
      : [],
    reason: String(parsed.reason || '').trim(),
    safety: parsed.safety === 'high' ? 'high' : 'none',
    degraded: Boolean(parsed._degraded),
    degradedReason,
    songs: [],
  };

  if (result.safety === 'high') {
    result.advice = [
      '全国心理援助热线 12356（24 小时）',
      '北京心理危机干预中心 010-82951332',
      '如果情况紧急，请立即联系身边信任的人或拨打 120',
    ];
    result.songs = [];
    return result;
  }

  if (withMusic) {
    await resolveSongs(result, parsed, chart);
    // 网络抖动时（比如启动瞬间定时任务在抓新闻）重试一次
    if (!result.songs.length) {
      await sleep(700);
      await resolveSongs(result, parsed, chart.length ? chart : await getHotChart(60).catch(() => []));
    }
  }

  return result;
}

/** 优先从热歌榜挑歌，不足再用关键词搜索补齐 */
async function resolveSongs(result, parsed, chart) {
  const picks = pickFromChart(chart, parsed.picks, 6);
  result.songs = picks;
  if (chart.length) result.chartName = chart[0].chart || '热歌榜';

  if (result.songs.length >= 3) return;

  const kws =
    result.keywords.length > 0
      ? result.keywords
      : DEFAULT_KEYWORDS[result.emotion] || ['治愈 钢琴', '安静 民谣'];

  try {
    const searched = await findSongs(kws, { perKeyword: 3, total: 8 });
    const seen = new Set(result.songs.map((s) => s.id));
    for (const s of searched) {
      if (result.songs.length >= 6) break;
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      result.songs.push(s);
    }
  } catch {
    /* 搜索失败就只用榜单结果 */
  }
}

/** 把热歌榜拼进提问，让模型从真实榜单里选，而不是凭印象编歌名 */
function buildUserPrompt(userText, chart) {
  if (!chart.length) {
    return `我现在的心情是：${userText}`;
  }
  return `我现在的心情是：${userText}

下面是网易云音乐「热歌榜」当前的前 ${Math.min(chart.length, 60)} 首（现在真正流行的歌）：
${formatChartForPrompt(chart, 60)}

请根据你对这些歌曲风格、歌词和歌手特点的了解，挑选 5 到 6 首最契合我现在心情的，把序号填进 "picks"：
- 情绪负面时（紧张、焦虑、失落、愤怒、疲惫），选节奏舒缓、旋律温暖的；不要选比我现在更丧的歌。
- 情绪正面时（喜悦、兴奋），选节奏明快、氛围明亮的；不要选慢板伤感情歌。
- 同名歌手最多出现一次。
- 只能填榜单里真实存在的序号，不要编造歌名或序号。`;
}

function localFallback(text) {
  const hit = FALLBACK_RULES.find((r) => r.test.test(text));
  if (!hit) {
    return {
      emotion: '平静',
      intensity: 'low',
      reply: '我收到了。你说得不多，但愿意开口这件事本身就值得被认真对待。想多说一点也可以，我就先在这儿陪着。',
      advice: ['给自己倒杯水，慢慢喝完', '做三次深呼吸，把肩膀放下来', '如果愿意，写下此刻最想说的那句话'],
      keywords: ['轻音乐 安静', '治愈 钢琴', '温暖 人声'],
      reason: '轻柔的音乐适合不影响思绪的状态',
      safety: 'none',
    };
  }
  return {
    emotion: hit.emotion,
    intensity: hit.emotion === '愉悦' ? 'low' : 'medium',
    reply: hit.reply,
    advice: hit.advice,
    keywords: hit.kws,
    reason: hit.reason,
    safety: 'none',
    _degraded: true,
  };
}