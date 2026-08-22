const VOICE_STORAGE_KEY = 'luma:narration:voice:v1';
const VOICE_SELECT_SELECTOR = '.audio-control:not(.speed) select';

function readSavedVoice() {
  try {
    return localStorage.getItem(VOICE_STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

function saveVoice(value: string) {
  if (!value) return;
  try {
    localStorage.setItem(VOICE_STORAGE_KEY, value);
  } catch {
    // Storage can be unavailable in restrictive/private browser contexts.
  }
}

function isVoiceSelect(target: EventTarget | null): target is HTMLSelectElement {
  return target instanceof HTMLSelectElement && target.matches(VOICE_SELECT_SELECTOR);
}

function restoreSavedVoice() {
  const select = document.querySelector<HTMLSelectElement>(VOICE_SELECT_SELECTOR);
  if (!select) return;

  const savedVoice = readSavedVoice();
  if (!savedVoice || select.value === savedVoice) return;
  if (![...select.options].some((option) => option.value === savedVoice)) return;

  // Use the native setter so React's controlled select receives a real change
  // event and updates ReaderView's voiceName state as if the user selected it.
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
  setter?.call(select, savedVoice);
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

document.addEventListener('change', (event) => {
  if (isVoiceSelect(event.target)) saveVoice(event.target.value);
});

const observer = new MutationObserver(() => restoreSavedVoice());
observer.observe(document.documentElement, { childList: true, subtree: true });
queueMicrotask(restoreSavedVoice);
