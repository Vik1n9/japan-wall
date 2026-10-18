// 上傳影片的伺服器端處理：檢查 MP4 結構、讀長度與畫面尺寸、剝掉 metadata（第二層防線）。
// 瀏覽器已經轉檔並抹掉 metadata；這裡再把 moov 裡可能藏 GPS／拍攝資訊的 udta、meta、uuid
// 整個拿掉，頂層只留 ftyp、moov、mdat。moov 變短會讓 mdat 位移，所以要修正 stco／co64 的 chunk offset。

type Box = { type: string; start: number; header: number; size: number };

/** moov 裡會往下走的容器；其餘 box 原樣保留（stsd 等內部結構不動） */
const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'dinf']);
/** 可能帶 metadata 的 box：任何層級一律丟掉 */
const DROP = new Set(['udta', 'meta', 'uuid', 'free', 'skip', 'wide', 'pnot', 'PICT']);

function readBoxes(buf: Uint8Array, start: number, end: number): Box[] | null {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const out: Box[] = [];
  let off = start;
  while (off < end) {
    if (off + 8 > end) return null;
    let size = v.getUint32(off);
    const type = String.fromCharCode(buf[off + 4], buf[off + 5], buf[off + 6], buf[off + 7]);
    let header = 8;
    if (size === 1) {
      if (off + 16 > end) return null;
      const big = v.getBigUint64(off + 8);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) return null;
      size = Number(big);
      header = 16;
    } else if (size === 0) {
      size = end - off; // 延伸到檔尾
    }
    if (size < header || off + size > end) return null;
    out.push({ type, start: off, header, size });
    off += size;
  }
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function boxBytes(type: string, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + payload.length);
  new DataView(out.buffer).setUint32(0, out.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(payload, 8);
  return out;
}

/** 重建容器：丟掉 DROP 的子 box，遞迴處理子容器 */
function rebuild(buf: Uint8Array, box: Box): Uint8Array | null {
  if (!CONTAINERS.has(box.type)) return buf.subarray(box.start, box.start + box.size);
  const kids = readBoxes(buf, box.start + box.header, box.start + box.size);
  if (!kids) return null;
  const parts: Uint8Array[] = [];
  for (const k of kids) {
    if (DROP.has(k.type)) continue;
    const b = rebuild(buf, k);
    if (!b) return null;
    parts.push(b);
  }
  return boxBytes(box.type, concat(parts));
}

/** 在重建後的 moov 裡找出所有 stco／co64，chunk offset 依 mdat 的位移修正 */
function patchOffsets(moov: Uint8Array, shift: (old: number) => number | null): boolean {
  const v = new DataView(moov.buffer, moov.byteOffset, moov.byteLength);
  const walk = (start: number, end: number): boolean => {
    const kids = readBoxes(moov, start, end);
    if (!kids) return false;
    for (const k of kids) {
      const body = k.start + k.header;
      if (CONTAINERS.has(k.type)) {
        if (!walk(body, k.start + k.size)) return false;
      } else if (k.type === 'stco' || k.type === 'co64') {
        const n = v.getUint32(body + 4);
        const wide = k.type === 'co64';
        if (body + 8 + n * (wide ? 8 : 4) > k.start + k.size) return false;
        for (let i = 0; i < n; i++) {
          const at = body + 8 + i * (wide ? 8 : 4);
          const old = wide ? Number(v.getBigUint64(at)) : v.getUint32(at);
          const nu = shift(old);
          if (nu === null) return false;
          if (wide) v.setBigUint64(at, BigInt(nu));
          else {
            if (nu > 0xffffffff) return false;
            v.setUint32(at, nu);
          }
        }
      }
    }
    return true;
  };
  return walk(8, moov.length);
}

export type VideoInfo = { clean: Uint8Array; duration: number; width: number; height: number; hasAudio: boolean };

/** 檢查並清理 MP4。格式不對回 null */
export function cleanMp4(buf: Uint8Array): VideoInfo | null {
  const top = readBoxes(buf, 0, buf.length);
  if (!top || top[0]?.type !== 'ftyp') return null;
  const moovs = top.filter((b) => b.type === 'moov');
  const mdats = top.filter((b) => b.type === 'mdat');
  if (moovs.length !== 1 || mdats.length < 1) return null;
  for (const b of top) {
    if (!['ftyp', 'moov', 'mdat', ...DROP].includes(b.type)) return null; // 不認得的頂層 box 一律拒收
  }

  const moov = rebuild(buf, moovs[0]);
  if (!moov) return null;
  // 新的頂層排列：ftyp、moov、mdat 依原順序，其餘丟掉；算出每個 mdat 的新起點
  const kept = top.filter((b) => b.type === 'ftyp' || b.type === 'moov' || b.type === 'mdat');
  const parts: Uint8Array[] = [];
  const moved: { oldStart: number; oldEnd: number; newStart: number }[] = [];
  let pos = 0;
  for (const b of kept) {
    const bytes = b.type === 'moov' ? moov : buf.subarray(b.start, b.start + b.size);
    if (b.type === 'mdat') moved.push({ oldStart: b.start, oldEnd: b.start + b.size, newStart: pos });
    parts.push(bytes);
    pos += bytes.length;
  }
  const ok = patchOffsets(moov, (old) => {
    const m = moved.find((x) => old >= x.oldStart && old < x.oldEnd);
    return m ? old - m.oldStart + m.newStart : null;
  });
  if (!ok) return null;

  // 長度（mvhd）與畫面尺寸（影像軌的 tkhd）
  const info = readInfo(moov);
  if (!info) return null;
  return { clean: concat(parts), ...info };
}

function readInfo(moov: Uint8Array): Omit<VideoInfo, 'clean'> | null {
  const v = new DataView(moov.buffer, moov.byteOffset, moov.byteLength);
  const kids = readBoxes(moov, 8, moov.length);
  if (!kids) return null;
  let duration = 0;
  let width = 0, height = 0, hasVideo = false, hasAudio = false;
  for (const k of kids) {
    const body = k.start + k.header;
    if (k.type === 'mvhd') {
      const ver = moov[body];
      const scale = v.getUint32(body + (ver === 1 ? 20 : 12));
      const dur = ver === 1 ? Number(v.getBigUint64(body + 24)) : v.getUint32(body + 16);
      if (scale) duration = dur / scale;
    } else if (k.type === 'trak') {
      const tk = readBoxes(moov, body, k.start + k.size) ?? [];
      const tkhd = tk.find((b) => b.type === 'tkhd');
      const mdia = tk.find((b) => b.type === 'mdia');
      const hdlr = mdia && (readBoxes(moov, mdia.start + mdia.header, mdia.start + mdia.size) ?? []).find((b) => b.type === 'hdlr');
      const handler = hdlr ? String.fromCharCode(...moov.subarray(hdlr.start + hdlr.header + 8, hdlr.start + hdlr.header + 12)) : '';
      if (handler === 'soun') hasAudio = true;
      if (handler === 'vide' && tkhd) {
        hasVideo = true;
        const end = tkhd.start + tkhd.size;
        width = Math.round(v.getUint32(end - 8) / 65536);
        height = Math.round(v.getUint32(end - 4) / 65536);
      }
    }
  }
  if (!hasVideo || !width || !height || !duration) return null;
  return { duration, width, height, hasAudio };
}
