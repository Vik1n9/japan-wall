// 公開唯讀端點（雙域共用模組）：/api/public/wall 與 /api/media/:key。
// 前台 Worker（純展示）與後台 Worker（/edit 預覽同一面牆）import 同一份程式。
import { json } from './util';

export type R2RangeLike = { offset: number; length?: number } | { suffix: number };
export interface R2BucketLike {
  get(key: string, opts?: { range?: R2RangeLike }): Promise<{ body: ReadableStream | null; size: number; httpMetadata?: { contentType?: string } } | null>;
  head(key: string): Promise<{ size: number } | null>;
  put(key: string, value: Uint8Array, opts?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  delete(key: string): Promise<void>;
}

export const MEDIA_KEY_RE = /^photos\/p-\d{8}-[a-z0-9]{4}(-poster)?\.(jpg|png|webp|mp4)$/;

/** 牆上所有 live 的照片與投稿（留言/繪馬），給前台動態注入用。
 *  一律不讓瀏覽器快取（no-cache）：剛投稿的人回到牆上要馬上看得到；前台另在 Worker 邊緣快取 60 秒擋流量。
 *  不回傳登入帳號名稱（author）：公開頁只需要顯示名稱與署名，帳號名稱外流等於替暴力登入省一半功夫 */
export async function publicWallResponse(db: D1Database): Promise<Response> {
  const [ph, po] = await Promise.all([
    db.prepare(
      `SELECT p.id, u.display_name AS author_name, p.day, p.caption, p.r2_key, p.mime, p.width, p.height, p.taken_at, p.created_at,
              p.kind, p.duration, p.poster_key
       FROM photos p JOIN users u ON u.username = p.author
       WHERE p.status = 'live'
       ORDER BY p.created_at ASC, p.id ASC`,
    ).all<{
      author_name: string; id: string; day: string; caption: string;
      r2_key: string; mime: string; width: number; height: number; taken_at: string | null; created_at: string;
      kind: string; duration: number | null; poster_key: string | null;
    }>(),
    db.prepare(
      // 掛在繪馬或照片上的留言：繪馬／照片被刪了就跟著不公開
      `SELECT p.id, p.kind, p.target, p.reply_to, p.by, p.body, p.posted_at
       FROM posts p
       WHERE p.status = 'live'
         AND (p.kind = 'ema' OR (p.target NOT LIKE 'n-%' AND p.target NOT LIKE 'p-%')
              OR EXISTS (SELECT 1 FROM posts e WHERE e.id = p.target AND e.kind = 'ema' AND e.status = 'live')
              OR EXISTS (SELECT 1 FROM photos ph WHERE ph.id = p.target AND ph.status = 'live'))
       ORDER BY p.posted_at ASC, p.id ASC`,
    ).all<{
      id: string; kind: string; target: string; reply_to: string | null; by: string;
      body: string; posted_at: string;
    }>(),
  ]);
  return json({
    photos: (ph.results || []).map((r) => ({
      id: r.id, authorName: r.author_name, day: r.day, caption: r.caption,
      key: r.r2_key, mime: r.mime, width: r.width, height: r.height, takenAt: r.taken_at, createdAt: r.created_at,
      kind: r.kind, duration: r.duration, posterKey: r.poster_key, // 拍攝地點（lat／lon）刻意不回傳
    })),
    posts: (po.results || []).map((r) => ({
      id: r.id, kind: r.kind, target: r.target, replyTo: r.reply_to, by: r.by,
      body: r.body, postedAt: r.posted_at,
    })),
  }, 200, { 'Cache-Control': 'no-cache' });
}

/** 「bytes=a-b」「bytes=a-」「bytes=-n」→ R2 range；格式不對回 null（當作沒帶 Range） */
function parseRange(h: string | null): R2RangeLike | null {
  const m = h?.match(/^bytes=(\d*)-(\d*)$/);
  if (!m || (!m[1] && !m[2])) return null;
  if (!m[1]) return { suffix: Number(m[2]) };
  const start = Number(m[1]);
  return m[2] ? { offset: start, length: Number(m[2]) - start + 1 } : { offset: start };
}

/** R2 物件串流：immutable 快取（key 含隨機碼、內容不可變）。支援 Range：影片在 Safari 一定要 206 才能播 */
export async function mediaResponse(uploads: R2BucketLike, key: string, request?: Request): Promise<Response> {
  if (!MEDIA_KEY_RE.test(key)) return json({ error: '找不到此 API 路徑' }, 404);
  const headers = (type?: string) => ({
    'Content-Type': type || 'application/octet-stream',
    'Cache-Control': 'public, max-age=31536000, immutable',
    'Accept-Ranges': 'bytes',
  });
  const range = parseRange(request?.headers.get('Range') ?? null);
  if (range) {
    const head = await uploads.head(key);
    if (!head) return json({ error: '找不到檔案' }, 404);
    const size = head.size;
    const start = 'suffix' in range ? Math.max(0, size - range.suffix) : range.offset;
    const end = 'suffix' in range ? size - 1 : Math.min(size - 1, range.length ? range.offset + range.length - 1 : size - 1);
    if (start >= size || end < start) {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    }
    const obj = await uploads.get(key, { range: { offset: start, length: end - start + 1 } });
    if (!obj || !obj.body) return json({ error: '找不到檔案' }, 404);
    return new Response(obj.body, {
      status: 206,
      headers: { ...headers(obj.httpMetadata?.contentType), 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) },
    });
  }
  const obj = await uploads.get(key);
  if (!obj || !obj.body) return json({ error: '找不到檔案' }, 404);
  return new Response(obj.body, { headers: { ...headers(obj.httpMetadata?.contentType), 'Content-Length': String(obj.size) } });
}
