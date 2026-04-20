/**
 * Structured error type for the live API client.
 * Provides machine-readable kind + optional HTTP context.
 */

export type LiveApiErrorKind =
  | "NetworkError"
  | "TimeoutError"
  | "HttpError"
  | "ParseError"
  | "ContractVersionMismatch"
  | "QuantityNotFound"
  | "DomainGenerationMismatch"
  | "ServerError";

export interface LiveApiErrorOptions {
  status?: number;
  requestId?: string;
  endpoint?: string;
  cause?: unknown;
}

export class LiveApiError extends Error {
  readonly kind: LiveApiErrorKind;
  readonly status?: number;
  readonly requestId?: string;
  readonly endpoint?: string;

  constructor(
    kind: LiveApiErrorKind,
    message: string,
    opts?: LiveApiErrorOptions,
  ) {
    super(message, opts?.cause ? { cause: opts.cause } : undefined);
    this.name = "LiveApiError";
    this.kind = kind;
    this.status = opts?.status;
    this.requestId = opts?.requestId;
    this.endpoint = opts?.endpoint;
  }

  get isRetryable(): boolean {
    return (
      this.kind === "NetworkError" ||
      this.kind === "TimeoutError" ||
      this.kind === "ServerError"
    );
  }

  get isNotFound(): boolean {
    return this.kind === "HttpError" && this.status === 404;
  }

  static networkError(endpoint: string, cause?: unknown): LiveApiError {
    return new LiveApiError(
      "NetworkError",
      `Network error requesting ${endpoint}`,
      { endpoint, cause },
    );
  }

  static timeoutError(endpoint: string, timeoutMs: number): LiveApiError {
    return new LiveApiError(
      "TimeoutError",
      `Request to ${endpoint} timed out after ${timeoutMs}ms`,
      { endpoint },
    );
  }

  static httpError(
    status: number,
    body: string,
    requestId?: string,
    endpoint?: string,
  ): LiveApiError {
    const kind: LiveApiErrorKind = status >= 500 ? "ServerError" : "HttpError";
    return new LiveApiError(kind, `HTTP ${status}: ${body}`, {
      status,
      requestId,
      endpoint,
    });
  }

  static parseError(endpoint: string, cause?: unknown): LiveApiError {
    return new LiveApiError(
      "ParseError",
      `Failed to parse response from ${endpoint}`,
      { endpoint, cause },
    );
  }

  static contractMismatch(
    expected: string,
    actual: string,
  ): LiveApiError {
    return new LiveApiError(
      "ContractVersionMismatch",
      `API contract version mismatch: expected ${expected}, got ${actual}`,
    );
  }

  static quantityNotFound(quantityId: string): LiveApiError {
    return new LiveApiError(
      "QuantityNotFound",
      `Field quantity "${quantityId}" not found`,
    );
  }

  static domainGenerationMismatch(
    expected: number,
    actual: number,
  ): LiveApiError {
    return new LiveApiError(
      "DomainGenerationMismatch",
      `Domain generation mismatch: expected ${expected}, got ${actual}`,
    );
  }
}
