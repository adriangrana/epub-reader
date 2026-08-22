import { useCallback, useEffect, useRef, useState } from 'react';
import ePub, { Book, Rendition } from 'epubjs';
import {
  ArrowLeft, BookOpenCheck, ChevronLeft, ChevronRight, CirclePause, CirclePlay, Headphones,
  LoaderCircle, MapPin, Menu, Sparkles, X,
} from 'lucide-react';
import {
  fetchBookData, getCurrentUser, LibraryBook, LocalNarrationVoice, synthesizeNarration, updateProgress,
} from './api';
import { SpeechSegment, splitSpeechSegments } from './speech';

type TocItem = { label?: string; href: string; subitems?: TocItem[] };
type NarrationCheckpoint = { cfi: string; offset: number; updatedAt: number };
type SpeechToken = { start: number; end: number; range: Range; document: Document };
type SpeechPage = { text: string; tokens: SpeechToken[] };
type PageLocation = { start?: { cfi?: string; href?: string }; end?: { cfi?: string; href?: string } };
type PageDirection = 'prev' | 'next';

const DAVEFX_VOICE = 'local:davefx';
const CHATTERBOX_BUILTIN_VOICE = 'local:builtin';
const SYSTEM_VOICE_PREFIX = 'system:';

type Props = {
  record: LibraryBook;
  onClose: () => void;
  onProgress: (bookId: string, cfi: string, percentage: number) => void;
};

function localNarrationVoice(value: string): LocalNarrationVoice | null {
  if (value === DAVEFX_VOICE) return 'davefx';
  if (value === CHATTERBOX_BUILTIN_VOICE) return 'builtin';
  return null;
}

function systemVoiceName(value: string): string {
  return value.startsWith(SYSTEM_VOICE_PREFIX) ? value.slice(SYSTEM_VOICE_PREFIX.length) : value;
}

function flattenToc(items: TocItem[], depth = 0): Array<TocItem & { depth: number }> {
  return items.flatMap((item) => [
    { ...item, depth },
    ...(item.subitems ? flattenToc(item.subitems, depth + 1) : []),
  ]);
}

function normalizeHref(href: string) {
  const withoutFragment = href.split('#')[0].split('?')[0].replace(/\\/g, '/').replace(/^(\.\/)+/, '');
  try { return decodeURIComponent(withoutFragment); } catch { return withoutFragment; }
}

function resolveActiveTocHref(items: TocItem[], currentHref: string) {
  if (!currentHref) return '';
  const current = normalizeHref(currentHref);
  const match = flattenToc(items).find((item) => {
    const candidate = normalizeHref(item.href);
    return candidate === current || candidate.endsWith(`/${current}`) || current.endsWith(`/${candidate}`);
  });
  return match?.href ?? '';
}

function delay(ms: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, ms));
}

async function waitForPagePaint() {
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  await delay(65);
}

function pageLocation(rendition: Rendition | null): PageLocation {
  if (!rendition) return {};
  try {
    return (rendition.location ?? {}) as PageLocation;
  } catch {
    return {};
  }
}

function currentCfi(rendition: Rendition | null): string {
  return pageLocation(rendition).start?.cfi ?? '';
}

function installSwipeGestures(document: Document, onTurnPage: (direction: PageDirection) => void) {
  const root = document.documentElement;
  if (!root || root.dataset.lumaSwipe === 'true') return;
  root.dataset.lumaSwipe = 'true';

  let tracking = false;
  let startX = 0;
  let startY = 0;
  let startedAt = 0;

  document.addEventListener('touchstart', (event) => {
    if (event.touches.length !== 1) {
      tracking = false;
      return;
    }
    const touch = event.touches[0];
    tracking = true;
    startX = touch.clientX;
    startY = touch.clientY;
    startedAt = Date.now();
  }, { passive: true });

  document.addEventListener('touchcancel', () => { tracking = false; }, { passive: true });

  document.addEventListener('touchend', (event) => {
    if (!tracking || event.changedTouches.length !== 1) return;
    tracking = false;
    if (!window.matchMedia('(max-width: 900px)').matches) return;

    const touch = event.changedTouches[0];
    const deltaX = touch.clientX - startX;
    const deltaY = touch.clientY - startY;
    const elapsed = Date.now() - startedAt;
    const horizontalDistance = Math.abs(deltaX);
    const verticalDistance = Math.abs(deltaY);

    if (elapsed > 900 || horizontalDistance < 55 || horizontalDistance < verticalDistance * 1.25) return;
    onTurnPage(deltaX < 0 ? 'next' : 'prev');
  }, { passive: true });
}

function visibleSpeechPage(rendition: Rendition): SpeechPage {
  const tokens: SpeechToken[] = [];
  let text = '';
  const location = pageLocation(rendition);
  const startCfi = location.start?.cfi ?? '';
  const endCfi = location.end?.cfi ?? '';

  for (const content of rendition.getContents()) {
    const document = content.document;
    const root = document.body;
    if (!root) continue;

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
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

          if (startCfi || endCfi) {
            try {
              const point = range.cloneRange();
              point.collapse(true);
              const tokenCfi = content.cfiFromRange(point);
              if (startCfi && rendition.epubcfi.compare(tokenCfi, startCfi) < 0) continue;
              if (endCfi && rendition.epubcfi.compare(tokenCfi, endCfi) > 0) continue;
            } catch {
              // Keep a word that a malformed EPUB cannot map to CFI instead of
              // making the whole visible page unnarratable.
            }
          }

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
  const localAudioRef = useRef<HTMLAudioElement | null>(null);
  const localAudioUrlRef = useRef<string | null>(null);
  const checkpointKeyRef = useRef<string | null>(null);
  const lastCheckpointWriteRef = useRef(0);
  const autoAdvanceRef = useRef<(runId: number) => Promise<void>>(async () => undefined);
  const startPageRef = useRef<(offset: number, runId?: number) => Promise<void>>(async () => undefined);
  const manualTurnPageRef = useRef<(direction: PageDirection) => Promise<void>>(async () => undefined);

  const [toc, setToc] = useState<TocItem[]>([]);
  const [activeTocHref, setActiveTocHref] = useState('');
  const [tocOpen, setTocOpen] = useState(false);
  const [progress, setProgress] = useState(record.progress ?? 0);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [voiceName, setVoiceName] = useState(DAVEFX_VOICE);
  const [rate, setRate] = useState(1);
  const [volume, setVolume] = useState(0.75);
  const [speaking, setSpeaking] = useState(false);
  const [paused, setPaused] = useState(false);
  const [loading, setLoading] = useState(true);
  const [narrationPreparing, setNarrationPreparing] = useState(false);
  const [savedCheckpoint, setSavedCheckpoint] = useState<NarrationCheckpoint | null>(null);
  const [resumePromptOpen, setResumePromptOpen] = useState(false);
  const [error, setError] = useState('');

  const releaseLocalAudio = useCallback(() => {
    const audio = localAudioRef.current;
    if (audio) {
      audio.onended = null;
      audio.onerror = null;
      audio.ontimeupdate = null;
      try { audio.pause(); } catch { /* already stopped */ }
      audio.removeAttribute('src');
      try { audio.load(); } catch { /* no-op */ }
      localAudioRef.current = null;
    }
    if (localAudioUrlRef.current) {
      URL.revokeObjectURL(localAudioUrlRef.current);
      localAudioUrlRef.current = null;
    }
  }, []);

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
    if (savePosition && speechPageRef.current && currentPageCfiRef.current) {
      persistCheckpoint(currentPageCfiRef.current, speechOffsetRef.current, true);
    }
    releaseLocalAudio();
    try { window.speechSynthesis.cancel(); } catch { /* browser speech engine unavailable */ }
    clearSpeechHighlight(speechPageRef.current);
    speechPageRef.current = null;
    speechSegmentsRef.current = [];
    speechSegmentIndexRef.current = 0;
    setSpeaking(false);
    setPaused(false);
    setNarrationPreparing(false);
  }, [persistCheckpoint, releaseLocalAudio]);

  useEffect(() => {
    let active = true;
    getCurrentUser().then((user) => {
      if (!active || !user) return;
      const key = `luma:narration:v2:${user.id}:${record.id}`;
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
    const load = () => setVoices(synth.getVoices());
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
        const tocItems = (navigation.toc ?? []) as TocItem[];
        setToc(tocItems);
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

        rendition.on('rendered', (_section: unknown, view: { document?: Document }) => {
          if (view?.document) {
            installSwipeGestures(view.document, (direction) => { void manualTurnPageRef.current(direction); });
          }
        });

        try { await book.locations.generate(1200); } catch { /* reading still works without generated locations */ }
        if (disposed) return;

        rendition.on('relocated', (location: PageLocation) => {
          const cfi = location.start?.cfi;
          if (!cfi || disposed || !book) return;
          currentPageCfiRef.current = cfi;

          let sectionHref = location.start?.href ?? '';
          try {
            const section = book.spine.get(cfi) as { href?: string } | undefined;
            sectionHref = section?.href || sectionHref;
          } catch { /* location href is enough when available */ }
          setActiveTocHref(resolveActiveTocHref(tocItems, sectionHref));

          let percentage = progress;
          try { percentage = book.locations.percentageFromCfi(cfi); } catch { /* preserve last percentage */ }
          percentage = Math.max(0, Math.min(1, percentage));
          setProgress(percentage);
          onProgress(record.id, cfi, percentage);
          updateProgress(record.id, cfi, percentage).catch(() => setError('No se pudo guardar el progreso de lectura.'));
        });

        await rendition.display(record.cfi || undefined);
        await waitForPagePaint();
        const initialCfi = currentCfi(rendition) || record.cfi || '';
        currentPageCfiRef.current = initialCfi;
        if (initialCfi) {
          try {
            const section = book.spine.get(initialCfi) as { href?: string } | undefined;
            setActiveTocHref(resolveActiveTocHref(tocItems, section?.href ?? ''));
          } catch { /* relocated usually already selected the chapter */ }
        }
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

  useEffect(() => {
    if (!activeTocHref) return;
    const frame = requestAnimationFrame(() => {
      const active = document.querySelector('.toc-list button[aria-current="location"]');
      active?.scrollIntoView({ block: 'nearest' });
    });
    return () => cancelAnimationFrame(frame);
  }, [activeTocHref, tocOpen]);

  const speakSegment = useCallback((index: number, runId: number) => {
    if (runId !== speechRunRef.current) return;
    const segment = speechSegmentsRef.current[index];
    const page = speechPageRef.current;
    if (!segment || !page) {
      void autoAdvanceRef.current(runId);
      return;
    }

    speechSegmentIndexRef.current = index;
    speechOffsetRef.current = segment.start;
    highlightSpeechOffset(page, segment.start);

    const localVoice = localNarrationVoice(voiceName);
    if (localVoice) {
      setNarrationPreparing(true);
      void (async () => {
        try {
          const blob = await synthesizeNarration(record.id, segment.text, localVoice);
          if (runId !== speechRunRef.current) return;

          releaseLocalAudio();
          const audioUrl = URL.createObjectURL(blob);
          const audio = new Audio(audioUrl);
          localAudioUrlRef.current = audioUrl;
          localAudioRef.current = audio;
          audio.volume = volume;
          audio.playbackRate = rate;
          audio.preload = 'auto';

          audio.ontimeupdate = () => {
            if (runId !== speechRunRef.current || !Number.isFinite(audio.duration) || audio.duration <= 0) return;
            const ratio = Math.max(0, Math.min(1, audio.currentTime / audio.duration));
            const approximateOffset = Math.min(segment.end, segment.start + Math.floor((segment.end - segment.start) * ratio));
            speechOffsetRef.current = approximateOffset;
            highlightSpeechOffset(page, approximateOffset);
            persistCheckpoint(currentPageCfiRef.current, approximateOffset);
          };

          audio.onended = () => {
            if (runId !== speechRunRef.current) return;
            speechOffsetRef.current = segment.end;
            persistCheckpoint(currentPageCfiRef.current, segment.end, true);
            releaseLocalAudio();
            const nextIndex = index + 1;
            if (nextIndex < speechSegmentsRef.current.length) {
              speakSegment(nextIndex, runId);
              return;
            }
            clearSpeechHighlight(page);
            void autoAdvanceRef.current(runId);
          };

          audio.onerror = () => {
            if (runId !== speechRunRef.current) return;
            releaseLocalAudio();
            setSpeaking(false);
            setPaused(false);
            setNarrationPreparing(false);
            setError('No se pudo reproducir el audio generado por el narrador IA local.');
          };

          setNarrationPreparing(false);
          await audio.play();
        } catch (cause) {
          if (runId !== speechRunRef.current) return;
          releaseLocalAudio();
          setSpeaking(false);
          setPaused(false);
          setNarrationPreparing(false);
          setError(cause instanceof Error ? cause.message : 'El narrador IA local no está disponible.');
        }
      })();
      return;
    }

    const utterance = new SpeechSynthesisUtterance(segment.text);
    const selectedVoiceName = systemVoiceName(voiceName);
    const selectedVoice = voices.find((voice) => voice.name === selectedVoiceName);
    if (selectedVoice) utterance.voice = selectedVoice;
    utterance.rate = rate;
    utterance.volume = volume;

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
      setSpeaking(false);
      setPaused(false);
      setNarrationPreparing(false);
      setError('La voz del navegador interrumpió la narración.');
    };

    window.speechSynthesis.speak(utterance);
  }, [persistCheckpoint, rate, record.id, releaseLocalAudio, voiceName, voices, volume]);

  const startCurrentPageNarration = useCallback(async (offset: number, existingRunId?: number) => {
    const rendition = renditionRef.current;
    if (!rendition) return;

    let runId = existingRunId;
    if (runId === undefined) {
      speechRunRef.current += 1;
      runId = speechRunRef.current;
      releaseLocalAudio();
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
    setSpeaking(true);
    setPaused(false);
    setNarrationPreparing(false);
    speakSegment(0, runId);
  }, [persistCheckpoint, releaseLocalAudio, speakSegment]);

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
      const localVoice = localNarrationVoice(voiceName);
      if (localVoice) {
        const audio = localAudioRef.current;
        if (!audio) return;
        if (paused) {
          void audio.play();
          setPaused(false);
        } else {
          audio.pause();
          setPaused(true);
        }
        return;
      }

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

  const manualTurnPage = useCallback(async (direction: PageDirection) => {
    const rendition = renditionRef.current;
    if (!rendition) return;
    stopSpeech(true);
    if (direction === 'prev') await rendition.prev();
    else await rendition.next();
    await waitForPagePaint();
    currentPageCfiRef.current = currentCfi(rendition) || currentPageCfiRef.current;
    speechOffsetRef.current = 0;
  }, [stopSpeech]);

  useEffect(() => { manualTurnPageRef.current = manualTurnPage; }, [manualTurnPage]);

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
            {flatToc.length ? flatToc.map((item, index) => {
              const isActive = item.href === activeTocHref;
              return (
                <button
                  key={`${item.href}-${index}`}
                  className={isActive ? 'active' : undefined}
                  aria-current={isActive ? 'location' : undefined}
                  style={{ paddingLeft: `${18 + item.depth * 16}px` }}
                  onClick={async () => {
                    stopSpeech(true);
                    await renditionRef.current?.display(item.href);
                    await waitForPagePaint();
                    currentPageCfiRef.current = currentCfi(renditionRef.current) || currentPageCfiRef.current;
                    speechOffsetRef.current = 0;
                    setTocOpen(false);
                  }}
                >{item.label || `Sección ${index + 1}`}</button>
              );
            }) : <p className="muted">Este EPUB no incluye un índice navegable.</p>}
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
        <div className="audio-copy"><span className="audio-icon"><Headphones /></span><div><small>NARRACIÓN CONTINUA</small><strong>{narrationPreparing ? 'Generando narración…' : speaking ? (paused ? 'En pausa' : 'Leyendo y siguiendo el texto') : 'Escuchar el libro'}</strong></div></div>
        <button className="play-button" onClick={requestPlay} disabled={loading || narrationPreparing} aria-label={paused || !speaking ? 'Reproducir' : 'Pausar'}>{speaking && !paused ? <CirclePause /> : <CirclePlay />}</button>
        <label className="audio-control">Voz<select value={voiceName} onChange={(event) => { stopSpeech(true); setVoiceName(event.target.value); }}>
          <optgroup label="IA local">
            <option value={DAVEFX_VOICE}>DaveFX · IA local</option>
            <option value={CHATTERBOX_BUILTIN_VOICE}>Chatterbox original · IA local</option>
          </optgroup>
          <optgroup label="Voces del sistema">
            {voices.map((voice) => <option key={`${voice.name}-${voice.lang}`} value={`${SYSTEM_VOICE_PREFIX}${voice.name}`}>{voice.name} · {voice.lang}</option>)}
          </optgroup>
        </select></label>
        <label className="audio-control speed">Velocidad<select value={rate} onChange={(event) => { stopSpeech(true); setRate(Number(event.target.value)); }}><option value={0.8}>0.8×</option><option value={1}>1×</option><option value={1.15}>1.15×</option><option value={1.3}>1.3×</option><option value={1.5}>1.5×</option><option value={1.75}>1.75×</option></select></label>
        <label className="audio-control volume">Volumen<select value={volume} onChange={(event) => { const nextVolume = Number(event.target.value); setVolume(nextVolume); if (localAudioRef.current) localAudioRef.current.volume = nextVolume; }}><option value={0.5}>50%</option><option value={0.65}>65%</option><option value={0.75}>75%</option><option value={0.85}>85%</option><option value={1}>100%</option></select></label>
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
              <BookOpenCheck /><span><strong>Empezar esta página</strong><small>Lee desde la página visible actual.</small></span>
            </button>
          </div>
        </section>
      </div>}

      {error && <button className="toast" onClick={() => setError('')}>{error}<X size={16} /></button>}
    </main>
  );
}
