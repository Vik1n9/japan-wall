#!/usr/bin/env node
// 收稿腳本：從 D1 讀取待處理投稿，逐筆展出（寫成 src/content/notes/<編號>.yaml）或標為未採用
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import YAML from 'yaml';

const ROOT = new URL('..', import.meta.url).pathname;
const NOTES_DIR = join(ROOT, 'src/content/notes');
const DAYS_DIR = join(ROOT, 'src/content/days');
const EXHIBITS_DIR = join(ROOT, 'src/content/exhibits');
const DB_NAME = 'osaka2026-notes';

const args = process.argv.slice(2);
let mode = 'list'; // 'list' | 'publish' | 'publish-all' | 'reject'
let targetIds = [];
let isLocal = false;
let persistTo = null;
let configPath = null;

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--local') {
    isLocal = true;
  } else if (a === '--remote') {
    isLocal = false;
  } else if (a === '--persist-to') {
    persistTo = args[++i];
  } else if (a === '--config') {
    configPath = args[++i];
  } else if (a === '--publish-all') {
    mode = 'publish-all';
  } else if (a === '--publish') {
    mode = 'publish';
    const raw = args[++i] || '';
    targetIds.push(...raw.split(',').map((s) => s.trim()).filter(Boolean));
  } else if (a === '--reject') {
    mode = 'reject';
    const raw = args[++i] || '';
    targetIds.push(...raw.split(',').map((s) => s.trim()).filter(Boolean));
  } else if (!a.startsWith('--') && (mode === 'publish' || mode === 'reject')) {
    targetIds.push(...a.split(',').map((s) => s.trim()).filter(Boolean));
  } else {
    console.error(`未知參數：${a}`);
    process.exit(1);
  }
}

function sqlQuote(str) {
  return `'${String(str).replace(/'/g, "''")}'`;
}

function runD1(sql) {
  const cmdArgs = ['--yes', 'wrangler@4', 'd1', 'execute', DB_NAME, isLocal ? '--local' : '--remote', '--json'];
  if (persistTo) cmdArgs.push('--persist-to', persistTo);
  if (configPath) cmdArgs.push('--config', configPath);
  cmdArgs.push('--command', sql);
  const out = execFileSync('npx', cmdArgs, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const parsed = JSON.parse(out);
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  return first?.results ?? [];
}

function nowTaipeiIso() {
  const ms = Date.now() + 8 * 3600_000;
  const d = new Date(ms);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}+08:00`;
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const HANDLE_RE = /(?:^|[^\w])@[A-Za-z0-9_.-]{2,}/;
const PHONE_RE = /(?:^|\D)(?:09\d{2}[-\s]?\d{3}[-\s]?\d{3}|\+(?:81|886)[-\s\d]{7,13}|0\d{1,3}-\d{3,4}-\d{3,4})(?:\D|$)/;
function hasPii(text) {
  if (typeof text !== 'string' || !text) return false;
  return EMAIL_RE.test(text) || HANDLE_RE.test(text) || PHONE_RE.test(text);
}

function validateNoteSchema(note, validDays, validExhibits, publishedEmas, publishedComments) {
  if (note.kind !== 'comment' && note.kind !== 'ema') return 'kind 必須是 comment 或 ema';
  if (typeof note.by !== 'string' || note.by.length > 20) return 'by 長度超過 20 字';
  if (typeof note.body !== 'string' || note.body.trim().length < 1 || note.body.length > 300) return 'body 長度須為 1～300 字';
  if (hasPii(note.by) || hasPii(note.body)) return '署名或內文疑似含 email、電話號碼或 @ 帳號';
  if (typeof note.posted !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(note.posted)) {
    return 'posted 格式不是含時區的 ISO 8601 時間字串';
  }
  if (note.kind === 'ema') {
    if (!validDays.has(note.target)) return `繪馬 target 日期 ${note.target} 不存在`;
    if (note.replyTo !== null) return '繪馬不可有 replyTo';
  } else {
    if (!validExhibits.has(note.target) && !publishedEmas.has(note.target)) {
      return `留言對象 ${note.target} 尚未展出`;
    }
    if (note.replyTo !== null) {
      const parentTarget = publishedComments.get(note.replyTo);
      if (!parentTarget) return `回覆對象 ${note.replyTo} 尚未展出`;
      if (parentTarget !== note.target) return `回覆對象 ${note.replyTo} 的 target（${parentTarget}）與本則不符`;
    }
  }
  return null;
}

function formatNoteYaml(row) {
  const doc = new YAML.Document({
    kind: row.kind,
    target: row.target,
    replyTo: row.reply_to ?? null,
    by: row.by ?? '',
    body: row.body,
    posted: row.posted_at,
  });
  doc.commentBefore = ' 由 notes:pull 產生。內容為投稿者原文，不得修改';
  for (const key of ['target', 'by', 'body', 'posted']) {
    const node = doc.get(key, true);
    if (node && typeof node.value === 'string') node.type = 'QUOTE_DOUBLE';
  }
  if (row.reply_to) {
    const rNode = doc.get('replyTo', true);
    if (rNode) rNode.type = 'QUOTE_DOUBLE';
  }
  return doc.toString();
}

const allPending = runD1(
  `SELECT id, kind, target, reply_to, by, body, author, status, posted_at
   FROM posts
   WHERE status = 'pending'
   ORDER BY posted_at ASC, id ASC`,
);

if (mode === 'list') {
  if (allPending.length === 0) {
    console.log('目前沒有待收稿（pending）的投稿。');
    process.exit(0);
  }
  console.log(`待收稿共 ${allPending.length} 則：\n`);
  for (const p of allPending) {
    const typeLabel = p.kind === 'ema' ? '繪馬' : '留言';
    const replyInfo = p.reply_to ? `（回覆 ${p.reply_to}）` : '';
    console.log(`[${p.id}] ${typeLabel} → ${p.target}${replyInfo}`);
    console.log(`  署名：${p.by || '（無署名）'}｜作者：${p.author}｜時間：${p.posted_at}`);
    console.log(`  內文：${p.body.replace(/\n/g, '\n        ')}\n`);
  }
  process.exit(0);
}

const pendingById = new Map(allPending.map((p) => [p.id, p]));

if (mode === 'reject') {
  if (targetIds.length === 0) {
    console.error('請指定要標為未採用的編號：--reject <編號,…>');
    process.exit(1);
  }
  const now = nowTaipeiIso();
  const rejectedIds = [];
  for (const id of targetIds) {
    if (!pendingById.has(id)) {
      console.error(`  跳過 ${id}：不在待收稿（pending）清單中`);
      continue;
    }
    runD1(`UPDATE posts SET status = 'rejected', decided_at = ${sqlQuote(now)} WHERE id = ${sqlQuote(id)} AND status = 'pending'`);
    rejectedIds.push(id);
    console.log(`✓ 已標為未採用：${id}`);
  }

  if (rejectedIds.length > 0) {
    const dependents = allPending.filter(
      (p) => !rejectedIds.includes(p.id) && (rejectedIds.includes(p.reply_to) || rejectedIds.includes(p.target)),
    );
    if (dependents.length > 0) {
      console.log('\n  提醒：以下待收稿項目回覆或留言於剛才未採用的投稿，請決定是否一併處理：');
      for (const d of dependents) {
        console.log(`    - ${d.id}（target: ${d.target}${d.reply_to ? `, replyTo: ${d.reply_to}` : ''}）：${d.body.slice(0, 30)}`);
      }
    }
  }
  process.exit(0);
}

// mode === 'publish' || mode === 'publish-all'
const selectedIds = mode === 'publish-all' ? allPending.map((p) => p.id) : targetIds;
if (selectedIds.length === 0) {
  console.log('沒有需要展出的投稿。');
  process.exit(0);
}

await mkdir(NOTES_DIR, { recursive: true });
const validDays = new Set(
  (await readdir(DAYS_DIR))
    .filter((f) => f.endsWith('.yaml'))
    .map((f) => f.replace(/\.yaml$/, '')),
);
const validExhibits = new Set(
  (await readdir(EXHIBITS_DIR))
    .filter((f) => f.endsWith('.yaml'))
    .map((f) => f.replace(/\.yaml$/, '')),
);

const publishedEmas = new Set();
const publishedComments = new Map();
for (const f of (await readdir(NOTES_DIR)).filter((f) => f.endsWith('.yaml'))) {
  const id = f.replace(/\.yaml$/, '');
  const data = YAML.parse(await readFile(join(NOTES_DIR, f), 'utf8'));
  if (data?.kind === 'ema') publishedEmas.add(id);
  else if (data?.kind === 'comment') publishedComments.set(id, data.target);
}

const queue = [];
const skippedErrors = [];
for (const id of selectedIds) {
  const row = pendingById.get(id);
  if (!row) {
    skippedErrors.push(`${id}：不在待收稿（pending）清單中`);
    continue;
  }
  queue.push(row);
}

const createdFiles = [];
const keptPending = [];
const now = nowTaipeiIso();

// 依相依順序多輪處理：先展出繪馬與頂層留言，再展出依賴它們的留言或回覆
let remaining = queue;
let progressed = true;
while (progressed && remaining.length > 0) {
  progressed = false;
  const nextRemaining = [];
  for (const row of remaining) {
    const filePath = join(NOTES_DIR, `${row.id}.yaml`);
    if (existsSync(filePath)) {
      skippedErrors.push(`${row.id}：檔案 src/content/notes/${row.id}.yaml 已存在，絕不覆寫`);
      continue;
    }

    // 檢查相依對象是否已展出
    const needTargetEma = row.kind === 'comment' && row.target.startsWith('n-') && !publishedEmas.has(row.target);
    const needReplyParent = row.kind === 'comment' && row.reply_to && !publishedComments.has(row.reply_to);
    if (needTargetEma || needReplyParent) {
      nextRemaining.push(row);
      continue;
    }

    const yamlText = formatNoteYaml(row);
    const parsed = YAML.parse(yamlText);
    const err = validateNoteSchema(parsed, validDays, validExhibits, publishedEmas, publishedComments);
    if (err) {
      skippedErrors.push(`${row.id}：驗證未通過（${err}），保留為 pending`);
      continue;
    }

    await writeFile(filePath, yamlText, 'utf8');
    runD1(`UPDATE posts SET status = 'published', decided_at = ${sqlQuote(now)} WHERE id = ${sqlQuote(row.id)} AND status = 'pending'`);

    if (row.kind === 'ema') publishedEmas.add(row.id);
    else publishedComments.set(row.id, row.target);

    createdFiles.push(`src/content/notes/${row.id}.yaml`);
    progressed = true;
  }
  remaining = nextRemaining;
}

for (const row of remaining) {
  const reasons = [];
  if (row.kind === 'comment' && row.target.startsWith('n-') && !publishedEmas.has(row.target)) {
    reasons.push(`留言對象繪馬 ${row.target} 尚未展出`);
  }
  if (row.kind === 'comment' && row.reply_to && !publishedComments.has(row.reply_to)) {
    reasons.push(`回覆對象留言 ${row.reply_to} 尚未展出`);
  }
  keptPending.push(`${row.id}：保留在 pending（${reasons.join('、')}）`);
}

if (createdFiles.length > 0) {
  console.log(`✓ 已展出 ${createdFiles.length} 則投稿，新增檔案：`);
  for (const f of createdFiles) console.log(`  - ${f}`);
}
if (keptPending.length > 0) {
  console.log('\n以下投稿因相依對象尚未展出，先保留在 pending：');
  for (const m of keptPending) console.log(`  提醒  ${m}`);
}
if (skippedErrors.length > 0) {
  console.error('\n以下項目未處理：');
  for (const e of skippedErrors) console.error(`  錯誤  ${e}`);
}
if (createdFiles.length > 0) {
  console.log('\n下一步：npm run dev 看一次 → npm run build → git commit → npm run deploy');
}
if (skippedErrors.length > 0) {
  process.exit(1);
}
