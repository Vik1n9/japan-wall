#!/usr/bin/env node
// 後台 API 煙霧測試：對本機 wrangler dev（npm run dev:api）跑一輪完整流程，每次改後台都跑一次。
// 用法：KURA_ADMIN=<帳號> KURA_ADMIN_PW=<密碼> node scripts/api-smoke.mjs [http://localhost:8787]
// 會建立 smoke-* 測試帳號與投稿，跑完把測試帳號停用、測試內容刪除。只對本機用，不要指向正式站。
import sharp from 'sharp';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

/** 簡易 cookie jar：一個 client 一個 session；cfIp 預設用這次執行專用的假 IP */
function client() {
  let cookie = '';
  return async function call(method, path, { body, form, origin = ORIGIN, rawCookie, cfIp = SMOKE_IP } = {}) {
    const headers = {};
    if (origin) headers.Origin = origin;
    if (cfIp) headers['CF-Connecting-IP'] = cfIp;
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
// wrangler dev 會原樣傳遞 CF-Connecting-IP（實測過；正式環境 Cloudflare 會覆寫，偽造無效）。
// 整份測試的請求都掛同一個「這一次執行專用」的假 IP：除了貼近正式行為，
// 也避免所有失敗登入都累積在 IP 'local' 上，觸發 IP 層限速（20 次）而污染下一次執行。
const fakeIp = (n) => `198.18.${(parseInt(tag, 36) % 250) + 1}.${n}`;
const SMOKE_IP = fakeIp(1);
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

// ---------- 影片（直接打 API，繞過瀏覽器轉檔：伺服器要能自己剝 metadata） ----------
let video = null;
{
  const dir = mkdtempSync(join(tmpdir(), 'kura-vid-'));
  const mk = (name, secs, extra = []) => {
    const out = join(dir, name);
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
      '-t', String(secs), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', ...extra, out]);
    return readFileSync(out);
  };
  // iPhone 式 metadata：拍攝時間＋GPS；moov 放前面（faststart），剝掉後 mdat 位移要修正
  const gpsVid = mk('gps.mp4', 2, ['-movflags', '+faststart+use_metadata_tags',
    '-metadata', 'com.apple.quicktime.creationdate=2026-10-07T15:20:30+0900',
    '-metadata', 'com.apple.quicktime.location.ISO6709=+34.8572+135.4867+100.000/', '-metadata', 'comment=video-secret']);
  const poster = await sharp({ create: { width: 32, height: 24, channels: 3, background: '#224466' } }).jpeg().toBuffer();
  const upVideo = (buf, opts = {}) => {
    const f = new FormData();
    f.append('kind', 'video');
    f.append('file', new Blob([buf], { type: 'video/mp4' }), 'v.mp4');
    if (opts.poster !== false) f.append('poster', new Blob([poster], { type: 'image/jpeg' }), 'p.jpg');
    f.append('day', '2026-10-07');
    f.append('caption', opts.caption ?? '煙霧測試影片');
    return user('POST', '/api/photos', { form: f });
  };
  r = await upVideo(gpsVid);
  check('上傳影片 → 201', r.status === 201, JSON.stringify(r.data));
  video = r.data.photo ?? null;
  if (video) {
    extraPhotos.push(video.id);
    check('影片：kind／長度／尺寸／封面', video.kind === 'video' && Math.abs(video.duration - 2) < 0.2 && video.width === 320 && video.height === 240 && !!video.posterKey,
      JSON.stringify({ k: video.kind, d: video.duration, w: video.width, h: video.height, p: video.posterKey }));
    check('影片：剝除前讀出拍攝時間（伺服器端）', video.takenAt === '2026-10-07T15:20:30', String(video.takenAt));
    check('影片：API 不回傳拍攝地點', !('lat' in video) && !JSON.stringify(video).includes('34.857'));
    const m = await fetch(`${BASE}/api/media/${video.key}`);
    const out = Buffer.from(await m.arrayBuffer());
    check('影片：可取回、型別 video/mp4', m.status === 200 && m.headers.get('content-type') === 'video/mp4', `${m.status} ${m.headers.get('content-type')}`);
    check('影片：GPS、拍攝時間、comment 都剝除', !out.includes('34.857') && !out.includes('video-secret') && !out.includes('creationdate'));
    const outFile = join(dir, 'out.mp4');
    (await import('node:fs')).writeFileSync(outFile, out);
    let decoded = true;
    try { execFileSync('ffmpeg', ['-v', 'error', '-i', outFile, '-f', 'null', '-']); } catch { decoded = false; }
    const streams = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', outFile]).toString();
    check('影片：剝完仍可完整解碼、保留聲音', decoded && streams.includes('audio') && streams.includes('video'), streams.replace(/\n/g, ' '));
    const rg = await fetch(`${BASE}/api/media/${video.key}`, { headers: { Range: 'bytes=0-99' } });
    const part = Buffer.from(await rg.arrayBuffer());
    check('影片：Range 請求回 206', rg.status === 206 && part.length === 100 && (rg.headers.get('content-range') || '').startsWith('bytes 0-99/'),
      `${rg.status} ${part.length} ${rg.headers.get('content-range')}`);
    const pm = await fetch(`${BASE}/api/media/${video.posterKey}`);
    check('影片：封面可取回', pm.status === 200, String(pm.status));
  }
  r = await upVideo(mk('long.mp4', 62));
  check('影片超過 60 秒 → 400', r.status === 400, `${r.status} ${JSON.stringify(r.data)}`);
  r = await upVideo(mk('np.mp4', 1), { poster: false });
  check('影片沒附封面 → 400', r.status === 400, String(r.status));
  r = await upVideo(Buffer.from('not a video at all, just text'));
  check('不是 MP4 → 400', r.status === 400, String(r.status));
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

// ---------- 帳號管理的保護與邊界 ----------
r = await admin('PATCH', `/api/users/${ADMIN}`, { body: { status: 'disabled' } });
check('admin 停用自己 → 400', r.status === 400, `${r.status} ${JSON.stringify(r.data)}`);
r = await admin('PATCH', `/api/users/${ADMIN}`, { body: { role: 'user' } });
check('admin 降級自己 → 400', r.status === 400, `${r.status} ${JSON.stringify(r.data)}`);
r = await admin('GET', '/api/me');
check('自我保護擋下後 admin session 仍有效', r.status === 200 && r.data.me?.role === 'admin', String(r.status));
r = await admin('PATCH', `/api/users/nobody-${tag}`, { body: { status: 'disabled' } });
check('PATCH 不存在的帳號 → 404', r.status === 404, String(r.status));
r = await admin('PATCH', `/api/users/${uname}`, { body: {} });
check('PATCH 沒有欄位 → 400', r.status === 400, String(r.status));
{
  const roleUser = `role-${tag}`;
  r = await admin('POST', '/api/users', { body: { username: roleUser, displayName: '角色測試' } });
  check('建立角色測試帳號 → 201', r.status === 201, String(r.status));
  r = await admin('PATCH', `/api/users/${roleUser}`, { body: { role: 'admin' } });
  check('升為管理員 → 200', r.status === 200, `${r.status} ${JSON.stringify(r.data)}`);
  r = await admin('PATCH', `/api/users/${roleUser}`, { body: { role: 'user' } });
  check('降回用戶（還有其他管理員）→ 200', r.status === 200, `${r.status} ${JSON.stringify(r.data)}`);
  r = await admin('PATCH', `/api/users/${roleUser}`, { body: { status: 'disabled' } });
  check('停用角色測試帳號 → 200', r.status === 200, String(r.status));
}

// ---------- 登入限速：同帳號＋IP 連錯 5 次 → 429 鎖 15 分鐘 ----------
const lockName = `lock-${tag}`;
r = await admin('POST', '/api/users', { body: { username: lockName, displayName: '限速測試' } });
check('建立限速測試帳號 → 201', r.status === 201, String(r.status));
{
  const lockPw = r.data.password;
  const lc = client();
  let st = 0;
  for (let i = 0; i < 5; i++) {
    st = (await lc('POST', '/api/login', { body: { username: lockName, password: `bad-${i}` } })).status;
  }
  check('登入連錯 5 次密碼 → 401', st === 401, String(st));
  r = await lc('POST', '/api/login', { body: { username: lockName, password: lockPw } });
  check('第 6 次即使密碼正確 → 429 鎖定', r.status === 429 && /分鐘/.test(r.data.error || ''), `${r.status} ${JSON.stringify(r.data)}`);
  r = await client()('POST', '/api/login', { body: { username: ADMIN, password: ADMIN_PW } });
  check('鎖定只針對該帳號＋IP，不影響其他帳號', r.status === 200, String(r.status));
  r = await admin('PATCH', `/api/users/${lockName}`, { body: { status: 'disabled' } });
  check('停用限速測試帳號 → 200', r.status === 200, String(r.status));
}

// ---------- IP 層級限速：同一 IP 不論帳號，累計失敗 20 次 → 鎖 IP 15 分鐘 ----------
{
  // 每個情境用不同的假 IP（wrangler dev 原樣傳遞 CF-Connecting-IP），互不干擾也不污染其他測試
  const ipA = fakeIp(10);
  const ipB = fakeIp(11);
  const ipC = fakeIp(12);
  let st = 0;
  for (let i = 0; i < 20; i++) {
    // 每次換不存在的帳號：避免先觸發「帳號＋IP 5 次」那層鎖，確定測到的是 IP 層
    st = (await client()('POST', '/api/login', { body: { username: `iplock-${tag}-${i}`, password: 'bad' }, cfIp: ipA })).status;
  }
  check('同一 IP 對不同帳號連錯 20 次 → 401', st === 401, String(st));
  r = await client()('POST', '/api/login', { body: { username: ADMIN, password: ADMIN_PW }, cfIp: ipA });
  check('第 21 次即使帳號密碼正確 → 429（IP 被鎖）', r.status === 429 && /分鐘/.test(r.data.error || ''), `${r.status} ${JSON.stringify(r.data)}`);
  r = await client()('POST', '/api/login', { body: { username: ADMIN, password: ADMIN_PW }, cfIp: ipB });
  check('IP 鎖只針對該 IP，另一個 IP 不受影響 → 200', r.status === 200, String(r.status));

  // 成功登入不歸零 IP 計數（否則攻擊者可穿插自己的正確帳號重置）
  for (let i = 0; i < 19; i++) {
    await client()('POST', '/api/login', { body: { username: `ipreset-${tag}-${i}`, password: 'bad' }, cfIp: ipC });
  }
  r = await client()('POST', '/api/login', { body: { username: ADMIN, password: ADMIN_PW }, cfIp: ipC });
  check('IP 計數 19 時成功登入 → 200', r.status === 200, String(r.status));
  st = (await client()('POST', '/api/login', { body: { username: `ipreset-${tag}-x`, password: 'bad' }, cfIp: ipC })).status;
  check('成功登入後再失敗一次（累計滿 20）→ 401 且觸發 IP 鎖', st === 401, String(st));
  r = await client()('POST', '/api/login', { body: { username: ADMIN, password: ADMIN_PW }, cfIp: ipC });
  check('成功登入沒有歸零 IP 計數：第 21 次正確密碼也 429', r.status === 429 && /分鐘/.test(r.data.error || ''), `${r.status} ${JSON.stringify(r.data)}`);
}

// ---------- 帳號名稱「ip」不會跟 IP 層 key 撞名（#ip| 前綴） ----------
{
  const ipD = fakeIp(13);
  r = await admin('POST', '/api/users', { body: { username: 'ip', displayName: '撞名測試' } });
  check('建立名為 ip 的帳號 → 201（或已存在 409）', r.status === 201 || r.status === 409, String(r.status));
  // 前次執行可能已停用：先確保是 active，停用時的 login_attempts 清理（LIKE 'ip|%'）才真的會跑到
  r = await admin('PATCH', '/api/users/ip', { body: { status: 'active' } });
  check('啟用帳號 ip → 200', r.status === 200, String(r.status));
  let st = 0;
  for (let i = 0; i < 5; i++) {
    st = (await client()('POST', '/api/login', { body: { username: 'ip', password: `bad-${i}` }, cfIp: ipD })).status;
  }
  check('對帳號 ip 連錯 5 次 → 401（IP 層同步累計 5 次）', st === 401, String(st));
  r = await admin('PATCH', '/api/users/ip', { body: { status: 'disabled' } });
  check('停用帳號 ip → 200', r.status === 200, String(r.status));
  // 停用會 DELETE key LIKE 'ip|%'（帳號層紀錄）；IP 層 key 是 #ip|<ip>，不能被一起刪掉。
  // 同一 IP 再用其他帳號錯 15 次：若 IP 計數還在（5+15=20）就會鎖，被誤刪則只有 15 次不會鎖
  for (let i = 0; i < 15; i++) {
    st = (await client()('POST', '/api/login', { body: { username: `ipmix-${tag}-${i}`, password: 'bad' }, cfIp: ipD })).status;
  }
  r = await client()('POST', '/api/login', { body: { username: ADMIN, password: ADMIN_PW }, cfIp: ipD });
  check('停用帳號 ip 沒有清掉 IP 層計數：湊滿 20 次後正確密碼也 429', r.status === 429 && /分鐘/.test(r.data.error || ''), `${r.status} ${JSON.stringify(r.data)}`);
}

// ---------- 防點擊劫持：/admin、/edit 不可被框架嵌入；公開牆（/）不加 ----------
{
  const frameHeaders = async (path) => {
    const res = await fetch(BASE + path, { redirect: 'manual' });
    return { status: res.status, xfo: res.headers.get('x-frame-options'), csp: res.headers.get('content-security-policy') };
  };
  for (const path of ['/admin', '/admin/', '/edit', '/edit/']) {
    const h = await frameHeaders(path);
    check(`防點擊劫持 ${path}：X-Frame-Options DENY＋frame-ancestors 'none'`,
      h.xfo === 'DENY' && /^frame-ancestors 'none'$/.test(h.csp || ''), JSON.stringify(h));
  }
  const root = await frameHeaders('/');
  check('公開牆（/）沒有框架限制', root.status === 200 && root.xfo === null && root.csp === null, JSON.stringify(root));
}

// ---------- 展品短片 Range（靜態資源 /media/*.mp4：Safari 的 <video> 要 206 才播得到） ----------
// 從 public/media 挑一支短片與一張照片（build 後 dist 內容相同；前台與後台 Worker 都要測）
const mediaRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'media');
const findMedia = (ext) => {
  for (const day of readdirSync(mediaRoot).sort()) {
    const dir = join(mediaRoot, day);
    if (!statSync(dir).isDirectory()) continue;
    const hit = readdirSync(dir).filter((f) => f.endsWith(ext)).sort()[0];
    if (hit) return `/media/${day}/${hit}`;
  }
  return null;
};
const vidPath = findMedia('.mp4');
const webpPath = findMedia('.webp');
const vidBuf = vidPath ? readFileSync(join(mediaRoot, vidPath.slice('/media/'.length))) : null;

async function checkAssetRange(base, label) {
  if (!vidPath || !vidBuf) { check(`${label}：找到展品短片`, false, 'public/media 裡沒有 mp4'); return; }
  const vidUrl = base + vidPath;
  const size = vidBuf.length;
  let res = await fetch(vidUrl, { headers: { Range: 'bytes=100-199' } });
  let part = Buffer.from(await res.arrayBuffer());
  check(`${label}：短片 Range bytes=100-199 → 206、bytes 正確`,
    res.status === 206 && part.equals(vidBuf.subarray(100, 200))
    && res.headers.get('content-range') === `bytes 100-199/${size}`
    && Number(res.headers.get('content-length')) === 100
    && res.headers.get('accept-ranges') === 'bytes',
    `${res.status} ${res.headers.get('content-range')} len=${res.headers.get('content-length')} got=${part.length}`);
  check(`${label}：短片 206 保留 Content-Type 與快取 header`,
    res.headers.get('content-type') === 'video/mp4' && /max-age=86400/.test(res.headers.get('cache-control') || ''),
    `${res.headers.get('content-type')} / ${res.headers.get('cache-control')}`);
  res = await fetch(vidUrl);
  const full = Buffer.from(await res.arrayBuffer());
  check(`${label}：短片不帶 Range → 200 完整檔且 Accept-Ranges: bytes`,
    res.status === 200 && res.headers.get('accept-ranges') === 'bytes' && full.equals(vidBuf), String(res.status));
  res = await fetch(vidUrl, { headers: { Range: 'bytes=-50' } });
  part = Buffer.from(await res.arrayBuffer());
  check(`${label}：短片尾段 Range bytes=-50 → 206 最後 50 bytes`,
    res.status === 206 && part.equals(vidBuf.subarray(size - 50))
    && res.headers.get('content-range') === `bytes ${size - 50}-${size - 1}/${size}`,
    `${res.status} ${res.headers.get('content-range')} got=${part.length}`);
  res = await fetch(vidUrl, { headers: { Range: `bytes=${size}-${size + 100}` } });
  await res.arrayBuffer();
  check(`${label}：短片 Range 超出檔案 → 416 且 Content-Range: bytes */${size}`,
    res.status === 416 && res.headers.get('content-range') === `bytes */${size}`,
    `${res.status} ${res.headers.get('content-range')}`);
  res = await fetch(vidUrl, { headers: { Range: 'bytes=abc' } });
  part = Buffer.from(await res.arrayBuffer());
  check(`${label}：短片格式不對的 Range → 200 完整檔`, res.status === 200 && part.length === size, String(res.status));
  if (webpPath) {
    res = await fetch(base + webpPath);
    await res.arrayBuffer();
    check(`${label}：照片（webp）等其他靜態檔行為不變 → 200、不走 Range 處理`,
      res.status === 200 && res.headers.get('accept-ranges') === null,
      `${res.status} accept-ranges=${res.headers.get('accept-ranges')}`);
  }
}
await checkAssetRange(BASE, '後台');

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
  await checkAssetRange(FRONT, '前台');
}

console.log(`\n${pass} 通過、${fail} 失敗`);
process.exit(fail ? 1 : 0);
