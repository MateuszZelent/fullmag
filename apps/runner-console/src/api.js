/**
 * API client for the Fullmag Build Runner Coordinator.
 * Supports session cookies, Bearer tokens, same-origin calls, and typed endpoints.
 */

class RunnerAPI {
  constructor() {
    this.baseUrl = '';
    this.token = null;
    this.onAuthFailure = null;
  }

  setToken(token) {
    this.token = token ? token.trim() : null;
  }

  getToken() {
    return this.token;
  }

  async request(path, options = {}) {
    const url = `${this.baseUrl}${path}`;
    const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(0, options.timeoutMs) : 15000;
    const retries = Number.isInteger(options.retries) ? Math.max(0, options.retries) : 0;
    const {
      timeoutMs: _timeoutMs,
      retries: _retries,
      ...fetchOptions
    } = options;
    const headers = {
      'Content-Type': 'application/json',
      ...(fetchOptions.headers || {}),
    };

    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const externalSignal = fetchOptions.signal;
      let timeoutHandle = null;
      let removeExternalAbortListener = null;
      if (controller) {
        if (externalSignal) {
          if (externalSignal.aborted) {
            controller.abort();
          } else {
            const onExternalAbort = () => controller.abort();
            externalSignal.addEventListener('abort', onExternalAbort, { once: true });
            removeExternalAbortListener = () => externalSignal.removeEventListener('abort', onExternalAbort);
          }
        }
        timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
      }
      const config = {
        ...fetchOptions,
        headers,
        credentials: 'same-origin',
        ...(controller ? { signal: controller.signal } : {}),
      };

      try {
        const res = await fetch(url, config);

        if (res.status === 401) {
          if (typeof this.onAuthFailure === 'function') {
            this.onAuthFailure();
          }
          const err = new Error('Wymagana autoryzacja (brak ważnego tokena lub sesji)');
          err.status = 401;
          throw err;
        }

        if (res.status === 403) {
          const err = new Error('Brak uprawnień lub niedozwolony Origin');
          err.status = 403;
          throw err;
        }

        if (!res.ok) {
          let errData = {};
          try {
            errData = await res.json();
          } catch (_) {}
          const msg = errData.error || `Błąd serwera (${res.status} ${res.statusText})`;
          const err = new Error(msg);
          err.status = res.status;
          err.data = errData;
          throw err;
        }

        const contentType = res.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
          return await res.json();
        }
        return await res.text();
      } catch (error) {
        const timedOut = error?.name === 'AbortError';
        if (timedOut) {
          const timeoutError = new Error(`Przekroczono limit ${timeoutMs} ms dla żądania ${path}`);
          timeoutError.status = 408;
          timeoutError.code = 'REQUEST_TIMEOUT';
          timeoutError.cause = error;
          error = timeoutError;
        } else if (error.name === 'TypeError' && error.message.includes('fetch')) {
          const netErr = new Error('Brak połączenia z koordynatorem Fullmag runner');
          netErr.status = 0;
          error = netErr;
        }

        const retryable = error.status === 0 || error.status === 408 || error.code === 'REQUEST_TIMEOUT';
        if (retryable && attempt < retries) {
          continue;
        }
        throw error;
      } finally {
        if (timeoutHandle !== null) clearTimeout(timeoutHandle);
        if (removeExternalAbortListener) removeExternalAbortListener();
      }
    }

    throw new Error(`Nie udało się wykonać żądania ${path}`);
  }

  // --- Auth Session ---
  async login(token) {
    this.setToken(token);
    try {
      const res = await this.request('/api/v1/auth/session', {
        method: 'POST',
        body: JSON.stringify({ token }),
      });
      return res;
    } catch (err) {
      // Fallback check against /health with token
      if (err.status === 404) {
        return await this.request('/health');
      }
      throw err;
    }
  }

  async checkAuth() {
    try {
      return await this.request('/api/v1/auth/session', { method: 'GET' });
    } catch (_) {
      try {
        const health = await this.request('/health', { method: 'GET' });
        return { authenticated: true, health };
      } catch (err) {
        return { authenticated: false };
      }
    }
  }

  async logout() {
    try {
      await this.request('/api/v1/auth/logout', { method: 'POST', body: '{}' });
    } catch (_) {}
    this.token = null;
  }

  // --- Observability & Telemetry Endpoints ---
  async getOverview() {
    return await this.request('/api/v1/overview');
  }

  async getHealth() {
    return await this.request('/health');
  }

  async getJobs(params = {}) {
    const qs = new URLSearchParams();
    if (params.status) qs.set('status', params.status);
    if (params.profile) qs.set('profile', params.profile);
    if (params.worktree) qs.set('worktree', params.worktree);
    if (params.search) qs.set('search', params.search);
    if (params.sort) qs.set('sort', params.sort);
    if (params.page) qs.set('page', params.page);
    if (params.limit) qs.set('limit', params.limit);

    const query = qs.toString() ? `?${qs.toString()}` : '';
    return await this.request(`/api/v1/jobs${query}`);
  }

  async getJobDetail(jobId) {
    try {
      return await this.request(`/api/v1/jobs/${encodeURIComponent(jobId)}`);
    } catch (err) {
      if (err && err.status === 404) {
        return await this.request(`/jobs/${encodeURIComponent(jobId)}`);
      }
      throw err;
    }
  }

  async getJobLogs(jobId, stage = null) {
    const query = stage ? `?stage=${encodeURIComponent(stage)}` : '';
    try {
      return await this.request(`/api/v1/jobs/${encodeURIComponent(jobId)}/logs${query}`);
    } catch (err) {
      if (err && err.status === 404) {
        return await this.request(`/jobs/${encodeURIComponent(jobId)}/logs`);
      }
      throw err;
    }
  }

  async getJobEvents(jobId) {
    return await this.request(`/api/v1/jobs/${encodeURIComponent(jobId)}/events`);
  }

  async getJobMetrics(jobId) {
    return await this.request(`/api/v1/jobs/${encodeURIComponent(jobId)}/metrics`);
  }

  async getJobResources(jobId) {
    return await this.request(`/api/v1/jobs/${encodeURIComponent(jobId)}/resources`);
  }

  async cancelJob(jobId) {
    return await this.request(`/jobs/${encodeURIComponent(jobId)}/cancel`, {
      method: 'POST',
      body: '{}',
    });
  }

  async pauseQueue() {
    return await this.request('/stop', {
      method: 'POST',
      body: '{}',
    });
  }

  async resumeQueue() {
    return await this.request('/resume', {
      method: 'POST',
      body: '{}',
    });
  }

  // --- Storage Endpoints ---
  async getStorageVolumes(options = {}) {
    return await this.request('/api/v1/storage/volumes', options);
  }

  async getStorageResources(options = {}) {
    return await this.request('/api/v1/storage/resources', options);
  }

  // --- Processes & Diagnostic Endpoints ---
  async getProcesses() {
    return await this.request('/api/v1/processes');
  }

  async getAlerts() {
    return await this.request('/api/v1/alerts');
  }

  async getEvents(limit = 100) {
    return await this.request(`/api/v1/events?limit=${limit}`);
  }

  // --- Retention & Policies Endpoints ---
  async getRetentionPolicy() {
    return await this.request('/api/v1/retention/policy');
  }

  async updateRetentionPolicy(policy) {
    return await this.request('/api/v1/retention/policy', {
      method: 'PUT',
      body: JSON.stringify(policy),
    });
  }

  async getRetentionPlans() {
    return await this.request('/api/v1/retention/plans');
  }

  async createRetentionPlan() {
    return await this.request('/api/v1/retention/plans', {
      method: 'POST',
      body: '{}',
    });
  }

  async applyRetentionPlan(planId) {
    return await this.request(`/api/v1/retention/plans/${encodeURIComponent(planId)}/apply`, {
      method: 'POST',
      body: '{}',
    });
  }

  async pinResource(resourceId, pinned, reason = '') {
    return await this.request(`/api/v1/resources/${encodeURIComponent(resourceId)}/pin`, {
      method: 'POST',
      body: JSON.stringify({ pinned, reason }),
    });
  }
}

export const api = new RunnerAPI();
