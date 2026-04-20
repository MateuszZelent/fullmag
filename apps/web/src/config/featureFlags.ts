/**
 * Feature flags for API migration.
 *
 * During the resource-first API migration, these flags control whether
 * the frontend uses the new API client or the legacy bootstrap flow.
 */

/** When true, use the new resource-first API client instead of legacy bootstrap/poll. */
export const USE_NEW_API =
  process.env.NEXT_PUBLIC_USE_NEW_API === "true" ||
  process.env.NEXT_PUBLIC_USE_NEW_API === "1";

/** API contract version that the frontend expects. */
export const EXPECTED_API_CONTRACT_VERSION = "1.0.0";
