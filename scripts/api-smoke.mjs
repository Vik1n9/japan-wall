#!/usr/bin/env node
// 後台 API 煙霧測試：對本機 wrangler dev（npm run dev:api）跑一輪完整流程，每次改後台都跑一次。
// 用法：KURA_ADMIN=<帳號> KURA_ADMIN_PW=<密碼> node scripts/api-smoke.mjs [http://localhost:8787]
// 會建立 smoke-* 測試帳號與投稿，跑完把測試帳號停用、測試內容刪除。只對本機用，不要指向正式站。
import sharp from 'sharp';
import zlib from 'node:zlib';

const BASE = process.argv[2] || 'http://localhost:8787';
const ORIGIN = new URL(BASE).origin; // 跟 BASE 同埠：wrangler dev 的 Origin 白名單才不會擋
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

// 改密碼的「目前密碼」也有限速：連錯 5 次鎖 15 分鐘（防 session 被偷後被暴力改密碼鎖掉真使用者）
{
  let st = 0;
  for (let i = 0; i < 5; i++) {
    st = (await user('POST', '/api/change-password', { body: { currentPassword: `wrong-pw-${i}`, newPassword: 'Hijack-Pass-123' } })).status;
  }
  check('目前密碼連錯 5 次 → 403', st === 403, String(st));
  r = await user('POST', '/api/change-password', { body: { currentPassword: newPw, newPassword: 'Hijack-Pass-123' } });
  check('鎖定後即使密碼正確 → 429', r.status === 429 && /分鐘/.test(r.data.error || ''), `${r.status} ${JSON.stringify(r.data)}`);
}

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
const extraPhotos = [];
const extraPosts = [];
const jpeg = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#c2332a' } })
  .withMetadata({ exif: { IFD0: { Artist: 'should-be-stripped' } } }).jpeg().toBuffer();
const fd = new FormData();
fd.append('file', new Blob([jpeg], { type: 'image/jpeg' }), 'smoke.jpg');
fd.append('day', '2026-10-06');
fd.append('caption', '煙霧測試照片');
fd.append('takenAt', '2026-10-06T13:40:05');
r = await user('POST', '/api/photos', { form: fd });
check('上傳照片 → 201', r.status === 201, JSON.stringify(r.data));
const photo = r.data.photo;
let photoCmtId = null;
if (photo) {
  const m = await fetch(`${BASE}/api/media/${photo.key}`);
  const buf = new Uint8Array(await m.arrayBuffer());
  check('media 可取回', m.status === 200, String(m.status));
  check('EXIF 已剝除', !Buffer.from(buf).includes('should-be-stripped'));
  check('拍攝時刻 takenAt 存起來', photo.takenAt === '2026-10-06T13:40:05', String(photo.takenAt));
  r = await user('POST', '/api/posts', { body: { kind: 'comment', target: photo.id, body: '照片留言', by: '測試' } });
  check('照片可以留言 → 201', r.status === 201, JSON.stringify(r.data));
  photoCmtId = r.data.post?.id ?? null;
  if (photoCmtId) {
    r = await user('POST', '/api/posts', { body: { kind: 'comment', target: photo.id, replyTo: photoCmtId, body: '照片回覆', by: '測試' } });
    check('照片留言可以回覆 → 201', r.status === 201, JSON.stringify(r.data));
    if (r.data.post?.id) extraPosts.push(r.data.post.id);
  }
}
{
  const f = new FormData();
  f.append('file', new Blob([jpeg], { type: 'image/jpeg' }), 'bad.jpg');
  f.append('day', '2026-10-06');
  f.append('takenAt', 'not-a-date');
  const rb = await user('POST', '/api/photos', { form: f });
  check('takenAt 格式不對 → 照樣上傳、存成 null', rb.status === 201 && rb.data.photo?.takenAt === null, JSON.stringify(rb.data.photo?.takenAt));
  if (rb.data.photo) extraPhotos.push(rb.data.photo.id);
}

// ---------- 各格式的 metadata 剝除（直接打 API，繞過瀏覽器縮圖這一層） ----------
async function uploadRaw(buf, mime, name) {
  const f = new FormData();
  f.append('file', new Blob([buf], { type: mime }), name);
  f.append('day', '2026-10-06');
  return user('POST', '/api/photos', { form: f });
}
async function fetchMedia(key) {
  return Buffer.from(await (await fetch(`${BASE}/api/media/${key}`)).arrayBuffer());
}
{
  // JPEG：EOI 之後的附加資料（iPhone 的第二張圖會帶自己的 EXIF）要整段丟掉；ICC 色彩描述保留、照樣能解碼
  const base = await sharp({ create: { width: 40, height: 30, channels: 3, background: '#336699' } })
    .withMetadata({ icc: 'p3', exif: { IFD0: { Copyright: 'jpeg-exif-secret' } } }).jpeg().toBuffer();
  const trailing = Buffer.concat([base, Buffer.from('trailing-secret-after-EOI')]);
  const r1 = await uploadRaw(trailing, 'image/jpeg', 't.jpg');
  check('JPEG（含 EOI 後附加資料）上傳 → 201', r1.status === 201, JSON.stringify(r1.data));
  if (r1.data.photo) {
    extraPhotos.push(r1.data.photo.id);
    const out = await fetchMedia(r1.data.photo.key);
    check('JPEG：EXIF 與 EOI 後的附加資料都剝除', !out.includes('jpeg-exif-secret') && !out.includes('trailing-secret'));
    const meta = await sharp(out).metadata().catch(() => null);
    check('JPEG：剝完仍可解碼、保留 ICC', !!meta && meta.width === 40 && !!meta.icc, JSON.stringify(meta && { w: meta.width, icc: !!meta.icc }));
  }
  // PNG：tEXt／iTXt／eXIf 剝除
  const png = await sharp({ create: { width: 20, height: 20, channels: 3, background: '#aa3311' } }).png().toBuffer();
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const iend = png.length - 12;
  const pngWithText = Buffer.concat([png.subarray(0, iend), chunk('tEXt', Buffer.from('Comment\0png-text-secret')), png.subarray(iend)]);
  const r2 = await uploadRaw(pngWithText, 'image/png', 't.png');
  check('PNG（含 tEXt）上傳 → 201', r2.status === 201, JSON.stringify(r2.data));
  if (r2.data.photo) {
    extraPhotos.push(r2.data.photo.id);
    const out = await fetchMedia(r2.data.photo.key);
    check('PNG：tEXt 剝除且可解碼', !out.includes('png-text-secret') && !!(await sharp(out).metadata().catch(() => null)));
  }
  // WebP：EXIF 區塊剝除、VP8X 旗標同步清掉
  const webp = await sharp({ create: { width: 24, height: 16, channels: 3, background: '#118844' } })
    .withMetadata({ exif: { IFD0: { Copyright: 'webp-exif-secret' } } }).webp().toBuffer();
  const r3 = await uploadRaw(webp, 'image/webp', 't.webp');
  check('WebP（含 EXIF）上傳 → 201', r3.status === 201, JSON.stringify(r3.data));
  if (r3.data.photo) {
    extraPhotos.push(r3.data.photo.id);
    const out = await fetchMedia(r3.data.photo.key);
    const meta = await sharp(out).metadata().catch(() => null);
    check('WebP：EXIF 剝除且可解碼', !out.includes('webp-exif-secret') && !!meta && meta.width === 24 && !meta.exif);
  }
  // 假冒副檔名
  const r4 = await uploadRaw(Buffer.from('GIF89a not really an image'), 'image/jpeg', 'x.jpg');
  check('非圖片內容 → 400', r4.status === 400, String(r4.status));
}

// ---------- 公開牆 ----------
r = await client()('GET', '/api/public/wall', { origin: null });
check('公開牆 → 200', r.status === 200, String(r.status));
const wall = r.data;
check('公開牆不含登入帳號名稱', !JSON.stringify(wall).includes(uname));
check('公開牆有測試繪馬與留言', wall.posts.some((p) => p.id === emaId) && wall.posts.some((p) => p.id === cmtId));
if (photo) {
  check('公開牆的照片帶拍攝時刻', wall.photos.find((p) => p.id === photo.id)?.takenAt === '2026-10-06T13:40:05');
  check('公開牆有照片上的留言', !!photoCmtId && wall.posts.some((p) => p.id === photoCmtId));
}

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
  r = await client()('GET', '/api/public/wall', { origin: null });
  check('照片刪除後，上面的留言不再公開', !r.data.posts.some((p) => p.id === photoCmtId));
  r = await user('POST', '/api/posts', { body: { kind: 'comment', target: photo.id, body: '刪掉後留言', by: '測試' } });
  check('已刪除的照片不能留言 → 400', r.status === 400, String(r.status));
}
for (const id of [cmtId, exCmtId, photoCmtId, ...extraPosts].filter(Boolean)) await admin('DELETE', `/api/posts/${id}`);
for (const id of extraPhotos) await admin('DELETE', `/api/photos/${id}`);
r = await admin('PATCH', `/api/users/${uname}`, { body: { status: 'disabled' } });
check('停用測試帳號 → 200', r.status === 200, JSON.stringify(r.data));
r = await user('GET', '/api/me');
check('停用後 session 立即失效 → 401', r.status === 401, String(r.status));

// ---------- 前台 Worker（選用：KURA_FRONT=http://localhost:8788，另開 npx wrangler dev --port 8788） ----------
const FRONT = process.env.KURA_FRONT;
if (FRONT && /localhost|127\.0\.0\.1/.test(FRONT)) {
  for (const path of ['/edit', '/edit/targets.json', '/admin', '/api/me', '/api/login', '/api/users']) {
    const res = await fetch(FRONT + path);
    check(`前台 ${path} → 404`, res.status === 404, String(res.status));
  }
  const pub = await fetch(`${FRONT}/api/public/wall`);
  const body = await pub.text();
  check('前台公開牆 → 200 且不含帳號名稱', pub.status === 200 && !body.includes('"author"'), String(pub.status));
}

console.log(`\n${pass} 通過、${fail} 失敗`);
process.exit(fail ? 1 : 0);
