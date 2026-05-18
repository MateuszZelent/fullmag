export type RuntimeTarget = "web" | "tauri" | "electron";

interface RuntimeDetectionSource {
  readonly __TAURI__?: unknown;
  readonly __TAURI_INTERNALS__?: unknown;
  readonly process?: {
    readonly versions?: {
      readonly electron?: string;
    };
  };
}

export function detectRuntimeTarget(
  source: RuntimeDetectionSource = globalThis as RuntimeDetectionSource,
): RuntimeTarget {
  if (source.__TAURI_INTERNALS__ || source.__TAURI__) {
    return "tauri";
  }

  if (source.process?.versions?.electron) {
    return "electron";
  }

  return "web";
}
