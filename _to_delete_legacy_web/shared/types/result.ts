/**
 * Shared types – result wrappers.
 */

/** Discriminated union for async operation results. */
export type AsyncResult<T, E = string> =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; data: T }
  | { status: "error"; error: E };

/** Branded type helper for nominal typing. */
export type Brand<T, B extends string> = T & { __brand: B };
