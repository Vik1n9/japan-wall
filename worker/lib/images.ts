// 上傳影像的伺服器端把關：magic bytes 驗證、byte 層剝除 metadata（EXIF/XMP/IPTC/時間戳）、尺寸解析。
// 純 byte 操作、不需 wasm。client 端 canvas 重編碼是第一層，這裡是防繞過瀏覽器的第二層。

export type ImageKind = 'jpeg' | 'png' | 'webp';

export interface ParsedImage {
  kind: ImageKind;
  mime: string;
  ext: string;
  width: number;
  height: number;
  clean: Uint8Array; // 剝除 metadata 後的位元組
}

const JPEG = 'image/jpeg';
const PNG = 'image/png';
const WEBP = 'image/webp';

export function detectKind(bytes: Uint8Array): ImageKind | null {
  if (bytes.length > 3 && bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) return 'jpeg';
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47
    && bytes[4] === 0x0D && bytes[5] === 0x0A && bytes[6] === 0x1A && bytes[7] === 0x0A) return 'png';
  if (bytes.length > 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'webp';
  return null;
}

const u16be = (b: Uint8Array, i: number) => (b[i] << 8) | b[i + 1];
const u16le = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8);
const u24le = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
const u32be = (b: Uint8Array, i: number) => (b[i] * 0x1000000) + ((b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]);
const u32le = (b: Uint8Array, i: number) => (b[i + 3] * 0x1000000) + ((b[i + 2] << 16) | (b[i + 1] << 8) | b[i]);

/* ---------- JPEG ---------- */

/** 剝除 APP1(EXIF/XMP)、APP2..APP15、COM 段；保留 APP0(JFIF) 與所有圖像資料段 */
function stripJpeg(src: Uint8Array): { clean: Uint8Array; width: number; height: number } {
  const out: number[] = [0xFF, 0xD8];
  let width = 0;
  let height = 0;
  let i = 2;
  while (i + 1 < src.length) {
    if (src[i] !== 0xFF) { i++; continue; }
    const marker = src[i + 1];
    if (marker === 0xD8 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) { // 無 payload 的 marker
      out.push(src[i], src[i + 1]);
      i += 2;
      continue;
    }
    if (i + 3 >= src.length) break;
    const len = u16be(src, i + 2);
    if (len < 2 || i + 2 + len > src.length) break;
    const isApp = marker >= 0xE1 && marker <= 0xEF; // APP1..APP15（APP0=E0 保留）
    const isCom = marker === 0xFE;
    if (marker === 0xDA) {
      // SOS：header＋entropy 原樣全複製到結尾（只複製一次！）
      for (let k = i; k < src.length; k++) out.push(src[k]);
      i = src.length;
      break;
    }
    if (!isApp && !isCom) {
      for (let k = i; k < i + 2 + len; k++) out.push(src[k]);
    }
    // SOF0..SOF15（排除 C4/C8/CC）含尺寸
    if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
      height = u16be(src, i + 5);
      width = u16be(src, i + 7);
    }
    i += 2 + len;
  }
  return { clean: Uint8Array.from(out), width, height };
}

/* ---------- PNG ---------- */

const PNG_DROP = new Set(['eXIf', 'tEXt', 'iTXt', 'zTXt', 'tIME']);

function stripPng(src: Uint8Array): { clean: Uint8Array; width: number; height: number } {
  const out: number[] = [...src.slice(0, 8)];
  let width = 0;
  let height = 0;
  let i = 8;
  while (i + 8 <= src.length) {
    const len = u32be(src, i);
    const type = String.fromCharCode(src[i + 4], src[i + 5], src[i + 6], src[i + 7]);
    if (i + 12 + len > src.length) break;
    if (type === 'IHDR') {
      width = u32be(src, i + 8);
      height = u32be(src, i + 12);
    }
    if (!PNG_DROP.has(type)) {
      for (let k = i; k < i + 12 + len; k++) out.push(src[k]);
    }
    i += 12 + len;
    if (type === 'IEND') break;
  }
  return { clean: Uint8Array.from(out), width, height };
}

/* ---------- WebP ---------- */

function stripWebp(src: Uint8Array): { clean: Uint8Array; width: number; height: number } {
  const out: number[] = [...src.slice(0, 12)];
  let width = 0;
  let height = 0;
  let i = 12;
  while (i + 8 <= src.length) {
    const fourcc = String.fromCharCode(src[i], src[i + 1], src[i + 2], src[i + 3]);
    const size = u32le(src, i + 4);
    const padded = size + (size % 2);
    if (i + 8 + size > src.length) break;
    if (fourcc === 'VP8X') {
      width = u24le(src, i + 8 + 4) + 1;
      height = u24le(src, i + 8 + 7) + 1;
    } else if (fourcc === 'VP8 ') {
      width = u16le(src, i + 8 + 6) & 0x3FFF;
      height = u16le(src, i + 8 + 8) & 0x3FFF;
    } else if (fourcc === 'VP8L') {
      const b = src[i + 8 + 1] | (src[i + 8 + 2] << 8) | (src[i + 8 + 3] << 16) | (src[i + 8 + 4] << 24);
      width = (b & 0x3FFF) + 1;
      height = ((b >>> 14) & 0x3FFF) + 1;
    }
    if (fourcc !== 'EXIF' && fourcc !== 'XMP ') {
      for (let k = i; k < i + 8 + size; k++) out.push(src[k]);
      if (size % 2) out.push(0); // RIFF chunk padding
    }
    i += 8 + padded;
  }
  // 更新 RIFF 總長
  const clean = Uint8Array.from(out);
  const total = clean.length - 8;
  clean[4] = total & 0xFF;
  clean[5] = (total >>> 8) & 0xFF;
  clean[6] = (total >>> 16) & 0xFF;
  clean[7] = (total >>> 24) & 0xFF;
  return { clean, width, height };
}

/* ---------- 對外 ---------- */

/** 驗證＋剝 metadata＋取尺寸；不認得的格式回 null */
export function parseAndClean(bytes: Uint8Array): ParsedImage | null {
  const kind = detectKind(bytes);
  if (!kind) return null;
  let r: { clean: Uint8Array; width: number; height: number };
  if (kind === 'jpeg') r = stripJpeg(bytes);
  else if (kind === 'png') r = stripPng(bytes);
  else r = stripWebp(bytes);
  if (!r.width || !r.height || r.width > 100000 || r.height > 100000) return null;
  const mime = kind === 'jpeg' ? JPEG : kind === 'png' ? PNG : WEBP;
  const ext = kind === 'jpeg' ? 'jpg' : kind;
  return { kind, mime, ext, width: r.width, height: r.height, clean: r.clean };
}
