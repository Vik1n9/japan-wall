// 後台 Worker（kura.osaka2026.voriens.dev）：完整 API＋靜態資源。
// 這裡只做分派與共用檢查（Origin、session、強制改密碼）；各功能在 worker/routes/：
//   auth.ts（登入/登出/me/改密碼）、photos.ts、posts.ts、users.ts（僅 admin）。
// 公開唯讀端點（/api/public/wall、/api/media/*）與前台共用 worker/lib/public.ts。

import { json, safeDecode } from './lib/util';
import { cleanupStaleAuthRows, getSessionUser } from './lib/auth';
import { isMediaVideo, mediaAssetResponse } from './lib/media-assets';
import { mediaResponse, publicWallResponse } from './lib/public';
import { purgeDeletedUsers } from './lib/user-purge';
import { originAllowed, type AuthedCtx, type Ctx, type Env } from './lib/http';
import * as auth from './routes/auth';
import * as photos from './routes/photos';
import * as posts from './routes/posts';
import * as users from './routes/users';

export type { Env };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) {
      // 展品短片（run_worker_first 送進來的 /media/*.mp4）：靜態資源不支援 Range，Safari 要 206 才播得到
      if ((request.method === 'GET' || request.method === 'HEAD') && isMediaVideo(url.pathname)) {
        return mediaAssetResponse(env.ASSETS, request);
      }
      return env.ASSETS.fetch(request);
    }

    const method = request.method.toUpperCase();
    const ctx: Ctx = { request, env, url, method };

    // 所有變異請求檢查 Origin（CSRF 第一道；第二道是 SameSite=Lax cookie）
    // 注意：wrangler dev 會把同源 Origin 改寫成 http://<route hostname>，所以白名單含 http 版 kura（正式站是 https，瀏覽器不會送 http Origin，無風險）
    if (method !== 'GET' && method !== 'HEAD' && !originAllowed(request, env)) {
      return json({ error: 'Origin 不允許' }, 403);
    }

    if (method === 'POST' && url.pathname === '/api/login') return auth.login(ctx);

    /* 公開唯讀（與前台共用模組） */
    if (method === 'GET' && url.pathname.startsWith('/api/media/')) {
      return mediaResponse(env.DB, env.UPLOADS, safeDecode(url.pathname.slice('/api/media/'.length)) ?? '', request);
    }
    if (method === 'GET' && url.pathname === '/api/public/wall') {
      return publicWallResponse(env.DB);
    }

    /* 以下都需要 session */
    const session = await getSessionUser(env.DB, request);
    if (method === 'POST' && url.pathname === '/api/logout') return auth.logout(ctx, session?.tokenHash ?? null);
    if (!session) return json({ error: '未登入或驗證已過期' }, 401);

    // 必須先改密碼的帳號（新建或被重設）：除了讀取與改密碼之外一律擋下，不能只靠介面擋
    if (session.user.mustChangePw && method !== 'GET' && url.pathname !== '/api/change-password') {
      return json({ error: '請先變更密碼', mustChangePw: true }, 403);
    }

    const actx: AuthedCtx = { ...ctx, session };
    if (method === 'GET' && url.pathname === '/api/me') return auth.me(actx);
    if (method === 'POST' && url.pathname === '/api/change-password') return auth.changePassword(actx);

    for (const r of [photos.route, posts.route, users.route]) {
      const res = await r(actx);
      if (res) return res;
    }
    return json({ error: '找不到此 API 路徑' }, 404);
  },

  /** 每日排程（cron 見 wrangler.back.jsonc 的 triggers；UTC 19:17＝台灣凌晨 3:17）：
   *  清掉已過期的 session 與舊登入失敗紀錄（cleanupStaleAuthRows），並永久刪除
   *  軟刪除期滿（deleted_at 早於 30 天前）的帳號（purgeDeletedUsers）。
   *  兩個清理各自 try/catch，一個失敗不影響另一個。 */
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    try {
      await cleanupStaleAuthRows(env.DB);
    } catch (err) {
      console.error('清理登入紀錄失敗', err);
    }
    try {
      await purgeDeletedUsers(env);
    } catch (err) {
      console.error('清除待刪除帳號失敗', err);
    }
  },
};
