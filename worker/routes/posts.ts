// 投稿（留言／繪馬）：GET/POST /api/posts、PUT/DELETE /api/posts/:id。
import { json, nowTaipeiIso } from '../lib/util';
import { cleanPostBody, cleanSingleLine, freshId, readJsonBody, type AuthedCtx, type Env } from '../lib/http';

const POST_BODY_MAX = 300;
const POST_BY_MAX = 20;
const POSTS_PER_DAY = 100;

type PostRow = {
  id: string; kind: string; target: string; reply_to: string | null; by: string;
  body: string; author: string; posted_at: string;
};

function postDto(r: PostRow, mine: boolean) {
  return {
    id: r.id, kind: r.kind, target: r.target, replyTo: r.reply_to, by: r.by,
    body: r.body, author: r.author, postedAt: r.posted_at, mine,
  };
}

/* ---------- targets 白名單：建置時產生的 public/edit/targets.json（前台 /edit* 已擋） ---------- */
let targetsCache: { exhibits: Set<string>; days: Set<string> } | null = null;
async function loadTargets(env: Env, request: Request): Promise<{ exhibits: Set<string>; days: Set<string> }> {
  if (targetsCache) return targetsCache;
  try {
    const res = await env.ASSETS.fetch(new Request(new URL('/edit/targets.json', request.url)));
    if (!res.ok) return { exhibits: new Set(), days: new Set() };
    const data = (await res.json()) as { exhibits: string[]; days: string[] };
    targetsCache = { exhibits: new Set(data.exhibits), days: new Set(data.days) };
  } catch {
    return { exhibits: new Set(), days: new Set() };
  }
  return targetsCache;
}

export async function route(ctx: AuthedCtx): Promise<Response | null> {
  const { request, env, url, method, session } = ctx;

  if (method === 'GET' && url.pathname === '/api/posts') {
    const { results } = await env.DB.prepare(
      `SELECT id, kind, target, reply_to, by, body, author, posted_at
       FROM posts WHERE status = 'live'
       ORDER BY posted_at ASC, id ASC`,
    ).all<PostRow>();
    return json({ posts: (results || []).map((r) => postDto(r, r.author === session.user.username)) });
  }

  if (method === 'POST' && url.pathname === '/api/posts') {
    const body = await readJsonBody(request);
    if (!body) return json({ error: '無效的 JSON' }, 400);
    const kind = body.kind === 'ema' ? 'ema' : body.kind === 'comment' ? 'comment' : null;
    if (!kind) return json({ error: 'kind 須為 comment 或 ema' }, 400);
    const postBody = cleanPostBody(typeof body.body === 'string' ? body.body : '');
    if (!postBody || postBody.length > POST_BODY_MAX) {
      return json({ error: `內容須為 1～${POST_BODY_MAX} 字` }, 400);
    }
    const by = cleanSingleLine(typeof body.by === 'string' ? body.by : '');
    if (by.length > POST_BY_MAX) return json({ error: `署名須為 0～${POST_BY_MAX} 字` }, 400);
    const target = typeof body.target === 'string' ? body.target.trim() : '';

    const targets = await loadTargets(env, request);
    if (kind === 'ema') {
      if (!targets.days.has(target)) return json({ error: '指定的展覽日不存在' }, 400);
    } else {
      // 留言對象：展品、繪馬、上傳的照片（照片與展品同等，都能留言）
      let ok = targets.exhibits.has(target);
      if (!ok && /^n-\d{8}-[a-z0-9]{4}$/.test(target)) {
        ok = !!(await env.DB.prepare(`SELECT id FROM posts WHERE id = ?1 AND kind = 'ema' AND status = 'live'`)
          .bind(target).first());
      } else if (!ok && /^p-\d{8}-[a-z0-9]{4}$/.test(target)) {
        ok = !!(await env.DB.prepare(`SELECT id FROM photos WHERE id = ?1 AND status = 'live'`)
          .bind(target).first());
      }
      if (!ok) return json({ error: '留言的目標不存在' }, 400);
    }

    const replyTo = typeof body.replyTo === 'string' && body.replyTo ? body.replyTo.trim() : null;
    if (replyTo !== null) {
      if (kind !== 'comment') return json({ error: '只有留言可以回覆留言' }, 400);
      const parent = await env.DB.prepare(`SELECT id, kind, target FROM posts WHERE id = ?1 AND status = 'live'`)
        .bind(replyTo).first<{ id: string; kind: string; target: string }>();
      if (!parent || parent.kind !== 'comment' || parent.target !== target) {
        return json({ error: '回覆目標須是同一 target 下的另一則留言' }, 400);
      }
    }

    const { ymd, datePrefix, iso } = nowTaipeiIso();
    const quota = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM posts WHERE author = ?1 AND posted_at LIKE ?2`, // 含已刪除
    ).bind(session.user.username, `${datePrefix}%`).first<{ n: number }>();
    if ((quota?.n ?? 0) >= POSTS_PER_DAY) return json({ error: `一天最多 ${POSTS_PER_DAY} 則投稿` }, 429);

    const id = await freshId(env.DB, 'posts', `n-${ymd}-`);
    await env.DB.prepare(
      `INSERT INTO posts (id, kind, target, reply_to, by, body, author, status, posted_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'live', ?8)`,
    ).bind(id, kind, target, replyTo, by, postBody, session.user.username, iso).run();
    return json({
      ok: true,
      post: postDto({ id, kind, target, reply_to: replyTo, by, body: postBody, author: session.user.username, posted_at: iso }, true),
    }, 201);
  }

  const match = url.pathname.match(/^\/api\/posts\/(n-\d{8}-[a-z0-9]{4})$/);
  if (!match || (method !== 'PUT' && method !== 'DELETE')) return null;

  const id = match[1];
  const row = await env.DB.prepare(`SELECT * FROM posts WHERE id = ?1 AND status = 'live'`)
    .bind(id)
    .first<PostRow>();
  if (!row) return json({ error: '投稿不存在（或已刪除）' }, 404);
  if (row.author !== session.user.username && session.user.role !== 'admin') {
    return json({ error: '只能管理自己的投稿' }, 403);
  }
  const { iso } = nowTaipeiIso();
  if (method === 'DELETE') {
    await env.DB.prepare(`UPDATE posts SET status = 'removed', updated_at = ?1, removed_by = ?2 WHERE id = ?3`)
      .bind(iso, session.user.username, id).run();
    return json({ ok: true });
  }
  const body = await readJsonBody(request);
  if (!body) return json({ error: '無效的 JSON' }, 400);
  const sets: string[] = [];
  const values: (string | number)[] = [];
  if (typeof body.body === 'string') {
    const next = cleanPostBody(body.body);
    if (!next || next.length > POST_BODY_MAX) return json({ error: `內容須為 1～${POST_BODY_MAX} 字` }, 400);
    sets.push(`body = ?${values.length + 1}`); values.push(next);
  }
  if (typeof body.by === 'string') {
    const next = cleanSingleLine(body.by);
    if (next.length > POST_BY_MAX) return json({ error: `署名須為 0～${POST_BY_MAX} 字` }, 400);
    sets.push(`by = ?${values.length + 1}`); values.push(next);
  }
  if (sets.length === 0) return json({ error: '沒有要更新的欄位' }, 400);
  sets.push(`updated_at = ?${values.length + 1}`); values.push(iso);
  values.push(id);
  await env.DB.prepare(`UPDATE posts SET ${sets.join(', ')} WHERE id = ?${values.length}`).bind(...values).run();
  return json({ ok: true });
}
