-- 2026-10-19：users 加 deleted_at（軟刪除時刻，ISO 8601 +08:00；null＝正常）。
-- 用途：刪除有內容的帳號時先軟刪除（內容隱藏、不能登入），滿 30 天後由每日排程永久刪除；
-- 清掉 deleted_at 即可恢復。沒有內容的帳號則直接硬刪，不會用到這欄。
-- 只對 schema.sql 加這欄之前建立的資料庫跑一次：
--   npx --yes wrangler@4 d1 execute osaka2026 -c wrangler.back.jsonc --remote --file=worker/migrations/004-users-deleted-at.sql
-- （本機把 --remote 換成 --local；重跑會因欄位已存在而報錯，可忽略）
ALTER TABLE users ADD COLUMN deleted_at TEXT;
