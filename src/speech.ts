const CHUNK_SIZE = 1200;

export type SpeechSegment = {
  text: string;
  start: number;
  end: number;
};

export function splitForSpeech(text: string): string[] {
  return splitSpeechSegments(text).map((segment) => segment.text);
}

export function splitSpeechSegments(text: string, startOffset = 0): SpeechSegment[] {
  const start = Math.max(0, Math.min(text.length, startOffset));
  if (!text.slice(start).trim()) return [];

  const source = text.slice(start);
  const sentencePattern = /[^.!?…]+[.!?…]+|[^.!?…]+$/g;
  const matches = Array.from(source.matchAll(sentencePattern));
  const segments: SpeechSegment[] = [];
  let currentStart: number | null = null;
  let currentEnd = 0;

  const pushRange = (rangeStart: number, rangeEnd: number) => {
    let left = rangeStart;
    let right = rangeEnd;
    while (left < right && /\s/.test(text[left])) left += 1;
    while (right > left && /\s/.test(text[right - 1])) right -= 1;
    if (right <= left) return;
    segments.push({ text: text.slice(left, right), start: left, end: right });
  };

  const flushCurrent = () => {
    if (currentStart === null) return;
    pushRange(currentStart, currentEnd);
    currentStart = null;
    currentEnd = 0;
  };

  for (const match of matches) {
    const sentenceStart = start + (match.index ?? 0);
    const sentenceEnd = sentenceStart + match[0].length;

    if (sentenceEnd - sentenceStart > CHUNK_SIZE) {
      flushCurrent();
      for (let cursor = sentenceStart; cursor < sentenceEnd; cursor += CHUNK_SIZE) {
        pushRange(cursor, Math.min(sentenceEnd, cursor + CHUNK_SIZE));
      }
      continue;
    }

    if (currentStart === null) {
      currentStart = sentenceStart;
      currentEnd = sentenceEnd;
      continue;
    }

    if (sentenceEnd - currentStart <= CHUNK_SIZE) {
      currentEnd = sentenceEnd;
      continue;
    }

    flushCurrent();
    currentStart = sentenceStart;
    currentEnd = sentenceEnd;
  }

  flushCurrent();

  if (!segments.length) {
    for (let cursor = start; cursor < text.length; cursor += CHUNK_SIZE) {
      pushRange(cursor, Math.min(text.length, cursor + CHUNK_SIZE));
    }
  }

  return segments;
}
