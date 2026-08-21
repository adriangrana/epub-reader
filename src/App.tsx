import { ChangeEvent, FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BookOpen, Check, Download, Globe2, LibraryBig, LoaderCircle, LockKeyhole, LogOut,
  Plus, Search, Share2, Sparkles, Trash2, Upload, UserPlus, UsersRound, X,
} from 'lucide-react';
import {
  acceptShare, addPublicBook, coverUrl, dismissShare, downloadUrl, getCurrentUser,
  getLibrary, getPublicBooks, getShares, LibraryBook, login, logout, register,
  removeBookFromLibrary, setBookVisibility, shareBook, uploadBook, User,
} from './api';
import { readEpubMetadata } from './epubMetadata';
import ReaderView from './ReaderView';

type Section = 'library' | 'public' | 'shared';
type AuthMode = 'login' | 'register';

type BookCardProps = {
  book: LibraryBook;
  context: Section;
  onRead: (book: LibraryBook) => void;
  onAdd?: (book: LibraryBook) => void;
  onVisibility?: (book: LibraryBook) => void;
  onShare?: (book: LibraryBook) => void;
  onRemove?: (book: LibraryBook) => void;
  onAccept?: (book: LibraryBook) => void;
  onDismiss?: (book: LibraryBook) => void;
};

function BookCard({ book, context, onRead, onAdd, onVisibility, onShare, onRemove, onAccept, onDismiss }: BookCardProps) {
  const image = coverUrl(book);
  const percent = Math.round((book.progress ?? 0) * 100);

  return (
    <article className="book-card">
      <button className="cover-button" onClick={() => onRead(book)}>
        <div className="cover">
          {image ? <img src={image} alt={`Portada de ${book.title}`} /> : (
            <div className="cover-fallback"><Sparkles /><strong>{book.title}</strong><span>{book.author}</span></div>
          )}
          <div className="cover-overlay"><span><BookOpen /> Leer</span></div>
          {context === 'library' && <span className={`visibility-pill ${book.visibility}`}>
            {book.visibility === 'public' ? <Globe2 /> : <LockKeyhole />}{book.visibility === 'public' ? 'Público' : 'Privado'}
          </span>}
        </div>
      </button>

      <div className="book-meta">
        <button className="book-title" onClick={() => onRead(book)}>{book.title}</button>
        <span>{book.author}</span>
        {context === 'public' && book.publishedBy && <small className="book-context">Publicado por {book.publishedBy}</small>}
        {context === 'shared' && book.sharedBy && <small className="book-context">Compartido por {book.sharedBy}</small>}
        <div className="card-progress"><div><i style={{ width: `${percent}%` }} /></div><small>{percent}%</small></div>
      </div>

      <div className="book-actions">
        {context === 'library' && <>
          <button title={book.visibility === 'public' ? 'Hacer privado' : 'Hacer público'} onClick={() => onVisibility?.(book)}>
            {book.visibility === 'public' ? <LockKeyhole /> : <Globe2 />}
          </button>
          <button title="Compartir con otro usuario" onClick={() => onShare?.(book)}><Share2 /></button>
          <a title="Descargar EPUB" href={downloadUrl(book.id)}><Download /></a>
          <button className="danger" title="Quitar de mi biblioteca" onClick={() => onRemove?.(book)}><Trash2 /></button>
        </>}

        {context === 'public' && (
          book.inLibrary
            ? <span className="in-library-badge"><Check /> En tu biblioteca</span>
            : <button className="add-library-button" onClick={() => onAdd?.(book)}><Plus /> Añadir a mi biblioteca</button>
        )}

        {context === 'shared' && <>
          <button className="add-library-button" onClick={() => onAccept?.(book)}><UserPlus /> Añadir a mi biblioteca</button>
          <button className="dismiss-button" onClick={() => onDismiss?.(book)}>Descartar</button>
        </>}
      </div>
    </article>
  );
}

function AuthScreen({ onAuthenticated }: { onAuthenticated: (user: User) => void }) {
  const [mode, setMode] = useState<AuthMode>('login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const user = mode === 'login' ? await login(email, password) : await register(name, email, password);
      onAuthenticated(user);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'No se pudo completar el acceso.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="auth-shell">
      <section className="auth-hero">
        <div className="brand auth-brand"><span className="brand-mark"><Sparkles /></span><div><strong>Luma</strong><small>READ · LISTEN · SHARE</small></div></div>
        <div className="auth-copy">
          <span className="eyebrow">TU BIBLIOTECA, EN TU EQUIPO</span>
          <h1>Historias que permanecen contigo.</h1>
          <p>Guarda tus EPUB físicamente en este equipo, conserva tu progreso y comparte lecturas con otros usuarios de Luma.</p>
          <div className="auth-features">
            <span><LockKeyhole /> Biblioteca privada por usuario</span>
            <span><Globe2 /> Catálogo público opcional</span>
            <span><Share2 /> Compartir directamente</span>
          </div>
        </div>
      </section>

      <section className="auth-panel">
        <form className="auth-card" onSubmit={submit}>
          <div className="auth-tabs">
            <button type="button" className={mode === 'login' ? 'active' : ''} onClick={() => { setMode('login'); setError(''); }}>Entrar</button>
            <button type="button" className={mode === 'register' ? 'active' : ''} onClick={() => { setMode('register'); setError(''); }}>Crear cuenta</button>
          </div>
          <div className="auth-heading"><span>{mode === 'login' ? 'BIENVENIDO DE NUEVO' : 'EMPIEZA TU BIBLIOTECA'}</span><h2>{mode === 'login' ? 'Inicia sesión' : 'Crea tu cuenta'}</h2></div>
          {mode === 'register' && <label>Nombre<input value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" required minLength={2} /></label>}
          <label>Email<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" required /></label>
          <label>Contraseña<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} required minLength={8} /></label>
          {error && <p className="auth-error">{error}</p>}
          <button className="primary-button auth-submit" disabled={busy}>{busy ? <LoaderCircle className="spin" /> : mode === 'login' ? 'Entrar en Luma' : 'Crear cuenta'}</button>
          <small className="auth-note">Los datos y los EPUB se almacenan en el equipo donde se ejecuta el servidor Luma.</small>
        </form>
      </section>
    </main>
  );
}

function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [section, setSection] = useState<Section>('library');
  const [library, setLibrary] = useState<LibraryBook[]>([]);
  const [publicBooks, setPublicBooks] = useState<LibraryBook[]>([]);
  const [shares, setShares] = useState<LibraryBook[]>([]);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [loadingData, setLoadingData] = useState(false);
  const [reader, setReader] = useState<LibraryBook | null>(null);
  const [shareTarget, setShareTarget] = useState<LibraryBook | null>(null);
  const [shareEmail, setShareEmail] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const refreshAll = useCallback(async () => {
    if (!user) return;
    setLoadingData(true);
    try {
      const [myBooks, catalog, incoming] = await Promise.all([getLibrary(), getPublicBooks(), getShares()]);
      setLibrary(myBooks);
      setPublicBooks(catalog);
      setShares(incoming);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'No se pudo cargar la biblioteca.');
    } finally {
      setLoadingData(false);
    }
  }, [user]);

  useEffect(() => {
    getCurrentUser().then(setUser).catch((cause) => {
      setError(cause instanceof Error ? cause.message : 'No se pudo conectar con el servidor Luma.');
      setUser(null);
    });
  }, []);

  useEffect(() => { if (user) refreshAll(); }, [user, refreshAll]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(''), 3500);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const currentBooks = section === 'library' ? library : section === 'public' ? publicBooks : shares;
  const filteredBooks = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return currentBooks;
    return currentBooks.filter((book) => `${book.title} ${book.author} ${book.publishedBy ?? ''} ${book.sharedBy ?? ''}`.toLowerCase().includes(needle));
  }, [currentBooks, query]);

  const handleFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []).filter((file) => file.name.toLowerCase().endsWith('.epub'));
    if (!files.length) return;
    setBusy(true);
    setError('');
    try {
      for (const file of files) {
        const metadata = await readEpubMetadata(file);
        await uploadBook(file, metadata);
      }
      await refreshAll();
      setNotice(files.length === 1 ? 'Libro guardado en tu biblioteca.' : `${files.length} libros guardados en tu biblioteca.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'No se pudo importar uno de los EPUB.');
    } finally {
      setBusy(false);
      event.target.value = '';
    }
  };

  const toggleVisibility = async (book: LibraryBook) => {
    const next = book.visibility === 'public' ? 'private' : 'public';
    try {
      const updated = await setBookVisibility(book.id, next);
      setLibrary((items) => items.map((item) => item.id === book.id ? updated : item));
      await refreshAll();
      setNotice(next === 'public' ? 'El libro ahora aparece en la biblioteca pública.' : 'El libro vuelve a ser privado.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'No se pudo cambiar la visibilidad.'); }
  };

  const submitShare = async (event: FormEvent) => {
    event.preventDefault();
    if (!shareTarget) return;
    setBusy(true);
    try {
      const result = await shareBook(shareTarget.id, shareEmail);
      setNotice(result.alreadyInLibrary ? `${result.recipient?.name ?? 'Ese usuario'} ya tiene el libro en su biblioteca.` : `Libro compartido con ${result.recipient?.name ?? shareEmail}.`);
      setShareTarget(null);
      setShareEmail('');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'No se pudo compartir el libro.'); }
    finally { setBusy(false); }
  };

  const addFromPublic = async (book: LibraryBook) => {
    try {
      await addPublicBook(book.id);
      await refreshAll();
      setNotice('Libro añadido a tu biblioteca privada.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'No se pudo añadir el libro.'); }
  };

  const acceptIncomingShare = async (book: LibraryBook) => {
    if (!book.shareId) return;
    try {
      await acceptShare(book.shareId);
      await refreshAll();
      setNotice('Libro añadido a tu biblioteca.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'No se pudo aceptar el libro compartido.'); }
  };

  const dismissIncomingShare = async (book: LibraryBook) => {
    if (!book.shareId) return;
    try {
      await dismissShare(book.shareId);
      setShares((items) => items.filter((item) => item.shareId !== book.shareId));
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'No se pudo descartar la compartición.'); }
  };

  const removeFromLibrary = async (book: LibraryBook) => {
    try {
      await removeBookFromLibrary(book.id);
      await refreshAll();
      setNotice('Libro eliminado de tu biblioteca.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'No se pudo eliminar el libro.'); }
  };

  const applyProgress = (bookId: string, cfi: string, progress: number) => {
    const update = (items: LibraryBook[]) => items.map((item) => item.id === bookId ? { ...item, cfi, progress } : item);
    setLibrary(update);
    setPublicBooks(update);
    setShares(update);
    setReader((current) => current?.id === bookId ? { ...current, cfi, progress } : current);
  };

  const handleLogout = async () => {
    try { await logout(); } finally {
      setUser(null);
      setLibrary([]);
      setPublicBooks([]);
      setShares([]);
      setReader(null);
    }
  };

  if (user === undefined) {
    return <main className="boot-screen"><span className="brand-mark"><Sparkles /></span><LoaderCircle className="spin" /><span>Abriendo Luma…</span></main>;
  }

  if (!user) return <AuthScreen onAuthenticated={setUser} />;

  if (reader) return <ReaderView record={reader} onClose={() => { setReader(null); refreshAll(); }} onProgress={applyProgress} />;

  const title = section === 'library' ? 'Mi biblioteca' : section === 'public' ? 'Biblioteca pública' : 'Compartidos conmigo';
  const description = section === 'library'
    ? 'Tu colección personal. Cada libro conserva tu progreso de lectura.'
    : section === 'public'
      ? 'Libros que otros usuarios han decidido publicar para toda la comunidad.'
      : 'Libros que otros usuarios de Luma han compartido directamente contigo.';

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark"><Sparkles /></span><div><strong>Luma</strong><small>LIBRARY</small></div></div>
        <nav>
          <button className={section === 'library' ? 'active' : ''} onClick={() => { setSection('library'); setQuery(''); }}><LibraryBig /> Mi biblioteca <span>{library.length}</span></button>
          <button className={section === 'public' ? 'active' : ''} onClick={() => { setSection('public'); setQuery(''); }}><Globe2 /> Biblioteca pública <span>{publicBooks.length}</span></button>
          <button className={section === 'shared' ? 'active' : ''} onClick={() => { setSection('shared'); setQuery(''); }}><UsersRound /> Compartidos <span>{shares.length}</span></button>
        </nav>
        <div className="storage-card"><span>ALMACENAMIENTO LOCAL</span><strong>Los EPUB viven en este equipo.</strong><p>Las cuentas controlan el acceso; el archivo físico se conserva en el servidor Luma.</p></div>
        <div className="account-card"><div className="account-avatar">{user.name.slice(0, 1).toUpperCase()}</div><div><strong>{user.name}</strong><span>{user.email}</span></div><button onClick={handleLogout} title="Cerrar sesión"><LogOut /></button></div>
      </aside>

      <section className="library">
        <header className="library-header">
          <div><span className="eyebrow">{section === 'library' ? 'TU ESPACIO DE LECTURA' : section === 'public' ? 'DESCUBRE Y AÑADE' : 'DE OTROS USUARIOS PARA TI'}</span><h1>{title}</h1><p>{description}</p></div>
          {section === 'library' && <><button className="primary-button" onClick={() => fileRef.current?.click()} disabled={busy}>{busy ? <LoaderCircle className="spin" /> : <Plus />} Añadir EPUB</button><input ref={fileRef} type="file" accept=".epub,application/epub+zip" multiple hidden onChange={handleFiles} /></>}
        </header>

        {section === 'public' && <div className="public-note"><Globe2 /><span><strong>Catálogo comunitario.</strong> Publica únicamente contenido que tengas derecho a compartir.</span></div>}

        <div className="library-tools">
          <label className="search-box"><Search /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar por título, autor o usuario…" /></label>
          <span>{loadingData ? 'Actualizando…' : `${filteredBooks.length} ${filteredBooks.length === 1 ? 'libro' : 'libros'}`}</span>
        </div>

        {filteredBooks.length === 0 ? (
          <section className="empty-state">
            <div className="empty-orb">{section === 'library' ? <Upload /> : section === 'public' ? <Globe2 /> : <UsersRound />}</div>
            <span className="eyebrow">{section === 'library' ? 'EMPIEZA TU BIBLIOTECA' : section === 'public' ? 'SIN RESULTADOS' : 'BANDEJA VACÍA'}</span>
            <h2>{section === 'library' ? 'Tu próxima historia vive aquí.' : section === 'public' ? 'Aún no hay libros públicos aquí.' : 'No tienes libros compartidos pendientes.'}</h2>
            <p>{section === 'library' ? 'Importa uno o varios EPUB. Se guardarán físicamente en este equipo y quedarán asociados únicamente a tu cuenta.' : section === 'public' ? 'Cuando un usuario haga público un libro, aparecerá en este catálogo y podrás incorporarlo a tu biblioteca.' : 'Cuando otro usuario comparta un libro contigo, podrás leerlo o añadirlo a tu biblioteca personal.'}</p>
            {section === 'library' && <button className="primary-button large" onClick={() => fileRef.current?.click()} disabled={busy}><Upload /> Seleccionar EPUB</button>}
          </section>
        ) : (
          <section className="book-grid">{filteredBooks.map((book) => <BookCard
            key={`${section}-${book.shareId ?? book.id}`}
            book={book}
            context={section}
            onRead={setReader}
            onVisibility={toggleVisibility}
            onShare={(target) => { setShareTarget(target); setShareEmail(''); }}
            onRemove={removeFromLibrary}
            onAdd={addFromPublic}
            onAccept={acceptIncomingShare}
            onDismiss={dismissIncomingShare}
          />)}</section>
        )}
      </section>

      {shareTarget && <div className="modal-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target) setShareTarget(null); }}>
        <form className="share-modal" onSubmit={submitShare}>
          <button type="button" className="modal-close" onClick={() => setShareTarget(null)}><X /></button>
          <span className="modal-icon"><Share2 /></span>
          <span className="eyebrow">COMPARTIR LIBRO</span>
          <h2>{shareTarget.title}</h2>
          <p>Introduce el email de otro usuario registrado en Luma. El EPUB no se duplica: Luma le concede acceso al mismo archivo físico.</p>
          <label>Email del usuario<input type="email" placeholder="usuario@ejemplo.com" value={shareEmail} onChange={(event) => setShareEmail(event.target.value)} autoFocus required /></label>
          <button className="primary-button" disabled={busy}>{busy ? <LoaderCircle className="spin" /> : <Share2 />} Compartir</button>
        </form>
      </div>}

      {notice && <button className="toast success" onClick={() => setNotice('')}>{notice}<X size={16} /></button>}
      {error && <button className="toast" onClick={() => setError('')}>{error}<X size={16} /></button>}
    </main>
  );
}

export default App;
