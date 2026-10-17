// 前台 Worker（osaka2026.voriens.dev）：純展示，零登入痕跡。
// /api/*、/edit*、/admin* 在這個網域上一律 404——dist 裡即使有 /edit 空殼 HTML 也拿不到。
// 階段 4/6 會在這裡加 /api/public/*、/api/media/* 公開唯讀端點。

export interface FrontEnv {
  ASSETS: Fetcher;
}

export default {
  async fetch(request: Request, env: FrontEnv): Promise<Response> {
    const { pathname } = new URL(request.url);
    const blocked =
      pathname.startsWith('/api/') ||
      pathname === '/edit' || pathname.startsWith('/edit/') ||
      pathname === '/admin' || pathname.startsWith('/admin/');
    if (blocked) {
      return new Response('Not Found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
    return env.ASSETS.fetch(request);
  },
};
