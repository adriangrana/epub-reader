import { SpeechSegment, splitSpeechSegments } from './speech';

export const NARRATOR_ROLE = 'Narrador';
export const FALLBACK_ROLE_1 = 'Personaje 1';
export const FALLBACK_ROLE_2 = 'Personaje 2';

export type CastRole = {
  id: string;
  label: string;
  mentions: number;
  detected: boolean;
};

export type CastSpeechSegment = SpeechSegment & {
  speaker: string;
};

const SPEECH_VERBS = [
  'dijo', 'preguntó', 'respondió', 'contestó', 'añadió', 'murmuró', 'susurró',
  'gritó', 'exclamó', 'replicó', 'insistió', 'comentó', 'observó', 'señaló',
  'avisó', 'recordó', 'ordenó', 'pidió', 'admitió', 'explicó', 'continuó',
  'prosiguió', 'intervino', 'anunció', 'aclaró', 'concluyó', 'bromeó',
];

const NAME_TOKEN = "[A-ZÁÉÍÓÚÜÑ][\\p{L}ÁÉÍÓÚÜÑáéíóúüñ’'-]{1,30}";
const VERB_PATTERN = SPEECH_VERBS.join('|');
const VERB_THEN_NAME = new RegExp(`(?:${VERB_PATTERN})\\s+(${NAME_TOKEN})`, 'gu');
const NAME_THEN_VERB = new RegExp(`(${NAME_TOKEN})\\s+(?:${VERB_PATTERN})`, 'gu');
const NAME_STOPWORDS = new Set([
  'El', 'La', 'Los', 'Las', 'Un', 'Una', 'Uno', 'Y', 'Pero', 'Entonces', 'Después',
  'Antes', 'Cuando', 'Mientras', 'Aunque', 'Porque', 'Como', 'Sin', 'Con', 'Por',
]);

function cleanName(candidate: string) {
  const name = candidate.trim().replace(/[.,;:!?…»”)]*$/u, '');
  if (!name || NAME_STOPWORDS.has(name)) return '';
  return name;
}

function collectAttributedNames(text: string, counts: Map<string, number>) {
  for (const pattern of [VERB_THEN_NAME, NAME_THEN_VERB]) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const name = cleanName(match[1] || '');
      if (!name) continue;
      counts.set(name, (counts.get(name) || 0) + 1);
    }
  }
}

export function detectCastRolesFromText(text: string, maxCharacters = 12): CastRole[] {
  const counts = new Map<string, number>();
  collectAttributedNames(text, counts);
  const detected = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'es'))
    .slice(0, maxCharacters)
    .map(([name, mentions]) => ({ id: name, label: name, mentions, detected: true }));

  return [
    { id: NARRATOR_ROLE, label: NARRATOR_ROLE, mentions: 0, detected: true },
    ...detected,
    { id: FALLBACK_ROLE_1, label: FALLBACK_ROLE_1, mentions: 0, detected: false },
    { id: FALLBACK_ROLE_2, label: FALLBACK_ROLE_2, mentions: 0, detected: false },
  ];
}

type SectionLike = {
  document?: Document;
  load?: (request: (path: string) => Promise<unknown>) => Promise<unknown>;
  unload?: () => void;
};

type BookLike = {
  load?: (path: string) => Promise<unknown>;
  spine?: { spineItems?: SectionLike[] };
};

export async function detectCastRolesFromBook(book: unknown, maxCharacters = 12): Promise<CastRole[]> {
  const target = book as BookLike;
  const sections = target.spine?.spineItems ?? [];
  const request = typeof target.load === 'function' ? target.load.bind(target) : null;
  const chunks: string[] = [];
  let totalCharacters = 0;
  const maxScanCharacters = 2_000_000;

  for (const section of sections) {
    if (totalCharacters >= maxScanCharacters) break;
    let loadedHere = false;
    try {
      if (!section.document && section.load && request) {
        await section.load(request);
        loadedHere = true;
      }
      const text = section.document?.body?.innerText || section.document?.body?.textContent || '';
      if (!text.trim()) continue;
      const remaining = maxScanCharacters - totalCharacters;
      const chunk = text.slice(0, remaining);
      chunks.push(chunk);
      totalCharacters += chunk.length;
    } catch {
      // Some EPUB sections cannot be loaded independently. Continue scanning the rest.
    } finally {
      if (loadedHere) {
        try { section.unload?.(); } catch { /* best-effort cleanup */ }
      }
    }
  }

  if (!chunks.length) {
    return detectCastRolesFromText('', maxCharacters);
  }
  return detectCastRolesFromText(chunks.join('\n'), maxCharacters);
}

function findAttributedSpeaker(text: string, knownNames: string[]) {
  if (!text) return '';
  const known = new Set(knownNames);
  const counts = new Map<string, number>();
  collectAttributedNames(text, counts);
  for (const [name] of counts) {
    if (!known.size || known.has(name)) return name;
  }
  return '';
}

function findMentionedKnownName(text: string, knownNames: string[]) {
  let best = '';
  let bestIndex = Number.POSITIVE_INFINITY;
  for (const name of knownNames) {
    const index = text.indexOf(name);
    if (index >= 0 && index < bestIndex) {
      best = name;
      bestIndex = index;
    }
  }
  return best;
}

function splitRange(text: string, start: number, end: number, speaker: string, startOffset: number) {
  if (end <= start || end <= startOffset) return [] as CastSpeechSegment[];
  const localStart = Math.max(0, startOffset - start);
  return splitSpeechSegments(text.slice(start, end), localStart).map((segment) => ({
    ...segment,
    start: start + segment.start,
    end: start + segment.end,
    speaker,
  }));
}

export function splitCastSpeechSegments(text: string, roles: CastRole[], startOffset = 0): CastSpeechSegment[] {
  const segments: CastSpeechSegment[] = [];
  const knownNames = roles
    .map((role) => role.id)
    .filter((id) => id !== NARRATOR_ROLE && id !== FALLBACK_ROLE_1 && id !== FALLBACK_ROLE_2);
  const recentSpeakers: string[] = [];
  let pendingNarrativeSpeaker = '';
  let fallbackTurn = 0;
  let lastSpeaker = '';

  const rememberSpeaker = (speaker: string) => {
    if (!speaker || speaker === NARRATOR_ROLE) return;
    lastSpeaker = speaker;
    const index = recentSpeakers.indexOf(speaker);
    if (index >= 0) recentSpeakers.splice(index, 1);
    recentSpeakers.push(speaker);
    while (recentSpeakers.length > 2) recentSpeakers.shift();
  };

  const inferDialogueSpeaker = (line: string, tail: string) => {
    const explicit = findAttributedSpeaker(tail || line, knownNames);
    if (explicit) return explicit;
    if (pendingNarrativeSpeaker) {
      const inferred = pendingNarrativeSpeaker;
      pendingNarrativeSpeaker = '';
      return inferred;
    }
    if (recentSpeakers.length >= 2) {
      const alternate = [...recentSpeakers].reverse().find((speaker) => speaker !== lastSpeaker);
      if (alternate) return alternate;
    }
    const fallback = fallbackTurn % 2 === 0 ? FALLBACK_ROLE_1 : FALLBACK_ROLE_2;
    fallbackTurn += 1;
    return fallback;
  };

  const linePattern = /[^\n]+/g;
  for (const match of text.matchAll(linePattern)) {
    const rawLine = match[0];
    const lineStart = match.index ?? 0;
    const leading = rawLine.search(/\S/u);
    if (leading < 0) continue;
    const contentStart = lineStart + leading;
    const content = rawLine.slice(leading);
    const lineEnd = lineStart + rawLine.length;
    const isDialogue = /^[—–-]/u.test(content);

    if (!isDialogue) {
      pendingNarrativeSpeaker = findMentionedKnownName(content, knownNames);
      segments.push(...splitRange(text, contentStart, lineEnd, NARRATOR_ROLE, startOffset));
      continue;
    }

    const closingMarker = content.indexOf(' —', 1);
    const dialogueEnd = closingMarker >= 0 ? contentStart + closingMarker : lineEnd;
    const tailStart = closingMarker >= 0 ? dialogueEnd + 1 : lineEnd;
    const tail = tailStart < lineEnd ? text.slice(tailStart, lineEnd) : '';
    const speaker = inferDialogueSpeaker(content, tail);
    rememberSpeaker(speaker);
    segments.push(...splitRange(text, contentStart, dialogueEnd, speaker, startOffset));
    if (tailStart < lineEnd) {
      segments.push(...splitRange(text, tailStart, lineEnd, NARRATOR_ROLE, startOffset));
      const mentioned = findMentionedKnownName(tail, knownNames);
      if (mentioned) pendingNarrativeSpeaker = mentioned;
    }
  }

  return segments.length ? segments : splitSpeechSegments(text, startOffset).map((segment) => ({ ...segment, speaker: NARRATOR_ROLE }));
}
