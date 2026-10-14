import { state } from '../state.js';
import { api } from '../api.js';
import { formatDuration, formatDurationBetween, formatRelative, formatTimestamp, renderStatusBadge, escapeHtml } from '../utils.js';

export function renderQueueView(container) {
  const health = state.healthData || {};

  container.innerHTML = `
    <div class="view-container queue-view">
      <div class="view-header-actions">
        <div>
          <h1 class="view-title">Kolejka zadań</h1>
          <p class="view-subtitle">Aktywny proces oraz zadania oczekujące w kolejce FIFO</p>
        </div>
        <div class="header-btns">
          ${health.stop_requested || health.worker_state === 'paused' ? `
            <button class="btn btn-success" id="btn-queue-resume">
              ▶ Wznów przyjmowanie zadań
            </button>
          ` : `
            <button class="btn btn-warning" id="btn-queue-pause">
              ⏸ Wstrzymaj przyjmowanie (Drain)
            </button>
          `}
          <button class="btn btn-secondary" id="btn-queue-refresh">
            ↻ Odśwież
          </button>
        </div>
      </div>

      <div class="section-card" id="queue-table-card">
        <div class="loading-spinner">Ładowanie kolejki...</div>
      </div>
    </div>
  `;

  // Attach control listeners
  container.querySelector('#btn-queue-pause')?.addEventListener('click', async () => {
    if (confirm('Wstrzymanie kolejki nie przerywa aktywnego builda, ale odrzuca nowe zgłoszenia. Kontynuować?')) {
      try {
        await api.pauseQueue();
        await state.refresh();
        loadQueue();
      } catch (err) {
        alert('Błąd wstrzymania: ' + err.message);
      }
    }
  });

  container.querySelector('#btn-queue-resume')?.addEventListener('click', async () => {
    try {
      await api.resumeQueue();
      await state.refresh();
      loadQueue();
    } catch (err) {
      alert('Błąd wznowienia: ' + err.message);
    }
  });

  container.querySelector('#btn-queue-refresh')?.addEventListener('click', () => {
    loadQueue();
  });

  async function loadQueue() {
    const card = container.querySelector('#queue-table-card');
    if (!card) return;
    try {
      const queueJobs = [];
      const seenJobIds = new Set();
      const seenCursors = new Set();
      let cursor = null;
      let asOfSequence = null;
      do {
        const params = { status: 'queue', sort: 'oldest', limit: 200 };
        if (cursor !== null) params.cursor = cursor;
        const res = await api.getJobs(params);
        if (!Array.isArray(res?.items) ||
            !Object.prototype.hasOwnProperty.call(res, 'next_cursor') ||
            !Number.isInteger(res.as_of_sequence) || res.as_of_sequence < 0 ||
            (res.next_cursor !== null && typeof res.next_cursor !== 'string')) {
          throw new Error('Nieprawidłowa odpowiedź kolejki');
        }
        if (asOfSequence !== null && res.as_of_sequence !== asOfSequence) {
          throw new Error('Nieprawidłowa odpowiedź kolejki');
        }
        asOfSequence = res.as_of_sequence;
        if (res.is_truncated) throw new Error('Lista kolejki jest niekompletna');
        for (const job of res.items) {
          if (!job || typeof job.job_id !== 'string' || !job.job_id || seenJobIds.has(job.job_id)) {
            throw new Error('Nieprawidłowa odpowiedź kolejki');
          }
          seenJobIds.add(job.job_id);
          queueJobs.push(job);
        }
        const nextCursor = res.next_cursor;
        if (nextCursor !== null) {
          if (!nextCursor || nextCursor === cursor || seenCursors.has(nextCursor)) {
            throw new Error('Nieprawidłowa odpowiedź kolejki');
          }
          seenCursors.add(nextCursor);
        }
        cursor = nextCursor;
      } while (cursor !== null);

      if (queueJobs.length === 0) {
        card.innerHTML = `
          <div class="empty-state">
            <span class="empty-icon">📭</span>
            <p class="empty-text">Kolejka jest pusta. Żadne zadanie nie czeka na slot ani nie jest wykonywane.</p>
          </div>
        `;
        return;
      }

      card.innerHTML = `
        <div class="table-responsive">
          <table class="data-table">
            <thead>
              <tr>
                <th>Poz.</th>
                <th>Identyfikator zadania</th>
                <th>Status</th>
                <th>Profil</th>
                <th>Operator</th>
                <th>Worktree</th>
                <th>Zgłoszone</th>
                <th>Czas pracy / oczekiwania</th>
                <th>Akcje</th>
              </tr>
            </thead>
            <tbody>
              ${queueJobs.map((j, idx) => `
                <tr class="${j.state === 'running' ? 'row-active' : ''}">
                  <td class="font-mono">#${idx + 1}</td>
                  <td class="font-mono font-bold" title="${escapeHtml(j.job_id)}">
                    ${escapeHtml(j.job_id.substring(0, 12))}…
                  </td>
                  <td>${renderStatusBadge(j.state)}</td>
                  <td><strong>${escapeHtml(j.profile || 'niedostępne')}</strong></td>
                  <td>${escapeHtml(j.owner || 'operator')}</td>
                  <td class="font-mono">${escapeHtml(j.worktree_id || 'n/a')}</td>
                  <td class="font-mono">${formatRelative(j.created_at)}</td>
                  <td class="font-mono">
                    ${formatDurationBetween(j.started_at || j.created_at, Date.now())}
                  </td>
                  <td>
                    <div class="btn-group">
                      <button class="btn btn-sm btn-secondary btn-table-details" data-id="${escapeHtml(j.job_id)}">
                        Szczegóły
                      </button>
                      <button class="btn btn-sm btn-danger btn-table-cancel" data-id="${escapeHtml(j.job_id)}">
                        Anuluj
                      </button>
                    </div>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `;

      card.querySelectorAll('.btn-table-details').forEach(btn => {
        btn.addEventListener('click', (e) => state.openJobDetails(e.currentTarget.getAttribute('data-id')));
      });

      card.querySelectorAll('.btn-table-cancel').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          const id = e.currentTarget.getAttribute('data-id');
          if (confirm(`Czy na pewno anulować zadanie ${id}?`)) {
            try {
              await api.cancelJob(id);
              await state.refresh();
              loadQueue();
            } catch (err) {
              alert('Błąd anulowania: ' + err.message);
            }
          }
        });
      });
    } catch (err) {
      card.innerHTML = `<div class="error-box">Błąd ładowania kolejki: ${escapeHtml(err.message)}</div>`;
    }
  }

  loadQueue();

  return {
    update: () => loadQueue(),
  };
}
