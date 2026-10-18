// /edit 編輯模式 client 邏輯：登入遮罩、浮動工具列、變更密碼、上傳照片（canvas 縮圖）、我的照片管理。
// 上傳隱私第一層：這裡先 canvas 重編碼（長邊 ≤2048、JPEG ~85%），EXIF/GPS 自然消失；
// server（worker/lib/images.ts）還會再剝一次 metadata 防繞過。
// 重編碼前只讀出 EXIF 的拍攝時刻（DateTimeOriginal）一起送出，牆上依它排序；GPS 等其他欄位不讀不送。

type Me = { username: string; displayName: string; role: string; mustChangePw: boolean };
type Photo = {
  id: string; author: string; authorName: string; day: string; caption: string;
  key: string; mime: string; width: number; height: number; takenAt: string | null; createdAt: string; mine: boolean;
};
type Post = {
  id: string; kind: string; target: string; replyTo: string | null; by: string;
  body: string; author: string; postedAt: string; mine: boolean;
};

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

let me: Me | null = null;

/** 所有 API 呼叫走這裡：網路斷線不丟例外；401＝登入過期（回登入遮罩）；403 mustChangePw＝強制改密碼 */
async function api(path: string, init?: RequestInit): Promise<{ status: number; data: Record<string, unknown> }> {
  let res: Response;
  try {
    res = await fetch(path, {
      headers: init?.body instanceof FormData ? undefined : { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      ...init,
    });
  } catch {
    return { status: 0, data: { error: '網路連線失敗，請稍後再試' } };
  }
  let data: Record<string, unknown> = {};
  try { data = await res.json(); } catch { /* 非 JSON */ }
  if (res.status === 401 && me && path !== '/api/login') {
    me = null;
    setView();
    $('em-login-err').textContent = '登入已過期，請重新登入';
  } else if (res.status === 403 && data.mustChangePw && me) {
    me.mustChangePw = true;
    openPw(true);
  }
  return { status: res.status, data };
}

/** 通知牆面重新載入動態內容（wall.ts 監聽），新增／修改／刪除後馬上看得到 */
function refreshWall(): void {
  window.dispatchEvent(new Event('wall:refresh'));
}

/** 刪除鍵兩段式確認：第一次按變成「確定刪除？」，4 秒內再按才執行（不用 confirm 對話框） */
function armDelete(btn: HTMLButtonElement, run: () => Promise<void>): void {
  let timer = 0;
  const label = btn.textContent || '刪除';
  btn.addEventListener('click', async () => {
    if (!btn.classList.contains('armed')) {
      btn.classList.add('armed');
      btn.textContent = '確定刪除？';
      timer = window.setTimeout(() => { btn.classList.remove('armed'); btn.textContent = label; }, 4000);
      return;
    }
    clearTimeout(timer);
    btn.disabled = true;
    await run();
    btn.disabled = false;
    btn.classList.remove('armed');
    btn.textContent = label;
  });
}

function opsError(host: HTMLElement): HTMLParagraphElement {
  let el = host.querySelector<HTMLParagraphElement>('.ops-err');
  if (!el) {
    el = document.createElement('p');
    el.className = 'ops-err';
    el.setAttribute('role', 'alert');
    host.append(el);
  }
  return el;
}

function setView(): void {
  const logged = me !== null;
  $('edit-mask').hidden = logged;
  $('edit-bar').hidden = !logged;
  if (logged && me) {
    $('em-who').textContent = me.displayName;
    $('em-admin').hidden = me.role !== 'admin';
    if (me.mustChangePw) openPw(true);
    void loadMyPhotos();
    void loadMyPosts();
    const byInput = ($('post-form') as HTMLFormElement).by as HTMLInputElement;
    if (!byInput.value) byInput.value = me.displayName;
  } else {
    $('edit-drawer').hidden = true;
    const f = document.getElementById('lb-cmt-form');
    if (f) f.hidden = true;
  }
}

/* ---------- 登入遮罩 ---------- */

$('em-login').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target as HTMLFormElement;
  const btn = form.querySelector('button[type=submit]') as HTMLButtonElement;
  btn.disabled = true;
  $('em-login-err').textContent = '';
  const { status, data } = await api('/api/login', {
    method: 'POST',
    body: JSON.stringify({ username: form.username.value, password: form.password.value }),
  });
  btn.disabled = false;
  if (status !== 200) {
    $('em-login-err').textContent = (data.error as string) || '登入失敗';
    return;
  }
  me = data.me as Me;
  form.reset();
  setView();
});

/* ---------- 工具列 ---------- */

$('em-logout').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST', body: '{}' });
  me = null;
  setView();
});

$('em-admin').addEventListener('click', () => { location.href = '/admin'; });

function openPw(forced: boolean): void {
  $('em-pw-title').textContent = forced ? '請先變更密碼' : '變更密碼';
  $('em-pw-hint').hidden = !forced;
  $('em-pw-cancel').hidden = forced; // 強制變更不給取消
  $('em-pw-err').textContent = '';
  $('edit-pw').hidden = false;
}
$('em-pw').addEventListener('click', () => openPw(false));
$('em-pw-cancel').addEventListener('click', () => {
  if (!me?.mustChangePw) $('edit-pw').hidden = true;
});

$('em-pw-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target as HTMLFormElement;
  $('em-pw-err').textContent = '';
  const { status, data } = await api('/api/change-password', {
    method: 'POST',
    body: JSON.stringify({
      currentPassword: form.currentPassword.value,
      newPassword: form.newPassword.value,
    }),
  });
  if (status !== 200) {
    $('em-pw-err').textContent = (data.error as string) || '變更失敗';
    return;
  }
  form.reset();
  $('edit-pw').hidden = true;
  if (me) me.mustChangePw = false;
});

/* ---------- 上傳抽屜 ---------- */

const days: { date: string; label: string }[] = (() => {
  try {
    return JSON.parse($('edit-days').textContent || '[]');
  } catch {
    return [];
  }
})();
for (const d of days) {
  const opt = document.createElement('option');
  opt.value = d.date;
  opt.textContent = `${d.label}（${d.date}）`;
  $('up-day').append(opt);
}

$('em-uploads').addEventListener('click', () => {
  $('edit-drawer').hidden = !$('edit-drawer').hidden;
});
$('ed-close').addEventListener('click', () => { $('edit-drawer').hidden = true; });

/** 從 JPEG 的 EXIF 讀拍攝時刻（DateTimeOriginal，當地時間），回傳 YYYY-MM-DDTHH:MM:SS；讀不到回 null。
 *  只解析 APP1 → IFD0 → Exif IFD 的 0x9003 一個欄位；PNG／WebP／HEIC 一律當作沒有 */
async function readTakenAt(file: File): Promise<string | null> {
  try {
    const v = new DataView(await file.slice(0, 256 * 1024).arrayBuffer());
    if (v.getUint16(0) !== 0xffd8) return null;
    let off = 2;
    while (off + 4 <= v.byteLength) {
      const marker = v.getUint16(off);
      const len = v.getUint16(off + 2);
      if ((marker & 0xff00) !== 0xff00 || marker === 0xffda) return null; // 掃到影像資料還沒找到
      if (marker === 0xffe1 && v.getUint32(off + 4) === 0x45786966) { // "Exif"
        const tiff = off + 10;
        const le = v.getUint16(tiff) === 0x4949;
        const u16 = (o: number) => v.getUint16(tiff + o, le);
        const u32 = (o: number) => v.getUint32(tiff + o, le);
        const findTag = (ifd: number, tag: number): number | null => {
          const n = u16(ifd);
          for (let i = 0; i < n; i++) {
            const e = ifd + 2 + i * 12;
            if (u16(e) === tag) return e;
          }
          return null;
        };
        const ptr = findTag(u32(4), 0x8769); // Exif IFD
        if (ptr === null) return null;
        const e = findTag(u32(ptr + 8), 0x9003); // DateTimeOriginal，ASCII 20 bytes
        if (e === null) return null;
        const at = u32(e + 8);
        let str = '';
        for (let i = 0; i < 19; i++) str += String.fromCharCode(v.getUint8(tiff + at + i));
        const m = str.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
        return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}` : null;
      }
      off += 2 + len;
    }
  } catch { /* 壞檔或截斷：當作沒有拍攝時刻 */ }
  return null;
}

/** 拍攝時刻 → 掛在哪一天（30 小時制：凌晨 0:00–5:59 算前一天；前一天不是展覽日就算當天，例如出發日凌晨） */
function dayOfTakenAt(takenAt: string): string {
  const date = takenAt.slice(0, 10);
  if (Number(takenAt.slice(11, 13)) >= 6) return date;
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  const prev = d.toISOString().slice(0, 10);
  return days.some((x) => x.date === prev) ? prev : date;
}

let pickedTakenAt: string | null = null;
($('up-form') as HTMLFormElement).file.addEventListener('change', async (e: Event) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  pickedTakenAt = file ? await readTakenAt(file) : null;
  const hint = $('up-taken');
  if (!pickedTakenAt) {
    hint.textContent = file ? '讀不到拍攝時間，會排在當天最後。' : '';
    return;
  }
  const day = dayOfTakenAt(pickedTakenAt);
  const known = days.some((d) => d.date === day);
  if (known) ($('up-day') as HTMLSelectElement).value = day;
  hint.textContent = `拍攝時間 ${pickedTakenAt.slice(0, 16).replace('T', ' ')}${known ? '，已選好那一天' : '，不在展覽日內，請自己選'}。`;
});

/** canvas 重編碼：長邊 ≤2048、JPEG 85%；順帶抹掉所有 EXIF/GPS */
async function reencode(file: File): Promise<Blob> {
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(file);
  } catch {
    throw new Error('這個檔案讀不出來（iPhone 的 HEIC 請先在相簿轉成 JPEG，或改用 Safari 上傳）');
  }
  const scale = Math.min(1, 2048 / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff'; // 透明底轉 JPEG 不要變黑
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/jpeg', 0.85));
  if (!blob) throw new Error('縮圖失敗');
  return blob;
}

$('up-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target as HTMLFormElement;
  const btn = form.querySelector('button[type=submit]') as HTMLButtonElement;
  const fileInput = form.file as HTMLInputElement;
  $('up-err').textContent = '';
  $('up-ok').textContent = '';
  const file = fileInput.files?.[0];
  if (!file) return;
  btn.disabled = true;
  btn.textContent = '縮圖中……';
  try {
    const blob = await reencode(file);
    const fd = new FormData();
    fd.append('file', blob, 'photo.jpg');
    fd.append('day', form.day.value);
    fd.append('caption', form.caption.value);
    if (pickedTakenAt) fd.append('takenAt', pickedTakenAt);
    btn.textContent = '上傳中……';
    const { status, data } = await api('/api/photos', { method: 'POST', body: fd });
    if (status !== 201) {
      $('up-err').textContent = (data.error as string) || '上傳失敗';
      return;
    }
    form.reset();
    pickedTakenAt = null;
    $('up-taken').textContent = '';
    $('up-ok').textContent = '已上傳，牆上已更新。';
    await loadMyPhotos();
    refreshWall();
  } catch (err) {
    $('up-err').textContent = err instanceof Error ? err.message : '上傳失敗';
  } finally {
    btn.disabled = false;
    btn.textContent = '上傳';
  }
});

/* ---------- 我的照片 ---------- */

let allPhotos: Photo[] = [];

async function loadMyPhotos(): Promise<void> {
  const grid = $('my-photos');
  grid.textContent = '';
  const { status, data } = await api('/api/photos');
  if (status !== 200) return;
  allPhotos = data.photos as Photo[];
  const mine = allPhotos.filter((p) => p.mine);
  if (mine.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'ep-empty';
    empty.textContent = '還沒有上傳任何照片。';
    grid.append(empty);
    return;
  }
  for (const p of mine) grid.append(photoCard(p));
}

function photoCard(p: Photo): HTMLElement {
  const item = document.createElement('div');
  item.className = 'ep-item';

  const img = document.createElement('img');
  img.src = `/api/media/${p.key}`;
  img.alt = p.caption || p.id;
  img.loading = 'lazy';
  img.width = p.width;
  img.height = p.height;
  item.append(img);

  const cap = document.createElement('div');
  cap.className = 'cap';
  cap.textContent = p.caption || '（無說明）';
  cap.title = p.caption;
  item.append(cap);

  const meta = document.createElement('div');
  meta.className = 'meta';
  const dayLabel = days.find((d) => d.date === p.day)?.label ?? p.day;
  meta.textContent = p.takenAt
    ? `${dayLabel} · 拍攝 ${p.takenAt.slice(5, 16).replace('T', ' ')}`
    : `${dayLabel} · 上傳 ${p.createdAt.slice(5, 10)}`;
  item.append(meta);

  const ops = document.createElement('div');
  ops.className = 'ops';

  const editBtn = document.createElement('button');
  editBtn.type = 'button';
  editBtn.textContent = '編輯';
  editBtn.addEventListener('click', () => {
    // 行內編輯：說明＋掛在哪一天
    const form = document.createElement('form');
    form.className = 'ep-edit';
    const capIn = document.createElement('input');
    capIn.name = 'caption'; capIn.maxLength = 300; capIn.value = p.caption; capIn.placeholder = '說明（可留空）';
    const daySel = document.createElement('select');
    daySel.name = 'day';
    for (const d of days) {
      const opt = document.createElement('option');
      opt.value = d.date; opt.textContent = d.label; opt.selected = d.date === p.day;
      daySel.append(opt);
    }
    const row = document.createElement('div');
    row.className = 'ops';
    const save = document.createElement('button'); save.type = 'submit'; save.textContent = '儲存';
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = '取消';
    row.append(save, cancel);
    form.append(capIn, daySel, row);
    cap.hidden = meta.hidden = ops.hidden = true;
    item.append(form);
    capIn.focus();
    cancel.addEventListener('click', () => { form.remove(); cap.hidden = meta.hidden = ops.hidden = false; });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      save.disabled = true;
      const { status, data } = await api(`/api/photos/${p.id}`, {
        method: 'PUT',
        body: JSON.stringify({ caption: capIn.value, day: daySel.value }),
      });
      save.disabled = false;
      if (status !== 200) { opsError(form).textContent = (data.error as string) || '更新失敗'; return; }
      await loadMyPhotos();
      refreshWall();
    });
  });
  ops.append(editBtn);

  const delBtn = document.createElement('button');
  delBtn.type = 'button';
  delBtn.className = 'del';
  delBtn.textContent = '刪除';
  armDelete(delBtn, async () => {
    const { status, data } = await api(`/api/photos/${p.id}`, { method: 'DELETE', body: '{}' });
    if (status !== 200) { opsError(item).textContent = (data.error as string) || '刪除失敗'; return; }
    await loadMyPhotos();
    refreshWall();
  });
  ops.append(delBtn);

  item.append(ops);
  return item;
}

/* ---------- 留言／繪馬 ---------- */

let allPosts: Post[] = [];

const exhibits: { id: string; title: string; date: string }[] = (() => {
  try {
    return JSON.parse($('edit-exhibits').textContent || '[]');
  } catch {
    return [];
  }
})();

function dayLabel(date: string): string {
  return days.find((d) => d.date === date)?.label ?? date;
}

function targetLabel(p: { kind: string; target: string }): string {
  if (p.kind === 'ema') return `繪馬 · ${dayLabel(p.target)}`;
  const ex = exhibits.find((e) => e.id === p.target);
  if (ex) return `${p.target} ${ex.title}`;
  const ema = allPosts.find((x) => x.id === p.target);
  if (ema) return `繪馬 ${p.target}`;
  const ph = allPhotos.find((x) => x.id === p.target);
  return ph ? `照片 · ${ph.authorName}${ph.caption ? ' ' + ph.caption : ''}` : p.target;
}

function buildDayOptions(): void {
  const sel = $('post-target-day') as HTMLSelectElement;
  if (sel.options.length) return;
  for (const d of days) {
    const opt = document.createElement('option');
    opt.value = d.date;
    opt.textContent = `${d.label}（${d.date}）`;
    sel.append(opt);
  }
}

function buildTargetOptions(): void {
  const sel = $('post-target-exhibit');
  sel.textContent = '';
  for (const d of days) {
    const group = document.createElement('optgroup');
    group.label = `${d.label}（${d.date}）`;
    for (const ex of exhibits.filter((e) => e.date === d.date)) {
      const opt = document.createElement('option');
      opt.value = ex.id;
      opt.textContent = `${ex.id} ${ex.title}`;
      group.append(opt);
    }
    if (group.children.length) sel.append(group);
  }
  const emas = allPosts.filter((p) => p.kind === 'ema');
  if (emas.length) {
    const group = document.createElement('optgroup');
    group.label = '繪馬';
    for (const em of emas) {
      const opt = document.createElement('option');
      opt.value = em.id;
      opt.textContent = `${em.id} ${em.by || '（無署名）'}：${em.body.slice(0, 12)}`;
      group.append(opt);
    }
    sel.append(group);
  }
}

$('post-kind').addEventListener('change', () => {
  const isEma = ($('post-kind') as HTMLSelectElement).value === 'ema';
  $('post-target-exhibit-label').hidden = isEma;
  $('post-target-day-label').hidden = !isEma;
});

const postBodyInput = (): HTMLTextAreaElement => ($('post-form') as HTMLFormElement).body as HTMLTextAreaElement;
postBodyInput().addEventListener('input', () => {
  $('post-count').textContent = `${postBodyInput().value.length}/300`;
});

$('post-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target as HTMLFormElement;
  const btn = form.querySelector('button[type=submit]') as HTMLButtonElement;
  $('post-err').textContent = '';
  $('post-ok').textContent = '';
  const isEma = (form.kind as HTMLSelectElement).value === 'ema';
  btn.disabled = true;
  const { status, data } = await api('/api/posts', {
    method: 'POST',
    body: JSON.stringify({
      kind: isEma ? 'ema' : 'comment',
      target: isEma ? (form.targetDay as HTMLSelectElement).value : (form.targetExhibit as HTMLSelectElement).value,
      by: form.by.value,
      body: form.body.value,
    }),
  });
  btn.disabled = false;
  if (status !== 201) {
    $('post-err').textContent = (data.error as string) || '送出失敗';
    return;
  }
  form.body.value = '';
  $('post-count').textContent = '0/300';
  $('post-ok').textContent = '已送出，牆上已更新。';
  await loadMyPosts();
  refreshWall();
});

async function loadMyPosts(): Promise<void> {
  const { status, data } = await api('/api/posts');
  if (status !== 200) return;
  allPosts = data.posts as Post[];
  buildDayOptions();
  buildTargetOptions();
  const list = $('my-posts');
  list.textContent = '';
  const mine = allPosts.filter((p) => p.mine);
  if (mine.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'ep-empty';
    empty.textContent = '還沒有任何投稿。';
    list.append(empty);
    return;
  }
  for (const p of mine) list.append(postItem(p));
}

function postItem(p: Post): HTMLElement {
  const item = document.createElement('div');
  item.className = 'pst-item';

  const head = document.createElement('div');
  head.className = 'pst-head';
  const kind = document.createElement('span');
  kind.className = `pst-kind ${p.kind === 'ema' ? 'ema' : ''}`;
  kind.textContent = p.kind === 'ema' ? '繪馬' : '留言';
  head.append(kind);
  const tgt = document.createElement('span');
  tgt.className = 'pst-target';
  tgt.textContent = targetLabel(p);
  head.append(tgt);
  item.append(head);

  const body = document.createElement('div');
  body.className = 'pst-body';
  body.textContent = p.body;
  item.append(body);

  const meta = document.createElement('div');
  meta.className = 'pst-meta';
  meta.textContent = `${p.by || '（無署名）'} · ${p.postedAt.slice(5, 10)}`;
  item.append(meta);

  const ops = document.createElement('div');
  ops.className = 'ops';
  const editBtn = document.createElement('button');
  editBtn.type = 'button';
  editBtn.textContent = '編輯';
  editBtn.addEventListener('click', () => {
    const form = document.createElement('form');
    form.className = 'ep-edit';
    const bodyIn = document.createElement('textarea');
    bodyIn.maxLength = 300; bodyIn.rows = 3; bodyIn.required = true; bodyIn.value = p.body;
    const byIn = document.createElement('input');
    byIn.maxLength = 20; byIn.value = p.by; byIn.placeholder = '署名（可留空）';
    const row = document.createElement('div');
    row.className = 'ops';
    const save = document.createElement('button'); save.type = 'submit'; save.textContent = '儲存';
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = '取消';
    row.append(save, cancel);
    form.append(bodyIn, byIn, row);
    body.hidden = meta.hidden = ops.hidden = true;
    item.append(form);
    bodyIn.focus();
    cancel.addEventListener('click', () => { form.remove(); body.hidden = meta.hidden = ops.hidden = false; });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      save.disabled = true;
      const { status, data } = await api(`/api/posts/${p.id}`, {
        method: 'PUT',
        body: JSON.stringify({ body: bodyIn.value, by: byIn.value }),
      });
      save.disabled = false;
      if (status !== 200) { opsError(form).textContent = (data.error as string) || '更新失敗'; return; }
      await loadMyPosts();
      refreshWall();
    });
  });
  ops.append(editBtn);

  const delBtn = document.createElement('button');
  delBtn.type = 'button';
  delBtn.className = 'del';
  delBtn.textContent = '刪除';
  armDelete(delBtn, async () => {
    const { status, data } = await api(`/api/posts/${p.id}`, { method: 'DELETE', body: '{}' });
    if (status !== 200) { opsError(item).textContent = (data.error as string) || '刪除失敗'; return; }
    await loadMyPosts();
    refreshWall();
  });
  ops.append(delBtn);

  item.append(ops);
  return item;
}

/* ---------- 說明卡裡直接留言／回覆（wall.ts 開說明卡時發 wall:lightbox） ---------- */

let lbTarget: string | null = null;
let lbReplyTo: string | null = null;

function lbForm(): HTMLFormElement {
  let form = document.getElementById('lb-cmt-form') as HTMLFormElement | null;
  if (form) return form;
  form = document.createElement('form');
  form.id = 'lb-cmt-form';
  form.className = 'lb-cmt-form';
  const replying = document.createElement('div');
  replying.className = 'replying';
  replying.hidden = true;
  const replyTxt = document.createElement('span');
  const replyX = document.createElement('button');
  replyX.type = 'button';
  replyX.textContent = '×';
  replyX.setAttribute('aria-label', '取消回覆');
  replyX.addEventListener('click', () => setReply(null));
  replying.append(replyTxt, replyX);
  const ta = document.createElement('textarea');
  ta.name = 'body'; ta.rows = 2; ta.maxLength = 300; ta.required = true; ta.placeholder = '留言（1～300 字，送出後立刻公開）';
  const row = document.createElement('div');
  row.className = 'row';
  const by = document.createElement('input');
  by.name = 'by'; by.maxLength = 20; by.placeholder = '署名（可留空）';
  const send = document.createElement('button');
  send.type = 'submit'; send.textContent = '送出';
  row.append(by, send);
  const err = document.createElement('p');
  err.className = 'err'; err.setAttribute('role', 'alert');
  form.append(replying, ta, row, err);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!lbTarget) return;
    send.disabled = true;
    err.textContent = '';
    const { status, data } = await api('/api/posts', {
      method: 'POST',
      body: JSON.stringify({ kind: 'comment', target: lbTarget, replyTo: lbReplyTo, body: ta.value, by: by.value }),
    });
    send.disabled = false;
    if (status !== 201) { err.textContent = (data.error as string) || '送出失敗'; return; }
    ta.value = '';
    setReply(null);
    refreshWall(); // 牆面重新載入後會重開同一張說明卡、留言串跟著更新
    void loadMyPosts();
  });
  $('lb-cmts').after(form);
  return form;
}

function setReply(cid: string | null): void {
  lbReplyTo = cid;
  const box = lbForm().querySelector<HTMLElement>('.replying')!;
  box.hidden = !cid;
  if (cid) {
    const head = document.querySelector(`#lb-cmts .cmt[data-cid="${cid}"] .cmt-head`)?.textContent || '';
    box.querySelector('span')!.textContent = `回覆 ${head.split(' · ')[0] || '這則留言'}`;
    lbForm().querySelector('textarea')!.focus();
  }
}

window.addEventListener('wall:lightbox', (e) => {
  const { id, kind } = (e as CustomEvent<{ id: string; kind: string }>).detail;
  if (!me) return;
  const form = lbForm();
  if (lbTarget !== id) setReply(null);
  lbTarget = id; // 展品、照片、繪馬都能留言
  const byIn = form.querySelector<HTMLInputElement>('input[name=by]')!;
  if (!byIn.value) byIn.value = me.displayName;
  // 每則留言加「回覆」
  document.querySelectorAll<HTMLElement>('#lb-cmts .cmt').forEach((c) => {
    if (c.querySelector('.cmt-reply')) return;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'cmt-reply';
    b.textContent = '回覆';
    b.addEventListener('click', () => setReply(c.dataset.cid || null));
    c.querySelector('.cmt-head')?.append(b);
  });
});

/* ---------- 初始 ---------- */

/* 每天標題旁的「掛一塊繪馬」：開抽屜、切繪馬、預選那天 */
document.querySelectorAll<HTMLButtonElement>('.btn-add-ema').forEach((btn) => {
  btn.addEventListener('click', () => {
    buildDayOptions();
    $('edit-drawer').hidden = false;
    ($('post-kind') as HTMLSelectElement).value = 'ema';
    $('post-kind').dispatchEvent(new Event('change'));
    ($('post-target-day') as HTMLSelectElement).value = btn.dataset.day || '';
    postBodyInput().focus();
  });
});

void (async () => {
  const { status, data } = await api('/api/me');
  if (status === 200) me = data.me as Me;
  setView();
})();
