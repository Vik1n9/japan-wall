#!/usr/bin/env node
// 匯入一天的原始素材：raw/<日期>/ → public/media/<日期>/ ＋ 展品草稿 ＋ 當天的欄位
//
// 用法：
//   npm run ingest -- 2026-10-07 [--city 京都] [--place 伏見稻荷]
//   npm run ingest -- 2026-10-06 --redo JP-02-09     依展品檔的 clip / crop 重新轉檔
//   npm run ingest -- 2026-10-07 --dry               只列出會做什麼，不寫檔
//
// 原則：
//   - 拍攝時刻只從檔案 metadata 讀取；讀不到就是 null，不猜。
//   - 已存在的展品檔不覆寫（保護人工寫的標題與說明）；--redo 只更新媒體相關欄位。
//   - 輸出檔一律移除 metadata（含 GPS）；短片去除音軌與 Apple 附帶的資料軌。
//   - 新展品放在當天最後一欄（unsorted: true），排版由人決定。
//
// 需要：ffmpeg / ffprobe（brew install ffmpeg）；macOS 內建 sips 用來讀 HEIC。

import { readdir, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import YAML from 'yaml';
import sharp from 'sharp';
import exifr from 'exifr';

const ROOT = new URL('..', import.meta.url).pathname;
const P = (...p) => join(ROOT, ...p);
const PHOTO = new Set(['.heic', '.heif', '.jpg', '.jpeg', '.png']);
const VIDEO = new Set(['.mov', '.mp4', '.m4v']);
const PHOTO_MAX = 1600;  // 照片長邊
const WEBP_Q = 78;
const CRF = 27;

const { values: opt, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    city: { type: 'string' },
    place: { type: 'string' },
    redo: { type: 'string', multiple: true },
    dry: { type: 'boolean', default: false },
  },
});
const date = positionals[0];
if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '')) {
  console.error('用法：npm run ingest -- <YYYY-MM-DD> [--city 城市] [--place 地點] [--redo 編號] [--dry]');
  process.exit(1);
}

/* ---------- 工具 ---------- */
const run = (cmd, args) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
function need(cmd) {
  try { execFileSync(cmd, ['-version'], { stdio: 'ignore' }); } catch {
    console.error(`找不到 ${cmd}。請先安裝：brew install ffmpeg`);
    process.exit(1);
  }
}
const pad = (n) => String(n).padStart(2, '0');
const mmss = (s) => `${Math.floor(s / 60)}:${pad(Math.round(s % 60))}`;
/** 日期、時刻、長度一律加引號，避免被 YAML 解析成日期或數字 */
function quote(doc, keys) {
  for (const k of keys) {
    const node = doc.get(k, true);
    if (node && typeof node.value === 'string') node.type = 'QUOTE_DOUBLE';
  }
  return doc;
}
const slug = (name) => basename(name, extname(name)).toLowerCase().replace(/[^a-z0-9_-]+/g, '-');

/** 照片拍攝時間：回傳 { date: 'YYYY-MM-DD', time: 'HH:MM' } 或 null。直接取字串，不做時區換算（即拍攝地當地時間）。 */
async function photoTime(file) {
  try {
    const t = await exifr.parse(file, { pick: ['DateTimeOriginal', 'CreateDate'], reviveValues: false });
    const raw = t?.DateTimeOriginal ?? t?.CreateDate;
    const m = typeof raw === 'string' && raw.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2})/);
    return m ? { date: `${m[1]}-${m[2]}-${m[3]}`, time: `${m[4]}:${m[5]}` } : null;
  } catch { return null; }
}

/** 短片拍攝時間：優先用 Apple 的 creationdate（含當地時區），否則 null。 */
function videoInfo(file) {
  const j = JSON.parse(run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:format_tags', '-of', 'json', file]));
  const tags = j.format?.tags ?? {};
  const cd = tags['com.apple.quicktime.creationdate'];
  const m = typeof cd === 'string' && cd.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
  return { taken: m ? { date: m[1], time: m[2] } : null, duration: Number(j.format?.duration ?? 0) };
}

function videoSize(file) {
  const j = JSON.parse(run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:format=duration', '-of', 'json', file]));
  return { width: j.streams[0].width, height: j.streams[0].height, duration: Number(j.format.duration) };
}

async function convertPhoto(src, out, crop) {
  let input = src;
  const tmp = P('.tmp');
  if (/\.hei[cf]$/i.test(src)) {
    await mkdir(tmp, { recursive: true });
    input = join(tmp, `${slug(src)}.jpg`);
    if (process.platform === 'darwin') run('sips', ['-s', 'format', 'jpeg', src, '--out', input]);
    else run('heif-convert', [src, input]); // Linux：需要 libheif-examples
  }
  let img = sharp(input).rotate(); // 依 EXIF 方向轉正，輸出不保留 metadata
  if (crop) {
    const { data, info } = await img.toBuffer({ resolveWithObject: true });
    const top = Math.round(info.height * crop.top);
    const height = Math.round(info.height * crop.bottom) - top;
    img = sharp(data).extract({ left: 0, top, width: info.width, height });
  }
  const info = await img
    .resize({ width: PHOTO_MAX, height: PHOTO_MAX, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: WEBP_Q })
    .toFile(out);
  return { width: info.width, height: info.height };
}

async function convertVideo(src, out, poster, clip) {
  const args = ['-v', 'error', '-y'];
  if (clip) args.push('-ss', String(clip.start));
  args.push('-i', src);
  if (clip) args.push('-t', String(clip.duration));
  args.push(
    '-map', '0:v:0', '-an', '-sn', '-dn', '-map_metadata', '-1', '-map_chapters', '-1',
    '-vf', "scale='if(gte(iw,ih),min(1280,iw),min(720,iw))':-2",
    '-c:v', 'libx264', '-preset', 'slow', '-crf', String(CRF), '-pix_fmt', 'yuv420p', '-r', '30',
    '-movflags', '+faststart', out,
  );
  run('ffmpeg', args);
  const size = videoSize(out);
  // 封面：取片中約 1 秒處
  await mkdir(P('.tmp'), { recursive: true });
  const frame = P('.tmp', `${basename(out)}.png`);
  run('ffmpeg', ['-v', 'error', '-y', '-ss', String(Math.min(1, size.duration / 2)), '-i', out, '-frames:v', '1', frame]);
  await sharp(frame).webp({ quality: 72 }).toFile(poster);
  return size;
}

/* ---------- 主流程 ---------- */
need('ffmpeg'); need('ffprobe');
const trip = YAML.parse(await readFile(P('src/content/site/trip.yaml'), 'utf8'));
const dayNo = Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${trip.start}T00:00:00Z`)) / 86_400_000) + 1;
if (dayNo < 1) { console.error(`${date} 早於 trip.yaml 的起始日 ${trip.start}`); process.exit(1); }
const prefix = `${trip.prefix ?? 'JP'}-${pad(dayNo)}-`;
const rawDir = P('raw', date);
const outDir = P('public/media', date);
const exDir = P('src/content/exhibits');
const dayFile = P('src/content/days', `${date}.yaml`);

// 既有展品
const existing = new Map(); // id -> { doc, data }
for (const f of (await readdir(exDir)).filter((f) => f.startsWith(prefix) && f.endsWith('.yaml'))) {
  const doc = YAML.parseDocument(await readFile(join(exDir, f), 'utf8'));
  existing.set(f.replace(/\.yaml$/, ''), { doc, data: doc.toJS() });
}
const bySource = new Map([...existing].filter(([, e]) => e.data.source).map(([id, e]) => [e.data.source, id]));
let seq = Math.max(0, ...[...existing.keys()].map((id) => Number(id.slice(prefix.length)) || 0));

if (!opt.dry) await mkdir(outDir, { recursive: true });
const rel = (abs) => abs.slice(P('public').length + 1);

/* --redo：依展品檔的 clip / crop 重新轉檔 */
if (opt.redo?.length) {
  for (const id of opt.redo) {
    const e = existing.get(id);
    if (!e) { console.error(`找不到展品 ${id}（只能 redo ${date} 這天的展品）`); continue; }
    const src = e.data.source && join(rawDir, e.data.source);
    if (!src || !existsSync(src)) { console.error(`${id}：raw/${date}/ 裡找不到原始檔 ${e.data.source ?? '（source 未設定）'}`); continue; }
    if (opt.dry) { console.log(`[dry] 重新轉檔 ${id} ← ${e.data.source}`); continue; }
    const out = join(P('public'), e.data.media);
    if (e.data.type === 'video') {
      const poster = join(P('public'), e.data.poster ?? e.data.media.replace(/\.mp4$/, '-poster.webp'));
      const s = await convertVideo(src, out, poster, e.data.clip);
      e.doc.set('width', s.width); e.doc.set('height', s.height); e.doc.set('duration', mmss(s.duration)); quote(e.doc, ['duration']);
    } else {
      const s = await convertPhoto(src, out, e.data.crop);
      e.doc.set('width', s.width); e.doc.set('height', s.height);
    }
    await writeFile(join(exDir, `${id}.yaml`), e.doc.toString());
    console.log(`✓ 重新轉檔 ${id}`);
  }
  await rm(P('.tmp'), { recursive: true, force: true });
  process.exit(0);
}

/* 新素材 */
if (!existsSync(rawDir)) { console.error(`找不到 raw/${date}/。請把當天的原始檔放進去。`); process.exit(1); }
const files = (await readdir(rawDir))
  .filter((f) => PHOTO.has(extname(f).toLowerCase()) || VIDEO.has(extname(f).toLowerCase()))
  .filter((f) => !bySource.has(f));
if (!files.length) { console.log(`raw/${date}/ 沒有新的檔案（已匯入的會略過）。`); process.exit(0); }

const items = [];
for (const f of files) {
  const src = join(rawDir, f);
  const type = VIDEO.has(extname(f).toLowerCase()) ? 'video' : 'photo';
  const taken = type === 'video' ? videoInfo(src).taken : await photoTime(src);
  if (!taken) console.warn(`  ⚠ ${f}：讀不到拍攝時間，時刻留空`);
  else if (taken.date !== date) console.warn(`  ⚠ ${f}：拍攝日期是 ${taken.date}，不是 ${date}，請確認是否放錯資料夾`);
  items.push({ f, src, type, taken });
}
// 依拍攝時間排序；讀不到時間的排最後，再依檔名
items.sort((a, b) => (a.taken ? `${a.taken.date} ${a.taken.time}` : '~').localeCompare(b.taken ? `${b.taken.date} ${b.taken.time}` : '~') || a.f.localeCompare(b.f));

const newIds = [];
for (const it of items) {
  const id = `${prefix}${pad(++seq)}`;
  const name = slug(it.f);
  const media = join(outDir, `${name}.${it.type === 'video' ? 'mp4' : 'webp'}`);
  const poster = join(outDir, `${name}-poster.webp`);
  if (opt.dry) { console.log(`[dry] ${id} ← ${it.f}（${it.type}，${it.taken?.time ?? '時刻不明'}）`); newIds.push(id); continue; }

  const s = it.type === 'video' ? await convertVideo(it.src, media, poster, null) : await convertPhoto(it.src, media, null);
  const data = {
    type: it.type,
    date,
    time: it.taken?.time ?? null,
    title: '',
    place: opt.place ?? '',
    note: '',
    media: rel(media),
    ...(it.type === 'video' ? { poster: rel(poster) } : {}),
    width: s.width,
    height: s.height,
    ...(it.type === 'video' ? { duration: mmss(s.duration) } : {}),
    source: it.f,
    clip: null,
    crop: null,
    draft: true,
  };
  const doc = quote(new YAML.Document(data), ['date', 'time', 'duration']);
  doc.commentBefore = ' 由 ingest 產生。title / note 只寫畫面看得到的事實；確認後把 draft 改成 false';
  await writeFile(join(exDir, `${id}.yaml`), doc.toString());
  newIds.push(id);
  console.log(`✓ ${id} ← ${it.f}  ${it.taken?.time ?? '（時刻不明）'}  ${s.width}×${s.height}`);
}

/* 把新展品加到當天最後一欄（unsorted） */
if (!opt.dry) {
  let doc;
  if (existsSync(dayFile)) doc = YAML.parseDocument(await readFile(dayFile, 'utf8'));
  else doc = new YAML.Document({ date, city: opt.city ?? '', place: opt.place ?? '', columns: [] });
  quote(doc, ['date']);
  if (doc.get('status') === 'pending') { doc.delete('status'); doc.delete('note'); }
  if (opt.city) doc.set('city', opt.city);
  if (opt.place) doc.set('place', opt.place);
  if (!doc.get('city')) console.warn('  ⚠ 這天還沒設定城市：請在 days 檔填 city，或加上 --city');
  if (!doc.has('columns')) doc.set('columns', []);
  doc.addIn(['columns'], doc.createNode({ width: 260, unsorted: true, items: newIds.map((id) => ({ exhibit: id })) }));
  await writeFile(dayFile, doc.toString());
  console.log(`✓ 已加到 src/content/days/${date}.yaml 的最後一欄（未排版）`);
}
await rm(P('.tmp'), { recursive: true, force: true });
console.log(`\n完成：${newIds.length} 件。下一步：補標題與說明、調整欄位，然後 npm run check。`);
