// /admin 管理台 client 邏輯：登入檢查 → 帳號列表/建號/重設密碼/停用/角色/改名 → 刪除帳號（無內容立即刪、有內容軟刪除 30 天）與恢復 → 內容審核 → 自助變更密碼。
// 不用 confirm/prompt/alert：危險操作在按鈕上多段確認（刪帳號有內容時三段）、改名行內編輯、錯誤顯示在卡片裡。
// 靜態殼在 src/pages/admin/index.astro；API 在 worker/back.ts（僅 kura 網域可達）。

type Me = { username: string; displayName: string; role: string; mustChangePw: boolean };
type UserRow = {
  username: string; displayName: string; role: string; status: string;
  mustChangePw: boolean; createdAt: string; lastLoginAt: string | null;
  deletedAt: string | null; purgeAt: string | null;
};
type Photo = {
  id: string; author: string; authorName: string; day: string; caption: string;
  key: string; width: number; height: number; createdAt: string; kind?: string; posterKey?: string | null;
};
type Post = {
  id: string; kind: string; target: string; replyTo: string | null; by: string;
  body: string; author: string; postedAt: string;
};

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

/** API 呼叫：網路斷線不丟例外；已登入卻收到 401＝登入過期，回登入卡 */
async function api(path: string, init?: RequestInit): Promise<{ status: number; data: Record<string, unknown> }> {
  let res: Response;
  try {
    res = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      ...init,
    });
  } catch {
    return { status: 0, data: { error: '網路連線失敗，請稍後再試' } };
  }
  let data: Record<string, unknown> = {};
  try { data = await res.json(); } catch { /* 非 JSON 回應 */ }
  if (res.status === 401 && me && path !== '/api/login') {
    me = null;
    show('login');
    $('login-err').textContent = '登入已過期，請重新登入';
  }
  return { status: res.status, data };
}

/** 危險操作兩段式確認：第一次按變成「確定？」，4 秒內再按才執行 */
function armed(btn: HTMLButtonElement, confirmLabel: string, run: () => Promise<void>): void {
  const label = btn.textContent || '';
  let timer = 0;
  btn.addEventListener('click', async () => {
    if (!btn.classList.contains('armed')) {
      btn.classList.add('armed');
      btn.textContent = confirmLabel;
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

/** 刪除帳號的確認：依「內容數量」決定兩段或三段，全部在按鈕上（不用原生 confirm）。
 *  無內容：確定刪除？ → 送出（硬刪）。
 *  有內容：有內容（照片 N、影片 N、留言 N、繪馬 N），再按一次
 *         → 隱藏內容並在 30 天後永久刪除？ → 送出（帶 confirm:'content'，軟刪除）。
 *  任何一段 4 秒內沒按下一段就回到原狀。數量由預覽 API 取得，模式仍由伺服器依實際內容決定。 */
function armedUserDelete(
  btn: HTMLButtonElement,
  username: string,
  err: (msg: string) => void,
  done: () => Promise<void>,
): void {
  const label = btn.textContent || '';
  let timer = 0;
  let step = 0;        // 0 未確認／1 已按第一次／2 有內容且已按第二次
  let hasContent = false;
  const revert = () => { step = 0; hasContent = false; btn.classList.remove('armed'); btn.textContent = label; };
  const arm = (text: string) => {
    btn.classList.add('armed');
    btn.textContent = text;
    clearTimeout(timer);
    timer = window.setTimeout(revert, 4000);
  };
  btn.addEventListener('click', async () => {
    if (step === 0) {
      btn.disabled = true;
      const { status, data } = await api(`/api/users/${encodeURIComponent(username)}/content`);
      btn.disabled = false;
      if (status !== 200) { err((data.error as string) || '無法取得內容數量'); return; }
      const n = data as { photos?: number; videos?: number; comments?: number; emas?: number };
      const counts = { photos: n.photos ?? 0, videos: n.videos ?? 0, comments: n.comments ?? 0, emas: n.emas ?? 0 };
      hasContent = counts.photos + counts.videos + counts.comments + counts.emas > 0;
      step = 1;
      arm(hasContent
        ? `有內容（照片 ${counts.photos}、影片 ${counts.videos}、留言 ${counts.comments}、繪馬 ${counts.emas}），再按一次`
        : '確定刪除？');
      return;
    }
    if (step === 1 && hasContent) {
      step = 2;
      arm('隱藏內容並在 30 天後永久刪除？');
      return;
    }
    // 最後一步：送出
    clearTimeout(timer);
    btn.disabled = true;
    const { status, data } = await api(`/api/users/${encodeURIComponent(username)}`, {
      method: 'DELETE',
      body: JSON.stringify(hasContent ? { confirm: 'content' } : {}),
    });
    btn.disabled = false;
    if (status !== 200) { err((data.error as string) || '刪除失敗'); revert(); return; }
    err('');
    revert();
    await done();
  });
}

function patchUser(username: string, body: Record<string, unknown>) {
  return api(`/api/users/${encodeURIComponent(username)}`, { method: 'PATCH', body: JSON.stringify(body) });
}

/* ---------- 一次性密碼 modal ---------- */

function revealPassword(title: string, password: string): void {
  $('pw-reveal-title').textContent = title;
  $('pw-reveal-value').textContent = password;
  $('pw-reveal-copy').textContent = '複製'; // 上一次的「已複製」不能留著
  $('pw-reveal').hidden = false;
}
$('pw-reveal-close').addEventListener('click', () => {
  $('pw-reveal').hidden = true;
  $('pw-reveal-value').textContent = ''; // 「只顯示這一次」：關閉後不能留在 DOM 裡
});
$('pw-reveal-copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('pw-reveal-value').textContent || '');
    $('pw-reveal-copy').textContent = '已複製';
  } catch { /* clipboard 不可用就手動複製 */ }
});

/* ---------- 狀態切換 ---------- */

function show(view: 'login' | 'forbidden' | 'console'): void {
  $('adm-loading').hidden = true;
  $('adm-login').hidden = view !== 'login';
  $('adm-forbidden').hidden = view !== 'forbidden';
  $('adm-console').hidden = view !== 'console';
}

let me: Me | null = null;

async function init(): Promise<void> {
  const { status, data } = await api('/api/me');
  if (status !== 200) { show('login'); return; }
  me = data.me as Me;
  if (me.role !== 'admin') {
    $('forbidden-who').textContent = `${me.displayName}（${me.username}）`;
    show('forbidden');
    return;
  }
  $('console-who').textContent = `${me.displayName}（${me.username}）`;
  $('must-change').hidden = !me.mustChangePw;
  if (me.mustChangePw) $('change-pw-card').hidden = false;
  show('console');
  await Promise.all([loadUsers(), loadContent()]);
}

/* ---------- 登入/登出 ---------- */

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target as HTMLFormElement;
  const btn = form.querySelector('button[type=submit]') as HTMLButtonElement;
  btn.disabled = true;
  $('login-err').textContent = '';
  const { status, data } = await api('/api/login', {
    method: 'POST',
    body: JSON.stringify({
      username: form.username.value,
      password: form.password.value,
    }),
  });
  btn.disabled = false;
  if (status !== 200) {
    $('login-err').textContent = (data.error as string) || '登入失敗';
    return;
  }
  form.reset();
  await init();
});

async function logout(): Promise<void> {
  await api('/api/logout', { method: 'POST', body: '{}' });
  location.reload();
}
$('btn-logout').addEventListener('click', logout);
$('forbidden-logout').addEventListener('click', logout);

/* ---------- 變更密碼（自助） ---------- */

$('btn-change-pw').addEventListener('click', () => {
  $('change-pw-card').hidden = !$('change-pw-card').hidden;
});
$('change-pw-cancel').addEventListener('click', () => {
  if (!me?.mustChangePw) $('change-pw-card').hidden = true;
});
$('change-pw-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target as HTMLFormElement;
  $('change-pw-err').textContent = '';
  $('change-pw-ok').textContent = '';
  const { status, data } = await api('/api/change-password', {
    method: 'POST',
    body: JSON.stringify({
      currentPassword: form.currentPassword.value,
      newPassword: form.newPassword.value,
    }),
  });
  if (status !== 200) {
    $('change-pw-err').textContent = (data.error as string) || '變更失敗';
    return;
  }
  form.reset();
  $('change-pw-ok').textContent = '已變更，其他裝置已登出。';
  if (me?.mustChangePw) {
    me.mustChangePw = false;
    $('must-change').hidden = true;
    $('change-pw-card').hidden = true;
  }
});

/* ---------- 帳號列表 ---------- */

function badge(text: string, cls = ''): HTMLElement {
  const el = document.createElement('span');
  el.className = `badge ${cls}`.trim();
  el.textContent = text;
  return el;
}

async function loadUsers(): Promise<void> {
  const { status, data } = await api('/api/users');
  const tbody = $('users-tbl').querySelector('tbody')!;
  tbody.textContent = '';
  if (status !== 200) return;
  for (const u of data.users as UserRow[]) tbody.appendChild(userRow(u));
}

function cell(label: string): HTMLTableCellElement {
  const td = document.createElement('td');
  td.dataset.label = label; // 手機版改卡片時當欄位名
  return td;
}

function userRow(u: UserRow): HTMLTableRowElement {
  const tr = document.createElement('tr');
  if (u.deletedAt) tr.className = 'deleted'; // 待刪除的列整列變淡
  const isSelf = me?.username === u.username;
  const err = (msg: string) => { $('users-err').textContent = msg; };

  const tdName = cell('帳號');
  tdName.className = 'name';
  tdName.textContent = u.username;
  tr.append(tdName);

  const tdDisp = cell('顯示名稱');
  tdDisp.textContent = u.displayName;
  if (u.mustChangePw) tdDisp.append(' ', badge('待改密碼', 'must'));
  tr.append(tdDisp);

  const tdRole = cell('角色');
  tdRole.append(badge(u.role === 'admin' ? '管理員' : '用戶', u.role === 'admin' ? 'admin' : ''));
  tr.append(tdRole);

  const tdStatus = cell('狀態');
  if (u.deletedAt) {
    // 軟刪除中：顯示永久刪除日期（deleted_at + 30 天，伺服器算好）
    tdStatus.append(badge(`待刪除（${(u.purgeAt ?? u.deletedAt).slice(0, 10)} 永久刪除）`, 'disabled'));
  } else {
    tdStatus.append(badge(u.status === 'active' ? '啟用' : '停用', u.status === 'active' ? '' : 'disabled'));
  }
  tr.append(tdStatus);

  const tdCreated = cell('建立');
  tdCreated.textContent = u.createdAt.slice(0, 10);
  tr.append(tdCreated);

  const tdLogin = cell('最後登入');
  tdLogin.textContent = u.lastLoginAt ? u.lastLoginAt.slice(0, 16).replace('T', ' ') : '尚未登入';
  tr.append(tdLogin);

  const tdOps = cell('操作');
  const ops = document.createElement('div');
  ops.className = 'ops';

  // 軟刪除中（待刪除）：列上只有恢復鈕（一段式），沒有停用／重設密碼／角色／改名／刪除
  if (u.deletedAt) {
    const restore = opButton('恢復');
    restore.title = '取消刪除，內容重新公開';
    restore.addEventListener('click', async () => {
      const { status, data } = await api(`/api/users/${encodeURIComponent(u.username)}/restore`, { method: 'POST', body: '{}' });
      if (status !== 200) { err((data.error as string) || '恢復失敗'); return; }
      err('');
      await Promise.all([loadUsers(), loadContent()]);
    });
    ops.append(restore);
    tdOps.append(ops);
    tr.append(tdOps);
    return tr;
  }

  const reset = opButton('重設密碼');
  armed(reset, '確定重設？', async () => {
    const { status, data } = await patchUser(u.username, { resetPassword: true });
    if (status !== 200) { err((data.error as string) || '重設失敗'); return; }
    err('');
    revealPassword(`${u.username} 的新密碼`, data.password as string);
    await loadUsers();
  });
  ops.append(reset);

  const toggle = opButton(u.status === 'active' ? '停用' : '啟用', isSelf);
  const doToggle = async () => {
    const { status, data } = await patchUser(u.username, { status: u.status === 'active' ? 'disabled' : 'active' });
    if (status !== 200) { err((data.error as string) || '操作失敗'); return; }
    err('');
    await loadUsers();
  };
  if (u.status === 'active') armed(toggle, '確定停用？', doToggle); // 停用會立即登出，要確認；啟用直接做
  else toggle.addEventListener('click', doToggle);
  ops.append(toggle);

  const role = opButton(u.role === 'admin' ? '降為用戶' : '升為管理員', isSelf);
  armed(role, u.role === 'admin' ? '確定降級？' : '確定升級？', async () => {
    const { status, data } = await patchUser(u.username, { role: u.role === 'admin' ? 'user' : 'admin' });
    if (status !== 200) { err((data.error as string) || '操作失敗'); return; }
    err('');
    await loadUsers();
  });
  ops.append(role);

  const rename = opButton('改名');
  rename.addEventListener('click', () => {
    // 行內改名：顯示名稱欄換成輸入框
    const form = document.createElement('form');
    form.className = 'rename';
    const input = document.createElement('input');
    input.maxLength = 20; input.required = true; input.value = u.displayName;
    const save = document.createElement('button'); save.type = 'submit'; save.className = 'ghost'; save.textContent = '儲存';
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'ghost'; cancel.textContent = '取消';
    form.append(input, save, cancel);
    const before = [...tdDisp.childNodes];
    tdDisp.replaceChildren(form);
    input.focus();
    cancel.addEventListener('click', () => tdDisp.replaceChildren(...before));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const { status, data } = await patchUser(u.username, { displayName: input.value.trim() });
      if (status !== 200) { err((data.error as string) || '改名失敗'); return; }
      err('');
      await Promise.all([loadUsers(), loadContent()]);
    });
  });
  ops.append(rename);

  // 刪除帳號：自己那一列不顯示。第一次按先打預覽 API，內容數量決定兩段或三段確認。
  if (!isSelf) {
    const del = opButton('刪除');
    del.title = '刪除帳號：沒有內容時立即刪除，有內容時先隱藏、30 天後永久刪除';
    armedUserDelete(del, u.username, err, async () => { await Promise.all([loadUsers(), loadContent()]); });
    ops.append(del);
  }

  tdOps.append(ops);
  tr.append(tdOps);
  return tr;
}

function opButton(label: string, disabled = false): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ghost';
  btn.textContent = label;
  btn.disabled = disabled;
  btn.title = disabled ? '不可操作自己的帳號' : '';
  return btn;
}

/* ---------- 建立帳號 ---------- */

$('create-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target as HTMLFormElement;
  $('create-err').textContent = '';
  $('create-ok').textContent = '';
  const { status, data } = await api('/api/users', {
    method: 'POST',
    body: JSON.stringify({
      username: form.username.value,
      displayName: form.displayName.value,
      role: (form.elements.namedItem('role') as HTMLSelectElement).value, // form.role 會被型別當成 ARIA 的 role 屬性
      password: form.password.value, // 留空字串 → 後端自動產生
    }),
  });
  if (status !== 201) {
    $('create-err').textContent = (data.error as string) || '建立失敗';
    return;
  }
  form.reset();
  $('create-ok').textContent = `已建立 ${data.username}。`;
  if (typeof data.password === 'string') {
    revealPassword(`${data.username} 的初始密碼`, data.password);
  }
  await loadUsers();
});

/* ---------- 內容審核 ---------- */

let modTab: 'photos' | 'posts' = 'photos';

document.querySelectorAll<HTMLButtonElement>('.tab').forEach((t) => {
  t.addEventListener('click', () => {
    modTab = t.dataset.tab === 'posts' ? 'posts' : 'photos';
    document.querySelectorAll<HTMLButtonElement>('.tab').forEach((x) => {
      x.classList.toggle('on', x === t);
      x.setAttribute('aria-selected', String(x === t));
    });
    $('mod-photos').hidden = modTab !== 'photos';
    $('mod-posts').hidden = modTab !== 'posts';
  });
});
$('mod-reload').addEventListener('click', () => void loadContent());

function emptyNote(text: string): HTMLElement {
  const p = document.createElement('p');
  p.className = 'mod-empty';
  p.textContent = text;
  return p;
}

async function loadContent(): Promise<void> {
  $('mod-err').textContent = '';
  const [ph, po] = await Promise.all([api('/api/photos'), api('/api/posts')]);
  if (ph.status !== 200 || po.status !== 200) {
    $('mod-err').textContent = (ph.data.error as string) || (po.data.error as string) || '載入失敗';
    return;
  }
  const photos = ph.data.photos as Photo[];
  const posts = po.data.posts as Post[];
  $('mod-n-photos').textContent = String(photos.length);
  $('mod-n-posts').textContent = String(posts.length);

  const pg = $('mod-photos');
  pg.textContent = '';
  if (!photos.length) pg.append(emptyNote('目前沒有上傳的照片。'));
  for (const p of photos) {
    const card = document.createElement('div');
    card.className = 'mod-ph';
    const img = document.createElement('img');
    img.src = `/api/media/${p.kind === 'video' && p.posterKey ? p.posterKey : p.key}`; // 影片顯示封面
    img.alt = p.caption || p.id;
    img.loading = 'lazy';
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = `${p.authorName}（${p.author}）· 掛 ${p.day.slice(5)} · ${p.createdAt.slice(5, 16).replace('T', ' ')}`;
    const cap = document.createElement('div');
    cap.className = 'cap';
    cap.textContent = p.caption || '（無說明）';
    const ops = document.createElement('div');
    ops.className = 'ops';
    const del = opButton('刪除');
    armed(del, '確定刪除？', async () => {
      const { status, data } = await api(`/api/photos/${p.id}`, { method: 'DELETE', body: '{}' });
      if (status !== 200) { $('mod-err').textContent = (data.error as string) || '刪除失敗'; return; }
      await loadContent();
    });
    ops.append(del);
    card.append(img, meta, cap, ops);
    pg.append(card);
  }

  const pl = $('mod-posts');
  pl.textContent = '';
  if (!posts.length) pl.append(emptyNote('目前沒有留言或繪馬。'));
  const byId = new Map(posts.map((x) => [x.id, x]));
  for (const p of [...posts].reverse()) { // 新的在上面
    const item = document.createElement('div');
    item.className = 'mod-po';
    const head = document.createElement('div');
    head.className = 'head';
    head.append(badge(p.kind === 'ema' ? '繪馬' : '留言', p.kind === 'ema' ? 'admin' : ''));
    const where = document.createElement('span');
    where.className = 'meta';
    const ema = byId.get(p.target);
    // 留言的 target 有三種：展品（JP-…）、繪馬（n-…，在 byId 裡）、照片（p-…）。
    // 不然照片下的留言會顯示成「展品 p-20261018-xxxx」，審核時看不出掛在哪。
    const whereText = p.kind === 'ema'
      ? `掛在 ${p.target}`
      : ema
        ? `繪馬「${ema.body.slice(0, 12)}」下`
        : /^p-\d{8}-[a-z0-9]{4}$/.test(p.target)
          ? `照片 ${p.target} 下`
          : `展品 ${p.target}`;
    where.textContent = whereText;
    if (p.replyTo) where.textContent += ' · 回覆';
    head.append(where);
    const body = document.createElement('div');
    body.className = 'body';
    body.textContent = p.body;
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = `署名 ${p.by || '（無）'} · 帳號 ${p.author} · ${p.postedAt.slice(5, 16).replace('T', ' ')}`;
    const ops = document.createElement('div');
    ops.className = 'ops';
    const del = opButton('刪除');
    armed(del, '確定刪除？', async () => {
      const { status, data } = await api(`/api/posts/${p.id}`, { method: 'DELETE', body: '{}' });
      if (status !== 200) { $('mod-err').textContent = (data.error as string) || '刪除失敗'; return; }
      await loadContent();
    });
    ops.append(del);
    item.append(head, body, meta, ops);
    pl.append(item);
  }
}

void init();
