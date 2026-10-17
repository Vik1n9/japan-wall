// 後台 Worker（kura.osaka2026.voriens.dev）：完整 API＋靜態資源。
// 階段 1：auth 核心（login / logout / me / change-password）。
// 之後階段在這裡加 users 管理、photos、posts、public/media。

import { json, nowTaipeiIso, randomCode, randomPassword, safeEqual } from './lib/util';
import { parseAndClean } from './lib/images';
import { mediaResponse, publicWallResponse, type R2BucketLike } from './lib/public';
import {
  createSession,
  destroyAllSessions,
  destroyOtherSessions,
  destroySession,
  getSessionUser,
  hashPassword,
  loginLockSeconds,
  recordLoginFailure,
  resetLoginFailures,
  sessionCookie,
  verifyPassword,
  type UserRow,
} from './lib/auth';

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  UPLOADS: R2BucketLike;
  ALLOWED_ORIGINS?: string;
  DAYS?: string;
  DEV_MODE?: string; // .dev.vars：本機開發時 "1"，cookie 不加 Secure（http://localhost 也要能收）
}

const DEFAULT_ALLOWED_ORIGINS = 'https://kura.osaka2026.voriens.dev,http://kura.osaka2026.voriens.dev,http://localhost:8787,http://localhost:4321';
const MIN_PASSWORD = 8;
const USERNAME_RE = /^[a-z0-9_.-]{2,32}$/; // 與 scripts/admin-create.mjs 相同
const MAX_UPLOAD = 8 * 1024 * 1024;
const MAX_SIDE = 2048;
const PHOTOS_PER_DAY = 20;
const CAPTION_MAX = 300;
const PHOTO_ID_RE = /^p-\d{8}-[a-z0-9]{4}$/;
const POST_BODY_MAX = 300;
const POST_BY_MAX = 20;
const POSTS_PER_DAY = 100;

function cleanSingleLine(s: string): string {
  return s.replace(/[\r\n\t]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** 投稿 body：去控制字元（保留換行）、CRLF 統一、修前後空白（舊 spec 3.6 沿用） */
function cleanPostBody(s: string): string {
  return s
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim();
}

/* ---------- targets 白名單：建置時產生的 public/edit/targets.json（前台 /edit* 已擋） ---------- */
let targetsCache: { exhibits: Set<string>; days: Set<string> } | null = null;
async function loadTargets(env: Env, request: Request): Promise<{ exhibits: Set<string>; days: Set<string> }> {
  if (targetsCache) return targetsCache;
  try {
    const res = await env.ASSETS.fetch(new Request(new URL('/edit/targets.json', request.url)));
    if (!res.ok) return { exhibits: new Set(), days: new Set() };
    const data = (await res.json()) as { exhibits: string[]; days: string[] };
    targetsCache = { exhibits: new Set(data.exhibits), days: new Set(data.days) };
  } catch {
    return { exhibits: new Set(), days: new Set() };
  }
  return targetsCache;
}

function clientIp(request: Request): string {
  return request.headers.get('CF-Connecting-IP') || 'local';
}

function originAllowed(request: Request, env: Env): boolean {
  const origin = request.headers.get('Origin');
  if (!origin) return false;
  const allowed = new Set(
    (env.ALLOWED_ORIGINS || DEFAULT_ALLOWED_ORIGINS)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  return allowed.has(origin);
}

async function readJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const parsed = await request.json();
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function mePayload(u: { username: string; displayName: string; role: string; mustChangePw: boolean }) {
  return { username: u.username, displayName: u.displayName, role: u.role, mustChangePw: u.mustChangePw };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) {
      return env.ASSETS.fetch(request);
    }

    const method = request.method.toUpperCase();

    // 所有變異請求檢查 Origin（CSRF 第一道；第二道是 SameSite=Lax cookie）
    // 注意：wrangler dev 會把同源 Origin 改寫成 http://<route hostname>，所以白名單含 http 版 kura（正式站是 https，瀏覽器不會送 http Origin，無風險）
    if (method !== 'GET' && method !== 'HEAD' && !originAllowed(request, env)) {
      return json({ error: 'Origin 不允許' }, 403);
    }

    /* ---------- POST /api/login ---------- */
    if (method === 'POST' && url.pathname === '/api/login') {
      const body = await readJsonBody(request);
      if (!body) return json({ error: '無效的 JSON' }, 400);
      const username = typeof body.username === 'string' ? body.username.trim().toLowerCase() : '';
      const password = typeof body.password === 'string' ? body.password : '';
      if (!username || !password) return json({ error: '請輸入帳號與密碼' }, 400);
      if (username.length > 32 || password.length > 128) return json({ error: '帳號或密碼格式錯誤' }, 400);

      const lockKey = `${username}|${clientIp(request)}`;
      const locked = await loginLockSeconds(env.DB, lockKey);
      if (locked > 0) {
        return json({ error: `失敗次數過多，請 ${Math.ceil(locked / 60)} 分鐘後再試` }, 429);
      }

      const user = await env.DB.prepare(`SELECT * FROM users WHERE username = ?1`)
        .bind(username)
        .first<UserRow>();

      // 帳號不存在也走一次雜湊，避免用回應時間分辨帳號是否存在
      if (!user || !(await verifyPassword(password, user.password_hash))) {
        await recordLoginFailure(env.DB, lockKey);
        return json({ error: '帳號或密碼錯誤' }, 401);
      }
      if (user.status !== 'active') {
        return json({ error: '帳號已停用，請聯絡管理員' }, 403);
      }

      await resetLoginFailures(env.DB, lockKey);
      const token = await createSession(env.DB, user.username);
      return json(
        { me: mePayload({ username: user.username, displayName: user.display_name, role: user.role, mustChangePw: user.must_change_pw === 1 }) },
        200,
        { 'Set-Cookie': sessionCookie(token, env.DEV_MODE !== '1') },
      );
    }

    /* ---------- GET /api/media/:key 與 /api/public/wall（公開唯讀，與前台共用模組） ---------- */
    if (method === 'GET' && url.pathname.startsWith('/api/media/')) {
      return mediaResponse(env.UPLOADS, decodeURIComponent(url.pathname.slice('/api/media/'.length)));
    }
    if (method === 'GET' && url.pathname === '/api/public/wall') {
      return publicWallResponse(env.DB);
    }

    /* ---------- 以下都需要 session ---------- */
    const session = await getSessionUser(env.DB, request);

    /* ---------- POST /api/logout ---------- */
    if (method === 'POST' && url.pathname === '/api/logout') {
      if (session) await destroySession(env.DB, session.tokenHash);
      return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(null, env.DEV_MODE !== '1') });
    }

    if (!session) {
      return json({ error: '未登入或驗證已過期' }, 401);
    }

    /* ---------- GET /api/me ---------- */
    if (method === 'GET' && url.pathname === '/api/me') {
      return json({ me: mePayload(session.user) });
    }

    /* ---------- POST /api/change-password ---------- */
    if (method === 'POST' && url.pathname === '/api/change-password') {
      const body = await readJsonBody(request);
      if (!body) return json({ error: '無效的 JSON' }, 400);
      const current = typeof body.currentPassword === 'string' ? body.currentPassword : '';
      const next = typeof body.newPassword === 'string' ? body.newPassword : '';
      if (!current || !next) return json({ error: '請輸入目前密碼與新密碼' }, 400);
      if (next.length < MIN_PASSWORD || next.length > 128) {
        return json({ error: `新密碼長度須為 ${MIN_PASSWORD}～128 字` }, 400);
      }
      if (safeEqual(current, next)) return json({ error: '新密碼不可與目前密碼相同' }, 400);

      const row = await env.DB.prepare(`SELECT password_hash FROM users WHERE username = ?1 AND status = 'active'`)
        .bind(session.user.username)
        .first<{ password_hash: string }>();
      if (!row || !(await verifyPassword(current, row.password_hash))) {
        return json({ error: '目前密碼不正確' }, 403);
      }

      const hash = await hashPassword(next);
      await env.DB
        .prepare(`UPDATE users SET password_hash = ?1, must_change_pw = 0 WHERE username = ?2`)
        .bind(hash, session.user.username)
        .run();
      await destroyOtherSessions(env.DB, session.user.username, session.tokenHash);
      return json({ ok: true });
    }

    /* ---------- 照片：GET/POST /api/photos、PUT/DELETE /api/photos/:id ---------- */
    const days = new Set((env.DAYS || '').split(',').map((s) => s.trim()).filter(Boolean));

    function photoDto(r: {
      id: string; author: string; author_name?: string; day: string; caption: string;
      r2_key: string; mime: string; width: number; height: number; created_at: string;
    }, mine: boolean) {
      return {
        id: r.id, author: r.author, authorName: r.author_name ?? r.author, day: r.day,
        caption: r.caption, key: r.r2_key, mime: r.mime, width: r.width, height: r.height,
        createdAt: r.created_at, mine,
      };
    }

    if (method === 'GET' && url.pathname === '/api/photos') {
      const { results } = await env.DB.prepare(
        `SELECT p.id, p.author, u.display_name AS author_name, p.day, p.caption, p.r2_key, p.mime, p.width, p.height, p.created_at
         FROM photos p JOIN users u ON u.username = p.author
         WHERE p.status = 'live'
         ORDER BY p.created_at DESC, p.id DESC`,
      ).all<{
        id: string; author: string; author_name: string; day: string; caption: string;
        r2_key: string; mime: string; width: number; height: number; created_at: string;
      }>();
      return json({
        photos: (results || []).map((r) => photoDto(r, r.author === session.user.username)),
      });
    }

    if (method === 'POST' && url.pathname === '/api/photos') {
      let form: FormData;
      try { form = await request.formData(); } catch { return json({ error: '請用 multipart/form-data 上傳' }, 400); }
      const file = form.get('file');
      if (!(file instanceof File) || file.size === 0) return json({ error: '沒有檔案' }, 400);
      if (file.size > MAX_UPLOAD) return json({ error: '檔案上限 8MB（上傳前會先在瀏覽器縮圖）' }, 413);

      const day = typeof form.get('day') === 'string' ? (form.get('day') as string).trim() : '';
      const caption = cleanSingleLine(typeof form.get('caption') === 'string' ? (form.get('caption') as string) : '');
      if (!days.has(day)) return json({ error: '指定的展覽日不存在' }, 400);
      if (caption.length > CAPTION_MAX) return json({ error: `說明上限 ${CAPTION_MAX} 字` }, 400);

      const buf = new Uint8Array(await file.arrayBuffer());
      const img = parseAndClean(buf);
      if (!img) return json({ error: '只接受 JPEG／PNG／WebP' }, 400);
      if (Math.max(img.width, img.height) > MAX_SIDE) {
        return json({ error: `長邊上限 ${MAX_SIDE}px——請透過頁面上傳介面（會自動縮圖）` }, 400);
      }

      const { ymd, datePrefix, iso } = nowTaipeiIso();
      const quota = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM photos WHERE author = ?1 AND status = 'live' AND created_at LIKE ?2`,
      ).bind(session.user.username, `${datePrefix}%`).first<{ n: number }>();
      if ((quota?.n ?? 0) >= PHOTOS_PER_DAY) {
        return json({ error: `一天最多上傳 ${PHOTOS_PER_DAY} 張照片` }, 429);
      }

      const id = `p-${ymd}-${randomCode(4)}`;
      const key = `photos/${id}.${img.ext}`;
      await env.UPLOADS.put(key, img.clean, { httpMetadata: { contentType: img.mime } });
      await env.DB.prepare(
        `INSERT INTO photos (id, author, day, caption, r2_key, mime, bytes, width, height, status, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'live', ?10)`,
      ).bind(id, session.user.username, day, caption, key, img.mime, img.clean.length, img.width, img.height, iso).run();

      return json({
        ok: true,
        photo: photoDto({
          id, author: session.user.username, author_name: session.user.displayName, day,
          caption, r2_key: key, mime: img.mime, width: img.width, height: img.height, created_at: iso,
        }, true),
      }, 201);
    }

    const photoMatch = url.pathname.match(/^\/api\/photos\/(p-\d{8}-[a-z0-9]{4})$/);
    if (photoMatch && (method === 'PUT' || method === 'DELETE')) {
      const id = photoMatch[1];
      const row = await env.DB.prepare(`SELECT * FROM photos WHERE id = ?1 AND status = 'live'`)
        .bind(id)
        .first<{ id: string; author: string; day: string; caption: string; r2_key: string; mime: string; width: number; height: number; created_at: string }>();
      if (!row) return json({ error: '照片不存在（或已刪除）' }, 404);
      const isOwner = row.author === session.user.username;
      const isAdmin = session.user.role === 'admin';
      if (!isOwner && !isAdmin) return json({ error: '只能管理自己的照片' }, 403);

      const { iso } = nowTaipeiIso();

      if (method === 'DELETE') {
        await env.DB.prepare(`UPDATE photos SET status = 'removed', updated_at = ?1 WHERE id = ?2`)
          .bind(iso, id).run();
        // 檔案一併刪除：刪除的意義就是不再公開（DB 列保留作 audit；若 R2 刪除失敗留孤兒檔，靠 backup/清理處理）
        try { await env.UPLOADS.delete(row.r2_key); } catch { /* 非致命 */ }
        return json({ ok: true });
      }

      // PUT：改 caption / day
      const body = await readJsonBody(request);
      if (!body) return json({ error: '無效的 JSON' }, 400);
      const sets: string[] = [];
      const values: (string | number)[] = [];
      if (typeof body.caption === 'string') {
        const caption = cleanSingleLine(body.caption);
        if (caption.length > CAPTION_MAX) return json({ error: `說明上限 ${CAPTION_MAX} 字` }, 400);
        sets.push(`caption = ?${values.length + 1}`); values.push(caption);
      }
      if (typeof body.day === 'string') {
        if (!days.has(body.day.trim())) return json({ error: '指定的展覽日不存在' }, 400);
        sets.push(`day = ?${values.length + 1}`); values.push(body.day.trim());
      }
      if (sets.length === 0) return json({ error: '沒有要更新的欄位' }, 400);
      sets.push(`updated_at = ?${values.length + 1}`); values.push(iso);
      values.push(id);
      await env.DB.prepare(`UPDATE photos SET ${sets.join(', ')} WHERE id = ?${values.length}`)
        .bind(...values).run();
      return json({ ok: true });
    }

    /* ---------- 投稿（留言/繪馬）：GET/POST /api/posts、PUT/DELETE /api/posts/:id ---------- */
    function postDto(r: {
      id: string; kind: string; target: string; reply_to: string | null; by: string;
      body: string; author: string; posted_at: string;
    }, mine: boolean) {
      return {
        id: r.id, kind: r.kind, target: r.target, replyTo: r.reply_to, by: r.by,
        body: r.body, author: r.author, postedAt: r.posted_at, mine,
      };
    }

    if (method === 'GET' && url.pathname === '/api/posts') {
      const { results } = await env.DB.prepare(
        `SELECT id, kind, target, reply_to, by, body, author, posted_at
         FROM posts WHERE status = 'live'
         ORDER BY posted_at ASC, id ASC`,
      ).all<{ id: string; kind: string; target: string; reply_to: string | null; by: string; body: string; author: string; posted_at: string }>();
      return json({ posts: (results || []).map((r) => postDto(r, r.author === session.user.username)) });
    }

    if (method === 'POST' && url.pathname === '/api/posts') {
      const body = await readJsonBody(request);
      if (!body) return json({ error: '無效的 JSON' }, 400);
      const kind = body.kind === 'ema' ? 'ema' : body.kind === 'comment' ? 'comment' : null;
      if (!kind) return json({ error: 'kind 須為 comment 或 ema' }, 400);
      const postBody = cleanPostBody(typeof body.body === 'string' ? body.body : '');
      if (!postBody || postBody.length > POST_BODY_MAX) {
        return json({ error: `內容須為 1～${POST_BODY_MAX} 字` }, 400);
      }
      const by = cleanSingleLine(typeof body.by === 'string' ? body.by : '');
      if (by.length > POST_BY_MAX) return json({ error: `署名須為 0～${POST_BY_MAX} 字` }, 400);
      const target = typeof body.target === 'string' ? body.target.trim() : '';

      const targets = await loadTargets(env, request);
      if (kind === 'ema') {
        if (!targets.days.has(target)) return json({ error: '指定的展覽日不存在' }, 400);
      } else {
        const isExhibit = targets.exhibits.has(target);
        let isEma = false;
        if (!isExhibit && /^n-\d{8}-[a-z0-9]{4}$/.test(target)) {
          const ema = await env.DB.prepare(`SELECT id FROM posts WHERE id = ?1 AND kind = 'ema' AND status = 'live'`)
            .bind(target).first();
          isEma = !!ema;
        }
        if (!isExhibit && !isEma) return json({ error: '留言的目標不存在' }, 400);
      }

      const replyTo = typeof body.replyTo === 'string' && body.replyTo ? body.replyTo.trim() : null;
      if (replyTo !== null) {
        if (kind !== 'comment') return json({ error: '只有留言可以回覆留言' }, 400);
        const parent = await env.DB.prepare(`SELECT id, kind, target FROM posts WHERE id = ?1 AND status = 'live'`)
          .bind(replyTo).first<{ id: string; kind: string; target: string }>();
        if (!parent || parent.kind !== 'comment' || parent.target !== target) {
          return json({ error: '回覆目標須是同一 target 下的另一則留言' }, 400);
        }
      }

      const { ymd, datePrefix, iso } = nowTaipeiIso();
      const quota = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM posts WHERE author = ?1 AND status = 'live' AND posted_at LIKE ?2`,
      ).bind(session.user.username, `${datePrefix}%`).first<{ n: number }>();
      if ((quota?.n ?? 0) >= POSTS_PER_DAY) return json({ error: `一天最多 ${POSTS_PER_DAY} 則投稿` }, 429);

      const id = `n-${ymd}-${randomCode(4)}`;
      await env.DB.prepare(
        `INSERT INTO posts (id, kind, target, reply_to, by, body, author, status, posted_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'live', ?8)`,
      ).bind(id, kind, target, replyTo, by, postBody, session.user.username, iso).run();
      return json({
        ok: true,
        post: postDto({ id, kind, target, reply_to: replyTo, by, body: postBody, author: session.user.username, posted_at: iso }, true),
      }, 201);
    }

    const postMatch = url.pathname.match(/^\/api\/posts\/(n-\d{8}-[a-z0-9]{4})$/);
    if (postMatch && (method === 'PUT' || method === 'DELETE')) {
      const id = postMatch[1];
      const row = await env.DB.prepare(`SELECT * FROM posts WHERE id = ?1 AND status = 'live'`)
        .bind(id)
        .first<{ id: string; kind: string; target: string; reply_to: string | null; by: string; body: string; author: string; posted_at: string }>();
      if (!row) return json({ error: '投稿不存在（或已刪除）' }, 404);
      if (row.author !== session.user.username && session.user.role !== 'admin') {
        return json({ error: '只能管理自己的投稿' }, 403);
      }
      const { iso } = nowTaipeiIso();
      if (method === 'DELETE') {
        await env.DB.prepare(`UPDATE posts SET status = 'removed', updated_at = ?1 WHERE id = ?2`).bind(iso, id).run();
        return json({ ok: true });
      }
      const body = await readJsonBody(request);
      if (!body) return json({ error: '無效的 JSON' }, 400);
      const sets: string[] = [];
      const values: (string | number)[] = [];
      if (typeof body.body === 'string') {
        const next = cleanPostBody(body.body);
        if (!next || next.length > POST_BODY_MAX) return json({ error: `內容須為 1～${POST_BODY_MAX} 字` }, 400);
        sets.push(`body = ?${values.length + 1}`); values.push(next);
      }
      if (typeof body.by === 'string') {
        const next = cleanSingleLine(body.by);
        if (next.length > POST_BY_MAX) return json({ error: `署名須為 0～${POST_BY_MAX} 字` }, 400);
        sets.push(`by = ?${values.length + 1}`); values.push(next);
      }
      if (sets.length === 0) return json({ error: '沒有要更新的欄位' }, 400);
      sets.push(`updated_at = ?${values.length + 1}`); values.push(iso);
      values.push(id);
      await env.DB.prepare(`UPDATE posts SET ${sets.join(', ')} WHERE id = ?${values.length}`).bind(...values).run();
      return json({ ok: true });
    }

    /* ---------- 帳號管理（僅 admin）：/api/users ---------- */
    if (url.pathname === '/api/users' || url.pathname.startsWith('/api/users/')) {
      if (session.user.role !== 'admin') {
        return json({ error: '需要管理員權限' }, 403);
      }

      /* GET /api/users — 帳號列表 */
      if (method === 'GET' && url.pathname === '/api/users') {
        const { results } = await env.DB.prepare(
          `SELECT username, display_name, role, status, must_change_pw, created_at
           FROM users ORDER BY created_at ASC`,
        ).all<{
          username: string; display_name: string; role: string; status: string;
          must_change_pw: number; created_at: string;
        }>();
        return json({
          users: (results || []).map((u) => ({
            username: u.username,
            displayName: u.display_name,
            role: u.role,
            status: u.status,
            mustChangePw: u.must_change_pw === 1,
            createdAt: u.created_at,
          })),
        });
      }

      /* POST /api/users — 建立帳號（密碼可留空由系統產生，只回傳一次） */
      if (method === 'POST' && url.pathname === '/api/users') {
        const body = await readJsonBody(request);
        if (!body) return json({ error: '無效的 JSON' }, 400);
        const username = typeof body.username === 'string' ? body.username.trim().toLowerCase() : '';
        const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : '';
        const role = body.role === 'admin' ? 'admin' : 'user';
        let password = typeof body.password === 'string' ? body.password : '';
        const generated = password === '';
        if (generated) password = randomPassword();

        if (!USERNAME_RE.test(username)) {
          return json({ error: '帳號限 2–32 字的小寫 a-z、0-9、_ . -' }, 400);
        }
        if (!displayName || displayName.length > 20) {
          return json({ error: '顯示名稱須為 1～20 字' }, 400);
        }
        if (password.length < MIN_PASSWORD || password.length > 128) {
          return json({ error: `密碼長度須為 ${MIN_PASSWORD}～128 字` }, 400);
        }
        const exists = await env.DB.prepare(`SELECT username FROM users WHERE username = ?1`)
          .bind(username).first();
        if (exists) return json({ error: '帳號已存在' }, 409);

        const { iso } = nowTaipeiIso();
        const hash = await hashPassword(password);
        await env.DB
          .prepare(
            `INSERT INTO users (username, display_name, password_hash, role, status, must_change_pw, created_at)
             VALUES (?1, ?2, ?3, ?4, 'active', 1, ?5)`,
          )
          .bind(username, displayName, hash, role, iso)
          .run();
        return json({ ok: true, username, ...(generated ? { password } : {}) }, 201);
      }

      /* PATCH /api/users/:username — 重設密碼、停用/啟用、改角色、改顯示名稱 */
      const patchMatch = url.pathname.match(/^\/api\/users\/([^/]+)$/);
      if (method === 'PATCH' && patchMatch) {
        const target = decodeURIComponent(patchMatch[1]).toLowerCase();
        const body = await readJsonBody(request);
        if (!body) return json({ error: '無效的 JSON' }, 400);
        const row = await env.DB.prepare(`SELECT * FROM users WHERE username = ?1`).bind(target).first<UserRow>();
        if (!row) return json({ error: '帳號不存在' }, 404);

        const isSelf = target === session.user.username;
        const nextStatus = body.status === 'active' || body.status === 'disabled' ? body.status : null;
        const nextRole = body.role === 'admin' || body.role === 'user' ? body.role : null;
        const nextDisplayName = typeof body.displayName === 'string' ? body.displayName.trim() : null;
        const wantsNewPassword = body.resetPassword === true || typeof body.newPassword === 'string';

        if (nextStatus === null && nextRole === null && nextDisplayName === null && !wantsNewPassword) {
          return json({ error: '沒有要更新的欄位' }, 400);
        }
        if (nextDisplayName !== null && (!nextDisplayName || nextDisplayName.length > 20)) {
          return json({ error: '顯示名稱須為 1～20 字' }, 400);
        }

        // 防鎖死：不可停用/降級自己；也不可停用/降級最後一位可用 admin
        const losingAdmin =
          (nextStatus === 'disabled' && row.status === 'active' && row.role === 'admin') ||
          (nextRole === 'user' && row.role === 'admin');
        if (losingAdmin) {
          if (isSelf) return json({ error: '不可停用或降級自己的帳號' }, 400);
          const others = await env.DB.prepare(
            `SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND status = 'active' AND username != ?1`,
          ).bind(target).first<{ n: number }>();
          if (!others || others.n < 1) {
            return json({ error: '不可停用或降級最後一位管理員' }, 400);
          }
        }

        const sets: string[] = [];
        const values: (string | number)[] = [];
        if (nextStatus !== null && nextStatus !== row.status) {
          sets.push(`status = ?${values.length + 1}`); values.push(nextStatus);
        }
        if (nextRole !== null && nextRole !== row.role) {
          sets.push(`role = ?${values.length + 1}`); values.push(nextRole);
        }
        if (nextDisplayName !== null && nextDisplayName !== row.display_name) {
          sets.push(`display_name = ?${values.length + 1}`); values.push(nextDisplayName);
        }

        let newPassword: string | null = null;
        if (wantsNewPassword) {
          newPassword = typeof body.newPassword === 'string' && body.newPassword !== ''
            ? body.newPassword
            : randomPassword();
          if (newPassword.length < MIN_PASSWORD || newPassword.length > 128) {
            return json({ error: `密碼長度須為 ${MIN_PASSWORD}～128 字` }, 400);
          }
          sets.push(`password_hash = ?${values.length + 1}`); values.push(await hashPassword(newPassword));
          sets.push(`must_change_pw = 1`);
        }
        if (sets.length === 0) return json({ ok: true });

        values.push(target);
        await env.DB.prepare(`UPDATE users SET ${sets.join(', ')} WHERE username = ?${values.length}`)
          .bind(...values).run();

        // 停用或重設密碼 → 該帳號所有 session 立即失效
        if (nextStatus === 'disabled' || newPassword !== null) {
          await destroyAllSessions(env.DB, target);
          await env.DB.prepare(`DELETE FROM login_attempts WHERE key LIKE ?1`).bind(`${target}|%`).run();
        }
        return json({ ok: true, ...(newPassword !== null ? { password: newPassword } : {}) });
      }

      return json({ error: '找不到此 API 路徑' }, 404);
    }

    return json({ error: '找不到此 API 路徑' }, 404);
  },
};
