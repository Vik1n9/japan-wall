-- 2026-10-18：照片加拍攝時刻，牆上依拍攝時間排序。
-- 只對 schema.sql 加這欄之前建立的資料庫跑一次：
--   npx --yes wrangler@4 d1 execute osaka2026 -c wrangler.back.jsonc --remote --file=worker/migrations/001-photos-taken-at.sql
-- （本機把 --remote 換成 --local；重跑會因欄位已存在而報錯，可忽略）
ALTER TABLE photos ADD COLUMN taken_at TEXT;
