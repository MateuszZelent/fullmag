import { state } from '../state.js';
import { api } from '../api.js';
import { formatTimestamp, escapeHtml } from '../utils.js';

export function renderLogsView(container) {
  let events = [];
  let filterLevel = 'all';
  let filterSearch = '';
  let autoScroll = true;

  container.innerHTML = `
    <div class="view-container logs-view">
      <div class="view-header-actions">
        <div>
          <h1 class="view-title">Dziennik zdarzeń i logi koordynatora</h1>
          <p class="view-subtitle">Ustrukturyzowany strumień zdarzeń cyklu życia zadań oraz kontroli storage</p>
        </div>
        <div class="header-btns">
          <label class="checkbox-label font-small">
            <input type="checkbox" id="chk-autoscroll" checked /> Auto-scroll
          </label>
          <button class="btn btn-secondary btn-sm" id="btn-logs-copy">📋 Kopiuj logi</button>
          <button class="btn btn-secondary btn-sm" id="btn-logs-refresh">↻ Odśwież</button>
        </div>
      </div>

      <!-- Filters -->
      <div class="section-card filter-bar">
        <div class="filter-group">
          <label class="filter-label">Poziom (Level):</label>
          <select id="sel-log-level" class="form-select">
            <option value="all">Wszystkie poziomy</option>
            <option value="INFO">INFO</option>
            <option value="WARN">WARN</option>
            <option value="ERROR">ERROR</option>
          </select>
        </div>

        <div class="filter-group filter-search">
          <label class="filter-label">Filtruj tekst:</label>
          <input type="text" id="inp-log-search" class="form-input" placeholder="Szukaj zdarzenia, job ID lub komunikatu..." />
        </div>
      </div>

      <!-- Logs Terminal Box -->
      <div class="section-card terminal-card">
        <div class="terminal-body font-mono" id="terminal-content">
          <div class="loading-spinner">Wczytywanie logów...</div>
        </div>
      </div>
    </div>
  `;

  // Filter bindings
  container.querySelector('#sel-log-level')?.addEventListener('change', (e) => {
    filterLevel = e.target.value;
    renderFiltered();
  });

  container.querySelector('#inp-log-search')?.addEventListener('input', (e) => {
    filterSearch = e.target.value.toLowerCase().trim();
    renderFiltered();
  });

  container.querySelector('#chk-autoscroll')?.addEventListener('change', (e) => {
    autoScroll = e.target.checked;
  });

  container.querySelector('#btn-logs-refresh')?.addEventListener('click', () => loadLogs());

  container.querySelector('#btn-logs-copy')?.addEventListener('click', () => {
    const text = events.map(e => `[${e.timestamp}] [${e.level}] ${e.event}: ${e.message}`).join('\n');
    navigator.clipboard.writeText(text).then(() => alert('Logi skopiowane do schowka.'));
  });

  async function loadLogs(isBackground = false) {
    const term = container.querySelector('#terminal-content');
    if (!term) return;
    try {
      events = await api.getEvents(200);
      renderFiltered();
    } catch (err) {
      if (!isBackground || events.length === 0) {
        term.innerHTML = `<div class="error-box">Błąd wczytywania zdarzeń: ${escapeHtml(err.message)}</div>`;
      }
    }
  }

  function renderFiltered() {
    const term = container.querySelector('#terminal-content');
    if (!term) return;

    let filtered = events;
    if (filterLevel !== 'all') {
      filtered = filtered.filter(e => e.level === filterLevel);
    }
    if (filterSearch) {
      filtered = filtered.filter(e =>
        (e.message && e.message.toLowerCase().includes(filterSearch)) ||
        (e.event && e.event.toLowerCase().includes(filterSearch)) ||
        (e.job_id && e.job_id.toLowerCase().includes(filterSearch))
      );
    }

    if (filtered.length === 0) {
      term.innerHTML = `<div class="empty-hint">Brak zdarzeń spełniających wybrane kryteria.</div>`;
      return;
    }

    term.innerHTML = filtered.map(e => {
      let levelClass = 'log-level-info';
      if (e.level === 'WARN') levelClass = 'log-level-warn';
      if (e.level === 'ERROR' || e.level === 'CRITICAL') levelClass = 'log-level-error';

      return `
        <div class="log-line">
          <span class="log-time">${formatTimestamp(e.timestamp)}</span>
          <span class="log-level ${levelClass}">[${e.level}]</span>
          <span class="log-event font-bold">${escapeHtml(e.event)}</span>
          ${e.job_id ? `<span class="log-job">[job:${escapeHtml(e.job_id.substring(0, 8))}]</span>` : ''}
          <span class="log-msg">${escapeHtml(e.message)}</span>
        </div>
      `;
    }).join('');

    if (autoScroll) {
      term.scrollTop = term.scrollHeight;
    }
  }

  loadLogs();

  return {
    update: () => {
      loadLogs(true);
    },
    destroy: () => {},
  };
}
