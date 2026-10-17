// 後台 Worker（kura.osaka2026.voriens.dev）：完整 API＋靜態資源。
// 階段 1：auth 核心（login / logout / me / change-password）。
// 之後階段在這裡加 users 管理、photos、posts、public/media。

import { json, safeEqual } from './lib/util';
import {
  createSession,
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

    return json({ error: '找不到此 API 路徑' }, 404);
  },
};
