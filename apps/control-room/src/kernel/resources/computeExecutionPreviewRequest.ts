import type { ComputePreviewRequest } from "../api/apiTypes";

export interface PreparedComputeExecutionPreview {
  readonly request: ComputePreviewRequest;
  /** Digest of the HTTP body, not the server's canonical source digest. */
  readonly bodySha256: string;
  readonly apiScope: string;
  readonly sessionScope: string;
}

function freezeJson(value: unknown): void {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) freezeJson(child);
  }
}

/** Detach explicit canonical inputs before an asynchronous preview request.
 * No Scene/Study conversion, defaults, host inference or resolver lives here.
 */
export async function prepareComputeExecutionPreview(
  request: ComputePreviewRequest,
  scope: { apiScope: string; sessionScope: string },
): Promise<PreparedComputeExecutionPreview> {
  const { apiScope, sessionScope } = scope;
  if (!apiScope || !sessionScope) throw new Error("A current API and session scope is required.");
  const body = JSON.stringify(request);
  const bytes = new TextEncoder().encode(body);
  if (bytes.byteLength > 8 * 1024 * 1024) throw new Error("Compute preview exceeds the 8 MiB input limit.");
  const detached = JSON.parse(body) as ComputePreviewRequest;
  freezeJson(detached);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const bodySha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return Object.freeze({ request: detached, bodySha256, apiScope, sessionScope });
}

export function isComputePreviewScopeCurrent(
  prepared: PreparedComputeExecutionPreview | null,
  apiScope: string,
  sessionScope: string | null,
): boolean {
  return Boolean(prepared && sessionScope && prepared.apiScope === apiScope && prepared.sessionScope === sessionScope);
}
