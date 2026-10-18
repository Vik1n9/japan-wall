// IP 層限速用的 IP 正規化：IPv4 用完整位址；IPv6 用 /64 網段（前 4 組 16-bit）。
//
// 為什麼 IPv6 要用 /64：IPv6 用戶端幾乎都拿到一整個 /64 前綴，且作業系統的
// 「隱私位址」（RFC 8981）會定期、甚至每個連線都換 interface-id——同一台主機
// 每個請求的完整位址都可能不同。IP 層限速（同 IP 累計失敗 20 次鎖 15 分鐘，
// 擋分散帳號的密碼噴灑）若按完整位址計數，對 IPv6 攻擊者形同虛設：換個尾碼
// 就是全新的計數桶。業界（RFC 6177、各大服務的 abuse 處理）都把 /64 當作一個
// 「主機」單位來限速。代價是同一 /64（大家庭、小型機構）共用一個桶——這是
// Viking 拍板的取捨。「帳號＋IP」那一層不受影響，仍用完整位址。
//
// 這個檔案刻意零依賴、只用可擦除（erasable）的 TS 語法：
// scripts/api-smoke.mjs 用 node（≥23.6 內建 type stripping）直接 import 做單元檢查。

/** 標準 IPv4（四段 0–255）→ 去掉前導零的規範寫法；不合法回 null */
function normalizeIpv4(s: string): string | null {
  const m = s.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((n) => n > 255)) return null;
  return parts.join('.');
}

/** 把 IPv6 解析成 8 組 16-bit（小寫、去前導零）；處理 '::' 縮寫與尾端內嵌
 *  IPv4（如 64:ff9b::1.2.3.4）。格式不合法回 null。 */
function ipv6Groups(s: string): string[] | null {
  let addr = s;
  // 尾端內嵌 IPv4 → 轉成兩組 16-bit（::ffff:1.2.3.4 在 ipRateKey 已先行處理，
  // 會走到這裡的是 NAT64 等其他內嵌形式，它們是真正的 IPv6 位址，照 /64 算）
  const v4Tail = addr.match(/:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (v4Tail) {
    const v4 = normalizeIpv4(v4Tail[1]);
    if (!v4) return null;
    const p = v4.split('.').map(Number);
    const hi = ((p[0] << 8) | p[1]).toString(16);
    const lo = ((p[2] << 8) | p[3]).toString(16);
    addr = addr.slice(0, addr.length - v4Tail[1].length - 1) + `:${hi}:${lo}`;
  }
  const halves = addr.split('::');
  if (halves.length > 2) return null; // 多個 '::' 不合法
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  for (const g of left.concat(right)) if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
  if (halves.length === 1) {
    if (left.length !== 8) return null; // 沒有 '::' 就必須寫滿 8 組
  } else {
    if (left.length + right.length > 7) return null; // '::' 至少要代表一組 0
    left.push(...new Array(8 - left.length - right.length).fill('0'));
  }
  return left.concat(right);
}

/** 限速 key 用的 IP：IPv4 原樣（完整位址）；IPv6 → '<前4組>::/64'。
 *  ::ffff:x.x.x.x（IPv4-mapped）視為對應的 IPv4，跟純 IPv4 共用同一個桶；
 *  zone id（fe80::1%en0）先剝掉；大小寫與各種縮寫寫法都正規化成同一個 key。
 *  解析不了的輸入原樣返回——寧可少併（各算各的桶），不可誤併不同主機。 */
export function ipRateKey(ip: string): string {
  const s = ip.split('%')[0].trim().toLowerCase();
  if (!s.includes(':')) return s; // IPv4：完整位址，桶的粒度不變
  const mapped = s.match(/^::ffff:(.+)$/);
  if (mapped) {
    const v4 = normalizeIpv4(mapped[1]);
    if (v4) return v4;
  }
  const groups = ipv6Groups(s);
  if (!groups) return s;
  // /64 = 前 4 組；去前導零、全零時輸出 '::/64'，確保同網段各種寫法得到同一個 key
  const head = groups.slice(0, 4).map((g) => g.replace(/^0+/, '') || '0');
  return (head.every((g) => g === '0') ? '' : head.join(':')) + '::/64';
}
