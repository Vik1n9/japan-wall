// 後台路由共用：請求內容、輸入清理、Origin 檢查、編號產生、路由 context。
import { randomCode } from './util';
import type { R2BucketLike } from './public';
import type { SessionUser } from './auth';

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  UPLOADS: R2BucketLike;
  ALLOWED_ORIGINS?: string;
  DAYS?: string;
  DEV_MODE?: string; // .dev.vars：本機開發時 "1"，cookie 不加 Secure（http://localhost 也要能收）
}

/** 每個請求的路由 context；session 只在需要登入的路由才有值 */
export interface Ctx {
  request: Request;
  env: Env;
  url: URL;
  method: string;
}
export interface AuthedCtx extends Ctx {
  session: { user: SessionUser; tokenHash: string };
}

export const MIN_PASSWORD = 8;

const DEFAULT_ALLOWED_ORIGINS = 'https://kura.osaka2026.voriens.dev,http://kura.osaka2026.voriens.dev,http://localhost:8787,http://localhost:4321';

export function cleanSingleLine(s: string): string {
  return s.replace(/[\r\n\t]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** 投稿 body：去控制字元（保留換行）、CRLF 統一、修前後空白（舊 spec 3.6 沿用） */
export function cleanPostBody(s: string): string {
  return s
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim();
}

/** 產生當天未用過的編號（隨機 4 碼，一天 36^4 種；撞號就重抽，最多 8 次） */
export async function freshId(db: D1Database, table: 'photos' | 'posts', prefix: string): Promise<string> {
  for (let i = 0; i < 8; i++) {
    const id = prefix + randomCode(4);
    const hit = await db.prepare(`SELECT 1 FROM ${table} WHERE id = ?1`).bind(id).first();
    if (!hit) return id;
  }
  throw new Error('編號產生失敗');
}

export function clientIp(request: Request): string {
  return request.headers.get('CF-Connecting-IP') || 'local';
}

export function originAllowed(request: Request, env: Env): boolean {
  const origin = request.headers.get('Origin');
  if (!origin) return false;
  const allowed = new Set(
    (env.ALLOWED_ORIGINS || DEFAULT_ALLOWED_ORIGINS)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  return allowed.has(origin);
}

export async function readJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const parsed = await request.json();
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}
