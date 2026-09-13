import { state } from '../state.js';
import { api } from '../api.js';
import { formatBytes, formatDuration, formatDurationBetween, formatRelative, formatTimestamp, renderStatusBadge, escapeHtml } from '../utils.js';

const historyFilterState = {
  status: 'all',
  profile: 'all',
  worktree: 'all',
  sort: 'newest',
  search: '',
  page: 1,
  pageSize: 25,
};

export function renderHistoryView(container) {
  let allJobs = [];
  let currentPolicy = state.policiesData || null;

  container.innerHTML = `
    <div class="view-container history-view">
      <div class="view-header">
        <h1 class="view-title">Historia kompilacji</h1>
        <p class="view-subtitle">Archiwum zakończonych zadań wraz z kodami wyjścia i statusem retencji</p>
      </div>

      <!-- Filters Bar -->
      <div class="section-card filter-bar">
        <div class="filter-group">
          <label class="filter-label">Status:</label>
          <select id="sel-filter-status" class="form-select">
            <option value="all" ${historyFilterState.status === 'all' ? 'selected' : ''}>Wszystkie</option>
            <option value="succeeded" ${historyFilterState.status === 'succeeded' ? 'selected' : ''}>Sukces (succeeded)</option>
            <option value="failed" ${historyFilterState.status === 'failed' ? 'selected' : ''}>Błąd (failed)</option>
            <option value="cancelled" ${historyFilterState.status === 'cancelled' ? 'selected' : ''}>Anulowane (cancelled)</option>
          </select>
        </div>

        <div class="filter-group">
          <label class="filter-label">Profil:</label>
          <select id="sel-filter-profile" class="form-select">
            <option value="all" ${historyFilterState.profile === 'all' ? 'selected' : ''}>Wszystkie profile</option>
            ${(state.healthData?.allowed_profiles || []).map(p => `
              <option value="${escapeHtml(p)}" ${historyFilterState.profile === p ? 'selected' : ''}>${escapeHtml(p)}</option>
            `).join('')}
          </select>
        </div>

        <div class="filter-group">
          <label class="filter-label">Worktree:</label>
          <select id="sel-filter-worktree" class="form-select">
            <option value="all">Wszystkie worktree</option>
          </select>
        </div>

        <div class="filter-group">
          <label class="filter-label">Sortowanie:</label>
          <select id="sel-filter-sort" class="form-select">
            <option value="newest" ${historyFilterState.sort === 'newest' ? 'selected' : ''}>Najnowsze najpierw</option>
            <option value="oldest" ${historyFilterState.sort === 'oldest' ? 'selected' : ''}>Najstarsze najpierw</option>
          </select>
        </div>

        <div class="filter-group filter-search">
          <label class="filter-label">Szukaj:</label>
          <input type="text" id="inp-search" class="form-input" placeholder="ID zadania, digest lub worktree..." value="${escapeHtml(historyFilterState.search)}" />
        </div>

        <div class="filter-actions">
          <button class="btn btn-secondary btn-sm" id="btn-history-refresh">↻ Odśwież</button>
        </div>
      </div>

      <!-- Table Container -->
      <div class="section-card" id="history-table-card">
        <div class="loading-spinner">Wczytywanie historii zadań...</div>
      </div>
    </div>
  `;

  let searchDebounceTimer = null;

  // Filter bindings
  container.querySelector('#sel-filter-status')?.addEventListener('change', (e) => {
    historyFilterState.status = e.target.value;
    historyFilterState.page = 1;
    fetchHistory();
  });

  container.querySelector('#sel-filter-profile')?.addEventListener('change', (e) => {
    historyFilterState.profile = e.target.value;
    historyFilterState.page = 1;
    fetchHistory();
  });

  container.querySelector('#sel-filter-worktree')?.addEventListener('change', (e) => {
    historyFilterState.worktree = e.target.value;
    historyFilterState.page = 1;
    fetchHistory();
  });

  container.querySelector('#sel-filter-sort')?.addEventListener('change', (e) => {
    historyFilterState.sort = e.target.value;
    historyFilterState.page = 1;
    fetchHistory();
  });

  container.querySelector('#inp-search')?.addEventListener('input', (e) => {
    historyFilterState.search = e.target.value.toLowerCase().trim();
    historyFilterState.page = 1;
    if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => {
      fetchHistory();
    }, 250);
  });

  container.querySelector('#btn-history-refresh')?.addEventListener('click', () => {
    fetchHistory();
  });

  async function fetchHistory(isBackground = false) {
    const card = container.querySelector('#history-table-card');
    if (!card) return;
    if (!isBackground && allJobs.length === 0) {
      card.innerHTML = `<div class="loading-spinner">Wczytywanie historii zadań...</div>`;
    }

    try {
      const params = {
        sort: historyFilterState.sort,
        page: historyFilterState.page,
        limit: historyFilterState.pageSize,
      };
      if (historyFilterState.status === 'all') {
        params.status = 'history';
      } else {
        params.status = historyFilterState.status;
      }
      if (historyFilterState.profile !== 'all') {
        params.profile = historyFilterState.profile;
      }
      if (historyFilterState.worktree !== 'all') {
        params.worktree = historyFilterState.worktree;
      }
      if (historyFilterState.search) {
        params.search = historyFilterState.search;
      }

      const [res, pol] = await Promise.all([
        api.getJobs(params),
        state.policiesData ? Promise.resolve(state.policiesData) : api.getRetentionPolicy().catch(() => null),
      ]);

      if (pol && !state.policiesData) {
        state.policiesData = pol;
      }
      currentPolicy = state.policiesData || pol;

      let items = [];
      let total = 0;
      let availableWorktrees = [];

      if (Array.isArray(res)) {
        items = res.filter(j => j.state === 'succeeded' || j.state === 'failed' || j.state === 'cancelled');
        total = items.length;
      } else if (res && Array.isArray(res.items)) {
        items = res.items;
        total = res.total || items.length;
        availableWorktrees = res.worktrees || [];
      }

      allJobs = items;

      // Populate worktrees filter if present and not populated
      const wtSelect = container.querySelector('#sel-filter-worktree');
      if (wtSelect && wtSelect.options.length <= 1 && availableWorktrees.length > 0) {
        availableWorktrees.forEach(wt => {
          const opt = document.createElement('option');
          opt.value = wt;
          opt.textContent = wt;
          if (historyFilterState.worktree === wt) opt.selected = true;
          wtSelect.appendChild(opt);
        });
      }

      renderTable(items, total);
    } catch (err) {
      if (!isBackground || allJobs.length === 0) {
        card.innerHTML = `<div class="error-box">Błąd pobierania historii: ${escapeHtml(err.message)}</div>`;
      }
    }
  }

  function renderTable(items, totalItems) {
    const card = container.querySelector('#history-table-card');
    if (!card) return;

    if (!items || items.length === 0) {
      card.innerHTML = `<p class="empty-hint">Brak zakończonych zadań kompilacji spełniających wybrane kryteria.</p>`;
      return;
    }

    const totalPages = Math.ceil(totalItems / historyFilterState.pageSize) || 1;
    const startIndex = (historyFilterState.page - 1) * historyFilterState.pageSize;

    card.innerHTML = `
      <div class="table-responsive">
        <table class="data-table">
          <thead>
            <tr>
              <th>ID Zadania</th>
              <th>Status</th>
              <th>Profil</th>
              <th>Worktree</th>
              <th>Digest Źródeł</th>
              <th>Utworzono</th>
              <th>Czas trwania</th>
              <th>Exit Code</th>
              <th>Ochrona / Retencja</th>
              <th>Akcje</th>
            </tr>
          </thead>
          <tbody>
            ${items.map(j => {
              const dur = formatDurationBetween(j.started_at || j.created_at, j.updated_at);
              const exitCodeStr = j.exit_code !== undefined && j.exit_code !== null ? String(j.exit_code) : (j.state === 'succeeded' ? '0' : 'n/a');

              let ttlStr = 'Chronione';
              let ttlTitle = 'Retencja zgodna ze stanem zadania';
              if (currentPolicy) {
                const hours = j.state === 'succeeded' ? currentPolicy.ttl_success_hours : currentPolicy.ttl_failure_hours;
                if (hours !== undefined && hours !== null) {
                  const durStr = hours % 24 === 0 ? `${hours / 24}d` : `${hours}h`;
                  ttlStr = `Chronione (${durStr})`;
                  ttlTitle = `Retencja zgodna ze skonfigurowaną polityką (${hours}h / ${durStr})`;
                }
              } else {
                ttlStr = j.state === 'succeeded' ? 'Chronione (sukces)' : 'Chronione (błąd)';
              }

              return `
                <tr>
                  <td class="font-mono font-bold" title="${escapeHtml(j.job_id)}">
                    ${escapeHtml(j.job_id.substring(0, 10))}…
                  </td>
                  <td>${renderStatusBadge(j.state)}</td>
                  <td>${escapeHtml(j.profile || 'niedostępne')}</td>
                  <td class="font-mono">${escapeHtml(j.worktree_id || 'n/a')}</td>
                  <td class="font-mono" title="${escapeHtml(j.source_digest || '')}">
                    ${j.source_digest ? escapeHtml(j.source_digest.substring(0, 10)) + '…' : 'n/a'}
                  </td>
                  <td class="font-mono">${formatRelative(j.created_at)}</td>
                  <td class="font-mono">${dur}</td>
                  <td>
                    <span class="badge ${j.exit_code === 0 || (j.state === 'succeeded' && exitCodeStr === '0') ? 'badge-success' : 'badge-danger'} font-mono">
                      ${exitCodeStr}
                    </span>
                  </td>
                  <td>
                    <span class="badge badge-muted" title="${escapeHtml(ttlTitle)}">
                      ${escapeHtml(ttlStr)}
                    </span>
                  </td>
                  <td>
                    <div class="btn-group">
                      <button class="btn btn-sm btn-secondary btn-history-details" data-id="${escapeHtml(j.job_id)}">
                        Szczegóły
                      </button>
                    </div>
                  </td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
      <div class="table-pagination-footer" style="display: flex; justify-content: space-between; align-items: center; margin-top: 1rem; padding-top: 0.5rem; border-top: 1px solid var(--border);">
        <div class="pagination-info font-small text-muted">
          Wyświetlono ${startIndex + 1}–${Math.min(startIndex + items.length, totalItems)} z ${totalItems} zadań
        </div>
        <div class="pagination-controls" style="display: flex; gap: 0.5rem; align-items: center;">
          <button class="btn btn-secondary btn-sm" id="btn-page-prev" ${historyFilterState.page <= 1 ? 'disabled' : ''}>&laquo; Poprzednia</button>
          <span class="font-small font-mono">Strona ${historyFilterState.page} z ${totalPages}</span>
          <button class="btn btn-secondary btn-sm" id="btn-page-next" ${historyFilterState.page >= totalPages ? 'disabled' : ''}>Następna &raquo;</button>
        </div>
      </div>
    `;

    card.querySelectorAll('.btn-history-details').forEach(btn => {
      btn.addEventListener('click', (e) => state.openJobDetails(e.currentTarget.getAttribute('data-id')));
    });

    card.querySelector('#btn-page-prev')?.addEventListener('click', () => {
      if (historyFilterState.page > 1) {
        historyFilterState.page--;
        fetchHistory();
      }
    });

    card.querySelector('#btn-page-next')?.addEventListener('click', () => {
      if (historyFilterState.page < totalPages) {
        historyFilterState.page++;
        fetchHistory();
      }
    });
  }

  fetchHistory();

  return {
    update: () => {
      fetchHistory(true);
    },
    destroy: () => {
      if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
    },
  };
}
