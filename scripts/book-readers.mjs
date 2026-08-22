import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { DatabaseSync } from 'node:sqlite';

function usage(exitCode = 0) {
  console.log(`Uso:\n  node scripts/book-readers.mjs [titulo] [--db <ruta>]\n\nSin título muestra todos los libros y sus lectores.\n\nEjemplos:\n  node scripts/book-readers.mjs\n  node scripts/book-readers.mjs "El Archivo de los Olvidados"\n  node scripts/book-readers.mjs "Archivo" --db "C:/www/luma/data/luma.sqlite"`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const positional = [];
  let dbPath = process.env.LUMA_REPORT_DB || '';

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--help' || value === '-h') usage(0);
    if (value === '--db') {
      dbPath = argv[index + 1] || '';
      index += 1;
      continue;
    }
    if (value.trim()) positional.push(value);
  }

  if (!dbPath) {
    const deployed = path.resolve('C:/www/luma/data/luma.sqlite');
    const local = path.resolve('data/luma.sqlite');
    dbPath = existsSync(deployed) ? deployed : local;
  }

  return { title: positional.join(' ').trim(), dbPath: path.resolve(dbPath) };
}

function formatDate(timestamp) {
  if (!timestamp) return '—';
  try {
    return new Intl.DateTimeFormat('es-ES', {
      dateStyle: 'short',
      timeStyle: 'short',
    }).format(new Date(Number(timestamp)));
  } catch {
    return String(timestamp);
  }
}

function statusFromProgress(value) {
  const progress = Number(value || 0);
  if (progress >= 0.999) return 'Completado';
  if (progress >= 0.01) return 'Leyendo';
  return 'Abierto / sin avance';
}

function percentFromProgress(value) {
  const progress = Math.max(0, Math.min(1, Number(value || 0)));
  return progress >= 0.999 ? 100 : Math.round(progress * 100);
}

function readerRows(db, bookId) {
  return db.prepare(`
    SELECT
      u.name,
      u.email,
      rp.percentage,
      rp.last_opened_at AS lastOpenedAt
    FROM reading_progress rp
    JOIN users u ON u.id = rp.user_id
    WHERE rp.book_id = ?
    ORDER BY rp.percentage DESC, rp.last_opened_at DESC
  `).all(bookId);
}

function printReaders(db, book, { showHeader = true } = {}) {
  const rows = readerRows(db, book.id);

  if (showHeader) {
    console.log(`\n${book.title}`);
    console.log(`${book.author}`);
  }

  if (!rows.length) {
    console.log('Sin lectores todavía.');
    return;
  }

  const reading = rows.filter((row) => Number(row.percentage || 0) >= 0.01 && Number(row.percentage || 0) < 0.999).length;
  const completed = rows.filter((row) => Number(row.percentage || 0) >= 0.999).length;
  const noProgress = rows.length - reading - completed;

  console.log(`Usuarios con progreso: ${rows.length} · Leyendo: ${reading} · Completado: ${completed} · Sin avance: ${noProgress}\n`);
  console.table(rows.map((row) => ({
    Usuario: row.name,
    Email: row.email,
    Estado: statusFromProgress(row.percentage),
    Progreso: `${percentFromProgress(row.percentage)}%`,
    'Última lectura': formatDate(row.lastOpenedAt),
  })));
}

const { title, dbPath } = parseArgs(process.argv.slice(2));

if (!existsSync(dbPath)) {
  console.error(`No existe la base de datos: ${dbPath}`);
  process.exit(2);
}

const db = new DatabaseSync(dbPath, { readOnly: true });

try {
  if (!title) {
    const books = db.prepare(`
      SELECT
        ba.id,
        ba.title,
        ba.author,
        COUNT(rp.user_id) AS readers,
        SUM(CASE WHEN rp.percentage >= 0.01 AND rp.percentage < 0.999 THEN 1 ELSE 0 END) AS reading,
        SUM(CASE WHEN rp.percentage >= 0.999 THEN 1 ELSE 0 END) AS completed,
        SUM(CASE WHEN rp.user_id IS NOT NULL AND rp.percentage < 0.01 THEN 1 ELSE 0 END) AS noProgress,
        MAX(rp.last_opened_at) AS lastOpenedAt
      FROM book_assets ba
      LEFT JOIN reading_progress rp ON rp.book_id = ba.id
      GROUP BY ba.id
      ORDER BY COALESCE(MAX(rp.last_opened_at), 0) DESC, LOWER(ba.title)
    `).all();

    console.log(`\nReporte global de lectura`);
    console.log(`Base: ${dbPath}`);
    console.log(`Libros: ${books.length}\n`);

    if (!books.length) {
      console.log('No hay libros almacenados.');
    } else {
      console.table(books.map((book) => ({
        Libro: book.title,
        Autor: book.author,
        Lectores: Number(book.readers || 0),
        Leyendo: Number(book.reading || 0),
        Completados: Number(book.completed || 0),
        'Sin avance': Number(book.noProgress || 0),
        'Última lectura': formatDate(book.lastOpenedAt),
      })));

      for (const book of books) {
        console.log(`\n${'='.repeat(72)}`);
        console.log(`${book.title} — ${book.author}`);
        printReaders(db, book, { showHeader: false });
      }
    }
  } else {
    const exact = db.prepare(`
      SELECT id, title, author
      FROM book_assets
      WHERE LOWER(title) = LOWER(?)
      ORDER BY created_at DESC
    `).all(title);

    const candidates = exact.length ? exact : db.prepare(`
      SELECT id, title, author
      FROM book_assets
      WHERE LOWER(title) LIKE LOWER(?)
      ORDER BY created_at DESC
    `).all(`%${title}%`);

    if (!candidates.length) {
      console.error(`No encontré ningún libro que coincida con: "${title}"`);
      process.exitCode = 3;
    } else if (candidates.length > 1) {
      console.error(`Hay ${candidates.length} libros que coinciden con "${title}". Usa un título más específico:\n`);
      for (const book of candidates) console.error(`- ${book.title} — ${book.author}`);
      process.exitCode = 4;
    } else {
      console.log(`Base: ${dbPath}`);
      printReaders(db, candidates[0]);
    }
  }
} finally {
  db.close();
}
