/**
 * Utilities for marking and tracking deprecated code paths
 * during the API migration.
 */

const warned = new Set<string>();

/**
 * Emits a one-time console warning for a deprecated code path.
 * Subsequent calls with the same `id` are silently ignored.
 */
export function deprecatedPath(id: string, message: string): void {
  if (warned.has(id)) return;
  warned.add(id);
  console.warn(
    `[DEPRECATED] ${id}: ${message}. This will be removed in the next release.`,
  );
}

/**
 * Returns true when the new API layer is NOT enabled,
 * meaning the legacy code path should be used.
 */
export function isLegacyApiPath(): boolean {
  return !(
    process.env.NEXT_PUBLIC_USE_NEW_API === "true" ||
    process.env.NEXT_PUBLIC_USE_NEW_API === "1"
  );
}
