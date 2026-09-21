import { state } from '../state.js';
import { formatTimestamp, renderStatusBadge, escapeHtml } from '../utils.js';

export function renderTopBar(container) {
  const health = state.healthData || {};
  const overview = state.overviewData || {};
  const isOnline = state.connectionStatus === 'connected';
  const isStale = state.connectionStatus === 'stale';

  let apiStatusLabel = 'OK';
  let apiStatusClass = 'badge-success';
  if (!isOnline && !isStale) {
    apiStatusLabel = 'Brak połączenia';
    apiStatusClass = 'badge-danger';
  } else if (isStale) {
    apiStatusLabel = 'Nieaktualne (Stale)';
    apiStatusClass = 'badge-warning';
  }

  let workerStatus = health.worker_state || (health.worker_alive ? 'aktywny' : 'nieaktywny');
  let workerBadge = renderStatusBadge(workerStatus);

  let queueMode = 'Przyjmuje zadania (Accepting)';
  let queueBadgeClass = 'badge-success';
  if (health.stop_requested || health.worker_state === 'paused') {
    queueMode = 'Wstrzymana (Paused/Drain)';
    queueBadgeClass = 'badge-warning';
  } else if (!health.accepting_jobs) {
    queueMode = 'Zablokowana (Blocked)';
    queueBadgeClass = 'badge-danger';
  }

  const lastUpdatedStr = state.lastUpdated ? formatTimestamp(state.lastUpdated) : 'niedostępne';
  const currentPort = (typeof window !== 'undefined' && window.location && window.location.port) || '48765';
  const hostLabel = (typeof window !== 'undefined' && window.location && window.location.host) || `127.0.0.1:${currentPort}`;
  const envLabel = health.runtime_environment || health.docker_context || 'coordinator';

  container.innerHTML = `
    <header class="topbar">
      <div class="topbar-brand">
        <span class="logo-icon">⚡</span>
        <div class="brand-text">
          <span class="brand-title">Fullmag Build Runner</span>
          <span class="brand-host">${escapeHtml(hostLabel)} &bull; ${escapeHtml(envLabel)}</span>
        </div>
      </div>

      <div class="topbar-metrics">
        <div class="metric-pill" title="Zdrowie lokalnego serwera API">
          <span class="pill-label">API:</span>
          <span class="badge ${apiStatusClass}">${apiStatusLabel}</span>
        </div>

        <div class="metric-pill" title="Stan procesu wykonawczego (Worker)">
          <span class="pill-label">Wykonawca:</span>
          ${workerBadge}
        </div>

        <div class="metric-pill" title="Tryb przyjmowania zadań w kolejce SQLite">
          <span class="pill-label">Kolejka:</span>
          <span class="badge ${queueBadgeClass}">${escapeHtml(queueMode)}</span>
        </div>

        <div class="metric-pill" title="Czas ostatniego pomyślnego odświeżenia metryk">
          <span class="pill-label">Aktualizacja:</span>
          <span class="pill-value font-mono">${escapeHtml(lastUpdatedStr)}</span>
        </div>
      </div>

      <div class="topbar-actions">
        <button id="btn-refresh" class="btn btn-secondary btn-sm" title="Wymuś odświeżenie danych">
          <span class="icon">↻</span> Odśwież
        </button>

        <button id="btn-toggle-autorefresh" class="btn ${state.autoRefresh ? 'btn-active' : 'btn-secondary'} btn-sm" title="Włącz/wyłącz autoodświeżanie co 5s">
          ${state.autoRefresh ? '● Auto' : '○ Manual'}
        </button>

        <button id="btn-theme-toggle" class="btn btn-icon" title="Przełącz motyw (Jasny / Ciemny)">
          ${state.theme === 'dark' ? '☀️' : '🌙'}
        </button>
      </div>
    </header>
  `;

  // Attach handlers
  container.querySelector('#btn-refresh')?.addEventListener('click', () => state.refresh());
  container.querySelector('#btn-toggle-autorefresh')?.addEventListener('click', () => state.toggleAutoRefresh());
  container.querySelector('#btn-theme-toggle')?.addEventListener('click', () => state.toggleTheme());
}
