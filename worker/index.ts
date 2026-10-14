import { createRemoteJWKSet, jwtVerify } from 'jose';

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  EDITORS?: string;
  ALLOWED_ORIGINS?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
}

interface AccessContext {
  aud?: string;
  getIdentity?: () => Promise<{ email?: string } | null | undefined>;
}

type ExecutionCtx = ExecutionContext & { access?: AccessContext };

interface TargetsData {
  days: string[];
  exhibits: string[];
  emas?: string[];
  comments?: { id: string; target: string }[];
}

interface PostRow {
  id: string;
  kind: 'comment' | 'ema';
  target: string;
  reply_to: string | null;
  by: string;
  body: string;
  author: string;
  status: 'pending' | 'published' | 'rejected' | 'withdrawn';
  posted_at: string;
}

const DAILY_LIMIT = 100;
const BASE36 = '0123456789abcdefghijklmnopqrstuvwxyz';

let jwksCache: { domain: string; jwks: ReturnType<typeof createRemoteJWKSet> } | null = null;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function nowTaipeiIso(): { iso: string; ymd: string; datePrefix: string } {
  const ms = Date.now() + 8 * 3600_000;
  const d = new Date(ms);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  const datePrefix = `${yyyy}-${mm}-${dd}`;
  return {
    iso: `${datePrefix}T${hh}:${mi}:${ss}+08:00`,
    ymd: `${yyyy}${mm}${dd}`,
    datePrefix,
  };
}

function randomCode(len = 4): string {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < len; i++) out += BASE36[bytes[i] % 36];
  return out;
}

function cleanSingleLine(s: unknown): string {
  if (typeof s !== 'string') return '';
  return s.replace(/[\x00-\x1F\x7F]/g, '').trim();
}

function cleanMultiLine(s: unknown): string {
  if (typeof s !== 'string') return '';
  return s
    .replace(/\r\n?/g, '\n')
    .replace(/[\x00-\x09\x0B-\x1F\x7F]/g, '')
    .trim();
}

async function getAuthenticatedEmail(request: Request, env: Env, ctx: ExecutionCtx): Promise<string | null> {
  // 1. 優先由 ctx.access 取得（wrangler dev 的 access.dev 或直接掛在 Worker 上的 Access）
  if (ctx.access && typeof ctx.access.getIdentity === 'function') {
    try {
      const id = await ctx.access.getIdentity();
      if (id?.email && typeof id.email === 'string') {
        return id.email.trim().toLowerCase();
      }
    } catch {
      // 繼續嘗試 JWT
    }
  }

  // 2. 驗證 Cf-Access-Jwt-Assertion（Static Assets 路由層後方的正式環境）
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (token && env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD) {
    try {
      const rawDomain = env.ACCESS_TEAM_DOMAIN.trim().replace(/\/+$/, '');
      const issuer = rawDomain.startsWith('https://') ? rawDomain : `https://${rawDomain}`;
      if (!jwksCache || jwksCache.domain !== issuer) {
        jwksCache = {
          domain: issuer,
          jwks: createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`)),
        };
      }
      const aud = env.ACCESS_AUD.split(',').map((s) => s.trim()).filter(Boolean);
      const { payload } = await jwtVerify(token, jwksCache.jwks, { issuer, audience: aud });
      if (typeof payload.email === 'string' && payload.email.trim()) {
        return payload.email.trim().toLowerCase();
      }
    } catch {
      return null;
    }
  }

  return null;
}

async function loadTargets(request: Request, env: Env): Promise<TargetsData> {
  const url = new URL('/edit/targets.json', request.url);
  const res = await env.ASSETS.fetch(new Request(url.toString(), { method: 'GET' }));
  if (!res.ok) throw new Error('無法載入 targets.json');
  return (await res.json()) as TargetsData;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionCtx): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) {
      return env.ASSETS.fetch(request);
    }

    const email = await getAuthenticatedEmail(request, env, ctx);
    if (!email) {
      return json({ error: '未登入或驗證已過期' }, 401);
    }

    const editors = new Set(
      (env.EDITORS || '')
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    );
    if (!editors.has(email)) {
      return json({ error: '此帳號不在允許名單內' }, 403);
    }

    const method = request.method.toUpperCase();
    if (method === 'POST' || method === 'DELETE') {
      const origin = request.headers.get('Origin') || '';
      const allowedOrigins = new Set(
        (env.ALLOWED_ORIGINS || 'https://osaka2026.voriens.dev')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      );
      if (!origin || !allowedOrigins.has(origin)) {
        return json({ error: 'Origin 不允許' }, 403);
      }
      const ct = (request.headers.get('Content-Type') || '').toLowerCase();
      if (!ct.startsWith('application/json')) {
        return json({ error: 'Content-Type 必須為 application/json' }, 403);
      }
    }

    if (method === 'GET' && url.pathname === '/api/me') {
      return json({ email });
    }

    if (method === 'GET' && url.pathname === '/api/posts') {
      const { results } = await env.DB.prepare(
        `SELECT id, kind, target, reply_to, by, body, author, status, posted_at
         FROM posts
         WHERE status IN ('pending', 'published')
            OR (status = 'rejected' AND lower(author) = ?1)
         ORDER BY posted_at ASC, id ASC`,
      )
        .bind(email)
        .all<PostRow>();

      const posts = (results ?? []).map((r) => ({
        id: r.id,
        kind: r.kind,
        target: r.target,
        replyTo: r.reply_to ?? null,
        by: r.by,
        body: r.body,
        status: r.status,
        posted: r.posted_at,
        mine: r.author.toLowerCase() === email,
      }));
      return json({ posts });
    }

    if (method === 'POST' && url.pathname === '/api/posts') {
      let payload: Record<string, unknown>;
      try {
        const parsed = await request.json();
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return json({ error: '請求格式錯誤' }, 400);
        }
        payload = parsed as Record<string, unknown>;
      } catch {
        return json({ error: '無效的 JSON' }, 400);
      }

      const kind = payload.kind;
      if (kind !== 'comment' && kind !== 'ema') {
        return json({ error: 'kind 必須為 comment 或 ema' }, 400);
      }

      const target = cleanSingleLine(payload.target);
      if (!target) {
        return json({ error: 'target 不可為空' }, 400);
      }

      const rawReply = payload.replyTo;
      const replyTo = rawReply === null || rawReply === undefined || rawReply === '' ? null : cleanSingleLine(rawReply);

      if (payload.by !== undefined && typeof payload.by !== 'string') {
        return json({ error: 'by 必須為字串' }, 400);
      }
      const by = cleanSingleLine(payload.by ?? '');
      if (by.length > 20) {
        return json({ error: '署名最多 20 字' }, 400);
      }

      if (typeof payload.body !== 'string') {
        return json({ error: 'body 必須為字串' }, 400);
      }
      const body = cleanMultiLine(payload.body);
      if (body.length < 1 || body.length > 300) {
        return json({ error: '內文須為 1～300 字' }, 400);
      }

      const targets = await loadTargets(request, env);
      const daySet = new Set(targets.days);
      const exhibitSet = new Set(targets.exhibits);
      const staticEmaSet = new Set(targets.emas ?? []);
      const staticCommentMap = new Map((targets.comments ?? []).map((c) => [c.id, c.target]));

      if (kind === 'ema') {
        if (replyTo !== null) {
          return json({ error: '繪馬不可指定 replyTo' }, 400);
        }
        if (!daySet.has(target)) {
          return json({ error: `找不到日期 ${target}` }, 400);
        }
      } else {
        if (exhibitSet.has(target) || staticEmaSet.has(target)) {
          // 合法展品或已建置繪馬
        } else if (/^n-\d{8}-[a-z0-9]{4}$/.test(target)) {
          const emaRow = await env.DB.prepare(
            `SELECT id FROM posts WHERE id = ?1 AND kind = 'ema' AND status IN ('pending', 'published')`,
          )
            .bind(target)
            .first<{ id: string }>();
          if (!emaRow) {
            return json({ error: `找不到繪馬 ${target}` }, 400);
          }
        } else {
          return json({ error: `找不到留言對象 ${target}` }, 400);
        }

        if (replyTo !== null) {
          const staticTarget = staticCommentMap.get(replyTo);
          if (staticTarget !== undefined) {
            if (staticTarget !== target) {
              return json({ error: 'replyTo 不在同一個 target 底下' }, 400);
            }
          } else {
            const parentRow = await env.DB.prepare(
              `SELECT id, target FROM posts WHERE id = ?1 AND kind = 'comment' AND status IN ('pending', 'published')`,
            )
              .bind(replyTo)
              .first<{ id: string; target: string }>();
            if (!parentRow || parentRow.target !== target) {
              return json({ error: 'replyTo 留言不存在或不在同一個 target 底下' }, 400);
            }
          }
        }
      }

      const { iso, ymd, datePrefix } = nowTaipeiIso();
      const countRow = await env.DB.prepare(
        `SELECT COUNT(*) AS cnt FROM posts WHERE lower(author) = ?1 AND posted_at LIKE ?2`,
      )
        .bind(email, `${datePrefix}%`)
        .first<{ cnt: number }>();

      if ((countRow?.cnt ?? 0) >= DAILY_LIMIT) {
        return json({ error: `已達每日投稿上限（${DAILY_LIMIT} 則）` }, 429);
      }

      let id = '';
      for (let attempt = 0; attempt < 8; attempt++) {
        const candidate = `n-${ymd}-${randomCode(4)}`;
        const exists = await env.DB.prepare(`SELECT id FROM posts WHERE id = ?1`).bind(candidate).first();
        if (!exists && !staticEmaSet.has(candidate) && !staticCommentMap.has(candidate)) {
          id = candidate;
          break;
        }
      }
      if (!id) {
        return json({ error: '無法產生編號，請稍後再試' }, 500);
      }

      await env.DB.prepare(
        `INSERT INTO posts (id, kind, target, reply_to, by, body, author, status, posted_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'pending', ?8)`,
      )
        .bind(id, kind, target, replyTo, by, body, email, iso)
        .run();

      return json(
        {
          post: {
            id,
            kind,
            target,
            replyTo,
            by,
            body,
            status: 'pending',
            posted: iso,
            mine: true,
          },
        },
        201,
      );
    }

    const delMatch = method === 'DELETE' ? url.pathname.match(/^\/api\/posts\/(n-\d{8}-[a-z0-9]{4})$/) : null;
    if (delMatch) {
      const id = delMatch[1];
      const row = await env.DB.prepare(`SELECT id, author, status FROM posts WHERE id = ?1`)
        .bind(id)
        .first<{ id: string; author: string; status: string }>();

      if (!row) {
        return json({ error: '找不到此則投稿' }, 404);
      }
      if (row.author.toLowerCase() !== email) {
        return json({ error: '只能撤回自己的投稿' }, 403);
      }
      if (row.status !== 'pending') {
        return json({ error: '此投稿已展出或已處理，無法撤回' }, 409);
      }

      const { iso } = nowTaipeiIso();
      await env.DB.prepare(`UPDATE posts SET status = 'withdrawn', decided_at = ?1 WHERE id = ?2 AND status = 'pending'`)
        .bind(iso, id)
        .run();

      return json({ ok: true, id });
    }

    return json({ error: '找不到此 API 路徑' }, 404);
  },
};
