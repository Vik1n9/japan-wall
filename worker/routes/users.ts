// 帳號管理（僅 admin）：GET/POST /api/users、GET /api/users/:username/content、
// PATCH（改狀態／角色／名稱／密碼）、DELETE（無內容立即刪／有內容軟刪除）與 POST .../restore。
import { json, nowTaipeiIso, randomPassword, safeDecode } from '../lib/util';
import { destroyAllSessions, hashPassword, type UserRow } from '../lib/auth';
import { hardDeleteUser, purgeAtFor } from '../lib/user-purge';
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
      `SELECT username, display_name, role, status, must_change_pw, created_at, last_login_at, deleted_at
       FROM users ORDER BY created_at ASC`,
    ).all<{
      username: string; display_name: string; role: string; status: string;
      must_change_pw: number; created_at: string; last_login_at: string | null; deleted_at: string | null;
    }>();
    return json({
      users: (results || []).map((u) => ({
        username: u.username,
        displayName: u.display_name,
        role: u.role,
        status: u.status,
        mustChangePw: u.must_change_pw === 1,
        createdAt: u.created_at,
        lastLoginAt: u.last_login_at,
        deletedAt: u.deleted_at,
        purgeAt: u.deleted_at ? purgeAtFor(u.deleted_at) : null, // 軟刪除期滿、排程會永久刪除的時刻
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

  /* GET /api/users/:username/content — 刪除前預覽：該帳號目前有多少「公開中」的內容。
   *  只算 status='live'（已從牆上移除的列不會被公開，刪除模式由 live 數決定）。 */
  const contentMatch = url.pathname.match(/^\/api\/users\/([^/]+)\/content$/);
  if (method === 'GET' && contentMatch) {
    const target = (safeDecode(contentMatch[1]) ?? '').toLowerCase();
    const exists = await env.DB.prepare(`SELECT username FROM users WHERE username = ?1`).bind(target).first();
    if (!exists) return json({ error: '帳號不存在' }, 404);
    const [media, posts] = await Promise.all([
      env.DB.prepare(
        `SELECT SUM(CASE WHEN kind = 'video' THEN 1 ELSE 0 END) AS videos,
                SUM(CASE WHEN kind = 'video' THEN 0 ELSE 1 END) AS photos
         FROM photos WHERE author = ?1 AND status = 'live'`,
      ).bind(target).first<{ videos: number | null; photos: number | null }>(),
      env.DB.prepare(
        `SELECT SUM(CASE WHEN kind = 'ema' THEN 1 ELSE 0 END) AS emas,
                SUM(CASE WHEN kind = 'ema' THEN 0 ELSE 1 END) AS comments
         FROM posts WHERE author = ?1 AND status = 'live'`,
      ).bind(target).first<{ emas: number | null; comments: number | null }>(),
    ]);
    return json({
      photos: media?.photos ?? 0,
      videos: media?.videos ?? 0,
      comments: posts?.comments ?? 0,
      emas: posts?.emas ?? 0,
    });
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
      // 帳號名稱允許 '_'（LIKE 的單字元萬用字元）：不跳脫的話，停用 a_b 會順帶刪掉 axb 的
      // 登入失敗計數、把別人的鎖解掉。IP 層 key 是 '#ip|…'，前綴不同本來就不會被掃到。
      const escaped = target.replace(/[\\%_]/g, (c) => `\\${c}`);
      await env.DB.prepare(`DELETE FROM login_attempts WHERE key LIKE ?1 ESCAPE '\\'`).bind(`${escaped}|%`).run();
    }
    return json({ ok: true, ...(newPassword !== null ? { password: newPassword } : {}) });
  }

  /* POST /api/users/:username/restore — 取消軟刪除：清掉 deleted_at，帳號回到刪除前的狀態
   *  （軟刪除不動 status，所以清掉即恢復），內容也重新公開。 */
  const restoreMatch = url.pathname.match(/^\/api\/users\/([^/]+)\/restore$/);
  if (method === 'POST' && restoreMatch) {
    const target = (safeDecode(restoreMatch[1]) ?? '').toLowerCase();
    const row = await env.DB.prepare(`SELECT username, deleted_at FROM users WHERE username = ?1`)
      .bind(target)
      .first<{ username: string; deleted_at: string | null }>();
    if (!row) return json({ error: '帳號不存在' }, 404);
    if (row.deleted_at === null) return json({ error: '帳號不在待刪除狀態' }, 409);
    await env.DB.prepare(`UPDATE users SET deleted_at = NULL WHERE username = ?1`).bind(target).run();
    return json({ ok: true });
  }

  /* DELETE /api/users/:username — 刪除帳號，依「實際內容數」決定兩種做法（不信任前端）：
   *   沒有內容（四項 live 都是 0）→ 立刻硬刪。
   *   有內容 → 沒有帶 { confirm: 'content' } 就 409 並附上數量；有帶才軟刪除（30 天後排程清除）。
   *  軟刪除中的帳號再呼叫則 409（要先 restore 或等排程）。 */
  const delMatch = url.pathname.match(/^\/api\/users\/([^/]+)$/);
  if (method === 'DELETE' && delMatch) {
    const target = (safeDecode(delMatch[1]) ?? '').toLowerCase();
    if (target === session.user.username) return json({ error: '不可刪除自己的帳號' }, 400);
    const row = await env.DB.prepare(`SELECT username, role, status, deleted_at FROM users WHERE username = ?1`)
      .bind(target)
      .first<{ username: string; role: string; status: string; deleted_at: string | null }>();
    if (!row) return json({ error: '帳號不存在' }, 404);
    if (row.deleted_at !== null) return json({ error: '帳號已在待刪除狀態，請先恢復或等排程清除' }, 409);

    // 沿用 PATCH 的防鎖死：不可刪掉最後一位可用（active 且未刪除）管理員。
    // 刪自己已在上方擋掉，所以呼叫者本身一定是 active admin，這裡實質上是保險。
    if (row.role === 'admin' && row.status === 'active') {
      const others = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND status = 'active' AND deleted_at IS NULL AND username != ?1`,
      ).bind(target).first<{ n: number }>();
      if (!others || others.n < 1) return json({ error: '不可刪除最後一位管理員' }, 400);
    }

    // 實際內容數（live）由伺服器算；介面顯示的數字只是提示，不能拿來決定模式
    const [media, posts] = await Promise.all([
      env.DB.prepare(
        `SELECT SUM(CASE WHEN kind = 'video' THEN 1 ELSE 0 END) AS videos,
                SUM(CASE WHEN kind = 'video' THEN 0 ELSE 1 END) AS photos
         FROM photos WHERE author = ?1 AND status = 'live'`,
      ).bind(target).first<{ videos: number | null; photos: number | null }>(),
      env.DB.prepare(
        `SELECT SUM(CASE WHEN kind = 'ema' THEN 1 ELSE 0 END) AS emas,
                SUM(CASE WHEN kind = 'ema' THEN 0 ELSE 1 END) AS comments
         FROM posts WHERE author = ?1 AND status = 'live'`,
      ).bind(target).first<{ emas: number | null; comments: number | null }>(),
    ]);
    const content = {
      photos: media?.photos ?? 0,
      videos: media?.videos ?? 0,
      comments: posts?.comments ?? 0,
      emas: posts?.emas ?? 0,
    };
    const hasContent = content.photos + content.videos + content.comments + content.emas > 0;

    if (!hasContent) {
      // 沒有內容：立刻硬刪（沒有 live 內容，剩下的列都是先前已移除的，R2 檔案也已刪過）
      await hardDeleteUser(env, target);
      return json({ ok: true, mode: 'deleted' });
    }

    const body = await readJsonBody(request);
    if (body?.confirm !== 'content') {
      return json({ error: '帳號仍有內容，需確認連同內容一起刪除', content }, 409);
    }

    // 有內容且已確認：軟刪除。deleted_at 設現在時刻、立刻刪掉所有 session 讓它登出，
    // 內容與 R2 物件都保留，30 天後由排程永久刪除；清掉 deleted_at 即可完全恢復。
    const { iso } = nowTaipeiIso();
    await env.DB.batch([
      env.DB.prepare(`UPDATE users SET deleted_at = ?1 WHERE username = ?2`).bind(iso, target),
      env.DB.prepare(`DELETE FROM sessions WHERE username = ?1`).bind(target),
    ]);
    return json({ ok: true, mode: 'scheduled', purgeAt: purgeAtFor(iso) });
  }

  return json({ error: '找不到此 API 路徑' }, 404);
}
