import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { DatabaseSync } from 'node:sqlite';

function usage(exitCode = 0) {
  console.log(`Uso:\n  node scripts/book-readers.mjs <titulo> [--db <ruta>]\n\nEjemplos:\n  node scripts/book-readers.mjs "El Archivo de los Olvidados"\n  node scripts/book-readers.mjs "Archivo" --db "C:/www/luma/data/luma.sqlite"`);
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
    positional.push(value);
  }

  const title = positional.join(' ').trim();
  if (!title) usage(1);

  if (!dbPath) {
    const deployed = path.resolve('C:/www/luma/data/luma.sqlite');
    const local = path.resolve('data/luma.sqlite');
    dbPath = existsSync(deployed) ? deployed : local;
  }

  return { title, dbPath: path.resolve(dbPath) };
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

const { title, dbPath } = parseArgs(process.argv.slice(2));

if (!existsSync(dbPath)) {
  console.error(`No existe la base de datos: ${dbPath}`);
  process.exit(2);
}

const db = new DatabaseSync(dbPath, { readOnly: true });

try {
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
    const book = candidates[0];
    const rows = db.prepare(`
      SELECT
        u.name,
        u.email,
        rp.percentage,
        rp.last_opened_at AS lastOpenedAt
      FROM reading_progress rp
      JOIN users u ON u.id = rp.user_id
      WHERE rp.book_id = ?
      ORDER BY rp.percentage DESC, rp.last_opened_at DESC
    `).all(book.id);

    console.log(`\n${book.title}`);
    console.log(`${book.author}`);
    console.log(`Base: ${dbPath}\n`);

    if (!rows.length) {
      console.log('Ningún usuario ha abierto este libro todavía.');
    } else {
      const reading = rows.filter((row) => Number(row.percentage || 0) >= 0.01 && Number(row.percentage || 0) < 0.999).length;
      const completed = rows.filter((row) => Number(row.percentage || 0) >= 0.999).length;

      console.log(`Usuarios con progreso: ${rows.length} · Leyendo: ${reading} · Completado: ${completed}\n`);

      const table = rows.map((row) => ({
        Usuario: row.name,
        Email: row.email,
        Estado: statusFromProgress(row.percentage),
        Progreso: `${percentFromProgress(row.percentage)}%`,
        'Última lectura': formatDate(row.lastOpenedAt),
      }));
      console.table(table);
    }
  }
} finally {
  db.close();
}
