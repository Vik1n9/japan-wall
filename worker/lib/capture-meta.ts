// 從 MP4／MOV 的 moov 讀拍攝時間與地點（剝除 metadata 之前用，結果只存資料庫給內部排版，不公開）。
// 瀏覽器（轉檔前讀原檔）與後台 Worker（剝除前讀上傳檔）共用，純函式、不依賴任何環境。
//
// 來源優先順序：
//   時間：Apple mdta 的 com.apple.quicktime.creationdate（含時區的當地時間，取當地時刻）
//         → mvhd creation_time（UTC，換算成旅行地日本時間 +09:00；0 表示沒寫）
//   地點：Apple mdta 的 com.apple.quicktime.location.ISO6709 → udta/©xyz（Android）→ udta/loci（3GPP、ffmpeg）

export type CaptureMeta = { takenAt: string | null; lat: number | null; lon: number | null };

const TRIP_UTC_OFFSET_H = 9; // 旅行地日本；mvhd 只有 UTC 時才用得到
const MAC_EPOCH_TO_UNIX = 2082844800; // 1904-01-01 → 1970-01-01 的秒數
const TIME_KEYS = new Set(['com.apple.quicktime.creationdate', 'creation_time', 'date']);
const PLACE_KEYS = new Set(['com.apple.quicktime.location.ISO6709', 'location', 'location-eng']);

type Box = { type: string; start: number; body: number; end: number };

function boxes(b: Uint8Array, start: number, end: number): Box[] {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const out: Box[] = [];
  let off = start;
  while (off + 8 <= end) {
    let size = v.getUint32(off);
    let header = 8;
    if (size === 1 && off + 16 <= end) { size = Number(v.getBigUint64(off + 8)); header = 16; }
    else if (size === 0) size = end - off;
    if (size < header || off + size > end) break;
    out.push({ type: String.fromCharCode(b[off + 4], b[off + 5], b[off + 6], b[off + 7]), start: off, body: off + header, end: off + size });
    off += size;
  }
  return out;
}

const utf8 = (b: Uint8Array) => new TextDecoder().decode(b);

/** ISO 6709：「+34.6687+135.4302+005.123/」 */
export function parseIso6709(s: string): { lat: number; lon: number } | null {
  const m = s.trim().match(/^([+-]\d{1,2}(?:\.\d+)?)([+-]\d{1,3}(?:\.\d+)?)/);
  if (!m) return null;
  const lat = Number(m[1]), lon = Number(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  if (lat === 0 && lon === 0) return null;
  return { lat, lon };
}

/** 「2026-10-06T13:34:12+0900」→ 當地時刻「2026-10-06T13:34:12」 */
function localFromIso(s: string): string | null {
  const m = s.trim().match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})/);
  return m ? `${m[1]}T${m[2]}` : null;
}

function fromUtcSeconds(unix: number): string {
  const d = new Date((unix + TRIP_UTC_OFFSET_H * 3600) * 1000);
  return d.toISOString().slice(0, 19);
}

/** moov 是整個 moov box（含 8 bytes 標頭） */
export function captureMetaFromMoov(moov: Uint8Array): CaptureMeta {
  const out: CaptureMeta = { takenAt: null, lat: null, lon: null };
  const v = new DataView(moov.buffer, moov.byteOffset, moov.byteLength);
  let mvhdTime: string | null = null;

  /** mdta 形式的 meta（keys＋ilst）。QuickTime 的 meta 不是 FullBox；ISO 版多 4 bytes version/flags，看第一個子 box 是不是 hdlr 判斷 */
  const readMdta = (k: Box) => {
    const full = String.fromCharCode(...moov.subarray(k.body + 8, k.body + 12)) === 'hdlr';
    const kids = boxes(moov, k.body + (full ? 4 : 0), k.end);
    const keysBox = kids.find((x) => x.type === 'keys');
    const ilst = kids.find((x) => x.type === 'ilst');
    if (!keysBox || !ilst) return;
    const keys: string[] = [];
    const count = v.getUint32(keysBox.body + 4);
    let off = keysBox.body + 8;
    for (let i = 0; i < count && off + 8 <= keysBox.end; i++) {
      const size = v.getUint32(off);
      if (size < 8) break;
      keys.push(utf8(moov.subarray(off + 8, off + size)));
      off += size;
    }
    for (const item of boxes(moov, ilst.body, ilst.end)) {
      const key = keys[v.getUint32(item.start + 4) - 1]; // item 的 type 欄位就是 1 起算的 key 編號
      const data = boxes(moov, item.body, item.end).find((x) => x.type === 'data');
      if (!key || !data) continue;
      const value = utf8(moov.subarray(data.body + 8, data.end));
      if (TIME_KEYS.has(key)) out.takenAt = localFromIso(value) ?? out.takenAt;
      if (PLACE_KEYS.has(key)) {
        const p = parseIso6709(value);
        if (p) { out.lat = p.lat; out.lon = p.lon; }
      }
    }
  };

  try {
    for (const k of boxes(moov, 8, moov.length)) {
      if (k.type === 'mvhd') {
        const ver = moov[k.body];
        const t = ver === 1 ? Number(v.getBigUint64(k.body + 4)) : v.getUint32(k.body + 4);
        if (t > MAC_EPOCH_TO_UNIX) mvhdTime = fromUtcSeconds(t - MAC_EPOCH_TO_UNIX);
      } else if (k.type === 'udta') {
        for (const u of boxes(moov, k.body, k.end)) {
          if (u.type === '\u00a9xyz' && out.lat === null) {
            const len = v.getUint16(u.body);
            const p = parseIso6709(utf8(moov.subarray(u.body + 4, Math.min(u.end, u.body + 4 + len))));
            if (p) { out.lat = p.lat; out.lon = p.lon; }
          } else if (u.type === 'loci' && out.lat === null) {
            // 3GPP 位置：version/flags(4) language(2) name\0 role(1) longitude latitude altitude（16.16 定點，有號）
            let o = u.body + 6;
            while (o < u.end && moov[o] !== 0) o++;
            o += 2;
            if (o + 8 <= u.end) {
              const lon = v.getInt32(o) / 65536, lat = v.getInt32(o + 4) / 65536;
              const p = parseIso6709(`${lat >= 0 ? '+' : ''}${lat.toFixed(4)}${lon >= 0 ? '+' : ''}${lon.toFixed(4)}`);
              if (p) { out.lat = p.lat; out.lon = p.lon; }
            }
          } else if (u.type === 'meta') {
            readMdta(u); // ffmpeg 等工具把 mdta 放在 udta 底下
          }
        }
      } else if (k.type === 'meta') {
        readMdta(k); // iPhone 放在 moov 底下
      }
    }
  } catch {
    /* 壞檔：讀到多少算多少 */
  }
  out.takenAt ??= mvhdTime;
  return out;
}

/** 整個檔案已在記憶體時（後台 Worker）：找頂層 moov 再解析 */
export function captureMetaFromFile(buf: Uint8Array): CaptureMeta {
  const moov = boxes(buf, 0, buf.length).find((b) => b.type === 'moov');
  if (!moov) return { takenAt: null, lat: null, lon: null };
  return captureMetaFromMoov(buf.subarray(moov.start, moov.end));
}
