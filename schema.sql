-- カブコン D1スキーマ (自分のCloudflareアカウント用)
-- 適用: wrangler d1 execute kabucon-db --remote --file=schema.sql
CREATE TABLE IF NOT EXISTS records (
  table_name TEXT NOT NULL,
  id         TEXT NOT NULL,
  data       TEXT NOT NULL,          -- レコード本体(JSON)
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (table_name, id)
);
CREATE INDEX IF NOT EXISTS idx_records_list ON records (table_name, deleted, created_at DESC);
