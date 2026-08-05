import { type LiveStatusResource, type FieldCatalogResource } from "@/kernel/api/apiTypes";
import {
  type VisualizationTargetKind,
  type VisualizationTargetRef,
  type ObjectVisualizationSnapshot,
  type VisualizationStoredTargetPatch,
  type VisualizationTargetPatch,
  type SurfaceColorSource,
  visualizationTargetKey,
} from "@/kernel/visualization/ObjectVisualizationController";

export type ObjectVisualizationManifestStatus = {
  capabilities: Pick<LiveStatusResource["capabilities"], "explicit_topology">;
  domain: Pick<LiveStatusResource["domain"], "discretization">;
  resources: Pick<LiveStatusResource["resources"], "mesh_revision">;
};

export function selectObjectVisualizationManifestStatus(status: {
  data: LiveStatusResource | null;
}): ObjectVisualizationManifestStatus | null {
  if (!status.data) return null;
  return {
    capabilities: {
      // A malformed/stale status response must not crash the inspector. The
      // lane resolver still has enough information to keep an explicit FDM
      // session on its structured-grid path; missing capability data disables
      // FEM manifest loading through the existing fail-closed gate.
      explicit_topology: status.data.capabilities?.explicit_topology ?? false,
    },
    domain: {
      discretization: status.data.domain?.discretization ?? "",
    },
    resources: {
      mesh_revision: status.data.resources?.mesh_revision,
    },
  };
}

export function objectVisualizationManifestStatusEquals(
  previous: ObjectVisualizationManifestStatus | null,
  next: ObjectVisualizationManifestStatus | null,
): boolean {
  if (previous === next) return true;
  if (!previous || !next) return previous === next;
  return (
    previous.capabilities.explicit_topology ===
      next.capabilities.explicit_topology &&
    previous.domain.discretization === next.domain.discretization &&
    previous.resources.mesh_revision === next.resources.mesh_revision
  );
}

export const OBJECT_VISUALIZATION_TARGET_KINDS: readonly VisualizationTargetKind[] = [
  "airbox",
  // FDM domain is a viewport-local target. It is included so the shared
  // target registry can resolve its controls, while the serialization bridge
  // fail-closes and never emits an FEM VisualizationState scope for it.
  "fdm-domain",
  "object",
  "part",
  "region",
];

export function selectObjectVisualizationPanelSnapshot(
  snapshot: ObjectVisualizationSnapshot,
  targets: readonly VisualizationTargetRef[],
): ObjectVisualizationSnapshot {
  const defaults: ObjectVisualizationSnapshot["defaults"] = {};
  const viewportPreferenceDefaults: NonNullable<
    ObjectVisualizationSnapshot["viewportPreferenceDefaults"]
  > = {};
  const viewportPreferences: NonNullable<
    ObjectVisualizationSnapshot["viewportPreferences"]
  > = {};
  const overrides: ObjectVisualizationSnapshot["overrides"] = {};
  const pendingOverrides: NonNullable<
    ObjectVisualizationSnapshot["pendingOverrides"]
  > = {};

  for (const target of targets) {
    const defaultPatch = snapshot.defaults[target.kind];
    if (defaultPatch) {
      defaults[target.kind] = defaultPatch;
    }
    const viewportPreferenceDefault =
      snapshot.viewportPreferenceDefaults?.[target.kind];
    if (viewportPreferenceDefault) {
      viewportPreferenceDefaults[target.kind] = viewportPreferenceDefault;
    }

    const override = snapshot.overrides[visualizationTargetKey(target)];
    if (override) {
      overrides[visualizationTargetKey(target)] = override;
    }
    const viewportPreference = snapshot.viewportPreferences?.[
      visualizationTargetKey(target)
    ];
    if (viewportPreference) {
      viewportPreferences[visualizationTargetKey(target)] = viewportPreference;
    }
    const pendingOverride = snapshot.pendingOverrides?.[
      visualizationTargetKey(target)
    ];
    if (pendingOverride) {
      pendingOverrides[visualizationTargetKey(target)] = pendingOverride;
    }
  }

  return {
    defaults,
    viewportPreferenceDefaults,
    viewportPreferences,
    overrides,
    version: snapshot.version,
  };
}

export function objectVisualizationPanelSnapshotEquals(
  previous: ObjectVisualizationSnapshot,
  next: ObjectVisualizationSnapshot,
): boolean {
  for (const kind of OBJECT_VISUALIZATION_TARGET_KINDS) {
    if (!visualizationTargetPatchEquals(previous.defaults[kind], next.defaults[kind])) {
      return false;
    }
    if (
      !visualizationTargetPatchEquals(
        previous.viewportPreferenceDefaults?.[kind],
        next.viewportPreferenceDefaults?.[kind],
      )
    ) {
      return false;
    }
  }

  const overrideKeys = new Set([
    ...Object.keys(previous.overrides),
    ...Object.keys(next.overrides),
  ]);
  for (const key of overrideKeys) {
    if (!visualizationTargetPatchEquals(previous.overrides[key], next.overrides[key])) {
      return false;
    }
  }

  const viewportPreferenceKeys = new Set([
    ...Object.keys(previous.viewportPreferences ?? {}),
    ...Object.keys(next.viewportPreferences ?? {}),
  ]);
  for (const key of viewportPreferenceKeys) {
    if (
      !visualizationTargetPatchEquals(
        previous.viewportPreferences?.[key],
        next.viewportPreferences?.[key],
      )
    ) {
      return false;
    }
  }

  const pendingOverrideKeys = new Set([
    ...Object.keys(previous.pendingOverrides ?? {}),
    ...Object.keys(next.pendingOverrides ?? {}),
  ]);
  for (const key of pendingOverrideKeys) {
    const previousPending = previous.pendingOverrides?.[key];
    const nextPending = next.pendingOverrides?.[key];
    if (
      previousPending?.baseRevision !== nextPending?.baseRevision ||
      !visualizationTargetPatchEquals(previousPending?.patch, nextPending?.patch)
    ) {
      return false;
    }
  }

  return true;
}

export function visualizationTargetPatchEquals(
  previous: VisualizationStoredTargetPatch | undefined,
  next: VisualizationStoredTargetPatch | undefined,
): boolean {
  if (previous === next) return true;
  if (!previous || !next) return previous === next;

  const keys = new Set([
    ...Object.keys(previous),
    ...Object.keys(next),
  ] as Array<keyof VisualizationStoredTargetPatch>);
  for (const key of keys) {
    if (!Object.is(previous[key], next[key])) {
      return false;
    }
  }

  return true;
}

export function surfaceFieldStatus(
  source: SurfaceColorSource,
  fieldCatalog: FieldCatalogResource | null | undefined,
  fetchStatus: string,
): string {
  if (source === "solid") return "not required";
  const revision =
    fieldCatalog?.quantities.reduce(
      (latest, quantity) =>
        quantity.available ? Math.max(latest, quantity.field_revision) : latest,
      0,
    ) ?? 0;
  if (revision > 0) {
    return `available r${revision}`;
  }
  return fetchStatus === "ready" ? "none" : fetchStatus;
}

export function viewportRenderingPreferencesPatch(
  patch: VisualizationTargetPatch,
): Partial<VisualizationTargetPatch> {
  return {
    ...(patch.primitiveVisible === undefined
      ? {}
      : { primitiveVisible: patch.primitiveVisible }),
    ...(patch.primitiveMonoColor === undefined
      ? {}
      : { primitiveMonoColor: patch.primitiveMonoColor }),
    ...(patch.primitiveOpacityPercent === undefined
      ? {}
      : { primitiveOpacityPercent: patch.primitiveOpacityPercent }),
    ...(patch.vectorCenteringEnabled === undefined
      ? {}
      : { vectorCenteringEnabled: patch.vectorCenteringEnabled }),
    ...(patch.vectorSurfaceOffsetEnabled === undefined
      ? {}
      : { vectorSurfaceOffsetEnabled: patch.vectorSurfaceOffsetEnabled }),
    ...(patch.vectorSurfaceOffsetScale === undefined
      ? {}
      : { vectorSurfaceOffsetScale: patch.vectorSurfaceOffsetScale }),
  };
}
