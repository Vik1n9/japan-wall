// 共用小工具：JSON 回應、台北時區時間、隨機碼、SHA-256。

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers,
    },
  });
}

/** 台北時區（+08:00）的 ISO 時間與日期前綴，沿用舊系統慣例 */
export function nowTaipeiIso(): { iso: string; ymd: string; datePrefix: string } {
  const ms = Date.now() + 8 * 3600_000;
  const d = new Date(ms);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  const datePrefix = `${yyyy}-${mm}-${dd}`;
  return { iso: `${datePrefix}T${hh}:${mi}:${ss}+08:00`, ymd: `${yyyy}${mm}${dd}`, datePrefix };
}

const BASE36 = '0123456789abcdefghijklmnopqrstuvwxyz';

export function randomCode(len = 4): string {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < len; i++) out += BASE36[bytes[i] % 36];
  return out;
}

/** 隨機 token（base64url），預設 32 bytes = 256-bit 熵 */
export function randomTokenBase64url(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let bin = '';
  for (const b of buf) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 固定時間字串比較，避免 timing attack */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
