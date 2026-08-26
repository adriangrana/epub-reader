import { existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { DatabaseSync } from 'node:sqlite';

function usage(exitCode = 0) {
  console.log(`Uso:\n  node scripts/purge-book.mjs --id <bookId> [--confirm DELETE] [--db <ruta>]\n\nSin --confirm DELETE solo muestra una vista previa.\nCon --confirm DELETE elimina definitivamente el asset, todas sus referencias,\nprogresos y los archivos EPUB/portada asociados cuando ya no están referenciados.\n\nEjemplos:\n  node scripts/purge-book.mjs --id "<book-id>"\n  node scripts/purge-book.mjs --id "<book-id>" --confirm DELETE`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  let bookId = '';
  let confirmation = '';
  let dbPath = process.env.LUMA_REPORT_DB || '';

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--help' || value === '-h') usage(0);
    if (value === '--id') {
      bookId = argv[index + 1] || '';
      index += 1;
      continue;
    }
    if (value === '--confirm') {
      confirmation = argv[index + 1] || '';
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

  return { bookId: bookId.trim(), confirmation, dbPath: path.resolve(dbPath) };
}

function formatDate(timestamp) {
  if (!timestamp) return '—';
  try {
    return new Intl.DateTimeFormat('es-ES', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(Number(timestamp)));
  } catch {
    return String(timestamp);
  }
}

function safeDelete(rootDir, relativePath) {
  if (!relativePath) return { deleted: false, reason: 'sin archivo' };
  const root = path.resolve(rootDir);
  const target = path.resolve(root, relativePath);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    return { deleted: false, reason: 'ruta fuera del directorio de datos' };
  }
  if (!existsSync(target)) return { deleted: false, reason: 'archivo ya inexistente' };
  try {
    unlinkSync(target);
    return { deleted: true, reason: target };
  } catch (error) {
    return { deleted: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

const { bookId, confirmation, dbPath } = parseArgs(process.argv.slice(2));
if (!existsSync(dbPath)) {
  console.error(`No existe la base de datos: ${dbPath}`);
  process.exit(2);
}

const dataDir = path.dirname(dbPath);
const booksDir = path.join(dataDir, 'books');
const coversDir = path.join(dataDir, 'covers');
const db = new DatabaseSync(dbPath);

try {
  db.exec('PRAGMA foreign_keys = ON;');

  const asset = db.prepare(`
    SELECT
      ba.id,
      ba.title,
      ba.author,
      ba.file_name AS fileName,
      ba.file_path AS filePath,
      ba.cover_path AS coverPath,
      ba.file_hash AS fileHash,
      ba.created_at AS createdAt,
      u.name AS uploaderName,
      u.email AS uploaderEmail,
      (SELECT COUNT(*) FROM library_entries le WHERE le.book_id = ba.id) AS libraries,
      (SELECT COUNT(*) FROM library_entries le WHERE le.book_id = ba.id AND le.visibility = 'public') AS publicEntries,
      (SELECT COUNT(*) FROM book_shares bs WHERE bs.book_id = ba.id) AS shares,
      (SELECT COUNT(*) FROM reading_progress rp WHERE rp.book_id = ba.id) AS progresses,
      (SELECT MAX(rp.last_opened_at) FROM reading_progress rp WHERE rp.book_id = ba.id) AS lastOpenedAt
    FROM book_assets ba
    LEFT JOIN users u ON u.id = ba.uploaded_by
    WHERE ba.id = ?
  `).get(bookId);

  if (!asset) {
    console.error(`No existe ningún book_asset con ID: ${bookId}`);
    process.exitCode = 3;
  } else {
    console.log('\nPURGA TOTAL DE LIBRO');
    console.log(`Base: ${dbPath}`);
    console.log(`Título: ${asset.title}`);
    console.log(`Autor: ${asset.author}`);
    console.log(`ID: ${asset.id}`);
    console.log(`Creado: ${formatDate(asset.createdAt)}`);
    console.log(`Uploader: ${asset.uploaderName || '—'} <${asset.uploaderEmail || '—'}>`);
    console.log(`Archivo: ${asset.fileName}`);
    console.log(`Hash: ${asset.fileHash}`);
    console.log(`Bibliotecas: ${Number(asset.libraries || 0)} · Públicas: ${Number(asset.publicEntries || 0)}`);
    console.log(`Comparticiones pendientes: ${Number(asset.shares || 0)}`);
    console.log(`Filas de progreso: ${Number(asset.progresses || 0)} · Última lectura: ${formatDate(asset.lastOpenedAt)}`);

    if (confirmation !== 'DELETE') {
      console.log('\nVISTA PREVIA: no se ha borrado nada.');
      console.log('Para eliminar ESTE ID definitivamente ejecuta:');
      console.log(`make purge-book ID="${asset.id}" CONFIRM=DELETE`);
    } else {
      const otherFileRefs = Number(db.prepare('SELECT COUNT(*) AS total FROM book_assets WHERE file_path = ? AND id <> ?').get(asset.filePath, asset.id)?.total || 0);
      const otherCoverRefs = asset.coverPath
        ? Number(db.prepare('SELECT COUNT(*) AS total FROM book_assets WHERE cover_path = ? AND id <> ?').get(asset.coverPath, asset.id)?.total || 0)
        : 0;

      db.exec('BEGIN IMMEDIATE;');
      try {
        const result = db.prepare('DELETE FROM book_assets WHERE id = ?').run(asset.id);
        if (!Number(result.changes || 0)) throw new Error('El asset desapareció antes de poder eliminarlo.');
        db.exec('COMMIT;');
      } catch (error) {
        try { db.exec('ROLLBACK;'); } catch { /* no-op */ }
        throw error;
      }

      const epubResult = otherFileRefs === 0
        ? safeDelete(booksDir, asset.filePath)
        : { deleted: false, reason: `conservado: ${otherFileRefs} asset(s) aún referencian el archivo` };
      const coverResult = asset.coverPath && otherCoverRefs === 0
        ? safeDelete(coversDir, asset.coverPath)
        : { deleted: false, reason: asset.coverPath ? `conservada: ${otherCoverRefs} asset(s) aún la referencian` : 'sin portada' };

      console.log('\nELIMINACIÓN COMPLETADA.');
      console.log(`Asset eliminado: ${asset.id}`);
      console.log(`Bibliotecas eliminadas por CASCADE: ${Number(asset.libraries || 0)}`);
      console.log(`Comparticiones eliminadas por CASCADE: ${Number(asset.shares || 0)}`);
      console.log(`Progresos eliminados por CASCADE: ${Number(asset.progresses || 0)}`);
      console.log(`EPUB físico: ${epubResult.deleted ? 'eliminado' : epubResult.reason}`);
      console.log(`Portada física: ${coverResult.deleted ? 'eliminada' : coverResult.reason}`);
      console.log('\nEste book_id ya no puede restaurarse desde Luma salvo que exista una copia/backup externo.');
    }
  }
} finally {
  db.close();
}
