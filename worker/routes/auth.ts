// 登入／登出／me／變更密碼。
import { json, nowTaipeiIso, safeEqual } from '../lib/util';
import {
  createSession,
  destroyOtherSessions,
  destroySession,
  hashPassword,
  ipLockKey,
  loginLockSeconds,
  recordIpLoginFailure,
  recordLoginFailure,
  resetLoginFailures,
  sessionCookie,
  verifyPassword,
  type UserRow,
} from '../lib/auth';
import { MIN_PASSWORD, clientIp, readJsonBody, type AuthedCtx, type Ctx } from '../lib/http';

export function mePayload(u: { username: string; displayName: string; role: string; mustChangePw: boolean }) {
  return { username: u.username, displayName: u.displayName, role: u.role, mustChangePw: u.mustChangePw };
}

/** POST /api/login（不需 session） */
export async function login({ request, env }: Ctx): Promise<Response> {
  const body = await readJsonBody(request);
  if (!body) return json({ error: '無效的 JSON' }, 400);
  const username = typeof body.username === 'string' ? body.username.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!username || !password) return json({ error: '請輸入帳號與密碼' }, 400);
  if (username.length > 32 || password.length > 128) return json({ error: '帳號或密碼格式錯誤' }, 400);

  const ip = clientIp(request);
  const lockKey = `${username}|${ip}`;
  const ipKey = ipLockKey(ip);
  const locked = await loginLockSeconds(env.DB, lockKey);
  if (locked > 0) {
    return json({ error: `失敗次數過多，請 ${Math.ceil(locked / 60)} 分鐘後再試` }, 429);
  }
  // IP 層：同一個 IP 不論試哪個帳號，累計失敗 20 次鎖 15 分鐘（擋分散帳號的密碼噴灑）
  const ipLocked = await loginLockSeconds(env.DB, ipKey);
  if (ipLocked > 0) {
    return json({ error: `失敗次數過多，請 ${Math.ceil(ipLocked / 60)} 分鐘後再試` }, 429);
  }

  const user = await env.DB.prepare(`SELECT * FROM users WHERE username = ?1`)
    .bind(username)
    .first<UserRow>();

  // 帳號不存在也走一次雜湊（verifyPassword 收到空值會比對假雜湊），避免用回應時間分辨帳號是否存在。
  // 軟刪除中的帳號與「密碼錯誤」回應完全相同，不透露帳號是否還存在。
  const passwordOk = await verifyPassword(password, user?.password_hash);
  if (!user || user.deleted_at !== null || !passwordOk) {
    await recordLoginFailure(env.DB, lockKey);
    await recordIpLoginFailure(env.DB, ip);
    return json({ error: '帳號或密碼錯誤' }, 401);
  }
  if (user.status !== 'active') {
    return json({ error: '帳號已停用，請聯絡管理員' }, 403);
  }

  // 只歸零「帳號＋IP」的計數；IP 計數不歸零，否則攻擊者可以穿插自己的正確帳號來重置
  await resetLoginFailures(env.DB, lockKey);
  const token = await createSession(env.DB, user.username);
  await env.DB.prepare(`UPDATE users SET last_login_at = ?1 WHERE username = ?2`)
    .bind(nowTaipeiIso().iso, user.username).run();
  return json(
    { me: mePayload({ username: user.username, displayName: user.display_name, role: user.role, mustChangePw: user.must_change_pw === 1 }) },
    200,
    { 'Set-Cookie': sessionCookie(token, env.DEV_MODE !== '1') },
  );
}

/** POST /api/logout（沒有 session 也回 ok，順便清 cookie） */
export async function logout({ env }: Ctx, tokenHash: string | null): Promise<Response> {
  if (tokenHash) await destroySession(env.DB, tokenHash);
  return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(null, env.DEV_MODE !== '1') });
}

/** GET /api/me */
export function me({ session }: AuthedCtx): Response {
  return json({ me: mePayload(session.user) });
}

/** POST /api/change-password：改完把其他裝置全部登出。
 *  目前密碼錯誤也計入限速（與登入同一套：同帳號＋IP 5 次鎖 15 分鐘，key 多一段 |pw| 分開計），
 *  否則拿到 session cookie 的人可以無限次試目前密碼，改成功後就把真正的使用者整個鎖在門外。 */
export async function changePassword({ request, env, session }: AuthedCtx): Promise<Response> {
  const lockKey = `${session.user.username}|pw|${clientIp(request)}`;
  const locked = await loginLockSeconds(env.DB, lockKey);
  if (locked > 0) {
    return json({ error: `失敗次數過多，請 ${Math.ceil(locked / 60)} 分鐘後再試` }, 429);
  }

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
    await recordLoginFailure(env.DB, lockKey);
    return json({ error: '目前密碼不正確' }, 403);
  }
  await resetLoginFailures(env.DB, lockKey);

  const hash = await hashPassword(next);
  await env.DB
    .prepare(`UPDATE users SET password_hash = ?1, must_change_pw = 0 WHERE username = ?2`)
    .bind(hash, session.user.username)
    .run();
  await destroyOtherSessions(env.DB, session.user.username, session.tokenHash);
  return json({ ok: true });
}
