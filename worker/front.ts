// 前台 Worker（osaka2026.voriens.dev）：純展示，零登入痕跡。
// 只開放兩個公開唯讀端點：/api/public/wall（動態內容）與 /api/media/:key（親友照片）。
// 其餘 /api/*、/edit*、/admin* 一律 404——dist 裡即使有 /edit 空殼 HTML 也拿不到。
import { mediaResponse, publicWallResponse, type R2BucketLike } from './lib/public';

export interface FrontEnv {
  ASSETS: Fetcher;
  DB: D1Database;
  UPLOADS: R2BucketLike;
}

export default {
  async fetch(request: Request, env: FrontEnv): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/api/public/wall') {
      return publicWallResponse(env.DB);
    }
    if (request.method === 'GET' && url.pathname.startsWith('/api/media/')) {
      return mediaResponse(env.UPLOADS, decodeURIComponent(url.pathname.slice('/api/media/'.length)));
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
