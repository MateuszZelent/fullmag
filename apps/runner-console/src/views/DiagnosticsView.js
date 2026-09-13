import { state } from '../state.js';
import { api } from '../api.js';
import { formatBytes, formatTimestamp, renderStatusBadge, escapeHtml } from '../utils.js';

export function renderDiagnosticsView(container) {
  container.innerHTML = `
    <div class="view-container diagnostics-view">
      <div class="view-header-actions">
        <div>
          <h1 class="view-title">Diagnostyka koordynatora i alerty</h1>
          <p class="view-subtitle">Weryfikacja stanu technicznego, profile, aktywne alerty i eksport audytowy</p>
        </div>
        <div class="header-btns">
          <button class="btn btn-secondary" id="btn-export-report">
            📤 Eksportuj raport diagnostyczny (JSON)
          </button>
          <button class="btn btn-secondary" id="btn-diag-refresh">
            ↻ Odśwież
          </button>
        </div>
      </div>

      <!-- Health Comparison Grid -->
      <div class="section-card" id="diag-content">
        <div class="loading-spinner">Wczytywanie diagnostyki...</div>
      </div>
    </div>
  `;

  container.querySelector('#btn-diag-refresh')?.addEventListener('click', () => loadDiagnostics());

  container.querySelector('#btn-export-report')?.addEventListener('click', async () => {
    try {
      const [health, overview, vols, procs] = await Promise.all([
        api.getHealth(),
        api.getOverview(),
        api.getStorageVolumes().catch(() => []),
        api.getProcesses().catch(() => []),
      ]);

      const report = {
        report_schema: 'fullmag.runner-diagnostic-report.v1',
        exported_at: new Date().toISOString(),
        coordinator: {
          service: 'fullmag-build-runner',
          version: '1.2.0-runner-ui',
          health,
        },
        overview,
        storage_volumes: vols,
        processes: procs,
      };

      const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `fullmag-runner-diagnostic-${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      alert('Błąd eksportu raportu: ' + err.message);
    }
  });

  async function loadDiagnostics() {
    const card = container.querySelector('#diag-content');
    if (!card) return;
    try {
      const [healthRes, alertsRes] = await Promise.allSettled([
        api.getHealth(),
        api.getAlerts(),
      ]);

      if (healthRes.status === 'rejected') {
        throw healthRes.reason;
      }

      const health = healthRes.value || {};
      const alerts = alertsRes.status === 'fulfilled' ? alertsRes.value : null;
      const alertsErr = alertsRes.status === 'rejected' ? alertsRes.reason : state.alertsError;
      const currentPort = (typeof window !== 'undefined' && window.location && window.location.port) || '48765';

      const isApiHealthy = health.ok !== false && state.connectionStatus === 'connected';
      const apiBadgeClass = isApiHealthy ? 'badge-success' : (state.connectionStatus === 'stale' ? 'badge-warning' : 'badge-danger');
      const apiStatusText = isApiHealthy ? `OK (Port ${escapeHtml(currentPort)})` : (state.connectionStatus === 'stale' ? `STALE (Port ${escapeHtml(currentPort)})` : `BŁĄD (Port ${escapeHtml(currentPort)})`);

      card.innerHTML = `
        <div class="diag-split-grid">
          <!-- API & Worker Health -->
          <div class="diag-box">
            <h3 class="subsection-title">Stan podsystemów koordynatora:</h3>
            <ul class="diag-list">
              <li>
                <span class="diag-label">API HTTP (ThreadingHTTPServer):</span>
                <span class="badge ${apiBadgeClass}">${apiStatusText}</span>
              </li>
              <li>
                <span class="diag-label">Czas startu API:</span>
                <span class="font-mono">${formatTimestamp(health.api?.started_at)}</span>
              </li>
              <li>
                <span class="diag-label">Ostatnie zapytanie API:</span>
                <span class="font-mono">${formatTimestamp(health.api?.last_request_at)}</span>
              </li>
              <li>
                <span class="diag-label">Wątek wykonawczy (Worker Thread):</span>
                <span>${renderStatusBadge(health.worker_state || (health.worker_alive ? 'running' : 'failed'))}</span>
              </li>
              <li>
                <span class="diag-label">Przyjmowanie zadań (accepting_jobs):</span>
                <span class="badge ${health.accepting_jobs ? 'badge-success' : 'badge-danger'} font-mono">
                  ${health.accepting_jobs ? 'TRUE' : 'FALSE'}
                </span>
              </li>
              <li>
                <span class="diag-label">Ostatni błąd workera:</span>
                <span class="font-mono text-danger">${escapeHtml(health.worker_error || 'Brak (Brak zarejestrowanych błędów)')}</span>
              </li>
            </ul>
          </div>

          <!-- Allow-list & Configuration -->
          <div class="diag-box">
            <h3 class="subsection-title">Profile i konfiguracja środowiska:</h3>
            <ul class="diag-list">
              <li>
                <span class="diag-label">Kontekst środowiska:</span>
                <span class="font-mono font-bold">${escapeHtml(health.runtime_environment || health.docker_context || 'niedostępne')}</span>
              </li>
              <li>
                <span class="diag-label">Obsługiwana operacja:</span>
                <span class="badge badge-info">${escapeHtml(health.supported_operation || 'build')}</span>
              </li>
              <li>
                <span class="diag-label">Dozwolone profile buildu:</span>
                <div class="profile-tags" style="margin-top: 0.25rem;">
                  ${Array.isArray(health.allowed_profiles) && health.allowed_profiles.length > 0 ? health.allowed_profiles.map(p => `
                    <span class="badge badge-muted">${escapeHtml(p)}</span>
                  `).join(' ') : '<span class="text-muted font-small">niedostępne</span>'}
                </div>
              </li>
              <li>
                <span class="diag-label">Kwalifikacja FEM:</span>
                <span class="badge badge-warning">${escapeHtml(health.qualification || 'NOT VERIFIED')}</span>
              </li>
              <li>
                <span class="diag-label">Uprawnienia wykonawcy:</span>
                <span class="font-mono font-small">${escapeHtml(health.worker_security || 'niedostępne')}</span>
              </li>
            </ul>
          </div>
        </div>

        <!-- Alerty operacyjne -->
        <h3 class="subsection-title" style="margin-top: 1.5rem;">Aktywne alerty i warunki rozwiązania:</h3>
        ${(alertsErr || !Array.isArray(alerts)) ? `
          <div class="error-box">
            <strong>Błąd pobierania alertów operacyjnych:</strong> ${escapeHtml(alertsErr?.message || 'Brak danych podsystemu alertów')}. Stan aktywnych incydentów jest nieznany.
          </div>
        ` : alerts.length > 0 ? `
          <div class="table-responsive">
            <table class="data-table">
              <thead>
                <tr>
                  <th>Klucz alertu (Dedup)</th>
                  <th>Poziom</th>
                  <th>Komunikat</th>
                  <th>Początek</th>
                  <th>Warunek rozwiązania</th>
                </tr>
              </thead>
              <tbody>
                ${alerts.map(a => `
                  <tr>
                    <td class="font-mono font-bold">${escapeHtml(a.key || 'alert')}</td>
                    <td>${renderStatusBadge(a.level || 'warning')}</td>
                    <td>${escapeHtml(a.message)}</td>
                    <td class="font-mono">${formatTimestamp(a.started_at)}</td>
                    <td><span class="font-small text-muted">${escapeHtml(a.resolution_criteria || 'Automatyczne po ustąpieniu przyczyny')}</span></td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        ` : `
          <div class="healthy-state">
            <span class="healthy-icon">✓</span>
            <span class="healthy-text">Brak aktywnych alertów operacyjnych koordynatora.</span>
          </div>
        `}
      `;
    } catch (err) {
      card.innerHTML = `<div class="error-box">Błąd diagnostyki: ${escapeHtml(err.message)}</div>`;
    }
  }

  loadDiagnostics();

  return {
    update: () => loadDiagnostics(),
    destroy: () => {},
  };
}
