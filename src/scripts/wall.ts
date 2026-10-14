// 展覽牆的互動：短片自動播放、牆面／閱讀模式、橫向捲動、平面圖、展品說明卡。
// 由 prototype/index.html 移植。

interface Media {
  id: string; type: 'photo' | 'video'; title: string; place: string; note: string;
  date: string; time: string | null; src: string; poster: string | null;
  width: number; height: number; duration: string | null; source: string | null;
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
  requestAnimationFrame(buildMap);
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
addEventListener('resize', buildMap);
addEventListener('load', buildMap);
document.fonts?.ready.then(buildMap);
buildMap();

/* 展品說明卡 */
const lb = $('lb');
let cur = 0;
let lastFocus: HTMLElement | null = null;
const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六'];
function show(i: number) {
  cur = (i + MEDIA.length) % MEDIA.length;
  const m = MEDIA[cur];
  const holder = $('lb-media');
  holder.replaceChildren();
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
  const wd = WEEKDAY[new Date(`${m.date}T00:00:00Z`).getUTCDay()];
  $('lb-no').textContent = m.id;
  $('lb-title').textContent = m.title;
  $('lb-place').textContent = `${m.place} · ${m.date.replaceAll('-', '.')}（${wd}）${m.time ? ' ' + m.time : ' · 時刻待補'}`;
  $('lb-medium').textContent = m.type === 'video'
    ? `短片 · ${m.duration ?? ''} · 已去除聲音${m.source ? ' · ' + m.source : ''}`
    : `照片 · ${m.width}×${m.height}`;
  $('lb-p').textContent = m.note;
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
