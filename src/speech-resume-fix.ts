type LogicalUtterance = {
  utterance: SpeechSynthesisUtterance;
  charIndex: number;
  paused: boolean;
  onBoundary: ((this: SpeechSynthesisUtterance, ev: SpeechSynthesisEvent) => unknown) | null;
  onEnd: ((this: SpeechSynthesisUtterance, ev: SpeechSynthesisEvent) => unknown) | null;
  onError: ((this: SpeechSynthesisUtterance, ev: SpeechSynthesisErrorEvent) => unknown) | null;
};

const synth = window.speechSynthesis;
const marker = synth as SpeechSynthesis & { __lumaResumeFix?: boolean };

if (!marker.__lumaResumeFix) {
  marker.__lumaResumeFix = true;

  const nativeSpeak = synth.speak.bind(synth);
  const nativeCancel = synth.cancel.bind(synth);
  const nativePause = synth.pause.bind(synth);
  const nativeResume = synth.resume.bind(synth);

  let logical: LogicalUtterance | null = null;
  let epoch = 0;

  const cloneUtterance = (source: SpeechSynthesisUtterance, text: string) => {
    const clone = new SpeechSynthesisUtterance(text);
    clone.voice = source.voice;
    clone.lang = source.lang;
    clone.volume = source.volume;
    clone.rate = source.rate;
    clone.pitch = source.pitch;
    return clone;
  };

  const forwardBoundary = (
    target: LogicalUtterance,
    event: SpeechSynthesisEvent,
    baseOffset: number,
  ) => {
    const absoluteIndex = Math.min(
      target.utterance.text.length,
      baseOffset + Math.max(0, Number(event.charIndex || 0)),
    );
    target.charIndex = absoluteIndex;
    if (!target.onBoundary) return;

    // ReaderView only needs charIndex, but preserve the useful Web Speech fields
    // so this remains transparent to any other Luma narration listener.
    const forwarded = {
      charIndex: absoluteIndex,
      charLength: event.charLength,
      elapsedTime: event.elapsedTime,
      name: event.name,
      utterance: target.utterance,
      type: event.type,
      target: target.utterance,
      currentTarget: target.utterance,
    } as unknown as SpeechSynthesisEvent;
    target.onBoundary.call(target.utterance, forwarded);
  };

  synth.speak = (utterance: SpeechSynthesisUtterance) => {
    const target: LogicalUtterance = {
      utterance,
      charIndex: 0,
      paused: false,
      onBoundary: utterance.onboundary,
      onEnd: utterance.onend,
      onError: utterance.onerror,
    };
    logical = target;

    utterance.addEventListener('boundary', (event) => {
      if (logical !== target || target.paused) return;
      target.charIndex = Math.min(
        utterance.text.length,
        Math.max(0, Number(event.charIndex || 0)),
      );
    });

    nativeSpeak(utterance);
  };

  synth.cancel = () => {
    epoch += 1;
    logical = null;
    nativeCancel();
  };

  synth.pause = () => {
    const target = logical;
    if (!target || target.paused) {
      nativePause();
      return;
    }

    target.paused = true;

    // Chrome/Edge can get stuck after native pause()/resume(). Cancel the
    // physical utterance instead, but retain the logical utterance and offset.
    // Detaching callbacks prevents cancel() from being mistaken for a real end.
    target.utterance.onboundary = null;
    target.utterance.onend = null;
    target.utterance.onerror = null;
    nativeCancel();
  };

  synth.resume = () => {
    const target = logical;
    if (!target || !target.paused) {
      nativeResume();
      return;
    }

    const baseOffset = Math.max(0, Math.min(target.utterance.text.length, target.charIndex));
    const remaining = target.utterance.text.slice(baseOffset);
    target.paused = false;

    if (!remaining.trim()) {
      target.onEnd?.call(target.utterance, new Event('end') as unknown as SpeechSynthesisEvent);
      return;
    }

    const replacement = cloneUtterance(target.utterance, remaining);
    const resumeEpoch = epoch;

    replacement.onboundary = (event) => {
      if (logical !== target || target.paused || epoch !== resumeEpoch) return;
      forwardBoundary(target, event, baseOffset);
    };
    replacement.onend = (event) => {
      if (logical !== target || target.paused || epoch !== resumeEpoch) return;
      target.charIndex = target.utterance.text.length;
      target.onEnd?.call(target.utterance, event);
    };
    replacement.onerror = (event) => {
      if (logical !== target || target.paused || epoch !== resumeEpoch) return;
      target.onError?.call(target.utterance, event);
    };

    // A short turn of the event loop gives Chromium time to finish canceling the
    // old physical utterance before the replacement is queued.
    window.setTimeout(() => {
      if (logical !== target || target.paused || epoch !== resumeEpoch) return;
      nativeSpeak(replacement);
    }, 35);
  };
}

export {};
