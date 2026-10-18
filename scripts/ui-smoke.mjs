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
  check('牆上自動出現上傳的照片', await waitFor(`[...document.querySelectorAll('.col-photos')].some((el) => el.innerHTML.includes('UI 測試照片 ${tag}'))`, 8000));

  /* ---------- 兩段式刪除（不能跳原生對話框） ---------- */
  const before = dialogs();
  await run(`const item = [...document.querySelectorAll('.ep-item')].find((el) => el.textContent.includes('UI 測試照片 ${tag}'));
    item.querySelector('.del').click();`);
  check('第一次按刪除只變成確認狀態', await waitFor(`document.querySelector('.ep-item .del.armed')`));
  await run(`document.querySelector('.ep-item .del.armed').click();`);
  check('第二次按才刪除，牆上同步消失', await waitFor(`![...document.querySelectorAll('.col-photos')].some((el) => el.innerHTML.includes('UI 測試照片 ${tag}'))`, 8000));
  await run(`const item = [...document.querySelectorAll('.pst-item')].find((el) => el.textContent.includes(${JSON.stringify(edited)}));
    item.querySelector('.del').click(); await new Promise((r) => setTimeout(r, 50)); item.querySelector('.del').click();`);
  check('刪除投稿後牆上繪馬消失', await waitFor(`![...document.querySelectorAll('.ema-list')].some((el) => el.textContent.includes(${JSON.stringify(edited)}))`, 8000));
  check('全程沒有跳出原生對話框', dialogs() === before, `${dialogs() - before} 次`);

  /* ---------- 說明卡裡直接留言、回覆 ---------- */
  await run(`document.getElementById('ed-close').click(); document.querySelector('.it-media[data-exhibit-id="JP-01-03"]').click();`);
  check('編輯模式說明卡出現留言表單', await waitFor(`!document.getElementById('lb').hidden && document.getElementById('lb-cmt-form') && !document.getElementById('lb-cmt-form').hidden`));
  await run(`const ta = document.querySelector('#lb-cmt-form textarea'); ta.focus(); ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));`);
  check('在留言框按右鍵不會換下一件', await run(`return document.getElementById('lb-no').textContent === 'JP-01-03';`));
  await run(`const f = document.getElementById('lb-cmt-form'); f.querySelector('textarea').value = '說明卡留言 ${tag}'; f.requestSubmit();`);
  check('送出後留言串更新、說明卡仍停在同一件', await waitFor(`document.getElementById('lb-cmts').textContent.includes('說明卡留言 ${tag}') && document.getElementById('lb-no').textContent === 'JP-01-03' && !document.getElementById('lb').hidden`, 8000));
  await run(`const c = [...document.querySelectorAll('#lb-cmts .cmt')].find((el) => el.textContent.includes('說明卡留言 ${tag}')); c.querySelector('.cmt-reply').click();`);
  check('按回覆顯示「回覆 …」提示', await waitFor(`!document.querySelector('#lb-cmt-form .replying').hidden`));
  await run(`const f = document.getElementById('lb-cmt-form'); f.querySelector('textarea').value = '說明卡回覆 ${tag}'; f.requestSubmit();`);
  check('回覆以縮排顯示在原留言下', await waitFor(`[...document.querySelectorAll('#lb-cmts .cmt.reply')].some((el) => el.textContent.includes('說明卡回覆 ${tag}'))`, 8000));
  await shot('edit-lightbox-comment');
  await run(`document.getElementById('lb-x').click();`);
  const mine = await api('GET', '/api/posts');
  for (const p of (mine.data?.posts || []).filter((x) => x.body.includes(`說明卡`) && x.body.includes(tag))) await api('DELETE', `/api/posts/${p.id}`);

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
  // 照片＋照片下的留言：審核介面要標「照片 p-…」而不是「展品 p-…」
  const modPhoto = await run(`const c = document.createElement('canvas'); c.width = 60; c.height = 40; const g = c.getContext('2d'); g.fillStyle = '#37a'; g.fillRect(0, 0, 60, 40);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
    const fd = new FormData(); fd.append('file', blob, 'm.jpg'); fd.append('day', '2026-10-09'); fd.append('caption', '審核照片 ${tag}');
    const r = await fetch('/api/photos', { method: 'POST', body: fd, credentials: 'same-origin' }); return (await r.json()).photo?.id;`);
  const modPc = modPhoto ? await api('POST', '/api/posts', { kind: 'comment', target: modPhoto, body: `照片留言審核 ${tag}` }) : null;
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
  check('一次性密碼視窗關閉後不殘留密碼', await run(`return document.getElementById('pw-reveal').hidden && document.getElementById('pw-reveal-value').textContent === '';`));
  // 審核刪除投稿
  await run(`document.querySelector('.tab[data-tab=posts]').click();`);
  await shot('admin-moderation');
  await run(`const it = [...document.querySelectorAll('.mod-po')].find((el) => el.textContent.includes('審核測試 ${tag}'));
    const b = it.querySelector('button'); b.click(); await new Promise((r) => setTimeout(r, 50)); b.click();`);
  check('審核刪除投稿後從列表消失', await waitFor(`!document.getElementById('mod-posts').textContent.includes('審核測試 ${tag}')`));
  if (modPc?.data?.post?.id) {
    check('審核介面：照片下的留言標為「照片 p-…」', await waitFor(`[...document.querySelectorAll('.mod-po')].some((el) => el.textContent.includes('照片留言審核 ${tag}') && el.textContent.includes('照片 p-'))`));
  } else {
    check('審核介面：照片下的留言標為「照片 p-…」', false, '測試照片建立失敗');
  }
  const wall2 = await api('GET', '/api/public/wall');
  check('審核刪除後公開牆也消失', !JSON.stringify(wall2.data).includes(`審核測試 ${tag}`));
  check('/admin 全程沒有跳出原生對話框', dialogs() === before2, `${dialogs() - before2} 次`);
  void modEma;
  await shot('admin-console');
  await shot('admin-console-phone', 400);
  check('手機版帳號表格不需左右捲動', await run(`const w = document.querySelector('.tbl-wrap'); return w.scrollWidth <= w.clientWidth + 1;`));
  await cdp('Emulation.clearDeviceMetricsOverride');

  /* ---------- 公開牆：動態內容的呈現（以管理員身分先放測試內容，看首頁） ---------- */
  const pe = await api('POST', '/api/posts', { kind: 'ema', target: '2026-10-05', body: `公開牆繪馬 ${tag}`, by: '測試署名' });
  const pc1 = await api('POST', '/api/posts', { kind: 'comment', target: pe.data?.post?.id, body: `繪馬留言 ${tag}` });
  const px1 = await api('POST', '/api/posts', { kind: 'comment', target: 'JP-01-02', body: `展品留言 ${tag}` });
  const px2 = await api('POST', '/api/posts', { kind: 'comment', target: 'JP-01-02', body: `回覆 ${tag}`, replyTo: px1.data?.post?.id });
  const pp = await run(`const c = document.createElement('canvas'); c.width = 90; c.height = 60; const g = c.getContext('2d'); g.fillStyle = '#c63'; g.fillRect(0, 0, 90, 60);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
    const fd = new FormData(); fd.append('file', blob, 'p.jpg'); fd.append('day', '2026-10-05'); fd.append('caption', '公開牆照片 ${tag}'); fd.append('takenAt', '2026-10-05T09:30:00');
    const r = await fetch('/api/photos', { method: 'POST', body: fd, credentials: 'same-origin' }); return (await r.json()).photo?.id;`);
  // 直幅長圖：與上一張同一欄（09:31），兩張疊起來會超過展品欄，要觸發欄寬縮窄
  const pp2 = await run(`const c = document.createElement('canvas'); c.width = 60; c.height = 220; const g = c.getContext('2d'); g.fillStyle = '#36c'; g.fillRect(0, 0, 60, 220);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
    const fd = new FormData(); fd.append('file', blob, 'p2.jpg'); fd.append('day', '2026-10-05'); fd.append('caption', '直幅照片 ${tag}'); fd.append('takenAt', '2026-10-05T09:31:00');
    const r = await fetch('/api/photos', { method: 'POST', body: fd, credentials: 'same-origin' }); return (await r.json()).photo?.id;`);
  const ppc = pp ? await api('POST', '/api/posts', { kind: 'comment', target: pp, body: `照片留言 ${tag}` }) : null;
  // 每欄最多兩個：再放兩塊繪馬（共三塊），繪馬掛所要分成兩欄
  const pe2 = await api('POST', '/api/posts', { kind: 'ema', target: '2026-10-05', body: `第二塊 ${tag}` });
  const pe3 = await api('POST', '/api/posts', { kind: 'ema', target: '2026-10-05', body: `第三塊 ${tag}` });
  await goto('/');
  check('首頁：繪馬掛在當天的繪馬掛所', await waitFor(`[...document.querySelectorAll('.day[data-date="2026-10-05"] .ema-rack')].some((el) => el.textContent.includes('公開牆繪馬 ${tag}'))`, 8000));
  check('首頁：每欄最多兩個（照片欄、繪馬欄）', await run(`return [...document.querySelectorAll('.col-photos')].every((c) => c.querySelectorAll('.it-photo').length <= 2)
    && [...document.querySelectorAll('.ema-rack')].every((c) => c.querySelectorAll('.it-ema').length <= 2)
    && document.querySelectorAll('.day[data-date="2026-10-05"] .ema-rack').length >= 2;`));
  check('首頁：照片欄不高過最高的展品欄（直幅照片自動縮窄）', await run(`document.getElementById('wall').style.setProperty('--wall-scale', '1');
    const H = (c) => c.lastElementChild ? c.lastElementChild.getBoundingClientRect().bottom - c.getBoundingClientRect().top : 0;
    const ref = Math.max(...[...document.querySelectorAll('.cols > .col:not(.col-photos):not(.ema-rack)')].map(H));
    const cols = [...document.querySelectorAll('.col-photos')]; const tall = cols.find((c) => c.textContent.includes('直幅照片 ${tag}'));
    const ok = !!tall && tall.style.getPropertyValue('--colw') !== '240px' && cols.every((c) => H(c) <= ref + 2);
    dispatchEvent(new Event('resize')); return ok;`), await run(`return [...document.querySelectorAll('.col-photos')].map((c) => c.style.getPropertyValue('--colw') + ':' + Math.round(c.lastElementChild.getBoundingClientRect().bottom - c.getBoundingClientRect().top)).join(' ');`));
  check('首頁：繪馬上有留言籤', await run(`const b = [...document.querySelectorAll('.it-ema')].find((el) => el.textContent.includes('公開牆繪馬 ${tag}')); return !!b && b.querySelector('.ofuda')?.textContent === '籤 1';`));
  check('首頁：展品說明牌出現留言籤', await run(`return /^籤 \\d+$/.test(document.querySelector('.it-media[data-exhibit-id="JP-01-02"] .ofuda')?.textContent || '');`));
  check('首頁：照片依拍攝時刻插在展品之間（09:30 在 JP-01-04 06:46 與 JP-01-05 12:13 之間）', await run(`const col = [...document.querySelectorAll('.day[data-date="2026-10-05"] .col-photos')].find((el) => el.textContent.includes('公開牆照片 ${tag}'));
    if (!col) return false; let p = col.previousElementSibling; while (p && p.classList.contains('col-photos')) p = p.previousElementSibling;
    let n = col.nextElementSibling; while (n && n.classList.contains('col-photos')) n = n.nextElementSibling;
    return !!p?.querySelector('[data-exhibit-id="JP-01-04"]') && !!n?.querySelector('[data-exhibit-id="JP-01-05"]');`));
  check('首頁：照片外觀與展品相同（畫框）、沒有「親友」字樣', await run(`const b = [...document.querySelectorAll('.it-photo')].find((el) => el.textContent.includes('公開牆照片 ${tag}'));
    return !!b?.querySelector('figure.plate img') && !document.body.innerHTML.includes('親友');`));
  check('首頁：照片上有留言籤', await run(`const b = [...document.querySelectorAll('.it-photo')].find((el) => el.textContent.includes('公開牆照片 ${tag}')); return b?.querySelector('.ofuda')?.textContent === '籤 1';`));
  await run(`[...document.querySelectorAll('.it-ema')].find((el) => el.textContent.includes('公開牆繪馬 ${tag}')).click();`);
  check('繪馬說明卡：顯示繪馬內容與 1 則留言', await waitFor(`!document.getElementById('lb').hidden && document.getElementById('lb-cmts').textContent.includes('留言 1') && document.getElementById('lb-cmts').textContent.includes('繪馬留言 ${tag}')`));
  await shot('public-ema-lightbox');
  await run(`document.getElementById('lb-x').click();`);
  await run(`document.querySelector('.it-media[data-exhibit-id="JP-01-02"]').click();`);
  check('展品說明卡：留言串含縮排回覆', await waitFor(`document.getElementById('lb-cmts').textContent.includes('展品留言 ${tag}') && [...document.querySelectorAll('#lb-cmts .cmt.reply')].some((el) => el.textContent.includes('回覆 ${tag}'))`));
  await run(`document.getElementById('lb-x').click();`);
  await run(`[...document.querySelectorAll('.it-photo')].find((el) => el.textContent.includes('公開牆照片 ${tag}')).click();`);
  check('照片說明卡：顯示照片、拍攝時刻與留言', await waitFor(`!document.getElementById('lb').hidden && !!document.querySelector('#lb-media img[src^="/api/media/"]') && document.getElementById('lb-place').textContent.includes('09:30') && document.getElementById('lb-cmts').textContent.includes('照片留言 ${tag}')`));
  await run(`document.getElementById('lb-next').click();`);
  check('說明卡可往下一件瀏覽', await waitFor(`document.getElementById('lb-count').textContent.length > 0`));
  await run(`document.getElementById('lb-x').click();`);
  await shot('public-wall-dynamic');
  // 手機寬度（400px）：牆面模式與閱讀模式，有動態內容時頁面本體也不能橫向溢出
  await cdp('Emulation.setDeviceMetricsOverride', { width: 400, height: 860, deviceScaleFactor: 1, mobile: true });
  await goto('/');
  await waitFor(`document.querySelector('.ema-rack')`, 8000);
  check('手機牆面模式：頁面不橫向溢出', await run(`return document.documentElement.scrollWidth <= innerWidth + 1;`), await run(`return document.documentElement.scrollWidth + ' > ' + innerWidth;`));
  await run(`document.getElementById('m-read').click();`);
  await sleep(500);
  check('手機閱讀模式：頁面不橫向溢出', await run(`return document.documentElement.scrollWidth <= innerWidth + 1;`), await run(`return document.documentElement.scrollWidth + ' > ' + innerWidth;`));
  check('手機閱讀模式：繪馬與照片在當天範圍內', await run(`const d = document.querySelector('.day[data-date="2026-10-05"]').getBoundingClientRect();
    return [...document.querySelectorAll('.day[data-date="2026-10-05"] .ema-rack, .day[data-date="2026-10-05"] .col-photos')].every((el) => { const r = el.getBoundingClientRect(); return r.left >= d.left - 1 && r.right <= d.right + 1; });`));
  await run(`document.querySelector('.day[data-date="2026-10-05"] .ema-rack')?.scrollIntoView({ block: 'center' });`);
  await sleep(300);
  if (SHOTS) { const r = await cdp('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(SHOTS, 'phone-read-dynamic.png'), Buffer.from(r.result.data, 'base64')); }
  await run(`document.getElementById('m-wall').click();`);
  await cdp('Emulation.clearDeviceMetricsOverride');
  // 收尾
  for (const r of [px2, px1, pc1, ppc, pe, pe2, pe3, modPc]) if (r?.data?.post?.id) await api('DELETE', `/api/posts/${r.data.post.id}`);
  if (modPhoto) await api('DELETE', `/api/photos/${modPhoto}`);
  if (pp) await api('DELETE', `/api/photos/${pp}`);
  if (pp2) await api('DELETE', `/api/photos/${pp2}`);

  /* ---------- 深色模式截圖（目視檢查用） ---------- */
  await goto('/edit');
  await run(`document.documentElement.dataset.theme = 'dark'; document.getElementById('em-uploads')?.click();`);
  await shot('edit-dark');
  await goto('/admin');
  await waitFor(`!document.getElementById('adm-console').hidden`);
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  await shot('admin-dark');
  await cdp('Emulation.setEmulatedMedia', { features: [] });
} catch (err) {
  check('測試流程未中斷', false, err.message);
} finally {
  ws.close();
  chrome.kill();
}
console.log(`\n${pass} 通過、${fail} 失敗`);
process.exit(fail ? 1 : 0);
