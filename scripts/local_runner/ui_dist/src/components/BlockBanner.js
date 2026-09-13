import { state } from '../state.js';
import { api } from '../api.js';
import { formatBytes, escapeHtml } from '../utils.js';

export function renderBlockBanner(container) {
  const health = state.healthData || {};
  const overview = state.overviewData || {};
  const storage = overview.storage || {};

  let banner = null;

  // 1. Critical or Warning Storage Pressure
  const freeBytesValid = storage.free_bytes !== null && storage.free_bytes !== undefined;
  const critThresholdValid = storage.critical_threshold_bytes !== null && storage.critical_threshold_bytes !== undefined;
  const warnThresholdValid = storage.warning_threshold_bytes !== null && storage.warning_threshold_bytes !== undefined;

  if (storage.status === 'critical' || (freeBytesValid && critThresholdValid && storage.free_bytes <= storage.critical_threshold_bytes)) {
    banner = {
      type: 'critical',
      title: 'KRYTYCZNY BRAK MIEJSCA NA DYSKU',
      message: `Wolne miejsce wynosi zaledwie ${formatBytes(storage.free_bytes)} (próg krytyczny: ${formatBytes(storage.critical_threshold_bytes)}). Nowe zadania są natychmiast blokowane, a aktywny proces może zostać wstrzymany.`,
      actionLabel: 'Przejdź do Storage i Retencji',
      actionView: 'storage',
    };
  } else if (storage.status === 'warning' || (freeBytesValid && warnThresholdValid && storage.free_bytes <= storage.warning_threshold_bytes)) {
    banner = {
      type: 'warning',
      title: 'Ostrzeżenie o niskim poziomie pamięci dyskowej',
      message: `Wolne miejsce wynosi ${formatBytes(storage.free_bytes)} (próg ostrzegawczy: ${formatBytes(storage.warning_threshold_bytes)}). Zalecane wykonanie planu retencji i zwolnienie starych plików roboczych.`,
      actionLabel: 'Zobacz zasoby storage',
      actionView: 'storage',
    };
  } else if (health.stop_requested || health.worker_state === 'paused') {
    banner = {
      type: 'warning',
      title: 'Kolejka została wstrzymana przez operatora (Stop / Drain)',
      message: 'Koordynator nie przyjmuje nowych zadań kompilacji. Aktywny build (jeśli istnieje) zostanie dokończony przed zatrzymaniem.',
      actionLabel: 'Wznów przyjmowanie zadań (Resume)',
      actionFn: async () => {
        try {
          await api.resumeQueue();
          state.refresh();
        } catch (err) {
          alert('Błąd podczas wznawiania kolejki: ' + err.message);
        }
      },
    };
  } else if (health.worker_error) {
    banner = {
      type: 'danger',
      title: 'Błąd wykonawcy (Worker Error)',
      message: health.worker_error,
      actionLabel: 'Diagnostyka',
      actionView: 'diagnostics',
    };
  } else if (health.legacy_jobs && health.legacy_jobs.length > 0) {
    banner = {
      type: 'danger',
      title: 'Wykryto nieobsługiwane zadanie starszego typu (Legacy Job)',
      message: 'W kolejce znajduje się zadanie wymagające manualnej weryfikacji operatora.',
      actionLabel: 'Zobacz kolejkę',
      actionView: 'queue',
    };
  }

  if (!banner) {
    container.innerHTML = '';
    return;
  }

  container.innerHTML = `
    <div class="banner banner-${banner.type}">
      <div class="banner-icon">${banner.type === 'critical' || banner.type === 'danger' ? '⛔' : '⚠️'}</div>
      <div class="banner-content">
        <strong class="banner-title">${escapeHtml(banner.title)}</strong>
        <p class="banner-desc">${escapeHtml(banner.message)}</p>
      </div>
      <div class="banner-action">
        <button id="btn-banner-action" class="btn btn-sm btn-outline-${banner.type}">
          ${escapeHtml(banner.actionLabel)}
        </button>
      </div>
    </div>
  `;

  const btn = container.querySelector('#btn-banner-action');
  if (btn) {
    btn.addEventListener('click', () => {
      if (banner.actionFn) {
        banner.actionFn();
      } else if (banner.actionView) {
        state.setView(banner.actionView);
      }
    });
  }
}
