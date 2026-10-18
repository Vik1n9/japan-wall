// 上傳前在瀏覽器處理照片與影片。
// 隱私：先讀出拍攝時間與地點（存資料庫給內部排版用，不公開），再重新編碼，輸出檔不帶任何 metadata。
// 伺服器（worker/lib/images.ts、worker/lib/video.ts）還會再剝一次。

import { captureMetaFromMoov, type CaptureMeta } from '../../worker/lib/capture-meta';

export type { CaptureMeta };

/** 影片上限（Viking 定）：轉檔後 50MB、60 秒；伺服器 worker/routes/photos.ts 也驗 */
export const VIDEO_MAX_BYTES = 50 * 1024 * 1024;
export const VIDEO_MAX_SECONDS = 60;

export function isVideoFile(file: File): boolean {
  return file.type.startsWith('video/') || /\.(mov|mp4|m4v)$/i.test(file.name);
}

/* ---------- 照片：EXIF 的拍攝時刻與 GPS ---------- */

/** 從 JPEG 的 EXIF 讀 DateTimeOriginal（當地時間）與 GPS；PNG／WebP／HEIC 一律當作沒有 */
export async function readPhotoMeta(file: File): Promise<CaptureMeta> {
  const out: CaptureMeta = { takenAt: null, lat: null, lon: null };
  try {
    const v = new DataView(await file.slice(0, 256 * 1024).arrayBuffer());
    if (v.getUint16(0) !== 0xffd8) return out;
    let off = 2;
    while (off + 4 <= v.byteLength) {
      const marker = v.getUint16(off);
      const len = v.getUint16(off + 2);
      if ((marker & 0xff00) !== 0xff00 || marker === 0xffda) return out; // 掃到影像資料還沒找到
      if (marker === 0xffe1 && v.getUint32(off + 4) === 0x45786966) { // "Exif"
        const tiff = off + 10;
        const le = v.getUint16(tiff) === 0x4949;
        const u16 = (o: number) => v.getUint16(tiff + o, le);
        const u32 = (o: number) => v.getUint32(tiff + o, le);
        const findTag = (ifd: number, tag: number): number | null => {
          const n = u16(ifd);
          for (let i = 0; i < n; i++) {
            const e = ifd + 2 + i * 12;
            if (u16(e) === tag) return e;
          }
          return null;
        };
        const ifd0 = u32(4);
        const exif = findTag(ifd0, 0x8769);
        const dto = exif === null ? null : findTag(u32(exif + 8), 0x9003); // DateTimeOriginal，ASCII 20 bytes
        if (dto !== null) {
          const at = u32(dto + 8);
          let str = '';
          for (let i = 0; i < 19; i++) str += String.fromCharCode(v.getUint8(tiff + at + i));
          const m = str.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
          if (m) out.takenAt = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
        }
        const gps = findTag(ifd0, 0x8825);
        if (gps !== null) {
          const g = u32(gps + 8);
          const ref = (tag: number) => { const e = findTag(g, tag); return e === null ? '' : String.fromCharCode(v.getUint8(tiff + e + 8)); };
          const dms = (tag: number) => {
            const e = findTag(g, tag);
            if (e === null) return null;
            const at = u32(e + 8);
            const r = (i: number) => { const d = u32(at + i * 8 + 4); return d ? u32(at + i * 8) / d : 0; };
            return r(0) + r(1) / 60 + r(2) / 3600;
          };
          const lat = dms(2), lon = dms(4);
          if (lat !== null && lon !== null && (lat || lon)) {
            out.lat = Math.round((ref(1) === 'S' ? -lat : lat) * 1e6) / 1e6;
            out.lon = Math.round((ref(3) === 'W' ? -lon : lon) * 1e6) / 1e6;
          }
        }
        return out;
      }
      off += 2 + len;
    }
  } catch { /* 壞檔或截斷：當作沒有 */ }
  return out;
}

/* ---------- 影片：moov 裡的拍攝時刻與地點 ---------- */

/** 只讀頂層 box 標頭找 moov，再把 moov 讀進來解析；不把整支影片載入記憶體 */
export async function readVideoMeta(file: File): Promise<CaptureMeta> {
  const none: CaptureMeta = { takenAt: null, lat: null, lon: null };
  try {
    let off = 0;
    while (off + 8 <= file.size) {
      const h = new DataView(await file.slice(off, off + 16).arrayBuffer());
      let size = h.getUint32(0);
      const type = String.fromCharCode(h.getUint8(4), h.getUint8(5), h.getUint8(6), h.getUint8(7));
      if (size === 1) size = Number(h.getBigUint64(8));
      else if (size === 0) size = file.size - off;
      if (size < 8) return none;
      if (type === 'moov') {
        if (size > 32 * 1024 * 1024) return none;
        return captureMetaFromMoov(new Uint8Array(await file.slice(off, off + size).arrayBuffer()));
      }
      off += size;
    }
  } catch { /* 讀不到就當作沒有 */ }
  return none;
}

/* ---------- 影片轉檔：H.264（avc）＋ AAC，MP4，橫式寬 ≤1280／直式寬 ≤720（與展品短片相同） ---------- */

export type TranscodedVideo = { file: Blob; poster: Blob; duration: number; width: number; height: number };

export async function transcodeVideo(file: File, onProgress: (p: number) => void): Promise<TranscodedVideo> {
  if (!('VideoEncoder' in window)) throw new Error('這個瀏覽器不支援影片轉檔，請改用最新版的 Chrome、Edge 或 Safari。');
  const mb = await import('mediabunny');
  const input = new mb.Input({ formats: mb.ALL_FORMATS, source: new mb.BlobSource(file) });
  const duration = await input.computeDuration();
  if (duration > VIDEO_MAX_SECONDS + 0.5) {
    throw new Error(`影片長度上限 ${VIDEO_MAX_SECONDS} 秒（這支 ${Math.round(duration)} 秒），請先在相簿裡剪短再上傳。`);
  }
  const vt = await input.getPrimaryVideoTrack();
  if (!vt) throw new Error('這個檔案裡沒有影像。');
  const [dw, dh] = await Promise.all([vt.getDisplayWidth(), vt.getDisplayHeight()]);
  const maxW = dw >= dh ? 1280 : 720;
  const width = Math.min(dw, maxW) & ~1; // H.264 要偶數

  const aac = await mb.canEncodeAudio('aac');
  const output = new mb.Output({ format: new mb.Mp4OutputFormat({ fastStart: 'in-memory' }), target: new mb.BufferTarget() });
  const conversion = await mb.Conversion.init({
    input,
    output,
    // 直拍的 iPhone 影片是橫向畫面＋旋轉標記：把旋轉燒進畫面，輸出的寬高才等於實際顯示的寬高（伺服器讀 tkhd）
    video: { width, codec: 'avc', quality: mb.QUALITY_MEDIUM, frameRate: 30, forceTranscode: true, allowTransformationMetadata: false },
    audio: { codec: aac ? 'aac' : 'opus', numberOfChannels: 2, sampleRate: 48000, quality: mb.QUALITY_MEDIUM, forceTranscode: true },
    tags: {}, // 不帶任何 metadata（GPS、拍攝裝置、時間）
  });
  if (!conversion.isValid) {
    const why = conversion.discardedTracks.map((d) => d.reason).join('、');
    throw new Error(`這支影片無法轉檔（${why || '格式不支援'}）。`);
  }
  conversion.onProgress = onProgress;
  await conversion.execute();
  const buf = (output.target as InstanceType<typeof mb.BufferTarget>).buffer;
  if (!buf) throw new Error('轉檔失敗。');
  if (buf.byteLength > VIDEO_MAX_BYTES) {
    throw new Error(`轉檔後仍有 ${(buf.byteLength / 1048576).toFixed(1)}MB，超過 50MB 上限，請剪短一點。`);
  }

  // 封面：取約 1 秒處（短片取中間）的畫面
  const sink = new mb.CanvasSink(vt, { width: Math.min(width, 960) });
  const at = Math.min(1, duration / 2);
  const shot = await sink.getCanvas(at);
  if (!shot) throw new Error('取不到封面畫面。');
  const c = shot.canvas;
  const poster = 'convertToBlob' in c
    ? await c.convertToBlob({ type: 'image/jpeg', quality: 0.82 })
    : await new Promise<Blob | null>((res) => (c as HTMLCanvasElement).toBlob(res, 'image/jpeg', 0.82));
  if (!poster) throw new Error('封面產生失敗。');
  input.dispose?.();
  const height = Math.round((width * dh) / dw) & ~1;
  return { file: new Blob([buf], { type: 'video/mp4' }), poster, duration, width, height };
}
