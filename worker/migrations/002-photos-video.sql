-- 2026-10-18：上傳影片（與照片同表，kind 區分）＋拍攝地點。
-- lat／lon 是剝除 metadata 前讀出的拍攝地點，只給內部排版用，任何 API 都不回傳。
-- 只對 schema.sql 加這些欄之前建立的資料庫跑一次：
--   npx --yes wrangler@4 d1 execute osaka2026 -c wrangler.back.jsonc --remote --file=worker/migrations/002-photos-video.sql
ALTER TABLE photos ADD COLUMN kind TEXT NOT NULL DEFAULT 'photo';
ALTER TABLE photos ADD COLUMN duration REAL;
ALTER TABLE photos ADD COLUMN poster_key TEXT;
ALTER TABLE photos ADD COLUMN lat REAL;
ALTER TABLE photos ADD COLUMN lon REAL;
