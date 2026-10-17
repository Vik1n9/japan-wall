// 帳號管理（僅 admin）：GET/POST /api/users、PATCH /api/users/:username。
import { json, nowTaipeiIso, randomPassword, safeDecode } from '../lib/util';
import { destroyAllSessions, hashPassword, type UserRow } from '../lib/auth';
import { MIN_PASSWORD, readJsonBody, type AuthedCtx } from '../lib/http';

const USERNAME_RE = /^[a-z0-9_.-]{2,32}$/; // 與 scripts/admin-create.mjs 相同

export async function route(ctx: AuthedCtx): Promise<Response | null> {
  const { request, env, url, method, session } = ctx;
  if (url.pathname !== '/api/users' && !url.pathname.startsWith('/api/users/')) return null;
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
    const target = (safeDecode(patchMatch[1]) ?? '').toLowerCase();
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
