/**
 * Request-ID interceptor.
 * Generates a unique `x-request-id` header for every outgoing request.
 * Format: `fm-{timestamp_base36}-{random_6_chars}`
 */

function randomAlphaNum(length: number): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

export function generateRequestId(): string {
  const ts = Date.now().toString(36);
  const rand = randomAlphaNum(6);
  return `fm-${ts}-${rand}`;
}

export function applyRequestId(headers: Headers): string {
  const id = generateRequestId();
  headers.set("x-request-id", id);
  return id;
}
