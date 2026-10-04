const INSTANCE_QUERY = "fullmag_api_instance";
export const API_INSTANCE_HEADER = "x-fullmag-api-instance";

export function isApiInstanceId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
    && value !== "00000000-0000-0000-0000-000000000000";
}

/** Captured once by the API client; never persist or adopt a replacement pin. */
export function resolveApiInstancePin(search?: string): string | null {
  const source = search ?? (typeof window === "undefined" ? "" : window.location.search);
  const values = new URLSearchParams(source).getAll(INSTANCE_QUERY);
  if (values.length === 0) return null;
  if (values.length !== 1 || !isApiInstanceId(values[0])) {
    throw new Error("Invalid API instance pin; reopen Fullmag from its launcher");
  }
  return values[0];
}

/** Update navigation only for a confirmed, explicit handoff from this exact pin. */
export function developmentReplacementUrl(currentUrl: string, previousPin: string | null, replacementPin: string | null): string {
  if (!previousPin || !replacementPin || !isApiInstanceId(previousPin) || !isApiInstanceId(replacementPin) || previousPin === replacementPin) {
    throw new Error("Invalid development replacement navigation pin.");
  }
  const url = new URL(currentUrl);
  const currentPin = resolveApiInstancePin(url.search);
  if (currentPin !== previousPin && currentPin !== replacementPin) {
    throw new Error("Navigation no longer belongs to the captured workspace.");
  }
  url.searchParams.set(INSTANCE_QUERY, replacementPin);
  return url.href;
}
