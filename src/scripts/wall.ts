// 展覽牆的互動：短片自動播放、牆面／閱讀模式、橫向捲動、平面圖、展品說明卡。
// 由 prototype/index.html 移植。

export interface NoteComment {
  id: string;
  target: string;
  replyTo: string | null;
  by: string;
  body: string;
  posted: string;
  status?: 'pending' | 'published' | 'rejected';
  mine?: boolean;
}

export interface Media {
  id: string;
  type: 'photo' | 'video' | 'ema';
  title: string;
  by?: string;
  place: string;
  note: string;
  date: string;
  time: string | null;
  posted?: string | null;
  tilt?: number;
  src: string;
  poster: string | null;
  width: number;
  height: number;
  duration: string | null;
  source: string | null;
  status?: 'pending' | 'published' | 'rejected';
  mine?: boolean;
  comments?: NoteComment[];
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
export const MEDIA: Media[] = JSON.parse($('wall-data').textContent || '[]');
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
  requestAnimationFrame(() => { fitQueued = false; fitWall(); buildMap(); placeCritters(); });
}

/* 屋簷上的小動物：每隔一個視窗寬放一組，牆面模式滑到哪一屏都看得到一組、同一屏最多一組。
   第一組放在天守閣右邊；組合照 trip.yaml 的順序輪替，部分左右翻轉增加變化。視窗大小改變時重排 */
function placeCritters() {
  const box = document.getElementById('critters');
  if (!box) return;
  box.textContent = '';
  if (isRead()) return;
  const groups: { src: string; h: number }[] = JSON.parse(box.dataset.groups || '[]');
  if (!groups.length) return;
  const W = sc.clientWidth;
  const total = wall.scrollWidth;
  const wl = wall.getBoundingClientRect().left;
  const castle = wall.querySelector<HTMLElement>('.castle');
  let x = castle ? castle.getBoundingClientRect().right - wl + 24 : W * 0.4;
  for (let k = 0; x < total - 160; k++, x += W) {
    const g = groups[k % groups.length];
    const img = document.createElement('img');
    img.src = g.src;
    img.alt = '';
    img.decoding = 'async';
    img.style.left = `${Math.round(x)}px`;
    img.style.setProperty('--h', `${g.h}px`);
    if (k % 3 === 1) img.classList.add('flip');
    box.append(img);
  }
}

/* 平面圖 */
export function buildMap() {
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
let onShowHook: ((m: Media, index: number) => void) | null = null;
export const getCur = () => cur;
export const setOnShow = (fn: (m: Media, index: number) => void) => {
  onShowHook = fn;
};
const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六'];
export function show(i: number) {
  cur = (i + MEDIA.length) % MEDIA.length;
  const m = MEDIA[cur];
  const holder = $('lb-media');
  holder.replaceChildren();
  const wd = WEEKDAY[new Date(`${m.date}T00:00:00Z`).getUTCDay()];
  if (m.type === 'ema') {
    const stage = document.createElement('div');
    stage.className = 'lb-ema-stage';
    const frame = document.createElement('div');
    frame.className = 'ema-frame lb-ema';
    if (m.status === 'pending') frame.classList.add('is-pending');
    if (m.status === 'rejected') frame.classList.add('is-rejected');
    frame.style.setProperty('--tilt', `${m.tilt ?? 0}deg`);
    const cord = document.createElement('span');
    cord.className = 'ema-cord';
    const board = document.createElement('div');
    board.className = 'ema-board';
    const hole = document.createElement('span');
    hole.className = 'ema-hole';
    const bodyEl = document.createElement('div');
    bodyEl.className = 'ema-body';
    bodyEl.textContent = m.note;
    const foot = document.createElement('div');
    foot.className = 'ema-foot';
    if (m.status === 'pending' || m.status === 'rejected') {
      const badge = document.createElement('em');
      badge.className = `st-badge ${m.status}`;
      badge.textContent = m.status === 'pending' ? '待展出' : '未展出';
      foot.append(badge);
    }
    const byEl = document.createElement('span');
    byEl.className = 'ema-by';
    byEl.textContent = m.by || '無署名';
    foot.append(byEl);
    board.append(hole, bodyEl, foot);
    frame.append(cord, board);
    stage.append(frame);
    holder.append(stage);

    $('lb-no').textContent = m.id;
    $('lb-title').textContent = m.title;
    $('lb-place').textContent = `${m.place ? m.place + ' · ' : ''}${m.date.replaceAll('-', '.')}（${wd}）`;
    const postedDate = (m.posted || m.date).slice(0, 10).replaceAll('-', '.');
    const stText = m.status === 'pending' ? ' · 待展出' : m.status === 'rejected' ? ' · 未展出' : '';
    $('lb-medium').textContent = `繪馬 · 投稿於 ${postedDate}${stText}`;
    $('lb-p').textContent = m.note;
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
    $('lb-place').textContent = `${m.place} · ${m.date.replaceAll('-', '.')}（${wd}）${m.time ? ' ' + m.time : ' · 時刻待補'}`;
    $('lb-medium').textContent = m.type === 'video'
      ? `短片 · ${m.duration ?? ''} · 已去除聲音${m.source ? ' · ' + m.source : ''}`
      : `照片 · ${m.width}×${m.height}`;
    $('lb-p').textContent = m.note;
  }

  const notesBox = $('lb-notes');
  notesBox.replaceChildren();
  const comments = m.comments ?? [];
  if (comments.length > 0) {
    notesBox.hidden = false;
    const hd = document.createElement('div');
    hd.className = 'lb-notes-hd';
    hd.textContent = `留言 · ${comments.length}`;
    const list = document.createElement('div');
    list.className = 'lb-notes-list';
    const byId = new Map(comments.map((c) => [c.id, c]));
    for (const c of comments) {
      const item = document.createElement('div');
      item.className = 'lb-note';
      if (c.status === 'pending') item.classList.add('is-pending');
      if (c.status === 'rejected') item.classList.add('is-rejected');
      item.id = `lb-c-${c.id}`;
      item.dataset.cid = c.id;
      if (c.replyTo) {
        const parent = byId.get(c.replyTo);
        if (parent) {
          const ref = document.createElement('button');
          ref.type = 'button';
          ref.className = 'lb-reply-ref';
          const flat = parent.body.replace(/\s+/g, ' ').trim();
          const snippet = flat.slice(0, 20) + (flat.length > 20 ? '…' : '');
          ref.textContent = `回覆 ${parent.by || '無署名'}：${snippet}`;
          ref.onclick = () => {
            const targetEl = document.getElementById(`lb-c-${parent.id}`);
            if (targetEl) {
              targetEl.scrollIntoView({ behavior: smooth, block: 'nearest' });
              targetEl.classList.remove('flash');
              void targetEl.offsetWidth;
              targetEl.classList.add('flash');
            }
          };
          item.append(ref);
        }
      }
      const meta = document.createElement('div');
      meta.className = 'lb-note-meta';
      const authorWrap = document.createElement('div');
      authorWrap.className = 'lb-note-who';
      const author = document.createElement('strong');
      author.textContent = c.by || '無署名';
      authorWrap.append(author);
      if (c.status === 'pending' || c.status === 'rejected') {
        const badge = document.createElement('em');
        badge.className = `st-badge ${c.status}`;
        badge.textContent = c.status === 'pending' ? '待展出' : '未展出';
        authorWrap.append(badge);
      }
      const date = document.createElement('span');
      date.className = 'lb-note-date';
      date.textContent = c.posted.slice(0, 10).replaceAll('-', '.');
      meta.append(authorWrap, date);
      const bodyP = document.createElement('p');
      bodyP.className = 'lb-note-body';
      bodyP.textContent = c.body;
      item.append(meta, bodyP);
      list.append(item);
    }
    notesBox.append(hd, list);
  } else {
    notesBox.hidden = true;
  }

  $('lb-count').textContent = `${cur + 1} / ${MEDIA.length}`;
  onShowHook?.(m, cur);
}
export function open(i: number) {
  lastFocus = document.activeElement as HTMLElement | null;
  show(i);
  lb.hidden = false;
  body.style.overflow = 'hidden';
  $('lb-x').focus();
}
export function close() {
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
