// 公開唯讀端點（雙域共用模組）：/api/public/wall 與 /api/media/:key。
// 前台 Worker（純展示）與後台 Worker（/edit 預覽同一面牆）import 同一份程式。
import { json } from './util';

export interface R2BucketLike {
  get(key: string): Promise<{ body: ReadableStream | null; httpMetadata?: { contentType?: string } } | null>;
  put(key: string, value: Uint8Array, opts?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  delete(key: string): Promise<void>;
}

export const MEDIA_KEY_RE = /^photos\/p-\d{8}-[a-z0-9]{4}\.(jpg|png|webp)$/;

/** 牆上所有 live 的親友照片與投稿（留言/繪馬），給前台動態注入用 */
export async function publicWallResponse(db: D1Database): Promise<Response> {
  const [ph, po] = await Promise.all([
    db.prepare(
      `SELECT p.id, p.author, u.display_name AS author_name, p.day, p.caption, p.r2_key, p.mime, p.width, p.height, p.created_at
       FROM photos p JOIN users u ON u.username = p.author
       WHERE p.status = 'live'
       ORDER BY p.created_at ASC, p.id ASC`,
    ).all<{
      id: string; author: string; author_name: string; day: string; caption: string;
      r2_key: string; mime: string; width: number; height: number; created_at: string;
    }>(),
    db.prepare(
      `SELECT id, kind, target, reply_to, by, body, author, posted_at
       FROM posts WHERE status = 'live'
       ORDER BY posted_at ASC, id ASC`,
    ).all<{
      id: string; kind: string; target: string; reply_to: string | null; by: string;
      body: string; author: string; posted_at: string;
    }>(),
  ]);
  return json({
    photos: (ph.results || []).map((r) => ({
      id: r.id, author: r.author, authorName: r.author_name, day: r.day, caption: r.caption,
      key: r.r2_key, mime: r.mime, width: r.width, height: r.height, createdAt: r.created_at,
    })),
    posts: (po.results || []).map((r) => ({
      id: r.id, kind: r.kind, target: r.target, replyTo: r.reply_to, by: r.by,
      body: r.body, author: r.author, postedAt: r.posted_at,
    })),
  }, 200, { 'Cache-Control': 'public, max-age=60' });
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
