-- 後台 2.0 D1 schema（資料庫 osaka2026，binding DB）
-- 建立：npm run db:setup:local（本機）／ wrangler d1 execute osaka2026 --remote --file=worker/schema.sql（正式）

CREATE TABLE IF NOT EXISTS users (
  username       TEXT PRIMARY KEY,
  display_name   TEXT NOT NULL,
  password_hash  TEXT NOT NULL,            -- pbkdf2$<iterations>$<saltHex>$<hashHex>
  role           TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  must_change_pw INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,            -- ISO 8601（+08:00）
  last_login_at  TEXT,                     -- 最近一次登入成功；null＝還沒登入過
  deleted_at     TEXT                      -- 軟刪除時刻（ISO 8601 +08:00）；null＝正常。滿 30 天由排程永久刪除，清掉即恢復
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,            -- opaque token 的 SHA-256（hex）
  username    TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_username ON sessions (username);

CREATE TABLE IF NOT EXISTS login_attempts (
  key          TEXT PRIMARY KEY,           -- <username>|<ip>（username 小寫）；IP 層限速另有 #ip|<ip>（# 不會出現在帳號名稱裡）
  fails        INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,                       -- ISO 8601；null 表示未鎖定
  updated_at   TEXT                        -- 最後一次失敗時刻（ISO 8601 +08:00）；排程清理與 IP 計數重新起算用
);

CREATE TABLE IF NOT EXISTS photos (
  id          TEXT PRIMARY KEY,            -- p-YYYYMMDD-xxxx
  author      TEXT NOT NULL,               -- users.username
  day         TEXT NOT NULL,               -- YYYY-MM-DD
  caption     TEXT NOT NULL DEFAULT '',
  r2_key      TEXT NOT NULL,
  mime        TEXT NOT NULL,
  bytes       INTEGER NOT NULL,
  width       INTEGER NOT NULL,
  height      INTEGER NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'photo', -- photo｜video（影片：r2_key 是 MP4，另有封面 poster_key）
  duration    REAL,                        -- 影片長度（秒）；照片為 null
  poster_key  TEXT,                        -- 影片封面（R2 key）；照片為 null
  taken_at    TEXT,                        -- 拍攝時刻（照片 EXIF DateTimeOriginal／影片 creationdate，當地時間 YYYY-MM-DDTHH:MM:SS）；讀不到為 null
  lat         REAL,                        -- 拍攝地點（剝除 metadata 前讀出）：只給內部排版用，任何 API 都不回傳
  lon         REAL,
  status      TEXT NOT NULL DEFAULT 'live' CHECK (status IN ('live', 'removed')),
  created_at  TEXT NOT NULL,
  updated_at  TEXT,
  removed_by  TEXT                         -- 刪除者 username（本人或管理員）
);
CREATE INDEX IF NOT EXISTS photos_day ON photos (day, status);
CREATE INDEX IF NOT EXISTS photos_author ON photos (author, status);

CREATE TABLE IF NOT EXISTS posts (
  id          TEXT PRIMARY KEY,            -- n-YYYYMMDD-xxxx
  kind        TEXT NOT NULL CHECK (kind IN ('comment', 'ema')),
  target      TEXT NOT NULL,               -- comment：展品/繪馬 id；ema：日期
  reply_to    TEXT,
  by          TEXT NOT NULL DEFAULT '',    -- 署名（可與 display_name 不同）
  body        TEXT NOT NULL,
  author      TEXT NOT NULL,               -- users.username
  status      TEXT NOT NULL DEFAULT 'live' CHECK (status IN ('live', 'removed')),
  posted_at   TEXT NOT NULL,
  updated_at  TEXT,
  removed_by  TEXT                         -- 刪除者 username（本人或管理員）
);
CREATE INDEX IF NOT EXISTS posts_target ON posts (target, status);
CREATE INDEX IF NOT EXISTS posts_author ON posts (author, status);
