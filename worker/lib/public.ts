// 公開唯讀端點（雙域共用模組）：/api/public/wall 與 /api/media/:key。
// 前台 Worker（純展示）與後台 Worker（/edit 預覽同一面牆）import 同一份程式。
import { json } from './util';

export interface R2BucketLike {
  get(key: string): Promise<{ body: ReadableStream | null; httpMetadata?: { contentType?: string } } | null>;
  put(key: string, value: Uint8Array, opts?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  delete(key: string): Promise<void>;
}

export const MEDIA_KEY_RE = /^photos\/p-\d{8}-[a-z0-9]{4}\.(jpg|png|webp)$/;

/** 牆上所有 live 的親友照片與投稿（留言/繪馬），給前台動態注入用。
 *  一律不讓瀏覽器快取（no-cache）：剛投稿的人回到牆上要馬上看得到；前台另在 Worker 邊緣快取 60 秒擋流量。
 *  不回傳登入帳號名稱（author）：公開頁只需要顯示名稱與署名，帳號名稱外流等於替暴力登入省一半功夫 */
export async function publicWallResponse(db: D1Database): Promise<Response> {
  const [ph, po] = await Promise.all([
    db.prepare(
      `SELECT p.id, u.display_name AS author_name, p.day, p.caption, p.r2_key, p.mime, p.width, p.height, p.created_at
       FROM photos p JOIN users u ON u.username = p.author
       WHERE p.status = 'live'
       ORDER BY p.created_at ASC, p.id ASC`,
    ).all<{
      author_name: string; id: string; day: string; caption: string;
      r2_key: string; mime: string; width: number; height: number; created_at: string;
    }>(),
    db.prepare(
      // 掛在繪馬上的留言：繪馬被刪了就跟著不公開
      `SELECT p.id, p.kind, p.target, p.reply_to, p.by, p.body, p.posted_at
       FROM posts p
       WHERE p.status = 'live'
         AND (p.kind = 'ema' OR p.target NOT LIKE 'n-%'
              OR EXISTS (SELECT 1 FROM posts e WHERE e.id = p.target AND e.kind = 'ema' AND e.status = 'live'))
       ORDER BY p.posted_at ASC, p.id ASC`,
    ).all<{
      id: string; kind: string; target: string; reply_to: string | null; by: string;
      body: string; posted_at: string;
    }>(),
  ]);
  return json({
    photos: (ph.results || []).map((r) => ({
      id: r.id, authorName: r.author_name, day: r.day, caption: r.caption,
      key: r.r2_key, mime: r.mime, width: r.width, height: r.height, createdAt: r.created_at,
    })),
    posts: (po.results || []).map((r) => ({
      id: r.id, kind: r.kind, target: r.target, replyTo: r.reply_to, by: r.by,
      body: r.body, postedAt: r.posted_at,
    })),
  }, 200, { 'Cache-Control': 'no-cache' });
}

/** R2 物件串流：immutable 快取（key 含隨機碼、內容不可變） */
export async function mediaResponse(uploads: R2BucketLike, key: string): Promise<Response> {
  if (!MEDIA_KEY_RE.test(key)) return json({ error: '找不到此 API 路徑' }, 404);
  const obj = await uploads.get(key);
  if (!obj || !obj.body) return json({ error: '找不到檔案' }, 404);
  return new Response(obj.body, {
    headers: {
      'Content-Type': obj.httpMetadata?.contentType || 'application/octet-stream',
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
}
