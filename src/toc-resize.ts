const TOC_WIDTH_STORAGE_KEY = 'luma:reader:toc-width:v1';
const DEFAULT_TOC_WIDTH = 260;
const MIN_TOC_WIDTH = 220;
const MAX_TOC_WIDTH = 520;
const DESKTOP_BREAKPOINT = 900;

function maxAllowedWidth() {
  return Math.max(MIN_TOC_WIDTH, Math.min(MAX_TOC_WIDTH, Math.floor(window.innerWidth * 0.48)));
}

function clampWidth(value: number) {
  return Math.max(MIN_TOC_WIDTH, Math.min(maxAllowedWidth(), Math.round(value)));
}

function readSavedWidth() {
  try {
    const value = Number(localStorage.getItem(TOC_WIDTH_STORAGE_KEY));
    return Number.isFinite(value) && value > 0 ? clampWidth(value) : DEFAULT_TOC_WIDTH;
  } catch {
    return DEFAULT_TOC_WIDTH;
  }
}

function saveWidth(value: number) {
  try {
    localStorage.setItem(TOC_WIDTH_STORAGE_KEY, String(clampWidth(value)));
  } catch {
    // Storage may be unavailable in restrictive/private browser contexts.
  }
}

function applyWidth(layout: HTMLElement, handle: HTMLElement, value: number) {
  const width = clampWidth(value);
  layout.style.setProperty('--luma-toc-width', `${width}px`);
  handle.setAttribute('aria-valuenow', String(width));
  handle.setAttribute('aria-valuemax', String(maxAllowedWidth()));
  return width;
}

function installResizableToc() {
  const layout = document.querySelector<HTMLElement>('.reader-layout');
  const toc = layout?.querySelector<HTMLElement>('.toc-panel');
  if (!layout || !toc || toc.dataset.lumaResizable === 'true') return;

  toc.dataset.lumaResizable = 'true';
  const handle = document.createElement('div');
  handle.className = 'toc-resizer';
  handle.setAttribute('role', 'separator');
  handle.setAttribute('aria-orientation', 'vertical');
  handle.setAttribute('aria-label', 'Cambiar ancho del índice');
  handle.setAttribute('aria-valuemin', String(MIN_TOC_WIDTH));
  handle.tabIndex = 0;

  // Keep the splitter outside the scrolling TOC. If it lives inside .toc-panel,
  // a visible vertical scrollbar changes the panel's scrollport width and makes
  // an absolutely-positioned handle appear several pixels left of the real grid
  // boundary. As a sibling, its position is tied directly to --luma-toc-width.
  layout.appendChild(handle);

  let currentWidth = applyWidth(layout, handle, readSavedWidth());
  let drag: { pointerId: number; startX: number; startWidth: number } | null = null;

  const finishDrag = (pointerId?: number) => {
    if (!drag || (pointerId !== undefined && drag.pointerId !== pointerId)) return;
    const activePointer = drag.pointerId;
    drag = null;
    layout.classList.remove('toc-resizing');
    handle.classList.remove('dragging');
    try {
      if (handle.hasPointerCapture(activePointer)) handle.releasePointerCapture(activePointer);
    } catch {
      // Pointer capture may already have been released by the browser.
    }
    saveWidth(currentWidth);
  };

  handle.addEventListener('pointerdown', (event) => {
    if (window.innerWidth <= DESKTOP_BREAKPOINT || event.button !== 0) return;
    event.preventDefault();
    drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: toc.getBoundingClientRect().width,
    };
    handle.setPointerCapture(event.pointerId);
    layout.classList.add('toc-resizing');
    handle.classList.add('dragging');
  });

  handle.addEventListener('pointermove', (event) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    currentWidth = applyWidth(layout, handle, drag.startWidth + event.clientX - drag.startX);
  });

  handle.addEventListener('pointerup', (event) => finishDrag(event.pointerId));
  handle.addEventListener('pointercancel', (event) => finishDrag(event.pointerId));
  handle.addEventListener('lostpointercapture', () => finishDrag());

  handle.addEventListener('dblclick', () => {
    currentWidth = applyWidth(layout, handle, DEFAULT_TOC_WIDTH);
    saveWidth(currentWidth);
  });

  handle.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    if (event.key === 'Home') currentWidth = applyWidth(layout, handle, MIN_TOC_WIDTH);
    else if (event.key === 'End') currentWidth = applyWidth(layout, handle, maxAllowedWidth());
    else currentWidth = applyWidth(layout, handle, currentWidth + (event.key === 'ArrowRight' ? 20 : -20));
    saveWidth(currentWidth);
  });

  const onResize = () => {
    if (window.innerWidth <= DESKTOP_BREAKPOINT) return;
    currentWidth = applyWidth(layout, handle, currentWidth);
  };
  window.addEventListener('resize', onResize, { passive: true });
}

const observer = new MutationObserver(installResizableToc);
observer.observe(document.documentElement, { childList: true, subtree: true });
queueMicrotask(installResizableToc);

export {};
