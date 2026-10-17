#!/usr/bin/env node
// 建立（或重設）管理員帳號。
// 用法：npm run admin:create -- <username> [display_name] [--local] [--password <pw>]
//   --local    寫入 wrangler dev 的本機 D1（預設寫 remote）
//   --password 指定密碼（預設隨機產生並印出，只顯示這一次）
// 雜湊格式與 worker/lib/auth.ts 相同：pbkdf2$150000$<saltHex>$<hashHex>
import { execFileSync } from 'node:child_process';

const ITERATIONS = 150_000;

function toHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITERATIONS },
    key,
    256,
  );
  return `pbkdf2$${ITERATIONS}$${toHex(salt)}$${toHex(bits)}`;
}

function randomPassword(len = 14) {
  // 去掉容易看錯的字元（0/O、1/l/I）
  const alphabet = '23456789abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ';
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
}

function nowTaipeiIso() {
  const d = new Date(Date.now() + 8 * 3600_000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}+08:00`;
}

const args = process.argv.slice(2);
const local = args.includes('--local');
const pwIdx = args.indexOf('--password');
let password = null;
if (pwIdx !== -1) {
  password = args[pwIdx + 1];
  if (!password) {
    console.error('--password 後面要接密碼');
    process.exit(1);
  }
  args.splice(pwIdx, 2);
}
const positional = args.filter((a) => !a.startsWith('--'));
const username = (positional[0] || '').trim().toLowerCase();
const displayName = positional[1] || username;

if (!username || !/^[a-z0-9_.-]{2,32}$/.test(username)) {
  console.error('用法：npm run admin:create -- <username> [display_name] [--local] [--password <pw>]');
  console.error('username 限 2–32 字的小寫 a-z、0-9、_ . -');
  process.exit(1);
}
if (password !== null && (password.length < 8 || password.length > 128)) {
  console.error('密碼長度須為 8～128 字');
  process.exit(1);
}

const generated = password === null;
const pw = password ?? randomPassword();
const hash = await hashPassword(pw);
const sql =
  `INSERT INTO users (username, display_name, password_hash, role, status, must_change_pw, created_at) ` +
  `VALUES ('${username}', '${displayName.replaceAll("'", "''")}', '${hash}', 'admin', 'active', 0, '${nowTaipeiIso()}') ` +
  `ON CONFLICT(username) DO UPDATE SET password_hash = excluded.password_hash, role = 'admin', status = 'active', must_change_pw = 0;`;

const wranglerArgs = [
  '--yes', 'wrangler@4', 'd1', 'execute', 'osaka2026',
  '--config', 'wrangler.back.jsonc',
  local ? '--local' : '--remote',
  '--command', sql,
];
try {
  execFileSync('npx', wranglerArgs, { stdio: 'inherit' });
} catch {
  console.error('\n✗ 寫入失敗。本機請先跑 npm run db:setup:local；remote 請先建立 D1 並跑 db:setup:remote。');
  process.exit(1);
}

console.log(`\n✓ 管理員 ${username} 已${generated ? '建立' : '更新'}`);
if (generated) {
  console.log(`  初始密碼：${pw}`);
  console.log('  （只顯示這一次，請轉交給使用者或自己保管）');
}
