import { type LiveStatusResource, type FieldCatalogResource } from "@/kernel/api/apiTypes";
import {
  projectFlatActiveLaneDiscretization,
  type SessionDiscretizationCapabilitiesProjection,
} from "@/kernel/resources/sessionDiscretization";
import {
  type VisualizationTargetKind,
  type VisualizationTargetRef,
  type ObjectVisualizationSnapshot,
  type VisualizationStoredTargetPatch,
  type VisualizationTargetPatch,
  type SurfaceColorSource,
  type ViewportTargetRenderingPreferences,
  viewportRenderingPreferencesFromTargetPatch,
  visualizationTargetKey,
} from "@/kernel/visualization/ObjectVisualizationController";

export type ObjectVisualizationManifestStatus = {
  capabilities: Pick<LiveStatusResource["capabilities"], "explicit_topology"> &
    SessionDiscretizationCapabilitiesProjection;
  domain: Pick<LiveStatusResource["domain"], "discretization"> &
    Partial<Pick<LiveStatusResource["domain"], "cell_count" | "generation_id">>;
  resources: Pick<LiveStatusResource["resources"], "mesh_revision"> &
    Partial<
      Pick<
        LiveStatusResource["resources"],
        "domain_generation_id" | "topology_revision"
      >
    >;
  session: Pick<LiveStatusResource["session"], "session_epoch" | "session_id">;
};

export function selectObjectVisualizationManifestStatus(status: {
  data: LiveStatusResource | null;
}): ObjectVisualizationManifestStatus | null {
  if (!status.data) return null;
  const sourceCapabilities = status.data.capabilities;
  const flatLane = projectFlatActiveLaneDiscretization(sourceCapabilities);
  const hasActiveLane = Object.prototype.hasOwnProperty.call(
    sourceCapabilities ?? {},
    "active_lane",
  );
  return {
    capabilities: {
      // A malformed/stale status response must not crash the inspector. The
      // lane resolver still has enough information to keep an explicit FDM
      // session on its structured-grid path; missing capability data disables
      // FEM manifest loading through the existing fail-closed gate.
      explicit_topology: status.data.capabilities?.explicit_topology ?? false,
      ...(hasActiveLane
        ? { active_lane: status.data.capabilities?.active_lane ?? null }
        : {}),
      ...(flatLane ? { active_lane_discretization: flatLane.value } : {}),
    },
    domain: {
      discretization: status.data.domain?.discretization ?? "",
      ...(status.data.domain?.cell_count === undefined
        ? {}
        : { cell_count: status.data.domain.cell_count }),
      ...(status.data.domain?.generation_id === undefined
        ? {}
        : { generation_id: status.data.domain.generation_id }),
    },
    resources: {
      mesh_revision: status.data.resources?.mesh_revision,
      ...(status.data.resources?.domain_generation_id === undefined
        ? {}
        : { domain_generation_id: status.data.resources.domain_generation_id }),
      ...(status.data.resources?.topology_revision === undefined
        ? {}
        : { topology_revision: status.data.resources.topology_revision }),
    },
    session: {
      session_epoch: status.data.session?.session_epoch ?? "",
      session_id: status.data.session?.session_id ?? "",
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
    Object.prototype.hasOwnProperty.call(
      previous.capabilities,
      "active_lane",
    ) === Object.prototype.hasOwnProperty.call(next.capabilities, "active_lane") &&
    previous.capabilities.active_lane?.resolved?.discretization ===
      next.capabilities.active_lane?.resolved?.discretization &&
    Object.prototype.hasOwnProperty.call(
      previous.capabilities,
      "active_lane_discretization",
    ) ===
      Object.prototype.hasOwnProperty.call(
        next.capabilities,
        "active_lane_discretization",
      ) &&
    previous.capabilities.active_lane_discretization ===
      next.capabilities.active_lane_discretization &&
    previous.domain.discretization === next.domain.discretization &&
    previous.domain.cell_count === next.domain.cell_count &&
    previous.domain.generation_id === next.domain.generation_id &&
    previous.resources.mesh_revision === next.resources.mesh_revision &&
    previous.resources.domain_generation_id ===
      next.resources.domain_generation_id &&
    previous.resources.topology_revision === next.resources.topology_revision &&
    previous.session.session_id === next.session.session_id &&
    previous.session.session_epoch === next.session.session_epoch
  );
}

export const OBJECT_VISUALIZATION_TARGET_KINDS: readonly VisualizationTargetKind[] = [
  "airbox",
  // FDM domain is a viewport-local target. It is included so the shared
  // target registry can resolve its controls, while the serialization bridge
  // fail-closes and never emits an FEM VisualizationState scope for it.
  "fdm-domain",
  "fdm-native-layer",
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
    pendingOverrides,
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
      previousPending?.transactionId !== nextPending?.transactionId ||
      !fieldTransactionIdsEqual(
        previousPending?.fieldTransactionIds,
        nextPending?.fieldTransactionIds,
      ) ||
      !visualizationTargetPatchEquals(previousPending?.patch, nextPending?.patch)
    ) {
      return false;
    }
  }

  return true;
}

function fieldTransactionIdsEqual(
  left: Readonly<Record<string, string | undefined>> | undefined,
  right: Readonly<Record<string, string | undefined>> | undefined,
): boolean {
  const keys = new Set([...Object.keys(left ?? {}), ...Object.keys(right ?? {})]);
  for (const key of keys) {
    if (left?.[key] !== right?.[key]) return false;
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
): ViewportTargetRenderingPreferences {
  return viewportRenderingPreferencesFromTargetPatch(patch);
}
