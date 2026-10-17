// /edit 編輯模式 client 邏輯：登入遮罩、浮動工具列、變更密碼。
// 之後階段 4/5 會在這個 session 狀態上掛上傳與發文 UI。

type Me = { username: string; displayName: string; role: string; mustChangePw: boolean };

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

async function api(path: string, init?: RequestInit): Promise<{ status: number; data: Record<string, unknown> }> {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
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

/* ---------- 初始 ---------- */

void (async () => {
  const { status, data } = await api('/api/me');
  if (status === 200) me = data.me as Me;
  setView();
})();
