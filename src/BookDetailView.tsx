import { ChangeEvent, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle, ArrowLeft, BookOpen, Check, Download, FilePenLine, FileText, Globe2,
  LoaderCircle, LockKeyhole, Pencil, Plus, RefreshCw, RotateCcw, Save, Share2,
  ShieldCheck, Trash2, UserPlus, X,
} from 'lucide-react';
import {
  coverUrl, downloadUrl, LibraryBook, updateBookCover, updateBookMetadata, updateProgress,
} from './api';
import { readEpubMetadata } from './epubMetadata';
import { replaceEpubWithProgressPolicy } from './replaceEpub';
import MarkdownText from './MarkdownText';

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
  marginTop: 7,
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

const editorInputStyle = {
  width: '100%',
  height: 43,
  marginTop: 7,
  padding: '0 13px',
  border: '1px solid rgba(255, 255, 255, .09)',
  borderRadius: 11,
  color: '#e7eaf4',
  background: 'rgba(255, 255, 255, .025)',
  font: 'inherit',
  outline: 'none',
};

export default function BookDetailView({
  book, context, onBack, onRead, onAdd, onAccept, onVisibility, onShare, onRemove,
}: Props) {
  const [currentBook, setCurrentBook] = useState(book);
  const [editingMetadata, setEditingMetadata] = useState(false);
  const [titleDraft, setTitleDraft] = useState(book.title);
  const [authorDraft, setAuthorDraft] = useState(book.author);
  const [descriptionDraft, setDescriptionDraft] = useState(book.description ?? '');
  const [busyAction, setBusyAction] = useState<'metadata' | 'epub' | 'restart' | null>(null);
  const [localError, setLocalError] = useState('');
  const [localNotice, setLocalNotice] = useState('');
  const [pendingEpub, setPendingEpub] = useState<File | null>(null);
  const [preserveProgress, setPreserveProgress] = useState(true);
  const epubInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setCurrentBook(book);
    setTitleDraft(book.title);
    setAuthorDraft(book.author);
    setDescriptionDraft(book.description ?? '');
    setEditingMetadata(false);
    setPendingEpub(null);
    setPreserveProgress(true);
    setLocalError('');
    setLocalNotice('');
  }, [book]);

  const replaceLocalBook = (next: LibraryBook) => {
    Object.assign(book, next);
    setCurrentBook({ ...next });
  };

  const beginEditing = () => {
    setTitleDraft(currentBook.title);
    setAuthorDraft(currentBook.author);
    setDescriptionDraft(currentBook.description ?? '');
    setEditingMetadata(true);
    setLocalError('');
    setLocalNotice('');
  };

  const cancelEditing = () => {
    setTitleDraft(currentBook.title);
    setAuthorDraft(currentBook.author);
    setDescriptionDraft(currentBook.description ?? '');
    setEditingMetadata(false);
    setLocalError('');
  };

  const image = coverUrl(currentBook);
  const progress = Math.max(0, Math.min(1, Number(currentBook.progress ?? 0)));
  const isFinished = progress >= .999;
  const hasProgress = progress >= .01 && !isFinished;
  const percent = isFinished ? 100 : Math.min(99, Math.round(progress * 100));
  const status = isFinished ? 'Completado' : hasProgress ? 'En lectura' : 'Sin comenzar';
  const readLabel = isFinished ? 'Leer de nuevo' : hasProgress ? 'Continuar leyendo' : 'Empezar a leer';
  const canEdit = context === 'library' && Boolean(currentBook.canEdit);

  const saveMetadata = async () => {
    const title = titleDraft.trim();
    const author = authorDraft.trim();
    if (!title) {
      setLocalError('El título no puede quedar vacío.');
      return;
    }
    if (!author) {
      setLocalError('El autor no puede quedar vacío.');
      return;
    }

    setBusyAction('metadata');
    setLocalError('');
    setLocalNotice('');
    try {
      const updated = await updateBookMetadata(currentBook.id, {
        title,
        author,
        description: descriptionDraft.trim(),
      });
      replaceLocalBook(updated);
      setTitleDraft(updated.title);
      setAuthorDraft(updated.author);
      setDescriptionDraft(updated.description ?? '');
      setEditingMetadata(false);
      setLocalNotice('Datos del libro actualizados.');
    } catch (cause) {
      setLocalError(cause instanceof Error ? cause.message : 'No se pudieron actualizar los datos del libro.');
    } finally {
      setBusyAction(null);
    }
  };

  const updateEpub = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.epub')) {
      setLocalError('Selecciona un archivo EPUB.');
      return;
    }

    setLocalError('');
    setLocalNotice('');
    setPreserveProgress(true);
    setPendingEpub(file);
  };

  const confirmEpubUpdate = async () => {
    const file = pendingEpub;
    if (!file) return;

    setBusyAction('epub');
    setLocalError('');
    setLocalNotice('');
    try {
      const metadata = await readEpubMetadata(file);
      const updated = await replaceEpubWithProgressPolicy(currentBook.id, file, preserveProgress);
      if (metadata.cover) {
        await updateBookCover(currentBook.id, metadata.cover);
        updated.hasCover = true;
      }
      replaceLocalBook(updated);
      setPendingEpub(null);
      setLocalNotice(preserveProgress
        ? 'EPUB actualizado. Se conservaron los porcentajes de lectura y Luma reconstruirá una posición aproximada en la nueva versión.'
        : 'EPUB actualizado. Se reinició el progreso de lectura de todos los lectores.');
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
              <FileText /><span>{editingMetadata ? 'Editar datos del libro' : 'Descripción'}</span>
              {canEdit && !editingMetadata && (
                <button
                  type="button"
                  onClick={beginEditing}
                  title="Editar título, autor y descripción"
                  style={{ marginLeft: 6, border: 0, color: '#9487db', background: 'transparent', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10 }}
                >
                  <Pencil size={13} /> Editar datos
                </button>
              )}
            </div>

            {editingMetadata ? (
              <div style={{ marginTop: 13, display: 'grid', gap: 12 }}>
                <label style={{ color: '#8d97b1', fontSize: 10, fontWeight: 600 }}>
                  Título
                  <input
                    value={titleDraft}
                    onChange={(event) => setTitleDraft(event.target.value.slice(0, 300))}
                    maxLength={300}
                    style={editorInputStyle}
                    autoFocus
                  />
                </label>
                <label style={{ color: '#8d97b1', fontSize: 10, fontWeight: 600 }}>
                  Autor
                  <input
                    value={authorDraft}
                    onChange={(event) => setAuthorDraft(event.target.value.slice(0, 300))}
                    maxLength={300}
                    style={editorInputStyle}
                    placeholder="Ej. Adrian T. Graña"
                  />
                </label>
                <label style={{ color: '#8d97b1', fontSize: 10, fontWeight: 600 }}>
                  Descripción (admite Markdown)
                  <textarea
                    value={descriptionDraft}
                    onChange={(event) => setDescriptionDraft(event.target.value.slice(0, 5000))}
                    maxLength={5000}
                    style={editorStyle}
                    placeholder={'Ej. **Una historia olvidada.**\n\n> Algunas puertas no deberían abrirse.'}
                  />
                </label>
                <div className="detail-library-actions" style={{ marginTop: 0 }}>
                  <button type="button" onClick={() => void saveMetadata()} disabled={busyAction !== null}>
                    {busyAction === 'metadata' ? <LoaderCircle className="spin" /> : <Save />} Guardar cambios
                  </button>
                  <button type="button" onClick={cancelEditing} disabled={busyAction !== null}>
                    <X /> Cancelar
                  </button>
                  <span style={{ marginLeft: 'auto', alignSelf: 'center', color: '#68738d', fontSize: 9 }}>{descriptionDraft.length}/5000</span>
                </div>
              </div>
            ) : currentBook.description?.trim() ? (
              <MarkdownText text={currentBook.description} />
            ) : (
              <p>Este libro todavía no tiene una descripción.</p>
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
                <button onClick={beginEditing} disabled={busyAction !== null}><FilePenLine /> Editar datos</button>
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

      {pendingEpub && <div className="modal-backdrop epub-replace-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target && busyAction !== 'epub') setPendingEpub(null); }}>
        <section className="epub-replace-modal" role="dialog" aria-modal="true" aria-labelledby="epub-replace-title">
          <button type="button" className="modal-close" onClick={() => setPendingEpub(null)} disabled={busyAction === 'epub'} aria-label="Cerrar"><X /></button>
          <span className="epub-replace-icon"><RefreshCw /></span>
          <span className="eyebrow">NUEVA VERSIÓN DEL EPUB</span>
          <h2 id="epub-replace-title">Actualizar «{currentBook.title}»</h2>
          <p className="epub-replace-intro">El libro, su visibilidad y sus comparticiones se conservarán. Decide qué debe ocurrir con el progreso de quienes ya lo están leyendo.</p>

          <div className="epub-file-chip"><FileText /><span>{pendingEpub.name}</span></div>

          <div className="epub-progress-options">
            <label className={`epub-progress-option ${preserveProgress ? 'selected' : ''}`}>
              <input type="radio" name="progress-policy" checked={preserveProgress} onChange={() => setPreserveProgress(true)} disabled={busyAction === 'epub'} />
              <span className="epub-option-icon safe"><ShieldCheck /></span>
              <span className="epub-option-copy">
                <strong>Mantener progreso de lectura</strong>
                <small>Conserva el porcentaje de cada lector. Luma descarta las posiciones internas antiguas y reconstruye una posición aproximada en el EPUB nuevo.</small>
                <em><AlertTriangle /> Si el contenido cambió mucho, el mismo porcentaje puede corresponder a otra parte del texto. Úsalo bajo tu responsabilidad.</em>
              </span>
            </label>

            <label className={`epub-progress-option ${!preserveProgress ? 'selected danger' : ''}`}>
              <input type="radio" name="progress-policy" checked={!preserveProgress} onChange={() => setPreserveProgress(false)} disabled={busyAction === 'epub'} />
              <span className="epub-option-icon reset"><RotateCcw /></span>
              <span className="epub-option-copy">
                <strong>Reiniciar progreso de todos</strong>
                <small>Todos los lectores volverán al 0 %. Esta opción es más segura si cambiaste capítulos, orden o estructura de forma importante.</small>
              </span>
            </label>
          </div>

          <div className="epub-replace-actions">
            <button type="button" className="epub-cancel-button" onClick={() => setPendingEpub(null)} disabled={busyAction === 'epub'}>Cancelar</button>
            <button type="button" className="primary-button" onClick={() => void confirmEpubUpdate()} disabled={busyAction === 'epub'}>
              {busyAction === 'epub' ? <LoaderCircle className="spin" /> : <RefreshCw />} Actualizar EPUB
            </button>
          </div>
        </section>
      </div>}
    </section>
  );
}
