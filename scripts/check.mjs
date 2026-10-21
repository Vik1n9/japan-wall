#!/usr/bin/env node
// 發佈前檢查（npm run build 前自動執行）
//  1. 隱私：public/ 下的圖片不得帶 EXIF/XMP；短片不得帶位置或裝置資訊
//  2. 引用：每個展品的媒體檔都存在；每天引用的展品都存在
//  3. 提醒：還沒掛上牆的展品、仍是草稿（draft）的展品、時刻待補的展品
// 有「錯誤」時以非零碼結束，阻止建置；「提醒」不阻止。
//
// 短片的串流規則：短片保留聲音（docs/decisions.md），所以「1 個影像串流＋最多 1 個聲音串流」算正常；
// 其他種類的串流（字幕、資料軌…）或超額（多個影像、多個聲音）才提醒。用 ffprobe 的 codec_type 判斷。
// 規則的反例驗證：node scripts/check.mjs --streams <短片檔...> 只檢查指定檔案的串流組成後結束。
import { readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import YAML from 'yaml';
import sharp from 'sharp';

const ROOT = new URL('..', import.meta.url).pathname;
const PUBLIC = join(ROOT, 'public');
const errors = [];
const notes = [];

async function walk(dir) {
  const out = [];
  for (const d of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, d.name);
    if (d.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}

function hasFfprobe() {
  try { execFileSync('ffprobe', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; }
}

function probe(file) {
  return JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format_tags:stream_tags:stream=codec_type', '-of', 'json', file]).toString());
}

/* 短片串流組成：影像剛好 1 個、聲音最多 1 個；其餘種類或超額都提醒 */
const STREAM_LABEL = { video: '影像', audio: '聲音', subtitle: '字幕', data: '資料軌', attachment: '附件', image: '圖片' };

function streamLabel(type) {
  return STREAM_LABEL[type] ?? `未知（${type}）`;
}

function videoStreamNotes(rel, streams) {
  const counts = new Map();
  for (const s of streams ?? []) {
    const type = s.codec_type ?? 'unknown';
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  const out = [];
  const video = counts.get('video') ?? 0;
  if (video !== 1) out.push(`${rel}：有 ${video} 個影像串流，預期剛好 1 個`);
  const audio = counts.get('audio') ?? 0;
  if (audio > 1) out.push(`${rel}：有 ${audio} 個聲音串流，預期最多 1 個`);
  for (const [type, n] of counts) {
    if (type === 'video' || type === 'audio') continue;
    out.push(`${rel}：有 ${n} 個${streamLabel(type)}串流，短片只該有影像（1 個）與聲音（最多 1 個）`);
  }
  return out;
}

/* 反例驗證用：只檢查指定短片的串流組成，不掃 public/ */
const argv = process.argv.slice(2);
if (argv[0] === '--streams') {
  const targets = argv.slice(1);
  if (!targets.length) {
    console.error('用法：node scripts/check.mjs --streams <短片檔...>');
    process.exit(2);
  }
  if (!hasFfprobe()) {
    console.error('找不到 ffprobe，無法檢查短片串流（本機請安裝：brew install ffmpeg）');
    process.exit(2);
  }
  const found = targets.flatMap((t) => videoStreamNotes(t, probe(t).streams));
  for (const n of found) console.log(`  提醒  ${n}`);
  if (found.length) {
    console.error(`\n✗ 串流組成有 ${found.length} 個提醒。`);
    process.exit(1);
  }
  console.log('✓ 短片串流組成正常（影像 1 個、聲音最多 1 個）');
  process.exit(0);
}

/* 1. 隱私 */
const IMG = new Set(['.webp', '.jpg', '.jpeg', '.png', '.avif', '.heic']);
const VID = new Set(['.mp4', '.mov', '.m4v', '.webm']);
const files = existsSync(PUBLIC) ? await walk(PUBLIC) : [];
const ffprobe = hasFfprobe();
let checkedVideos = 0;

for (const f of files) {
  const ext = extname(f).toLowerCase();
  const rel = relative(ROOT, f);
  if (ext === '.heic' || ext === '.mov') errors.push(`${rel}：原始格式檔不應放在 public/，請用 npm run ingest 轉檔`);
  if (IMG.has(ext) && ext !== '.heic') {
    const m = await sharp(f).metadata();
    if (m.exif || m.xmp || m.iptc) errors.push(`${rel}：圖片仍帶有 EXIF/XMP/IPTC（可能含拍攝地點）`);
  }
  if (VID.has(ext) && ffprobe) {
    checkedVideos++;
    const json = probe(f);
    const tags = { ...(json.format?.tags ?? {}) };
    for (const s of json.streams ?? []) Object.assign(tags, s.tags ?? {});
    const bad = Object.keys(tags).filter((k) => /location|ISO6709|com\.apple|make|model|creation_?date/i.test(k));
    if (bad.length) errors.push(`${rel}：短片仍帶有 metadata（${bad.join(', ')}）`);
    notes.push(...videoStreamNotes(rel, json.streams));
  }
}
if (!ffprobe) notes.push('找不到 ffprobe，略過短片的 metadata 檢查（本機請安裝：brew install ffmpeg）');

/* 2. 引用與 3. 提醒 */
const exDir = join(ROOT, 'src/content/exhibits');
const dayDir = join(ROOT, 'src/content/days');
const exhibits = new Map();
for (const f of (await readdir(exDir)).filter((f) => f.endsWith('.yaml'))) {
  const id = f.replace(/\.yaml$/, '');
  const data = YAML.parse(await readFile(join(exDir, f), 'utf8'));
  exhibits.set(id, data);
  for (const key of ['media', 'poster']) {
    if (data[key] && !existsSync(join(PUBLIC, data[key]))) errors.push(`${id}：找不到 ${key} 檔 public/${data[key]}`);
  }
}

const dayFiles = (await readdir(dayDir)).filter((f) => f.endsWith('.yaml'));
const daysByFile = new Map();
for (const f of dayFiles) {
  const day = YAML.parse(await readFile(join(dayDir, f), 'utf8'));
  daysByFile.set(f, day);
}

const placed = new Set();
for (const [f, day] of daysByFile) {
  for (const col of day.columns ?? []) {
    for (const it of col.items ?? []) {
      if (it.exhibit) {
        if (!exhibits.has(it.exhibit)) errors.push(`days/${f}：引用了不存在的展品 ${it.exhibit}`);
        else if (placed.has(it.exhibit)) errors.push(`days/${f}：展品 ${it.exhibit} 被掛了兩次`);
        placed.add(it.exhibit);
      }
    }
    if (col.unsorted) notes.push(`days/${f}：有一欄「未排版」，請調整位置後移除 unsorted`);
  }
}
const unplaced = [...exhibits.keys()].filter((id) => !placed.has(id));
const drafts = [...exhibits].filter(([, d]) => d.draft !== false).map(([id]) => id);
const noTime = [...exhibits].filter(([, d]) => !d.time).map(([id]) => id);
if (unplaced.length) notes.push(`尚未掛上牆：${unplaced.join('、')}`);
if (drafts.length) notes.push(`草稿（標題或說明待確認）：${drafts.length} 件`);
if (noTime.length) notes.push(`時刻待補：${noTime.join('、')}`);

/* 輸出 */
const imgCount = files.filter((f) => IMG.has(extname(f).toLowerCase())).length;
console.log(`檢查 public/：${imgCount} 張圖片、${checkedVideos} 支短片；展品 ${exhibits.size} 件`);
for (const n of notes) console.log(`  提醒  ${n}`);
for (const e of errors) console.error(`  錯誤  ${e}`);
if (errors.length) {
  console.error(`\n✗ ${errors.length} 個錯誤，已中止。`);
  process.exit(1);
}
console.log('✓ 通過');
