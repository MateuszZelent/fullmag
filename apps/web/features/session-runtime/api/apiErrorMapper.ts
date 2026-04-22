/**
 * Layer B: API Error Mapper
 *
 * One place for mapping backend errors to frontend error types.
 * Distinguishes retryable vs non-retryable errors.
 */

import { LiveApiError } from "@/src/api/client/errors/LiveApiError";

export type ErrorClassification =
  | "validation_error"     // 4xx - bad input, don't retry
  | "auth_error"           // 401/403 - auth issue
  | "not_found"            // 404 - resource missing
  | "conflict"             // 409 - concurrent modification
  | "server_error"         // 5xx - retry with backoff
  | "network_error"        // no response - retry
  | "unknown";

export interface ClassifiedError {
  classification: ErrorClassification;
  message: string;
  status: number | null;
  retryable: boolean;
  original: unknown;
}

export function classifyApiError(error: unknown): ClassifiedError {
  if (error instanceof LiveApiError && typeof error.status === "number") {
    const status = error.status;
    if (status === 401 || status === 403) {
      return { classification: "auth_error", message: error.message, status, retryable: false, original: error };
    }
    if (status === 404) {
      return { classification: "not_found", message: error.message, status, retryable: false, original: error };
    }
    if (status === 409) {
      return { classification: "conflict", message: error.message, status, retryable: false, original: error };
    }
    if (status >= 400 && status < 500) {
      return { classification: "validation_error", message: error.message, status, retryable: false, original: error };
    }
    if (status >= 500) {
      return { classification: "server_error", message: error.message, status, retryable: true, original: error };
    }
  }

  if (error instanceof TypeError && error.message.includes("fetch")) {
    return { classification: "network_error", message: "Network request failed", status: null, retryable: true, original: error };
  }

  const message = error instanceof Error ? error.message : String(error);
  return { classification: "unknown", message, status: null, retryable: false, original: error };
}

export function isRetryableError(error: unknown): boolean {
  return classifyApiError(error).retryable;
}
