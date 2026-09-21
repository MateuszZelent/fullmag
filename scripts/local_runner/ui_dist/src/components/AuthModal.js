import { state } from '../state.js';
import { api } from '../api.js';

export function renderAuthModal(container) {
  if (!state.showAuthModal) {
    container.innerHTML = '';
    return;
  }

  container.innerHTML = `
    <div class="modal-backdrop">
      <div class="modal-card modal-sm">
        <div class="modal-header">
          <div>
            <h2 class="modal-title">Połącz z runnerem</h2>
            <span class="modal-subtitle">Wprowadź lokalny token bearer koordynatora</span>
          </div>
        </div>

        <form id="auth-form" class="modal-body">
          <div class="form-group">
            <label class="form-label">Token autoryzacyjny (Bearer Token):</label>
            <input type="password" id="auth-token-input" class="form-input font-mono" placeholder="Wklej token z control/config.json..." required autofocus />
            <span class="form-hint">
              Token znajduje się w lokalnym storage hosta w pliku <code>index/local-runner-container-secret.json</code> lub <code>control/config.json</code>.
            </span>
          </div>
          <div id="auth-error-msg" class="error-box" style="display: none;"></div>
          <div class="modal-footer" style="padding: 1rem 0 0 0;">
            <button type="submit" class="btn btn-primary" id="btn-auth-submit">Połącz i zapisz sesję</button>
          </div>
        </form>
      </div>
    </div>
  `;

  const form = container.querySelector('#auth-form');
  const input = container.querySelector('#auth-token-input');
  const errorBox = container.querySelector('#auth-error-msg');

  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const token = input?.value?.trim();
    if (!token) return;

    errorBox.style.display = 'none';
    try {
      await api.login(token);
      state.showAuthModal = false;
      state.refresh();
    } catch (err) {
      errorBox.textContent = 'Nieprawidłowy token autoryzacyjny lub błąd połączenia.';
      errorBox.style.display = 'block';
    }
  });
}
