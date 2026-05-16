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

export interface RuntimeCapabilities {
  readonly runtimeTarget: RuntimeTarget;
  readonly fileDialogs: boolean;
  readonly nativeWindowControls: boolean;
  readonly systemTray: boolean;
  readonly localBackendDefault: boolean;
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

export function getRuntimeCapabilities(
  runtimeTarget: RuntimeTarget = detectRuntimeTarget(),
): RuntimeCapabilities {
  const isDesktop = runtimeTarget === "tauri" || runtimeTarget === "electron";

  return {
    runtimeTarget,
    fileDialogs: isDesktop,
    nativeWindowControls: isDesktop,
    systemTray: isDesktop,
    localBackendDefault: isDesktop,
  };
}
