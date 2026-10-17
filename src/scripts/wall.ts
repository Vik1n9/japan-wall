// 展覽牆的互動：短片自動播放、牆面／閱讀模式、橫向捲動、平面圖、展品說明卡。
// 由 prototype/index.html 移植。

export interface Media {
  id: string;
  type: 'photo' | 'video';
  title: string;
  place: string;
  note: string;
  date: string;
  time: string | null;
  src: string;
  poster: string | null;
  width: number;
  height: number;
  duration: string | null;
  source: string | null;
  /** 動態內容（/api/public/wall 注入）：friend＝親友照片、ema＝繪馬 */
  dyn?: 'friend' | 'ema';
  by?: string;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const MEDIA: Media[] = JSON.parse($('wall-data').textContent || '[]');
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
const smooth: ScrollBehavior = reduce ? 'auto' : 'smooth';
const body = document.body;
const sc = $('scroller');
const wall = $('wall');
const map = $('map');
const isRead = () => body.classList.contains('read');

/* 短片：只在畫面內時播放 */
if ('IntersectionObserver' in window && !reduce) {
  const vo = new IntersectionObserver(
    (entries) => entries.forEach(({ target, isIntersecting }) => {
      const v = target as HTMLVideoElement;
      if (isIntersecting) v.play().catch(() => {});
      else v.pause();
    }),
    { threshold: 0.35 },
  );
  document.querySelectorAll<HTMLVideoElement>('video[data-auto]').forEach((v) => vo.observe(v));
}

/* 牆面／閱讀模式 */
const btnW = $('m-wall'), btnR = $('m-read');
function setMode(mode: 'wall' | 'read') {
  body.classList.toggle('read', mode === 'read');
  btnW.setAttribute('aria-pressed', String(mode !== 'read'));
  btnR.setAttribute('aria-pressed', String(mode === 'read'));
  try { localStorage.setItem('wall-mode', mode); } catch {}
  fit();
}
btnW.onclick = () => setMode('wall');
btnR.onclick = () => setMode('read');
try { if (localStorage.getItem('wall-mode') === 'read') setMode('read'); } catch {}

/* 橫向捲動 */
$('pl').onclick = () => sc.scrollBy({ left: -sc.clientWidth * 0.8, behavior: smooth });
$('pr').onclick = () => sc.scrollBy({ left: sc.clientWidth * 0.8, behavior: smooth });
sc.addEventListener('wheel', (e) => {
  if (isRead() || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
  const max = sc.scrollWidth - sc.clientWidth;
  if ((e.deltaY < 0 && sc.scrollLeft <= 0) || (e.deltaY > 0 && sc.scrollLeft >= max - 1)) return;
  e.preventDefault();
  sc.scrollLeft += e.deltaY;
}, { passive: false });

/* 牆面模式整面牆收進視窗高度：滾輪被轉成橫向移動，牆底（屋簷、石垣、平面圖）
   必須一屏看得完，所以量測頁面高度後用 --wall-scale 等比縮小牆面內容 */
function fitWall() {
  if (isRead()) { wall.style.removeProperty('--wall-scale'); return; }
  const setS = (s: number) => { wall.style.setProperty('--wall-scale', String(s)); return wall.offsetHeight; };
  const de = document.documentElement;
  const h1 = setS(1);
  const chrome = de.scrollHeight - h1; // 頂欄、地板、平面圖、捲軸等不隨 scale 變的高度
  const avail = window.innerHeight - chrome - 1; // 留 1px 餘裕，避免無意義的垂直捲動
  if (h1 > avail) {
    const h0 = setS(0.8);
    const slope = (h1 - h0) / 0.2 || 1; // 牆高對 scale 大致線性（plate 高度隨欄寬等比）
    let s = Math.min(1, Math.max(0.5, 1 + (avail - h1) / slope));
    const h = setS(s);
    if (Math.abs(h - avail) > 4) setS(Math.min(1, Math.max(0.5, s + (avail - h) / slope)));
  }
}
let fitQueued = false;
function fit() {
  if (fitQueued) return;
  fitQueued = true;
  requestAnimationFrame(() => { fitQueued = false; fitWall(); buildMap(); });
}

/* 平面圖 */
function buildMap() {
  if (isRead()) return;
  const W = wall.scrollWidth;
  if (!W) return;
  const segs: [HTMLElement, string, boolean][] = [
    [$('prelude'), '序', false],
    ...[...document.querySelectorAll<HTMLElement>('.era')].map((s): [HTMLElement, string, boolean] => [s, s.dataset.label || '', !s.classList.contains('pending')]),
    [$('finale'), '終', false],
  ];
  map.innerHTML = segs
    .map(([el, label, live]) => `<div class="sg${live ? ' live' : ''}" style="left:${(el.offsetLeft / W) * 100}%;width:${(el.offsetWidth / W) * 100}%">${label}</div>`)
    .join('') + '<div class="vp" id="vp"></div>';
  syncViewport();
}
function syncViewport() {
  const vp = document.getElementById('vp');
  if (!vp) return;
  const W = sc.scrollWidth;
  vp.style.left = `${(sc.scrollLeft / W) * 100}%`;
  vp.style.width = `${Math.min(100, (sc.clientWidth / W) * 100)}%`;
}
sc.addEventListener('scroll', syncViewport, { passive: true });
function jump(e: PointerEvent) {
  const r = map.getBoundingClientRect();
  const x = (e.clientX - r.left) / r.width;
  sc.scrollTo({ left: x * sc.scrollWidth - sc.clientWidth / 2, behavior: e.type === 'pointerdown' ? smooth : 'auto' });
}
let dragging = false;
map.addEventListener('pointerdown', (e) => { dragging = true; try { map.setPointerCapture(e.pointerId); } catch {} jump(e); });
map.addEventListener('pointermove', (e) => { if (dragging) jump(e); });
map.addEventListener('pointerup', () => (dragging = false));
map.addEventListener('pointercancel', () => (dragging = false));
addEventListener('resize', fit);
addEventListener('load', fit);
document.fonts?.ready.then(fit);
fit();

/* 展品說明卡 */
const lb = $('lb');
let cur = 0;
let lastFocus: HTMLElement | null = null;
const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六'];
const fmtDate = (d: string) => d.replaceAll('-', '.');
function show(i: number) {
  cur = (i + MEDIA.length) % MEDIA.length;
  const m = MEDIA[cur];
  const holder = $('lb-media');
  holder.replaceChildren();
  const wd = WEEKDAY[new Date(`${m.date}T00:00:00Z`).getUTCDay()];
  if (m.dyn === 'ema') {
    holder.append(lbEmaBoard(m));
    $('lb-no').textContent = m.id;
    $('lb-title').textContent = '繪馬';
    $('lb-place').textContent = `${fmtDate(m.date)}（${wd}）`;
    $('lb-medium').textContent = `繪馬 · ${m.by || '無署名'}`;
    $('lb-p').textContent = '';
  } else {
    if (m.type === 'video') {
      const v = document.createElement('video');
      Object.assign(v, { src: m.src, controls: true, muted: true, loop: true, playsInline: true, autoplay: !reduce });
      if (m.poster) v.poster = m.poster;
      holder.append(v);
    } else {
      const img = document.createElement('img');
      img.src = m.src;
      img.alt = m.title;
      holder.append(img);
    }
    $('lb-no').textContent = m.id;
    $('lb-title').textContent = m.title;
    $('lb-place').textContent = m.dyn === 'friend'
      ? `${m.place} · ${fmtDate(m.date)}（${wd}）`
      : `${m.place} · ${fmtDate(m.date)}（${wd}）${m.time ? ' ' + m.time : ' · 時刻待補'}`;
    $('lb-medium').textContent = m.dyn === 'friend'
      ? `親友照片 · ${m.width}×${m.height}`
      : m.type === 'video'
        ? `短片 · ${m.duration ?? ''} · 已去除聲音${m.source ? ' · ' + m.source : ''}`
        : `照片 · ${m.width}×${m.height}`;
    $('lb-p').textContent = m.dyn === 'friend' ? '' : m.note;
  }
  renderComments(m.id);
  $('lb-count').textContent = `${cur + 1} / ${MEDIA.length}`;
}
function open(i: number) {
  lastFocus = document.activeElement as HTMLElement | null;
  show(i);
  lb.hidden = false;
  body.style.overflow = 'hidden';
  $('lb-x').focus();
}
function close() {
  lb.hidden = true;
  $('lb-media').replaceChildren();
  body.style.overflow = '';
  lastFocus?.focus();
}
wall.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('.it-media');
  if (b) open(Number(b.dataset.i));
});
$('lb-x').onclick = close;
$('lb-prev').onclick = () => show(cur - 1);
$('lb-next').onclick = () => show(cur + 1);
lb.addEventListener('click', (e) => { if (e.target === lb) close(); });
addEventListener('keydown', (e) => {
  if (lb.hidden) return;
  if (e.key === 'Escape') close();
  if (e.key === 'ArrowLeft') show(cur - 1);
  if (e.key === 'ArrowRight') show(cur + 1);
});

/* ---------- 動態內容：親友照片／繪馬／留言（/api/public/wall，前後台同源皆可用） ----------
   注入原則：DOM 結構照抄舊版收稿制的產出（.col.ema-rack、.it-ema、.ofuda），
   樣式全部沿用 wall.css 既有規則；注入完重建 MEDIA 瀏覽順序（照牆上 DOM 順序）並重算 fit/map。 */

type PubPhoto = {
  id: string; authorName: string; day: string; caption: string;
  key: string; mime: string; width: number; height: number; createdAt: string;
};
type PubPost = {
  id: string; kind: string; target: string; replyTo: string | null; by: string;
  body: string; postedAt: string;
};

const FRIENDS_PER_COL = 3; // 每欄三張：欄自然高（≈756px）不超過展品欄，才不會拉低整面牆的 --wall-scale；第四張起往右加欄（橫向擴充）
const COMMENTS: PubPost[] = [];
const dynMedia = new Map<string, Media>();

function tiltOf(id: string): number {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return ((Math.abs(h) % 5) - 2) * 0.8;
}

function friendButton(p: PubPhoto): HTMLElement {
  const b = document.createElement('button');
  b.className = 'it it-media it-friend';
  b.dataset.friend = p.id;
  b.setAttribute('aria-label', `檢視親友照片（${p.authorName}）`);
  const ph = document.createElement('span');
  ph.className = 'ph';
  const img = document.createElement('img');
  img.loading = 'lazy';
  img.decoding = 'async';
  img.src = `/api/media/${p.key}`;
  img.alt = p.caption || `${p.authorName} 的親友照片`;
  ph.append(img);
  const cap = document.createElement('span');
  cap.className = 'cap';
  const bb = document.createElement('b');
  const g = document.createElement('span');
  g.className = 'g';
  g.textContent = '■';
  bb.append(g, ` ${p.authorName}`);
  cap.append(bb, p.caption);
  b.append(ph, cap);
  return b;
}

function emaButton(p: PubPost, commentCount: number): HTMLElement {
  const b = document.createElement('button');
  b.className = 'it it-media it-ema in-rack';
  b.dataset.emaId = p.id;
  b.style.setProperty('--tilt', `${tiltOf(p.id)}deg`);
  b.setAttribute('aria-label', `檢視繪馬（${p.by || '無署名'}）`);
  const frame = document.createElement('span');
  frame.className = 'ema-frame';
  const cord = document.createElement('span');
  cord.className = 'ema-cord';
  const board = document.createElement('span');
  board.className = 'ema-board';
  const hole = document.createElement('span');
  hole.className = 'ema-hole';
  const bodyEl = document.createElement('span');
  bodyEl.className = 'ema-body';
  bodyEl.textContent = p.body;
  const foot = document.createElement('span');
  foot.className = 'ema-foot';
  if (commentCount > 0) {
    const of = document.createElement('span');
    of.className = 'ofuda';
    of.setAttribute('aria-label', `${commentCount} 則留言`);
    of.textContent = `籤 ${commentCount}`;
    foot.append(of);
  }
  const byEl = document.createElement('span');
  byEl.className = 'ema-by';
  byEl.textContent = p.by || '無署名';
  foot.append(byEl);
  board.append(hole, bodyEl, foot);
  frame.append(cord, board);
  b.append(frame);
  return b;
}

function lbEmaBoard(m: Media): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'lb-ema';
  const board = document.createElement('span');
  board.className = 'ema-board';
  const hole = document.createElement('span');
  hole.className = 'ema-hole';
  const bodyEl = document.createElement('span');
  bodyEl.className = 'ema-body';
  bodyEl.textContent = m.note;
  const foot = document.createElement('span');
  foot.className = 'ema-foot';
  const byEl = document.createElement('span');
  byEl.className = 'ema-by';
  byEl.textContent = m.by || '無署名';
  foot.append(byEl);
  board.append(hole, bodyEl, foot);
  wrap.append(board);
  return wrap;
}

/* 說明卡底的留言討論串（展品與繪馬皆有；replyTo 縮排接在-parent 後面） */
function renderComments(targetId: string): void {
  const box = $('lb-cmts');
  const list = COMMENTS.filter((c) => c.target === targetId);
  box.textContent = '';
  if (list.length === 0) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const h = document.createElement('h4');
  h.textContent = `留言 ${list.length}`;
  box.append(h);
  const repliesOf = (pid: string) => list.filter((c) => c.replyTo === pid);
  const render = (c: PubPost, depth: number): void => {
    const div = document.createElement('div');
    div.className = depth > 0 ? 'cmt reply' : 'cmt';
    const head = document.createElement('div');
    head.className = 'cmt-head';
    head.textContent = `${c.by || '無署名'} · ${c.postedAt.slice(0, 10)}`;
    const bodyEl = document.createElement('div');
    bodyEl.className = 'cmt-body';
    bodyEl.textContent = c.body;
    div.append(head, bodyEl);
    box.append(div);
    for (const r of repliesOf(c.id)) render(r, depth + 1);
  };
  // 頂層＝沒有 replyTo，或 replyTo 指向已不存在/不在本串的留言（孤兒回覆當頂層顯示，不讓內容消失）
  for (const c of list.filter((x) => !x.replyTo || !list.some((y) => y.id === x.replyTo))) render(c, 0);
}

function injectDynamic(photos: PubPhoto[], posts: PubPost[]): void {
  const comments = posts.filter((p) => p.kind === 'comment');
  COMMENTS.push(...comments);
  const countFor = (target: string) => comments.filter((c) => c.target === target).length;

  /* 親友照片：依天分組，每天 0..n 個 240px 欄掛在該天最右 */
  const photosByDay = new Map<string, PubPhoto[]>();
  for (const p of photos) {
    const arr = photosByDay.get(p.day) ?? [];
    arr.push(p);
    photosByDay.set(p.day, arr);
  }
  for (const [day, list] of photosByDay) {
    const cols = document.querySelector(`.day[data-date="${day}"] .cols`);
    if (!cols) continue;
    for (let i = 0; i < list.length; i += FRIENDS_PER_COL) {
      const col = document.createElement('div');
      col.className = 'col col-friends';
      col.style.setProperty('--colw', '240px'); // 要有單位：.col 寬度是 calc(var(--colw) * var(--wall-scale))
      const rail = document.createElement('div');
      rail.className = 'f-rail';
      const railTxt = document.createElement('span');
      railTxt.textContent = '親友照片';
      rail.append(railTxt);
      const fl = document.createElement('div');
      fl.className = 'f-list';
      for (const p of list.slice(i, i + FRIENDS_PER_COL)) {
        dynMedia.set(p.id, {
          id: p.id, type: 'photo', dyn: 'friend', title: p.caption || '親友照片',
          place: p.authorName, note: p.caption, date: p.day, time: null,
          src: `/api/media/${p.key}`, poster: null, width: p.width, height: p.height,
          duration: null, source: null,
        });
        fl.append(friendButton(p));
      }
      col.append(rail, fl);
      cols.append(col);
    }
  }

  /* 繪馬：依天分組，每天一個「繪馬掛所」rack 欄 */
  const emaByDay = new Map<string, PubPost[]>();
  for (const p of posts) {
    if (p.kind !== 'ema') continue;
    const arr = emaByDay.get(p.target) ?? [];
    arr.push(p);
    emaByDay.set(p.target, arr);
  }
  for (const [day, list] of emaByDay) {
    const cols = document.querySelector(`.day[data-date="${day}"] .cols`);
    if (!cols) continue;
    const col = document.createElement('div');
    col.className = 'col ema-rack';
    col.style.setProperty('--colw', '200px');
    const rail = document.createElement('div');
    rail.className = 'ema-rail';
    const railTxt = document.createElement('span');
    railTxt.textContent = '繪馬掛所';
    rail.append(railTxt);
    const el = document.createElement('div');
    el.className = 'ema-list';
    for (const p of list) {
      dynMedia.set(p.id, {
        id: p.id, type: 'photo', dyn: 'ema', title: `繪馬 · ${p.by || '無署名'}`,
        place: p.by || '無署名', note: p.body, date: p.target, time: null, src: '',
        poster: null, width: 0, height: 0, duration: null, source: null, by: p.by,
      });
      el.append(emaButton(p, countFor(p.id)));
    }
    col.append(rail, el);
    cols.append(col);
  }

  /* 展品說明卡按讚…不是，是展品 cap 上的留言籤 */
  const perTarget = new Map<string, number>();
  for (const c of comments) perTarget.set(c.target, (perTarget.get(c.target) ?? 0) + 1);
  for (const [id, n] of perTarget) {
    const cap = document.querySelector(`.it-media[data-exhibit-id="${id}"] .cap`);
    if (cap && !cap.querySelector('.ofuda')) {
      const of = document.createElement('span');
      of.className = 'ofuda';
      of.setAttribute('aria-label', `${n} 則留言`);
      of.textContent = `籤 ${n}`;
      cap.append(of);
    }
  }
}

/* 瀏覽順序（← →）照牆上 DOM 順序重建：展品＋注入的親友照片/繪馬混排 */
function rebuildMediaOrder(): void {
  const exhibits = new Map(MEDIA.map((m) => [m.id, m]));
  const next: Media[] = [];
  wall.querySelectorAll<HTMLElement>('.it-media').forEach((el) => {
    const id = el.dataset.exhibitId || el.dataset.friend || el.dataset.emaId;
    const item = id ? (exhibits.get(id) ?? dynMedia.get(id)) : undefined;
    if (!item) return;
    el.dataset.i = String(next.length);
    next.push(item);
  });
  MEDIA.length = 0;
  MEDIA.push(...next);
}

void (async () => {
  try {
    const res = await fetch('/api/public/wall');
    if (!res.ok) return;
    const data = (await res.json()) as { photos: PubPhoto[]; posts: PubPost[] };
    if (data.photos.length === 0 && data.posts.length === 0) return;
    injectDynamic(data.photos, data.posts);
    rebuildMediaOrder();
    fit(); // 牆變寬/變高：重算 --wall-scale、平面圖、屋簷小動物
  } catch {
    /* 公開端點不可用就維持靜態牆 */
  }
})();
