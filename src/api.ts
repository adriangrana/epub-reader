export type User = {
  id: string;
  name: string;
  email: string;
};

export type LibraryBook = {
  id: string;
  title: string;
  author: string;
  description: string;
  fileName: string;
  hasCover: boolean;
  visibility: 'private' | 'public';
  progress: number;
  cfi?: string;
  lastOpenedAt?: number;
  publishedBy?: string;
  inLibrary?: boolean;
  shareId?: string;
  sharedBy?: string;
  sharedByEmail?: string;
  canEdit?: boolean;
};

type ApiErrorBody = { error?: string };

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    credentials: 'include',
    ...init,
    headers: {
      ...(init?.body && !(init.body instanceof Blob) && !(init.body instanceof File) ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  });

  if (!response.ok) {
    let message = `Error ${response.status}`;
    try {
      const body = await response.json() as ApiErrorBody;
      if (body.error) message = body.error;
    } catch { /* use status fallback */ }
    const error = new Error(message) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }

  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export async function getCurrentUser(): Promise<User | null> {
  try {
    const result = await request<{ user: User }>('/api/auth/me');
    return result.user;
  } catch (error) {
    if ((error as Error & { status?: number }).status === 401) return null;
    throw error;
  }
}

export async function register(name: string, email: string, password: string): Promise<User> {
  const result = await request<{ user: User }>('/api/auth/register', { method: 'POST', body: JSON.stringify({ name, email, password }) });
  return result.user;
}

export async function login(email: string, password: string): Promise<User> {
  const result = await request<{ user: User }>('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
  return result.user;
}

export async function logout(): Promise<void> {
  await request<{ ok: true }>('/api/auth/logout', { method: 'POST' });
}

export async function getLibrary(): Promise<LibraryBook[]> {
  return (await request<{ books: LibraryBook[] }>('/api/library')).books;
}

export async function getPublicBooks(query = ''): Promise<LibraryBook[]> {
  const params = new URLSearchParams();
  if (query.trim()) params.set('q', query.trim());
  const suffix = params.size ? `?${params}` : '';
  return (await request<{ books: LibraryBook[] }>(`/api/public${suffix}`)).books;
}

export async function getShares(): Promise<LibraryBook[]> {
  return (await request<{ books: LibraryBook[] }>('/api/shares')).books;
}

export async function uploadBook(file: File, metadata: { title: string; author: string; description?: string; cover?: string }): Promise<LibraryBook> {
  const params = new URLSearchParams({
    title: metadata.title,
    author: metadata.author,
    description: metadata.description ?? '',
    fileName: file.name,
  });
  const response = await request<{ book: LibraryBook }>(`/api/library/upload?${params}`, {
    method: 'POST',
    body: file,
    headers: { 'Content-Type': 'application/epub+zip' },
  });

  if (metadata.cover && !response.book.hasCover) {
    await updateBookCover(response.book.id, metadata.cover);
    response.book.hasCover = true;
  }

  return response.book;
}

export async function setBookVisibility(bookId: string, visibility: 'private' | 'public'): Promise<LibraryBook> {
  return (await request<{ book: LibraryBook }>(`/api/library/${encodeURIComponent(bookId)}/visibility`, {
    method: 'PATCH', body: JSON.stringify({ visibility }),
  })).book;
}

export async function updateBookDescription(bookId: string, description: string): Promise<LibraryBook> {
  return (await request<{ book: LibraryBook }>(`/api/library/${encodeURIComponent(bookId)}/metadata`, {
    method: 'PATCH', body: JSON.stringify({ description }),
  })).book;
}

export async function replaceBookEpub(bookId: string, file: File): Promise<LibraryBook> {
  const params = new URLSearchParams({ fileName: file.name });
  return (await request<{ book: LibraryBook }>(`/api/library/${encodeURIComponent(bookId)}/file?${params}`, {
    method: 'PUT',
    body: file,
    headers: { 'Content-Type': 'application/epub+zip' },
  })).book;
}

export async function updateBookCover(bookId: string, cover: string): Promise<void> {
  await request<{ ok: true }>(`/api/books/${encodeURIComponent(bookId)}/cover`, {
    method: 'PUT',
    body: JSON.stringify({ cover }),
  });
}

export async function shareBook(bookId: string, email: string): Promise<{ alreadyInLibrary?: boolean; recipient?: { name: string; email: string } }> {
  return request<{ alreadyInLibrary?: boolean; recipient?: { name: string; email: string } }>(`/api/library/${encodeURIComponent(bookId)}/share`, {
    method: 'POST', body: JSON.stringify({ email }),
  });
}

export async function removeBookFromLibrary(bookId: string): Promise<void> {
  await request<{ ok: true }>(`/api/library/${encodeURIComponent(bookId)}`, { method: 'DELETE' });
}

export async function addPublicBook(bookId: string): Promise<LibraryBook> {
  return (await request<{ book: LibraryBook }>(`/api/public/${encodeURIComponent(bookId)}/add`, { method: 'POST' })).book;
}

export async function acceptShare(shareId: string): Promise<LibraryBook> {
  return (await request<{ book: LibraryBook }>(`/api/shares/${encodeURIComponent(shareId)}/accept`, { method: 'POST' })).book;
}

export async function dismissShare(shareId: string): Promise<void> {
  await request<{ ok: true }>(`/api/shares/${encodeURIComponent(shareId)}`, { method: 'DELETE' });
}

export async function updateProgress(bookId: string, cfi: string, percentage: number): Promise<void> {
  await request<{ ok: true }>(`/api/progress/${encodeURIComponent(bookId)}`, {
    method: 'PUT', body: JSON.stringify({ cfi, percentage }),
  });
}

export async function fetchBookData(bookId: string): Promise<ArrayBuffer> {
  const response = await fetch(`/api/books/${encodeURIComponent(bookId)}/file`, { credentials: 'include' });
  if (!response.ok) {
    let message = 'No se pudo descargar el EPUB.';
    try { message = (await response.json() as ApiErrorBody).error || message; } catch { /* keep fallback */ }
    throw new Error(message);
  }
  return response.arrayBuffer();
}

export function coverUrl(book: Pick<LibraryBook, 'id' | 'hasCover'>): string | undefined {
  return book.hasCover ? `/api/books/${encodeURIComponent(book.id)}/cover` : undefined;
}

export function downloadUrl(bookId: string): string {
  return `/api/books/${encodeURIComponent(bookId)}/file?download=1`;
}
