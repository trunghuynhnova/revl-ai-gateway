-- Waitlist and API-key requests collected by POST /api/waitlist.
-- Apply with:
--   npx wrangler d1 execute revl-ai-waitlist --remote --file=schema.sql
-- Read the signups with:
--   npx wrangler d1 execute revl-ai-waitlist --remote --command "SELECT * FROM waitlist ORDER BY created_at DESC"

CREATE TABLE IF NOT EXISTS waitlist (
  email      TEXT PRIMARY KEY,
  source     TEXT NOT NULL DEFAULT 'waitlist',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS waitlist_created_at ON waitlist (created_at);
