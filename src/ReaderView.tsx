import { useCallback, useEffect, useRef, useState } from 'react';
import ePub, { Book, Rendition } from 'epubjs';
import {
  ArrowLeft, ChevronLeft, ChevronRight, CirclePause, CirclePlay, Headphones,
  LoaderCircle, Menu, Sparkles, X,
} from 'lucide-react';
import { fetchBookData, LibraryBook, updateProgress } from './api';
import { splitForSpeech } from './speech';

type TocItem = { label?: string; href: string; subitems?: TocItem[] };

type Props = {
  record: LibraryBook;
  onClose: () => void;
  onProgress: (bookId: string, cfi: string, percentage: number) => void;
};

function flattenToc(items: TocItem[], depth = 0): Array<TocItem & { depth: number }> {
  return items.flatMap((item) => [
    { ...item, depth },
    ...(item.subitems ? flattenToc(item.subitems, depth + 1) : []),
  ]);
}

export default function ReaderView({ record, onClose, onProgress }: Props) {
  const viewerRef = useRef<HTMLDivElement>(null);
  const bookRef = useRef<Book | null>(null);
  const renditionRef = useRef<Rendition | null>(null);
  const speechQueueRef = useRef<string[]>([]);
  const speechIndexRef = useRef(0);
  const [toc, setToc] = useState<TocItem[]>([]);
  const [tocOpen, setTocOpen] = useState(false);
  const [progress, setProgress] = useState(record.progress ?? 0);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [voiceName, setVoiceName] = useState('');
  const [rate, setRate] = useState(1);
  const [speaking, setSpeaking] = useState(false);
  const [paused, setPaused] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const stopSpeech = useCallback(() => {
    window.speechSynthesis.cancel();
    speechQueueRef.current = [];
    speechIndexRef.current = 0;
    setSpeaking(false);
    setPaused(false);
  }, []);

  useEffect(() => {
    const synth = window.speechSynthesis;
    const load = () => {
      const available = synth.getVoices();
      setVoices(available);
      setVoiceName((current) => {
        if (current) return current;
        const spanish = available.find((voice) => voice.lang.toLowerCase().startsWith('es'));
        return (spanish ?? available[0])?.name ?? '';
      });
    };
    load();
    synth.addEventListener('voiceschanged', load);
    return () => synth.removeEventListener('voiceschanged', load);
  }, []);

  useEffect(() => {
    let disposed = false;
    let book: Book | null = null;
    let rendition: Rendition | null = null;

    const initialise = async () => {
      setLoading(true);
      setError('');
      try {
        const data = await fetchBookData(record.id);
        if (disposed) return;
        book = ePub(data);
        bookRef.current = book;
        await book.ready;
        if (disposed) return;

        const navigation = await book.loaded.navigation;
        setToc((navigation.toc ?? []) as TocItem[]);
        if (!viewerRef.current) throw new Error('No se encontró el contenedor de lectura.');

        rendition = book.renderTo(viewerRef.current, {
          width: '100%', height: '100%', spread: 'none', flow: 'paginated',
        });
        renditionRef.current = rendition;
        rendition.themes.default({
          body: { color: '#202231', 'font-family': 'Georgia, Cambria, serif', 'line-height': '1.72', 'padding-left': '5%', 'padding-right': '5%' },
          'p, li': { 'font-size': '1.04rem' },
          'img, svg': { 'max-width': '100%', 'max-height': '90vh', 'object-fit': 'contain' },
        });

        try { await book.locations.generate(1200); } catch { /* reading still works without generated locations */ }
        if (disposed) return;

        rendition.on('relocated', (location: { start?: { cfi?: string } }) => {
          const cfi = location.start?.cfi;
          if (!cfi || disposed || !book) return;
          let percentage = progress;
          try { percentage = book.locations.percentageFromCfi(cfi); } catch { /* preserve last percentage */ }
          percentage = Math.max(0, Math.min(1, percentage));
          setProgress(percentage);
          onProgress(record.id, cfi, percentage);
          updateProgress(record.id, cfi, percentage).catch(() => setError('No se pudo guardar el progreso de lectura.'));
        });

        await rendition.display(record.cfi || undefined);
      } catch (cause) {
        console.error(cause);
        setError(cause instanceof Error ? cause.message : 'No se pudo abrir este EPUB.');
      } finally {
        if (!disposed) setLoading(false);
      }
    };

    initialise();
    return () => {
      disposed = true;
      stopSpeech();
      try { rendition?.destroy(); } catch { /* already disposed */ }
      try { book?.destroy(); } catch { /* already disposed */ }
      renditionRef.current = null;
      bookRef.current = null;
    };
  // record.id intentionally defines the reader lifecycle; progress updates must not recreate the rendition.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [record.id, stopSpeech]);

  const speakNext = useCallback(() => {
    const queue = speechQueueRef.current;
    const index = speechIndexRef.current;
    if (index >= queue.length) {
      setSpeaking(false);
      setPaused(false);
      return;
    }

    const utterance = new SpeechSynthesisUtterance(queue[index]);
    const selectedVoice = voices.find((voice) => voice.name === voiceName);
    if (selectedVoice) utterance.voice = selectedVoice;
    utterance.rate = rate;
    utterance.onend = () => {
      speechIndexRef.current += 1;
      speakNext();
    };
    utterance.onerror = () => {
      setSpeaking(false);
      setPaused(false);
      setError('La voz del navegador interrumpió la narración.');
    };
    window.speechSynthesis.speak(utterance);
  }, [rate, voiceName, voices]);

  const startSpeech = useCallback(() => {
    const rendition = renditionRef.current;
    if (!rendition) return;
    const text = rendition.getContents().map((content) => content.document.body?.innerText ?? '').join('\n').trim();
    const chunks = splitForSpeech(text);
    if (!chunks.length) {
      setError('No encontré texto narrable en la página actual.');
      return;
    }
    stopSpeech();
    speechQueueRef.current = chunks;
    speechIndexRef.current = 0;
    setSpeaking(true);
    setPaused(false);
    speakNext();
  }, [speakNext, stopSpeech]);

  const togglePause = () => {
    if (!speaking) return startSpeech();
    if (paused) {
      window.speechSynthesis.resume();
      setPaused(false);
    } else {
      window.speechSynthesis.pause();
      setPaused(true);
    }
  };

  const flatToc = flattenToc(toc);
  const progressPercent = Math.round(progress * 100);

  return (
    <main className="reader-shell">
      <header className="reader-header">
        <button className="icon-button" onClick={onClose} aria-label="Volver a la biblioteca"><ArrowLeft /></button>
        <button className="icon-button mobile-only" onClick={() => setTocOpen((value) => !value)} aria-label="Índice"><Menu /></button>
        <div className="reader-title-block"><strong>{record.title}</strong><span>{record.author}</span></div>
        <div className="reader-progress"><span>{progressPercent}%</span><div><i style={{ width: `${progressPercent}%` }} /></div></div>
        <div className="brand compact"><span className="brand-mark"><Sparkles size={16} /></span><span>Luma</span></div>
      </header>

      <div className="reader-layout">
        <aside className={`toc-panel ${tocOpen ? 'open' : ''}`}>
          <div className="toc-heading">
            <div><span>CONTENIDO</span><strong>Índice del libro</strong></div>
            <button className="icon-button mobile-only" onClick={() => setTocOpen(false)} aria-label="Cerrar índice"><X /></button>
          </div>
          <div className="toc-list">
            {flatToc.length ? flatToc.map((item, index) => (
              <button key={`${item.href}-${index}`} style={{ paddingLeft: `${18 + item.depth * 16}px` }} onClick={() => {
                stopSpeech();
                renditionRef.current?.display(item.href);
                setTocOpen(false);
              }}>{item.label || `Sección ${index + 1}`}</button>
            )) : <p className="muted">Este EPUB no incluye un índice navegable.</p>}
          </div>
        </aside>

        <section className="book-stage">
          <button className="page-arrow left" onClick={() => { stopSpeech(); renditionRef.current?.prev(); }} aria-label="Página anterior"><ChevronLeft /></button>
          <div className="paper"><div ref={viewerRef} className="epub-viewer" /></div>
          <button className="page-arrow right" onClick={() => { stopSpeech(); renditionRef.current?.next(); }} aria-label="Página siguiente"><ChevronRight /></button>
          {loading && <div className="reader-loading"><LoaderCircle className="spin" /><span>Abriendo EPUB…</span></div>}
        </section>
      </div>

      <footer className="audio-dock">
        <div className="audio-copy"><span className="audio-icon"><Headphones /></span><div><small>NARRACIÓN</small><strong>{speaking ? (paused ? 'En pausa' : 'Leyendo en voz alta') : 'Escuchar esta página'}</strong></div></div>
        <button className="play-button" onClick={togglePause} disabled={loading} aria-label={paused || !speaking ? 'Reproducir' : 'Pausar'}>{speaking && !paused ? <CirclePause /> : <CirclePlay />}</button>
        <label className="audio-control">Voz<select value={voiceName} onChange={(event) => { stopSpeech(); setVoiceName(event.target.value); }}>{voices.map((voice) => <option key={`${voice.name}-${voice.lang}`} value={voice.name}>{voice.name} · {voice.lang}</option>)}</select></label>
        <label className="audio-control speed">Velocidad<select value={rate} onChange={(event) => { stopSpeech(); setRate(Number(event.target.value)); }}><option value={0.8}>0.8×</option><option value={1}>1×</option><option value={1.15}>1.15×</option><option value={1.3}>1.3×</option><option value={1.5}>1.5×</option><option value={1.75}>1.75×</option></select></label>
        {speaking && <button className="text-button" onClick={stopSpeech}>Detener</button>}
      </footer>

      {error && <button className="toast" onClick={() => setError('')}>{error}<X size={16} /></button>}
    </main>
  );
}
