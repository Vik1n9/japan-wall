// 帳號密碼驗證核心：PBKDF2 雜湊、opaque session token、cookie、登入限速。
// 不使用 SESSION_SECRET：token 本身是 256-bit 隨機值，D1 只存 SHA-256 雜湊，可隨時撤銷。

import { randomTokenBase64url, safeDecode, safeEqual, sha256Hex, nowTaipeiIso } from './util';
import { ipRateKey } from './ip-subnet';

// Cloudflare 正式環境的 Web Crypto PBKDF2 上限是 100,000 次（本機 wrangler dev 不擋），超過會丟 NotSupportedError
const PBKDF2_ITERATIONS = 100_000;
const MAX_FAILS = 5;
const LOCK_MINUTES = 15;
export const SESSION_COOKIE = 'kura_session';
const SESSION_DAYS = 30;

export interface UserRow {
  username: string;
  display_name: string;
  password_hash: string;
  role: 'admin' | 'user';
  status: 'active' | 'disabled';
  must_change_pw: number;
  created_at: string;
}

export interface SessionUser {
  username: string;
  displayName: string;
  role: 'admin' | 'user';
  mustChangePw: boolean;
}

/* ---------- 密碼 ---------- */

export async function hashPassword(password: string, saltHex?: string): Promise<string> {
  const salt = saltHex
    ? new Uint8Array(saltHex.match(/.{2}/g)!.map((b) => parseInt(b, 16)))
    : crypto.getRandomValues(new Uint8Array(16));
  const hex = saltHex ?? [...salt].map((b) => b.toString(16).padStart(2, '0')).join('');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS },
    key,
    256,
  );
  const hashHex = [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `pbkdf2$${PBKDF2_ITERATIONS}$${hex}$${hashHex}`;
}

/** 帳號不存在時拿來比對的假雜湊：照樣跑一次 PBKDF2，回應時間才不會洩漏帳號是否存在 */
const DUMMY_HASH = `pbkdf2$${PBKDF2_ITERATIONS}$${'00'.repeat(16)}$${'00'.repeat(32)}`;

export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored) {
    await hashPassword(password, DUMMY_HASH.split('$')[2]);
    return false;
  }
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const expected = await hashPassword(password, parts[2]);
  return safeEqual(expected, stored);
}

/* ---------- Cookie ---------- */

export function parseCookies(header: string | null): Map<string, string> {
  const out = new Map<string, string>();
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const value = safeDecode(part.slice(i + 1).trim());
    if (value !== null) out.set(part.slice(0, i).trim(), value);
  }
  return out;
}

/** Secure 只在正式環境加。wrangler dev 會把 Host 改寫成 route 網域，無法用 hostname 判斷，
 *  改讀 .dev.vars 的 DEV_MODE=1（只存在本機，不會部署上去） */
export function sessionCookie(token: string | null, secure: boolean): string {
  const secureFlag = secure ? '; Secure' : '';
  if (token === null) {
    return `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secureFlag}`;
  }
  return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}${secureFlag}`;
}

/* ---------- Session ---------- */

export async function createSession(db: D1Database, username: string): Promise<string> {
  const token = randomTokenBase64url(32);
  const tokenHash = await sha256Hex(token);
  const { iso } = nowTaipeiIso();
  // 順手清掉過期的 session 與早已解鎖的登入失敗紀錄（登入頻率低，放這裡就夠，不必排程）
  await db.batch([
    db.prepare(`DELETE FROM sessions WHERE expires_at <= ?1`).bind(iso),
    db.prepare(`DELETE FROM login_attempts WHERE locked_until IS NOT NULL AND locked_until <= ?1`).bind(iso),
  ]);
  const expires = new Date(Date.now() + SESSION_DAYS * 86400_000 + 8 * 3600_000).toISOString().replace('Z', '+08:00');
  await db
    .prepare(`INSERT INTO sessions (token_hash, username, expires_at, created_at) VALUES (?1, ?2, ?3, ?4)`)
    .bind(tokenHash, username, expires, iso)
    .run();
  return token;
}

export async function getSessionUser(db: D1Database, request: Request): Promise<{ user: SessionUser; tokenHash: string } | null> {
  const token = parseCookies(request.headers.get('Cookie')).get(SESSION_COOKIE);
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  const { iso } = nowTaipeiIso();
  const row = await db
    .prepare(
      `SELECT u.username, u.display_name, u.role, u.status, u.must_change_pw
       FROM sessions s JOIN users u ON u.username = s.username
       WHERE s.token_hash = ?1 AND s.expires_at > ?2`,
    )
    .bind(tokenHash, iso)
    .first<{ username: string; display_name: string; role: 'admin' | 'user'; status: string; must_change_pw: number }>();
  if (!row || row.status !== 'active') return null;
  return {
    user: { username: row.username, displayName: row.display_name, role: row.role, mustChangePw: row.must_change_pw === 1 },
    tokenHash,
  };
}

export async function destroySession(db: D1Database, tokenHash: string): Promise<void> {
  await db.prepare(`DELETE FROM sessions WHERE token_hash = ?1`).bind(tokenHash).run();
}

/** 改密碼後把其他裝置全部登出，保留目前這個 session */
export async function destroyOtherSessions(db: D1Database, username: string, keepTokenHash: string): Promise<void> {
  await db
    .prepare(`DELETE FROM sessions WHERE username = ?1 AND token_hash != ?2`)
    .bind(username, keepTokenHash)
    .run();
}

/** admin 重設密碼/停用帳號時，把該使用者全部登出 */
export async function destroyAllSessions(db: D1Database, username: string): Promise<void> {
  await db.prepare(`DELETE FROM sessions WHERE username = ?1`).bind(username).run();
}

/* ---------- 登入限速 ---------- */

/** 回傳剩餘鎖定秒數；0 表示未鎖定 */
export async function loginLockSeconds(db: D1Database, key: string): Promise<number> {
  const row = await db
    .prepare(`SELECT fails, locked_until FROM login_attempts WHERE key = ?1`)
    .bind(key)
    .first<{ fails: number; locked_until: string | null }>();
  if (!row?.locked_until) return 0;
  const until = Date.parse(row.locked_until);
  const remain = Math.ceil((until - Date.now()) / 1000);
  return remain > 0 ? remain : 0;
}

export async function recordLoginFailure(
  db: D1Database,
  key: string,
  opts: { maxFails?: number; staleMinutes?: number } = {},
): Promise<void> {
  const maxFails = opts.maxFails ?? MAX_FAILS;
  const row = await db
    .prepare(`SELECT fails, locked_until, updated_at FROM login_attempts WHERE key = ?1`)
    .bind(key)
    .first<{ fails: number; locked_until: string | null; updated_at: string | null }>();
  // 鎖定期已過就重新起算：規格是「失敗 5 次鎖 15 分鐘」，不是「累積滿 5 次後每次失敗都再鎖」。
  // 不重設的話舊紀錄會永久累積，解鎖後再打錯一次密碼又立刻鎖 15 分鐘。
  const lockExpired = !!row?.locked_until && Date.parse(row.locked_until) <= Date.now();
  // staleMinutes：距離上次失敗（updated_at）超過這個分鐘數也重新起算（IP 層限速用）
  const stale =
    opts.staleMinutes !== undefined && !!row?.updated_at &&
    Date.now() - Date.parse(row.updated_at) > opts.staleMinutes * 60_000;
  const fails = row && !lockExpired && !stale ? row.fails + 1 : 1;
  const lockedUntil = fails >= maxFails
    ? new Date(Date.now() + LOCK_MINUTES * 60_000 + 8 * 3600_000).toISOString().replace('Z', '+08:00')
    : null;
  const { iso } = nowTaipeiIso();
  await db
    .prepare(
      `INSERT INTO login_attempts (key, fails, locked_until, updated_at) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(key) DO UPDATE SET fails = ?2, locked_until = ?3, updated_at = ?4`,
    )
    .bind(key, fails, lockedUntil, iso)
    .run();
}

export async function resetLoginFailures(db: D1Database, key: string): Promise<void> {
  await db.prepare(`DELETE FROM login_attempts WHERE key = ?1`).bind(key).run();
}

/* ---------- IP 層級限速 ----------
 * 在「帳號＋IP 5 次鎖 15 分鐘」之外另一層：同一個 IP 不論嘗試哪個帳號，
 * 失敗累計 20 次就鎖這個 IP 15 分鐘（擋分散帳號的密碼噴灑）。
 * 成功登入「不」歸零 IP 計數，否則攻擊者可以穿插自己的正確帳號來重置；
 * 計數改在鎖定到期後、或距離上次失敗超過 15 分鐘時重新起算（靠 updated_at）。 */

export const IP_MAX_FAILS = 20;

/** IP 層 key 前綴用 '#'：帳號名稱允許字元（a-z、0-9、_ . -）不可能出現 '#'，
 *  所以叫「ip」的帳號（帳號 key 'ip|<ip>'）不會跟 IP 層 key 撞名，
 *  停用帳號時的 `DELETE … WHERE key LIKE '<username>|%'` 也不會誤刪 IP 層紀錄。
 *  IP 經過 ipRateKey 正規化：IPv4 完整位址、IPv6 以 /64 網段計數
 *  （IPv6 隱私位址會每個連線都換尾碼，完整位址擋不住噴灑；原因詳見 ip-subnet.ts）。
 *  只影響 IP 層；「帳號＋IP」那層（'<username>|<ip>'）維持完整位址。 */
export function ipLockKey(ip: string): string {
  return `#ip|${ipRateKey(ip)}`;
}

export async function recordIpLoginFailure(db: D1Database, ip: string): Promise<void> {
  await recordLoginFailure(db, ipLockKey(ip), { maxFails: IP_MAX_FAILS, staleMinutes: LOCK_MINUTES });
}

/* ---------- 每日排程清理 ---------- */

/** 刪掉不在鎖定中、且最後失敗超過 1 天（或 updated_at 為 NULL 的舊資料）的登入失敗紀錄，
 *  以及已過期的 session。由 back.ts 的 scheduled handler 每天呼叫（cron 見 wrangler.back.jsonc）。
 *  兩張表各自獨立清理，不需要跨表原子性，所以用兩次 run 而非 batch。 */
export async function cleanupStaleAuthRows(db: D1Database): Promise<void> {
  const { iso } = nowTaipeiIso();
  const dayAgo = new Date(Date.now() - 86400_000 + 8 * 3600_000).toISOString().replace('Z', '+08:00');
  await db.prepare(`DELETE FROM sessions WHERE expires_at <= ?1`).bind(iso).run();
  await db
    .prepare(
      `DELETE FROM login_attempts
       WHERE (locked_until IS NULL OR locked_until <= ?1)
         AND (updated_at IS NULL OR updated_at <= ?2)`,
    )
    .bind(iso, dayAgo)
    .run();
}
