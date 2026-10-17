// 後台 Worker（kura.osaka2026.voriens.dev）：完整 API＋靜態資源。
// 階段 1：auth 核心（login / logout / me / change-password）。
// 之後階段在這裡加 users 管理、photos、posts、public/media。

import { json, nowTaipeiIso, randomPassword, safeEqual } from './lib/util';
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
  ALLOWED_ORIGINS?: string;
  DEV_MODE?: string; // .dev.vars：本機開發時 "1"，cookie 不加 Secure（http://localhost 也要能收）
}

const DEFAULT_ALLOWED_ORIGINS = 'https://kura.osaka2026.voriens.dev,http://kura.osaka2026.voriens.dev,http://localhost:8787,http://localhost:4321';
const MIN_PASSWORD = 8;
const USERNAME_RE = /^[a-z0-9_.-]{2,32}$/; // 與 scripts/admin-create.mjs 相同

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
