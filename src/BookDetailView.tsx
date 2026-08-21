import {
  ArrowLeft, BookOpen, Check, Download, FileText, Globe2, LockKeyhole, Plus,
  Share2, Trash2, UserPlus,
} from 'lucide-react';
import { coverUrl, downloadUrl, LibraryBook } from './api';

export type BookContext = 'library' | 'public' | 'shared';

type Props = {
  book: LibraryBook;
  context: BookContext;
  onBack: () => void;
  onRead: (book: LibraryBook) => void;
  onAdd?: (book: LibraryBook) => void;
  onAccept?: (book: LibraryBook) => void;
  onVisibility?: (book: LibraryBook) => void;
  onShare?: (book: LibraryBook) => void;
  onRemove?: (book: LibraryBook) => void;
};

export default function BookDetailView({
  book, context, onBack, onRead, onAdd, onAccept, onVisibility, onShare, onRemove,
}: Props) {
  const image = coverUrl(book);
  const percent = Math.round((book.progress ?? 0) * 100);
  const hasProgress = percent > 0;

  return (
    <section className="book-detail-shell">
      <button className="detail-back" onClick={onBack}><ArrowLeft /> Volver</button>

      <div className="book-detail-card">
        <div className="detail-cover-column">
          <div className="detail-cover">
            {image ? <img src={image} alt={`Portada de ${book.title}`} /> : (
              <div className="detail-cover-fallback"><BookOpen /><strong>{book.title}</strong><span>{book.author}</span></div>
            )}
          </div>
        </div>

        <div className="detail-content">
          <div className="detail-kicker">
            {context === 'library' && <span className={`detail-badge ${book.visibility}`}>
              {book.visibility === 'public' ? <Globe2 /> : <LockKeyhole />}
              {book.visibility === 'public' ? 'Público' : 'Privado'}
            </span>}
            {context === 'public' && <span className="detail-badge public"><Globe2 /> Biblioteca pública</span>}
            {context === 'shared' && <span className="detail-badge shared"><Share2 /> Compartido contigo</span>}
          </div>

          <h1>{book.title}</h1>
          <p className="detail-author">{book.author}</p>

          {(book.publishedBy || book.sharedBy) && (
            <p className="detail-origin">
              {book.publishedBy ? `Publicado por ${book.publishedBy}` : `Compartido por ${book.sharedBy}`}
            </p>
          )}

          <div className="detail-progress-block">
            <div className="detail-progress-copy"><span>Progreso de lectura</span><strong>{percent}%</strong></div>
            <div className="detail-progress-track"><i style={{ width: `${percent}%` }} /></div>
          </div>

          <div className="detail-description">
            <div className="detail-section-title"><FileText /><span>Descripción</span></div>
            <p>{book.description?.trim() || 'Este libro todavía no tiene una descripción.'}</p>
          </div>

          <div className="detail-meta-grid">
            <div><span>Archivo</span><strong>{book.fileName}</strong></div>
            <div><span>Estado</span><strong>{hasProgress ? 'En lectura' : 'Sin comenzar'}</strong></div>
          </div>

          <div className="detail-primary-actions">
            <button className="primary-button detail-read" onClick={() => onRead(book)}>
              <BookOpen /> {hasProgress ? 'Continuar leyendo' : 'Empezar a leer'}
            </button>

            {context === 'public' && !book.inLibrary && (
              <button className="detail-secondary-action" onClick={() => onAdd?.(book)}><Plus /> Añadir a mi biblioteca</button>
            )}
            {context === 'public' && book.inLibrary && (
              <span className="detail-in-library"><Check /> Ya está en tu biblioteca</span>
            )}
            {context === 'shared' && (
              <button className="detail-secondary-action" onClick={() => onAccept?.(book)}><UserPlus /> Añadir a mi biblioteca</button>
            )}
          </div>

          {context === 'library' && (
            <div className="detail-library-actions">
              <button onClick={() => onVisibility?.(book)}>
                {book.visibility === 'public' ? <LockKeyhole /> : <Globe2 />}
                {book.visibility === 'public' ? 'Hacer privado' : 'Hacer público'}
              </button>
              <button onClick={() => onShare?.(book)}><Share2 /> Compartir</button>
              <a href={downloadUrl(book.id)}><Download /> Descargar EPUB</a>
              <button className="danger" onClick={() => onRemove?.(book)}><Trash2 /> Quitar de mi biblioteca</button>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
