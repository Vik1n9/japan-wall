// /admin 管理台 client 邏輯：登入檢查 → 帳號列表/建號/重設密碼/停用/角色/改名 → 自助變更密碼。
// 靜態殼在 src/pages/admin/index.astro；API 在 worker/back.ts（僅 kura 網域可達）。

type Me = { username: string; displayName: string; role: string; mustChangePw: boolean };
type UserRow = {
  username: string; displayName: string; role: string; status: string;
  mustChangePw: boolean; createdAt: string;
};

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

async function api(path: string, init?: RequestInit): Promise<{ status: number; data: Record<string, unknown> }> {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    ...init,
  });
  let data: Record<string, unknown> = {};
  try { data = await res.json(); } catch { /* 非 JSON 回應 */ }
  return { status: res.status, data };
}

/* ---------- 一次性密碼 modal ---------- */

function revealPassword(title: string, password: string): void {
  $('pw-reveal-title').textContent = title;
  $('pw-reveal-value').textContent = password;
  $('pw-reveal').hidden = false;
}
$('pw-reveal-close').addEventListener('click', () => { $('pw-reveal').hidden = true; });
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
  await loadUsers();
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

function userRow(u: UserRow): HTMLTableRowElement {
  const tr = document.createElement('tr');
  const isSelf = me?.username === u.username;

  const tdName = document.createElement('td');
  tdName.className = 'name';
  tdName.textContent = u.username;
  tr.append(tdName);

  const tdDisp = document.createElement('td');
  tdDisp.textContent = u.displayName;
  if (u.mustChangePw) tdDisp.append(' ', badge('待改密碼', 'must'));
  tr.append(tdDisp);

  const tdRole = document.createElement('td');
  tdRole.append(badge(u.role === 'admin' ? '管理員' : '用戶', u.role === 'admin' ? 'admin' : ''));
  tr.append(tdRole);

  const tdStatus = document.createElement('td');
  tdStatus.append(badge(u.status === 'active' ? '啟用' : '停用', u.status === 'active' ? '' : 'disabled'));
  tr.append(tdStatus);

  const tdCreated = document.createElement('td');
  tdCreated.textContent = u.createdAt.slice(0, 10);
  tr.append(tdCreated);

  const tdOps = document.createElement('td');
  const ops = document.createElement('div');
  ops.className = 'ops';

  ops.append(opButton('重設密碼', 'ghost', async () => {
    if (!confirm(`重設 ${u.username} 的密碼？該帳號會立即登出。`)) return;
    const { status, data } = await api(`/api/users/${encodeURIComponent(u.username)}`, {
      method: 'PATCH', body: JSON.stringify({ resetPassword: true }),
    });
    if (status !== 200) { alert((data.error as string) || '重設失敗'); return; }
    revealPassword(`${u.username} 的新密碼`, data.password as string);
    await loadUsers();
  }));

  ops.append(opButton(u.status === 'active' ? '停用' : '啟用', 'ghost', async () => {
    const next = u.status === 'active' ? 'disabled' : 'active';
    if (next === 'disabled' && !confirm(`停用 ${u.username}？登入會被擋下，已公開的內容會留在牆上。`)) return;
    const { status, data } = await api(`/api/users/${encodeURIComponent(u.username)}`, {
      method: 'PATCH', body: JSON.stringify({ status: next }),
    });
    if (status !== 200) alert((data.error as string) || '操作失敗');
    await loadUsers();
  }, isSelf));

  ops.append(opButton(u.role === 'admin' ? '降為用戶' : '升為管理員', 'ghost', async () => {
    const next = u.role === 'admin' ? 'user' : 'admin';
    if (!confirm(`把 ${u.username} ${next === 'admin' ? '升為管理員' : '降為一般用戶'}？`)) return;
    const { status, data } = await api(`/api/users/${encodeURIComponent(u.username)}`, {
      method: 'PATCH', body: JSON.stringify({ role: next }),
    });
    if (status !== 200) alert((data.error as string) || '操作失敗');
    await loadUsers();
  }, isSelf));

  ops.append(opButton('改名', 'ghost', async () => {
    const next = prompt(`${u.username} 的新顯示名稱（1–20 字）：`, u.displayName);
    if (next === null) return;
    const { status, data } = await api(`/api/users/${encodeURIComponent(u.username)}`, {
      method: 'PATCH', body: JSON.stringify({ displayName: next.trim() }),
    });
    if (status !== 200) alert((data.error as string) || '改名失敗');
    await loadUsers();
  }));

  tdOps.append(ops);
  tr.append(tdOps);
  return tr;
}

function opButton(label: string, cls: string, onClick: () => void, disabled = false): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = cls;
  btn.textContent = label;
  btn.disabled = disabled;
  btn.title = disabled ? '不可操作自己的帳號' : '';
  btn.addEventListener('click', onClick);
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

void init();
