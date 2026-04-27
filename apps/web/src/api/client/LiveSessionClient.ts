/**
 * Session-scoped v2 API client with modular endpoint access,
 * interceptor pipeline (requestId → retry → versionCheck → diagnostics),
 * and revision-based caching.
 */

import { createOpenApiV2Transport } from "../generated/openapi-v2-client";
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
import { VisualizationStateModule } from "./modules/VisualizationStateModule";
import { CommandsModule } from "./modules/CommandsModule";
import { ArtifactsModule } from "./modules/ArtifactsModule";
import { EigenModule } from "./modules/EigenModule";
import { SessionModule } from "./modules/SessionModule";
import { GpuModule } from "./modules/GpuModule";
import { LogsModule } from "./modules/LogsModule";
import { SystemModule } from "./modules/SystemModule";
import { QuantitiesModule } from "./modules/QuantitiesModule";
import { SceneModule } from "./modules/SceneModule";
import { RunsModule } from "./modules/RunsModule";
import { StagesModule } from "./modules/StagesModule";
import { SolverModule } from "./modules/SolverModule";
import { WorkspaceModule } from "./modules/WorkspaceModule";
import { MeshModule } from "./modules/MeshModule";
import type { BinaryResourceResponse, JsonResourceResponse } from "../types";

// ── Config ────────────────────────────────────────────────────────────

export interface LiveSessionClientConfig {
  baseUrl: string;
  timeout?: number;
  maxRetries?: number;
}

export interface RequestOptions {
  signal?: AbortSignal;
  timeout?: number;
  headers?: HeadersInit;
  cache?: RequestCache;
  /** When true, a 304 Not Modified response is returned as-is instead of being treated as an error. */
  allowNotModified?: boolean;
}

// ── Client ────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT = 15_000;
const DEFAULT_MAX_RETRIES = 3;
type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export class LiveSessionClient {
  readonly status: StatusModule;
  readonly domain: DomainModule;
  readonly fields: FieldsModule;
  readonly scalars: ScalarsModule;
  readonly display: DisplayModule;
  readonly visualizationState: VisualizationStateModule;
  readonly commands: CommandsModule;
  readonly artifacts: ArtifactsModule;
  readonly eigen: EigenModule;
  readonly session: SessionModule;
  readonly gpu: GpuModule;
  readonly logs: LogsModule;
  readonly system: SystemModule;
  readonly quantities: QuantitiesModule;
  readonly scene: SceneModule;
  readonly workspace: WorkspaceModule;
  readonly mesh: MeshModule;
  readonly runs: RunsModule;
  readonly stages: StagesModule;
  readonly solver: SolverModule;

  private cache: ResourceCache;
  private config: LiveSessionClientConfig;

  constructor(config: LiveSessionClientConfig) {
    this.config = config;
    this.cache = new ResourceCache();

    this.status = new StatusModule(this);
    this.domain = new DomainModule(this);
    this.fields = new FieldsModule(this);
    this.scalars = new ScalarsModule(this);
    this.display = new DisplayModule(this);
    this.visualizationState = new VisualizationStateModule(this);
    this.commands = new CommandsModule(this);
    this.artifacts = new ArtifactsModule(this);
    this.eigen = new EigenModule(this);
    this.session = new SessionModule(this);
    this.gpu = new GpuModule(this);
    this.logs = new LogsModule(this);
    this.system = new SystemModule(this);
    this.quantities = new QuantitiesModule(this);
    this.scene = new SceneModule(this);
    this.workspace = new WorkspaceModule(this);
    this.mesh = new MeshModule(this);
    this.runs = new RunsModule(this);
    this.stages = new StagesModule(this);
    this.solver = new SolverModule(this);
  }

  // ── Public HTTP helpers (used by modules) ───────────────────────────

  async get<T>(path: string, opts?: RequestOptions): Promise<T> {
    return this.executeOpenApiJson<T>("GET", path, undefined, opts);
  }

  async getJsonResponse<T>(
    path: string,
    opts?: RequestOptions,
  ): Promise<JsonResourceResponse<T>> {
    const url = this.resolveUrl(path);
    const response = await this.executeRequest("GET", url, undefined, opts, {
      acceptStatuses: [304],
    });
    if (response.status === 304) {
      return { data: null, headers: response.headers, status: response.status };
    }
    const data = await this.parseJson<T>(response, url);
    return { data, headers: response.headers, status: response.status };
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
  ): Promise<BinaryResourceResponse> {
    const url = this.resolveUrl(path);
    const response = await this.executeRequest("GET", url, undefined, opts, {
      acceptStatuses: [304],
    });
    try {
      const buffer = await response.arrayBuffer();
      return { buffer, headers: response.headers, status: response.status };
    } catch (err) {
      throw LiveApiError.networkError(url, err);
    }
  }

  async post<T>(path: string, body: unknown, opts?: RequestOptions): Promise<T> {
    return this.executeOpenApiJson<T>("POST", path, body, opts, {
      retryable: false,
    });
  }

  async put<T>(path: string, body: unknown, opts?: RequestOptions): Promise<T> {
    return this.executeOpenApiJson<T>("PUT", path, body, opts, {
      retryable: false,
    });
  }

  async patch<T>(path: string, body: unknown, opts?: RequestOptions): Promise<T> {
    return this.executeOpenApiJson<T>("PATCH", path, body, opts, {
      retryable: false,
    });
  }

  async delete<T>(path: string, opts?: RequestOptions): Promise<T> {
    return this.executeOpenApiJson<T>("DELETE", path, undefined, opts, {
      retryable: false,
    });
  }

  getCache(): ResourceCache {
    return this.cache;
  }

  getBaseUrl(): string {
    return this.config.baseUrl;
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
    execution?: { retryable?: boolean; acceptStatuses?: number[] },
  ): Promise<Response> {
    const timeout = opts?.timeout ?? this.config.timeout ?? DEFAULT_TIMEOUT;
    const maxRetries = this.config.maxRetries ?? DEFAULT_MAX_RETRIES;
    const retryable = execution?.retryable ?? true;
    const acceptStatuses = execution?.acceptStatuses ?? [];

    // 1. Build headers and apply requestId
    const headers = new Headers();
    if (body !== undefined) {
      headers.set("Content-Type", "application/json");
    }
    if (opts?.headers) {
      const requestHeaders = new Headers(opts.headers);
      requestHeaders.forEach((value, key) => {
        headers.set(key, value);
      });
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
          cache: opts?.cache ?? "no-store",
        });

      const response = await withRetry(
        doFetch,
        { maxRetries: retryable ? maxRetries : 0 },
        opts?.signal,
      );

      // 5. Version check
      checkContractVersion(response);

      // 6. Handle HTTP errors
      const acceptedStatus = acceptStatuses.includes(response.status);
      if (!response.ok && !acceptedStatus) {
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
        acceptedStatus,
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

  private async executeOpenApiJson<T>(
    method: HttpMethod,
    path: string,
    body?: unknown,
    opts?: RequestOptions,
    execution?: { retryable?: boolean; acceptStatuses?: number[] },
  ): Promise<T> {
    const client = createOpenApiV2Transport({
      baseUrl: this.config.baseUrl.replace(/\/+$/, ""),
      fetch: (input: Request) =>
        this.executeOpenApiFetch(input, undefined, opts, execution),
    });
    const request: Record<string, unknown> = {
      headers: opts?.headers,
      signal: opts?.signal,
      cache: opts?.cache ?? "no-store",
    };
    if (body !== undefined) {
      request.body = body;
    }

    const typedPath = path as never;
    const typedRequest = request as never;
    const result =
      method === "GET"
        ? await client.GET(typedPath, typedRequest)
        : method === "POST"
          ? await client.POST(typedPath, typedRequest)
          : method === "PUT"
            ? await client.PUT(typedPath, typedRequest)
            : method === "PATCH"
              ? await client.PATCH(typedPath, typedRequest)
              : await client.DELETE(typedPath, typedRequest);
    const response = result.response as Response | undefined;
    if (!response) {
      throw LiveApiError.networkError(path, "OpenAPI client returned no response");
    }

    const acceptStatuses = execution?.acceptStatuses ?? [];
    if (!response.ok && !acceptStatuses.includes(response.status)) {
      throw LiveApiError.httpError(
        response.status,
        formatOpenApiError(result.error),
        response.headers.get("x-request-id") ?? undefined,
        this.resolveUrl(path),
      );
    }

    return result.data as T;
  }

  private async executeOpenApiFetch(
    input: RequestInfo | URL,
    init: RequestInit | undefined,
    opts?: RequestOptions,
    execution?: { retryable?: boolean; acceptStatuses?: number[] },
  ): Promise<Response> {
    const request = await normalizeFetchInput(input, init);
    return this.executeFetchRequest(
      request.method,
      request.url,
      request.init,
      opts,
      execution,
    );
  }

  private async executeFetchRequest(
    method: string,
    url: string,
    init: RequestInit,
    opts?: RequestOptions,
    execution?: { retryable?: boolean; acceptStatuses?: number[] },
  ): Promise<Response> {
    const timeout = opts?.timeout ?? this.config.timeout ?? DEFAULT_TIMEOUT;
    const maxRetries = this.config.maxRetries ?? DEFAULT_MAX_RETRIES;
    const retryable = execution?.retryable ?? true;
    const acceptStatuses = execution?.acceptStatuses ?? [];

    const headers = new Headers(init.headers);
    const requestId = applyRequestId(headers);

    const controller = new AbortController();
    const abort = () => controller.abort();
    opts?.signal?.addEventListener("abort", abort);
    init.signal?.addEventListener("abort", abort);
    const timer = setTimeout(() => controller.abort(), timeout);
    const diag = createDiagnosticEntry(requestId, method, url);

    try {
      const doFetch = () =>
        fetch(url, {
          ...init,
          method,
          headers,
          signal: controller.signal,
          cache: opts?.cache ?? init.cache ?? "no-store",
        });

      const response = await withRetry(
        doFetch,
        { maxRetries: retryable ? maxRetries : 0 },
        opts?.signal,
      );
      checkContractVersion(response);

      const acceptedStatus = acceptStatuses.includes(response.status);
      const contentLength = response.headers.get("content-length");
      diag.finish(
        response.status,
        contentLength ? parseInt(contentLength, 10) : null,
        response.ok || acceptedStatus,
      );
      return response;
    } catch (err) {
      if (err instanceof LiveApiError) {
        throw err;
      }
      if (err instanceof DOMException && err.name === "AbortError") {
        if (opts?.signal?.aborted || init.signal?.aborted) {
          throw LiveApiError.networkError(url, err);
        }
        diag.finish(0, null, false, "timeout");
        throw LiveApiError.timeoutError(url, timeout);
      }
      diag.finish(0, null, false, String(err));
      throw LiveApiError.networkError(url, err);
    } finally {
      clearTimeout(timer);
      opts?.signal?.removeEventListener("abort", abort);
      init.signal?.removeEventListener("abort", abort);
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

async function normalizeFetchInput(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
): Promise<{ url: string; method: string; init: RequestInit }> {
  if (typeof Request !== "undefined" && input instanceof Request) {
    const method = init?.method ?? input.method;
    let body = init?.body;
    if (
      body === undefined &&
      method !== "GET" &&
      method !== "HEAD" &&
      input.body != null
    ) {
      body = await input.clone().arrayBuffer();
    }
    return {
      url: input.url,
      method,
      init: {
        ...init,
        headers: init?.headers ?? input.headers,
        body,
        cache: init?.cache ?? input.cache,
        signal: init?.signal ?? input.signal,
      },
    };
  }
  return {
    url: String(input),
    method: init?.method ?? "GET",
    init: init ?? {},
  };
}

function formatOpenApiError(error: unknown): string {
  if (error == null) {
    return "Request failed";
  }
  if (typeof error === "string") {
    return error;
  }
  if (typeof error === "object") {
    const record = error as Record<string, unknown>;
    if (typeof record.message === "string") {
      return record.message;
    }
    if (typeof record.error === "string") {
      return record.error;
    }
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return String(error);
}

// ── Singleton ─────────────────────────────────────────────────────────

let _instance: LiveSessionClient | null = null;

export function getLiveSessionClient(): LiveSessionClient {
  if (!_instance) {
    throw new Error(
      "LiveSessionClient not initialized. Call initLiveSessionClient() first.",
    );
  }
  return _instance;
}

export function initLiveSessionClient(config: LiveSessionClientConfig): LiveSessionClient {
  _instance = new LiveSessionClient(config);
  return _instance;
}
