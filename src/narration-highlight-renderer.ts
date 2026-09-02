const HIGHLIGHT_NAME = 'luma-narration';
const MARKER_SELECTOR = 'span[data-luma-narration-word]';

function unwrapMarkers(document: Document) {
  for (const marker of Array.from(document.querySelectorAll<HTMLElement>(MARKER_SELECTOR))) {
    const parent = marker.parentNode;
    if (!parent) {
      marker.remove();
      continue;
    }
    while (marker.firstChild) parent.insertBefore(marker.firstChild, marker);
    marker.remove();
  }
}

function firstRange(highlight: unknown): Range | null {
  const value = highlight as {
    values?: () => IterableIterator<unknown>;
    [Symbol.iterator]?: () => IterableIterator<unknown>;
  } | null;

  try {
    const iterator = typeof value?.values === 'function'
      ? value.values()
      : typeof value?.[Symbol.iterator] === 'function'
        ? value[Symbol.iterator]()
        : null;
    if (!iterator) return null;

    for (const candidate of iterator) {
      if (candidate && typeof (candidate as Range).cloneRange === 'function') {
        return candidate as Range;
      }
    }
  } catch {
    // Keep the native custom highlight when its ranges cannot be inspected.
  }
  return null;
}

function renderRoundedMarker(document: Document, highlight: unknown) {
  unwrapMarkers(document);
  const liveRange = firstRange(highlight);
  if (!liveRange) return;

  try {
    const range = liveRange.cloneRange();
    if (range.collapsed) return;

    const marker = document.createElement('span');
    marker.dataset.lumaNarrationWord = 'true';
    marker.style.background = '#c8f273';
    marker.style.color = '#27321c';
    marker.style.boxShadow = '0 0 0 3px #c8f273';
    marker.style.borderRadius = '4px';
    marker.style.setProperty('box-decoration-break', 'clone');
    marker.style.setProperty('-webkit-box-decoration-break', 'clone');

    range.surroundContents(marker);
  } catch {
    // The CSS Custom Highlight remains as a safe fallback if a malformed EPUB
    // produces a range that cannot be wrapped.
  }
}

function installInFrame(frame: HTMLIFrameElement) {
  let document: Document;
  let view: Window;
  try {
    document = frame.contentDocument!;
    view = frame.contentWindow!;
  } catch {
    return;
  }
  if (!document || !view) return;

  const css = (view as Window & { CSS?: { highlights?: unknown } }).CSS;
  const registry = css?.highlights as {
    set?: (name: string, highlight: unknown) => unknown;
    delete?: (name: string) => boolean;
    clear?: () => void;
  } | undefined;
  if (!registry) return;

  const prototype = Object.getPrototypeOf(registry) as {
    set?: (this: unknown, name: string, highlight: unknown) => unknown;
    delete?: (this: unknown, name: string) => boolean;
    clear?: (this: unknown) => void;
    __lumaRoundedNarrationHighlight?: boolean;
  } | null;
  if (!prototype || prototype.__lumaRoundedNarrationHighlight || typeof prototype.set !== 'function') return;

  const nativeSet = prototype.set;
  const nativeDelete = prototype.delete;
  const nativeClear = prototype.clear;

  try {
    Object.defineProperty(prototype, '__lumaRoundedNarrationHighlight', {
      value: true,
      configurable: true,
    });

    prototype.set = function patchedSet(name: string, highlight: unknown) {
      const result = nativeSet.call(this, name, highlight);
      if (this === registry && name === HIGHLIGHT_NAME) renderRoundedMarker(document, highlight);
      return result;
    };

    if (typeof nativeDelete === 'function') {
      prototype.delete = function patchedDelete(name: string) {
        const result = nativeDelete.call(this, name);
        if (this === registry && name === HIGHLIGHT_NAME) unwrapMarkers(document);
        return result;
      };
    }

    if (typeof nativeClear === 'function') {
      prototype.clear = function patchedClear() {
        const result = nativeClear.call(this);
        if (this === registry) unwrapMarkers(document);
        return result;
      };
    }
  } catch {
    // Some engines may expose a non-writable HighlightRegistry prototype. In
    // that case ReaderView's native ::highlight rendering continues to work.
  }
}

function installNarrationHighlightRenderer() {
  for (const frame of Array.from(document.querySelectorAll<HTMLIFrameElement>('iframe'))) {
    if (frame.dataset.lumaNarrationHighlightRenderer !== 'true') {
      frame.dataset.lumaNarrationHighlightRenderer = 'true';
      frame.addEventListener('load', () => installInFrame(frame));
    }
    installInFrame(frame);
  }
}

const observer = new MutationObserver(installNarrationHighlightRenderer);
observer.observe(document.documentElement, { childList: true, subtree: true });
queueMicrotask(installNarrationHighlightRenderer);

export {};
