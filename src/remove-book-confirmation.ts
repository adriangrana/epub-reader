let pendingRemoveButton: HTMLButtonElement | null = null;
let backdrop: HTMLDivElement | null = null;

function closeRemoveConfirmation() {
  backdrop?.remove();
  backdrop = null;
  pendingRemoveButton = null;
}

function currentBookTitle(button: HTMLButtonElement) {
  const shell = button.closest('.book-detail-shell');
  return shell?.querySelector<HTMLElement>('.detail-content h1')?.textContent?.trim() || 'este libro';
}

function showRemoveConfirmation(button: HTMLButtonElement) {
  closeRemoveConfirmation();
  pendingRemoveButton = button;

  const title = currentBookTitle(button);
  const layer = document.createElement('div');
  layer.className = 'remove-book-backdrop';
  layer.innerHTML = `
    <section class="remove-book-modal" role="dialog" aria-modal="true" aria-labelledby="remove-book-title">
      <button type="button" class="remove-book-close" aria-label="Cerrar">×</button>
      <span class="remove-book-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 6h18"></path>
          <path d="M8 6V4h8v2"></path>
          <path d="M19 6l-1 14H6L5 6"></path>
          <path d="M10 11v5"></path>
          <path d="M14 11v5"></path>
        </svg>
      </span>
      <span class="remove-book-eyebrow">CONFIRMACIÓN NECESARIA</span>
      <h2 id="remove-book-title">¿Quitar «${escapeHtml(title)}» de tu biblioteca?</h2>
      <p>Esta acción quitará el libro de tu biblioteca personal. No es lo mismo que una purga administrativa, pero puede tener consecuencias si eres la última referencia del libro.</p>
      <div class="remove-book-warning">
        <strong>Antes de continuar</strong>
        <span>Si ningún otro usuario lo conserva en su biblioteca ni quedan comparticiones activas, Luma puede eliminar el asset almacenado y el progreso asociado a ese book ID.</span>
      </div>
      <div class="remove-book-actions">
        <button type="button" class="remove-book-cancel">Cancelar</button>
        <button type="button" class="remove-book-confirm">Quitar de mi biblioteca</button>
      </div>
    </section>
  `;

  backdrop = layer;
  document.body.appendChild(layer);

  layer.addEventListener('mousedown', (event) => {
    if (event.target === layer) closeRemoveConfirmation();
  });

  layer.querySelector<HTMLButtonElement>('.remove-book-close')?.addEventListener('click', closeRemoveConfirmation);
  layer.querySelector<HTMLButtonElement>('.remove-book-cancel')?.addEventListener('click', closeRemoveConfirmation);
  layer.querySelector<HTMLButtonElement>('.remove-book-confirm')?.addEventListener('click', () => {
    const target = pendingRemoveButton;
    if (!target || !target.isConnected) {
      closeRemoveConfirmation();
      return;
    }

    target.dataset.lumaRemoveConfirmed = 'true';
    closeRemoveConfirmation();
    target.click();
  });

  layer.querySelector<HTMLButtonElement>('.remove-book-cancel')?.focus();
}

function escapeHtml(value: string) {
  return value.replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;',
  })[character] || character);
}

document.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;

  const button = target.closest<HTMLButtonElement>('.detail-library-actions button.danger');
  if (!button) return;

  if (button.dataset.lumaRemoveConfirmed === 'true') {
    delete button.dataset.lumaRemoveConfirmed;
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  showRemoveConfirmation(button);
}, true);

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && backdrop) closeRemoveConfirmation();
});

export {};
