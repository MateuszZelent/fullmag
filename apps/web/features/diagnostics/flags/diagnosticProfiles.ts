/**
 * Layer E: Diagnostic Profiles
 *
 * Named presets that apply a coherent set of flag overrides
 * in one shot.  The mutable singleton from frontendDiagnosticFlags.ts
 * is wrapped — consumers import profiles here instead.
 */

import type { FrontendDiagnosticFlags } from "../../../lib/debug/frontendDiagnosticFlags";
import {
  getDefaultFrontendDiagnosticFlags,
  applyFrontendDiagnosticFlags,
  persistFrontendDiagnosticFlags,
} from "../../../lib/debug/frontendDiagnosticFlags";

/* ── Profile definition ──────────────────────────────────────────── */

export type DiagnosticProfileId =
  | "default"
  | "performance"
  | "debug-render"
  | "debug-viewport"
  | "minimal-shell"
  | "headless-test";

export interface DiagnosticProfile {
  id: DiagnosticProfileId;
  label: string;
  description: string;
  overrides: DeepPartial<FrontendDiagnosticFlags>;
}

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

/* ── Built-in profiles ───────────────────────────────────────────── */

export const DIAGNOSTIC_PROFILES: readonly DiagnosticProfile[] = [
  {
    id: "default",
    label: "Default",
    description: "Production defaults — all features active.",
    overrides: {},
  },
  {
    id: "performance",
    label: "Performance",
    description: "Strip all chrome for max FPS benchmarking.",
    overrides: {
      shell: {
        showSidebar: false,
        showBottomDock: false,
        showRightInspector: false,
        showStatusBar: false,
        showWorkspaceOverlays: false,
      },
      viewportChrome: {
        showTelemetryHud: false,
        showAntennaPreviewBadge: false,
        showFemSelectionBadges: false,
        showFdmSelectionBadges: false,
      },
      femViewport: {
        showPartExplorer: false,
        showToolbar: false,
        showViewCube: false,
        showOrientationSphere: false,
        showFieldLegend: false,
        showSelectionHud: false,
        enableGeometryHoverInteractions: false,
        forceLowQualityProfile: true,
      },
    },
  },
  {
    id: "debug-render",
    label: "Debug Render",
    description: "Enable render logging + perf counters.",
    overrides: {
      renderDebug: { enableRenderLogging: true },
      femViewport: { enableGeometryPerfLogging: true },
    },
  },
  {
    id: "debug-viewport",
    label: "Debug Viewport",
    description: "Expose all viewport diagnostic layers.",
    overrides: {
      viewportCore: { useBareCanvasShell: false },
      femWrapper: {
        enableInteractiveState: true,
        enablePartDerivedModel: true,
        enableVectorDerivedModel: true,
        enableBoundsDerivedModel: true,
        enableToolbarModel: true,
        enableOverlayItemsModel: true,
        enableOverlayManager: true,
        enableHoverTooltip: true,
        enableContextMenu: true,
      },
      renderDebug: { enableRenderLogging: true },
    },
  },
  {
    id: "minimal-shell",
    label: "Minimal Shell",
    description: "Viewport-only shell for embedding scenarios.",
    overrides: {
      shell: {
        showSidebar: false,
        showViewportBar: false,
        showPreviewNotices: false,
        showBottomDock: false,
        showRightInspector: false,
        showStatusBar: false,
        showWorkspaceOverlays: false,
        showBackendErrorNotice: false,
      },
    },
  },
  {
    id: "headless-test",
    label: "Headless Test",
    description: "All chrome off, no localStorage persistence.",
    overrides: {
      shell: {
        showSidebar: false,
        showViewportBar: false,
        showPreviewNotices: false,
        showBottomDock: false,
        showRightInspector: false,
        showStatusBar: false,
        showWorkspaceOverlays: false,
        showBackendErrorNotice: false,
      },
      session: {
        enableLiveWebSocket: false,
      },
    },
  },
] as const;

const profileById = new Map(DIAGNOSTIC_PROFILES.map((p) => [p.id, p]));

/* ── Apply ───────────────────────────────────────────────────────── */

/**
 * Apply a named profile.  Resets to defaults first, then applies overrides.
 * Optionally persists so the profile survives page reload.
 */
export function applyDiagnosticProfile(
  profileId: DiagnosticProfileId,
  persist = true,
): void {
  const profile = profileById.get(profileId);
  if (!profile) return;

  const next = getDefaultFrontendDiagnosticFlags();
  deepApply(next, profile.overrides);
  applyFrontendDiagnosticFlags(next);

  if (persist) {
    persistFrontendDiagnosticFlags(next);
  }
}

export function getProfileById(id: DiagnosticProfileId): DiagnosticProfile | undefined {
  return profileById.get(id);
}

/* ── helpers ── */

function deepApply(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const key of Object.keys(source)) {
    const sv = source[key];
    const tv = target[key];
    if (sv && typeof sv === "object" && !Array.isArray(sv) && tv && typeof tv === "object" && !Array.isArray(tv)) {
      deepApply(tv as Record<string, unknown>, sv as Record<string, unknown>);
    } else {
      target[key] = sv;
    }
  }
}
