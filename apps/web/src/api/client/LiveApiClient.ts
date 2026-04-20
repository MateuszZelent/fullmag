/**
 * Core live API client with modular endpoint access,
 * interceptor pipeline (requestId → retry → versionCheck → diagnostics),
 * and revision-based caching.
 */

import { LiveApiError } from "./errors/LiveApiError";
import { ResourceCache } from "./cache/ResourceCache";
import { applyRequestId } from "./interceptors/requestId";
import { withRetry } from "./interceptors/retry";
import { checkContractVersion } from "./interceptors/versionCheck";
import { createDiagnosticEntry } from "./interceptors/diagnostics";

import { StatusModule } from "./modules/StatusModule";
import { DomainModule } from "./modules/DomainModule";
import { FieldsModule } from "./modules/FieldsModule";
import { ScalarsModule } from "./modules/ScalarsModule";
import { DisplayModule } from "./modules/DisplayModule";
import { CommandsModule } from "./modules/CommandsModule";
import { ArtifactsModule } from "./modules/ArtifactsModule";
import { EigenModule } from "./modules/EigenModule";
import { SessionModule } from "./modules/SessionModule";
import { GpuModule } from "./modules/GpuModule";
import { SystemModule } from "./modules/SystemModule";

// ── Config ────────────────────────────────────────────────────────────

export interface LiveApiClientConfig {
  baseUrl: string;
  timeout?: number;
  maxRetries?: number;
}

export interface RequestOptions {
  signal?: AbortSignal;
  timeout?: number;
}

// ── Client ────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT = 15_000;
const DEFAULT_MAX_RETRIES = 3;

export class LiveApiClient {
  readonly status: StatusModule;
  readonly domain: DomainModule;
  readonly fields: FieldsModule;
  readonly scalars: ScalarsModule;
  readonly display: DisplayModule;
  readonly commands: CommandsModule;
  readonly artifacts: ArtifactsModule;
  readonly eigen: EigenModule;
  readonly session: SessionModule;
  readonly gpu: GpuModule;
  readonly system: SystemModule;

  private cache: ResourceCache;
  private config: LiveApiClientConfig;

  constructor(config: LiveApiClientConfig) {
    this.config = config;
    this.cache = new ResourceCache();

    this.status = new StatusModule(this);
    this.domain = new DomainModule(this);
    this.fields = new FieldsModule(this);
    this.scalars = new ScalarsModule(this);
    this.display = new DisplayModule(this);
    this.commands = new CommandsModule(this);
    this.artifacts = new ArtifactsModule(this);
    this.eigen = new EigenModule(this);
    this.session = new SessionModule(this);
    this.gpu = new GpuModule(this);
    this.system = new SystemModule(this);
  }

  // ── Public HTTP helpers (used by modules) ───────────────────────────

  async get<T>(path: string, opts?: RequestOptions): Promise<T> {
    const url = this.resolveUrl(path);
    const response = await this.executeRequest("GET", url, undefined, opts);
    return this.parseJson<T>(response, url);
  }

  async getBinary(path: string, opts?: RequestOptions): Promise<ArrayBuffer> {
    const url = this.resolveUrl(path);
    const response = await this.executeRequest("GET", url, undefined, opts);
    try {
      return await response.arrayBuffer();
    } catch (err) {
      throw LiveApiError.networkError(url, err);
    }
  }

  /**
   * Like getBinary but also returns response headers.
   * Useful for ETag/304 caching and content-length inspection.
   */
  async getBinaryResponse(
    path: string,
    opts?: RequestOptions,
  ): Promise<{ buffer: ArrayBuffer; headers: Headers; status: number }> {
    const url = this.resolveUrl(path);
    const response = await this.executeRequest("GET", url, undefined, opts);
    try {
      const buffer = await response.arrayBuffer();
      return { buffer, headers: response.headers, status: response.status };
    } catch (err) {
      throw LiveApiError.networkError(url, err);
    }
  }

  async post<T>(path: string, body: unknown, opts?: RequestOptions): Promise<T> {
    const url = this.resolveUrl(path);
    const response = await this.executeRequest("POST", url, body, opts, {
      retryable: false,
    });
    return this.parseJson<T>(response, url);
  }

  async put<T>(path: string, body: unknown, opts?: RequestOptions): Promise<T> {
    const url = this.resolveUrl(path);
    const response = await this.executeRequest("PUT", url, body, opts, {
      retryable: false,
    });
    return this.parseJson<T>(response, url);
  }

  async patch<T>(path: string, body: unknown, opts?: RequestOptions): Promise<T> {
    const url = this.resolveUrl(path);
    const response = await this.executeRequest("PATCH", url, body, opts, {
      retryable: false,
    });
    return this.parseJson<T>(response, url);
  }

  getCache(): ResourceCache {
    return this.cache;
  }

  // ── Internal pipeline ───────────────────────────────────────────────

  private resolveUrl(path: string): string {
    if (path.startsWith("http://") || path.startsWith("https://")) {
      return path;
    }
    const base = this.config.baseUrl.replace(/\/+$/, "");
    const p = path.startsWith("/") ? path : `/${path}`;
    return `${base}${p}`;
  }

  private async executeRequest(
    method: string,
    url: string,
    body?: unknown,
    opts?: RequestOptions,
    execution?: { retryable?: boolean },
  ): Promise<Response> {
    const timeout = opts?.timeout ?? this.config.timeout ?? DEFAULT_TIMEOUT;
    const maxRetries = this.config.maxRetries ?? DEFAULT_MAX_RETRIES;
    const retryable = execution?.retryable ?? true;

    // 1. Build headers and apply requestId
    const headers = new Headers();
    if (body !== undefined) {
      headers.set("Content-Type", "application/json");
    }
    const requestId = applyRequestId(headers);

    // 2. Setup abort for timeout
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    opts?.signal?.addEventListener("abort", onAbort);
    const timer = setTimeout(() => controller.abort(), timeout);

    // 3. Diagnostics tracking
    const diag = createDiagnosticEntry(requestId, method, url);

    try {
      // 4. Retry wrapper around fetch
      const doFetch = () =>
        fetch(url, {
          method,
          headers,
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: controller.signal,
          cache: "no-store",
        });

      const response = await withRetry(
        doFetch,
        { maxRetries: retryable ? maxRetries : 0 },
        opts?.signal,
      );

      // 5. Version check
      checkContractVersion(response);

      // 6. Handle HTTP errors
      if (!response.ok) {
        let errorBody = `HTTP ${response.status}`;
        try {
          const payload = await response.json();
          if (
            payload &&
            typeof payload === "object" &&
            typeof (payload as Record<string, unknown>).message === "string"
          ) {
            errorBody = (payload as Record<string, unknown>).message as string;
          } else if (
            payload &&
            typeof payload === "object" &&
            typeof (payload as Record<string, unknown>).error === "string"
          ) {
            errorBody = (payload as Record<string, unknown>).error as string;
          }
        } catch {
          // ignore parse failure on error body
        }

        const contentLength = response.headers.get("content-length");
        diag.finish(
          response.status,
          contentLength ? parseInt(contentLength, 10) : null,
          false,
          errorBody,
        );
        throw LiveApiError.httpError(response.status, errorBody, requestId, url);
      }

      const contentLength = response.headers.get("content-length");
      diag.finish(
        response.status,
        contentLength ? parseInt(contentLength, 10) : null,
        false,
      );

      return response;
    } catch (err) {
      if (err instanceof LiveApiError) {
        throw err;
      }
      if (err instanceof DOMException && err.name === "AbortError") {
        if (opts?.signal?.aborted) {
          throw LiveApiError.networkError(url, err);
        }
        diag.finish(0, null, false, "timeout");
        throw LiveApiError.timeoutError(url, timeout);
      }
      diag.finish(0, null, false, String(err));
      throw LiveApiError.networkError(url, err);
    } finally {
      clearTimeout(timer);
      opts?.signal?.removeEventListener("abort", onAbort);
    }
  }

  private async parseJson<T>(response: Response, url: string): Promise<T> {
    try {
      return (await response.json()) as T;
    } catch (err) {
      throw LiveApiError.parseError(url, err);
    }
  }
}

// ── Singleton ─────────────────────────────────────────────────────────

let _instance: LiveApiClient | null = null;

export function getLiveApiClient(): LiveApiClient {
  if (!_instance) {
    throw new Error(
      "LiveApiClient not initialized. Call initLiveApiClient() first.",
    );
  }
  return _instance;
}

export function initLiveApiClient(config: LiveApiClientConfig): LiveApiClient {
  _instance = new LiveApiClient(config);
  return _instance;
}
