#!/usr/bin/env node
// 後台介面煙霧測試：無頭 Chrome（DevTools Protocol）實際操作 /edit 與 /admin，每次改前端都跑一次。
// 用法：KURA_ADMIN=<帳號> KURA_ADMIN_PW=<密碼> node scripts/ui-smoke.mjs [http://localhost:8787] [截圖資料夾]
// 前置：npm run build && npm run dev:api。只對本機用；會建立 ui-* 測試帳號與內容，跑完刪除/停用。
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.argv[2] || 'http://localhost:8787';
const SHOTS = process.argv[3] || '';
const ADMIN = process.env.KURA_ADMIN;
const ADMIN_PW = process.env.KURA_ADMIN_PW;
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if (!ADMIN || !ADMIN_PW) { console.error('需要 KURA_ADMIN 與 KURA_ADMIN_PW'); process.exit(2); }
if (!/localhost|127\.0\.0\.1/.test(BASE)) { console.error('只允許對本機跑'); process.exit(2); }
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  ok ? pass++ : fail++;
  console.log(`${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : ` — ${detail}`}`);
};

/* ---------- 啟動 Chrome＋CDP ---------- */
const port = 9300 + Math.floor(Math.random() * 500);
const profile = mkdtempSync(join(tmpdir(), 'kura-ui-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--window-size=1280,900', 'about:blank',
], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let target;
for (let i = 0; i < 50 && !target; i++) {
  await sleep(200);
  try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page'); } catch { /* 還沒起來 */ }
}
if (!target) { console.error('Chrome 啟動失敗'); chrome.kill(); process.exit(1); }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let seq = 0;
const pending = new Map();
const events = [];
ws.addEventListener('message', (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  else if (msg.method) events.push(msg);
});
const cdp = (method, params = {}) => new Promise((resolve) => {
  const id = ++seq;
  pending.set(id, resolve);
  ws.send(JSON.stringify({ id, method, params }));
});
await cdp('Page.enable');
await cdp('Runtime.enable');
await cdp('Page.setLifecycleEventsEnabled', { enabled: true });

/** 在頁面裡跑一段 async 函式本體，回傳結果 */
async function run(body) {
  const r = await cdp('Runtime.evaluate', { expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'evaluate 失敗');
  return r.result?.result?.value;
}
async function goto(path) {
  events.length = 0;
  await cdp('Page.navigate', { url: BASE + path });
  for (let i = 0; i < 100; i++) {
    await sleep(100);
    if (events.some((e) => e.method === 'Page.lifecycleEvent' && e.params.name === 'networkIdle')) break;
  }
}
async function waitFor(cond, ms = 5000) {
  for (let t = 0; t < ms; t += 100) {
    if (await run(`return !!(${cond});`)) return true;
    await sleep(100);
  }
  return false;
}
async function shot(name, width = 1280) {
  if (!SHOTS) return;
  await cdp('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 600 });
  await sleep(300);
  const r = await cdp('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(r.result.data, 'base64'));
}
const api = (method, path, body) => run(`
  const r = await fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} });
  let d = null; try { d = await r.json(); } catch {}
  return { status: r.status, data: d };`);
const dialogs = () => events.filter((e) => e.method === 'Page.javascriptDialogOpening').length;

const tag = Math.random().toString(36).slice(2, 6);
try {
  /* ---------- /edit 登入 ---------- */
  await goto('/edit');
  check('/edit 未登入顯示登入遮罩', await run(`return !document.getElementById('edit-mask').hidden;`));
  await shot('edit-login');
  await run(`const f = document.getElementById('em-login'); f.username.value = ${JSON.stringify(ADMIN)}; f.password.value = 'wrong-pass-x'; f.requestSubmit();`);
  check('錯誤密碼顯示錯誤訊息', await waitFor(`document.getElementById('em-login-err').textContent.length > 0`));
  await run(`const f = document.getElementById('em-login'); f.username.value = ${JSON.stringify(ADMIN)}; f.password.value = ${JSON.stringify(ADMIN_PW)}; f.requestSubmit();`);
  check('登入後顯示工具列', await waitFor(`!document.getElementById('edit-bar').hidden`));

  /* ---------- 掛繪馬（表單）→ 牆上自動出現 ---------- */
  await run(`document.getElementById('em-uploads').click();`);
  await run(`const f = document.getElementById('post-form'); f.kind.value = 'ema'; f.kind.dispatchEvent(new Event('change'));
    f.targetDay.value = '2026-10-07'; f.body.value = 'UI 測試繪馬 ${tag}'; f.requestSubmit();`);
  check('送出繪馬顯示成功', await waitFor(`document.getElementById('post-ok').textContent.includes('已送出')`));
  check('牆上自動出現新繪馬（不必重新整理）', await waitFor(`[...document.querySelectorAll('.ema-list')].some((el) => el.textContent.includes('UI 測試繪馬 ${tag}'))`, 8000));
  await shot('edit-drawer');

  /* ---------- 行內編輯投稿 ---------- */
  const edited = `UI 測試繪馬 ${tag} 改`;
  await run(`const item = [...document.querySelectorAll('.pst-item')].find((el) => el.textContent.includes('UI 測試繪馬 ${tag}'));
    item.querySelector('.ops button:not(.del)').click();`);
  check('投稿編輯改為行內表單', await waitFor(`document.querySelector('.pst-item .ep-edit textarea')`));
  await run(`const f = document.querySelector('.pst-item .ep-edit'); f.querySelector('textarea').value = ${JSON.stringify(edited)}; f.requestSubmit();`);
  check('行內編輯儲存後清單更新', await waitFor(`[...document.querySelectorAll('.pst-body')].some((el) => el.textContent === ${JSON.stringify(edited)})`));
  check('牆上繪馬同步更新', await waitFor(`[...document.querySelectorAll('.ema-list')].some((el) => el.textContent.includes(${JSON.stringify(edited)}))`, 8000));

  /* ---------- 上傳照片（DataTransfer 塞檔案） ---------- */
  await run(`const c = document.createElement('canvas'); c.width = 80; c.height = 60; const g = c.getContext('2d'); g.fillStyle = '#2a6'; g.fillRect(0, 0, 80, 60);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    const dt = new DataTransfer(); dt.items.add(new File([blob], 'ui.png', { type: 'image/png' }));
    const f = document.getElementById('up-form'); f.file.files = dt.files; f.day.value = '2026-10-08'; f.caption.value = 'UI 測試照片 ${tag}'; f.requestSubmit();`);
  check('上傳照片顯示成功', await waitFor(`document.getElementById('up-ok').textContent.includes('已上傳')`, 10000));
  check('牆上自動出現親友照片', await waitFor(`[...document.querySelectorAll('.col-friends')].some((el) => el.innerHTML.includes('UI 測試照片 ${tag}'))`, 8000));

  /* ---------- 兩段式刪除（不能跳原生對話框） ---------- */
  const before = dialogs();
  await run(`const item = [...document.querySelectorAll('.ep-item')].find((el) => el.textContent.includes('UI 測試照片 ${tag}'));
    item.querySelector('.del').click();`);
  check('第一次按刪除只變成確認狀態', await waitFor(`document.querySelector('.ep-item .del.armed')`));
  await run(`document.querySelector('.ep-item .del.armed').click();`);
  check('第二次按才刪除，牆上同步消失', await waitFor(`![...document.querySelectorAll('.col-friends')].some((el) => el.innerHTML.includes('UI 測試照片 ${tag}'))`, 8000));
  await run(`const item = [...document.querySelectorAll('.pst-item')].find((el) => el.textContent.includes(${JSON.stringify(edited)}));
    item.querySelector('.del').click(); await new Promise((r) => setTimeout(r, 50)); item.querySelector('.del').click();`);
  check('刪除投稿後牆上繪馬消失', await waitFor(`![...document.querySelectorAll('.ema-list')].some((el) => el.textContent.includes(${JSON.stringify(edited)}))`, 8000));
  check('全程沒有跳出原生對話框', dialogs() === before, `${dialogs() - before} 次`);

  /* ---------- 新帳號：必須先改密碼 ---------- */
  const uname = `ui-${tag}`;
  const created = await api('POST', '/api/users', { username: uname, displayName: 'UI 測試' });
  check('建立測試帳號', created.status === 201, JSON.stringify(created));
  await run(`document.getElementById('em-logout').click();`);
  check('登出回到登入遮罩', await waitFor(`!document.getElementById('edit-mask').hidden`));
  await run(`const f = document.getElementById('em-login'); f.username.value = '${uname}'; f.password.value = ${JSON.stringify(created.data?.password || '')}; f.requestSubmit();`);
  check('新帳號登入後強制跳改密碼', await waitFor(`!document.getElementById('edit-pw').hidden && document.getElementById('em-pw-cancel').hidden`));
  await shot('edit-force-pw');
  await shot('edit-force-pw-phone', 400);
  await cdp('Emulation.clearDeviceMetricsOverride');
  await run(`const f = document.getElementById('em-pw-form'); f.currentPassword.value = ${JSON.stringify(created.data?.password || '')}; f.newPassword.value = 'Ui-${tag}-new-pass'; f.requestSubmit();`);
  check('改密碼後關閉視窗', await waitFor(`document.getElementById('edit-pw').hidden`));
  await run(`document.getElementById('em-logout').click();`);
  await waitFor(`!document.getElementById('edit-mask').hidden`);

  /* ---------- 收尾：用管理員停用測試帳號 ---------- */
  await run(`const f = document.getElementById('em-login'); f.username.value = ${JSON.stringify(ADMIN)}; f.password.value = ${JSON.stringify(ADMIN_PW)}; f.requestSubmit();`);
  await waitFor(`!document.getElementById('edit-bar').hidden`);
  const dis = await api('PATCH', `/api/users/${uname}`, { status: 'disabled' });
  check('停用測試帳號', dis.status === 200, JSON.stringify(dis));

  /* ---------- /admin ---------- */
  // 先放一則繪馬與一張照片，給審核介面刪
  const modEma = await api('POST', '/api/posts', { kind: 'ema', target: '2026-10-09', body: `審核測試 ${tag}` });
  await goto('/admin');
  check('/admin 已登入直接進管理台', await waitFor(`!document.getElementById('adm-console').hidden`));
  check('審核介面列出投稿', await waitFor(`document.getElementById('mod-posts').textContent.includes('審核測試 ${tag}')`));
  const before2 = dialogs();
  // 行內改名
  await run(`const tr = [...document.querySelectorAll('#users-tbl tbody tr')].find((r) => r.textContent.includes('ui-${tag}'));
    [...tr.querySelectorAll('button')].find((b) => b.textContent === '改名').click();`);
  check('改名變成行內輸入框', await waitFor(`document.querySelector('#users-tbl .rename input')`));
  await run(`const f = document.querySelector('#users-tbl .rename'); f.querySelector('input').value = 'UI 改名 ${tag}'; f.requestSubmit();`);
  check('改名儲存後列表更新', await waitFor(`document.getElementById('users-tbl').textContent.includes('UI 改名 ${tag}')`));
  // 兩段式重設密碼
  await run(`const tr = [...document.querySelectorAll('#users-tbl tbody tr')].find((r) => r.textContent.includes('ui-${tag}'));
    [...tr.querySelectorAll('button')].find((b) => b.textContent === '重設密碼').click();`);
  check('重設密碼第一次按只進入確認', await waitFor(`document.querySelector('#users-tbl button.armed')`) && await run(`return document.getElementById('pw-reveal').hidden;`));
  await run(`document.querySelector('#users-tbl button.armed').click();`);
  check('第二次按才重設並顯示一次性密碼', await waitFor(`!document.getElementById('pw-reveal').hidden && document.getElementById('pw-reveal-value').textContent.length >= 8`));
  await run(`document.getElementById('pw-reveal-close').click();`);
  // 審核刪除投稿
  await run(`document.querySelector('.tab[data-tab=posts]').click();`);
  await shot('admin-moderation');
  await run(`const it = [...document.querySelectorAll('.mod-po')].find((el) => el.textContent.includes('審核測試 ${tag}'));
    const b = it.querySelector('button'); b.click(); await new Promise((r) => setTimeout(r, 50)); b.click();`);
  check('審核刪除投稿後從列表消失', await waitFor(`!document.getElementById('mod-posts').textContent.includes('審核測試 ${tag}')`));
  const wall2 = await api('GET', '/api/public/wall');
  check('審核刪除後公開牆也消失', !JSON.stringify(wall2.data).includes(`審核測試 ${tag}`));
  check('/admin 全程沒有跳出原生對話框', dialogs() === before2, `${dialogs() - before2} 次`);
  void modEma;
  await shot('admin-console');
  await shot('admin-console-phone', 400);
  check('手機版帳號表格不需左右捲動', await run(`const w = document.querySelector('.tbl-wrap'); return w.scrollWidth <= w.clientWidth + 1;`));
  await cdp('Emulation.clearDeviceMetricsOverride');
} catch (err) {
  check('測試流程未中斷', false, err.message);
} finally {
  ws.close();
  chrome.kill();
}
console.log(`\n${pass} 通過、${fail} 失敗`);
process.exit(fail ? 1 : 0);
