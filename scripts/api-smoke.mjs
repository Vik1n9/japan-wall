#!/usr/bin/env node
// 後台 API 煙霧測試：對本機 wrangler dev（npm run dev:api）跑一輪完整流程，每次改後台都跑一次。
// 用法：KURA_ADMIN=<帳號> KURA_ADMIN_PW=<密碼> node scripts/api-smoke.mjs [http://localhost:8787]
// 會建立 smoke-* 測試帳號與投稿，跑完把測試帳號停用、測試內容刪除。只對本機用，不要指向正式站。
import sharp from 'sharp';

const BASE = process.argv[2] || 'http://localhost:8787';
const ORIGIN = 'http://localhost:8787';
const ADMIN = process.env.KURA_ADMIN;
const ADMIN_PW = process.env.KURA_ADMIN_PW;
if (!ADMIN || !ADMIN_PW) {
  console.error('需要 KURA_ADMIN 與 KURA_ADMIN_PW 環境變數（本機管理員帳號）');
  process.exit(2);
}
if (!/localhost|127\.0\.0\.1/.test(BASE)) {
  console.error('只允許對本機跑');
  process.exit(2);
}

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : ` — ${detail}`}`);
}

/** 簡易 cookie jar：一個 client 一個 session */
function client() {
  let cookie = '';
  return async function call(method, path, { body, form, origin = ORIGIN, rawCookie } = {}) {
    const headers = {};
    if (origin) headers.Origin = origin;
    if (rawCookie !== undefined) headers.Cookie = rawCookie;
    else if (cookie) headers.Cookie = cookie;
    let payload;
    if (form) payload = form;
    else if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(BASE + path, { method, headers, body: payload, redirect: 'manual' });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    let data = null;
    const text = await res.text();
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data, headers: res.headers };
  };
}

const tag = Math.random().toString(36).slice(2, 6);
const admin = client();

// ---------- 登入 ----------
let r = await admin('POST', '/api/login', { body: { username: ADMIN, password: 'wrong-password' } });
check('錯誤密碼 → 401', r.status === 401, String(r.status));
r = await admin('POST', '/api/login', { body: { username: ADMIN, password: ADMIN_PW } });
check('管理員登入 → 200', r.status === 200, JSON.stringify(r.data));
if (r.status !== 200) process.exit(1);
check('登入 cookie 帶 HttpOnly、SameSite=Lax', /HttpOnly/.test(r.headers.get('set-cookie') || '') && /SameSite=Lax/.test(r.headers.get('set-cookie') || ''));

r = await admin('POST', '/api/login', { body: { username: ADMIN, password: ADMIN_PW }, origin: null });
check('無 Origin 的 POST → 403', r.status === 403, String(r.status));
r = await admin('POST', '/api/login', { body: { username: ADMIN, password: ADMIN_PW }, origin: 'https://evil.example' });
check('外站 Origin → 403', r.status === 403, String(r.status));

// 帳號存在與否的回應時間差（PBKDF2 一次約數十 ms；差距應遠小於一次雜湊）
const t = async (u) => {
  const c = client();
  const s = performance.now();
  await c('POST', '/api/login', { body: { username: u, password: 'x-wrong-pass' } });
  return performance.now() - s;
};
const tExist = (await t(ADMIN)) + (await t(ADMIN));
const tNone = (await t(`nobody-${tag}`)) + (await t(`nobody2-${tag}`));
check('帳號不存在也跑雜湊（時間差 < 40%）', Math.abs(tExist - tNone) / Math.max(tExist, tNone) < 0.4,
  `exist ${tExist.toFixed(0)}ms / none ${tNone.toFixed(0)}ms`);

// ---------- 壞輸入不該 500 ----------
r = await admin('GET', '/api/media/%E0%A4%A');
check('殘缺 URI 的 media → 404', r.status === 404, String(r.status));
r = await client()('GET', '/api/me', { rawCookie: 'kura_session=%E0%A4%A' });
check('殘缺 cookie → 401', r.status === 401, String(r.status));
r = await admin('PATCH', '/api/users/%E0%A4%A', { body: { displayName: 'x' } });
check('殘缺 URI 的 users PATCH → 404', r.status === 404, String(r.status));

// ---------- 建立測試帳號，必須先改密碼 ----------
const uname = `smoke-${tag}`;
r = await admin('POST', '/api/users', { body: { username: uname, displayName: '煙霧測試' } });
check('admin 建帳號 → 201 且回傳一次性密碼', r.status === 201 && typeof r.data.password === 'string', JSON.stringify(r.data));
const tempPw = r.data.password;
const user = client();
r = await user('POST', '/api/login', { body: { username: uname, password: tempPw } });
check('新帳號登入 → mustChangePw', r.status === 200 && r.data.me.mustChangePw === true, JSON.stringify(r.data));
r = await user('POST', '/api/posts', { body: { kind: 'ema', target: '2026-10-05', body: '未改密碼不能投稿' } });
check('未改密碼投稿 → 403', r.status === 403 && r.data.mustChangePw === true, `${r.status} ${JSON.stringify(r.data)}`);
const newPw = `Smoke-${tag}-Pw-2026`;
r = await user('POST', '/api/change-password', { body: { currentPassword: tempPw, newPassword: newPw } });
check('改密碼 → 200', r.status === 200, JSON.stringify(r.data));

// ---------- 投稿 ----------
r = await user('POST', '/api/posts', { body: { kind: 'ema', target: '2026-10-05', body: '煙霧測試繪馬', by: '測試' } });
check('掛繪馬 → 201', r.status === 201, JSON.stringify(r.data));
const emaId = r.data.post?.id;
r = await user('POST', '/api/posts', { body: { kind: 'comment', target: emaId, body: '留在繪馬上的留言' } });
check('在繪馬上留言 → 201', r.status === 201, JSON.stringify(r.data));
const cmtId = r.data.post?.id;
r = await user('POST', '/api/posts', { body: { kind: 'comment', target: 'JP-01-01', body: '展品留言' } });
check('展品留言 → 201', r.status === 201, JSON.stringify(r.data));
const exCmtId = r.data.post?.id;
r = await user('POST', '/api/posts', { body: { kind: 'comment', target: 'JP-99-99', body: 'x' } });
check('不存在的 target → 400', r.status === 400, String(r.status));
r = await user('POST', '/api/posts', { body: { kind: 'comment', target: 'JP-01-01', body: 'x'.repeat(301) } });
check('301 字 → 400', r.status === 400, String(r.status));

// ---------- 照片 ----------
const jpeg = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#c2332a' } })
  .withMetadata({ exif: { IFD0: { Artist: 'should-be-stripped' } } }).jpeg().toBuffer();
const fd = new FormData();
fd.append('file', new Blob([jpeg], { type: 'image/jpeg' }), 'smoke.jpg');
fd.append('day', '2026-10-06');
fd.append('caption', '煙霧測試照片');
r = await user('POST', '/api/photos', { form: fd });
check('上傳照片 → 201', r.status === 201, JSON.stringify(r.data));
const photo = r.data.photo;
if (photo) {
  const m = await fetch(`${BASE}/api/media/${photo.key}`);
  const buf = new Uint8Array(await m.arrayBuffer());
  check('media 可取回', m.status === 200, String(m.status));
  check('EXIF 已剝除', !Buffer.from(buf).includes('should-be-stripped'));
}

// ---------- 公開牆 ----------
r = await client()('GET', '/api/public/wall', { origin: null });
check('公開牆 → 200', r.status === 200, String(r.status));
const wall = r.data;
check('公開牆不含登入帳號名稱', !JSON.stringify(wall).includes(uname));
check('公開牆有測試繪馬與留言', wall.posts.some((p) => p.id === emaId) && wall.posts.some((p) => p.id === cmtId));

// ---------- 他人權限 ----------
const other = client();
r = await other('POST', '/api/login', { body: { username: ADMIN, password: ADMIN_PW } });
r = await user('DELETE', `/api/posts/${emaId}`);
check('本人刪自己的繪馬 → 200', r.status === 200, JSON.stringify(r.data));
r = await client()('GET', '/api/public/wall', { origin: null });
check('繪馬刪除後，掛在上面的留言不再公開', !r.data.posts.some((p) => p.id === cmtId));

// ---------- 收尾 ----------
if (photo) {
  r = await admin('DELETE', `/api/photos/${photo.id}`);
  check('admin 刪他人照片 → 200', r.status === 200, JSON.stringify(r.data));
  const m = await fetch(`${BASE}/api/media/${photo.key}`);
  check('刪除後 media → 404', m.status === 404, String(m.status));
}
for (const id of [cmtId, exCmtId].filter(Boolean)) await admin('DELETE', `/api/posts/${id}`);
r = await admin('PATCH', `/api/users/${uname}`, { body: { status: 'disabled' } });
check('停用測試帳號 → 200', r.status === 200, JSON.stringify(r.data));
r = await user('GET', '/api/me');
check('停用後 session 立即失效 → 401', r.status === 401, String(r.status));

console.log(`\n${pass} 通過、${fail} 失敗`);
process.exit(fail ? 1 : 0);
