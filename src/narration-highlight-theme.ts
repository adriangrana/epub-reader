const HIGHLIGHT_STYLE_ID = 'luma-narration-highlight-theme';

const HIGHLIGHT_CSS = `
  ::highlight(luma-narration) {
    background: #c8f273 !important;
    color: #27321c !important;
    box-shadow: 0 0 0 3px #c8f273 !important;
    border-radius: 4px !important;
    text-decoration: none !important;
  }
`;

function injectHighlightTheme(frame: HTMLIFrameElement) {
  try {
    const document = frame.contentDocument;
    if (!document?.head || document.getElementById(HIGHLIGHT_STYLE_ID)) return;

    const style = document.createElement('style');
    style.id = HIGHLIGHT_STYLE_ID;
    style.textContent = HIGHLIGHT_CSS;
    document.head.appendChild(style);
  } catch {
    // EPUB iframe may be between documents while epub.js is changing pages.
  }
}

function installHighlightTheme() {
  document.querySelectorAll<HTMLIFrameElement>('.epub-viewer iframe').forEach((frame) => {
    if (frame.dataset.lumaHighlightTheme !== 'true') {
      frame.dataset.lumaHighlightTheme = 'true';
      frame.addEventListener('load', () => injectHighlightTheme(frame));
    }
    injectHighlightTheme(frame);
  });
}

const observer = new MutationObserver(installHighlightTheme);
observer.observe(document.documentElement, { childList: true, subtree: true });
queueMicrotask(installHighlightTheme);

export {};
