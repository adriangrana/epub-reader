import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const DATA_DIR = path.resolve(process.env.LUMA_DATA_DIR || path.join(process.cwd(), 'data'));
export const BOOKS_DIR = path.join(DATA_DIR, 'books');
export const COVERS_DIR = path.join(DATA_DIR, 'covers');

mkdirSync(BOOKS_DIR, { recursive: true });
mkdirSync(COVERS_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'luma.sqlite'));

db.exec(`
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);

  CREATE TABLE IF NOT EXISTS book_assets (
    id TEXT PRIMARY KEY,
    file_hash TEXT NOT NULL UNIQUE,
    file_name TEXT NOT NULL,
    file_path TEXT NOT NULL,
    title TEXT NOT NULL,
    author TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    cover_path TEXT,
    uploaded_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS library_entries (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    book_id TEXT NOT NULL REFERENCES book_assets(id) ON DELETE CASCADE,
    visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'public')),
    added_at INTEGER NOT NULL,
    UNIQUE(user_id, book_id)
  );

  CREATE INDEX IF NOT EXISTS idx_library_user ON library_entries(user_id);
  CREATE INDEX IF NOT EXISTS idx_library_public ON library_entries(visibility, book_id);

  CREATE TABLE IF NOT EXISTS book_shares (
    id TEXT PRIMARY KEY,
    book_id TEXT NOT NULL REFERENCES book_assets(id) ON DELETE CASCADE,
    shared_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    shared_with TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    UNIQUE(book_id, shared_by, shared_with)
  );

  CREATE INDEX IF NOT EXISTS idx_shares_recipient ON book_shares(shared_with);

  CREATE TABLE IF NOT EXISTS reading_progress (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    book_id TEXT NOT NULL REFERENCES book_assets(id) ON DELETE CASCADE,
    cfi TEXT,
    percentage REAL NOT NULL DEFAULT 0,
    last_opened_at INTEGER NOT NULL,
    narration_cfi TEXT,
    narration_offset INTEGER NOT NULL DEFAULT 0,
    narration_updated_at INTEGER,
    PRIMARY KEY(user_id, book_id)
  );
`);

// Existing installations are migrated additively so a deploy never removes
// users, books, progress or narration checkpoints.
const assetColumns = new Set(
  db.prepare('PRAGMA table_info(book_assets)').all().map((column) => column.name),
);
if (!assetColumns.has('description')) {
  db.exec("ALTER TABLE book_assets ADD COLUMN description TEXT NOT NULL DEFAULT ''");
}

const progressColumns = new Set(
  db.prepare('PRAGMA table_info(reading_progress)').all().map((column) => column.name),
);
if (!progressColumns.has('narration_cfi')) {
  db.exec('ALTER TABLE reading_progress ADD COLUMN narration_cfi TEXT');
}
if (!progressColumns.has('narration_offset')) {
  db.exec('ALTER TABLE reading_progress ADD COLUMN narration_offset INTEGER NOT NULL DEFAULT 0');
}
if (!progressColumns.has('narration_updated_at')) {
  db.exec('ALTER TABLE reading_progress ADD COLUMN narration_updated_at INTEGER');
}

// Sessions are deliberately server-side so revocation/logout is immediate.
db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
