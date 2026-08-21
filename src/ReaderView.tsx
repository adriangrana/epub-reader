import { useCallback, useEffect, useRef, useState } from 'react';
import ePub, { Book, Rendition } from 'epubjs';
import {
  ArrowLeft, BookOpenCheck, ChevronLeft, ChevronRight, CirclePause, CirclePlay, Headphones,
  LoaderCircle, MapPin, Menu, Sparkles, X,
} from 'lucide-react';
import { fetchBookData, getCurrentUser, LibraryBook, updateProgress } from './api';
import { SpeechSegment, splitSpeechSegments } from './speech';

type TocItem = { label?: string; href: string; subitems?: TocItem[] };
type NarrationCheckpoint = { cfi: string; offset: number; updatedAt: number };
type SpeechToken = { start: number; end: number; range: Range; document: Document };
type SpeechPage = { text: string; tokens: SpeechToken[] };

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

function delay(ms: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, ms));
}

async function waitForPagePaint() {
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  await delay(45);
}

function currentCfi(rendition: Rendition | null): string {
  if (!rendition) return '';
  try {
    const location = rendition.currentLocation() as { start?: { cfi?: string } } | undefined;
    return location?.start?.cfi ?? '';
  } catch {
    return '';
  }
}

function rangeIsVisible(range: Range, width: number, height: number) {
  return Array.from(range.getClientRects()).some((rect) => (
    rect.width > 0 && rect.height > 0
    && rect.right > 0 && rect.left < width
    && rect.bottom > 0 && rect.top < height
  ));
}

function visibleSpeechPage(rendition: Rendition): SpeechPage {
  const tokens: SpeechToken[] = [];
  let text = '';

  for (const content of rendition.getContents()) {
    const document = content.document;
    const root = document.body;
    const view = document.defaultView;
    if (!root || !view) continue;

    const width = view.innerWidth || document.documentElement.clientWidth;
    const height = view.innerHeight || document.documentElement.clientHeight;
    const walker = document.createTreeWalker(root, 4);
    let node = walker.nextNode() as Text | null;

    while (node) {
      const parent = node.parentElement;
      if (parent && !parent.closest('script, style, noscript')) {
        const source = node.data;
        for (const match of source.matchAll(/\S+/g)) {
          const localStart = match.index ?? 0;
          const localEnd = localStart + match[0].length;
          const range = document.createRange();
          range.setStart(node, localStart);
          range.setEnd(node, localEnd);
          if (!rangeIsVisible(range, width, height)) continue;

          if (text) text += ' ';
          const start = text.length;
          text += match[0];
          tokens.push({ start, end: text.length, range, document });
        }
      }
      node = walker.nextNode() as Text | null;
    }
  }

  return { text, tokens };
}

function ensureHighlightStyle(document: Document) {
  if (document.querySelector('style[data-luma-narration]')) return;
  const style = document.createElement('style');
  style.dataset.lumaNarration = 'true';
  style.textContent = `
    ::highlight(luma-narration) {
      background: rgba(140, 108, 255, .34);
      color: inherit;
      text-decoration: underline;
      text-decoration-color: rgba(104, 74, 235, .65);
      text-decoration-thickness: 2px;
      text-underline-offset: 3px;
    }
  `;
  document.head?.appendChild(style);
}

function clearSpeechHighlight(page: SpeechPage | null) {
  if (!page) return;
  for (const document of new Set(page.tokens.map((token) => token.document))) {
    const view = document.defaultView as (Window & { CSS?: { highlights?: Map<string, unknown> } }) | null;
    try { view?.CSS?.highlights?.delete('luma-narration'); } catch { /* optional API */ }
    try { view?.getSelection()?.removeAllRanges(); } catch { /* fallback cleanup */ }
  }
}

function highlightSpeechOffset(page: SpeechPage, offset: number) {
  const token = page.tokens.find((candidate) => offset >= candidate.start && offset < candidate.end)
    ?? [...page.tokens].reverse().find((candidate) => candidate.start <= offset)
    ?? page.tokens[0];
  if (!token) return;

  ensureHighlightStyle(token.document);
  const view = token.document.defaultView as (Window & {
    CSS?: { highlights?: Map<string, unknown> };
    Highlight?: new (...ranges: Range[]) => unknown;
  }) | null;

  try {
    if (view?.CSS?.highlights && view.Highlight) {
      view.CSS.highlights.set('luma-narration', new view.Highlight(token.range));
      return;
    }
  } catch { /* use selection fallback */ }

  try {
    const selection = view?.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(token.range);
  } catch { /* highlighting is optional */ }
}

export default function ReaderView({ record, onClose, onProgress }: Props) {
  const viewerRef = useRef<HTMLDivElement>(null);
  const bookRef = useRef<Book | null>(null);
  const renditionRef = useRef<Rendition | null>(null);
  const currentPageCfiRef = useRef('');
  const speechPageRef = useRef<SpeechPage | null>(null);
  const speechSegmentsRef = useRef<SpeechSegment[]>([]);
  const speechSegmentIndexRef = useRef(0);
  const speechOffsetRef = useRef(0);
  const speechRunRef = useRef(0);
  const speakingRef = useRef(false);
  const checkpointKeyRef = useRef<string | null>(null);
  const lastCheckpointWriteRef = useRef(0);
  const autoAdvanceRef = useRef<(runId: number) => Promise<void>>(async () => undefined);
  const startPageRef = useRef<(offset: number, runId?: number) => Promise<void>>(async () => undefined);

  const [toc, setToc] = useState<TocItem[]>([]);
  const [tocOpen, setTocOpen] = useState(false);
  const [progress, setProgress] = useState(record.progress ?? 0);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [voiceName, setVoiceName] = useState('');
  const [rate, setRate] = useState(1);
  const [speaking, setSpeaking] = useState(false);
  const [paused, setPaused] = useState(false);
  const [loading, setLoading] = useState(true);
  const [narrationPreparing, setNarrationPreparing] = useState(false);
  const [savedCheckpoint, setSavedCheckpoint] = useState<NarrationCheckpoint | null>(null);
  const [resumePromptOpen, setResumePromptOpen] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { speakingRef.current = speaking; }, [speaking]);

  const persistCheckpoint = useCallback((cfi: string, offset: number, force = false) => {
    const key = checkpointKeyRef.current;
    if (!key || !cfi) return;
    const now = Date.now();
    if (!force && now - lastCheckpointWriteRef.current < 900) return;
    lastCheckpointWriteRef.current = now;
    const checkpoint = { cfi, offset: Math.max(0, Math.floor(offset)), updatedAt: now };
    try { localStorage.setItem(key, JSON.stringify(checkpoint)); } catch { /* storage may be disabled */ }
    setSavedCheckpoint(checkpoint);
  }, []);

  const stopSpeech = useCallback((savePosition = true) => {
    speechRunRef.current += 1;
    if (savePosition && currentPageCfiRef.current) {
      persistCheckpoint(currentPageCfiRef.current, speechOffsetRef.current, true);
    }
    try { window.speechSynthesis.cancel(); } catch { /* browser speech engine unavailable */ }
    clearSpeechHighlight(speechPageRef.current);
    speechPageRef.current = null;
    speechSegmentsRef.current = [];
    speechSegmentIndexRef.current = 0;
    speakingRef.current = false;
    setSpeaking(false);
    setPaused(false);
    setNarrationPreparing(false);
  }, [persistCheckpoint]);

  useEffect(() => {
    let active = true;
    getCurrentUser().then((user) => {
      if (!active || !user) return;
      const key = `luma:narration:${user.id}:${record.id}`;
      checkpointKeyRef.current = key;
      try {
        const raw = localStorage.getItem(key);
        if (!raw) return;
        const parsed = JSON.parse(raw) as Partial<NarrationCheckpoint>;
        if (typeof parsed.cfi === 'string' && parsed.cfi && Number.isFinite(parsed.offset)) {
          setSavedCheckpoint({ cfi: parsed.cfi, offset: Math.max(0, Number(parsed.offset)), updatedAt: Number(parsed.updatedAt || 0) });
        }
      } catch { /* ignore malformed local checkpoint */ }
    }).catch(() => undefined);
    return () => { active = false; };
  }, [record.id]);

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
          currentPageCfiRef.current = cfi;
          let percentage = progress;
          try { percentage = book.locations.percentageFromCfi(cfi); } catch { /* preserve last percentage */ }
          percentage = Math.max(0, Math.min(1, percentage));
          setProgress(percentage);
          onProgress(record.id, cfi, percentage);
          updateProgress(record.id, cfi, percentage).catch(() => setError('No se pudo guardar el progreso de lectura.'));
        });

        await rendition.display(record.cfi || undefined);
        await waitForPagePaint();
        currentPageCfiRef.current = currentCfi(rendition) || record.cfi || '';
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
      stopSpeech(true);
      try { rendition?.destroy(); } catch { /* already disposed */ }
      try { book?.destroy(); } catch { /* already disposed */ }
      renditionRef.current = null;
      bookRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [record.id]);

  const speakSegment = useCallback((index: number, runId: number) => {
    if (runId !== speechRunRef.current) return;
    const segment = speechSegmentsRef.current[index];
    const page = speechPageRef.current;
    if (!segment || !page) {
      void autoAdvanceRef.current(runId);
      return;
    }

    speechSegmentIndexRef.current = index;
    const utterance = new SpeechSynthesisUtterance(segment.text);
    const selectedVoice = voices.find((voice) => voice.name === voiceName);
    if (selectedVoice) utterance.voice = selectedVoice;
    utterance.rate = rate;

    speechOffsetRef.current = segment.start;
    highlightSpeechOffset(page, segment.start);

    utterance.onboundary = (event) => {
      if (runId !== speechRunRef.current) return;
      const absoluteOffset = Math.min(page.text.length, segment.start + Math.max(0, event.charIndex || 0));
      speechOffsetRef.current = absoluteOffset;
      highlightSpeechOffset(page, absoluteOffset);
      persistCheckpoint(currentPageCfiRef.current, absoluteOffset);
    };

    utterance.onend = () => {
      if (runId !== speechRunRef.current) return;
      speechOffsetRef.current = segment.end;
      persistCheckpoint(currentPageCfiRef.current, segment.end, true);
      const nextIndex = index + 1;
      if (nextIndex < speechSegmentsRef.current.length) {
        speakSegment(nextIndex, runId);
        return;
      }
      clearSpeechHighlight(page);
      void autoAdvanceRef.current(runId);
    };

    utterance.onerror = (event) => {
      if (runId !== speechRunRef.current) return;
      const reason = String((event as SpeechSynthesisErrorEvent).error || '');
      if (reason === 'interrupted' || reason === 'canceled') return;
      speakingRef.current = false;
      setSpeaking(false);
      setPaused(false);
      setNarrationPreparing(false);
      setError('La voz del navegador interrumpió la narración.');
    };

    window.speechSynthesis.speak(utterance);
  }, [persistCheckpoint, rate, voiceName, voices]);

  const startCurrentPageNarration = useCallback(async (offset: number, existingRunId?: number) => {
    const rendition = renditionRef.current;
    if (!rendition) return;

    let runId = existingRunId;
    if (runId === undefined) {
      speechRunRef.current += 1;
      runId = speechRunRef.current;
      try { window.speechSynthesis.cancel(); } catch { /* no-op */ }
    }
    if (runId !== speechRunRef.current) return;

    setNarrationPreparing(true);
    await waitForPagePaint();
    if (runId !== speechRunRef.current) return;

    currentPageCfiRef.current = currentCfi(rendition) || currentPageCfiRef.current;
    const page = visibleSpeechPage(rendition);
    speechPageRef.current = page;

    if (!page.text.trim()) {
      setNarrationPreparing(false);
      await autoAdvanceRef.current(runId);
      return;
    }

    const safeOffset = Math.max(0, Math.min(page.text.length, offset));
    speechOffsetRef.current = safeOffset;
    const segments = splitSpeechSegments(page.text, safeOffset);
    speechSegmentsRef.current = segments;
    speechSegmentIndexRef.current = 0;

    if (!segments.length) {
      setNarrationPreparing(false);
      await autoAdvanceRef.current(runId);
      return;
    }

    persistCheckpoint(currentPageCfiRef.current, safeOffset, true);
    speakingRef.current = true;
    setSpeaking(true);
    setPaused(false);
    setNarrationPreparing(false);
    speakSegment(0, runId);
  }, [persistCheckpoint, speakSegment]);

  useEffect(() => { startPageRef.current = startCurrentPageNarration; }, [startCurrentPageNarration]);

  const autoAdvance = useCallback(async (runId: number) => {
    const rendition = renditionRef.current;
    if (!rendition || runId !== speechRunRef.current) return;
    const before = currentPageCfiRef.current || currentCfi(rendition);

    try {
      await rendition.next();
      await waitForPagePaint();
    } catch { /* end of malformed book */ }

    if (runId !== speechRunRef.current) return;
    const after = currentCfi(rendition) || currentPageCfiRef.current;
    currentPageCfiRef.current = after;

    if (!after || after === before) {
      persistCheckpoint(before, speechOffsetRef.current, true);
      speakingRef.current = false;
      setSpeaking(false);
      setPaused(false);
      setNarrationPreparing(false);
      return;
    }

    speechOffsetRef.current = 0;
    persistCheckpoint(after, 0, true);
    await startPageRef.current(0, runId);
  }, [persistCheckpoint]);

  useEffect(() => { autoAdvanceRef.current = autoAdvance; }, [autoAdvance]);

  const beginFromCurrentPage = useCallback(async () => {
    setResumePromptOpen(false);
    speechOffsetRef.current = 0;
    await startCurrentPageNarration(0);
  }, [startCurrentPageNarration]);

  const continueSavedNarration = useCallback(async () => {
    const checkpoint = savedCheckpoint;
    const rendition = renditionRef.current;
    if (!checkpoint || !rendition) return beginFromCurrentPage();

    setResumePromptOpen(false);
    stopSpeech(false);
    speechRunRef.current += 1;
    const runId = speechRunRef.current;
    setNarrationPreparing(true);

    try {
      await rendition.display(checkpoint.cfi);
      await waitForPagePaint();
      if (runId !== speechRunRef.current) return;
      currentPageCfiRef.current = currentCfi(rendition) || checkpoint.cfi;
      await startPageRef.current(checkpoint.offset, runId);
    } catch {
      setNarrationPreparing(false);
      setError('No pude recuperar exactamente el punto de narración. Puedes iniciar desde la página actual.');
    }
  }, [beginFromCurrentPage, savedCheckpoint, stopSpeech]);

  const requestPlay = () => {
    if (speaking) {
      if (paused) {
        window.speechSynthesis.resume();
        setPaused(false);
      } else {
        window.speechSynthesis.pause();
        setPaused(true);
      }
      return;
    }

    if (savedCheckpoint?.cfi) {
      setResumePromptOpen(true);
      return;
    }
    void beginFromCurrentPage();
  };

  const manualTurnPage = async (direction: 'prev' | 'next') => {
    const rendition = renditionRef.current;
    if (!rendition) return;
    stopSpeech(true);
    if (direction === 'prev') await rendition.prev();
    else await rendition.next();
    await waitForPagePaint();
    currentPageCfiRef.current = currentCfi(rendition) || currentPageCfiRef.current;
    speechOffsetRef.current = 0;
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
              <button key={`${item.href}-${index}`} style={{ paddingLeft: `${18 + item.depth * 16}px` }} onClick={async () => {
                stopSpeech(true);
                await renditionRef.current?.display(item.href);
                await waitForPagePaint();
                currentPageCfiRef.current = currentCfi(renditionRef.current) || currentPageCfiRef.current;
                speechOffsetRef.current = 0;
                setTocOpen(false);
              }}>{item.label || `Sección ${index + 1}`}</button>
            )) : <p className="muted">Este EPUB no incluye un índice navegable.</p>}
          </div>
        </aside>

        <section className="book-stage">
          <button className="page-arrow left" onClick={() => { void manualTurnPage('prev'); }} aria-label="Página anterior"><ChevronLeft /></button>
          <div className="paper"><div ref={viewerRef} className="epub-viewer" /></div>
          <button className="page-arrow right" onClick={() => { void manualTurnPage('next'); }} aria-label="Página siguiente"><ChevronRight /></button>
          {loading && <div className="reader-loading"><LoaderCircle className="spin" /><span>Abriendo EPUB…</span></div>}
        </section>
      </div>

      <footer className="audio-dock">
        <div className="audio-copy"><span className="audio-icon"><Headphones /></span><div><small>NARRACIÓN CONTINUA</small><strong>{narrationPreparing ? 'Preparando narración…' : speaking ? (paused ? 'En pausa' : 'Leyendo y siguiendo el texto') : 'Escuchar el libro'}</strong></div></div>
        <button className="play-button" onClick={requestPlay} disabled={loading || narrationPreparing} aria-label={paused || !speaking ? 'Reproducir' : 'Pausar'}>{speaking && !paused ? <CirclePause /> : <CirclePlay />}</button>
        <label className="audio-control">Voz<select value={voiceName} onChange={(event) => { stopSpeech(true); setVoiceName(event.target.value); }}>{voices.map((voice) => <option key={`${voice.name}-${voice.lang}`} value={voice.name}>{voice.name} · {voice.lang}</option>)}</select></label>
        <label className="audio-control speed">Velocidad<select value={rate} onChange={(event) => { stopSpeech(true); setRate(Number(event.target.value)); }}><option value={0.8}>0.8×</option><option value={1}>1×</option><option value={1.15}>1.15×</option><option value={1.3}>1.3×</option><option value={1.5}>1.5×</option><option value={1.75}>1.75×</option></select></label>
        {speaking && <button className="text-button" onClick={() => stopSpeech(true)}>Detener</button>}
      </footer>

      {resumePromptOpen && <div className="narration-choice-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setResumePromptOpen(false); }}>
        <section className="narration-choice" role="dialog" aria-modal="true" aria-labelledby="narration-choice-title">
          <button className="modal-close" onClick={() => setResumePromptOpen(false)} aria-label="Cerrar"><X /></button>
          <span className="narration-choice-icon"><Headphones /></span>
          <span className="eyebrow">LUMA RECUERDA TU AUDIO</span>
          <h2 id="narration-choice-title">¿Desde dónde quieres escuchar?</h2>
          <p>Hay un punto de narración guardado para este libro. Puedes retomarlo o comenzar desde la página que tienes abierta ahora.</p>
          <div className="narration-choice-actions">
            <button className="resume-option primary" onClick={() => { void continueSavedNarration(); }}>
              <MapPin /><span><strong>Continuar donde lo dejé</strong><small>Recupera la página y la palabra aproximada.</small></span>
            </button>
            <button className="resume-option" onClick={() => { void beginFromCurrentPage(); }}>
              <BookOpenCheck /><span><strong>Empezar esta página</strong><small>Lee solamente desde la página visible actual.</small></span>
            </button>
          </div>
        </section>
      </div>}

      {error && <button className="toast" onClick={() => setError('')}>{error}<X size={16} /></button>}
    </main>
  );
}
