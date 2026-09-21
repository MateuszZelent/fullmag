import { state } from '../state.js';
import { api } from '../api.js';
import { formatTimestamp, escapeHtml } from '../utils.js';

export function renderPoliciesView(container) {
  let currentPolicy = null;
  let isDirty = false;

  container.innerHTML = `
    <div class="view-container policies-view">
      <div class="view-header-actions">
        <div>
          <h1 class="view-title">Polityki ochrony storage i retencji</h1>
          <p class="view-subtitle">Zarządzanie regułami automatycznego planowania retencji i progami dyskowymi</p>
        </div>
        <div class="header-btns">
          <button class="btn btn-primary" id="btn-save-policy">💾 Zapisz zmiany polityki</button>
        </div>
      </div>

      <div class="section-card" id="policy-card">
        <div class="loading-spinner">Wczytywanie aktualnej polityki...</div>
      </div>
    </div>
  `;

  async function loadPolicy(isBackground = false) {
    const card = container.querySelector('#policy-card');
    if (!card) return;

    if (isBackground) {
      const activeEl = (typeof document !== 'undefined') ? document.activeElement : null;
      const formEl = card.querySelector('#policy-form');
      const isFocused = formEl && activeEl && typeof formEl.contains === 'function' && formEl.contains(activeEl);
      if (isDirty || isFocused) {
        // Do not disturb user input while editing
        return;
      }
    }

    try {
      currentPolicy = await api.getRetentionPolicy();
      state.policiesData = currentPolicy;
      isDirty = false;

      card.innerHTML = `
        <form id="policy-form" class="policy-form">
          <div class="alert-box alert-warning" style="margin-bottom: 1.5rem; padding: 0.75rem 1rem; border-left: 4px solid var(--warning); background: rgba(245, 158, 11, 0.1);">
            <strong>Tryb działania:</strong> Automatyczny harmonogram usuwania danych (Automatic Mode) jest obecnie wyłączony. Wszystkie operacje retencji działają w bezpiecznym trybie podglądu (Preview).
          </div>
          <div class="form-row">
            <div class="form-group">
              <label class="form-label">Tryb działania retencji (Execution Mode):</label>
              <select id="pol-mode" class="form-select">
                <option value="preview" selected>
                  Preview (Tylko audytowalny podgląd, bez usuwania plików)
                </option>
                <option value="automatic" disabled>
                  Tryb automatyczny niedostępny (wyłącznie podgląd)
                </option>
              </select>
              <span class="form-hint">Domyślnie włączony jest bezpieczny tryb podglądu (preview).</span>
            </div>
          </div>

          <h3 class="subsection-title">Okresy ważności (TTL) według kategorii:</h3>
          <div class="form-grid-3">
            <div class="form-group">
              <label class="form-label">Katalogi execution po sukcesie (godz.):</label>
              <input type="number" id="pol-ttl-success" class="form-input" value="${currentPolicy.ttl_success_hours || 24}" min="1" max="720" />
              <span class="form-hint">Domyślnie 24 godziny.</span>
            </div>

            <div class="form-group">
              <label class="form-label">Katalogi execution po błędzie/anulowaniu (godz.):</label>
              <input type="number" id="pol-ttl-failure" class="form-input" value="${currentPolicy.ttl_failure_hours || 168}" min="1" max="720" />
              <span class="form-hint">Domyślnie 168 godzin (7 dni).</span>
            </div>

            <div class="form-group">
              <label class="form-label">Osierocone katalogi staging (godz.):</label>
              <input type="number" id="pol-ttl-orphan" class="form-input" value="${currentPolicy.ttl_orphan_hours || 24}" min="1" max="720" />
              <span class="form-hint">Domyślnie 24 godziny od zakończenia.</span>
            </div>

            <div class="form-group">
              <label class="form-label">Kapsuły źródeł (godz.):</label>
              <input type="number" id="pol-ttl-sources" class="form-input" value="${currentPolicy.ttl_sources_hours || 168}" min="24" max="720" />
              <span class="form-hint">Domyślnie 7 dni.</span>
            </div>

            <div class="form-group">
              <label class="form-label">Historia logów kompilacji (dni):</label>
              <input type="number" id="pol-ttl-logs" class="form-input" value="${currentPolicy.ttl_logs_days || 30}" min="1" max="365" />
              <span class="form-hint">Domyślnie 30 dni.</span>
            </div>

            <div class="form-group">
              <label class="form-label">Minimalna liczba zachowanych artefaktów na profil:</label>
              <input type="number" id="pol-min-artifacts" class="form-input" value="${currentPolicy.min_artifacts_to_keep || 3}" min="1" max="20" />
              <span class="form-hint">Domyślnie minimum 3 sukcesy.</span>
            </div>
          </div>

          <h3 class="subsection-title">Progi ochrony wolnego miejsca:</h3>
          <div class="form-grid-3">
            <div class="form-group">
              <label class="form-label">Próg ostrzegawczy dysku (GiB):</label>
              <input type="number" id="pol-warn-gib" class="form-input" value="${currentPolicy.disk_warning_threshold_gib || 30}" min="10" />
              <span class="form-hint">Domyślnie 30 GiB (lub 15% pojemności).</span>
            </div>

            <div class="form-group">
              <label class="form-label">Próg krytyczny dysku (GiB):</label>
              <input type="number" id="pol-crit-gib" class="form-input" value="${currentPolicy.disk_critical_threshold_gib || 10}" min="5" />
              <span class="form-hint">Domyślnie 10 GiB (lub 5% pojemności).</span>
            </div>

            <div class="form-group">
              <label class="form-label">Minimalny zapas do startu buildu (GiB):</label>
              <input type="number" id="pol-min-free" class="form-input" value="${currentPolicy.min_free_space_gib || 8}" min="4" />
              <span class="form-hint">Domyślnie 8 GiB rezerwy.</span>
            </div>
          </div>

          <div class="policy-meta-footer font-small text-muted">
            Wersja polityki: v${currentPolicy.version || '1.0'} &bull; Ostatnia aktualizacja: ${formatTimestamp(currentPolicy.updated_at)}
          </div>
        </form>
      `;

      const formEl = card.querySelector('#policy-form');
      formEl?.addEventListener('input', () => { isDirty = true; });
      formEl?.addEventListener('change', () => { isDirty = true; });
    } catch (err) {
      if (!isBackground) {
        card.innerHTML = `<div class="error-box">Błąd ładowania polityki: ${escapeHtml(err.message)}</div>`;
      }
    }
  }

  container.querySelector('#btn-save-policy')?.addEventListener('click', async () => {
    const card = container.querySelector('#policy-card');
    if (!card) return;

    const chosenMode = card.querySelector('#pol-mode')?.value;
    if (chosenMode === 'automatic') {
      alert('Tryb automatyczny niedostępny (wyłącznie podgląd). Harmonogram usuwania w tle nie jest włączony.');
      return;
    }

    const payload = {
      mode: 'preview',
      ttl_success_hours: parseInt(card.querySelector('#pol-ttl-success')?.value, 10) || 24,
      ttl_failure_hours: parseInt(card.querySelector('#pol-ttl-failure')?.value, 10) || 168,
      ttl_orphan_hours: parseInt(card.querySelector('#pol-ttl-orphan')?.value, 10) || 24,
      ttl_sources_hours: parseInt(card.querySelector('#pol-ttl-sources')?.value, 10) || 168,
      ttl_logs_days: parseInt(card.querySelector('#pol-ttl-logs')?.value, 10) || 30,
      min_artifacts_to_keep: parseInt(card.querySelector('#pol-min-artifacts')?.value, 10) || 3,
      disk_warning_threshold_gib: parseInt(card.querySelector('#pol-warn-gib')?.value, 10) || 30,
      disk_critical_threshold_gib: parseInt(card.querySelector('#pol-crit-gib')?.value, 10) || 10,
      min_free_space_gib: parseInt(card.querySelector('#pol-min-free')?.value, 10) || 8,
    };

    try {
      await api.updateRetentionPolicy(payload);
      isDirty = false;
      alert('Polityka została pomyślnie zaktualizowana.');
      loadPolicy();
    } catch (err) {
      alert('Błąd aktualizacji polityki: ' + err.message);
    }
  });

  loadPolicy();

  return {
    update: () => {
      loadPolicy(true);
    },
    destroy: () => {},
  };
}
