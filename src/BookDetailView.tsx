import { ChangeEvent, useEffect, useRef, useState } from 'react';
import {
  ArrowLeft, BookOpen, Check, Download, FilePenLine, FileText, Globe2, LoaderCircle,
  LockKeyhole, Pencil, Plus, RefreshCw, Save, Share2, Trash2, UserPlus, X,
} from 'lucide-react';
import {
  coverUrl, downloadUrl, LibraryBook, replaceBookEpub, updateBookCover,
  updateBookDescription, updateProgress,
} from './api';
import { readEpubMetadata } from './epubMetadata';

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

const editorStyle = {
  width: '100%',
  minHeight: 132,
  marginTop: 12,
  padding: '12px 14px',
  border: '1px solid rgba(255, 255, 255, .09)',
  borderRadius: 12,
  resize: 'vertical' as const,
  color: '#d7dbea',
  background: 'rgba(255, 255, 255, .025)',
  font: 'inherit',
  lineHeight: 1.65,
  outline: 'none',
};

export default function BookDetailView({
  book, context, onBack, onRead, onAdd, onAccept, onVisibility, onShare, onRemove,
}: Props) {
  const [currentBook, setCurrentBook] = useState(book);
  const [editingDescription, setEditingDescription] = useState(false);
  const [descriptionDraft, setDescriptionDraft] = useState(book.description ?? '');
  const [busyAction, setBusyAction] = useState<'description' | 'epub' | 'restart' | null>(null);
  const [localError, setLocalError] = useState('');
  const [localNotice, setLocalNotice] = useState('');
  const epubInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setCurrentBook(book);
    setDescriptionDraft(book.description ?? '');
    setEditingDescription(false);
    setLocalError('');
    setLocalNotice('');
  }, [book]);

  const replaceLocalBook = (next: LibraryBook) => {
    // Keep the parent library object coherent without forcing a full reload.
    Object.assign(book, next);
    setCurrentBook({ ...next });
  };

  const image = coverUrl(currentBook);
  const percent = Math.max(0, Math.min(100, Math.round((currentBook.progress ?? 0) * 100)));
  const isFinished = percent >= 100;
  const hasProgress = percent >= 1 && !isFinished;
  const status = isFinished ? 'Leído' : hasProgress ? 'En lectura' : 'Sin comenzar';
  const readLabel = isFinished ? 'Volver a leer' : hasProgress ? 'Continuar leyendo' : 'Empezar a leer';
  const canEdit = context === 'library' && Boolean(currentBook.canEdit);

  const saveDescription = async () => {
    setBusyAction('description');
    setLocalError('');
    setLocalNotice('');
    try {
      const updated = await updateBookDescription(currentBook.id, descriptionDraft.trim());
      replaceLocalBook(updated);
      setDescriptionDraft(updated.description ?? '');
      setEditingDescription(false);
      setLocalNotice('Descripción actualizada.');
    } catch (cause) {
      setLocalError(cause instanceof Error ? cause.message : 'No se pudo actualizar la descripción.');
    } finally {
      setBusyAction(null);
    }
  };

  const updateEpub = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.epub')) {
      setLocalError('Selecciona un archivo EPUB.');
      return;
    }

    setBusyAction('epub');
    setLocalError('');
    setLocalNotice('');
    try {
      const metadata = await readEpubMetadata(file);
      const updated = await replaceBookEpub(currentBook.id, file);
      if (metadata.cover) {
        await updateBookCover(currentBook.id, metadata.cover);
        updated.hasCover = true;
      }
      replaceLocalBook(updated);
      setLocalNotice('EPUB actualizado correctamente.');
    } catch (cause) {
      setLocalError(cause instanceof Error ? cause.message : 'No se pudo actualizar el EPUB.');
    } finally {
      setBusyAction(null);
    }
  };

  const startReading = async () => {
    if (!isFinished) {
      onRead(currentBook);
      return;
    }

    setBusyAction('restart');
    setLocalError('');
    try {
      await updateProgress(currentBook.id, '', 0);
      const restarted: LibraryBook = {
        ...currentBook,
        progress: 0,
        cfi: undefined,
        lastOpenedAt: undefined,
      };
      replaceLocalBook(restarted);
      onRead(restarted);
    } catch (cause) {
      setLocalError(cause instanceof Error ? cause.message : 'No se pudo reiniciar la lectura.');
      setBusyAction(null);
    }
  };

  return (
    <section className="book-detail-shell">
      <button className="detail-back" onClick={onBack}><ArrowLeft /> Volver</button>

      <div className="book-detail-card">
        <div className="detail-cover-column">
          <div className="detail-cover">
            {image ? <img src={image} alt={`Portada de ${currentBook.title}`} /> : (
              <div className="detail-cover-fallback"><BookOpen /><strong>{currentBook.title}</strong><span>{currentBook.author}</span></div>
            )}
          </div>
        </div>

        <div className="detail-content">
          <div className="detail-kicker">
            {context === 'library' && <span className={`detail-badge ${currentBook.visibility}`}>
              {currentBook.visibility === 'public' ? <Globe2 /> : <LockKeyhole />}
              {currentBook.visibility === 'public' ? 'Público' : 'Privado'}
            </span>}
            {context === 'public' && <span className="detail-badge public"><Globe2 /> Biblioteca pública</span>}
            {context === 'shared' && <span className="detail-badge shared"><Share2 /> Compartido contigo</span>}
          </div>

          <h1>{currentBook.title}</h1>
          <p className="detail-author">{currentBook.author}</p>

          {(currentBook.publishedBy || currentBook.sharedBy) && (
            <p className="detail-origin">
              {currentBook.publishedBy ? `Publicado por ${currentBook.publishedBy}` : `Compartido por ${currentBook.sharedBy}`}
            </p>
          )}

          <div className="detail-progress-block">
            <div className="detail-progress-copy"><span>Progreso de lectura</span><strong>{percent}%</strong></div>
            <div className="detail-progress-track"><i style={{ width: `${percent}%` }} /></div>
          </div>

          <div className="detail-description">
            <div className="detail-section-title">
              <FileText /><span>Descripción</span>
              {canEdit && !editingDescription && (
                <button
                  type="button"
                  onClick={() => { setDescriptionDraft(currentBook.description ?? ''); setEditingDescription(true); setLocalError(''); }}
                  title="Editar descripción"
                  style={{ marginLeft: 6, border: 0, color: '#9487db', background: 'transparent', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10 }}
                >
                  <Pencil size={13} /> Editar
                </button>
              )}
            </div>

            {editingDescription ? (
              <>
                <textarea
                  value={descriptionDraft}
                  onChange={(event) => setDescriptionDraft(event.target.value.slice(0, 5000))}
                  maxLength={5000}
                  style={editorStyle}
                  autoFocus
                />
                <div className="detail-library-actions" style={{ marginTop: 8 }}>
                  <button type="button" onClick={() => void saveDescription()} disabled={busyAction !== null}>
                    {busyAction === 'description' ? <LoaderCircle className="spin" /> : <Save />} Guardar
                  </button>
                  <button type="button" onClick={() => { setEditingDescription(false); setDescriptionDraft(currentBook.description ?? ''); }} disabled={busyAction !== null}>
                    <X /> Cancelar
                  </button>
                  <span style={{ marginLeft: 'auto', alignSelf: 'center', color: '#68738d', fontSize: 9 }}>{descriptionDraft.length}/5000</span>
                </div>
              </>
            ) : (
              <p>{currentBook.description?.trim() || 'Este libro todavía no tiene una descripción.'}</p>
            )}
          </div>

          <div className="detail-meta-grid">
            <div><span>Archivo</span><strong>{currentBook.fileName}</strong></div>
            <div><span>Estado</span><strong>{status}</strong></div>
          </div>

          {localNotice && <p style={{ margin: '14px 0 0', color: '#86d9c9', fontSize: 11 }}>{localNotice}</p>}
          {localError && <p style={{ margin: '14px 0 0', color: '#ff9eb1', fontSize: 11 }}>{localError}</p>}

          <div className="detail-primary-actions">
            <button className="primary-button detail-read" onClick={() => void startReading()} disabled={busyAction !== null}>
              {busyAction === 'restart' ? <LoaderCircle className="spin" /> : <BookOpen />} {readLabel}
            </button>

            {context === 'public' && !currentBook.inLibrary && (
              <button className="detail-secondary-action" onClick={() => onAdd?.(currentBook)}><Plus /> Añadir a mi biblioteca</button>
            )}
            {context === 'public' && currentBook.inLibrary && (
              <span className="detail-in-library"><Check /> Ya está en tu biblioteca</span>
            )}
            {context === 'shared' && (
              <button className="detail-secondary-action" onClick={() => onAccept?.(currentBook)}><UserPlus /> Añadir a mi biblioteca</button>
            )}
          </div>

          {context === 'library' && (
            <div className="detail-library-actions">
              <button onClick={() => onVisibility?.(currentBook)}>
                {currentBook.visibility === 'public' ? <LockKeyhole /> : <Globe2 />}
                {currentBook.visibility === 'public' ? 'Hacer privado' : 'Hacer público'}
              </button>
              <button onClick={() => onShare?.(currentBook)}><Share2 /> Compartir</button>
              <a href={downloadUrl(currentBook.id)}><Download /> Descargar EPUB</a>
              {canEdit && <>
                <button onClick={() => setEditingDescription(true)} disabled={busyAction !== null}><FilePenLine /> Editar descripción</button>
                <button onClick={() => epubInputRef.current?.click()} disabled={busyAction !== null}>
                  {busyAction === 'epub' ? <LoaderCircle className="spin" /> : <RefreshCw />} Actualizar EPUB
                </button>
                <input ref={epubInputRef} type="file" accept=".epub,application/epub+zip" hidden onChange={updateEpub} />
              </>}
              <button className="danger" onClick={() => onRemove?.(currentBook)}><Trash2 /> Quitar de mi biblioteca</button>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
