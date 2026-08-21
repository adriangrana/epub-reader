const CHUNK_SIZE = 1700;

export function splitForSpeech(text: string): string[] {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return [];

  const sentences = normalized.match(/[^.!?…]+[.!?…]+|[^.!?…]+$/g) ?? [normalized];
  const chunks: string[] = [];
  let current = '';

  for (const sentence of sentences) {
    if ((current + sentence).length <= CHUNK_SIZE) {
      current += sentence;
      continue;
    }
    if (current.trim()) chunks.push(current.trim());
    if (sentence.length <= CHUNK_SIZE) {
      current = sentence;
      continue;
    }
    for (let i = 0; i < sentence.length; i += CHUNK_SIZE) {
      chunks.push(sentence.slice(i, i + CHUNK_SIZE).trim());
    }
    current = '';
  }

  if (current.trim()) chunks.push(current.trim());
  return chunks.filter(Boolean);
}
