import { BookOpen, LoaderCircle, Upload, X } from 'lucide-react';

export type PendingImport = {
  file: File;
  title: string;
  author: string;
  description: string;
  cover?: string;
};

type Props = {
  items: PendingImport[];
  busy: boolean;
  onChange: (index: number, patch: Partial<Pick<PendingImport, 'title' | 'author' | 'description'>>) => void;
  onCancel: () => void;
  onSubmit: () => void;
};

export default function ImportBooksModal({ items, busy, onChange, onCancel, onSubmit }: Props) {
  return (
    <div className="modal-backdrop import-backdrop" onMouseDown={(event) => {
      if (!busy && event.currentTarget === event.target) onCancel();
    }}>
      <section className="import-modal" role="dialog" aria-modal="true" aria-labelledby="import-title">
        <button className="modal-close" onClick={onCancel} disabled={busy} aria-label="Cerrar"><X /></button>
        <span className="modal-icon"><Upload /></span>
        <span className="eyebrow">AÑADIR A TU BIBLIOTECA</span>
        <h2 id="import-title">Completa los datos del libro</h2>
        <p className="import-intro">Luma ha leído la metadata del EPUB. Puedes corregir título y autor y añadir una descripción en Markdown antes de guardarlo.</p>

        <div className="import-list">
          {items.map((item, index) => (
            <article className="import-book" key={`${item.file.name}-${index}`}>
              <div className="import-preview">
                {item.cover ? <img src={item.cover} alt="" /> : <BookOpen />}
              </div>
              <div className="import-fields">
                <span className="import-file-name">{item.file.name}</span>
                <div className="import-two-columns">
                  <label>Título<input value={item.title} onChange={(event) => onChange(index, { title: event.target.value })} required /></label>
                  <label>Autor<input value={item.author} onChange={(event) => onChange(index, { author: event.target.value })} required /></label>
                </div>
                <label>Descripción (Markdown)
                  <textarea
                    value={item.description}
                    onChange={(event) => onChange(index, { description: event.target.value })}
                    placeholder={'Ej. **Una historia olvidada.**\n\n> Algunas puertas no deberían abrirse.'}
                    maxLength={5000}
                    rows={4}
                  />
                </label>
                <small>{item.description.length}/5000</small>
              </div>
            </article>
          ))}
        </div>

        <div className="import-actions">
          <button className="detail-secondary-action" onClick={onCancel} disabled={busy}>Cancelar</button>
          <button className="primary-button" onClick={onSubmit} disabled={busy || items.some((item) => !item.title.trim() || !item.author.trim())}>
            {busy ? <LoaderCircle className="spin" /> : <Upload />}
            {items.length === 1 ? 'Guardar libro' : `Guardar ${items.length} libros`}
          </button>
        </div>
      </section>
    </div>
  );
}
