// 親友照片：GET/POST /api/photos、PUT/DELETE /api/photos/:id。
import { json, nowTaipeiIso } from '../lib/util';
import { parseAndClean } from '../lib/images';
import { cleanSingleLine, freshId, readJsonBody, type AuthedCtx } from '../lib/http';

const MAX_UPLOAD = 8 * 1024 * 1024;
const MAX_SIDE = 2048;
const PHOTOS_PER_DAY = 20;
const CAPTION_MAX = 300;

type PhotoRow = {
  id: string; author: string; author_name?: string; day: string; caption: string;
  r2_key: string; mime: string; width: number; height: number; created_at: string;
};

function photoDto(r: PhotoRow, mine: boolean) {
  return {
    id: r.id, author: r.author, authorName: r.author_name ?? r.author, day: r.day,
    caption: r.caption, key: r.r2_key, mime: r.mime, width: r.width, height: r.height,
    createdAt: r.created_at, mine,
  };
}

/** 牆上的展覽日（上傳照片要指定掛在哪一天）來自 wrangler vars DAYS */
function exhibitionDays(env: AuthedCtx['env']): Set<string> {
  return new Set((env.DAYS || '').split(',').map((s) => s.trim()).filter(Boolean));
}

export async function route(ctx: AuthedCtx): Promise<Response | null> {
  const { request, env, url, method, session } = ctx;

  if (method === 'GET' && url.pathname === '/api/photos') {
    const { results } = await env.DB.prepare(
      `SELECT p.id, p.author, u.display_name AS author_name, p.day, p.caption, p.r2_key, p.mime, p.width, p.height, p.created_at
       FROM photos p JOIN users u ON u.username = p.author
       WHERE p.status = 'live'
       ORDER BY p.created_at DESC, p.id DESC`,
    ).all<PhotoRow>();
    return json({
      photos: (results || []).map((r) => photoDto(r, r.author === session.user.username)),
    });
  }

  if (method === 'POST' && url.pathname === '/api/photos') {
    let form: FormData;
    try { form = await request.formData(); } catch { return json({ error: '請用 multipart/form-data 上傳' }, 400); }
    const file = form.get('file');
    if (!(file instanceof File) || file.size === 0) return json({ error: '沒有檔案' }, 400);
    if (file.size > MAX_UPLOAD) return json({ error: '檔案上限 8MB（上傳前會先在瀏覽器縮圖）' }, 413);

    const day = typeof form.get('day') === 'string' ? (form.get('day') as string).trim() : '';
    const caption = cleanSingleLine(typeof form.get('caption') === 'string' ? (form.get('caption') as string) : '');
    if (!exhibitionDays(env).has(day)) return json({ error: '指定的展覽日不存在' }, 400);
    if (caption.length > CAPTION_MAX) return json({ error: `說明上限 ${CAPTION_MAX} 字` }, 400);

    const buf = new Uint8Array(await file.arrayBuffer());
    const img = parseAndClean(buf);
    if (!img) return json({ error: '只接受 JPEG／PNG／WebP' }, 400);
    if (Math.max(img.width, img.height) > MAX_SIDE) {
      return json({ error: `長邊上限 ${MAX_SIDE}px——請透過頁面上傳介面（會自動縮圖）` }, 400);
    }

    const { ymd, datePrefix, iso } = nowTaipeiIso();
    const quota = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM photos WHERE author = ?1 AND created_at LIKE ?2`, // 含已刪除：刪掉重傳不能繞過上限
    ).bind(session.user.username, `${datePrefix}%`).first<{ n: number }>();
    if ((quota?.n ?? 0) >= PHOTOS_PER_DAY) {
      return json({ error: `一天最多上傳 ${PHOTOS_PER_DAY} 張照片` }, 429);
    }

    const id = await freshId(env.DB, 'photos', `p-${ymd}-`);
    const key = `photos/${id}.${img.ext}`;
    await env.UPLOADS.put(key, img.clean, { httpMetadata: { contentType: img.mime } });
    await env.DB.prepare(
      `INSERT INTO photos (id, author, day, caption, r2_key, mime, bytes, width, height, status, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'live', ?10)`,
    ).bind(id, session.user.username, day, caption, key, img.mime, img.clean.length, img.width, img.height, iso).run();

    return json({
      ok: true,
      photo: photoDto({
        id, author: session.user.username, author_name: session.user.displayName, day,
        caption, r2_key: key, mime: img.mime, width: img.width, height: img.height, created_at: iso,
      }, true),
    }, 201);
  }

  const match = url.pathname.match(/^\/api\/photos\/(p-\d{8}-[a-z0-9]{4})$/);
  if (!match || (method !== 'PUT' && method !== 'DELETE')) return null;

  const id = match[1];
  const row = await env.DB.prepare(`SELECT * FROM photos WHERE id = ?1 AND status = 'live'`)
    .bind(id)
    .first<PhotoRow>();
  if (!row) return json({ error: '照片不存在（或已刪除）' }, 404);
  if (row.author !== session.user.username && session.user.role !== 'admin') {
    return json({ error: '只能管理自己的照片' }, 403);
  }

  const { iso } = nowTaipeiIso();

  if (method === 'DELETE') {
    await env.DB.prepare(`UPDATE photos SET status = 'removed', updated_at = ?1 WHERE id = ?2`)
      .bind(iso, id).run();
    // 檔案一併刪除：刪除的意義就是不再公開（DB 列保留作 audit；若 R2 刪除失敗留孤兒檔，靠 backup/清理處理）
    try { await env.UPLOADS.delete(row.r2_key); } catch { /* 非致命 */ }
    return json({ ok: true });
  }

  // PUT：改 caption / day
  const body = await readJsonBody(request);
  if (!body) return json({ error: '無效的 JSON' }, 400);
  const sets: string[] = [];
  const values: (string | number)[] = [];
  if (typeof body.caption === 'string') {
    const caption = cleanSingleLine(body.caption);
    if (caption.length > CAPTION_MAX) return json({ error: `說明上限 ${CAPTION_MAX} 字` }, 400);
    sets.push(`caption = ?${values.length + 1}`); values.push(caption);
  }
  if (typeof body.day === 'string') {
    if (!exhibitionDays(env).has(body.day.trim())) return json({ error: '指定的展覽日不存在' }, 400);
    sets.push(`day = ?${values.length + 1}`); values.push(body.day.trim());
  }
  if (sets.length === 0) return json({ error: '沒有要更新的欄位' }, 400);
  sets.push(`updated_at = ?${values.length + 1}`); values.push(iso);
  values.push(id);
  await env.DB.prepare(`UPDATE photos SET ${sets.join(', ')} WHERE id = ?${values.length}`)
    .bind(...values).run();
  return json({ ok: true });
}
