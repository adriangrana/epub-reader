import ePub from 'epubjs';

export type EpubMetadata = {
  title: string;
  author: string;
  cover?: string;
};

function toDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(blob);
  });
}

export async function readEpubMetadata(file: File): Promise<EpubMetadata> {
  const data = await file.arrayBuffer();
  const book = ePub(data);
  try {
    await book.ready;
    const metadata = await book.loaded.metadata;
    let cover: string | undefined;
    try {
      const coverUrl = await book.coverUrl();
      if (coverUrl) {
        const response = await fetch(coverUrl);
        if (response.ok) cover = await toDataUrl(await response.blob());
      }
    } catch { cover = undefined; }

    return {
      title: metadata.title?.trim() || file.name.replace(/\.epub$/i, ''),
      author: metadata.creator?.trim() || 'Autor desconocido',
      cover,
    };
  } finally {
    book.destroy();
  }
}
