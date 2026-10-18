// 展品短片（public/media/**/*.mp4）的 Range 請求支援：前台與後台 Worker 共用。
// Cloudflare 靜態資源管線對 Range 一律回 200 完整檔（沒有 Content-Range／Accept-Ranges），
// 而 iPhone Safari 的 <video> 需要 206 才播得出來。兩個 Worker 都把 "/media/*.mp4"
// 放進 wrangler 的 assets.run_worker_first，由這裡接手：把 Range 拿掉向 env.ASSETS
// 取完整檔，再依 Range 切片回 206／416。
// 快取與其他 header 原樣沿用資源管線的回應（public/_headers 的設定不變）；
// 照片（webp）等其他靜態檔不走這裡，行為完全不變。

import { parseRange } from './public';

/** run_worker_first 的 "/media/*.mp4" 會送進來的請求；Worker 端再確認一次範圍 */
export function isMediaVideo(pathname: string): boolean {
  return pathname.startsWith('/media/') && pathname.toLowerCase().endsWith('.mp4');
}

/** 串流切片：跳過前 start bytes、取 length bytes 後 terminate（上游隨之取消，不會讀完整檔） */
function sliceStream(start: number, length: number): TransformStream<Uint8Array, Uint8Array> {
  let skipped = 0;
  let emitted = 0;
  return new TransformStream({
    transform(chunk, controller) {
      let off = 0;
      if (skipped < start) {
        const skip = Math.min(start - skipped, chunk.length);
        skipped += skip;
        off = skip;
      }
      const remain = length - emitted;
      if (remain > 0 && off < chunk.length) {
        const take = Math.min(remain, chunk.length - off);
        controller.enqueue(chunk.subarray(off, off + take));
        emitted += take;
      }
      if (emitted >= length) controller.terminate();
    },
  });
}

/** 依 Range 與檔案大小算出切片起點與終點；範圍超出回 null（要回 416） */
function bounds(range: NonNullable<ReturnType<typeof parseRange>>, size: number): { start: number; end: number } | null {
  const start = 'suffix' in range ? Math.max(0, size - range.suffix) : range.offset;
  const end = 'suffix' in range ? size - 1 : Math.min(size - 1, range.length ? range.offset + range.length - 1 : size - 1);
  return start >= size || end < start ? null : { start, end };
}

/** GET／HEAD /media/*.mp4 的回應。
 *  - 沒有 Range（或格式不認得、多段 Range）：照資源管線回 200／304／404，200 時補 Accept-Ranges: bytes
 *  - 有 Range：206＋Content-Range＋正確 Content-Length；範圍超出回 416＋Content-Range: bytes *\/size */
export async function mediaAssetResponse(assets: Fetcher, request: Request): Promise<Response> {
  const range = request.method === 'GET' ? parseRange(request.headers.get('Range')) : null;
  if (!range) {
    const res = await assets.fetch(request);
    if (res.status !== 200) return res; // 304（If-None-Match）／404 原樣回
    const out = new Response(res.body, res);
    out.headers.set('Accept-Ranges', 'bytes');
    return out;
  }

  // 刻意把 Range 拿掉再取檔：資源管線不支援 Range，拿掉後各環境（本機 dev／正式）行為一致，
  // 切片一律由 Worker 做。If-None-Match 等條件 header 保留，304 直接沿用。
  const headers = new Headers(request.headers);
  headers.delete('Range');
  const res = await assets.fetch(new Request(new URL(request.url), { method: 'GET', headers }));
  if (res.status !== 200 || !res.body) return res;

  // If-Range 的驗證器（ETag 強比對）不符：檔案在快取期間換過內容（重新轉檔／部署時檔名不變），
  // 照 RFC 7233 忽略 Range 回完整 200，否則瀏覽器會把新舊內容接在一起。
  const ifRange = request.headers.get('If-Range');
  if (ifRange && ifRange !== res.headers.get('ETag')) {
    const full = new Response(res.body, res);
    full.headers.set('Accept-Ranges', 'bytes');
    return full;
  }

  const out = new Headers(res.headers);
  out.set('Accept-Ranges', 'bytes');
  // 注意：不能用 Number(header ?? null)——Number(null) 是 0，会把「沒有 header」誤判成空檔。
  // assets.fetch 的子回應可能不帶 Content-Length（實測本機 dev 就不帶），那時整包讀出取大小。
  const lenHeader = out.get('Content-Length');
  const size = lenHeader === null ? NaN : Number(lenHeader);

  if (Number.isFinite(size)) {
    // 有大小：串流切片，讀到 Range 尾就取消上游，不必把整檔載進記憶體
    const b = bounds(range, size);
    if (!b) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    out.set('Content-Range', `bytes ${b.start}-${b.end}/${size}`);
    out.set('Content-Length', String(b.end - b.start + 1));
    return new Response(res.body.pipeThrough(sliceStream(b.start, b.end - b.start + 1)), { status: 206, headers: out });
  }

  // 沒有 Content-Length：整包讀出（展品短片最大約 16MB，Worker 記憶體上限 128MB，夠）再切
  const buf = new Uint8Array(await res.arrayBuffer());
  const b = bounds(range, buf.length);
  if (!b) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${buf.length}` } });
  out.set('Content-Range', `bytes ${b.start}-${b.end}/${buf.length}`);
  out.set('Content-Length', String(b.end - b.start + 1));
  return new Response(buf.subarray(b.start, b.end + 1), { status: 206, headers: out });
}
