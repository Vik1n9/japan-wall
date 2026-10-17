// /edit 編輯模式 client 邏輯：登入遮罩、浮動工具列、變更密碼、上傳照片（canvas 縮圖）、我的照片管理。
// 上傳隱私第一層：這裡先 canvas 重編碼（長邊 ≤2048、JPEG ~85%），EXIF/GPS 自然消失；
// server（worker/lib/images.ts）還會再剝一次 metadata 防繞過。

type Me = { username: string; displayName: string; role: string; mustChangePw: boolean };
type Photo = {
  id: string; author: string; authorName: string; day: string; caption: string;
  key: string; mime: string; width: number; height: number; createdAt: string; mine: boolean;
};

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

async function api(path: string, init?: RequestInit): Promise<{ status: number; data: Record<string, unknown> }> {
  const res = await fetch(path, {
    headers: init?.body instanceof FormData ? undefined : { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    ...init,
  });
  let data: Record<string, unknown> = {};
  try { data = await res.json(); } catch { /* 非 JSON */ }
  return { status: res.status, data };
}

let me: Me | null = null;

function setView(): void {
  const logged = me !== null;
  $('edit-mask').hidden = logged;
  $('edit-bar').hidden = !logged;
  if (logged && me) {
    $('em-who').textContent = me.displayName;
    $('em-admin').hidden = me.role !== 'admin';
    if (me.mustChangePw) openPw(true);
    void loadMyPhotos();
  } else {
    $('edit-drawer').hidden = true;
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

/** canvas 重編碼：長邊 ≤2048、JPEG 85%；順帶抹掉所有 EXIF/GPS */
async function reencode(file: File): Promise<Blob> {
  const bmp = await createImageBitmap(file);
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
    btn.textContent = '上傳中……';
    const { status, data } = await api('/api/photos', { method: 'POST', body: fd });
    if (status !== 201) {
      $('up-err').textContent = (data.error as string) || '上傳失敗';
      return;
    }
    form.reset();
    $('up-ok').textContent = '已上傳，馬上就出現在牆上了。';
    await loadMyPhotos();
  } catch (err) {
    $('up-err').textContent = err instanceof Error ? err.message : '上傳失敗';
  } finally {
    btn.disabled = false;
    btn.textContent = '上傳';
  }
});

/* ---------- 我的照片 ---------- */

async function loadMyPhotos(): Promise<void> {
  const grid = $('my-photos');
  grid.textContent = '';
  const { status, data } = await api('/api/photos');
  if (status !== 200) return;
  const mine = (data.photos as Photo[]).filter((p) => p.mine);
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
  meta.textContent = `${dayLabel} · ${p.createdAt.slice(5, 10)}`;
  item.append(meta);

  const ops = document.createElement('div');
  ops.className = 'ops';

  const editBtn = document.createElement('button');
  editBtn.type = 'button';
  editBtn.textContent = '編輯';
  editBtn.addEventListener('click', async () => {
    const caption = prompt('照片說明（≤300 字，留空＝無說明）：', p.caption);
    if (caption === null) return;
    const day = prompt('掛在哪一天？（YYYY-MM-DD）', p.day);
    if (day === null) return;
    const { status, data } = await api(`/api/photos/${p.id}`, {
      method: 'PUT',
      body: JSON.stringify({ caption, day: day.trim() }),
    });
    if (status !== 200) { alert((data.error as string) || '更新失敗'); return; }
    await loadMyPhotos();
  });
  ops.append(editBtn);

  const delBtn = document.createElement('button');
  delBtn.type = 'button';
  delBtn.className = 'del';
  delBtn.textContent = '刪除';
  delBtn.addEventListener('click', async () => {
    if (!confirm('刪除這張照片？牆上會立刻消失。')) return;
    const { status, data } = await api(`/api/photos/${p.id}`, { method: 'DELETE', body: '{}' });
    if (status !== 200) { alert((data.error as string) || '刪除失敗'); return; }
    await loadMyPhotos();
  });
  ops.append(delBtn);

  item.append(ops);
  return item;
}

/* ---------- 初始 ---------- */

void (async () => {
  const { status, data } = await api('/api/me');
  if (status === 200) me = data.me as Me;
  setView();
})();
