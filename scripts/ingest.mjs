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
//   - 日期用日本式 30 小時制：凌晨 0:00–5:59 歸前一天，時刻寫成 24:00–29:59；深夜素材要放進前一天的 raw 資料夾。
//   - 已存在的展品檔不覆寫（保護人工寫的標題與說明）；--redo 只更新媒體相關欄位。
//   - 輸出檔一律移除 metadata（含 GPS）；短片保留聲音（AAC），去除 Apple 附帶的資料軌與字幕軌。
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

/** 日本式 30 小時制：凌晨 0:00–5:59 算前一天，寫成 24:00–29:59（例：10-06 00:10 → 10-05 24:10） */
const DAY_ENDS_AT = 6;
function to27h(taken) {
  if (!taken) return null;
  const h = Number(taken.time.slice(0, 2));
  if (h >= DAY_ENDS_AT) return taken;
  const d = new Date(`${taken.date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return { date: d.toISOString().slice(0, 10), time: `${pad(h + 24)}${taken.time.slice(2)}` };
}

/** 照片拍攝時間：回傳 { date: 'YYYY-MM-DD', time: 'HH:MM' } 或 null。直接取字串，不做時區換算（即拍攝地當地時間）。 */
async function photoTime(file) {
  try {
    // 先讀成 Buffer：直接給路徑時，exifr 留下未關閉的 FileHandle，Node 26 在垃圾回收時會讓整個程序崩潰（try/catch 擋不住）
    const t = await exifr.parse(await readFile(file), { pick: ['DateTimeOriginal', 'CreateDate'], reviveValues: false });
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

/** 路人臉部虛化：boxes 是 [x, y, w, h]（轉正後整張圖的比例），每框向外擴 35% 再模糊 */
async function blurRegions(buf, boxes) {
  const { width: W, height: H } = await sharp(buf).metadata();
  const overlays = [];
  for (const [x, y, w, h] of boxes) {
    const pad = 0.35;
    const left = Math.max(0, Math.round((x - w * pad) * W));
    const top = Math.max(0, Math.round((y - h * pad) * H));
    const width = Math.min(W - left, Math.round(w * (1 + 2 * pad) * W));
    const height = Math.min(H - top, Math.round(h * (1 + 2 * pad) * H));
    if (width < 2 || height < 2) continue;
    const sigma = Math.max(3, Math.min(width, height) / 5);
    overlays.push({ input: await sharp(buf).extract({ left, top, width, height }).blur(sigma).toBuffer(), left, top });
  }
  return overlays.length ? sharp(buf).composite(overlays).jpeg({ quality: 95 }).toBuffer() : buf;
}

async function convertPhoto(src, out, crop, blur) {
  let input = src;
  const tmp = P('.tmp');
  if (/\.hei[cf]$/i.test(src)) {
    await mkdir(tmp, { recursive: true });
    input = join(tmp, `${slug(src)}.jpg`);
    if (process.platform === 'darwin') run('sips', ['-s', 'format', 'jpeg', src, '--out', input]);
    else run('heif-convert', [src, input]); // Linux：需要 libheif-examples
  }
  let img = sharp(input).rotate(); // 依 EXIF 方向轉正，輸出不保留 metadata
  if (blur?.length) img = sharp(await blurRegions(await img.jpeg({ quality: 95 }).toBuffer(), blur));
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

/** 有 ffmpeg-full（brew install ffmpeg-full，含 libvidstab）就優先用它；可用環境變數 FFMPEG 指定 */
const FFMPEG = process.env.FFMPEG ?? (existsSync('/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg') ? '/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg' : 'ffmpeg');

function hasAudio(file) {
  return run('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', file]).trim() !== '';
}

function sourceFps(file) {
  const j = JSON.parse(run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=avg_frame_rate', '-of', 'json', file]));
  const [n, d] = (j.streams[0].avg_frame_rate ?? '30/1').split('/').map(Number);
  return d ? n / d : 30;
}

/**
 * 短片轉檔。剪輯參數來自展品檔：
 *   clip：{ start, duration }（舊格式，等同一段、速度 1）
 *   edit：{ stabilize, segments: [{ start, end, speed }], poster }
 *     stabilize  雙階段 vidstab 防手震（需要 ffmpeg-full）；smoothing 平滑強度（預設 24，越大越穩但反應越慢）
 *     segments   依序取原片的這些段落再接起來，沒列到的部分捨棄；speed < 1 是放慢（聲音用 atempo 同步放慢，音高不變）
 *     poster     封面取剪輯後第幾秒（預設 1 秒）
 */
async function convertVideo(src, out, poster, clip, edit) {
  await mkdir(P('.tmp'), { recursive: true });
  const fps = sourceFps(src);
  const audio = hasAudio(src);
  const segments = edit?.segments?.length
    ? edit.segments
    : clip ? [{ start: clip.start, end: clip.start + clip.duration }] : null;

  const head = [];
  if (edit?.stabilize) {
    const trf = P('.tmp', `${basename(out)}.trf`);
    try {
      run(FFMPEG, ['-v', 'error', '-y', '-i', src, '-vf', `vidstabdetect=shakiness=7:accuracy=15:result=${trf}`, '-f', 'null', '-']);
    } catch {
      throw new Error(`防手震需要含 libvidstab 的 ffmpeg：brew install ffmpeg-full（目前用的是 ${FFMPEG}）`);
    }
    head.push(`vidstabtransform=input=${trf}:smoothing=${edit.smoothing ?? 24}:optzoom=1:zoomspeed=0.2:interpol=bicubic`, 'unsharp=5:5:0.5:3:3:0.3');
  }

  const scale = "scale='if(gte(iw,ih),min(1280,iw),min(720,iw))':-2";
  let graph;
  if (!segments) {
    graph = `[0:v]${[...head, 'fps=30', scale, 'format=yuv420p'].join(',')}[out]`;
    if (audio) graph += ';[0:a]aresample=48000[aout]';
  } else {
    const n = segments.length;
    const pre = n > 1 ? [...head, `split=${n}`] : head;
    const labels = segments.map((_, i) => `[s${i}]`).join('');
    const parts = segments.map((g, i) => {
      const speed = g.speed ?? 1;
      const chain = [`trim=start=${g.start}:end=${g.end}`, `setpts=(PTS-STARTPTS)/${speed}`];
      // 放慢後若原片的格數撐不到 30fps，用動態補幀；否則直接取 30fps
      chain.push(fps * speed < 29 ? 'minterpolate=fps=30:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1' : 'fps=30');
      return `[s${i}]${chain.join(',')}[v${i}]`;
    });
    const first = pre.length ? `[0:v]${pre.join(',')}${labels}` : '';
    const src0 = pre.length ? '' : null;
    // 聲音跟著影像剪：每段 atrim 對齊同一段，放慢的段落用 atempo（0.5～1）同步放慢
    const aparts = audio
      ? [
          n > 1 ? `[0:a]asplit=${n}${segments.map((_, i) => `[as${i}]`).join('')}` : null,
          ...segments.map((g, i) => {
            const speed = g.speed ?? 1;
            const chain = [`atrim=start=${g.start}:end=${g.end}`, 'asetpts=PTS-STARTPTS'];
            if (speed !== 1) chain.push(`atempo=${speed}`);
            return `${n > 1 ? `[as${i}]` : '[0:a]'}${chain.join(',')}[a${i}]`;
          }),
        ].filter(Boolean)
      : [];
    const joined = segments.map((_, i) => (audio ? `[v${i}][a${i}]` : `[v${i}]`)).join('');
    graph = [
      ...(first ? [first] : []),
      ...parts.map((p) => (src0 === null && n === 1 ? p.replace('[s0]', '[0:v]') : p)),
      ...aparts,
      audio
        ? `${joined}concat=n=${n}:v=1:a=1[vc][ac];[vc]${scale},format=yuv420p[out];[ac]aresample=48000[aout]`
        : `${joined}concat=n=${n}:v=1:a=0,${scale},format=yuv420p[out]`,
    ].join(';');
  }
  run(FFMPEG, [
    '-v', 'error', '-y', '-i', src, '-filter_complex', graph, '-map', '[out]',
    ...(audio ? ['-map', '[aout]', '-c:a', 'aac', '-b:a', '128k', '-ac', '2'] : ['-an']),
    '-sn', '-dn', '-map_metadata', '-1', '-map_chapters', '-1',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', String(CRF), '-r', '30',
    '-movflags', '+faststart', out,
  ]);
  const size = videoSize(out);
  // 封面：預設取剪輯後約 1 秒處，可用 edit.poster 指定
  const frame = P('.tmp', `${basename(out)}.png`);
  const at = Math.min(edit?.poster ?? 1, Math.max(0, size.duration - 0.1));
  run(FFMPEG, ['-v', 'error', '-y', '-ss', String(at), '-i', out, '-frames:v', '1', frame]);
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
      const s = await convertVideo(src, out, poster, e.data.clip, e.data.edit);
      e.doc.set('width', s.width); e.doc.set('height', s.height); e.doc.set('duration', mmss(s.duration)); quote(e.doc, ['duration']);
    } else {
      const s = await convertPhoto(src, out, e.data.crop, e.data.blur);
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
  const taken = to27h(type === 'video' ? videoInfo(src).taken : await photoTime(src));
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

  const s = it.type === 'video' ? await convertVideo(it.src, media, poster, null, null) : await convertPhoto(it.src, media, null);
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
  if (!doc.has('columns')) doc.set('columns', doc.createNode([])); // 要給 YAML 節點，給普通陣列 addIn 會失敗
  doc.addIn(['columns'], doc.createNode({ width: 260, unsorted: true, items: newIds.map((id) => ({ exhibit: id })) }));
  await writeFile(dayFile, doc.toString());
  console.log(`✓ 已加到 src/content/days/${date}.yaml 的最後一欄（未排版）`);
}
await rm(P('.tmp'), { recursive: true, force: true });
console.log(`\n完成：${newIds.length} 件。下一步：補標題與說明、調整欄位，然後 npm run check。`);
