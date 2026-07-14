export const PBC_INSPECTOR_CONTEXT_IDS = {
  authoring: "pbc-authoring",
  "mesh-certificate": "pbc-mesh-certificate",
  static: "pbc-static",
  "time-domain": "pbc-time-domain",
  eigenmodes: "pbc-eigenmodes",
  "frequency-response": "pbc-frequency-response",
} as const;

export type PbcInspectorContext = keyof typeof PBC_INSPECTOR_CONTEXT_IDS;

export interface PbcInspectorContextModel {
  context: PbcInspectorContext;
  contextId: (typeof PBC_INSPECTOR_CONTEXT_IDS)[PbcInspectorContext];
  /** One resource owner for status, revision, pairs, and certificate reasons. */
  resourceOwner: "meshing.mesh.periodic_pairs";
  stageSpecific: boolean;
}

const CONTEXT_MODELS: Record<PbcInspectorContext, PbcInspectorContextModel> = {
  authoring: {
    context: "authoring",
    contextId: PBC_INSPECTOR_CONTEXT_IDS.authoring,
    resourceOwner: "meshing.mesh.periodic_pairs",
    stageSpecific: false,
  },
  "mesh-certificate": {
    context: "mesh-certificate",
    contextId: PBC_INSPECTOR_CONTEXT_IDS["mesh-certificate"],
    resourceOwner: "meshing.mesh.periodic_pairs",
    stageSpecific: false,
  },
  static: {
    context: "static",
    contextId: PBC_INSPECTOR_CONTEXT_IDS.static,
    resourceOwner: "meshing.mesh.periodic_pairs",
    stageSpecific: true,
  },
  "time-domain": {
    context: "time-domain",
    contextId: PBC_INSPECTOR_CONTEXT_IDS["time-domain"],
    resourceOwner: "meshing.mesh.periodic_pairs",
    stageSpecific: true,
  },
  eigenmodes: {
    context: "eigenmodes",
    contextId: PBC_INSPECTOR_CONTEXT_IDS.eigenmodes,
    resourceOwner: "meshing.mesh.periodic_pairs",
    stageSpecific: true,
  },
  "frequency-response": {
    context: "frequency-response",
    contextId: PBC_INSPECTOR_CONTEXT_IDS["frequency-response"],
    resourceOwner: "meshing.mesh.periodic_pairs",
    stageSpecific: true,
  },
};

const AUTHORING_KINDS = new Set([
  "physics.pbc",
  "physics.periodic",
  "physics.coupling.pbc",
  "model:physics:pbc",
]);

const MESH_CERTIFICATE_KINDS = new Set([
  "resources.mesh.periodic_pairs",
]);

const STATIC_KINDS = new Set([
  "study.stage.relax",
  "study.stage.hysteresis",
]);

const TIME_DOMAIN_KINDS = new Set([
  "study.stage.run",
  "study.stage.action",
  "study.stage.change_device",
  "study.stage.save_state",
]);

function contextForPrefix(kind: string, prefix: string, context: PbcInspectorContext) {
  return kind.startsWith(prefix) ? CONTEXT_MODELS[context] : null;
}

/**
 * Resolve the semantic PBC inspector context without inspecting stage-specific
 * payloads.  Consumers use the returned resource owner for the shared
 * revision/status view and append only context-specific observables.
 */
export function resolvePbcInspectorContext(
  kind: string | null | undefined,
): PbcInspectorContextModel | null {
  if (!kind) return null;
  if (AUTHORING_KINDS.has(kind)) return CONTEXT_MODELS.authoring;
  if (MESH_CERTIFICATE_KINDS.has(kind)) return CONTEXT_MODELS["mesh-certificate"];
  if (STATIC_KINDS.has(kind)) return CONTEXT_MODELS.static;
  if (TIME_DOMAIN_KINDS.has(kind)) return CONTEXT_MODELS["time-domain"];
  if (kind.startsWith("study.stage.eigenmodes") || kind.startsWith("results.eigen")) {
    return CONTEXT_MODELS.eigenmodes;
  }
  if (
    kind.startsWith("study.stage.frequency_response") ||
    kind.startsWith("results.frequency_response") ||
    kind.startsWith("results.frequency_domain") ||
    kind.startsWith("resources.analysis.frequency") ||
    kind.startsWith("diagnostics.frequency_domain")
  ) {
    return CONTEXT_MODELS["frequency-response"];
  }
  return (
    contextForPrefix(kind, "study.stage.static", "static") ??
    contextForPrefix(kind, "study.stage.time", "time-domain")
  );
}
