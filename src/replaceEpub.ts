import type { LibraryBook } from './api';

type ApiErrorBody = { error?: string };

export async function replaceEpubWithProgressPolicy(
  bookId: string,
  file: File,
  preserveProgress: boolean,
): Promise<LibraryBook> {
  const params = new URLSearchParams({
    fileName: file.name,
    preserveProgress: preserveProgress ? '1' : '0',
  });

  const response = await fetch(`/api/books/${encodeURIComponent(bookId)}/file?${params}`, {
    method: 'PUT',
    credentials: 'include',
    body: file,
    headers: { 'Content-Type': 'application/epub+zip' },
  });

  if (!response.ok) {
    let message = `Error ${response.status}`;
    try {
      const body = await response.json() as ApiErrorBody;
      if (body.error) message = body.error;
    } catch { /* use status fallback */ }
    throw new Error(message);
  }

  return (await response.json() as { book: LibraryBook }).book;
}
