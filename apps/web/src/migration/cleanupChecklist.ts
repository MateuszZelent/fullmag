/**
 * Runtime diagnostic that reports which legacy code paths are still in use
 * and what their migration targets are.
 */

interface CleanupItem {
  id: string;
  description: string;
  module: string;
  status: "active" | "migrated" | "deprecated";
}

const CLEANUP_ITEMS: CleanupItem[] = [
  { id: "bootstrap-endpoint", description: "GET /bootstrap → replaced by GET /status", module: "lib/useSessionStream.ts", status: "deprecated" },
  { id: "poll-endpoint", description: "GET /poll → replaced by GET /status", module: "lib/useSessionStream.ts", status: "deprecated" },
  { id: "preview-component", description: "POST /preview/component → PATCH /display", module: "lib/liveApiClient.ts", status: "migrated" },
  { id: "preview-everyN", description: "POST /preview/everyN → PATCH /display", module: "lib/liveApiClient.ts", status: "migrated" },
  { id: "preview-maxPoints", description: "POST /preview/maxPoints → removed with preview compat transport", module: "lib/liveApiClient.ts", status: "migrated" },
  { id: "preview-layer", description: "POST /preview/layer → PATCH /display", module: "lib/liveApiClient.ts", status: "migrated" },
  { id: "preview-allLayers", description: "POST /preview/allLayers → PATCH /display", module: "lib/liveApiClient.ts", status: "migrated" },
  { id: "preview-autoScale", description: "POST /preview/autoScaleEnabled → PATCH /display", module: "lib/liveApiClient.ts", status: "migrated" },
  { id: "preview-selection", description: "POST /preview/selection → PATCH /display", module: "lib/liveApiClient.ts", status: "migrated" },
  { id: "normalize-ts", description: "84KB normalize.ts → eliminated by typed API", module: "lib/session/normalize.ts", status: "deprecated" },
  { id: "merge-ts", description: "mergeSessionState → eliminated by revision cache", module: "lib/session/merge.ts", status: "deprecated" },
  { id: "viewport-fdm-entry", description: "VIEWPORT_3D_FDM → merged into UNIFIED_VIEWPORT_3D", module: "features/viewport-core/registry/viewRegistry.ts", status: "deprecated" },
  { id: "viewport-fem-entry", description: "VIEWPORT_3D_FEM → merged into UNIFIED_VIEWPORT_3D", module: "features/viewport-core/registry/viewRegistry.ts", status: "deprecated" },
  { id: "isFemBackend-selector", description: "selectIsFemBackend → replaced by capability guards", module: "features/session-runtime/store", status: "deprecated" },
  { id: "binary-preview-codec", description: "lib/session/binary-preview.ts → src/api/codecs/fieldVectorCodec.ts", module: "lib/session/binary-preview.ts", status: "deprecated" },
  { id: "binary-fem-mesh-codec", description: "lib/session/binary-fem-mesh.ts → src/api/codecs/topologyCodec.ts", module: "lib/session/binary-fem-mesh.ts", status: "deprecated" },
];

export function getCleanupChecklist(): CleanupItem[] {
  return CLEANUP_ITEMS;
}

export function getActiveDeprecations(): CleanupItem[] {
  return CLEANUP_ITEMS.filter((i) => i.status === "deprecated");
}

export function printCleanupReport(): void {
  console.group("[Migration] Cleanup Checklist");
  for (const item of CLEANUP_ITEMS) {
    const icon =
      item.status === "migrated"
        ? "✅"
        : item.status === "deprecated"
          ? "⚠️"
          : "🔵";
    console.log(
      `${icon} ${item.id}: ${item.description} (${item.module})`,
    );
  }
  console.groupEnd();
}
