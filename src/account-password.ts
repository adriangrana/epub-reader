export {};

const ACCOUNT_CARD_SELECTOR = '.account-card';
const CHANGE_BUTTON_CLASS = 'account-password-button';
const MODAL_ID = 'luma-password-modal';

function iconKey() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  circle.setAttribute('cx', '7.5');
  circle.setAttribute('cy', '15.5');
  circle.setAttribute('r', '5.5');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'm21 2-9.6 9.6M15.5 7.5l2 2L20 7l-2-2');
  svg.append(circle, path);
  return svg;
}

function closePasswordModal() {
  document.getElementById(MODAL_ID)?.remove();
}

function makePasswordField(labelText: string, name: string, autoComplete: string) {
  const label = document.createElement('label');
  label.textContent = labelText;
  const input = document.createElement('input');
  input.type = 'password';
  input.name = name;
  input.required = true;
  input.minLength = 8;
  input.setAttribute('autocomplete', autoComplete);
  label.append(input);
  return { label, input };
}

function openPasswordModal() {
  if (document.getElementById(MODAL_ID)) return;

  const backdrop = document.createElement('div');
  backdrop.id = MODAL_ID;
  backdrop.className = 'modal-backdrop account-password-backdrop';

  const form = document.createElement('form');
  form.className = 'share-modal account-password-modal';

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'modal-close';
  close.setAttribute('aria-label', 'Cerrar');
  close.textContent = '×';
  close.addEventListener('click', closePasswordModal);

  const icon = document.createElement('span');
  icon.className = 'modal-icon';
  icon.append(iconKey());

  const eyebrow = document.createElement('span');
  eyebrow.className = 'eyebrow';
  eyebrow.textContent = 'SEGURIDAD DE LA CUENTA';

  const title = document.createElement('h2');
  title.textContent = 'Cambiar contraseña';

  const description = document.createElement('p');
  description.textContent = 'Confirma tu contraseña actual y elige una nueva. Al guardarla, Luma cerrará las demás sesiones abiertas de tu cuenta.';

  const current = makePasswordField('Contraseña actual', 'currentPassword', 'current-password');
  const next = makePasswordField('Nueva contraseña', 'newPassword', 'new-password');
  const confirm = makePasswordField('Repite la nueva contraseña', 'confirmPassword', 'new-password');

  const message = document.createElement('p');
  message.className = 'account-password-message';
  message.hidden = true;

  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.className = 'primary-button';
  submit.textContent = 'Guardar nueva contraseña';

  form.append(close, icon, eyebrow, title, description, current.label, next.label, confirm.label, message, submit);
  backdrop.append(form);
  document.body.append(backdrop);

  current.input.focus();

  backdrop.addEventListener('mousedown', (event) => {
    if (event.target === backdrop) closePasswordModal();
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    message.hidden = true;
    message.className = 'account-password-message';

    if (next.input.value !== confirm.input.value) {
      message.textContent = 'Las dos contraseñas nuevas no coinciden.';
      message.classList.add('error');
      message.hidden = false;
      return;
    }

    if (next.input.value.length < 8) {
      message.textContent = 'La nueva contraseña debe tener al menos 8 caracteres.';
      message.classList.add('error');
      message.hidden = false;
      return;
    }

    submit.disabled = true;
    submit.textContent = 'Guardando…';

    try {
      const response = await fetch('/api/auth/password', {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          currentPassword: current.input.value,
          newPassword: next.input.value,
        }),
      });

      if (!response.ok) {
        let errorText = `Error ${response.status}`;
        try {
          const body = await response.json() as { error?: string };
          errorText = body.error || errorText;
        } catch { /* status fallback */ }
        throw new Error(errorText);
      }

      current.input.value = '';
      next.input.value = '';
      confirm.input.value = '';
      message.textContent = 'Contraseña actualizada. Tu sesión actual continúa abierta y las demás se han cerrado.';
      message.classList.add('success');
      message.hidden = false;
      submit.textContent = 'Contraseña guardada';
      window.setTimeout(closePasswordModal, 1800);
    } catch (cause) {
      message.textContent = cause instanceof Error ? cause.message : 'No se pudo cambiar la contraseña.';
      message.classList.add('error');
      message.hidden = false;
      submit.disabled = false;
      submit.textContent = 'Guardar nueva contraseña';
    }
  });
}

function installAccountPasswordButton() {
  const card = document.querySelector<HTMLElement>(ACCOUNT_CARD_SELECTOR);
  if (!card || card.querySelector(`.${CHANGE_BUTTON_CLASS}`)) return;

  const logout = card.querySelector<HTMLButtonElement>('button:not(.' + CHANGE_BUTTON_CLASS + ')');
  if (!logout) return;

  const button = document.createElement('button');
  button.type = 'button';
  button.className = CHANGE_BUTTON_CLASS;
  button.title = 'Cambiar contraseña';
  button.setAttribute('aria-label', 'Cambiar contraseña');
  button.append(iconKey());
  button.addEventListener('click', openPasswordModal);
  card.insertBefore(button, logout);
}

const observer = new MutationObserver(installAccountPasswordButton);
observer.observe(document.documentElement, { childList: true, subtree: true });
queueMicrotask(installAccountPasswordButton);

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && document.getElementById(MODAL_ID)) closePasswordModal();
});
