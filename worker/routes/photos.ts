// 照片與影片（每個帳號上傳的，地位相同；同一張表，kind 區分）：GET/POST /api/photos、PUT/DELETE /api/photos/:id。
import { json, nowTaipeiIso } from '../lib/util';
import { parseAndClean } from '../lib/images';
import { cleanMp4 } from '../lib/video';
import { captureMetaFromFile } from '../lib/capture-meta';
import { cleanSingleLine, freshId, readJsonBody, type AuthedCtx } from '../lib/http';

const MAX_UPLOAD = 8 * 1024 * 1024;
const MAX_SIDE = 2048;
const PHOTOS_PER_DAY = 20;
const CAPTION_MAX = 300;
// 影片（Viking 定）：轉檔後 50MB、60 秒、每人每天 5 支。瀏覽器先轉成 H.264 720p MP4，這裡再驗一次
const MAX_VIDEO = 50 * 1024 * 1024;
const MAX_VIDEO_SECONDS = 60;
const VIDEO_MAX_SIDE = 1920;
const VIDEOS_PER_DAY = 5;
const MAX_POSTER = 2 * 1024 * 1024;

type PhotoRow = {
  id: string; author: string; author_name?: string; day: string; caption: string;
  r2_key: string; mime: string; width: number; height: number; taken_at: string | null; created_at: string;
  kind?: string; duration?: number | null; poster_key?: string | null;
};

function photoDto(r: PhotoRow, mine: boolean) {
  return {
    id: r.id, author: r.author, authorName: r.author_name ?? r.author, day: r.day,
    caption: r.caption, key: r.r2_key, mime: r.mime, width: r.width, height: r.height,
    takenAt: r.taken_at, createdAt: r.created_at, mine,
    kind: r.kind ?? 'photo', duration: r.duration ?? null, posterKey: r.poster_key ?? null,
  };
}

/** 拍攝時刻：瀏覽器在重編碼前從 EXIF DateTimeOriginal 讀出（當地時間、不做時區換算，與 ingest 相同）。
 *  格式不對或日期不合理就當作沒有，不擋上傳 */
function cleanTakenAt(v: FormDataEntryValue | null): string | null {
  if (typeof v !== 'string') return null;
  const m = v.trim().match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return null;
  const [y, mo, d, h, mi, se] = m.slice(1).map(Number);
  if (y < 2000 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || se > 59) return null;
  return m[0];
}

/** 拍攝地點（剝除 metadata 前讀出）：只存資料庫給內部排版用，不回傳 */
function cleanCoord(v: FormDataEntryValue | null, max: number): number | null {
  if (typeof v !== 'string' || !v.trim()) return null;
  const n = Number(v);
  return Number.isFinite(n) && Math.abs(n) <= max && n !== 0 ? Math.round(n * 1e6) / 1e6 : null;
}

/** 牆上的展覽日（上傳照片要指定掛在哪一天）來自 wrangler vars DAYS */
function exhibitionDays(env: AuthedCtx['env']): Set<string> {
  return new Set((env.DAYS || '').split(',').map((s) => s.trim()).filter(Boolean));
}

export async function route(ctx: AuthedCtx): Promise<Response | null> {
  const { request, env, url, method, session } = ctx;

  if (method === 'GET' && url.pathname === '/api/photos') {
    const { results } = await env.DB.prepare(
      `SELECT p.id, p.author, u.display_name AS author_name, p.day, p.caption, p.r2_key, p.mime, p.width, p.height, p.taken_at, p.created_at,
              p.kind, p.duration, p.poster_key
       FROM photos p JOIN users u ON u.username = p.author
       WHERE p.status = 'live'
       ORDER BY p.created_at DESC, p.id DESC`,
    ).all<PhotoRow>();
    return json({
      photos: (results || []).map((r) => photoDto(r, r.author === session.user.username)),
    });
  }

  if (method === 'POST' && url.pathname === '/api/photos') {
    const BODY_LIMIT = MAX_VIDEO + MAX_POSTER + 64 * 1024;
    // 先看宣告的長度，超過影片上限的請求不必整包讀進記憶體
    const declared = request.headers.get('Content-Length');
    if (declared !== null && Number(declared) > BODY_LIMIT) {
      return json({ error: '檔案太大：影片上限 50MB（上傳前會先在瀏覽器轉檔）' }, 413);
    }
    // 正式站經 Cloudflare 的 HTTP/2、HTTP/3 不保證請求帶 Content-Length（本機 dev 是
    // HTTP/1.1 測不出來），不能因為缺 header 就擋掉正常上傳。缺 header 時改串流讀取並計數：
    // 超過上限立刻取消上游回 413；沒超過就把讀到的 bytes 組回新的 Request（沿用含 boundary
    // 的 Content-Type）再 formData()——跟 readJsonBody 相同模式，不管 header 在不在，
    // formData() 都不會被拿來整包緩衝超過上限的 body（平台上限 100MB 會撞爆 isolate 的 128MB）
    let formRequest = request;
    if (declared === null && request.body) {
      const reader = request.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      let over = false;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > BODY_LIMIT) { over = true; await reader.cancel(); break; }
        chunks.push(value);
      }
      if (over) return json({ error: '檔案太大：影片上限 50MB（上傳前會先在瀏覽器轉檔）' }, 413);
      const whole = new Uint8Array(total);
      let o = 0;
      for (const c of chunks) { whole.set(c, o); o += c.length; }
      formRequest = new Request(request.url, {
        method: 'POST',
        headers: { 'Content-Type': request.headers.get('Content-Type') ?? 'application/octet-stream' },
        body: whole,
      });
    }
    let form: FormData;
    try { form = await formRequest.formData(); } catch { return json({ error: '請用 multipart/form-data 上傳' }, 400); }
    const file = form.get('file');
    if (!(file instanceof File) || file.size === 0) return json({ error: '沒有檔案' }, 400);
    const isVideo = form.get('kind') === 'video';
    if (!isVideo && file.size > MAX_UPLOAD) return json({ error: '檔案上限 8MB（上傳前會先在瀏覽器縮圖）' }, 413);
    if (isVideo && file.size > MAX_VIDEO) return json({ error: '影片上限 50MB（上傳前會先在瀏覽器轉檔）' }, 413);

    const day = typeof form.get('day') === 'string' ? (form.get('day') as string).trim() : '';
    const caption = cleanSingleLine(typeof form.get('caption') === 'string' ? (form.get('caption') as string) : '');
    if (!exhibitionDays(env).has(day)) return json({ error: '指定的展覽日不存在' }, 400);
    if (caption.length > CAPTION_MAX) return json({ error: `說明上限 ${CAPTION_MAX} 字` }, 400);
    let takenAt = cleanTakenAt(form.get('takenAt'));
    let lat = cleanCoord(form.get('lat'), 90);
    let lon = cleanCoord(form.get('lon'), 180);
    if (lat === null || lon === null) { lat = null; lon = null; }

    const buf = new Uint8Array(await file.arrayBuffer());
    let media: { clean: Uint8Array; mime: string; ext: string; width: number; height: number };
    let duration: number | null = null;
    let poster: { clean: Uint8Array; mime: string; ext: string } | null = null;
    if (isVideo) {
      // 剝除前先記下拍攝時間與地點（瀏覽器沒送才用；正常流程瀏覽器已在轉檔前讀好）
      const meta = captureMetaFromFile(buf);
      takenAt ??= cleanTakenAt(meta.takenAt);
      if (lat === null && meta.lat !== null && meta.lon !== null) { lat = meta.lat; lon = meta.lon; }
      const v = cleanMp4(buf);
      if (!v) return json({ error: '只接受 MP4 影片——請透過頁面上傳介面（會自動轉檔）' }, 400);
      if (v.duration > MAX_VIDEO_SECONDS + 1) return json({ error: `影片長度上限 ${MAX_VIDEO_SECONDS} 秒` }, 400);
      if (Math.max(v.width, v.height) > VIDEO_MAX_SIDE) {
        return json({ error: `影片長邊上限 ${VIDEO_MAX_SIDE}px——請透過頁面上傳介面（會自動轉檔）` }, 400);
      }
      const pf = form.get('poster');
      if (!(pf instanceof File) || pf.size === 0 || pf.size > MAX_POSTER) return json({ error: '缺少影片封面' }, 400);
      const p = parseAndClean(new Uint8Array(await pf.arrayBuffer()));
      if (!p) return json({ error: '影片封面只接受 JPEG／PNG／WebP' }, 400);
      media = { clean: v.clean, mime: 'video/mp4', ext: 'mp4', width: v.width, height: v.height };
      duration = Math.round(v.duration * 10) / 10;
      poster = { clean: p.clean, mime: p.mime, ext: p.ext };
    } else {
      const img = parseAndClean(buf);
      if (!img) return json({ error: '只接受 JPEG／PNG／WebP' }, 400);
      if (Math.max(img.width, img.height) > MAX_SIDE) {
        return json({ error: `長邊上限 ${MAX_SIDE}px——請透過頁面上傳介面（會自動縮圖）` }, 400);
      }
      media = img;
    }

    const { ymd, datePrefix, iso } = nowTaipeiIso();
    const kind = isVideo ? 'video' : 'photo';
    const quota = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM photos WHERE author = ?1 AND created_at LIKE ?2 AND kind = ?3`, // 含已刪除：刪掉重傳不能繞過上限
    ).bind(session.user.username, `${datePrefix}%`, kind).first<{ n: number }>();
    const limit = isVideo ? VIDEOS_PER_DAY : PHOTOS_PER_DAY;
    if ((quota?.n ?? 0) >= limit) {
      return json({ error: isVideo ? `一天最多上傳 ${VIDEOS_PER_DAY} 支影片` : `一天最多上傳 ${PHOTOS_PER_DAY} 張照片` }, 429);
    }

    const id = await freshId(env.DB, 'photos', `p-${ymd}-`);
    const key = `photos/${id}.${media.ext}`;
    const posterKey = poster ? `photos/${id}-poster.${poster.ext}` : null;
    await env.UPLOADS.put(key, media.clean, { httpMetadata: { contentType: media.mime } });
    if (poster && posterKey) await env.UPLOADS.put(posterKey, poster.clean, { httpMetadata: { contentType: poster.mime } });
    await env.DB.prepare(
      `INSERT INTO photos (id, author, day, caption, r2_key, mime, bytes, width, height, taken_at, kind, duration, poster_key, lat, lon, status, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, 'live', ?16)`,
    ).bind(id, session.user.username, day, caption, key, media.mime, media.clean.length, media.width, media.height,
      takenAt, kind, duration, posterKey, lat, lon, iso).run();

    return json({
      ok: true,
      photo: photoDto({
        id, author: session.user.username, author_name: session.user.displayName, day,
        caption, r2_key: key, mime: media.mime, width: media.width, height: media.height, taken_at: takenAt, created_at: iso,
        kind, duration, poster_key: posterKey,
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
    await env.DB.prepare(`UPDATE photos SET status = 'removed', updated_at = ?1, removed_by = ?2 WHERE id = ?3`)
      .bind(iso, session.user.username, id).run();
    // 檔案一併刪除：刪除的意義就是不再公開（DB 列保留作 audit；若 R2 刪除失敗留孤兒檔，靠 backup/清理處理）
    try { await env.UPLOADS.delete(row.r2_key); } catch { /* 非致命 */ }
    if (row.poster_key) { try { await env.UPLOADS.delete(row.poster_key); } catch { /* 非致命 */ } }
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
