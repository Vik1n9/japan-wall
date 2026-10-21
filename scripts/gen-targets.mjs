#!/usr/bin/env node
// 產生 public/edit/targets.json：投稿 target 的白名單（展品編號＋展覽日）。
// 後台 Worker 透過 env.ASSETS.fetch('/edit/targets.json') 讀取做伺服器端驗證；
// 檔案放在 /edit/ 下，前台 Worker 對 /edit* 一律 404，前台拿不到也無痕跡。
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import YAML from 'yaml';

const ROOT = new URL('..', import.meta.url).pathname;
const EXHIBITS = join(ROOT, 'src/content/exhibits');
const DAYS = join(ROOT, 'src/content/days');
const OUT = join(ROOT, 'public/edit/targets.json');

const exhibitIds = [];
for (const f of (await readdir(EXHIBITS)).filter((f) => f.endsWith('.yaml')).sort()) {
  exhibitIds.push(f.replace(/\.yaml$/, ''));
}

const dayDates = [];
for (const f of (await readdir(DAYS)).filter((f) => f.endsWith('.yaml')).sort()) {
  const data = YAML.parse(await readFile(join(DAYS, f), 'utf8'));
  if (data?.date) dayDates.push(data.date);
}

await mkdir(join(ROOT, 'public/edit'), { recursive: true });
await writeFile(OUT, JSON.stringify({ exhibits: exhibitIds, days: dayDates }), 'utf8');
console.log(`[gen-targets] ${exhibitIds.length} exhibits, ${dayDates.length} days → public/edit/targets.json`);
