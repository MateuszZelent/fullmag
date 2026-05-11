import {
  API_CONTRACT_VERSION_HEADER,
  EXPECTED_API_CONTRACT_VERSION,
  SESSION_STATUS_PATH,
  SIMULATION_COMMAND_DETAIL_PATH,
  SIMULATION_COMMANDS_PATH,
} from "./apiPaths";
import type {
  CommandDetailResource,
  CommandQueueStatusResource,
  CommandResponse,
  LiveStatusResource,
  RequestOptions,
  StructuredCommandRequest,
} from "./apiTypes";
import {
  createOpenApiV2Transport,
  type OpenApiV2Transport,
} from "./generated/openapi-v2-client";
import type { OpenApiV2Path } from "./generated/openapi-v2-paths";
import type { RequestDiagnosticsController } from "./RequestDiagnosticsController";

type FetchLike = typeof fetch;

interface ControlRoomApiOptions {
  baseUrl?: string;
  diagnostics?: RequestDiagnosticsController;
  fetchImpl?: FetchLike;
  maxGetRetries?: number;
  requestIdFactory?: () => string;
}

export class ControlRoomApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ControlRoomApiError";
  }
}

export class ControlRoomApi {
  private readonly baseUrl: string;
  private readonly diagnostics: RequestDiagnosticsController | null;
  private readonly fetchImpl: FetchLike;
  private readonly maxGetRetries: number;
  private readonly requestIdFactory: () => string;
  private readonly transport: OpenApiV2Transport;

  readonly sessions = {
    current: {
      status: (options?: RequestOptions) =>
        this.requestJson<LiveStatusResource>(SESSION_STATUS_PATH, options),
    },
  };

  readonly commands = {
    detail: (commandId: string, options?: RequestOptions) =>
      this.requestJson<CommandDetailResource>(
        SIMULATION_COMMAND_DETAIL_PATH,
        options,
        { path: { command_id: commandId } },
      ),
    list: (options?: RequestOptions) =>
      this.requestJson<CommandQueueStatusResource>(
        SIMULATION_COMMANDS_PATH,
        options,
      ),
    submit: (command: StructuredCommandRequest, options?: RequestOptions) =>
      this.postJson<CommandResponse, StructuredCommandRequest>(
        SIMULATION_COMMANDS_PATH,
        command,
        options,
      ),
  };

  constructor({
    baseUrl,
    diagnostics,
    fetchImpl = fetch,
    maxGetRetries = 1,
    requestIdFactory = () => crypto.randomUUID(),
  }: ControlRoomApiOptions = {}) {
    this.baseUrl = resolveBaseUrl(baseUrl);
    this.diagnostics = diagnostics ?? null;
    this.fetchImpl = fetchImpl;
    this.maxGetRetries = maxGetRetries;
    this.requestIdFactory = requestIdFactory;
    this.transport = createOpenApiV2Transport({
      baseUrl: this.baseUrl,
      fetch: (input) => this.executeOpenApiFetch(input, undefined),
    });
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  private async requestJson<T>(
    path: OpenApiV2Path,
    options: RequestOptions = {},
    params?: Record<string, unknown>,
  ): Promise<T> {
    const result = await this.transport.GET(path as never, {
      cache: "no-store",
      params,
      signal: options.signal,
    } as never);
    return readOpenApiResult<T>(result);
  }

  private async postJson<TResponse, TBody>(
    path: OpenApiV2Path,
    body: TBody,
    options: RequestOptions = {},
  ): Promise<TResponse> {
    const result = await this.transport.POST(path as never, {
      body,
      cache: "no-store",
      signal: options.signal,
    } as never);
    return readOpenApiResult<TResponse>(result);
  }

  private async executeOpenApiFetch(
    input: RequestInfo | URL,
    init: RequestInit | undefined,
  ): Promise<Response> {
    const request = await normalizeFetchInput(input, init);
    return this.executeFetchRequest(request.url, request.method, request.init);
  }

  private async executeFetchRequest(
    url: string,
    method: string,
    init: RequestInit,
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    const requestId = this.requestIdFactory();
    headers.set("x-request-id", requestId);

    const started = Date.now();
    const path = pathFromUrl(url);
    const maxAttempts = method === "GET" ? this.maxGetRetries + 1 : 1;
    let lastError: unknown = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const response = await this.fetchImpl(url, {
          ...init,
          cache: init.cache ?? "no-store",
          headers,
          method,
        });

        if (attempt < maxAttempts && response.status >= 500) {
          continue;
        }

        const contractVersionError = resolveContractVersionError(response);
        this.diagnostics?.record({
          durationMs: Date.now() - started,
          method,
          outcome: response.ok && !contractVersionError ? "ok" : "error",
          path,
          requestId,
          status: response.status,
        });

        if (contractVersionError) {
          throw contractVersionError;
        }

        return response;
      } catch (error) {
        if (error instanceof ControlRoomApiError) {
          throw error;
        }

        lastError = error;
        if (
          attempt < maxAttempts &&
          !(error instanceof DOMException && error.name === "AbortError")
        ) {
          continue;
        }
      }
    }

    this.diagnostics?.record({
      durationMs: Date.now() - started,
      method,
      outcome:
        lastError instanceof DOMException && lastError.name === "AbortError"
          ? "aborted"
          : "network-error",
      path,
      requestId,
      status: null,
    });

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}

function resolveBaseUrl(baseUrl: string | undefined): string {
  if (baseUrl !== undefined) {
    return baseUrl.replace(/\/$/, "");
  }

  if (typeof window !== "undefined") {
    return window.location.origin;
  }

  return "http://localhost";
}

async function normalizeFetchInput(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
): Promise<{ init: RequestInit; method: string; url: string }> {
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
      init: {
        ...init,
        body,
        cache: init?.cache ?? input.cache,
        headers: init?.headers ?? input.headers,
        signal: init?.signal ?? input.signal,
      },
      method,
      url: input.url,
    };
  }

  return {
    init: init ?? {},
    method: init?.method ?? "GET",
    url: String(input),
  };
}

function pathFromUrl(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

function resolveContractVersionError(response: Response): ControlRoomApiError | null {
  const actual = response.headers.get(API_CONTRACT_VERSION_HEADER);
  if (actual === EXPECTED_API_CONTRACT_VERSION) {
    return null;
  }

  return new ControlRoomApiError(
    `API contract version mismatch: expected ${EXPECTED_API_CONTRACT_VERSION}, got ${actual ?? "missing"}`,
    0,
  );
}

function readOpenApiResult<T>(result: {
  data?: unknown;
  error?: unknown;
  response?: Response;
}): T {
  const response = result.response;

  if (!response) {
    throw new ControlRoomApiError("OpenAPI transport returned no response", 0);
  }

  if (!response.ok) {
    throw new ControlRoomApiError(
      formatOpenApiError(result.error),
      response.status,
    );
  }

  return result.data as T;
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
  }

  return "Request failed";
}
