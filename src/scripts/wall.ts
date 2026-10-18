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
  /** 動態內容（/api/public/wall 注入）：photo＝大家上傳的照片、ema＝繪馬 */
  dyn?: 'photo' | 'ema';
  by?: string;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const MEDIA: Media[] = JSON.parse($('wall-data').textContent || '[]');
// 靜態展品（建置時產生）；動態內容重新載入時拿它重建瀏覽順序，不會沿用舊的動態項目
const STATIC_MEDIA = new Map(MEDIA.map((m) => [m.id, m]));
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
/** 上傳照片欄的高度規則：不得高過全牆最高的策展展品欄（以 scale 1 量），牆高與 --wall-scale 只由展品決定。
 *  太高就依照片比例把該欄縮窄（240px → 最窄 PHOTO_COLW_MIN），畫框等比縮、圖說高度不變，量三輪收斂 */
const PHOTO_COLW = 240;
const PHOTO_COLW_MIN = 120;
/** 欄的內容高度：欄在牆面模式會被撐滿牆高，offsetHeight 量不到內容本身 */
function contentHeight(col: HTMLElement): number {
  const last = col.lastElementChild;
  return last ? last.getBoundingClientRect().bottom - col.getBoundingClientRect().top : 0;
}
function fitPhotoCols(): void {
  const cols = [...wall.querySelectorAll<HTMLElement>('.col-photos')];
  if (!cols.length) return;
  const ref = Math.max(0, ...[...wall.querySelectorAll<HTMLElement>('.cols > .col:not(.col-photos):not(.ema-rack)')].map(contentHeight));
  for (const col of cols) {
    let w = PHOTO_COLW;
    col.style.setProperty('--colw', `${w}px`);
    for (let k = 0; k < 3 && ref > 0 && contentHeight(col) > ref && w > PHOTO_COLW_MIN; k++) {
      const plates = [...col.querySelectorAll<HTMLElement>('.plate')].reduce((a, el) => a + el.offsetHeight, 0);
      const fixed = contentHeight(col) - plates;
      if (plates <= 0) break;
      w = Math.max(PHOTO_COLW_MIN, Math.floor((w * (ref - fixed)) / plates));
      col.style.setProperty('--colw', `${w}px`);
    }
  }
}

function fitWall() {
  if (isRead()) { wall.style.removeProperty('--wall-scale'); return; }
  const setS = (s: number) => { wall.style.setProperty('--wall-scale', String(s)); return wall.offsetHeight; };
  const de = document.documentElement;
  setS(1);
  fitPhotoCols();
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
    // 上傳的照片：place 放上傳者名字（展品沒有拍攝者，place 是地點）
    $('lb-place').textContent = `${m.place} · ${fmtDate(m.date)}（${wd}）${m.time ? ' ' + m.time : ' · 時刻待補'}`;
    $('lb-medium').textContent = m.type === 'video'
      ? `短片 · ${m.duration ?? ''} · 已去除聲音${m.source ? ' · ' + m.source : ''}`
      : `照片 · ${m.width}×${m.height}`;
    $('lb-p').textContent = m.dyn === 'photo' ? '' : m.note;
  }
  renderComments(m.id);
  $('lb-count').textContent = `${cur + 1} / ${MEDIA.length}`;
  // 編輯模式（edit.ts）靠這個事件在說明卡裡掛留言／回覆表單；前台沒人聽，無作用
  const kind = m.dyn === 'ema' ? 'ema' : m.dyn === 'photo' ? 'photo' : 'exhibit';
  window.dispatchEvent(new CustomEvent('wall:lightbox', { detail: { id: m.id, kind } }));
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
  // 在說明卡裡打字（編輯模式的留言框）時，左右鍵是移動游標，不是換下一件
  const typing = (e.target as HTMLElement | null)?.closest('input, textarea, select');
  if (e.key === 'Escape') close();
  if (typing) return;
  if (e.key === 'ArrowLeft') show(cur - 1);
  if (e.key === 'ArrowRight') show(cur + 1);
});

/* ---------- 動態內容：上傳的照片／繪馬／留言（/api/public/wall，前後台同源皆可用） ----------
   注入原則：DOM 結構照抄舊版收稿制的產出（.col.ema-rack、.it-ema、.ofuda），
   樣式全部沿用 wall.css 既有規則；注入完重建 MEDIA 瀏覽順序（照牆上 DOM 順序）並重算 fit/map。 */

type PubPhoto = {
  id: string; authorName: string; day: string; caption: string;
  key: string; mime: string; width: number; height: number; takenAt: string | null; createdAt: string;
};
type PubPost = {
  id: string; kind: string; target: string; replyTo: string | null; by: string;
  body: string; postedAt: string;
};

const PER_COL = 2; // 照片與繪馬每欄最多兩個，跟展品欄一致（Viking 定的版面統一）；再多就往右加欄（橫向擴充）
const COMMENTS: PubPost[] = [];
const dynMedia = new Map<string, Media>();

function tiltOf(id: string): number {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return ((Math.abs(h) % 5) - 2) * 0.8;
}

/** 上傳的照片：外觀與展品相同（畫框＋圖說），圖說標上傳者名字 */
function photoButton(p: PubPhoto): HTMLElement {
  const b = document.createElement('button');
  b.className = 'it it-media it-photo';
  b.dataset.photoId = p.id;
  b.setAttribute('aria-label', `查看照片 ${p.caption || p.authorName}`);
  const fig = document.createElement('figure');
  fig.className = 'plate';
  fig.style.aspectRatio = `${p.width}/${p.height}`;
  const img = document.createElement('img');
  img.loading = 'lazy';
  img.decoding = 'async';
  img.src = `/api/media/${p.key}`;
  img.width = p.width;
  img.height = p.height;
  img.alt = p.caption || `${p.authorName} 的照片`;
  fig.append(img);
  const cap = document.createElement('span');
  cap.className = 'cap';
  const bb = document.createElement('b');
  const g = document.createElement('span');
  g.className = 'g';
  g.textContent = '■';
  bb.append(g, ` ${p.authorName}`);
  cap.append(bb, p.caption);
  b.append(fig, cap);
  return b;
}

/** "HH:MM" 或 30 小時制 "24:10" → 分鐘數 */
function minutesOf(t: string | null | undefined): number | null {
  const m = t?.match(/^(\d{1,2}):(\d{2})/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** EXIF 拍攝時刻 → 掛的那天的時刻（隔天 0:00–5:59 記成 30 小時制 24:00–29:59）；不在那天範圍就當作沒有。
 *  同一天的凌晨照實際時刻（DAY 1 出發前的機場照就是這樣，與 JP-01-01 相同） */
function dayTimeOf(takenAt: string | null, day: string): string | null {
  const m = takenAt?.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, date, hh, mm] = m;
  if (date === day) return `${hh}:${mm}`;
  const next = new Date(`${day}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  if (date === next.toISOString().slice(0, 10) && Number(hh) < 6) return `${Number(hh) + 24}:${mm}`;
  return null;
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
    div.dataset.cid = c.id;
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

/** 拿掉上一次注入的動態內容（重新載入前用） */
function clearDynamic(): void {
  wall.querySelectorAll('.col-photos, .ema-rack, .ofuda').forEach((el) => el.remove());
  COMMENTS.length = 0;
  dynMedia.clear();
}

function injectDynamic(photos: PubPhoto[], posts: PubPost[]): void {
  const comments = posts.filter((p) => p.kind === 'comment');
  COMMENTS.push(...comments);
  const countFor = (target: string) => comments.filter((c) => c.target === target).length;

  /* 上傳的照片：依拍攝時刻插進當天的展品欄之間（與展品混排）。
     插在「第一個最早時刻晚於它的展品欄」前面；讀不到時刻的照片接在當天最後（依上傳時間）。
     展品欄是人工策展，不拆開；照片另開欄插入，每欄最多 PER_COL 張，欄寬依高度規則（fitPhotoCols）調整 */
  const photosByDay = new Map<string, PubPhoto[]>();
  for (const p of photos) {
    const arr = photosByDay.get(p.day) ?? [];
    arr.push(p);
    photosByDay.set(p.day, arr);
  }
  for (const [day, list] of photosByDay) {
    const cols = document.querySelector<HTMLElement>(`.day[data-date="${day}"] .cols`);
    if (!cols) continue;
    const exhibitCols = [...cols.querySelectorAll<HTMLElement>(':scope > .col')];
    const colStart = exhibitCols.map((col) => {
      const ts = [...col.querySelectorAll<HTMLElement>('[data-exhibit-id]')]
        .map((el) => minutesOf(STATIC_MEDIA.get(el.dataset.exhibitId!)?.time))
        .filter((t): t is number => t !== null);
      return ts.length ? Math.min(...ts) : null;
    });
    const items = list.map((p) => ({ p, time: dayTimeOf(p.takenAt, day) }));
    items.sort((a, b) => {
      const ta = minutesOf(a.time), tb = minutesOf(b.time);
      if (ta !== null && tb !== null && ta !== tb) return ta - tb;
      if (ta === null && tb !== null) return 1;
      if (ta !== null && tb === null) return -1;
      return a.p.createdAt.localeCompare(b.p.createdAt) || a.p.id.localeCompare(b.p.id);
    });
    // 每張照片要插在哪一欄之前（exhibitCols.length＝當天最後）
    const groups = new Map<number, typeof items>();
    for (const it of items) {
      const t = minutesOf(it.time);
      let at = exhibitCols.length;
      if (t !== null) {
        const i = colStart.findIndex((s0) => s0 !== null && s0 > t);
        if (i >= 0) at = i;
      }
      const g = groups.get(at) ?? [];
      g.push(it);
      groups.set(at, g);
    }
    for (const [at, group] of groups) {
      const before = exhibitCols[at] ?? null;
      for (let i = 0; i < group.length; i += PER_COL) {
        const col = document.createElement('div');
        col.className = 'col col-photos';
        col.style.setProperty('--colw', `${PHOTO_COLW}px`); // 要有單位：.col 寬度是 calc(var(--colw) * var(--wall-scale))；fitPhotoCols 會再依高度調窄
        for (const { p, time } of group.slice(i, i + PER_COL)) {
          dynMedia.set(p.id, {
            id: p.id, type: 'photo', dyn: 'photo', title: p.caption || `${p.authorName} 的照片`,
            place: p.authorName, note: p.caption, date: p.day, time,
            src: `/api/media/${p.key}`, poster: null, width: p.width, height: p.height,
            duration: null, source: null,
          });
          col.append(photoButton(p));
        }
        cols.insertBefore(col, before);
      }
    }
  }

  /* 繪馬：依天分組，掛在當天最後的「繪馬掛所」，每欄最多 PER_COL 塊，多的往右加欄（每欄都有掛所橫桿） */
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
    for (let i = 0; i < list.length; i += PER_COL) {
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
      for (const p of list.slice(i, i + PER_COL)) {
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
  }

  /* 展品與照片 cap 上的留言籤 */
  const perTarget = new Map<string, number>();
  for (const c of comments) perTarget.set(c.target, (perTarget.get(c.target) ?? 0) + 1);
  for (const [id, n] of perTarget) {
    const cap = document.querySelector(`.it-media[data-exhibit-id="${id}"] .cap, .it-media[data-photo-id="${id}"] .cap`);
    if (cap && !cap.querySelector('.ofuda')) {
      const of = document.createElement('span');
      of.className = 'ofuda';
      of.setAttribute('aria-label', `${n} 則留言`);
      of.textContent = `籤 ${n}`;
      cap.append(of);
    }
  }
}

/* 瀏覽順序（← →）照牆上 DOM 順序重建：展品＋注入的照片/繪馬混排 */
function rebuildMediaOrder(): void {
  const exhibits = STATIC_MEDIA;
  const next: Media[] = [];
  wall.querySelectorAll<HTMLElement>('.it-media').forEach((el) => {
    const id = el.dataset.exhibitId || el.dataset.photoId || el.dataset.emaId;
    const item = id ? (exhibits.get(id) ?? dynMedia.get(id)) : undefined;
    if (!item) return;
    el.dataset.i = String(next.length);
    next.push(item);
  });
  MEDIA.length = 0;
  MEDIA.push(...next);
}

/** 載入（或重新載入）動態內容。fresh＝略過瀏覽器快取（編輯模式送出後用） */
async function loadDynamic(fresh = false): Promise<void> {
  try {
    const res = await fetch('/api/public/wall', fresh ? { cache: 'no-store' } : undefined);
    if (!res.ok) return;
    const data = (await res.json()) as { photos: PubPhoto[]; posts: PubPost[] };
    const openId = lb.hidden ? null : MEDIA[cur]?.id; // 說明卡開著：重新載入後留在同一件
    clearDynamic();
    if (data.photos.length || data.posts.length) injectDynamic(data.photos, data.posts);
    rebuildMediaOrder();
    fit(); // 牆變寬/變高：重算 --wall-scale、平面圖
    if (openId) {
      const i = MEDIA.findIndex((m) => m.id === openId);
      if (i >= 0) show(i);
      else close(); // 正在看的那件被刪了
    }
  } catch {
    /* 公開端點不可用就維持靜態牆 */
  }
}
void loadDynamic();
// 編輯模式（edit.ts）新增／修改／刪除後通知重新載入
window.addEventListener('wall:refresh', () => void loadDynamic(true));
