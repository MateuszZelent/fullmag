/**
 * Thin fetch wrappers with consistent error handling, timeouts, and type
 * safety.  All pages and hooks should use these instead of calling fetch()
 * directly.
 *
 * Error semantics:
 *   - Non-2xx HTTP responses throw `ApiError(status, message)`.
 *   - Network failures (offline, DNS, abort) throw `NetworkError`.
 *   - JSON parse failures from a 2xx response throw `NetworkError`.
 */

import { ApiError, NetworkError } from './errors';

const DEFAULT_TIMEOUT_MS = 15_000;
type ApiRequestOptions = { timeoutMs?: number; signal?: AbortSignal };

function normalizeOptions(options?: number | ApiRequestOptions): ApiRequestOptions {
  if (typeof options === 'number') {
    return { timeoutMs: options };
  }
  return options ?? {};
}

async function fetchWithTimeout(
  url: string,
  options: RequestInit & ApiRequestOptions = {},
): Promise<Response> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, signal, ...init } = options;
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort);
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new NetworkError(`Request to ${url} timed out after ${timeoutMs}ms`);
    }
    throw new NetworkError(`Network error for ${url}`, err);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

function extractErrorMessage(payload: unknown, status: number): string {
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    if (typeof record.message === 'string' && record.message.trim().length > 0) {
      return record.message;
    }
    if (typeof record.error === 'string' && record.error.trim().length > 0) {
      return record.error;
    }
  }
  return `HTTP ${status}`;
}

/**
 * Perform a GET request and parse the JSON response.
 *
 * @throws {ApiError}    on non-2xx HTTP status
 * @throws {NetworkError} on network / timeout / JSON parse failure
 */
export async function apiGet<T>(url: string, options?: number | ApiRequestOptions): Promise<T> {
  const resolved = normalizeOptions(options);
  const response = await fetchWithTimeout(url, {
    cache: 'no-store',
    timeoutMs: resolved.timeoutMs,
    signal: resolved.signal,
  });

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    if (!response.ok) {
      throw new ApiError(response.status, `HTTP ${response.status}`);
    }
    throw new NetworkError(`Failed to parse JSON response from ${url}`);
  }

  if (!response.ok) {
    throw new ApiError(response.status, extractErrorMessage(payload, response.status));
  }

  return payload as T;
}

/**
 * Perform a GET request and return the raw ArrayBuffer response body.
 *
 * @throws {ApiError}    on non-2xx HTTP status
 * @throws {NetworkError} on network / timeout / body read failure
 */
export async function apiGetArrayBuffer(
  url: string,
  options?: number | ApiRequestOptions,
): Promise<ArrayBuffer> {
  const resolved = normalizeOptions(options);
  const response = await fetchWithTimeout(url, {
    cache: 'no-store',
    timeoutMs: resolved.timeoutMs,
    signal: resolved.signal,
  });

  if (!response.ok) {
    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      throw new ApiError(response.status, `HTTP ${response.status}`);
    }
    throw new ApiError(response.status, extractErrorMessage(payload, response.status));
  }

  try {
    return await response.arrayBuffer();
  } catch (error) {
    throw new NetworkError(`Failed to read binary response from ${url}`, error);
  }
}

/**
 * Perform a GET request that may validly return 204 No Content.
 *
 * Returns `null` for 204 responses.
 */
export async function apiGetOptional<T>(url: string, options?: number | ApiRequestOptions): Promise<T | null> {
  const resolved = normalizeOptions(options);
  const response = await fetchWithTimeout(url, {
    cache: 'no-store',
    timeoutMs: resolved.timeoutMs,
    signal: resolved.signal,
  });

  if (response.status === 204) {
    return null;
  }

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    if (!response.ok) {
      throw new ApiError(response.status, `HTTP ${response.status}`);
    }
    throw new NetworkError(`Failed to parse JSON response from ${url}`);
  }

  if (!response.ok) {
    throw new ApiError(response.status, extractErrorMessage(payload, response.status));
  }

  return payload as T;
}

/**
 * Perform a POST request with a JSON body.
 *
 * @throws {ApiError}    on non-2xx HTTP status
 * @throws {NetworkError} on network / timeout / JSON parse failure
 */
export async function apiPost<T = unknown>(
  url: string,
  body: unknown,
  options?: number | ApiRequestOptions,
): Promise<T> {
  const resolved = normalizeOptions(options);
  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
    timeoutMs: resolved.timeoutMs,
    signal: resolved.signal,
  });

  let payload: unknown = null;
  try {
    if (response.headers.get('content-length') !== '0') {
      payload = await response.json();
    }
  } catch {
    if (!response.ok) {
      throw new ApiError(response.status, `HTTP ${response.status}`);
    }
    throw new NetworkError(`Failed to parse JSON response from ${url}`);
  }

  if (!response.ok) {
    throw new ApiError(response.status, extractErrorMessage(payload, response.status));
  }

  return payload as T;
}

/**
 * Perform a DELETE request.
 *
 * @throws {ApiError}    on non-2xx HTTP status
 * @throws {NetworkError} on network / timeout failure
 */
export async function apiDelete(url: string, options?: number | ApiRequestOptions): Promise<void> {
  const resolved = normalizeOptions(options);
  const response = await fetchWithTimeout(url, {
    method: 'DELETE',
    cache: 'no-store',
    timeoutMs: resolved.timeoutMs,
    signal: resolved.signal,
  });

  if (!response.ok) {
    let msg = `HTTP ${response.status}`;
    try {
      const payload = await response.json();
      msg = extractErrorMessage(payload, response.status);
    } catch { /* ignore body parse failure on error response */ }
    throw new ApiError(response.status, msg);
  }
}
