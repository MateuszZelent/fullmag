import { state } from '../state.js';
import { api } from '../api.js';
import { formatBytes, formatTimestamp, renderStatusBadge, escapeHtml } from '../utils.js';

export function renderStorageView(container) {
  let volumes = null;
  let resourcesData = null;
  let activePlan = null;
  let volumesError = null;
  let resourcesError = null;
  let storageLoadGeneration = 0;

  container.innerHTML = `
    <div class="view-container storage-view">
      <div class="view-header-actions">
        <div>
          <h1 class="view-title">Pojemność storage i inwentaryzacja zasobów</h1>
          <p class="view-subtitle">Zarządzanie wolumenami dyskowymi, alokacją klas danych i audytowalną retencją</p>
        </div>
        <div class="header-btns">
          <button class="btn btn-secondary btn-sm" id="btn-storage-refresh">↻ Odśwież stan</button>
          <button class="btn btn-primary btn-sm" id="btn-create-plan">🔍 Przygotuj plan retencji</button>
        </div>
      </div>

      <!-- Plan Preview Section (Hidden initially) -->
      <section class="section-card retention-plan-card" id="retention-plan-section" style="display: none;">
        <div class="card-header-flex">
          <div>
            <h2 class="section-title">Podgląd planu retencji (Audytowany preview)</h2>
            <span class="section-subtitle" id="plan-metadata"></span>
          </div>
          <div>
            <button class="btn btn-secondary btn-sm" id="btn-apply-plan">⚡ Wykonaj plan (Tryb podglądu / Preview)</button>
          </div>
        </div>
        <div id="plan-content-container"></div>
      </section>

      <!-- Volumes Overview Table -->
      <section class="section-card">
        <h2 class="section-title">Wolumeny fizyczne i punkty montowania</h2>
        <div id="volumes-table-container">
          <div class="loading-spinner">Wczytywanie informacji o wolumenach...</div>
        </div>
      </section>

      <!-- Category Breakdown & Inventory -->
      <section class="section-card">
        <h2 class="section-title">Podział klas danych w storage projektu</h2>
        <div id="categories-breakdown-container">
          <div class="loading-spinner">Wczytywanie podziału klas storage...</div>
        </div>
      </section>

      <!-- Detailed Resources Inventory -->
      <section class="section-card">
        <h2 class="section-title">Inwentaryzacja zasobów, worktree i kapsuł źródeł</h2>
        <p class="section-subtitle">Wszystkie zarejestrowane katalogi execution, staging, source capsules oraz status ochrony</p>
        <div id="resources-table-container">
          <div class="loading-spinner">Wczytywanie szczegółowej inwentaryzacji zasobów...</div>
        </div>
      </section>
    </div>
  `;

  // Attach button actions
  container.querySelector('#btn-storage-refresh')?.addEventListener('click', () => loadStorageData());
  container.querySelector('#btn-create-plan')?.addEventListener('click', async () => {
    const btn = container.querySelector('#btn-create-plan');
    if (btn) btn.disabled = true;
    try {
      const plan = await api.createRetentionPlan();
      activePlan = plan;
      renderPlan(plan);
    } catch (err) {
      alert('Błąd generowania planu: ' + err.message);
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  container.querySelector('#btn-apply-plan')?.addEventListener('click', async () => {
    if (!activePlan) return;
    if (confirm(`Czy na pewno wykonać plan retencji ${activePlan.plan_id}? Operacja jest restartowalna i bezpieczna.`)) {
      try {
        const res = await api.applyRetentionPlan(activePlan.plan_id);
        if (res && res.status === 'preview_only') {
          alert(`Tryb podglądu (Preview): ${res.message || 'Wykonawca automatycznego usuwania nie jest włączony.'}`);
          activePlan.status = 'preview_only';
          renderPlan();
          return;
        }
        if (!res || res.applied !== true) {
          const errMsg = res?.error || res?.message || 'Plan nie został wykonany (applied != true).';
          alert('Błąd wykonania retencji: ' + errMsg);
          return;
        }
        alert(res.message || 'Plan retencji został pomyślnie wykonany w trybie bezpiecznym.');
        loadStorageData();
      } catch (err) {
        alert('Błąd wykonania retencji: ' + err.message);
      }
    }
  });

  async function loadStorageData() {
    const generation = ++storageLoadGeneration;
    volumesError = null;
    resourcesError = null;

    // Keep the last good response visible during a refresh. On the initial
    // load the null values leave the individual sections on their own spinner.
    renderVolumes(volumes, volumesError);
    renderCategories(resourcesData, resourcesError);
    renderResourcesTable(resourcesData, resourcesError);

    // The volume endpoint is cheap and must render even when the recursive
    // resource scan is slow or unavailable. Do not await either request here:
    // each section owns its response, error state, and timeout.
    Promise.resolve()
      .then(() => api.getStorageVolumes({ timeoutMs: 5000, retries: 1 }))
      .then((value) => {
        if (generation !== storageLoadGeneration) return;
        volumes = value;
        volumesError = null;
        renderVolumes(volumes, volumesError);
      })
      .catch((err) => {
        if (generation !== storageLoadGeneration) return;
        volumes = null;
        volumesError = err;
        renderVolumes(null, volumesError);
      });

    Promise.resolve()
      .then(() => api.getStorageResources({ timeoutMs: 7000, retries: 1 }))
      .then((value) => {
        if (generation !== storageLoadGeneration) return;
        resourcesData = value;
        resourcesError = null;
        renderCategories(resourcesData, resourcesError);
        renderResourcesTable(resourcesData, resourcesError);
      })
      .catch((err) => {
        if (generation !== storageLoadGeneration) return;
        resourcesData = null;
        resourcesError = err;
        renderCategories(null, resourcesError);
        renderResourcesTable(null, resourcesError);
      });
  }

  function renderVolumes(vols, err = null) {
    const el = container.querySelector('#volumes-table-container');
    if (!el) return;

    if (err) {
      const statusLabel = state.connectionStatus === 'disconnected' ? 'Rozłączono z koordynatorem' : 'Błąd odczytu wolumenów';
      el.innerHTML = `
        <div class="error-box">
          <strong>${statusLabel}:</strong> ${escapeHtml(err.message || 'Nie udało się pobrać danych o wolumenach.')}
        </div>
      `;
      return;
    }

    if (vols === null) {
      el.innerHTML = '<div class="loading-spinner">Wczytywanie informacji o wolumenach...</div>';
      return;
    }

    if (!vols || vols.length === 0) {
      el.innerHTML = '<p class="empty-hint">Brak skonfigurowanych wolumenów storage.</p>';
      return;
    }

    el.innerHTML = `
      <div class="table-responsive">
        <table class="data-table">
          <thead>
            <tr>
              <th>Wolumen</th>
              <th>Punkt montowania</th>
              <th>Pojemność</th>
              <th>Zajęte</th>
              <th>Wolne miejsce</th>
              <th>Rezerwacja</th>
              <th>Próg ostrzegawczy</th>
              <th>Stan</th>
            </tr>
          </thead>
          <tbody>
            ${vols.map(v => {
              const usedPct = v.total_bytes ? Math.round((v.used_bytes / v.total_bytes) * 100) : 0;
              return `
                <tr>
                  <td><strong>${escapeHtml(v.name)}</strong></td>
                  <td class="font-mono">${escapeHtml(v.mount_point)}</td>
                  <td class="font-mono">${formatBytes(v.total_bytes)}</td>
                  <td class="font-mono">${formatBytes(v.used_bytes)} (${usedPct}%)</td>
                  <td class="font-mono font-bold">${formatBytes(v.free_bytes)}</td>
                  <td class="font-mono">${formatBytes(v.reserved_bytes)}</td>
                  <td class="font-mono">${formatBytes(v.warning_threshold_bytes)}</td>
                  <td>${renderStatusBadge(v.status || 'unavailable')}</td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  function renderCategories(resData, err = null) {
    const el = container.querySelector('#categories-breakdown-container');
    if (!el) return;

    if (err) {
      const statusLabel = state.connectionStatus === 'disconnected' ? 'Rozłączono z koordynatorem' : 'Błąd inwentaryzacji zasobów';
      el.innerHTML = `
        <div class="error-box">
          <strong>${statusLabel}:</strong> ${escapeHtml(err.message || 'Nie udało się pobrać danych inwentaryzacji storage.')}
        </div>
      `;
      return;
    }

    if (resData === null) {
      el.innerHTML = '<div class="loading-spinner">Wczytywanie podziału klas storage...</div>';
      return;
    }

    if (!resData || !resData.categories || resData.categories.length === 0) {
      el.innerHTML = '<p class="empty-hint">Brak danych inwentaryzacji klas storage.</p>';
      return;
    }

    const cats = resData.categories;
    const totalBytes = resData.total_measured_bytes || 1;
    const measuredAt = resData.measured_at ? new Date(resData.measured_at).getTime() : null;
    const isStale = state.connectionStatus === 'stale' || (measuredAt !== null && !Number.isNaN(measuredAt) && (Date.now() - measuredAt > 120000));

    function getCompletenessBadge(cat) {
      if (err || cat.error) {
        return '<span class="badge badge-danger">Błąd skanu</span>';
      }
      if (state.connectionStatus === 'disconnected') {
        return '<span class="badge badge-danger">Rozłączony</span>';
      }
      if (isStale) {
        return '<span class="badge badge-warning">Nieaktualny (stale)</span>';
      }
      const comp = cat.completeness;
      if (comp === 'partial' || comp === 'częściowy' || comp === 'part') {
        return '<span class="badge badge-warning">Częściowy</span>';
      }
      if (comp === 'complete' || comp === 'pełny' || comp === '100%') {
        return '<span class="badge badge-success">Pełny (100%)</span>';
      }
      if (typeof comp === 'number') {
        if (comp >= 100) return '<span class="badge badge-success">Pełny (100%)</span>';
        if (comp <= 0) return '<span class="badge badge-danger">Brak (0%)</span>';
        return `<span class="badge badge-warning">Częściowy (${comp}%)</span>`;
      }
      if (comp) {
        return `<span class="badge badge-muted">${escapeHtml(String(comp))}</span>`;
      }
      return '<span class="badge badge-muted">Nieznana</span>';
    }

    el.innerHTML = `
      <div class="storage-bar-wrapper">
        <div class="storage-bar">
          ${cats.map((c, i) => {
            const pct = Math.max(1, Math.round((c.logical_bytes / totalBytes) * 100));
            const colors = ['#0071e3', '#34c759', '#ff9500', '#af52de', '#5856d6', '#ff2d55', '#64d2ff', '#a2845e', '#8e8e93'];
            return `
              <div class="storage-segment" style="width: ${pct}%; background-color: ${colors[i % colors.length]};" title="${escapeHtml(c.name)}: ${formatBytes(c.logical_bytes)} (${pct}%)"></div>
            `;
          }).join('')}
        </div>
      </div>

      <div class="table-responsive">
        <table class="data-table">
          <thead>
            <tr>
              <th>Klasa danych</th>
              <th>Zajęte miejsce</th>
              <th>Liczba plików</th>
              <th>Kompletność skanu</th>
              <th>Kwalifikuje się do retencji</th>
              <th>Szacowany odzysk</th>
            </tr>
          </thead>
          <tbody>
            ${cats.map(c => `
              <tr>
                <td><strong>${escapeHtml(c.name)}</strong></td>
                <td class="font-mono">${formatBytes(c.logical_bytes)}</td>
                <td class="font-mono">${c.file_count !== undefined && c.file_count !== null ? c.file_count : 'niedostępne'}</td>
                <td>${getCompletenessBadge(c)}</td>
                <td class="font-mono">${formatBytes(c.eligible_cleanup_bytes)}</td>
                <td class="font-mono font-bold text-success">${formatBytes(c.reclaimable_bytes)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  function renderPlan(plan) {
    const sec = container.querySelector('#retention-plan-section');
    const meta = container.querySelector('#plan-metadata');
    const content = container.querySelector('#plan-content-container');
    if (!sec || !content) return;

    sec.style.display = 'block';
    meta.textContent = `ID: ${plan.plan_id} • Polityka v${plan.policy_version} • Data: ${formatTimestamp(plan.created_at)}`;

    content.innerHTML = `
      <div class="plan-summary-grid">
        <div class="plan-summary-box">
          <span class="plan-box-label">Szacowane zwolnione miejsce:</span>
          <span class="plan-box-val text-success font-mono font-bold">${formatBytes(plan.estimated_reclaimed_bytes)}</span>
        </div>
        <div class="plan-summary-box">
          <span class="plan-box-label">Liczba kandydatów do usunięcia:</span>
          <span class="plan-box-val font-mono">${plan.candidates_count}</span>
        </div>
        <div class="plan-summary-box">
          <span class="plan-box-label">Zasoby chronione (pozostające):</span>
          <span class="plan-box-val font-mono">${plan.retained_count}</span>
        </div>
      </div>

      <h3 class="subsection-title">Kandydaci do usunięcia w tym planie:</h3>
      ${plan.candidates && plan.candidates.length > 0 ? `
        <div class="table-responsive">
          <table class="data-table">
            <thead>
              <tr>
                <th>Zasób</th>
                <th>Ścieżka</th>
                <th>Rozmiar</th>
                <th>Uzasadnienie kwalifikacji</th>
              </tr>
            </thead>
            <tbody>
              ${plan.candidates.map(c => `
                <tr>
                  <td><strong>${escapeHtml(c.name)}</strong></td>
                  <td class="font-mono font-small">${escapeHtml(c.path)}</td>
                  <td class="font-mono">${formatBytes(c.size_bytes)}</td>
                  <td>${escapeHtml(c.reason)}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      ` : `
        <p class="empty-hint">Brak kwalifikujących się zasobów do usunięcia w tym planie.</p>
      `}
    `;
  }

  function renderResourcesTable(resData, err = null) {
    const el = container.querySelector('#resources-table-container');
    if (!el) return;

    if (err) {
      el.innerHTML = `
        <div class="error-box">
          <strong>Błąd inwentarza zasobów:</strong> ${escapeHtml(err.message || 'Nie udało się pobrać szczegółowych zasobów storage.')}
        </div>
      `;
      return;
    }

    if (resData === null) {
      el.innerHTML = '<div class="loading-spinner">Wczytywanie szczegółowej inwentaryzacji zasobów...</div>';
      return;
    }

    if (!resData || !resData.resources || resData.resources.length === 0) {
      el.innerHTML = '<p class="empty-hint">Brak zarejestrowanych zasobów w storage.</p>';
      return;
    }

    const items = resData.resources;

    el.innerHTML = `
      <div class="table-responsive">
        <table class="data-table">
          <thead>
            <tr>
              <th>Zasób / Nazwa</th>
              <th>Kategoria</th>
              <th>Rozmiar</th>
              <th>Pliki</th>
              <th>Dlaczego zostaje (Uzasadnienie ochrony)</th>
              <th>Akcja</th>
            </tr>
          </thead>
          <tbody>
            ${items.map(item => `
              <tr>
                <td>
                  <strong>${escapeHtml(item.name)}</strong>
                  <div class="font-mono font-small text-muted">${escapeHtml(item.path)}</div>
                </td>
                <td><span class="badge badge-muted">${escapeHtml(item.category)}</span></td>
                <td class="font-mono font-bold">${formatBytes(item.size_bytes)}</td>
                <td class="font-mono">${item.file_count || 1}</td>
                <td>
                  <span class="protection-tag ${item.pinned ? 'protection-pinned' : ''}">
                    ${item.pinned ? '📌 ' : ''}${escapeHtml(item.why_retained)}
                  </span>
                </td>
                <td>
                  <button class="btn btn-sm ${item.pinned ? 'btn-warning' : 'btn-secondary'} btn-pin-toggle"
                    data-id="${escapeHtml(item.resource_id)}" data-pinned="${item.pinned ? 'true' : 'false'}">
                    ${item.pinned ? 'Odepnij (Unpin)' : 'Przypnij (Pin)'}
                  </button>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;

    el.querySelectorAll('.btn-pin-toggle').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const id = e.currentTarget.getAttribute('data-id');
        const currentlyPinned = e.currentTarget.getAttribute('data-pinned') === 'true';
        try {
          await api.pinResource(id, !currentlyPinned, currentlyPinned ? '' : 'Przypięte ręcznie z panelu Storage');
          loadStorageData();
        } catch (err) {
          alert('Błąd pinowania: ' + err.message);
        }
      });
    });
  }

  loadStorageData();

  return {
    update: () => {
      loadStorageData();
    },
    destroy: () => {},
  };
}
