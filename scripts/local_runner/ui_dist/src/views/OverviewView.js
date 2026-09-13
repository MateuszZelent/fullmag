import { state } from '../state.js';
import { api } from '../api.js';
import { formatBytes, formatDuration, formatDurationBetween, formatRelative, formatTimestamp, renderStatusBadge, escapeHtml } from '../utils.js';

export function renderOverviewView(container) {
  function renderContent() {
    const scrollY = (typeof window !== 'undefined' && window.scrollY !== undefined) ? window.scrollY : 0;
    const scrollTop = container.scrollTop || 0;

    const overview = state.overviewData || {};
    const health = state.healthData || {};
    const active = overview.active_build;
    const storage = overview.storage || {};
    const worker = overview.worker || {};
    const cleanup = overview.last_cleanup || {};
    const trends = overview.trends || [];
    const incidents = overview.incidents || [];

    // Storage calculation
    const freeBytes = storage.free_bytes ?? health.storage_free_bytes;
    const reservedBytes = storage.reserved_bytes;
    const freeStr = formatBytes(freeBytes);
    const reservedStr = formatBytes(reservedBytes);

    // Worker RAM
    const workerRam = (worker.memory_mb !== null && worker.memory_mb !== undefined && worker.memory_mb > 0) ? `${worker.memory_mb} MiB` : 'niedostępne';
    const workerLimit = worker.limit_mb ? `${worker.limit_mb} MiB` : 'Bez limitu';

    // Cleanup calculation
    const hasCleanup = cleanup && cleanup.status && cleanup.status !== 'brak' && cleanup.status !== 'none' && cleanup.reclaimed_bytes !== null && cleanup.reclaimed_bytes !== undefined;
    const cleanupReclaimedStr = hasCleanup ? formatBytes(cleanup.reclaimed_bytes) : 'niedostępne';
    const cleanupCandidatesStr = (hasCleanup && cleanup.candidates_count !== null && cleanup.candidates_count !== undefined) ? cleanup.candidates_count : '—';
    const cleanupStatusStr = hasCleanup ? escapeHtml(cleanup.status) : 'brak';

    container.innerHTML = `
      <div class="view-container overview-view">
        <div class="view-header">
          <h1 class="view-title">Przegląd operacyjny</h1>
          <p class="view-subtitle">Stan wykonawcy Fullmag build runner, zapas danych i aktywność kolejki</p>
        </div>

      <!-- 1. 5 KPI CARDS -->
      <section class="kpi-grid">
        <div class="kpi-card ${active ? 'kpi-card-active' : ''}">
          <div class="kpi-header">
            <span class="kpi-title">Aktywny build</span>
            <span class="kpi-icon">🔨</span>
          </div>
          <div class="kpi-value">${active ? escapeHtml(active.profile || 'niedostępne') : 'Brak aktywnego'}</div>
          <div class="kpi-subtext">
            ${active ? `Etap: <strong>${escapeHtml(active.stage || 'niedostępne')}</strong>` : 'Slot kompilacji jest wolny'}
          </div>
        </div>

        <div class="kpi-card">
          <div class="kpi-header">
            <span class="kpi-title">Oczekujące w kolejce</span>
            <span class="kpi-icon">📋</span>
          </div>
          <div class="kpi-value font-mono">${overview.queued_count !== undefined ? overview.queued_count : 'niedostępne'}</div>
          <div class="kpi-subtext">
            ${overview.queued_count > 0 ? 'Kolejka FIFO (1 ciężki slot)' : 'Brak oczekujących zadań'}
          </div>
        </div>

        <div class="kpi-card ${storage.status === 'warning' ? 'kpi-card-warning' : storage.status === 'critical' ? 'kpi-card-danger' : ''}">
          <div class="kpi-header">
            <span class="kpi-title">Wolne miejsce / Rezerwa</span>
            <span class="kpi-icon">💾</span>
          </div>
          <div class="kpi-value font-mono">${freeStr}</div>
          <div class="kpi-subtext">
            Rezerwacja: <span class="font-mono">${reservedStr}</span>${storage.critical_threshold_bytes ? ` &bull; Próg krytyczny: ${formatBytes(storage.critical_threshold_bytes)}` : ''}
          </div>
        </div>

        <div class="kpi-card">
          <div class="kpi-header">
            <span class="kpi-title">RAM Workera / Limit</span>
            <span class="kpi-icon">🧠</span>
          </div>
          <div class="kpi-value font-mono">${workerRam}</div>
          <div class="kpi-subtext">
            Limit cgroup: <span class="font-mono">${workerLimit}</span> &bull; CPU: ${worker.cpu_percent !== null && worker.cpu_percent !== undefined ? worker.cpu_percent + '%' : 'niedostępne'}
          </div>
        </div>

        <div class="kpi-card">
          <div class="kpi-header">
            <span class="kpi-title">Ostatnie sprzątanie</span>
            <span class="kpi-icon">🧹</span>
          </div>
          <div class="kpi-value font-mono">${cleanupReclaimedStr}</div>
          <div class="kpi-subtext">
            Kandydaci: <strong>${cleanupCandidatesStr}</strong> &bull; Status: ${cleanupStatusStr}
          </div>
        </div>
      </section>

      <!-- 2. DUŻY PANEL AKTYWNEGO BUILDU -->
      <section class="section-card active-build-panel">
        <div class="card-header-flex">
          <div>
            <h2 class="section-title">Aktywny build w slocie kompilacji</h2>
            <span class="section-subtitle">Tylko jeden ciężki proces może jednocześnie zajmować slot</span>
          </div>
          <div class="active-badge-wrap">
            ${active ? renderStatusBadge('running') : renderStatusBadge('idle')}
          </div>
        </div>

        ${active ? `
          <div class="active-build-grid">
            <div class="build-field">
              <span class="field-label">Profil zadania:</span>
              <span class="field-val font-bold">${escapeHtml(active.profile)}</span>
            </div>

            <div class="build-field">
              <span class="field-label">Worktree ID:</span>
              <span class="field-val font-mono">${escapeHtml(active.worktree_id || 'niedostępne')}</span>
            </div>

            <div class="build-field">
              <span class="field-label">Kapsuła / Digest:</span>
              <span class="field-val font-mono" title="${escapeHtml(active.source_digest)}">
                ${active.source_digest ? escapeHtml(active.source_digest.substring(0, 16)) + '…' : 'niedostępne'}
              </span>
            </div>

            <div class="build-field">
              <span class="field-label">Bieżący etap:</span>
              <span class="field-val badge badge-info">${escapeHtml(active.stage || 'niedostępne')}</span>
            </div>

            <div class="build-field">
              <span class="field-label">Czas rozpoczęcia:</span>
              <span class="field-val font-mono">${formatTimestamp(active.started_at || active.created_at)}</span>
            </div>

            <div class="build-field">
              <span class="field-label">Czas trwania:</span>
              <span class="field-val font-mono">
                ${active ? formatDurationBetween(active.started_at || active.created_at, Date.now()) : 'niedostępne'}
              </span>
            </div>
          </div>

          <!-- Pasek postępu etapów -->
          <div class="stages-progress-bar">
            <div class="stages-timeline">
              ${(active.stages || []).map((st, idx) => `
                <div class="stage-step stage-${st.status}">
                  <div class="stage-dot">${idx + 1}</div>
                  <div class="stage-name">${escapeHtml(st.name)}</div>
                </div>
              `).join('')}
            </div>
          </div>

          <div class="active-build-actions">
            <button class="btn btn-primary btn-sm" id="btn-active-details" data-job-id="${escapeHtml(active.job_id)}">
              🔍 Szczegóły buildu
            </button>
            <button class="btn btn-secondary btn-sm" id="btn-active-logs" data-job-id="${escapeHtml(active.job_id)}">
              📋 Pokaż logi na żywo
            </button>
            <button class="btn btn-danger btn-sm" id="btn-active-cancel" data-job-id="${escapeHtml(active.job_id)}">
              ⛔ Anuluj zadanie
            </button>
          </div>
        ` : `
          <div class="empty-state">
            <span class="empty-icon">☕</span>
            <p class="empty-text">Brak trwających kompilacji. Runner oczekuje na nowe zgłoszenia z CLI lub worktree.</p>
            <button class="btn btn-secondary btn-sm" id="btn-go-queue">Zobacz historię i kolejkę</button>
          </div>
        `}
      </section>

      <!-- 3. TRENDY OSTATNIEJ GODZINY -->
      <section class="section-card trends-panel">
        <div class="card-header-flex">
          <div>
            <h2 class="section-title">Trendy telemetryczne ostatniej godziny</h2>
            <span class="section-subtitle">Dysk wolny, przyrost danych, RAM workera, obciążenie CPU i operacje I/O</span>
          </div>
        </div>

        ${renderTrendCharts(trends)}
      </section>

      <!-- 4. NASTĘPNE ZADANIA I OSTATNIE INCYDENTY -->
      <div class="overview-dual-grid">
        <section class="section-card">
          <h2 class="section-title">Następne zadania w kolejce</h2>
          <div class="next-jobs-list">
            ${overview.queued_count > 0 ? `
              <div class="table-responsive">
                <table class="data-table">
                  <thead>
                    <tr>
                      <th>Poz.</th>
                      <th>Profil</th>
                      <th>Worktree</th>
                      <th>Powód oczekiwania</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${((overview.next_jobs && overview.next_jobs.length > 0) ? overview.next_jobs : (overview.next_job ? [overview.next_job] : [])).map((nj, idx) => `
                      <tr>
                        <td class="font-mono">#${idx + 1}</td>
                        <td><strong>${escapeHtml(nj.profile || 'niedostępne')}</strong></td>
                        <td class="font-mono">${escapeHtml(nj.worktree_id || 'niedostępne')}</td>
                        <td>
                          <span class="badge ${active ? 'badge-warning' : (health.stop_requested ? 'badge-danger' : 'badge-info')}">
                            ${active ? (idx === 0 ? 'Oczekuje na slot (zajęty 1/1)' : `Oczekuje w kolejce (pozycja #${idx + 1})`) : (health.stop_requested ? 'Pauza operatora (Drain)' : 'Gotowy do wykonania')}
                          </span>
                        </td>
                      </tr>
                    `).join('')}
                  </tbody>
                </table>
              </div>
            ` : `
              <p class="empty-hint">Kolejka oczekujących jest pusta.</p>
            `}
          </div>
        </section>

        <section class="section-card">
          <h2 class="section-title">Ostatnie zdarzenia i incydenty</h2>
          <div class="incidents-list">
            ${incidents.length > 0 ? `
              <ul class="incident-items">
                ${incidents.map(inc => `
                  <li class="incident-item incident-${inc.level || 'info'}">
                    <span class="incident-icon">${inc.level === 'CRITICAL' ? '⛔' : inc.level === 'WARN' ? '⚠️' : 'ℹ️'}</span>
                    <div class="incident-body">
                      <div class="incident-msg">${escapeHtml(inc.message || inc.title)}</div>
                      <div class="incident-time font-mono">${formatRelative(inc.timestamp || inc.started_at || inc.time)}</div>
                    </div>
                  </li>
                `).join('')}
              </ul>
            ` : `
              <div class="healthy-state">
                <span class="healthy-icon">✓</span>
                <span class="healthy-text">Brak aktywnych incydentów ani awarii. Koordynator pracuje stabilnie.</span>
              </div>
            `}
          </div>
        </section>
      </div>
    </div>
  `;

  // Attach event handlers
    container.querySelector('#btn-active-details')?.addEventListener('click', (e) => {
      state.openJobDetails(e.currentTarget.getAttribute('data-job-id'));
    });

    container.querySelector('#btn-active-logs')?.addEventListener('click', (e) => {
      state.openJobDetails(e.currentTarget.getAttribute('data-job-id'), 'logs');
    });

    container.querySelector('#btn-active-cancel')?.addEventListener('click', async (e) => {
      const jobId = e.currentTarget.getAttribute('data-job-id');
      if (confirm(`Czy na pewno chcesz anulować zadanie ${jobId}?`)) {
        try {
          await api.cancelJob(jobId);
          await state.refresh();
        } catch (err) {
          alert('Błąd podczas anulowania zadania: ' + err.message);
        }
      }
    });

    container.querySelector('#btn-go-queue')?.addEventListener('click', () => {
      state.setView('queue');
    });

    if (typeof window !== 'undefined' && window.scrollTo && scrollY) {
      window.scrollTo(0, scrollY);
    }
    if (container.scrollTop !== undefined && scrollTop) {
      container.scrollTop = scrollTop;
    }
  }

  renderContent();

  return {
    update: () => renderContent(),
  };
}

function renderTrendCharts(trends) {
  if (!trends || trends.length === 0) {
    return `<div class="empty-hint">Brak zgromadzonych próbek telemetrycznych.</div>`;
  }

  // Generate SVG sparkline charts for Disk Free, Growth, RAM, CPU, I/O
  const points = trends.slice(-20);
  const w = 400;
  const h = 80;

  function renderChartPath(values, minBound, maxBound, strokeColor) {
    const valid = values.filter(v => v !== null && v !== undefined && !Number.isNaN(v));
    if (valid.length === 0) {
      return `<text x="${w / 2}" y="${h / 2 + 4}" text-anchor="middle" fill="var(--text-muted)" font-size="12">niedostępne</text>`;
    }
    const actualMin = minBound !== undefined ? Math.min(minBound, Math.min(...valid)) : Math.min(...valid);
    const actualMax = maxBound !== undefined ? Math.max(maxBound, Math.max(...valid)) : Math.max(...valid);
    const range = (actualMax - actualMin) || 1;

    let pathD = '';
    let circles = '';
    let inSegment = false;
    let segLen = 0;
    let lastX = 0, lastY = 0;

    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (v === null || v === undefined || Number.isNaN(v)) {
        if (inSegment && segLen === 1) {
          circles += `<circle cx="${lastX}" cy="${lastY}" r="3" fill="${strokeColor}" />`;
        }
        inSegment = false;
        segLen = 0;
        continue;
      }
      const x = values.length > 1 ? (i / (values.length - 1)) * (w - 20) + 10 : w / 2;
      const y = h - 10 - ((v - actualMin) / range) * (h - 20);
      lastX = Number(x.toFixed(1));
      lastY = Number(y.toFixed(1));

      if (!inSegment) {
        pathD += ` M ${lastX} ${lastY}`;
        inSegment = true;
        segLen = 1;
      } else {
        pathD += ` L ${lastX} ${lastY}`;
        segLen++;
      }
    }
    if (inSegment && segLen === 1) {
      circles += `<circle cx="${lastX}" cy="${lastY}" r="3" fill="${strokeColor}" />`;
    }

    let svgMarkup = '';
    if (pathD.trim()) {
      svgMarkup += `<path fill="none" stroke="${strokeColor}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" d="${pathD.trim()}" />`;
    }
    if (circles) {
      svgMarkup += circles;
    }
    return svgMarkup;
  }

  const diskVals = points.map(p => (p.disk_free_gb !== null && p.disk_free_gb !== undefined && !Number.isNaN(p.disk_free_gb)) ? p.disk_free_gb : null);
  const validDisks = diskVals.filter(v => v !== null);
  const minDisk = validDisks.length > 0 ? Math.min(...validDisks) - 1 : undefined;
  const maxDisk = validDisks.length > 0 ? Math.max(...validDisks) + 1 : undefined;
  const diskPath = renderChartPath(diskVals, minDisk, maxDisk, 'var(--status-success)');

  const growthVals = points.map(p => (p.storage_growth_mb !== null && p.storage_growth_mb !== undefined && !Number.isNaN(p.storage_growth_mb)) ? p.storage_growth_mb : null);
  const validGrowths = growthVals.filter(v => v !== null);
  const minGrowth = validGrowths.length > 0 ? Math.min(0, Math.min(...validGrowths)) : undefined;
  const maxGrowth = validGrowths.length > 0 ? Math.max(10, Math.max(...validGrowths) + 5) : undefined;
  const growthPath = renderChartPath(growthVals, minGrowth, maxGrowth, 'var(--accent)');

  const ramVals = points.map(p => (p.ram_mb !== null && p.ram_mb !== undefined && !Number.isNaN(p.ram_mb)) ? p.ram_mb : null);
  const validRams = ramVals.filter(v => v !== null);
  const minRam = validRams.length > 0 ? Math.min(...validRams) - 10 : undefined;
  const maxRam = validRams.length > 0 ? Math.max(...validRams) + 10 : undefined;
  const ramPath = renderChartPath(ramVals, minRam, maxRam, 'var(--accent)');

  const cpuVals = points.map(p => (p.cpu_percent !== null && p.cpu_percent !== undefined && !Number.isNaN(p.cpu_percent)) ? p.cpu_percent : null);
  const validCpus = cpuVals.filter(v => v !== null);
  const minCpu = validCpus.length > 0 ? 0 : undefined;
  const maxCpu = validCpus.length > 0 ? Math.max(10, Math.max(...validCpus) + 5) : undefined;
  const cpuPath = renderChartPath(cpuVals, minCpu, maxCpu, 'var(--status-warning)');

  const ioVals = points.map(p => (p.io_mb_s !== null && p.io_mb_s !== undefined && !Number.isNaN(p.io_mb_s)) ? p.io_mb_s : null);
  const validIos = ioVals.filter(v => v !== null);
  const minIo = validIos.length > 0 ? 0 : undefined;
  const maxIo = validIos.length > 0 ? Math.max(2, Math.max(...validIos) + 0.5) : undefined;
  const ioPath = renderChartPath(ioVals, minIo, maxIo, 'var(--status-info)');

  const lastPoint = points[points.length - 1] || {};
  const diskLatestStr = lastPoint.disk_free_gb !== null && lastPoint.disk_free_gb !== undefined ? `${lastPoint.disk_free_gb.toFixed(1)} GiB` : 'niedostępne';
  const growthLatestStr = lastPoint.storage_growth_mb !== null && lastPoint.storage_growth_mb !== undefined ? `${lastPoint.storage_growth_mb >= 0 ? '+' : ''}${lastPoint.storage_growth_mb.toFixed(1)} MiB` : 'niedostępne';
  const ramLatestStr = lastPoint.ram_mb !== null && lastPoint.ram_mb !== undefined ? `${lastPoint.ram_mb.toFixed(0)} MiB` : 'niedostępne';
  const cpuLatestStr = lastPoint.cpu_percent !== null && lastPoint.cpu_percent !== undefined ? `${lastPoint.cpu_percent.toFixed(1)}%` : 'niedostępne';
  const ioLatestStr = lastPoint.io_mb_s !== null && lastPoint.io_mb_s !== undefined ? `${lastPoint.io_mb_s.toFixed(2)} MB/s` : 'niedostępne';

  return `
    <div class="charts-grid">
      <div class="chart-box">
        <div class="chart-header">
          <span class="chart-label">Wolny dysk (GiB)</span>
          <span class="chart-latest font-mono">${diskLatestStr}</span>
        </div>
        <svg class="chart-svg" viewBox="0 0 ${w} ${h}">
          ${diskPath}
        </svg>
      </div>

      <div class="chart-box">
        <div class="chart-header">
          <span class="chart-label">Przyrost storage (MiB)</span>
          <span class="chart-latest font-mono">${growthLatestStr}</span>
        </div>
        <svg class="chart-svg" viewBox="0 0 ${w} ${h}">
          ${growthPath}
        </svg>
      </div>

      <div class="chart-box">
        <div class="chart-header">
          <span class="chart-label">RAM Workera (MiB)</span>
          <span class="chart-latest font-mono">${ramLatestStr}</span>
        </div>
        <svg class="chart-svg" viewBox="0 0 ${w} ${h}">
          ${ramPath}
        </svg>
      </div>

      <div class="chart-box">
        <div class="chart-header">
          <span class="chart-label">Użycie CPU (%)</span>
          <span class="chart-latest font-mono">${cpuLatestStr}</span>
        </div>
        <svg class="chart-svg" viewBox="0 0 ${w} ${h}">
          ${cpuPath}
        </svg>
      </div>

      <div class="chart-box">
        <div class="chart-header">
          <span class="chart-label">Operacje I/O (MB/s)</span>
          <span class="chart-latest font-mono">${ioLatestStr}</span>
        </div>
        <svg class="chart-svg" viewBox="0 0 ${w} ${h}">
          ${ioPath}
        </svg>
      </div>
    </div>
  `;
}
