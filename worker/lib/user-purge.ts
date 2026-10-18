// 帳號的永久刪除（硬刪）與 30 天排程清除。
// 軟刪除（users.deleted_at 設值）期間資料完全保留；滿 USER_PURGE_DAYS 天後由排程真的刪掉。
import { isoFromMs } from './util';
import type { R2BucketLike } from './public';

/** 軟刪除後保留的天數，期滿由排程永久刪除（Viking 決定 2026-10-19）。 */
export const USER_PURGE_DAYS = 30;

/** 軟刪除時刻 → 永久刪除時刻（deleted_at + USER_PURGE_DAYS）。 */
export function purgeAtFor(deletedAtIso: string): string {
  return isoFromMs(Date.parse(deletedAtIso) + USER_PURGE_DAYS * 86400_000);
}

/** 刪除用的環境（後台 Worker 的 Env 有 DB 與 UPLOADS）。 */
export type PurgeEnv = { DB: D1Database; UPLOADS: R2BucketLike };

/**
 * 永久刪除一個帳號的所有痕跡：R2 物件（照片／影片本體、影片封面）、photos／posts 列、
 * sessions、login_attempts（只刪 '<username>|…'，跳脫 _ % 且不碰 '#ip|…'）、最後 users 列。
 * D1 用一次 batch（原子性）；R2 刪除失敗非致命（記 console.error，留孤兒檔靠備份／清理處理）。
 */
export async function hardDeleteUser(
  env: PurgeEnv,
  username: string,
): Promise<{ photos: number; posts: number; sessions: number; r2Failed: number }> {
  // R2 key 要在列刪掉之前先查
  const { results: media } = await env.DB.prepare(`SELECT r2_key, poster_key FROM photos WHERE author = ?1`)
    .bind(username)
    .all<{ r2_key: string; poster_key: string | null }>();
  const keys = (media || []).flatMap((m) => [m.r2_key, ...(m.poster_key ? [m.poster_key] : [])]);

  const escaped = username.replace(/[\\%_]/g, (c) => `\\${c}`);
  const results = await env.DB.batch([
    env.DB.prepare(`DELETE FROM photos WHERE author = ?1`).bind(username),
    env.DB.prepare(`DELETE FROM posts WHERE author = ?1`).bind(username),
    env.DB.prepare(`DELETE FROM sessions WHERE username = ?1`).bind(username),
    env.DB.prepare(`DELETE FROM login_attempts WHERE key LIKE ?1 ESCAPE '\\'`).bind(`${escaped}|%`),
    env.DB.prepare(`DELETE FROM users WHERE username = ?1`).bind(username),
  ]);
  const changes = results.map((res) => res.meta?.changes ?? 0);

  let r2Failed = 0;
  for (const key of keys) {
    try {
      await env.UPLOADS.delete(key);
    } catch (err) {
      r2Failed++;
      console.error('R2 刪除失敗', key, err);
    }
  }
  return { photos: changes[0] ?? 0, posts: changes[1] ?? 0, sessions: changes[2] ?? 0, r2Failed };
}

/**
 * 30 天排程清除：找 deleted_at 早於（now − USER_PURGE_DAYS）的帳號，逐一硬刪。
 * now 可用 number(ms) 或 Date 注入，方便測試；回傳清除數與 R2 失敗數。
 * 單一帳號失敗只記 log、不中斷其他帳號。
 */
export async function purgeDeletedUsers(
  env: PurgeEnv,
  now: number | Date = Date.now(),
): Promise<{ purged: number; r2Failed: number }> {
  const nowMs = typeof now === 'number' ? now : now.getTime();
  const cutoff = isoFromMs(nowMs - USER_PURGE_DAYS * 86400_000); // 同位移 ISO，字串比較即可
  const { results } = await env.DB.prepare(
    `SELECT username FROM users WHERE deleted_at IS NOT NULL AND deleted_at <= ?1`,
  )
    .bind(cutoff)
    .all<{ username: string }>();

  let purged = 0;
  let r2Failed = 0;
  for (const u of results || []) {
    try {
      const r = await hardDeleteUser(env, u.username);
      r2Failed += r.r2Failed;
      purged++;
    } catch (err) {
      console.error('清除待刪除帳號失敗', u.username, err);
    }
  }
  return { purged, r2Failed };
}
