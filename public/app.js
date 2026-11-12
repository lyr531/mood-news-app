const $ = (sel) => document.querySelector(sel);

const state = {
  news: null,
  songs: [],
  activeSong: -1,
};

/* ---------------- 工具 ---------------- */

function toast(msg, ms = 2600) {
  let el = $('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.remove('show'), ms);
}

function setPill(text, kind) {
  const el = $('#statusPill');
  el.textContent = text;
  el.className = 'pill ' + (kind === 'ok' ? 'pill-ok' : kind === 'warn' ? 'pill-warn' : 'pill-muted');
}

function todayLabel() {
  const d = new Date();
  const w = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
  $('#todayLabel').textContent = `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${w}`;
}

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/* ---------------- 新闻 ---------------- */

async function loadNews(force = false) {
  const btn = $('#refreshBtn');
  btn.disabled = true;
  btn.textContent = force ? '刷新中…' : '加载中…';

  try {
    const res = await fetch('/api/news' + (force ? '?refresh=1' : ''));
    if (res.status === 401) {
      showLock();
      return;
    }
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '加载失败');
    state.news = data;
    renderNews(data);
    setPill(data.degraded ? '降级模式' : '已就绪', data.degraded ? 'warn' : 'ok');
  } catch (err) {
    setPill('离线', 'warn');
    const hasData = Boolean(state.news?.items?.length);
    if (hasData && force) {
      // 已有内容时刷新失败，保留旧列表，只做轻提示
      toast('刷新失败：' + err.message);
      $('#newsUpdated').textContent = '刷新失败，仍显示上次结果';
    } else {
      $('#newsUpdated').textContent = '新闻加载失败：' + err.message;
      $('#newsList').innerHTML =
        '<li class="muted" style="padding:16px 0">抓取失败，可能是网络问题或新闻源暂时不可用。稍后点右上角「刷新」再试。</li>';
    }
  } finally {
    btn.disabled = false;
    btn.textContent = '刷新';
  }
}

function renderNews(data) {
  const items = data.items || [];
  $('#newsCount').textContent = items.length ? `${items.length} 条` : '—';
  $('#newsHeadline').textContent = data.headline || '';

  const list = $('#newsList');
  list.innerHTML = '';

  if (!items.length) {
    list.innerHTML = '<li class="muted" style="padding:16px 0">今天还没有生成快报。</li>';
  }

  items.forEach((it, i) => {
    const li = document.createElement('li');
    li.className = 'news-item';
    li.style.animationDelay = Math.min(i * 40, 400) + 'ms';

    const body = document.createElement('div');
    body.className = 'news-body';

    const title = document.createElement('a');
    title.className = 'news-title';
    title.href = it.url || `https://www.baidu.com/s?wd=${encodeURIComponent(it.title)}`;
    title.target = '_blank';
    title.rel = 'noopener noreferrer';
    title.textContent = it.title;
    title.title = '点击查看来源原文';
    body.appendChild(title);

    if (it.summary) {
      const sum = document.createElement('p');
      sum.className = 'news-summary';
      sum.textContent = it.summary;
      body.appendChild(sum);
    }

    const meta = document.createElement('div');
    meta.className = 'news-meta';

    if (it.category) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = it.category;
      meta.appendChild(tag);
    }

    if (it.source) {
      const src = document.createElement('span');
      src.className = 'source';
      src.textContent = it.source;
      meta.appendChild(src);
    }

    body.appendChild(meta);
    li.appendChild(body);
    list.appendChild(li);
  });

  const when = fmtTime(data.generatedAt);
  const note = data.degraded ? `（${data.note || '降级模式'}）` : '';
  $('#newsUpdated').textContent = when
    ? `更新于 ${when}${note}`
    : '暂无更新记录';
}

/* ---------------- 心情 ---------------- */

async function submitMood() {
  const text = $('#moodInput').value.trim();
  if (!text) {
    toast('先说说你现在的心情吧');
    $('#moodInput').focus();
    return;
  }

  const btn = $('#moodBtn');
  const hint = $('#moodHint');
  btn.disabled = true;
  hint.innerHTML = '<span class="spinner"></span>正在听你说…';

  try {
    const res = await fetch('/api/mood', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (res.status === 401) {
      hint.textContent = '';
      showLock('会话已过期，请重新输入口令');
      return;
    }
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '出错了');
    renderMood(data);
    hint.textContent = '';
  } catch (err) {
    hint.textContent = '';
    toast(err.message || '出错了，稍后再试');
  } finally {
    btn.disabled = false;
  }
}

function renderMood(data) {
  const box = $('#moodResult');
  box.classList.remove('hidden');
  box.innerHTML = '';
  state.songs = data.songs || [];
  state.activeSong = -1;

  /* 情绪 + 回应 */
  const row = document.createElement('div');
  row.className = 'emotion-row';

  const name = document.createElement('span');
  name.className = 'emotion-name';
  name.textContent = data.emotion || '平静';
  row.appendChild(name);

  const intensityMap = { low: '轻微', medium: '中等', high: '强烈' };
  const inten = document.createElement('span');
  inten.className = 'intensity';
  inten.textContent = (intensityMap[data.intensity] || '') + '强度';
  row.appendChild(inten);
  box.appendChild(row);

  const reply = document.createElement('p');
  reply.className = 'reply';
  reply.textContent = data.reply || '';
  box.appendChild(reply);

  /* 安全提示优先 */
  if (data.safety === 'high') {
    const safe = document.createElement('div');
    safe.className = 'safety-box';
    safe.innerHTML =
      '<strong>我想先陪你停一下。</strong><br>你刚才说的让我有些担心，这种时候最需要的是有人真的在你身边。<br>';
    const ul = document.createElement('ul');
    ul.className = 'advice-list';
    (data.advice || []).forEach((a) => {
      const li = document.createElement('li');
      li.textContent = a;
      ul.appendChild(li);
    });
    safe.appendChild(ul);
    box.appendChild(safe);
    box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    return;
  }

  /* 建议 */
  if (data.advice && data.advice.length) {
    const label = document.createElement('div');
    label.className = 'section-label';
    label.textContent = '可以试试';
    box.appendChild(label);

    const ul = document.createElement('ul');
    ul.className = 'advice-list';
    data.advice.forEach((a) => {
      const li = document.createElement('li');
      li.textContent = a;
      ul.appendChild(li);
    });
    box.appendChild(ul);
  }

  /* 音乐 */
  if (state.songs.length) {
    const label = document.createElement('div');
    label.className = 'section-label';
    label.textContent = data.reason ? `为你选的歌 · ${data.reason}` : '为你选的歌';
    box.appendChild(label);

    const shell = document.createElement('div');
    shell.className = 'player-shell';
    shell.id = 'playerShell';
    shell.innerHTML = '<span class="player-empty">选一首歌开始播放</span>';
    box.appendChild(shell);

    const ol = document.createElement('ul');
    ol.className = 'song-list';
    state.songs.forEach((song, i) => ol.appendChild(songRow(song, i)));
    box.appendChild(ol);
  }

  if (data.degraded) {
    const n = document.createElement('div');
    n.className = 'degraded-note';
    n.textContent =
      data.degradedReason === 'nokey'
        ? '未配置智谱 API Key：当前由本地规则回应。填好 .env 里的 ZHIPU_API_KEY 并重启，即可换成模型生成的个性化回复。'
        : '模型暂时不可用，以上为本地规则生成的回应。';
    box.appendChild(n);
  }

  box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function songRow(song, i) {
  const li = document.createElement('li');
  li.className = 'song';
  li.dataset.index = i;
  li.addEventListener('click', () => playSong(i));

  const idx = document.createElement('span');
  idx.className = 'song-index';
  idx.textContent = i + 1;
  li.appendChild(idx);

  const info = document.createElement('div');
  info.className = 'song-info';

  const nm = document.createElement('div');
  nm.className = 'song-name';
  nm.textContent = song.name;
  info.appendChild(nm);

  const ar = document.createElement('div');
  ar.className = 'song-artist';
  const rank = song.chartRank ? `热歌榜 #${song.chartRank} · ` : '';
  ar.textContent = rank + song.artist + (song.album ? ` · ${song.album}` : '');
  info.appendChild(ar);

  li.appendChild(info);

  const mark = document.createElement('span');
  mark.className = 'play-mark';
  mark.textContent = '♪';
  li.appendChild(mark);

  return li;
}

function playSong(i) {
  const song = state.songs[i];
  if (!song) return;

  document.querySelectorAll('.song').forEach((el) => {
    el.classList.toggle('active', Number(el.dataset.index) === i);
  });

  const shell = $('#playerShell');
  if (!shell) return;
  shell.innerHTML = '';

  if (song.source === 'netease' && song.playerUrl) {
    const iframe = document.createElement('iframe');
    iframe.src = song.playerUrl.replace('auto=0', 'auto=1');
    iframe.setAttribute('frameborder', '0');
    iframe.setAttribute('allow', 'autoplay');
    iframe.setAttribute('loading', 'lazy');
    shell.appendChild(iframe);
  } else if (song.previewUrl) {
    const audio = document.createElement('audio');
    audio.controls = true;
    audio.autoplay = true;
    audio.src = song.previewUrl;
    shell.appendChild(audio);
  } else {
    shell.innerHTML = '<span class="player-empty">这首歌暂时不能直接播放</span>';
  }
}

/* ---------------- 初始化 ---------------- */

function bindChips() {
  document.querySelectorAll('.chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      $('#moodInput').value = chip.dataset.text || '';
      $('#moodInput').focus();
    });
  });
}

/* ---------------- 访问口令 ---------------- */

function showLock(message = '') {
  const el = $('#lockScreen');
  if (!el) return;
  el.classList.remove('hidden');
  const err = $('#lockError');
  if (err) err.textContent = message;
  setTimeout(() => $('#lockInput')?.focus(), 60);
}

function hideLock() {
  $('#lockScreen')?.classList.add('hidden');
}

async function submitLock(e) {
  e.preventDefault();
  const input = $('#lockInput');
  const btn = $('#lockBtn');
  const err = $('#lockError');
  const token = (input?.value || '').trim();
  if (!token) return;

  btn.disabled = true;
  err.textContent = '';
  try {
    const res = await fetch('/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    if (!res.ok) {
      err.textContent = '口令不对，再试一次';
      input.value = '';
      input.focus();
      return;
    }
    hideLock();
    input.value = '';
    await init();
  } catch {
    err.textContent = '网络异常，稍后重试';
  } finally {
    btn.disabled = false;
  }
}

/* ---------------- 初始化 ---------------- */

async function init() {
  todayLabel();
  bindChips();
  if (!state.bound) {
    state.bound = true;
    $('#refreshBtn').addEventListener('click', () => loadNews(true));
    $('#moodBtn').addEventListener('click', submitMood);
    $('#moodInput').addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') submitMood();
    });
  }
  await loadNews(false);
}

async function boot() {
  $('#lockForm')?.addEventListener('submit', submitLock);

  try {
    const res = await fetch('/api/status');
    if (res.status === 401) {
      showLock();
      return;
    }
  } catch {
    /* 网络问题交给 loadNews 提示 */
  }

  hideLock();
  await init();
}

boot();