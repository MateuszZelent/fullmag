import { state } from '../state.js';
import { api } from '../api.js';
import { formatBytes, formatTimestamp, renderStatusBadge, escapeHtml } from '../utils.js';

export function renderProcessesView(container) {
  container.innerHTML = `
    <div class="view-container processes-view">
      <div class="view-header">
        <h1 class="view-title">Procesy i zasoby</h1>
        <p class="view-subtitle">Koordynator, aktywny worker kontenerowy oraz rozpoznane procesy korzystające ze storage</p>
      </div>

      <div class="section-card" id="proc-card">
        <div class="loading-spinner">Wczytywanie informacji o procesach...</div>
      </div>
    </div>
  `;

  async function loadProcesses() {
    const card = container.querySelector('#proc-card');
    if (!card) return;
    try {
      const overview = state.overviewData || {};
      const health = state.healthData || {};
      const active = overview.active_build;

      const remoteProcs = await api.getProcesses().catch(() => null);
      const procs = (Array.isArray(remoteProcs) && remoteProcs.length > 0) ? remoteProcs : null;

      if (!procs || procs.length === 0) {
        card.innerHTML = `
          <div class="empty-state">
            <p class="empty-hint">Dane o procesach są obecnie niedostępne.</p>
          </div>
        `;
        return;
      }

      card.innerHTML = `
        <div class="table-responsive">
          <table class="data-table">
            <thead>
              <tr>
                <th>PID / Kontener ID</th>
                <th>Rola procesu</th>
                <th>Typ / Uprawnienia</th>
                <th>Zadanie (Job)</th>
                <th>Czas startu</th>
                <th>CPU</th>
                <th>RAM / Limit</th>
                <th>I/O</th>
                <th>Ścieżki robocze</th>
                <th>Zredagowane polecenie</th>
                <th>Stan</th>
              </tr>
            </thead>
            <tbody>
              ${procs.map(p => `
                <tr>
                  <td class="font-mono font-bold">${escapeHtml(p.id)}</td>
                  <td><strong>${escapeHtml(p.role)}</strong></td>
                  <td><span class="badge badge-muted">${escapeHtml(p.type)}</span></td>
                  <td class="font-mono">${escapeHtml(p.job_id)}</td>
                  <td class="font-mono">${formatTimestamp(p.started_at)}</td>
                  <td class="font-mono">${escapeHtml(p.cpu)}</td>
                  <td class="font-mono">${escapeHtml(p.ram)} <span class="text-muted">(${escapeHtml(p.limit)})</span></td>
                  <td class="font-mono">${escapeHtml(p.io)}</td>
                  <td class="font-mono font-small">${escapeHtml(p.paths)}</td>
                  <td class="font-mono font-small" title="${escapeHtml(p.cmd)}">${escapeHtml(p.cmd)}</td>
                  <td>${renderStatusBadge(p.status)}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>

        <div class="notice-box font-small text-muted" style="margin-top: 1rem;">
          ℹ️ Obce procesy i montowania hosta są pokazywane wyłącznie informacyjnie. Runner nie udostępnia arbitralnego usuwania ani zatrzymywania zewnętrznych procesów OS.
        </div>
      `;
    } catch (err) {
      card.innerHTML = `<div class="error-box">Błąd: ${escapeHtml(err.message)}</div>`;
    }
  }

  loadProcesses();

  return {
    update: () => loadProcesses(),
  };
}
