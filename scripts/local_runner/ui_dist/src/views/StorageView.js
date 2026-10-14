import { state } from '../state.js';
import { api } from '../api.js';
import { formatBytes, formatTimestamp, renderStatusBadge, escapeHtml } from '../utils.js';

export function renderStorageView(container) {
  let volumes = null;
  let resourcesData = null;
  let activePlan = null;
  let volumesError = null;
  let resourcesError = null;
  let resourcesRefreshing = false;
  let storageLoadGeneration = 0;
  let storageLoadPromise = null;
  let resourcesAbortController = null;
  let destroyed = false;
  let planObservation = 0;
  let planRequestGeneration = 0;
  let planSnapshotGeneration = 0;
  let createRequestGeneration = 0;
  let applyRequestGeneration = 0;
  let planPagePlanId = null;
  const planCollections = new Map();
  const savedPlanKey = 'fullmag-runner-retention-plan';
  const retentionPageLimit = 50;

  function resetPlanCollections(planId) {
    planCollections.clear();
    planPagePlanId = planId || null;
  }

  function beginPlanRequest({ invalidateObservation = true } = {}) {
    return {
      requestGeneration: ++planRequestGeneration,
      observation: invalidateObservation ? ++planObservation : planObservation,
      snapshotGeneration: planSnapshotGeneration,
    };
  }

  function isCurrentPlanRequest(request, planId) {
    return !destroyed &&
      request.requestGeneration === planRequestGeneration &&
      request.observation === planObservation &&
      request.snapshotGeneration === planSnapshotGeneration &&
      (activePlan?.plan_id || null) === planId;
  }

  function expectedCollectionStateIsCurrent(expected) {
    return !expected || (
      planCollections.get(expected.collection) === expected.state &&
      expected.state.revision === expected.revision
    );
  }

  function adoptPlanSnapshot(current) {
    const planId = current?.plan_id || null;
    if (planPagePlanId !== planId) resetPlanCollections(planId);

    if (current?.representation !== 'paged' || !current.collections || typeof current.collections !== 'object') {
      const priorCollectionNames = [...planCollections.keys()];
      if (planCollections.size) resetPlanCollections(planId);
      activePlan = { ...(activePlan?.plan_id === planId ? activePlan : {}) };
      for (const name of priorCollectionNames) delete activePlan[name];
      Object.assign(activePlan, current);
      return activePlan;
    }

    const metadata = current.collections;
    for (const [name, state] of planCollections) {
      if (!Object.prototype.hasOwnProperty.call(metadata, name)) {
        state.requestGeneration += 1;
        planCollections.delete(name);
      }
    }
    for (const [name, meta] of Object.entries(metadata)) {
      if (!meta || !Number.isSafeInteger(meta.total) || meta.total < 0 ||
          typeof meta.revision !== 'string' || !/^[a-f0-9]{64}$/.test(meta.revision)) {
        const invalid = planCollections.get(name);
        if (invalid) invalid.requestGeneration += 1;
        planCollections.delete(name);
        continue;
      }
      const initialRows = Array.isArray(current[name]) ? current[name] : [];
      const existing = planCollections.get(name);
      if (!existing || existing.revision !== meta.revision || existing.total !== meta.total) {
        planCollections.set(name, {
          revision: meta.revision,
          total: meta.total,
          rows: initialRows.slice(),
          nextCursor: meta.next_cursor,
          blocked: meta.blocked === true,
          error: meta.error || null,
          loading: false,
          requestGeneration: (existing?.requestGeneration || 0) + 1,
        });
      } else if (existing.rows.length === 0 && initialRows.length > 0) {
        existing.rows = initialRows.slice();
        existing.nextCursor = meta.next_cursor;
        existing.blocked = meta.blocked === true;
        existing.error = meta.error || null;
      }
    }

    activePlan = { ...(activePlan?.plan_id === planId ? activePlan : {}) };
    for (const [name, value] of Object.entries(activePlan)) {
      if (Array.isArray(value) && name !== 'omitted_fields' &&
          !Object.prototype.hasOwnProperty.call(metadata, name)) {
        delete activePlan[name];
      }
    }
    const snapshot = { ...current };
    for (const [name, value] of Object.entries(snapshot)) {
      if (Array.isArray(value) && name !== 'omitted_fields' &&
          !Object.prototype.hasOwnProperty.call(metadata, name)) {
        delete snapshot[name];
      }
    }
    Object.assign(activePlan, snapshot);
    for (const [name, state] of planCollections) activePlan[name] = state.rows;
    return activePlan;
  }

  container.innerHTML = `
    <div class="view-container storage-view">
      <div class="view-header-actions">
        <div>
          <h1 class="view-title">Pojemność storage i inwentaryzacja zasobów</h1>
          <p class="view-subtitle">Zarządzanie wolumenami dyskowymi, alokacją klas danych i audytowalną retencją</p>
        </div>
        <div class="header-btns">
          <label for="retention-scope">Zakres:</label>
          <select id="retention-scope" class="form-select">
            <option value="execution">Zakończone kopie robocze</option>
            <option value="sources">Współdzielenie źródeł</option>
            <option value="runtime">Stare paczki programu</option>
          </select>
          <button class="btn btn-secondary btn-sm" id="btn-storage-refresh">↻ Odśwież stan</button>
          <button class="btn btn-primary btn-sm" id="btn-create-plan">🔍 Przygotuj plan retencji</button>
        </div>
      </div>

      <!-- Plan Preview Section (Hidden initially) -->
      <section class="section-card retention-plan-card" id="retention-plan-section" style="display: none;">
        <div class="card-header-flex">
          <div>
            <h2 class="section-title" id="plan-title">Plan obsługi danych</h2>
            <span class="section-subtitle" id="plan-metadata"></span>
          </div>
          <div>
            <button class="btn btn-secondary btn-sm" id="btn-plan-refresh">Odśwież wynik operacji</button>
            <button class="btn btn-secondary btn-sm" id="btn-apply-plan" disabled>Usuń wskazane kopie robocze</button>
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
  container.querySelector('#btn-plan-refresh')?.addEventListener('click', async () => {
    const planId = activePlan?.plan_id;
    if (!planId) return;
    const request = beginPlanRequest({ invalidateObservation: false });
    let current;
    try {
      current = await api.getRetentionPlan(planId);
    } catch (err) {
      if (isCurrentPlanRequest(request, planId)) {
        alert(`Nie udało się odczytać operacji ${planId}: ${err.message}`);
      }
      return;
    }
    if (!isCurrentPlanRequest(request, planId)) return;
    const observation = observePlan(current);
    const observationId = planObservation;
    try { await observation; }
    catch (err) {
      if (!destroyed && activePlan?.plan_id === planId && planObservation === observationId) {
        alert(`Nie udało się odczytać operacji ${planId}: ${err.message}`);
      }
    }
  });
  container.querySelector('#btn-create-plan')?.addEventListener('click', async () => {
    const btn = container.querySelector('#btn-create-plan');
    if (btn) btn.disabled = true;
    const createGeneration = ++createRequestGeneration;
    const previousPlanId = activePlan?.plan_id || null;
    const request = beginPlanRequest();
    try {
      const scope = container.querySelector('#retention-scope')?.value || 'execution';
      const current = await api.createRetentionPlan(scope);
      if (!isCurrentPlanRequest(request, previousPlanId)) return;
      const observation = observePlan(current);
      const observationId = planObservation;
      activePlan = await observation;
      if (destroyed || planObservation !== observationId) return;
    } catch (err) {
      if (!destroyed && request.requestGeneration === planRequestGeneration) {
        alert('Błąd generowania planu: ' + err.message);
      }
    } finally {
      if (btn && !destroyed && createGeneration === createRequestGeneration) btn.disabled = false;
    }
  });

  container.querySelector('#btn-apply-plan')?.addEventListener('click', async () => {
    const planId = activePlan?.plan_id;
    if (!planId || activePlan.status !== 'preview') return;
    const scope = activePlan.scope;
    const question = scope === 'sources'
      ? `Współdzielić identyczną treść wskazanych źródeł z planu ${planId}? Każda kapsuła zachowa swój manifest i zawartość.`
      : scope === 'runtime'
        ? `Usunąć wskazane stare paczki programu z planu ${planId}? Ponownie sprawdzimy odwołania wyników, instancje i ochronę paczek.`
        : `Usunąć wskazane kopie robocze z planu ${planId}? Przed usunięciem ponownie sprawdzimy ich użycie. Wyniki, źródła i cache pozostaną zachowane.`;
    if (confirm(question)) {
      const btn = container.querySelector('#btn-apply-plan');
      if (btn) btn.disabled = true;
      const applyGeneration = ++applyRequestGeneration;
      const request = beginPlanRequest();
      try {
        let mutationResult;
        try {
          mutationResult = await api.applyRetentionPlan(planId);
        } catch (err) {
          if (isCurrentPlanRequest(request, planId)) {
            alert('Błąd wykonania retencji: ' + err.message);
          }
          return;
        }
        if (!isCurrentPlanRequest(request, planId)) return;
        const observation = observePlan(mutationResult);
        const observationId = planObservation;
        let res;
        try {
          res = await observation;
        } catch (err) {
          if (!destroyed && activePlan?.plan_id === planId && planObservation === observationId) {
            alert('Błąd wykonania retencji: ' + err.message);
          }
          return;
        }
        if (destroyed || activePlan?.plan_id !== planId || planObservation !== observationId) return;
        if (res && res.status === 'preview_only') {
          alert(`Tryb podglądu (Preview): ${res.message || 'Wykonawca automatycznego usuwania nie jest włączony.'}`);
          activePlan.status = 'preview_only';
          renderPlan(activePlan);
          return;
        }
        if (!res || res.applied !== true) {
          const errMsg = res?.error || res?.message || 'Plan nie został wykonany (applied != true).';
          alert('Błąd wykonania retencji: ' + errMsg);
          return;
        }
        let outcome;
        if (activePlan.scope === 'sources') {
          const compactedCount = Number.isSafeInteger(res.compacted_items_count)
            ? res.compacted_items_count
            : Number.isSafeInteger(activePlan.compacted_items_count)
              ? activePlan.compacted_items_count
              : res.representation !== 'paged' && Array.isArray(res.items)
                ? res.items.filter(item => item.status === 'compacted').length
                : activePlan.representation !== 'paged' && Array.isArray(activePlan.items)
                  ? activePlan.items.filter(item => item.status === 'compacted').length
                  : null;
          outcome = compactedCount === null
            ? `Operacja współdzielenia źródeł zakończyła się; pełne podsumowanie pozostaje dostępne w planie ${activePlan.plan_id}.`
            : `Współdzielono zawartość ${compactedCount} kapsuł źródeł.`;
        } else {
          outcome = `Usunięto wskazane zasoby o rozmiarze logicznym ${formatBytes(res.removed_logical_bytes)}.`;
        }
        alert(`${outcome} Zmiana wolnego miejsca: ${formatBytes(res.disk_free_change_bytes)}. Pomiar miejsca może obejmować równoległe zapisy innych programów.`);
        loadStorageData();
      } finally {
        if (btn && !destroyed && applyGeneration === applyRequestGeneration) {
          btn.disabled = activePlan?.status !== 'preview' || !activePlan?.candidates_count;
        }
      }
    }
  });

  async function observePlan(initial) {
    const observation = ++planObservation;
    let current = initial;
    while (!destroyed && observation === planObservation) {
      activePlan = adoptPlanSnapshot(current);
      planSnapshotGeneration += 1;
      if (current.plan_id) {
        try { sessionStorage.setItem(savedPlanKey, current.plan_id); } catch (_) { /* Storage may be disabled. */ }
      }
      renderPlan(activePlan);
      if (!['planning', 'accepted', 'running'].includes(current.status)) return activePlan;
      // Poll the same operation. A network error preserves its ID and never
      // retries the mutation or creates a replacement plan.
      await new Promise(resolve => setTimeout(resolve, 2000));
      if (destroyed || observation !== planObservation) return activePlan;
      current = await api.getRetentionPlan(current.plan_id);
    }
    return activePlan;
  }

  async function refreshPlanAfterConflict(planId, expectedCollection = null) {
    if (destroyed || activePlan?.plan_id !== planId ||
        !expectedCollectionStateIsCurrent(expectedCollection)) return;
    const request = beginPlanRequest();
    try {
      const current = await api.getRetentionPlan(planId);
      if (!isCurrentPlanRequest(request, planId) ||
          !expectedCollectionStateIsCurrent(expectedCollection)) return;
      activePlan = adoptPlanSnapshot(current);
      planSnapshotGeneration += 1;
      renderPlan(activePlan);
    } catch (error) {
      if (!isCurrentPlanRequest(request, planId) ||
          !expectedCollectionStateIsCurrent(expectedCollection)) return;
      const message = `Nie udało się odświeżyć planu po zmianie jego zawartości: ${error.message}`;
      activePlan = { ...activePlan, error: message };
      planSnapshotGeneration += 1;
      renderPlan(activePlan);
    }
  }

  async function loadRetentionPage(collection) {
    const planId = activePlan?.plan_id;
    const pageState = planCollections.get(collection);
    if (!planId || planPagePlanId !== planId || !pageState || pageState.loading ||
        pageState.blocked || pageState.nextCursor === null || pageState.nextCursor === undefined) return;

    const cursor = pageState.nextCursor;
    const revision = pageState.revision;
    const requestGeneration = ++pageState.requestGeneration;
    pageState.loading = true;
    pageState.error = null;
    renderPlan(activePlan);
    try {
      const response = await api.getRetentionPlanPage(planId, {
        collection,
        cursor,
        limit: retentionPageLimit,
        revision,
      });
      const page = response?.page;
      if (destroyed || activePlan?.plan_id !== planId ||
          planCollections.get(collection) !== pageState ||
          pageState.revision !== revision ||
          pageState.requestGeneration !== requestGeneration) return;
      if (!page || page.collection !== collection || page.offset !== cursor ||
          page.revision !== revision || page.total !== pageState.total ||
          !Array.isArray(page.entries) || page.returned !== page.entries.length ||
          (page.blocked && page.next_cursor !== null) ||
          (!page.blocked && page.next_cursor !==
            (cursor + page.returned < page.total ? cursor + page.returned : null))) {
        await refreshPlanAfterConflict(planId, { collection, state: pageState, revision });
        return;
      }
      if (pageState.rows.length !== cursor) {
        await refreshPlanAfterConflict(planId, { collection, state: pageState, revision });
        return;
      }
      pageState.rows.push(...page.entries);
      pageState.nextCursor = page.next_cursor;
      pageState.blocked = page.blocked === true;
      pageState.error = page.error || null;
      if (!pageState.blocked && page.returned === 0 && page.next_cursor === cursor) {
        pageState.error = 'Serwer nie przesunął kursora strony; odśwież plan przed kolejną próbą.';
        pageState.blocked = true;
        pageState.nextCursor = null;
      }
      activePlan = { ...activePlan, [collection]: pageState.rows };
    } catch (error) {
      if (destroyed || activePlan?.plan_id !== planId ||
          planCollections.get(collection) !== pageState ||
          pageState.revision !== revision ||
          pageState.requestGeneration !== requestGeneration) return;
      if (error.status === 409) {
        await refreshPlanAfterConflict(planId, { collection, state: pageState, revision });
        return;
      }
      pageState.error = error.message || 'Nie udało się pobrać kolejnej strony.';
    } finally {
      if (!destroyed && activePlan?.plan_id === planId &&
          planCollections.get(collection) === pageState &&
          pageState.revision === revision &&
          pageState.requestGeneration === requestGeneration) {
        pageState.loading = false;
        renderPlan(activePlan);
      }
    }
  }

  function loadStorageData() {
    if (destroyed) return Promise.resolve();
    if (storageLoadPromise) return storageLoadPromise;
    const generation = ++storageLoadGeneration;
    volumesError = null;
    resourcesError = null;
    resourcesRefreshing = resourcesData !== null;

    // Keep the last good response visible during a refresh. On the initial
    // load the null values leave the individual sections on their own spinner.
    renderVolumes(volumes, volumesError);
    renderCategories(resourcesData, resourcesError);
    renderResourcesTable(resourcesData, resourcesError);

    // The volume endpoint is cheap and must render even when the recursive
    // resource scan is slow or unavailable. Do not await either request here:
    // each section owns its response, error state, and timeout.
    const volumesRequest = Promise.resolve()
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

    const requestController = typeof AbortController === 'function'
      ? new AbortController()
      : null;
    resourcesAbortController = requestController;
    const resourcesRequest = Promise.resolve()
      .then(() => api.getStorageResources({
        timeoutMs: null,
        retries: 1,
        ...(requestController ? { signal: requestController.signal } : {}),
      }))
      .then((value) => {
        if (generation !== storageLoadGeneration) return;
        resourcesData = value;
        resourcesError = null;
        resourcesRefreshing = false;
        renderCategories(resourcesData, resourcesError);
        renderResourcesTable(resourcesData, resourcesError);
      })
      .catch((err) => {
        if (generation !== storageLoadGeneration) return;
        resourcesError = err;
        resourcesRefreshing = false;
        renderCategories(resourcesData, resourcesError);
        renderResourcesTable(resourcesData, resourcesError);
      })
      .finally(() => {
        if (resourcesAbortController === requestController) {
          resourcesAbortController = null;
        }
      });
    storageLoadPromise = Promise.allSettled([volumesRequest, resourcesRequest])
      .finally(() => { storageLoadPromise = null; });
    return storageLoadPromise;
  }

  function renderResourceSnapshotNotice(err) {
    if (resourcesRefreshing) {
      return `
        <div class="loading-spinner storage-stale-notice" role="status">
          Odświeżanie inwentarza; widoczne dane pochodzą z poprzedniego odczytu.
        </div>
      `;
    }
    if (err) {
      return `
        <div class="error-box storage-stale-notice" role="status">
          <strong>Nie udało się odświeżyć inwentarza; wyświetlane dane są nieaktualne (stale):</strong>
          ${escapeHtml(err.message || 'Nie udało się pobrać danych inwentaryzacji storage.')}
        </div>
      `;
    }
    return '';
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

    if (err && resData === null) {
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

    const staleNotice = renderResourceSnapshotNotice(err);
    if (!resData || !resData.categories || resData.categories.length === 0) {
      el.innerHTML = `${staleNotice}<p class="empty-hint">Brak danych inwentaryzacji klas storage.</p>`;
      return;
    }

    const cats = resData.categories;
    const totalBytes = resData.total_measured_bytes || 1;
    const measuredAt = resData.measured_at ? new Date(resData.measured_at).getTime() : null;
    const isStale = Boolean(err) || resourcesRefreshing || state.connectionStatus === 'stale' ||
      (measuredAt !== null && !Number.isNaN(measuredAt) && (Date.now() - measuredAt > 120000));

    function getCompletenessBadge(cat) {
      if (cat.error) {
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
      ${staleNotice}
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
    const sourceScope = plan.scope === 'sources';
    const title = container.querySelector('#plan-title');
    if (title) title.textContent = sourceScope ? 'Współdzielenie źródeł'
      : plan.scope === 'runtime' ? 'Retencja starych paczek programu' : 'Retencja kopii roboczych';
    meta.textContent = `ID: ${plan.plan_id || 'nie przyjęto operacji'} • Status: ${plan.status} • Data: ${formatTimestamp(plan.created_at)}`;
    const applyButton = container.querySelector('#btn-apply-plan');
    if (applyButton) {
      applyButton.disabled = plan.status !== 'preview' || !plan.candidates_count;
      applyButton.textContent = sourceScope ? 'Współdziel wskazane źródła'
        : plan.scope === 'runtime' ? 'Usuń wskazane paczki programu' : 'Usuń wskazane kopie robocze';
    }
    if (['planning', 'accepted', 'running'].includes(plan.status)) {
      content.textContent = plan.status === 'planning'
        ? `Trwa przygotowanie wykazu. Żadne dane nie są jeszcze usuwane.${Number.isInteger(plan.processed_jobs) && Number.isInteger(plan.total_jobs) ? ` Sprawdzono ${plan.processed_jobs} z ${plan.total_jobs} zadań.` : ''}`
        : 'Trwa sprawdzanie i sprzątanie. Wynik zostanie zapisany dla tego identyfikatora operacji.';
      return;
    }

    const retentionRowLabel = (item) => {
      if (typeof item === 'string') return item;
      if (!item || typeof item !== 'object') return String(item);
      const identity = item.name || item.path || item.job_id || item.resource_id || item.id || item.status;
      const reason = item.why_retained || item.reason || item.error || item.message;
      return [identity, reason].filter(value => value !== undefined && value !== null && value !== '').join(': ')
        || 'Szczegół retencji';
    };
    const collectionPager = (name, label) => {
      const pageState = planCollections.get(name);
      if (!pageState || pageState.total <= 0) return '';
      const loaded = Math.min(pageState.rows.length, pageState.total);
      const range = loaded > 0
        ? `Wyświetlono 1–${loaded} z ${pageState.total} ${label}.`
        : `Załadowano 0 z ${pageState.total} ${label}.`;
      const errorMessage = pageState.error === 'retention_page_item_too_large'
        ? 'Pojedynczy szczegół przekracza limit odpowiedzi; dalsze strony są zablokowane.'
        : pageState.error;
      const canContinue = pageState.nextCursor !== null && pageState.nextCursor !== undefined && !pageState.blocked;
      return `
        <div class="retention-page-status">
          <p>${range}</p>
          ${errorMessage ? `<p class="error-box">${escapeHtml(errorMessage)}</p>` : ''}
          ${canContinue ? `<button class="btn btn-secondary btn-sm" id="retention-page-${escapeHtml(name)}" ${pageState.loading ? 'disabled' : ''}>${pageState.loading ? 'Wczytywanie…' : loaded > 0 ? 'Załaduj kolejne szczegóły' : 'Załaduj szczegóły'}</button>` : ''}
        </div>
      `;
    };

    const candidateRows = Array.isArray(plan.candidates) ? plan.candidates : [];
    const candidateTotal = planCollections.get('candidates')?.total ?? candidateRows.length;
    const retainedRows = Array.isArray(plan.retained) ? plan.retained : [];
    const retainedTotal = planCollections.get('retained')?.total ?? retainedRows.length;
    const itemRows = Array.isArray(plan.items) ? plan.items : [];
    const itemTotal = planCollections.get('items')?.total ?? itemRows.length;
    const referenceErrors = Array.isArray(plan.reference_errors) ? plan.reference_errors : [];
    const referenceErrorsTotal = planCollections.get('reference_errors')?.total ?? referenceErrors.length;
    const detailComplete = plan.representation === 'paged' &&
      (!plan.omitted_fields_count || plan.omitted_fields_count === 0) &&
      Object.entries(plan.collections || {}).every(([name, collection]) => {
        if (!collection || collection.total === 0) return true;
        const pageState = planCollections.get(name);
        return Boolean(pageState && pageState.rows.length === pageState.total &&
          !pageState.blocked && !pageState.error);
      });
    const knownCollections = new Set(['candidates', 'retained', 'items', 'reference_errors']);
    const otherCollections = [...planCollections.entries()]
      .filter(([name, pageState]) => !knownCollections.has(name) && pageState.total > 0)
      .map(([name, pageState]) => `
        <h3>Szczegóły: ${escapeHtml(name)}</h3>
        ${pageState.rows.length
          ? `<ul>${pageState.rows.map(item => `<li>${escapeHtml(retentionRowLabel(item))}</li>`).join('')}</ul>`
          : '<p class="empty-hint">Nie pobrano jeszcze szczegółów.</p>'}
        ${collectionPager(name, 'elementów')}
      `).join('');

    content.innerHTML = `
      ${plan.error ? `<p class="error-box">${escapeHtml(plan.error)}</p>` : ''}
      ${plan.representation === 'paged' ? `<p class="retention-detail-completeness">${detailComplete ? 'Pobrano wszystkie dostępne szczegóły.' : 'Szczegóły są stronicowane; poniżej pokazano pobrany zakres.'}</p>` : ''}
      ${plan.omitted_fields_count ? `<p class="error-box">Limit odpowiedzi pominął ${plan.omitted_fields_count} dodatkowych pól: ${escapeHtml((plan.omitted_fields || []).join(', '))}${plan.omitted_fields_truncated ? ' (pokazano ograniczoną próbkę nazw)' : ''}</p>` : ''}
      ${itemTotal > 0 || Array.isArray(plan.items) ? `
        <h3>Wynik wykonania</h3>
        ${itemRows.length ? `<ul>${itemRows.map(item => `<li>${escapeHtml(item.job_id)}: ${escapeHtml(item.status)} ${escapeHtml(item.reason || '')}</li>`).join('')}</ul>`
          : itemTotal > 0 ? '<p class="empty-hint">Nie pobrano jeszcze szczegółów wykonania.</p>' : '<p class="empty-hint">Brak pozycji wyniku wykonania.</p>'}
        ${collectionPager('items', 'pozycji wyniku')}
      ` : ''}
      ${referenceErrorsTotal > 0 ? `
        <p class="error-box">Kontrola odwołań wykryła ${referenceErrorsTotal} problemów. Paczki objęte niepewną kontrolą pozostają chronione.</p>
        ${referenceErrors.length ? `<ul>${referenceErrors.map(item => `<li>${escapeHtml(retentionRowLabel(item))}</li>`).join('')}</ul>` : '<p class="empty-hint">Nie pobrano szczegółów problemów odwołań.</p>'}
        ${collectionPager('reference_errors', 'problemów')}
      ` : ''}
      <div class="plan-summary-grid">
        <div class="plan-summary-box">
          <span class="plan-box-label">Rozmiar logiczny kandydatów (estymata):</span>
          <span class="plan-box-val text-success font-mono font-bold">${formatBytes(plan.estimated_reclaimed_bytes)}</span>
        </div>
        <div class="plan-summary-box">
          <span class="plan-box-label">Liczba wskazanych zasobów:</span>
          <span class="plan-box-val font-mono">${plan.candidates_count}</span>
        </div>
        <div class="plan-summary-box">
          <span class="plan-box-label">Zasoby chronione (pozostające):</span>
          <span class="plan-box-val font-mono">${plan.retained_count}</span>
        </div>
      </div>

      <h3 class="subsection-title">Zasoby objęte tym planem:</h3>
      ${candidateTotal > 0 ? `
        ${candidateRows.length ? `
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
                ${candidateRows.map(c => `
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
        ` : '<p class="empty-hint">Nie pobrano jeszcze szczegółów kandydatów.</p>'}
        ${collectionPager('candidates', 'kandydatów')}
      ` : '<p class="empty-hint">Brak kwalifikujących się zasobów w tym planie.</p>'}
      ${retainedTotal > 0 ? `
        <h3>Zasoby zachowane</h3>
        ${retainedRows.length ? `<ul>${retainedRows.map(item =>
          `<li>${escapeHtml(item.name || item.job_id || item.path)}: ${escapeHtml(item.why_retained || item.reason || '')}</li>`).join('')}</ul>`
          : '<p class="empty-hint">Nie pobrano jeszcze szczegółów zachowanych zasobów.</p>'}
        ${collectionPager('retained', 'zachowanych zasobów')}
      ` : ''}
      ${otherCollections}
    `;

    for (const name of planCollections.keys()) {
      const pageButton = content.querySelector(`#retention-page-${name}`);
      if (pageButton) pageButton.onclick = () => loadRetentionPage(name);
    }
  }
  function renderResourcesTable(resData, err = null) {
    const el = container.querySelector('#resources-table-container');
    if (!el) return;

    if (err && resData === null) {
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

    const staleNotice = renderResourceSnapshotNotice(err);
    if (!resData || !resData.resources || resData.resources.length === 0) {
      el.innerHTML = `${staleNotice}<p class="empty-hint">Brak zarejestrowanych zasobów w storage.</p>`;
      return;
    }

    const items = resData.resources;

    el.innerHTML = `
      ${staleNotice}
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
  try {
    const savedId = sessionStorage.getItem(savedPlanKey);
    if (savedId && /^plan-[a-f0-9]{8,32}$/.test(savedId)) {
      const request = beginPlanRequest();
      activePlan = { plan_id: savedId, status: 'reconnecting' };
      planSnapshotGeneration += 1;
      request.snapshotGeneration = planSnapshotGeneration;
      renderPlan(activePlan);
      api.getRetentionPlan(savedId).then(current => {
        if (!isCurrentPlanRequest(request, savedId)) return;
        const observation = observePlan(current);
        const observationId = planObservation;
        return observation.catch(error => {
          if (destroyed || activePlan?.plan_id !== savedId || planObservation !== observationId) return;
          activePlan = { ...activePlan, error: `Nie udało się odczytać zapisanego wyniku: ${error.message}` };
          planSnapshotGeneration += 1;
          renderPlan(activePlan);
        });
      }).catch(error => {
        if (!isCurrentPlanRequest(request, savedId)) return;
        activePlan = { ...activePlan, error: `Nie udało się odczytać zapisanego wyniku: ${error.message}` };
        planSnapshotGeneration += 1;
        renderPlan(activePlan);
      });
    }
  } catch (_) { /* Browser storage availability does not gate the API. */ }

  return {
    update: () => loadStorageData(),
    destroy: () => {
      destroyed = true;
      storageLoadGeneration += 1;
      if (resourcesAbortController) resourcesAbortController.abort();
      resourcesAbortController = null;
      planObservation += 1;
      planRequestGeneration += 1;
      planSnapshotGeneration += 1;
      createRequestGeneration += 1;
      applyRequestGeneration += 1;
      resetPlanCollections(null);
    },
  };
}
