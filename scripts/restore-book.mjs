import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

function usage(exitCode = 0) {
  console.log(`Uso:\n  node scripts/restore-book.mjs --id <bookId> [--visibility public|private] [--db <ruta>]\n\nRestaura un asset existente en la biblioteca de quien lo subió originalmente.\nNo modifica ni borra reading_progress.\n\nEjemplo:\n  node scripts/restore-book.mjs --id "<book-id>" --visibility public`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  let bookId = '';
  let visibility = 'private';
  let dbPath = process.env.LUMA_REPORT_DB || '';

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--help' || value === '-h') usage(0);
    if (value === '--id') {
      bookId = argv[index + 1] || '';
      index += 1;
      continue;
    }
    if (value === '--visibility') {
      visibility = String(argv[index + 1] || '').toLowerCase();
      index += 1;
      continue;
    }
    if (value === '--db') {
      dbPath = argv[index + 1] || '';
      index += 1;
    }
  }

  if (!dbPath) {
    const deployed = path.resolve('C:/www/luma/data/luma.sqlite');
    const local = path.resolve('data/luma.sqlite');
    dbPath = existsSync(deployed) ? deployed : local;
  }

  if (!bookId.trim()) {
    console.error('Falta --id <bookId>.');
    usage(2);
  }
  if (visibility !== 'public' && visibility !== 'private') {
    console.error('La visibilidad debe ser public o private.');
    usage(2);
  }

  return { bookId: bookId.trim(), visibility, dbPath: path.resolve(dbPath) };
}

const { bookId, visibility, dbPath } = parseArgs(process.argv.slice(2));
if (!existsSync(dbPath)) {
  console.error(`No existe la base de datos: ${dbPath}`);
  process.exit(2);
}

const db = new DatabaseSync(dbPath);

try {
  db.exec('PRAGMA foreign_keys = ON;');

  const asset = db.prepare(`
    SELECT
      ba.id,
      ba.title,
      ba.author,
      ba.file_name AS fileName,
      ba.uploaded_by AS uploadedBy,
      u.name AS uploaderName,
      u.email AS uploaderEmail,
      COUNT(DISTINCT rp.user_id) AS readers
    FROM book_assets ba
    LEFT JOIN users u ON u.id = ba.uploaded_by
    LEFT JOIN reading_progress rp ON rp.book_id = ba.id
    WHERE ba.id = ?
    GROUP BY ba.id
  `).get(bookId);

  if (!asset) {
    console.error(`No existe ningún book_asset con ID: ${bookId}`);
    process.exitCode = 3;
  } else if (!asset.uploadedBy) {
    console.error('El libro existe, pero ya no tiene un usuario uploader asociado. No lo restauro automáticamente.');
    process.exitCode = 4;
  } else {
    const beforeProgress = Number(db.prepare('SELECT COUNT(*) AS total FROM reading_progress WHERE book_id = ?').get(bookId)?.total || 0);
    const existing = db.prepare('SELECT id, visibility FROM library_entries WHERE user_id = ? AND book_id = ?').get(asset.uploadedBy, bookId);

    db.exec('BEGIN IMMEDIATE;');
    try {
      if (existing) {
        db.prepare('UPDATE library_entries SET visibility = ? WHERE id = ?').run(visibility, existing.id);
      } else {
        db.prepare(`
          INSERT INTO library_entries (id, user_id, book_id, visibility, added_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(randomUUID(), asset.uploadedBy, bookId, visibility, Date.now());
      }
      db.exec('COMMIT;');
    } catch (error) {
      try { db.exec('ROLLBACK;'); } catch { /* no-op */ }
      throw error;
    }

    const afterProgress = Number(db.prepare('SELECT COUNT(*) AS total FROM reading_progress WHERE book_id = ?').get(bookId)?.total || 0);
    const libraryCount = Number(db.prepare('SELECT COUNT(*) AS total FROM library_entries WHERE book_id = ?').get(bookId)?.total || 0);

    console.log('\nLibro restaurado en la biblioteca del uploader original.');
    console.log(`Título: ${asset.title}`);
    console.log(`Autor: ${asset.author}`);
    console.log(`ID: ${asset.id}`);
    console.log(`Uploader: ${asset.uploaderName || '—'} <${asset.uploaderEmail || '—'}>`);
    console.log(`Visibilidad: ${visibility}`);
    console.log(`Entradas de biblioteca del asset: ${libraryCount}`);
    console.log(`Progresos antes: ${beforeProgress} · después: ${afterProgress}`);
    console.log('No se modificó ninguna fila de reading_progress.');
  }
} finally {
  db.close();
}
