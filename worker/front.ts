// 前台 Worker（osaka2026.voriens.dev）：純展示，零登入痕跡。
// 只開放兩個公開唯讀端點：/api/public/wall（動態內容）與 /api/media/:key（上傳的照片）。
// 其餘 /api/*、/edit*、/admin* 一律 404——dist 裡即使有 /edit 空殼 HTML 也拿不到。
import { mediaResponse, publicWallResponse, type R2BucketLike } from './lib/public';
import { safeDecode } from './lib/util';

export interface FrontEnv {
  ASSETS: Fetcher;
  DB: D1Database;
  UPLOADS: R2BucketLike;
}

export default {
  async fetch(request: Request, env: FrontEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/api/public/wall') {
      // 邊緣快取 60 秒：每個訪客不必都打一次 D1。存進快取的副本標 max-age=60，回給瀏覽器的一律 no-cache
      const cache = caches.default;
      const key = new Request(url.origin + url.pathname);
      const noCache = (r: Response) => {
        const out = new Response(r.body, r);
        out.headers.set('Cache-Control', 'no-cache');
        return out;
      };
      const hit = await cache.match(key);
      if (hit) return noCache(hit);
      const res = await publicWallResponse(env.DB);
      const stored = new Response(res.clone().body, res);
      stored.headers.set('Cache-Control', 'public, max-age=60');
      ctx.waitUntil(cache.put(key, stored));
      return res;
    }
    if (request.method === 'GET' && url.pathname.startsWith('/api/media/')) {
      return mediaResponse(env.UPLOADS, safeDecode(url.pathname.slice('/api/media/'.length)) ?? '');
    }

    const blocked =
      url.pathname.startsWith('/api/') ||
      url.pathname === '/edit' || url.pathname.startsWith('/edit/') ||
      url.pathname === '/admin' || url.pathname.startsWith('/admin/');
    if (blocked) {
      return new Response('Not Found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
    return env.ASSETS.fetch(request);
  },
};
