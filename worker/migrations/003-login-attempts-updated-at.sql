-- 2026-10-19：login_attempts 加 updated_at（最後一次失敗時刻，ISO 8601 +08:00）。
-- 用途：IP 層限速的「距上次失敗超過 15 分鐘重新起算」，與每日排程清理舊紀錄。
-- 只對 schema.sql 加這欄之前建立的資料庫跑一次：
--   npx --yes wrangler@4 d1 execute osaka2026 -c wrangler.back.jsonc --remote --file=worker/migrations/003-login-attempts-updated-at.sql
-- （本機把 --remote 換成 --local；重跑會因欄位已存在而報錯，可忽略）
ALTER TABLE login_attempts ADD COLUMN updated_at TEXT;
