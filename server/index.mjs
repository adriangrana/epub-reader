import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, existsSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { BOOKS_DIR, COVERS_DIR, db } from './db.mjs';
import { clearSession, createSession, getCurrentUser, hashPassword, verifyPassword } from './auth.mjs';

const PORT = Number(process.env.PORT || 8787);
const MAX_EPUB_BYTES = 150 * 1024 * 1024;
const MAX_JSON_BYTES = 8 * 1024 * 1024;
const DIST_DIR = path.join(process.cwd(), 'dist');

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

async function readBuffer(req, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error('Payload demasiado grande.'), { statusCode: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req) {
  const buffer = await readBuffer(req, MAX_JSON_BYTES);
  if (!buffer.length) return {};
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    throw Object.assign(new Error('JSON inválido.'), { statusCode: 400 });
  }
}

function asBook(row, userId) {
  return {
    id: row.id,
    title: row.title,
    author: row.author,
    description: row.description || '',
    fileName: row.fileName,
    hasCover: Boolean(row.coverPath),
    visibility: row.visibility || 'private',
    progress: Number(row.progress || 0),
    cfi: row.cfi || undefined,
    lastOpenedAt: row.lastOpenedAt ? Number(row.lastOpenedAt) : undefined,
    publishedBy: row.publishedBy || undefined,
    inLibrary: row.inLibrary === undefined ? undefined : Boolean(row.inLibrary),
    shareId: row.shareId || undefined,
    sharedBy: row.sharedBy || undefined,
    sharedByEmail: row.sharedByEmail || undefined,
    canEdit: Boolean(userId && row.uploadedBy === userId),
  };
}

function libraryBook(userId, bookId) {
  const row = db.prepare(`
    SELECT ba.id, ba.title, ba.author, ba.description, ba.file_name AS fileName,
           ba.cover_path AS coverPath, ba.uploaded_by AS uploadedBy,
           le.visibility, rp.cfi, rp.percentage AS progress, rp.last_opened_at AS lastOpenedAt
    FROM library_entries le
    JOIN book_assets ba ON ba.id = le.book_id
    LEFT JOIN reading_progress rp ON rp.user_id = le.user_id AND rp.book_id = ba.id
    WHERE le.user_id = ? AND ba.id = ?
  `).get(userId, bookId);
  return row ? asBook(row, userId) : null;
}

function canAccessBook(userId, bookId) {
  return Boolean(db.prepare(`
    SELECT 1 AS allowed
    WHERE EXISTS (SELECT 1 FROM library_entries WHERE user_id = ? AND book_id = ?)
       OR EXISTS (SELECT 1 FROM book_shares WHERE shared_with = ? AND book_id = ?)
       OR EXISTS (SELECT 1 FROM library_entries WHERE book_id = ? AND visibility = 'public')
  `).get(userId, bookId, userId, bookId, bookId));
}

function ownsLibraryEntry(userId, bookId) {
  return Boolean(db.prepare('SELECT 1 FROM library_entries WHERE user_id = ? AND book_id = ?').get(userId, bookId));
}

function canEditAsset(userId, bookId) {
  return Boolean(db.prepare('SELECT 1 FROM book_assets WHERE id = ? AND uploaded_by = ?').get(bookId, userId));
}

function safeUnlink(filePath) {
  try { if (filePath && existsSync(filePath)) unlinkSync(filePath); } catch { /* best-effort cleanup */ }
}

function maybeGarbageCollect(bookId) {
  const references = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM library_entries WHERE book_id = ?) AS libraries,
      (SELECT COUNT(*) FROM book_shares WHERE book_id = ?) AS shares
  `).get(bookId, bookId);
  if (Number(references?.libraries || 0) || Number(references?.shares || 0)) return;

  const asset = db.prepare('SELECT file_path AS filePath, cover_path AS coverPath FROM book_assets WHERE id = ?').get(bookId);
  if (!asset) return;
  safeUnlink(path.join(BOOKS_DIR, asset.filePath));
  if (asset.coverPath) safeUnlink(path.join(COVERS_DIR, asset.coverPath));
  db.prepare('DELETE FROM book_assets WHERE id = ?').run(bookId);
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return ({
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
    '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8', '.woff2': 'font/woff2',
  })[ext] || 'application/octet-stream';
}

function serveStatic(url, res) {
  if (!existsSync(DIST_DIR)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Frontend no compilado. Usa npm run dev o ejecuta npm run build antes de npm start.');
    return;
  }

  const requested = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
  let filePath = path.resolve(DIST_DIR, requested);
  if (!filePath.startsWith(path.resolve(DIST_DIR))) return sendError(res, 403, 'Ruta no permitida.');
  if (!existsSync(filePath) || statSync(filePath).isDirectory()) filePath = path.join(DIST_DIR, 'index.html');

  const stat = statSync(filePath);
  res.writeHead(200, { 'Content-Type': contentType(filePath), 'Content-Length': stat.size });
  createReadStream(filePath).pipe(res);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  const pathname = url.pathname;

  try {
    if (pathname === '/api/health' && req.method === 'GET') return sendJson(res, 200, { ok: true });

    if (pathname === '/api/auth/register' && req.method === 'POST') {
      const body = await readJson(req);
      const name = String(body.name || '').trim();
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      if (name.length < 2) return sendError(res, 400, 'El nombre debe tener al menos 2 caracteres.');
      if (!/^\S+@\S+\.\S+$/.test(email)) return sendError(res, 400, 'Introduce un email válido.');
      if (password.length < 8) return sendError(res, 400, 'La contraseña debe tener al menos 8 caracteres.');
      if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) return sendError(res, 409, 'Ya existe una cuenta con ese email.');

      const id = randomUUID();
      const passwordData = await hashPassword(password);
      db.prepare('INSERT INTO users (id, name, email, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, name, email, passwordData.hash, passwordData.salt, Date.now());
      createSession(id, res);
      return sendJson(res, 201, { user: { id, name, email } });
    }

    if (pathname === '/api/auth/login' && req.method === 'POST') {
      const body = await readJson(req);
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      const user = db.prepare('SELECT id, name, email, password_hash AS passwordHash, password_salt AS passwordSalt FROM users WHERE email = ?').get(email);
      if (!user || !(await verifyPassword(password, user.passwordSalt, user.passwordHash))) return sendError(res, 401, 'Email o contraseña incorrectos.');
      createSession(user.id, res);
      return sendJson(res, 200, { user: { id: user.id, name: user.name, email: user.email } });
    }

    if (pathname === '/api/auth/logout' && req.method === 'POST') {
      clearSession(req, res);
      return sendJson(res, 200, { ok: true });
    }

    if (!pathname.startsWith('/api/')) return serveStatic(url, res);

    const user = getCurrentUser(req);
    if (!user) return sendError(res, 401, 'Necesitas iniciar sesión.');
    if (pathname === '/api/auth/me' && req.method === 'GET') return sendJson(res, 200, { user });

    if (pathname === '/api/library' && req.method === 'GET') {
      const rows = db.prepare(`
        SELECT ba.id, ba.title, ba.author, ba.description, ba.file_name AS fileName,
               ba.cover_path AS coverPath, ba.uploaded_by AS uploadedBy,
               le.visibility, rp.cfi, rp.percentage AS progress, rp.last_opened_at AS lastOpenedAt
        FROM library_entries le
        JOIN book_assets ba ON ba.id = le.book_id
        LEFT JOIN reading_progress rp ON rp.user_id = le.user_id AND rp.book_id = ba.id
        WHERE le.user_id = ?
        ORDER BY COALESCE(rp.last_opened_at, le.added_at) DESC
      `).all(user.id);
      return sendJson(res, 200, { books: rows.map((row) => asBook(row, user.id)) });
    }

    if (pathname === '/api/library/upload' && req.method === 'POST') {
      const title = String(url.searchParams.get('title') || '').trim();
      const author = String(url.searchParams.get('author') || '').trim();
      const description = String(url.searchParams.get('description') || '').trim().slice(0, 5000);
      const fileName = String(url.searchParams.get('fileName') || 'book.epub').trim();
      const data = await readBuffer(req, MAX_EPUB_BYTES);
      if (!data.length || data[0] !== 0x50 || data[1] !== 0x4b) return sendError(res, 400, 'El archivo no parece ser un EPUB válido.');

      const fallbackTitle = fileName.replace(/\.epub$/i, '') || 'Libro sin título';
      const fileHash = createHash('sha256').update(data).digest('hex');
      let asset = db.prepare(`
        SELECT id, cover_path AS coverPath, uploaded_by AS uploadedBy, description
        FROM book_assets WHERE file_hash = ?
      `).get(fileHash);

      if (!asset) {
        const id = randomUUID();
        const storedFileName = `${fileHash}.epub`;
        writeFileSync(path.join(BOOKS_DIR, storedFileName), data);
        db.prepare(`
          INSERT INTO book_assets (id, file_hash, file_name, file_path, title, author, description, uploaded_by, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(id, fileHash, fileName || 'book.epub', storedFileName, title || fallbackTitle, author || 'Autor desconocido', description, user.id, Date.now());
        asset = { id, coverPath: null, uploadedBy: user.id, description };
      } else if (asset.uploadedBy === user.id) {
        // The physical EPUB is deduplicated by SHA-256, but the original uploader
        // is still allowed to apply the metadata reviewed in the import dialog.
        // Keep an existing synopsis if the user leaves the import field empty;
        // clearing it explicitly is available from "Editar datos".
        const nextDescription = description || String(asset.description || '');
        db.prepare('UPDATE book_assets SET title = ?, author = ?, description = ? WHERE id = ?')
          .run(title || fallbackTitle, author || 'Autor desconocido', nextDescription, asset.id);
      }

      db.prepare(`INSERT OR IGNORE INTO library_entries (id, user_id, book_id, visibility, added_at) VALUES (?, ?, ?, 'private', ?)`)
        .run(randomUUID(), user.id, asset.id, Date.now());
      return sendJson(res, 201, { book: libraryBook(user.id, asset.id) });
    }

    if (pathname === '/api/public' && req.method === 'GET') {
      const needle = `%${String(url.searchParams.get('q') || '').trim().toLowerCase()}%`;
      const rows = db.prepare(`
        SELECT ba.id, ba.title, ba.author, ba.description, ba.file_name AS fileName,
               ba.cover_path AS coverPath, ba.uploaded_by AS uploadedBy,
               MIN(pub.name) AS publishedBy,
               EXISTS(SELECT 1 FROM library_entries mine WHERE mine.user_id = ? AND mine.book_id = ba.id) AS inLibrary,
               rp.cfi, rp.percentage AS progress, rp.last_opened_at AS lastOpenedAt
        FROM book_assets ba
        JOIN library_entries public_entry ON public_entry.book_id = ba.id AND public_entry.visibility = 'public'
        JOIN users pub ON pub.id = public_entry.user_id
        LEFT JOIN reading_progress rp ON rp.user_id = ? AND rp.book_id = ba.id
        WHERE LOWER(ba.title) LIKE ? OR LOWER(ba.author) LIKE ? OR LOWER(ba.description) LIKE ?
        GROUP BY ba.id
        ORDER BY ba.created_at DESC
      `).all(user.id, user.id, needle, needle, needle);
      return sendJson(res, 200, { books: rows.map((row) => asBook(row, user.id)) });
    }

    if (pathname === '/api/shares' && req.method === 'GET') {
      const rows = db.prepare(`
        SELECT bs.id AS shareId, ba.id, ba.title, ba.author, ba.description,
               ba.file_name AS fileName, ba.cover_path AS coverPath, ba.uploaded_by AS uploadedBy,
               sender.name AS sharedBy, sender.email AS sharedByEmail,
               rp.cfi, rp.percentage AS progress, rp.last_opened_at AS lastOpenedAt
        FROM book_shares bs
        JOIN book_assets ba ON ba.id = bs.book_id
        JOIN users sender ON sender.id = bs.shared_by
        LEFT JOIN reading_progress rp ON rp.user_id = bs.shared_with AND rp.book_id = ba.id
        WHERE bs.shared_with = ?
        ORDER BY bs.created_at DESC
      `).all(user.id);
      return sendJson(res, 200, { books: rows.map((row) => asBook(row, user.id)) });
    }

    let match = pathname.match(/^\/api\/library\/([^/]+)\/visibility$/);
    if (match && req.method === 'PATCH') {
      const bookId = decodeURIComponent(match[1]);
      const body = await readJson(req);
      const visibility = body.visibility === 'public' ? 'public' : body.visibility === 'private' ? 'private' : null;
      if (!visibility) return sendError(res, 400, 'Visibilidad inválida.');
      const result = db.prepare('UPDATE library_entries SET visibility = ? WHERE user_id = ? AND book_id = ?').run(visibility, user.id, bookId);
      if (!Number(result.changes)) return sendError(res, 404, 'Libro no encontrado en tu biblioteca.');
      return sendJson(res, 200, { book: libraryBook(user.id, bookId) });
    }

    match = pathname.match(/^\/api\/library\/([^/]+)\/metadata$/);
    if (match && req.method === 'PATCH') {
      const bookId = decodeURIComponent(match[1]);
      if (!canEditAsset(user.id, bookId)) return sendError(res, 403, 'Solo quien subió originalmente el libro puede editar sus datos.');
      const body = await readJson(req);
      const title = String(body.title ?? '').trim().slice(0, 300);
      const author = String(body.author ?? '').trim().slice(0, 300);
      const description = String(body.description ?? '').trim().slice(0, 5000);
      if (!title) return sendError(res, 400, 'El título no puede quedar vacío.');
      if (!author) return sendError(res, 400, 'El autor no puede quedar vacío.');
      db.prepare('UPDATE book_assets SET title = ?, author = ?, description = ? WHERE id = ?')
        .run(title, author, description, bookId);
      return sendJson(res, 200, { book: libraryBook(user.id, bookId) });
    }

    match = pathname.match(/^\/api\/library\/([^/]+)\/share$/);
    if (match && req.method === 'POST') {
      const bookId = decodeURIComponent(match[1]);
      if (!ownsLibraryEntry(user.id, bookId)) return sendError(res, 404, 'Libro no encontrado en tu biblioteca.');
      const body = await readJson(req);
      const email = String(body.email || '').trim().toLowerCase();
      const recipient = db.prepare('SELECT id, name, email FROM users WHERE email = ?').get(email);
      if (!recipient) return sendError(res, 404, 'No existe ningún usuario con ese email.');
      if (recipient.id === user.id) return sendError(res, 400, 'No puedes compartir un libro contigo mismo.');
      if (ownsLibraryEntry(recipient.id, bookId)) return sendJson(res, 200, { alreadyInLibrary: true, recipient: { name: recipient.name, email: recipient.email } });
      db.prepare(`INSERT OR IGNORE INTO book_shares (id, book_id, shared_by, shared_with, created_at) VALUES (?, ?, ?, ?, ?)`)
        .run(randomUUID(), bookId, user.id, recipient.id, Date.now());
      return sendJson(res, 201, { ok: true, recipient: { name: recipient.name, email: recipient.email } });
    }

    match = pathname.match(/^\/api\/library\/([^/]+)$/);
    if (match && req.method === 'DELETE') {
      const bookId = decodeURIComponent(match[1]);
      const result = db.prepare('DELETE FROM library_entries WHERE user_id = ? AND book_id = ?').run(user.id, bookId);
      if (!Number(result.changes)) return sendError(res, 404, 'Libro no encontrado en tu biblioteca.');
      db.prepare('DELETE FROM book_shares WHERE shared_by = ? AND book_id = ?').run(user.id, bookId);
      maybeGarbageCollect(bookId);
      return sendJson(res, 200, { ok: true });
    }

    match = pathname.match(/^\/api\/public\/([^/]+)\/add$/);
    if (match && req.method === 'POST') {
      const bookId = decodeURIComponent(match[1]);
      const isPublic = db.prepare("SELECT 1 FROM library_entries WHERE book_id = ? AND visibility = 'public'").get(bookId);
      if (!isPublic) return sendError(res, 404, 'Ese libro ya no es público.');
      db.prepare(`INSERT OR IGNORE INTO library_entries (id, user_id, book_id, visibility, added_at) VALUES (?, ?, ?, 'private', ?)`)
        .run(randomUUID(), user.id, bookId, Date.now());
      return sendJson(res, 201, { book: libraryBook(user.id, bookId) });
    }

    match = pathname.match(/^\/api\/shares\/([^/]+)\/accept$/);
    if (match && req.method === 'POST') {
      const shareId = decodeURIComponent(match[1]);
      const share = db.prepare('SELECT book_id AS bookId FROM book_shares WHERE id = ? AND shared_with = ?').get(shareId, user.id);
      if (!share) return sendError(res, 404, 'Compartición no encontrada.');
      db.prepare(`INSERT OR IGNORE INTO library_entries (id, user_id, book_id, visibility, added_at) VALUES (?, ?, ?, 'private', ?)`)
        .run(randomUUID(), user.id, share.bookId, Date.now());
      db.prepare('DELETE FROM book_shares WHERE id = ?').run(shareId);
      return sendJson(res, 200, { book: libraryBook(user.id, share.bookId) });
    }

    match = pathname.match(/^\/api\/shares\/([^/]+)$/);
    if (match && req.method === 'DELETE') {
      const shareId = decodeURIComponent(match[1]);
      db.prepare('DELETE FROM book_shares WHERE id = ? AND shared_with = ?').run(shareId, user.id);
      return sendJson(res, 200, { ok: true });
    }

    match = pathname.match(/^\/api\/progress\/([^/]+)$/);
    if (match && req.method === 'PUT') {
      const bookId = decodeURIComponent(match[1]);
      if (!canAccessBook(user.id, bookId)) return sendError(res, 403, 'No tienes acceso a este libro.');
      const body = await readJson(req);
      const percentage = Math.max(0, Math.min(1, Number(body.percentage || 0)));
      const cfi = body.cfi ? String(body.cfi) : null;
      db.prepare(`
        INSERT INTO reading_progress (user_id, book_id, cfi, percentage, last_opened_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(user_id, book_id) DO UPDATE SET cfi = excluded.cfi, percentage = excluded.percentage, last_opened_at = excluded.last_opened_at
      `).run(user.id, bookId, cfi, percentage, Date.now());
      return sendJson(res, 200, { ok: true });
    }

    match = pathname.match(/^\/api\/books\/([^/]+)\/cover$/);
    if (match && req.method === 'PUT') {
      const bookId = decodeURIComponent(match[1]);
      if (!canEditAsset(user.id, bookId)) return sendError(res, 403, 'Solo quien subió originalmente el libro puede modificar la portada.');
      const body = await readJson(req);
      const dataUrl = String(body.cover || '');
      const parsed = dataUrl.match(/^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/);
      if (!parsed) return sendError(res, 400, 'Formato de portada no soportado.');
      const bytes = Buffer.from(parsed[2], 'base64');
      if (bytes.length > 6 * 1024 * 1024) return sendError(res, 413, 'La portada es demasiado grande.');
      const extension = ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' })[parsed[1]];
      const coverFileName = `${bookId}.${extension}`;
      writeFileSync(path.join(COVERS_DIR, coverFileName), bytes);
      db.prepare('UPDATE book_assets SET cover_path = ? WHERE id = ?').run(coverFileName, bookId);
      return sendJson(res, 200, { ok: true });
    }

    if (match && req.method === 'GET') {
      const bookId = decodeURIComponent(match[1]);
      if (!canAccessBook(user.id, bookId)) return sendError(res, 403, 'No tienes acceso a este libro.');
      const asset = db.prepare('SELECT cover_path AS coverPath FROM book_assets WHERE id = ?').get(bookId);
      if (!asset?.coverPath) return sendError(res, 404, 'Portada no disponible.');
      const filePath = path.join(COVERS_DIR, asset.coverPath);
      if (!existsSync(filePath)) return sendError(res, 404, 'Portada no disponible.');
      const stat = statSync(filePath);
      res.writeHead(200, { 'Content-Type': contentType(filePath), 'Content-Length': stat.size, 'Cache-Control': 'private, max-age=3600' });
      return createReadStream(filePath).pipe(res);
    }

    match = pathname.match(/^\/api\/books\/([^/]+)\/file$/);
    if (match && req.method === 'PUT') {
      const bookId = decodeURIComponent(match[1]);
      if (!canEditAsset(user.id, bookId)) return sendError(res, 403, 'Solo quien subió originalmente el libro puede sustituir el EPUB.');
      const fileName = String(url.searchParams.get('fileName') || 'book.epub').trim();
      const data = await readBuffer(req, MAX_EPUB_BYTES);
      if (!data.length || data[0] !== 0x50 || data[1] !== 0x4b) return sendError(res, 400, 'El archivo no parece ser un EPUB válido.');

      const asset = db.prepare('SELECT file_path AS filePath FROM book_assets WHERE id = ?').get(bookId);
      if (!asset) return sendError(res, 404, 'Libro no encontrado.');
      const fileHash = createHash('sha256').update(data).digest('hex');
      const duplicate = db.prepare('SELECT id FROM book_assets WHERE file_hash = ? AND id <> ?').get(fileHash, bookId);
      if (duplicate) return sendError(res, 409, 'Ese EPUB ya está almacenado como otro libro de Luma.');

      const storedFileName = `${fileHash}.epub`;
      writeFileSync(path.join(BOOKS_DIR, storedFileName), data);
      db.prepare('UPDATE book_assets SET file_hash = ?, file_name = ?, file_path = ? WHERE id = ?')
        .run(fileHash, fileName || 'book.epub', storedFileName, bookId);
      if (asset.filePath !== storedFileName) safeUnlink(path.join(BOOKS_DIR, asset.filePath));
      db.prepare('DELETE FROM reading_progress WHERE book_id = ?').run(bookId);
      return sendJson(res, 200, { book: libraryBook(user.id, bookId) });
    }

    if (match && req.method === 'GET') {
      const bookId = decodeURIComponent(match[1]);
      if (!canAccessBook(user.id, bookId)) return sendError(res, 403, 'No tienes acceso a este libro.');
      const asset = db.prepare('SELECT file_name AS fileName, file_path AS filePath FROM book_assets WHERE id = ?').get(bookId);
      if (!asset) return sendError(res, 404, 'Libro no encontrado.');
      const filePath = path.join(BOOKS_DIR, asset.filePath);
      if (!existsSync(filePath)) return sendError(res, 404, 'El archivo EPUB ya no existe en el disco.');
      const stat = statSync(filePath);
      const disposition = url.searchParams.get('download') === '1' ? 'attachment' : 'inline';
      res.writeHead(200, {
        'Content-Type': 'application/epub+zip',
        'Content-Length': stat.size,
        'Content-Disposition': `${disposition}; filename*=UTF-8''${encodeURIComponent(asset.fileName)}`,
        'Cache-Control': 'private, max-age=600',
      });
      return createReadStream(filePath).pipe(res);
    }

    return sendError(res, 404, 'Ruta API no encontrada.');
  } catch (error) {
    console.error(error);
    return sendError(res, Number(error?.statusCode || 500), error?.message || 'Error interno del servidor.');
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Luma server: http://localhost:${PORT}`);
  console.log(`Datos: ${path.dirname(BOOKS_DIR)}`);
});
