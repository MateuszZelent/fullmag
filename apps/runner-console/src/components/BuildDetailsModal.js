import { state } from '../state.js';
import { api } from '../api.js';
import { formatBytes, formatDuration, formatRelative, formatTimestamp, renderStatusBadge, escapeHtml } from '../utils.js';

export function renderBuildDetailsModal(container) {
  const jobId = state.selectedJobId;
  if (!jobId) {
    container.innerHTML = '';
    return {
      destroy: () => {},
      update: () => {},
    };
  }

  let activeTab = state.selectedJobTab || 'timeline';
  let jobData = null;
  let logsData = null;
  let resourcesData = null;
  let metricsData = null;
  let refreshTimer = null;
  let logSearchQuery = '';

  container.innerHTML = `
    <div class="modal-backdrop">
      <div class="modal-card modal-lg">
        <div class="modal-header">
          <div>
            <h2 class="modal-title">Szczegóły zadania: <span class="font-mono">${escapeHtml(jobId)}</span></h2>
            <span class="modal-subtitle" id="modal-subheading">Ładowanie danych zadania...</span>
          </div>
          <button class="btn btn-icon btn-close" id="btn-close-modal">✕</button>
        </div>

        <!-- Tabs Navigation -->
        <div class="modal-tabs">
          <button class="modal-tab ${activeTab === 'timeline' ? 'active' : ''}" data-tab="timeline">1. Przebieg (Timeline)</button>
          <button class="modal-tab ${activeTab === 'logs' ? 'active' : ''}" data-tab="logs">2. Logi na żywo</button>
          <button class="modal-tab ${activeTab === 'resources' ? 'active' : ''}" data-tab="resources">3. Zasoby (RAM/CPU)</button>
          <button class="modal-tab ${activeTab === 'files' ? 'active' : ''}" data-tab="files">4. Pliki i Storage</button>
          <button class="modal-tab ${activeTab === 'artifacts' ? 'active' : ''}" data-tab="artifacts">5. Źródła i Wynik (Receipt)</button>
          <button class="modal-tab ${activeTab === 'cleanup' ? 'active' : ''}" data-tab="cleanup">6. Sprzątanie i Retencja</button>
        </div>

        <div class="modal-body" id="modal-tab-content">
          <div class="loading-spinner">Ładowanie szczegółów zadania...</div>
        </div>

        <div class="modal-footer">
          <div id="modal-footer-left"></div>
          <button class="btn btn-secondary" id="btn-modal-close-footer">Zamknij</button>
        </div>
      </div>
    </div>
  `;

  function startAutoRefresh() {
    stopAutoRefresh();
    refreshTimer = setInterval(() => {
      if (typeof document !== 'undefined' && container && typeof document.contains === 'function' && !document.contains(container)) {
        stopAutoRefresh();
        return;
      }
      loadData(true);
    }, 2500);
    if (refreshTimer && typeof refreshTimer.unref === 'function') {
      refreshTimer.unref();
    }
  }

  function stopAutoRefresh() {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
  }

  const closeFn = () => {
    stopAutoRefresh();
    if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
      window.removeEventListener('keydown', onKeyDown);
    }
    state.closeJobDetails();
  };

  const onKeyDown = (e) => {
    if (e.key === 'Escape') {
      closeFn();
    }
  };
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('keydown', onKeyDown);
  }

  container.querySelector('.modal-backdrop')?.addEventListener('click', (e) => {
    if (e.target && e.target.classList && e.target.classList.contains('modal-backdrop')) {
      closeFn();
    }
  });

  function switchTab(newTab) {
    activeTab = newTab;
    state.selectedJobTab = activeTab;
    container.querySelectorAll('.modal-tab').forEach(b => {
      if (b.getAttribute('data-tab') === activeTab) {
        if (b.classList?.add) b.classList.add('active');
      } else {
        if (b.classList?.remove) b.classList.remove('active');
      }
    });
    renderTabContent();
  }

  // Attach tab switching
  container.querySelectorAll('.modal-tab').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const tab = e.currentTarget.getAttribute('data-tab');
      switchTab(tab);
    });
  });

  container.querySelector('#btn-close-modal')?.addEventListener('click', closeFn);
  container.querySelector('#btn-modal-close-footer')?.addEventListener('click', closeFn);

  async function loadData(isBackground = false) {
    try {
      const [job, logs, res, metrics, pol] = await Promise.all([
        api.getJobDetail(jobId).catch(() => null),
        api.getJobLogs(jobId).catch(() => null),
        api.getJobResources(jobId).catch(() => []),
        api.getJobMetrics(jobId).catch(() => []),
        state.policiesData ? Promise.resolve(state.policiesData) : api.getRetentionPolicy().catch(() => null),
      ]);
      jobData = job;
      logsData = logs;
      resourcesData = res;
      metricsData = metrics;
      if (pol && !state.policiesData) {
        state.policiesData = pol;
      }

      const sub = container.querySelector('#modal-subheading');
      if (sub && jobData) {
        sub.innerHTML = `Profil: <strong>${escapeHtml(jobData.profile || 'niedostępne')}</strong> &bull; Status: ${renderStatusBadge(jobData.state)}`;
      }

      if (isBackground) {
        updateBackgroundContent();
      } else {
        renderTabContent();
      }
    } catch (err) {
      if (!isBackground) {
        const content = container.querySelector('#modal-tab-content');
        if (content) content.innerHTML = `<div class="error-box">Błąd: ${escapeHtml(err.message)}</div>`;
      }
    }
  }

  function updateBackgroundContent() {
    if (!jobData) return;
    if (state.selectedJobTab && state.selectedJobTab !== activeTab) {
      switchTab(state.selectedJobTab);
      return;
    }

    if (activeTab === 'timeline') {
      renderTabContent();
    } else if (activeTab === 'logs') {
      const pre = container.querySelector('#pre-tab-logs');
      if (pre) {
        const logsText = typeof logsData === 'string' ? logsData : (logsData?.tail || logsData?.logs || 'Brak zapisanych logów dla tego zadania.');
        const isNearBottom = (pre.scrollHeight - pre.scrollTop - pre.clientHeight) < 60;
        if (!logSearchQuery) {
          pre.textContent = logsText;
        } else {
          const filteredLines = logsText.split('\n').filter(line => line.toLowerCase().includes(logSearchQuery));
          pre.textContent = filteredLines.length > 0 ? filteredLines.join('\n') : 'Brak pasujących linii logu.';
        }
        if (isNearBottom) {
          pre.scrollTop = pre.scrollHeight;
        }
      } else {
        renderTabContent();
      }
    } else if (activeTab === 'resources') {
      renderTabContent();
    } else if (activeTab === 'files') {
      renderTabContent();
    } else if (activeTab === 'cleanup') {
      renderTabContent();
    }
    updateFooter();
  }

  function updateFooter() {
    const footerLeft = container.querySelector('#modal-footer-left');
    if (footerLeft && jobData) {
      const execResId = `exec-${jobData.worktree_id || 'wt'}-${jobData.job_id}`;
      const isPinned = Boolean(jobData.is_pinned);
      footerLeft.innerHTML = `
        <button class="btn btn-sm ${isPinned ? 'btn-warning' : 'btn-secondary'}" id="btn-modal-pin-toggle">
          ${isPinned ? '📌 Odepnij zasoby buildu (Unpin)' : '📌 Przypnij zasoby buildu (Pin)'}
        </button>
      `;
      footerLeft.querySelector('#btn-modal-pin-toggle')?.addEventListener('click', async () => {
        try {
          const newPinned = !isPinned;
          await api.pinResource(
            execResId,
            newPinned,
            newPinned ? `Przypięte z okna zadania ${jobData.job_id}` : ''
          );
          jobData.is_pinned = newPinned;
          jobData.pin_reason = newPinned ? `Przypięte z okna zadania ${jobData.job_id}` : '';
          renderTabContent();
          alert(newPinned ? `Zasoby zadania ${jobData.job_id} zostały zabezpieczone przed retencją.` : `Zasoby zadania ${jobData.job_id} zostały odpięte.`);
        } catch (err) {
          alert('Błąd pinowania: ' + err.message);
        }
      });
    }
  }

  function renderTabContent() {
    const content = container.querySelector('#modal-tab-content');
    if (!content) return;

    if (!jobData) {
      content.innerHTML = `<div class="loading-spinner">Wczytywanie danych...</div>`;
      return;
    }

    if (activeTab === 'timeline') {
      const stages = jobData.stages || [];

      content.innerHTML = `
        <div class="timeline-container">
          <h3 class="subsection-title">Sekwencja etapów wykonania:</h3>
          ${stages.length > 0 ? `
            <div class="timeline-steps">
              ${stages.map((st, i) => `
                <div class="timeline-step step-${st.status}">
                  <div class="step-num">${i + 1}</div>
                  <div class="step-info">
                    <div class="step-title">${escapeHtml(st.name)}</div>
                    <div class="step-meta">
                      Status: ${renderStatusBadge(st.status)}
                      ${st.duration_seconds ? `&bull; Czas: <span class="font-mono">${formatDuration(st.duration_seconds)}</span>` : ''}
                    </div>
                  </div>
                </div>
              `).join('')}
            </div>
          ` : `
            <div class="empty-hint" style="margin-bottom: 1.5rem;">Brak zarejestrowanych etapów dla tego zadania.</div>
          `}

          <div class="job-meta-box">
            <div><strong>Exit Code:</strong> <span class="font-mono">${jobData.exit_code !== undefined && jobData.exit_code !== null ? jobData.exit_code : (jobData.state === 'succeeded' ? '0' : 'n/a')}</span></div>
            <div><strong>Czas rozpoczęcia:</strong> <span class="font-mono">${formatTimestamp(jobData.started_at || jobData.created_at)}</span></div>
            <div><strong>Worktree ID:</strong> <span class="font-mono">${escapeHtml(jobData.worktree_id || 'n/a')}</span></div>
            <div><strong>Source Digest:</strong> <span class="font-mono">${escapeHtml(jobData.source_digest || 'n/a')}</span></div>
          </div>
        </div>
      `;
    } else if (activeTab === 'logs') {
      const logsText = typeof logsData === 'string' ? logsData : (logsData?.tail || logsData?.logs || 'Brak zapisanych logów dla tego zadania.');
      content.innerHTML = `
        <div class="logs-tab-container">
          <div class="logs-header-actions">
            <input type="text" id="inp-modal-log-search" class="form-input form-input-sm font-mono" placeholder="Szukaj w logach..." value="${escapeHtml(logSearchQuery)}" style="max-width: 250px;" />
            <div class="btn-group">
              <button class="btn btn-secondary btn-sm" id="btn-copy-tab-logs">Kopiuj logi</button>
              <button class="btn btn-secondary btn-sm" id="btn-download-tab-logs">Pobierz .txt</button>
            </div>
          </div>
          <pre class="log-pre font-mono" id="pre-tab-logs">${escapeHtml(logsText)}</pre>
        </div>
      `;

      const pre = content.querySelector('#pre-tab-logs');
      content.querySelector('#inp-modal-log-search')?.addEventListener('input', (e) => {
        logSearchQuery = e.target.value.toLowerCase().trim();
        if (!logSearchQuery) {
          pre.textContent = logsText;
        } else {
          const filteredLines = logsText.split('\n').filter(line => line.toLowerCase().includes(logSearchQuery));
          pre.textContent = filteredLines.length > 0 ? filteredLines.join('\n') : 'Brak pasujących linii logu.';
        }
      });

      content.querySelector('#btn-copy-tab-logs')?.addEventListener('click', () => {
        navigator.clipboard.writeText(logsText).then(() => alert('Logi skopiowane do schowka.'));
      });

      content.querySelector('#btn-download-tab-logs')?.addEventListener('click', () => {
        const blob = new Blob([logsText], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `fullmag-${jobId}-logs.txt`;
        a.click();
        URL.revokeObjectURL(url);
      });
    } else if (activeTab === 'resources') {
      const metricsList = Array.isArray(metricsData) ? metricsData : [];
      const validRams = metricsList.map(m => m.ram_mb).filter(v => v !== null && v !== undefined && !Number.isNaN(v));
      const validCpus = metricsList.map(m => m.cpu_percent).filter(v => v !== null && v !== undefined && !Number.isNaN(v));
      const validGrowths = metricsList.map(m => m.storage_growth_mb).filter(v => v !== null && v !== undefined && !Number.isNaN(v));

      const hasMetrics = validRams.length > 0 || validCpus.length > 0 || validGrowths.length > 0;
      if (!hasMetrics) {
        content.innerHTML = `
          <div class="resources-tab-container">
            <h3 class="subsection-title">Wykorzystanie zasobów w trakcie kompilacji:</h3>
            <p class="empty-hint">Brak zarejestrowanych próbek telemetrycznych zużycia zasobów (RAM/CPU/storage) dla tego zadania.</p>
          </div>
        `;
        return;
      }

      const peakRam = validRams.length > 0 ? Math.max(...validRams) : null;
      const avgCpu = validCpus.length > 0 ? (validCpus.reduce((a, b) => a + b, 0) / validCpus.length) : null;
      const latestGrowth = validGrowths.length > 0 ? validGrowths[validGrowths.length - 1] : null;

      content.innerHTML = `
        <div class="resources-tab-container">
          <h3 class="subsection-title">Wykorzystanie zasobów w trakcie kompilacji:</h3>
          <div class="form-grid-3">
            <div class="stat-card">
              <span class="stat-label">Szczytowe zużycie RAM:</span>
              <span class="stat-val font-mono">${peakRam !== null ? (peakRam > 1024 ? (peakRam / 1024).toFixed(1) + ' GiB' : peakRam.toFixed(0) + ' MiB') : 'niedostępne'}</span>
              <span class="stat-hint">Pomiary cgroups/OS</span>
            </div>
            <div class="stat-card">
              <span class="stat-label">Średnie obciążenie CPU:</span>
              <span class="stat-val font-mono">${avgCpu !== null ? avgCpu.toFixed(1) + '%' : 'niedostępne'}</span>
              <span class="stat-hint">Przydzielone rdzenie procesora</span>
            </div>
            <div class="stat-card">
              <span class="stat-label">Przyrost storage:</span>
              <span class="stat-val font-mono">${latestGrowth !== null ? (latestGrowth >= 0 ? '+' : '') + latestGrowth.toFixed(1) + ' MiB' : 'niedostępne'}</span>
              <span class="stat-hint">Katalog roboczy execution</span>
            </div>
          </div>
        </div>
      `;
    } else if (activeTab === 'files') {
      let filesList = [];
      const isPinned = Boolean(jobData.is_pinned);
      if (Array.isArray(resourcesData) && resourcesData.length > 0) {
        filesList = resourcesData.map(item => {
          let prot = 'Niezmienna (Read-only)';
          let badge = 'badge-success';
          if (item.name === 'execution') {
            if (isPinned) {
              prot = '📌 Przypięty (Ochrona operatora)';
              badge = 'badge-warning';
            } else {
              prot = 'Kwalifikuje się do retencji';
              badge = 'badge-muted';
            }
          } else if (item.name === 'artifacts') {
            prot = 'Trwałe dowody i receipt';
            badge = 'badge-success';
          }
          return {
            name: item.name,
            path: item.path,
            size_bytes: item.size_bytes,
            file_count: item.file_count,
            protection: prot,
            badge,
          };
        });
      }

      if (filesList.length === 0) {
        content.innerHTML = `
          <div class="files-tab-container">
            <h3 class="subsection-title">Pliki i katalogi przypisane do zadania:</h3>
            <p class="empty-hint">Brak zarejestrowanych zasobów plików dla tego zadania w storage.</p>
          </div>
        `;
        return;
      }

      content.innerHTML = `
        <div class="files-tab-container">
          <h3 class="subsection-title">Pliki i katalogi przypisane do zadania:</h3>
          <div class="table-responsive">
            <table class="data-table">
              <thead>
                <tr>
                  <th>Kategoria</th>
                  <th>Ścieżka w storage</th>
                  <th>Rozmiar</th>
                  <th>Pliki</th>
                  <th>Status ochrony</th>
                </tr>
              </thead>
              <tbody>
                ${filesList.map(f => `
                  <tr>
                    <td><strong>${escapeHtml(f.name)}</strong></td>
                    <td class="font-mono font-small">${escapeHtml(f.path)}</td>
                    <td class="font-mono font-bold">${formatBytes(f.size_bytes)}</td>
                    <td class="font-mono">${f.file_count || 'niedostępne'}</td>
                    <td><span class="badge ${f.badge}">${escapeHtml(f.protection)}</span></td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        </div>
      `;
    } else if (activeTab === 'artifacts') {
      content.innerHTML = `
        <div class="artifacts-tab-container">
          <h3 class="subsection-title">Metadane receipt i artefakty wyjściowe:</h3>
          <div class="notice-box font-small text-muted" style="margin-bottom: 1rem;">
            ⚠️ Zgodnie z kontraktem Fullmag: Sukces kompilacji jest dowodem poprawności binarnej, ale NIE oznacza kwalifikacji fizyki ani automatycznej publikacji current.
          </div>
          ${jobData.receipt ? `
            <div class="receipt-box font-mono font-small">
              <pre>${escapeHtml(JSON.stringify(jobData.receipt, null, 2))}</pre>
            </div>
          ` : `
            <div class="empty-hint">Brak pliku receipt.json dla tego zadania. Kompilacja mogła jeszcze nie zostać ukończona lub zakończyła się błędem przed generacją potwierdzenia.</div>
          `}
        </div>
      `;
    } else if (activeTab === 'cleanup') {
      const isPinned = Boolean(jobData.is_pinned);
      const policy = state.policiesData;
      let ttlStr = 'niedostępne';
      if (jobData.state === 'running' || jobData.state === 'queued') {
        ttlStr = 'Zadanie aktywne (retencja po zakończeniu)';
      } else if (policy) {
        const hours = jobData.state === 'succeeded' ? policy.ttl_success_hours : policy.ttl_failure_hours;
        if (hours !== undefined && hours !== null) {
          ttlStr = hours % 24 === 0 ? `${hours / 24} dni (${hours}h)` : `${hours} godzin`;
        }
      } else {
        ttlStr = jobData.state === 'succeeded' ? 'Zgodnie ze skonfigurowaną polityką po sukcesie' : 'Zgodnie ze skonfigurowaną polityką po błędzie/anulowaniu';
      }

      content.innerHTML = `
        <div class="cleanup-tab-container">
          <h3 class="subsection-title">Status retencji i sprzątania dla tego zadania:</h3>
          <ul class="diag-list">
            <li>
              <span class="diag-label">Polityka retencji dla tego stanu:</span>
              <span>${escapeHtml(ttlStr)}</span>
            </li>
            <li>
              <span class="diag-label">Katalog execution:</span>
              ${isPinned ? `
                <span class="badge badge-warning">📌 Przypięty przez operatora: ${escapeHtml(jobData.pin_reason || 'Zabezpieczono przed retencją')}</span>
              ` : `
                <span class="badge badge-muted">Chroniony do upływu okna retencji</span>
              `}
            </li>
            <li>
              <span class="diag-label">Artefakty i logi:</span>
              <span class="badge badge-success">Chronione trwale (Receipt i journal)</span>
            </li>
            <li>
              <span class="diag-label">Współdzielony cache Cargo/pnpm:</span>
              <span class="badge badge-success">Nienaruszony (Izolacja zasobów)</span>
            </li>
          </ul>
        </div>
      `;
    }

    updateFooter();
  }

  loadData();
  startAutoRefresh();

  return {
    destroy: () => {
      stopAutoRefresh();
      if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
        window.removeEventListener('keydown', onKeyDown);
      }
    },
    update: (tab) => {
      const targetTab = tab || state.selectedJobTab;
      if (targetTab && targetTab !== activeTab) {
        switchTab(targetTab);
      }
      loadData(true);
    },
  };
}
