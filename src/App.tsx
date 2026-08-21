import { ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ePub, { Book, Rendition } from 'epubjs';
import {
  ArrowLeft, BookOpen, ChevronLeft, ChevronRight, CirclePause, CirclePlay, Headphones,
  LibraryBig, LoaderCircle, Menu, MoonStar, Plus, Search, Sparkles, Trash2, Upload, X,
} from 'lucide-react';
import { listBooks, putBook, removeBook, StoredBook } from './storage';
import { splitForSpeech } from './speech';

type TocItem = { label?: string; href: string; subitems?: TocItem[] };
type ReaderState = { book: Book; rendition: Rendition; record: StoredBook };

function toDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(blob);
  });
}

async function extractBook(file: File): Promise<StoredBook> {
  const data = await file.arrayBuffer();
  const book = ePub(data);
  try {
    await book.ready;
    const metadata = await book.loaded.metadata;
    let cover: string | undefined;
    try {
      const coverUrl = await book.coverUrl();
      if (coverUrl) {
        const response = await fetch(coverUrl);
        cover = await toDataUrl(await response.blob());
      }
    } catch { cover = undefined; }

    return {
      id: crypto.randomUUID(),
      title: metadata.title?.trim() || file.name.replace(/\.epub$/i, ''),
      author: metadata.creator?.trim() || 'Autor desconocido',
      cover,
      fileName: file.name,
      data,
      addedAt: Date.now(),
      progress: 0,
    };
  } finally { book.destroy(); }
}

function flattenToc(items: TocItem[], depth = 0): Array<TocItem & { depth: number }> {
  return items.flatMap((item) => [
    { ...item, depth },
    ...(item.subitems ? flattenToc(item.subitems, depth + 1) : []),
  ]);
}

function App() {
  const [books, setBooks] = useState<StoredBook[]>([]);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [reader, setReader] = useState<ReaderState | null>(null);
  const [toc, setToc] = useState<TocItem[]>([]);
  const [tocOpen, setTocOpen] = useState(false);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [voiceName, setVoiceName] = useState('');
  const [rate, setRate] = useState(1);
  const [speaking, setSpeaking] = useState(false);
  const [paused, setPaused] = useState(false);
  const [error, setError] = useState('');
  const viewerRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const speechQueueRef = useRef<string[]>([]);
  const speechIndexRef = useRef(0);
  const readerRef = useRef<ReaderState | null>(null);

  useEffect(() => { listBooks().then(setBooks).catch(() => setError('No se pudo abrir la biblioteca local.')); }, []);

  useEffect(() => {
    const synth = window.speechSynthesis;
    const load = () => {
      const available = synth.getVoices();
      setVoices(available);
      if (!voiceName && available.length) {
        const spanish = available.find((voice) => voice.lang.toLowerCase().startsWith('es'));
        setVoiceName((spanish ?? available[0]).name);
      }
    };
    load();
    synth.addEventListener('voiceschanged', load);
    return () => synth.removeEventListener('voiceschanged', load);
  }, [voiceName]);

  const filteredBooks = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return books;
    return books.filter((book) => `${book.title} ${book.author}`.toLowerCase().includes(needle));
  }, [books, query]);

  const stopSpeech = useCallback(() => {
    window.speechSynthesis.cancel();
    speechQueueRef.current = [];
    speechIndexRef.current = 0;
    setSpeaking(false);
    setPaused(false);
  }, []);

  const speakNext = useCallback(() => {
    const queue = speechQueueRef.current;
    const index = speechIndexRef.current;
    if (index >= queue.length) { setSpeaking(false); setPaused(false); return; }
    const utterance = new SpeechSynthesisUtterance(queue[index]);
    const selectedVoice = voices.find((voice) => voice.name === voiceName);
    if (selectedVoice) utterance.voice = selectedVoice;
    utterance.rate = rate;
    utterance.onend = () => { speechIndexRef.current += 1; speakNext(); };
    utterance.onerror = () => { setSpeaking(false); setPaused(false); setError('La voz del navegador interrumpió la narración.'); };
    window.speechSynthesis.speak(utterance);
  }, [rate, voiceName, voices]);

  const startSpeech = useCallback(() => {
    const current = readerRef.current;
    if (!current) return;
    const text = current.rendition.getContents().map((content) => content.document.body?.innerText ?? '').join('\n').trim();
    const chunks = splitForSpeech(text);
    if (!chunks.length) { setError('No encontré texto narrable en la página actual.'); return; }
    stopSpeech();
    speechQueueRef.current = chunks;
    speechIndexRef.current = 0;
    setSpeaking(true);
    setPaused(false);
    speakNext();
  }, [speakNext, stopSpeech]);

  const togglePause = () => {
    if (!speaking) { startSpeech(); return; }
    if (paused) { window.speechSynthesis.resume(); setPaused(false); }
    else { window.speechSynthesis.pause(); setPaused(true); }
  };

  const closeReader = useCallback(() => {
    stopSpeech();
    const current = readerRef.current;
    if (current) { current.rendition.destroy(); current.book.destroy(); }
    readerRef.current = null;
    setReader(null);
    setToc([]);
    setTocOpen(false);
  }, [stopSpeech]);

  const openBook = useCallback(async (record: StoredBook) => {
    setBusy(true); setError(''); stopSpeech();
    try {
      if (readerRef.current) closeReader();
      const book = ePub(record.data.slice(0));
      await book.ready;
      const navigation = await book.loaded.navigation;
      setToc((navigation.toc ?? []) as TocItem[]);
      const placeholder = { book, rendition: null as unknown as Rendition, record };
      setReader(placeholder);
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      if (!viewerRef.current) throw new Error('Reader container was not mounted');

      const rendition = book.renderTo(viewerRef.current, { width: '100%', height: '100%', spread: 'auto', flow: 'paginated' });
      rendition.themes.default({
        body: { color: '#202231', 'font-family': 'Georgia, Cambria, serif', 'line-height': '1.72', 'padding-left': '4%', 'padding-right': '4%' },
        'p, li': { 'font-size': '1.04rem' },
        'img, svg': { 'max-width': '100%', 'max-height': '90vh', 'object-fit': 'contain' },
      });

      const nextRecord = { ...record, lastOpenedAt: Date.now() };
      const state = { book, rendition, record: nextRecord };
      readerRef.current = state;
      setReader(state);
      await putBook(nextRecord);
      setBooks((items) => items.map((item) => (item.id === record.id ? nextRecord : item)));

      rendition.on('relocated', async (location: { start?: { cfi?: string; percentage?: number } }) => {
        const cfi = location.start?.cfi;
        if (!cfi) return;
        const current = readerRef.current;
        if (!current || current.record.id !== record.id) return;
        let progress = current.record.progress ?? 0;
        try { progress = current.book.locations.percentageFromCfi(cfi); } catch { /* keep previous value */ }
        const updated = { ...current.record, cfi, progress: Math.max(0, Math.min(1, progress)), lastOpenedAt: Date.now() };
        current.record = updated;
        await putBook(updated);
        setBooks((items) => items.map((item) => (item.id === updated.id ? updated : item)));
        setReader((value) => value && value.record.id === updated.id ? { ...value, record: updated } : value);
      });

      try { await book.locations.generate(1200); } catch { /* malformed EPUB: reading still works */ }
      await rendition.display(record.cfi || undefined);
    } catch (cause) {
      console.error(cause);
      closeReader();
      setError('No pude abrir este EPUB. Comprueba que el archivo no esté dañado o protegido con DRM.');
    } finally { setBusy(false); }
  }, [closeReader, stopSpeech]);

  const handleFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []).filter((file) => file.name.toLowerCase().endsWith('.epub'));
    if (!files.length) return;
    setBusy(true); setError('');
    try {
      const imported: StoredBook[] = [];
      for (const file of files) { const record = await extractBook(file); await putBook(record); imported.push(record); }
      setBooks((current) => [...imported, ...current]);
    } catch (cause) {
      console.error(cause);
      setError('No pude importar uno de los libros. Verifica que sea un EPUB válido.');
    } finally { setBusy(false); event.target.value = ''; }
  };

  const deleteBook = async (book: StoredBook) => {
    if (readerRef.current?.record.id === book.id) closeReader();
    await removeBook(book.id);
    setBooks((items) => items.filter((item) => item.id !== book.id));
  };

  if (reader) {
    const flatToc = flattenToc(toc);
    const progress = Math.round((reader.record.progress ?? 0) * 100);
    return (
      <main className="reader-shell">
        <header className="reader-header">
          <button className="icon-button" onClick={closeReader} aria-label="Volver a la biblioteca"><ArrowLeft /></button>
          <button className="icon-button mobile-only" onClick={() => setTocOpen((value) => !value)} aria-label="Índice"><Menu /></button>
          <div className="reader-title-block"><strong>{reader.record.title}</strong><span>{reader.record.author}</span></div>
          <div className="reader-progress"><span>{progress}%</span><div><i style={{ width: `${progress}%` }} /></div></div>
          <div className="brand compact"><span className="brand-mark"><Sparkles size={16} /></span><span>Luma</span></div>
        </header>
        <div className="reader-layout">
          <aside className={`toc-panel ${tocOpen ? 'open' : ''}`}>
            <div className="toc-heading"><div><span>CONTENIDO</span><strong>Índice del libro</strong></div><button className="icon-button mobile-only" onClick={() => setTocOpen(false)}><X /></button></div>
            <div className="toc-list">
              {flatToc.length ? flatToc.map((item, index) => (
                <button key={`${item.href}-${index}`} style={{ paddingLeft: `${18 + item.depth * 16}px` }} onClick={() => { reader.rendition.display(item.href); setTocOpen(false); stopSpeech(); }}>{item.label || `Sección ${index + 1}`}</button>
              )) : <p className="muted">Este EPUB no incluye un índice navegable.</p>}
            </div>
          </aside>
          <section className="book-stage">
            <button className="page-arrow left" onClick={() => { stopSpeech(); reader.rendition.prev(); }} aria-label="Página anterior"><ChevronLeft /></button>
            <div className="paper"><div ref={viewerRef} className="epub-viewer" /></div>
            <button className="page-arrow right" onClick={() => { stopSpeech(); reader.rendition.next(); }} aria-label="Página siguiente"><ChevronRight /></button>
          </section>
        </div>
        <footer className="audio-dock">
          <div className="audio-copy"><span className="audio-icon"><Headphones /></span><div><small>NARRACIÓN</small><strong>{speaking ? (paused ? 'En pausa' : 'Leyendo en voz alta') : 'Escuchar este capítulo'}</strong></div></div>
          <button className="play-button" onClick={togglePause} aria-label={paused || !speaking ? 'Reproducir' : 'Pausar'}>{speaking && !paused ? <CirclePause /> : <CirclePlay />}</button>
          <label className="audio-control">Voz<select value={voiceName} onChange={(e) => { stopSpeech(); setVoiceName(e.target.value); }}>{voices.map((voice) => <option key={`${voice.name}-${voice.lang}`} value={voice.name}>{voice.name} · {voice.lang}</option>)}</select></label>
          <label className="audio-control speed">Velocidad<select value={rate} onChange={(e) => { stopSpeech(); setRate(Number(e.target.value)); }}><option value={0.8}>0.8×</option><option value={1}>1×</option><option value={1.15}>1.15×</option><option value={1.3}>1.3×</option><option value={1.5}>1.5×</option><option value={1.75}>1.75×</option></select></label>
          {speaking && <button className="text-button" onClick={stopSpeech}>Detener</button>}
        </footer>
        {error && <button className="toast" onClick={() => setError('')}>{error}<X size={16} /></button>}
      </main>
    );
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark"><Sparkles /></span><div><strong>Luma</strong><small>EPUB READER</small></div></div>
        <nav><button className="active"><LibraryBig /> Mi biblioteca <span>{books.length}</span></button><button disabled><BookOpen /> Leyendo</button><button disabled><MoonStar /> Favoritos</button></nav>
        <div className="privacy-card"><span>100% LOCAL</span><strong>Tus libros son privados.</strong><p>Los EPUB se guardan únicamente en este navegador.</p></div>
      </aside>
      <section className="library">
        <header className="library-header">
          <div><span className="eyebrow">TU ESPACIO DE LECTURA</span><h1>Mi biblioteca</h1><p>Un lugar tranquilo para tus historias, con lectura visual y narración.</p></div>
          <button className="primary-button" onClick={() => fileRef.current?.click()} disabled={busy}>{busy ? <LoaderCircle className="spin" /> : <Plus />} Añadir EPUB</button>
          <input ref={fileRef} type="file" accept=".epub,application/epub+zip" multiple hidden onChange={handleFiles} />
        </header>
        <div className="library-tools"><label className="search-box"><Search /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buscar por título o autor…" /></label><span>{filteredBooks.length} {filteredBooks.length === 1 ? 'libro' : 'libros'}</span></div>
        {books.length === 0 ? (
          <section className="empty-state"><div className="empty-orb"><Upload /></div><span className="eyebrow">EMPIEZA TU BIBLIOTECA</span><h2>Tu próxima historia vive aquí.</h2><p>Importa uno o varios archivos EPUB. Guardaremos el libro y tu progreso en este dispositivo.</p><button className="primary-button large" onClick={() => fileRef.current?.click()} disabled={busy}><Upload /> Seleccionar EPUB</button><small>Sin cuentas · Sin subidas a la nube · Sin límite artificial</small></section>
        ) : (
          <section className="book-grid">{filteredBooks.map((book) => (
            <article className="book-card" key={book.id}>
              <button className="cover-button" onClick={() => openBook(book)}><div className="cover">{book.cover ? <img src={book.cover} alt={`Portada de ${book.title}`} /> : <div className="cover-fallback"><Sparkles /><strong>{book.title}</strong><span>{book.author}</span></div>}<div className="cover-overlay"><span><BookOpen /> Leer</span></div></div></button>
              <div className="book-meta"><button className="book-title" onClick={() => openBook(book)}>{book.title}</button><span>{book.author}</span><div className="card-progress"><div><i style={{ width: `${Math.round((book.progress ?? 0) * 100)}%` }} /></div><small>{Math.round((book.progress ?? 0) * 100)}%</small></div></div>
              <button className="delete-button" onClick={() => deleteBook(book)} aria-label={`Eliminar ${book.title}`}><Trash2 /></button>
            </article>
          ))}</section>
        )}
      </section>
      {error && <button className="toast" onClick={() => setError('')}>{error}<X size={16} /></button>}
    </main>
  );
}

export default App;
