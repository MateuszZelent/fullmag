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
