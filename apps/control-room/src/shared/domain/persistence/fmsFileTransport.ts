/** Compressed FMS file intake contract; ordinary JSON requests keep their limit. */
export const MAX_FMS_FILE_BYTES = 512 * 1024 * 1024;
export const FMS_PROXY_TIMEOUT_MS = 360_000;

export function fmsFileSizeError(size: number): string | null {
  if (!Number.isSafeInteger(size) || size <= 0) {
    return "The selected archive is empty or has an invalid size.";
  }
  if (size > MAX_FMS_FILE_BYTES) {
    return "The selected archive exceeds the supported upload limit of 512 MiB.";
  }
  return null;
}

export type FmsRestoreMode = "resume" | "visualization_only" | "replace_project";

/** Archive classification describes available data, not an import operation. */
export function defaultFmsRestoreMode(restoreClass: string): FmsRestoreMode {
  switch (restoreClass) {
    case "exact_resume":
    case "logical_resume":
    case "initial_condition_import":
    case "config_only":
      // Checkpoint classification does not describe the stored modal results.
      // Opening an archive must not implicitly request checkpoint execution.
      return "visualization_only";
    default:
      throw new Error(`Unsupported archive restore class: ${restoreClass}`);
  }
}
