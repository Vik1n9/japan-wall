#!/usr/bin/env node
// 發佈前檢查（npm run build 前自動執行）
//  1. 隱私：public/ 下的圖片不得帶 EXIF/XMP；短片不得帶位置或裝置資訊
//  2. 引用：每個展品的媒體檔都存在；每天引用的展品都存在
//  3. 提醒：還沒掛上牆的展品、仍是草稿（draft）的展品、時刻待補的展品
// 有「錯誤」時以非零碼結束，阻止建置；「提醒」不阻止。
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
    const json = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format_tags:stream_tags', '-of', 'json', f]).toString());
    const tags = { ...(json.format?.tags ?? {}) };
    for (const s of json.streams ?? []) Object.assign(tags, s.tags ?? {});
    const bad = Object.keys(tags).filter((k) => /location|ISO6709|com\.apple|make|model|creation_?date/i.test(k));
    if (bad.length) errors.push(`${rel}：短片仍帶有 metadata（${bad.join(', ')}）`);
    if ((json.streams ?? []).length > 1) notes.push(`${rel}：有 ${json.streams.length} 個串流，預期只有 1 個影像串流`);
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
