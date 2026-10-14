CREATE TABLE IF NOT EXISTS posts (
  id          TEXT PRIMARY KEY,          -- n-20261016-7k2q，與 YAML 檔名相同
  kind        TEXT NOT NULL CHECK (kind IN ('comment', 'ema')),
  target      TEXT NOT NULL,
  reply_to    TEXT,
  by          TEXT NOT NULL DEFAULT '',
  body        TEXT NOT NULL,
  author      TEXT NOT NULL,             -- 登入 email，只存在這裡
  status      TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending', 'published', 'rejected', 'withdrawn')),
  posted_at   TEXT NOT NULL,             -- ISO 8601
  decided_at  TEXT                       -- 收稿（展出或不採用）的時間
);
CREATE INDEX IF NOT EXISTS posts_status ON posts (status);
CREATE INDEX IF NOT EXISTS posts_author_date ON posts (author, posted_at);
