import type { Selection } from "@/kernel/selection/selectionTypes";
import {
  resolveArtifactAssessment,
  type ArtifactAssessmentState,
  type ResourceLoadState,
} from "@/shared/domain/mesh/artifactAssessment";

export type FemMeshGuideStepId =
  | "geometry"
  | "materials"
  | "airbox-domain"
  | "object-sizing"
  | "shared-domain-build"
  | "quality-gates";

export type FemMeshGuideStepStatus =
  | "ready"
  | "recommended"
  | "missing"
  | "stale"
  | "in-progress"
  | "warning"
  | "failed"
  | "blocked";

export type FemMeshGuideOverallStatus =
  | "blocked"
  | "needs-build"
  | "building"
  | "stale"
  | "failed"
  | "quality-warning"
  | "ready";

export type GuideSelection = Omit<Selection, "moduleSource">;

export type FemMeshGuideActionTarget =
  | { kind: "select-node"; selection: GuideSelection; tab?: "geometry" | "mesh" }
  | { kind: "execute-command"; commandId: string; label: string }
  | {
      kind: "focus-inspector-section";
      selection: GuideSelection;
      sectionId?: string;
    };

export interface FemMeshGuideParameterChip {
  label: string;
  source: "authored" | "effective" | "missing";
  value: string;
}

export interface FemMeshGuideStep {
  actionLabel: string;
  actionTarget: FemMeshGuideActionTarget;
  detail: string;
  id: FemMeshGuideStepId;
  optional: boolean;
  parameterChips: readonly FemMeshGuideParameterChip[];
  status: FemMeshGuideStepStatus;
  statusLabel: string;
  summary: string;
  title: string;
}

export interface FemMeshReadinessGuideModel {
  completedRequiredSteps: number;
  headline: string;
  nextRecommendedStep: FemMeshGuideStep | null;
  overallStatus: FemMeshGuideOverallStatus;
  overallStatusLabel: string;
  progressRatio: number;
  selectedObjectContext: {
    hasExplicitPolicy: boolean;
    objectId: string;
    objectName: string;
  } | null;
  steps: readonly FemMeshGuideStep[];
  subheadline: string;
  totalRequiredSteps: number;
}

export interface EvaluateFemMeshReadinessGuideInput {
  activeBuild?: unknown;
  geometryValidation?: unknown;
  latestBuild?: unknown;
  manifest?: unknown;
  manifestLoadState?: ResourceLoadState;
  meshSemantics?: unknown;
  meshSummary?: unknown;
  qualityGates?: unknown;
  scene?: unknown;
  selectedObjectId?: string | null;
  selectedObjectPolicy?: unknown;
  sharedDomainPolicy?: unknown;
  universePolicy?: unknown;
}

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function formatLengthSi(value: unknown): string | null {
  const num = asNumber(value);
  if (num === null) return null;
  if (num === 0) return "0 m";
  const abs = Math.abs(num);
  if (abs >= 1e-3 && abs < 1e3) {
    return `${Number(num.toPrecision(4))} m`;
  }
  return `${num.toExponential(2)} m`;
}

function formatVectorSi(value: unknown): string | null {
  if (!Array.isArray(value) || value.length !== 3) return null;
  const parts = value.map((item) => asNumber(item));
  if (parts.some((item) => item === null)) return null;
  return `[${parts.map((item) => formatLengthSi(item) ?? String(item)).join(", ")}]`;
}

interface ParsedSceneObject {
  geometryKind: string;
  id: string;
  materialRef: string | null;
  name: string;
}

function extractSceneObjects(scene: unknown): ParsedSceneObject[] {
  const record = asRecord(scene);
  const rawObjects = record?.objects;
  if (!Array.isArray(rawObjects)) return [];
  const result: ParsedSceneObject[] = [];
  for (const item of rawObjects) {
    const obj = asRecord(item);
    if (!obj) continue;
    const id = asString(obj.id) ?? asString(obj.object_id);
    if (!id) continue;
    const name = asString(obj.name) ?? id;
    const rawMaterial = asString(obj.material_ref);
    const materialRef =
      rawMaterial && rawMaterial.toLowerCase() !== "unassigned"
        ? rawMaterial
        : null;
    const geometry = asRecord(obj.geometry);
    const geometryKind =
      asString(geometry?.geometry_kind) ??
      asString(geometry?.kind) ??
      "primitive";
    result.push({
      geometryKind,
      id,
      materialRef,
      name,
    });
  }
  return result;
}

function extractGeometryValidationIssues(validation: unknown): {
  errors: string[];
  warnings: string[];
} {
  const errors: string[] = [];
  const warnings: string[] = [];
  const record = asRecord(validation);
  if (!record) return { errors, warnings };

  if (record.valid === false && errors.length === 0) {
    const topMsg =
      asString(record.message) ??
      asString(record.error) ??
      asString(record.reason);
    if (topMsg) errors.push(topMsg);
  }

  const visit = (node: unknown, defaultSeverity: "error" | "warning"): void => {
    if (Array.isArray(node)) {
      for (const entry of node) visit(entry, defaultSeverity);
      return;
    }
    const item = asRecord(node);
    if (!item) return;
    const severityRaw = (
      asString(item.severity) ??
      asString(item.level) ??
      asString(item.status) ??
      defaultSeverity
    ).toLowerCase();
    const msg =
      asString(item.message) ??
      asString(item.error) ??
      asString(item.reason) ??
      asString(item.detail);
    if (msg) {
      if (
        severityRaw.includes("err") ||
        severityRaw.includes("block") ||
        severityRaw.includes("fail") ||
        severityRaw.includes("invalid")
      ) {
        if (!errors.includes(msg)) errors.push(msg);
      } else if (severityRaw.includes("warn")) {
        if (!warnings.includes(msg)) warnings.push(msg);
      }
    }
    if (Array.isArray(item.errors)) visit(item.errors, "error");
    if (Array.isArray(item.issues)) visit(item.issues, "error");
    if (Array.isArray(item.warnings)) visit(item.warnings, "warning");
    if (Array.isArray(item.diagnostics)) visit(item.diagnostics, "warning");
  };

  visit(record, "warning");
  if (record.valid === false && errors.length === 0) {
    errors.push("Geometry validation reported an invalid scene configuration.");
  }
  return { errors, warnings };
}

function hasNonEmptyPolicyObject(value: unknown): boolean {
  const record = asRecord(value);
  return Boolean(record && Object.keys(record).length > 0);
}

interface ParsedObjectPolicySummary {
  authoredCount: number;
  byObjectId: Map<
    string,
    {
      authored: boolean;
      hmax: string | null;
      hmin: string | null;
      strategy: string | null;
    }
  >;
}

function extractObjectPolicies(
  sceneObjects: readonly ParsedSceneObject[],
  meshSemantics: unknown,
  selectedObjectId: string | null | undefined,
  selectedObjectPolicy: unknown,
): ParsedObjectPolicySummary {
  const byObjectId = new Map<
    string,
    {
      authored: boolean;
      hmax: string | null;
      hmin: string | null;
      strategy: string | null;
    }
  >();

  const semanticsRecord = asRecord(meshSemantics);
  const objectConfigs = Array.isArray(semanticsRecord?.object_configs)
    ? semanticsRecord.object_configs
    : [];

  for (const rawEntry of objectConfigs) {
    const entry = asRecord(rawEntry);
    if (!entry) continue;
    const objectId = asString(entry.object_id) ?? asString(entry.id);
    if (!objectId) continue;
    const config = asRecord(entry.config) ?? asRecord(entry.policy);
    const effective =
      asRecord(entry.effective_config) ??
      asRecord(entry.effective_target) ??
      config;
    const authored = hasNonEmptyPolicyObject(config);
    byObjectId.set(objectId, {
      authored,
      hmax:
        formatLengthSi(config?.maximum_element_size) ??
        formatLengthSi(effective?.maximum_element_size) ??
        formatLengthSi(config?.h_max) ??
        formatLengthSi(effective?.h_max),
      hmin:
        formatLengthSi(config?.minimum_element_size) ??
        formatLengthSi(effective?.minimum_element_size) ??
        formatLengthSi(config?.h_min) ??
        formatLengthSi(effective?.h_min),
      strategy:
        asString(config?.mesh_strategy) ??
        asString(effective?.mesh_strategy) ??
        asString(config?.topology) ??
        asString(effective?.topology),
    });
  }

  const selectedPolicyRecord = asRecord(selectedObjectPolicy);
  if (selectedObjectId && selectedPolicyRecord) {
    const config = asRecord(selectedPolicyRecord.config);
    const effective = asRecord(selectedPolicyRecord.effective_config);
    const authored = hasNonEmptyPolicyObject(config);
    const existing = byObjectId.get(selectedObjectId);
    byObjectId.set(selectedObjectId, {
      authored: authored || Boolean(existing?.authored),
      hmax:
        formatLengthSi(config?.maximum_element_size) ??
        formatLengthSi(effective?.maximum_element_size) ??
        existing?.hmax ??
        null,
      hmin:
        formatLengthSi(config?.minimum_element_size) ??
        formatLengthSi(effective?.minimum_element_size) ??
        existing?.hmin ??
        null,
      strategy:
        asString(config?.mesh_strategy) ??
        asString(effective?.mesh_strategy) ??
        asString(config?.topology) ??
        existing?.strategy ??
        null,
    });
  }

  let authoredCount = 0;
  for (const obj of sceneObjects) {
    if (byObjectId.get(obj.id)?.authored) {
      authoredCount += 1;
    }
  }

  return { authoredCount, byObjectId };
}

function buildObjectsRootSelection(): GuideSelection {
  return {
    kind: "objects.root",
    label: "Objects",
    nodeId: "model:objects",
    objectId: null,
    ref: null,
  };
}

function buildObjectGeneralSelection(obj: ParsedSceneObject): GuideSelection {
  return {
    kind: "object",
    label: obj.name,
    nodeId: `model:object:${obj.id}`,
    objectId: obj.id,
    ref: {
      kind: "object.root",
      nodeId: `model:object:${obj.id}`,
      objectId: obj.id,
      type: "scene-object",
      visualizationTargetId: `object:${obj.id}`,
    },
  };
}

function buildObjectMeshSelection(obj: ParsedSceneObject): GuideSelection {
  return {
    kind: "object.mesh",
    label: "Mesh",
    nodeId: `model:object:${obj.id}:mesh`,
    objectId: obj.id,
    ref: {
      kind: "object.mesh",
      nodeId: `model:object:${obj.id}:mesh`,
      objectId: obj.id,
      type: "scene-object",
      visualizationTargetId: `object:${obj.id}`,
    },
  };
}

function buildAirboxMeshParametersSelection(): GuideSelection {
  return {
    kind: "airbox.mesh.parameters",
    label: "Mesh Parameters",
    nodeId: "model:airbox:mesh:parameters",
    objectId: null,
    ref: null,
  };
}

function buildMeshQualitySelection(): GuideSelection {
  return {
    kind: "mesh.quality",
    label: "Mesh Quality",
    nodeId: "model:mesh:quality",
    objectId: null,
    ref: null,
  };
}

function resolveSharedDomainBuildStep({
  activeBuildRecord,
  assessmentState,
  geometryReady,
  lastBuildError,
  manifestRecord,
  presence,
  sceneRevision,
}: {
  activeBuildRecord: JsonRecord | null;
  assessmentState: ArtifactAssessmentState | null;
  geometryReady: boolean;
  lastBuildError: string | null;
  manifestRecord: JsonRecord | null;
  presence: "not-built" | "present";
  sceneRevision: number | null;
}): FemMeshGuideStep {
  const topologyCounts = asRecord(manifestRecord?.topology_counts);
  const elementCount =
    asNumber(topologyCounts?.elements) ??
    asNumber(topologyCounts?.tetrahedra) ??
    asNumber(manifestRecord?.element_count);
  const nodeCount =
    asNumber(topologyCounts?.nodes) ??
    asNumber(topologyCounts?.vertices) ??
    asNumber(manifestRecord?.node_count);
  const sourceRev = asNumber(manifestRecord?.source_scene_revision);

  const chips: FemMeshGuideParameterChip[] = [];
  if (sceneRevision !== null) {
    chips.push({
      label: "scene_rev",
      source: "effective",
      value: String(sceneRevision),
    });
  }
  if (sourceRev !== null) {
    chips.push({
      label: "mesh_source_rev",
      source: sourceRev === sceneRevision ? "authored" : "missing",
      value: String(sourceRev),
    });
  }
  if (elementCount !== null) {
    chips.push({
      label: "elements",
      source: "effective",
      value: elementCount.toLocaleString("en-US"),
    });
  }
  if (nodeCount !== null) {
    chips.push({
      label: "nodes",
      source: "effective",
      value: nodeCount.toLocaleString("en-US"),
    });
  }

  if (!geometryReady) {
    return {
      actionLabel: "Fix Geometry First",
      actionTarget: {
        kind: "select-node",
        selection: buildObjectsRootSelection(),
        tab: "geometry",
      },
      detail:
        "Shared-domain FEM meshing requires at least one valid geometry object in the scene.",
      id: "shared-domain-build",
      optional: false,
      parameterChips: chips,
      status: "blocked",
      statusLabel: "Blocked",
      summary: "Waiting for valid scene geometry",
      title: "5. Shared-Domain FEM Mesh Build",
    };
  }

  if (assessmentState === "loading" && activeBuildRecord) {
    const activePhase =
      asString(activeBuildRecord.phase) ??
      asString(activeBuildRecord.status) ??
      "running";
    return {
      actionLabel: "View Build Pipeline",
      actionTarget: {
        kind: "select-node",
        selection: {
          kind: "mesh.builds",
          label: "Build Pipeline",
          nodeId: "model:mesh:builds",
          objectId: null,
          ref: null,
        },
        tab: "mesh",
      },
      detail: `Shared-domain mesh build is currently ${activePhase}.`,
      id: "shared-domain-build",
      optional: false,
      parameterChips: chips,
      status: "in-progress",
      statusLabel: "Building",
      summary: `Mesh build in progress (${activePhase})`,
      title: "5. Shared-Domain FEM Mesh Build",
    };
  }

  if (
    assessmentState === "failed" ||
    (lastBuildError && assessmentState !== "current")
  ) {
    return {
      actionLabel: "Rebuild Shared-Domain Mesh",
      actionTarget: {
        commandId: "mesh.build-shared-domain",
        kind: "execute-command",
        label: "Rebuild Shared-Domain Mesh",
      },
      detail:
        lastBuildError ??
        "The latest shared-domain mesh build failed for the current scene revision. Inspect parameters or rebuild.",
      id: "shared-domain-build",
      optional: false,
      parameterChips: chips,
      status: "failed",
      statusLabel: "Failed",
      summary: "Last shared-domain mesh build failed",
      title: "5. Shared-Domain FEM Mesh Build",
    };
  }

  if (presence === "not-built") {
    return {
      actionLabel: "Build Shared-Domain Mesh",
      actionTarget: {
        commandId: "mesh.build-shared-domain",
        kind: "execute-command",
        label: "Build Shared-Domain Mesh",
      },
      detail:
        "FEM solvers require a realized shared-domain mesh (objects + Airbox). Per-object preview meshes alone do not satisfy study readiness.",
      id: "shared-domain-build",
      optional: false,
      parameterChips:
        chips.length > 0
          ? chips
          : [
              {
                label: "study_domain",
                source: "missing",
                value: "not built",
              },
            ],
      status: "missing",
      statusLabel: "Action Required",
      summary: "No shared-domain solver mesh built yet",
      title: "5. Shared-Domain FEM Mesh Build",
    };
  }

  if (assessmentState === "current") {
    return {
      actionLabel: "Rebuild Shared-Domain Mesh",
      actionTarget: {
        commandId: "mesh.build-shared-domain",
        kind: "execute-command",
        label: "Rebuild Shared-Domain Mesh",
      },
      detail:
        "The realized shared-domain FEM mesh matches the current scene revision and is ready for solver execution.",
      id: "shared-domain-build",
      optional: false,
      parameterChips: chips,
      status: "ready",
      statusLabel: "Current",
      summary:
        elementCount !== null
          ? `Ready (${elementCount.toLocaleString("en-US")} elements)`
          : "Shared-domain mesh is current",
      title: "5. Shared-Domain FEM Mesh Build",
    };
  }

  return {
    actionLabel: "Rebuild Shared-Domain Mesh",
    actionTarget: {
      commandId: "mesh.build-shared-domain",
      kind: "execute-command",
      label: "Rebuild Shared-Domain Mesh",
    },
    detail:
      "Scene geometry or mesh policies changed after the last shared-domain mesh build. Rebuild to synchronize the solver mesh.",
    id: "shared-domain-build",
    optional: false,
    parameterChips: chips,
    status: "stale",
    statusLabel: "Stale",
    summary: `Mesh is out of date (mesh rev ${sourceRev ?? "?"} vs scene rev ${sceneRevision ?? "?"})`,
    title: "5. Shared-Domain FEM Mesh Build",
  };
}

export function evaluateFemMeshReadinessGuide(
  input: EvaluateFemMeshReadinessGuideInput,
): FemMeshReadinessGuideModel {
  const sceneObjects = extractSceneObjects(input.scene);
  const { errors: validationErrors, warnings: validationWarnings } =
    extractGeometryValidationIssues(input.geometryValidation);

  const selectedObject =
    (input.selectedObjectId
      ? sceneObjects.find((obj) => obj.id === input.selectedObjectId)
      : null) ??
    sceneObjects[0] ??
    null;

  // Step 1: Geometry & Validation
  const geometryStep: FemMeshGuideStep = (() => {
    if (sceneObjects.length === 0) {
      return {
        actionLabel: "Open Geometry Tab",
        actionTarget: {
          kind: "select-node",
          selection: buildObjectsRootSelection(),
          tab: "geometry",
        },
        detail:
          "No committed geometry objects exist in the scene. Add a primitive (Box, Cylinder, Ellipsoid) or import CAD geometry before meshing.",
        id: "geometry",
        optional: false,
        parameterChips: [
          { label: "objects", source: "missing", value: "0 committed" },
        ],
        status: "missing",
        statusLabel: "Missing",
        summary: "Add at least one 3D object to the scene",
        title: "1. Scene Geometry & Validation",
      };
    }

    if (validationErrors.length > 0) {
      return {
        actionLabel: "Inspect Object Geometry",
        actionTarget: {
          kind: "select-node",
          selection: buildObjectGeneralSelection(selectedObject!),
          tab: "geometry",
        },
        detail: validationErrors[0]!,
        id: "geometry",
        optional: false,
        parameterChips: [
          {
            label: "objects",
            source: "authored",
            value: String(sceneObjects.length),
          },
          {
            label: "validation",
            source: "missing",
            value: `${validationErrors.length} error(s)`,
          },
        ],
        status: "blocked",
        statusLabel: "Invalid",
        summary: `${validationErrors.length} geometry validation error(s) block meshing`,
        title: "1. Scene Geometry & Validation",
      };
    }

    return {
      actionLabel: "Inspect Objects",
      actionTarget: {
        kind: "select-node",
        selection: buildObjectGeneralSelection(selectedObject!),
      },
      detail:
        validationWarnings.length > 0
          ? `Geometry is valid with ${validationWarnings.length} warning(s): ${validationWarnings[0]}`
          : `${sceneObjects.length} committed object(s) passed geometry validation.`,
      id: "geometry",
      optional: false,
      parameterChips: [
        {
          label: "objects",
          source: "authored",
          value: String(sceneObjects.length),
        },
        {
          label: "validation",
          source: "effective",
          value:
            validationWarnings.length > 0
              ? `${validationWarnings.length} warning(s)`
              : "valid",
        },
      ],
      status: "ready",
      statusLabel: "Ready",
      summary: `${sceneObjects.length} valid object(s) in scene`,
      title: "1. Scene Geometry & Validation",
    };
  })();

  // Step 2: Material Assignment
  const objectsWithoutMaterial = sceneObjects.filter(
    (obj) => obj.materialRef === null,
  );
  const materialsStep: FemMeshGuideStep = (() => {
    if (sceneObjects.length === 0) {
      return {
        actionLabel: "Add Geometry First",
        actionTarget: {
          kind: "select-node",
          selection: buildObjectsRootSelection(),
          tab: "geometry",
        },
        detail:
          "Assigning a material after creating geometry enables physics-calibrated mesh presets (exchange length l_ex).",
        id: "materials",
        optional: false,
        parameterChips: [],
        status: "blocked",
        statusLabel: "Blocked",
        summary: "Requires scene geometry",
        title: "2. Object Material Assignment",
      };
    }

    if (objectsWithoutMaterial.length > 0) {
      const targetObj = objectsWithoutMaterial[0]!;
      return {
        actionLabel: `Assign Material (${targetObj.name})`,
        actionTarget: {
          kind: "select-node",
          selection: buildObjectGeneralSelection(targetObj),
        },
        detail: `${objectsWithoutMaterial.length} of ${sceneObjects.length} object(s) have no material assigned (${objectsWithoutMaterial.map((o) => o.name).join(", ")}). Assign a material for physics-aware sizing and solver readiness.`,
        id: "materials",
        optional: false,
        parameterChips: [
          {
            label: "unassigned",
            source: "missing",
            value: `${objectsWithoutMaterial.length}/${sceneObjects.length}`,
          },
        ],
        status: "warning",
        statusLabel: "Missing Material",
        summary: `${objectsWithoutMaterial.length} object(s) missing material_ref`,
        title: "2. Object Material Assignment",
      };
    }

    return {
      actionLabel: "Inspect Material",
      actionTarget: {
        kind: "select-node",
        selection: buildObjectGeneralSelection(selectedObject!),
      },
      detail:
        "All scene objects have an assigned material reference for exchange-length calibration and FEM domain assembly.",
      id: "materials",
      optional: false,
      parameterChips: sceneObjects.slice(0, 3).map((obj) => ({
        label: obj.name,
        source: "authored" as const,
        value: obj.materialRef ?? "assigned",
      })),
      status: "ready",
      statusLabel: "Ready",
      summary: `Materials assigned (${sceneObjects.length}/${sceneObjects.length})`,
      title: "2. Object Material Assignment",
    };
  })();

  // Step 3: Airbox & Universe Domain Policy
  const universeRecord = asRecord(input.universePolicy);
  const universeConfig = asRecord(universeRecord?.config);
  const universeEffective = asRecord(universeRecord?.effective_config);
  const universeAuthored = hasNonEmptyPolicyObject(universeConfig);
  const airboxMode =
    asString(universeConfig?.mode) ??
    asString(universeEffective?.mode) ??
    "auto";
  const airboxHmax =
    formatLengthSi(universeConfig?.airbox_hmax) ??
    formatLengthSi(universeEffective?.airbox_hmax);
  const airboxHmin =
    formatLengthSi(universeConfig?.airbox_hmin) ??
    formatLengthSi(universeEffective?.airbox_hmin);
  const airboxPadding =
    formatVectorSi(universeConfig?.padding) ??
    formatVectorSi(universeEffective?.padding);
  const airboxSize =
    formatVectorSi(universeConfig?.size) ??
    formatVectorSi(universeEffective?.size);

  const airboxChips: FemMeshGuideParameterChip[] = [
    {
      label: "mode",
      source: asString(universeConfig?.mode) ? "authored" : "effective",
      value: airboxMode,
    },
  ];
  if (airboxHmax) {
    airboxChips.push({
      label: "airbox_hmax",
      source:
        formatLengthSi(universeConfig?.airbox_hmax) !== null
          ? "authored"
          : "effective",
      value: airboxHmax,
    });
  }
  if (airboxHmin) {
    airboxChips.push({
      label: "airbox_hmin",
      source:
        formatLengthSi(universeConfig?.airbox_hmin) !== null
          ? "authored"
          : "effective",
      value: airboxHmin,
    });
  }
  if (airboxMode === "manual" && airboxSize) {
    airboxChips.push({
      label: "size",
      source:
        formatVectorSi(universeConfig?.size) !== null
          ? "authored"
          : "effective",
      value: airboxSize,
    });
  } else if (airboxPadding) {
    airboxChips.push({
      label: "padding",
      source:
        formatVectorSi(universeConfig?.padding) !== null
          ? "authored"
          : "effective",
      value: airboxPadding,
    });
  }

  const airboxStep: FemMeshGuideStep = (() => {
    if (sceneObjects.length === 0) {
      return {
        actionLabel: "Configure Airbox",
        actionTarget: {
          kind: "select-node",
          selection: buildAirboxMeshParametersSelection(),
          tab: "mesh",
        },
        detail:
          "Airbox surrounds the magnetic objects for open-boundary demagnetization / stray-field FEM assembly.",
        id: "airbox-domain",
        optional: true,
        parameterChips: airboxChips,
        status: "blocked",
        statusLabel: "Blocked",
        summary: "Requires scene geometry",
        title: "3. Airbox & Exterior Domain Policy",
      };
    }

    if (!universeAuthored) {
      return {
        actionLabel: "Configure Airbox Policy",
        actionTarget: {
          kind: "select-node",
          selection: buildAirboxMeshParametersSelection(),
          tab: "mesh",
        },
        detail:
          "No explicit Airbox policy is saved yet (Explorer hides the Airbox node until authored). Backend defaults will be used unless you materialize or customize Airbox parameters.",
        id: "airbox-domain",
        optional: true,
        parameterChips: airboxChips,
        status: "recommended",
        statusLabel: "Using Defaults",
        summary: `Inherited defaults (mode: ${airboxMode}${airboxHmax ? `, h_max: ${airboxHmax}` : ""})`,
        title: "3. Airbox & Exterior Domain Policy",
      };
    }

    return {
      actionLabel: "Edit Airbox Policy",
      actionTarget: {
        kind: "select-node",
        selection: buildAirboxMeshParametersSelection(),
        tab: "mesh",
      },
      detail:
        "Canonical Airbox policy is authored and synchronized with Python round-trip export.",
      id: "airbox-domain",
      optional: true,
      parameterChips: airboxChips,
      status: "ready",
      statusLabel: "Authored",
      summary: `Authored (mode: ${airboxMode}${airboxHmax ? `, h_max: ${airboxHmax}` : ""})`,
      title: "3. Airbox & Exterior Domain Policy",
    };
  })();

  // Step 4: Per-Object Mesh Sizing & Strategy
  const objectPolicySummary = extractObjectPolicies(
    sceneObjects,
    input.meshSemantics,
    input.selectedObjectId,
    input.selectedObjectPolicy,
  );
  const sharedDomainPolicyRecord = asRecord(input.sharedDomainPolicy);
  const sharedDomainConfig = asRecord(sharedDomainPolicyRecord?.config);
  const sharedDomainEffective = asRecord(
    sharedDomainPolicyRecord?.effective_config,
  );
  const fallbackHmax =
    formatLengthSi(sharedDomainConfig?.maximum_element_size) ??
    formatLengthSi(sharedDomainEffective?.maximum_element_size);
  const fallbackHmin =
    formatLengthSi(sharedDomainConfig?.minimum_element_size) ??
    formatLengthSi(sharedDomainEffective?.minimum_element_size);

  const objectStep: FemMeshGuideStep = (() => {
    if (sceneObjects.length === 0) {
      return {
        actionLabel: "Add Geometry First",
        actionTarget: {
          kind: "select-node",
          selection: buildObjectsRootSelection(),
          tab: "geometry",
        },
        detail:
          "Per-object mesh policies control local element sizes (h_max, h_min), thin-film swept prisms, and interface transitions.",
        id: "object-sizing",
        optional: true,
        parameterChips: [],
        status: "blocked",
        statusLabel: "Blocked",
        summary: "Requires scene geometry",
        title: "4. Per-Object Mesh Sizing & Strategy",
      };
    }

    const focusObj = selectedObject!;
    const focusInfo = objectPolicySummary.byObjectId.get(focusObj.id);
    const chips: FemMeshGuideParameterChip[] = [
      {
        label: "overrides",
        source:
          objectPolicySummary.authoredCount > 0 ? "authored" : "effective",
        value: `${objectPolicySummary.authoredCount}/${sceneObjects.length} objects`,
      },
    ];
    const displayedHmax = focusInfo?.hmax ?? fallbackHmax;
    const displayedHmin = focusInfo?.hmin ?? fallbackHmin;
    if (displayedHmax) {
      chips.push({
        label: `${focusObj.name} h_max`,
        source: focusInfo?.authored ? "authored" : "effective",
        value: displayedHmax,
      });
    }
    if (displayedHmin) {
      chips.push({
        label: `${focusObj.name} h_min`,
        source: focusInfo?.authored ? "authored" : "effective",
        value: displayedHmin,
      });
    }
    if (focusInfo?.strategy) {
      chips.push({
        label: "strategy",
        source: focusInfo.authored ? "authored" : "effective",
        value: focusInfo.strategy,
      });
    }

    if (objectPolicySummary.authoredCount === 0) {
      return {
        actionLabel: `Configure ${focusObj.name} Mesh`,
        actionTarget: {
          kind: "select-node",
          selection: buildObjectMeshSelection(focusObj),
          tab: "mesh",
        },
        detail: `All ${sceneObjects.length} object(s) currently inherit global/effective mesh sizing. Enable "Use object policy" on ${focusObj.name} to set explicit h_max, h_min, or thin-film sweep layers.`,
        id: "object-sizing",
        optional: true,
        parameterChips: chips,
        status: "recommended",
        statusLabel: "Inherited",
        summary: `Using inherited sizing (0/${sceneObjects.length} object overrides)`,
        title: "4. Per-Object Mesh Sizing & Strategy",
      };
    }

    return {
      actionLabel: `Edit ${focusObj.name} Mesh Policy`,
      actionTarget: {
        kind: "select-node",
        selection: buildObjectMeshSelection(focusObj),
        tab: "mesh",
      },
      detail: `Explicit object mesh policy is authored for ${objectPolicySummary.authoredCount} of ${sceneObjects.length} object(s).`,
      id: "object-sizing",
      optional: true,
      parameterChips: chips,
      status: "ready",
      statusLabel: "Configured",
      summary: `${objectPolicySummary.authoredCount}/${sceneObjects.length} object policy override(s) active`,
      title: "4. Per-Object Mesh Sizing & Strategy",
    };
  })();

  // Step 5: Shared-Domain Mesh Build
  const sceneRecord = asRecord(input.scene);
  const sceneRevision =
    asNumber(sceneRecord?.revision) ?? asNumber(sceneRecord?.scene_revision);
  const summaryRecord = asRecord(input.meshSummary);
  const statusMeshRevision = asNumber(summaryRecord?.revision);
  const activeBuildOuter = asRecord(input.activeBuild);
  const activeBuildRecord =
    asRecord(activeBuildOuter?.active_build) ?? activeBuildOuter;
  const latestBuildOuter = asRecord(input.latestBuild);
  const latestBuildRecord =
    asRecord(latestBuildOuter?.last_success) ??
    asRecord(activeBuildOuter?.last_build_summary) ??
    latestBuildOuter;
  const lastBuildError =
    asString(activeBuildOuter?.last_build_error) ??
    asString(latestBuildOuter?.last_build_error);
  const manifestRecord = asRecord(input.manifest);

  const assessment = resolveArtifactAssessment({
    activeBuild: activeBuildRecord,
    latestBuild: latestBuildRecord,
    manifest: manifestRecord,
    resourceLoadState: input.manifestLoadState,
    sceneRevision,
    statusMeshRevision,
  });

  const geometryReady =
    sceneObjects.length > 0 && validationErrors.length === 0;
  const buildStep = resolveSharedDomainBuildStep({
    activeBuildRecord,
    assessmentState: assessment.state,
    geometryReady,
    lastBuildError,
    manifestRecord,
    presence: assessment.presence,
    sceneRevision,
  });

  // Step 6: Quality Gates Verification
  const qualityGatesOuter = asRecord(input.qualityGates);
  const gatesRecord =
    asRecord(qualityGatesOuter?.gates) ?? qualityGatesOuter;
  const rawChecks = Array.isArray(gatesRecord?.checks)
    ? gatesRecord.checks
    : [];
  const parsedChecks: Array<{ id: string; status: string; value: string }> = [];
  for (const item of rawChecks) {
    const check = asRecord(item);
    if (!check) continue;
    const id = asString(check.id) ?? asString(check.metric) ?? "gate";
    const status = (asString(check.status) ?? "unknown").toLowerCase();
    const value =
      asString(check.value) ??
      (asNumber(check.value) !== null ? String(asNumber(check.value)) : "");
    parsedChecks.push({ id, status, value });
  }

  const qualityStep: FemMeshGuideStep = (() => {
    if (buildStep.status !== "ready") {
      return {
        actionLabel: "Inspect Mesh Quality",
        actionTarget: {
          kind: "select-node",
          selection: buildMeshQualitySelection(),
          tab: "mesh",
        },
        detail:
          "Build a current shared-domain mesh first to evaluate element quality gates (SICN, Gamma, aspect ratio).",
        id: "quality-gates",
        optional: true,
        parameterChips: [],
        status: "blocked",
        statusLabel: "Awaiting Build",
        summary: "Requires a current shared-domain mesh",
        title: "6. Mesh Quality Gates & Inspection",
      };
    }

    const failedChecks = parsedChecks.filter(
      (c) =>
        c.status.includes("fail") ||
        c.status.includes("err") ||
        c.status === "blocked",
    );
    const warningChecks = parsedChecks.filter((c) =>
      c.status.includes("warn"),
    );

    const chips: FemMeshGuideParameterChip[] = parsedChecks
      .slice(0, 4)
      .map((c) => ({
        label: c.id,
        source:
          c.status.includes("pass") || c.status === "ready" || c.status === "ok"
            ? ("authored" as const)
            : ("missing" as const),
        value: c.value ? `${c.status} (${c.value})` : c.status,
      }));

    if (failedChecks.length > 0) {
      return {
        actionLabel: "Review Failed Quality Gates",
        actionTarget: {
          kind: "select-node",
          selection: buildMeshQualitySelection(),
          tab: "mesh",
        },
        detail: `${failedChecks.length} quality gate(s) failed (${failedChecks.map((c) => c.id).join(", ")}). Consider refining h_min/h_max or enabling mesh optimization.`,
        id: "quality-gates",
        optional: false,
        parameterChips: chips,
        status: "failed",
        statusLabel: "Gate Failed",
        summary: `${failedChecks.length} quality gate(s) failed`,
        title: "6. Mesh Quality Gates & Inspection",
      };
    }

    if (warningChecks.length > 0) {
      return {
        actionLabel: "Inspect Quality Warnings",
        actionTarget: {
          kind: "select-node",
          selection: buildMeshQualitySelection(),
          tab: "mesh",
        },
        detail: `${warningChecks.length} quality gate(s) reported warnings (${warningChecks.map((c) => c.id).join(", ")}). Review element distributions before running high-precision studies.`,
        id: "quality-gates",
        optional: true,
        parameterChips: chips,
        status: "warning",
        statusLabel: "Warning",
        summary: `${warningChecks.length} quality warning(s) detected`,
        title: "6. Mesh Quality Gates & Inspection",
      };
    }

    if (parsedChecks.length === 0) {
      return {
        actionLabel: "Open Quality Statistics",
        actionTarget: {
          kind: "select-node",
          selection: buildMeshQualitySelection(),
          tab: "mesh",
        },
        detail:
          "Shared-domain mesh is built. Open Mesh Quality to inspect SICN, Gamma, and characteristic size histograms.",
        id: "quality-gates",
        optional: true,
        parameterChips: [
          { label: "gates", source: "effective", value: "inspect histograms" },
        ],
        status: "recommended",
        statusLabel: "Inspect",
        summary: "Inspect element quality distributions",
        title: "6. Mesh Quality Gates & Inspection",
      };
    }

    return {
      actionLabel: "View Quality Certificate",
      actionTarget: {
        kind: "select-node",
        selection: buildMeshQualitySelection(),
        tab: "mesh",
      },
      detail: `All ${parsedChecks.length} mesh quality gate(s) passed for the current shared-domain mesh.`,
      id: "quality-gates",
      optional: true,
      parameterChips: chips,
      status: "ready",
      statusLabel: "Passed",
      summary: `All ${parsedChecks.length} quality gate(s) passed`,
      title: "6. Mesh Quality Gates & Inspection",
    };
  })();

  const steps: readonly FemMeshGuideStep[] = [
    geometryStep,
    materialsStep,
    airboxStep,
    objectStep,
    buildStep,
    qualityStep,
  ];

  const requiredSteps = [geometryStep, materialsStep, buildStep];
  const completedRequiredSteps = requiredSteps.filter(
    (s) => s.status === "ready",
  ).length;
  const totalRequiredSteps = requiredSteps.length;
  const progressRatio =
    totalRequiredSteps > 0 ? completedRequiredSteps / totalRequiredSteps : 0;

  // Determine overall status & next recommended step
  const nextRecommendedStep: FemMeshGuideStep | null = (() => {
    // Priority 1: Blocking geometry or material issues
    if (geometryStep.status !== "ready") return geometryStep;
    if (materialsStep.status !== "ready") return materialsStep;
    // Priority 2: Build is failed, stale, or missing
    if (buildStep.status !== "ready") return buildStep;
    // Priority 3: Quality gate failed or warning
    if (qualityStep.status === "failed" || qualityStep.status === "warning") {
      return qualityStep;
    }
    // Priority 4: Recommended optional refinements
    if (objectStep.status === "recommended") return objectStep;
    if (airboxStep.status === "recommended") return airboxStep;
    return null;
  })();

  const { headline, overallStatus, overallStatusLabel, subheadline } =
    ((): {
      headline: string;
      overallStatus: FemMeshGuideOverallStatus;
      overallStatusLabel: string;
      subheadline: string;
    } => {
      if (geometryStep.status !== "ready") {
        return {
          headline:
            geometryStep.status === "missing"
              ? "Add 3D geometry to begin FEM meshing"
              : "Resolve geometry validation errors before meshing",
          overallStatus: "blocked",
          overallStatusLabel: "Geometry Required",
          subheadline: geometryStep.detail,
        };
      }
      if (buildStep.status === "in-progress") {
        return {
          headline: "Shared-domain FEM mesh build in progress",
          overallStatus: "building",
          overallStatusLabel: "Building Mesh",
          subheadline: buildStep.detail,
        };
      }
      if (buildStep.status === "failed") {
        return {
          headline: "Shared-domain FEM mesh build failed",
          overallStatus: "failed",
          overallStatusLabel: "Build Failed",
          subheadline: buildStep.detail,
        };
      }
      if (buildStep.status === "stale") {
        return {
          headline: "Shared-domain FEM mesh is out of date",
          overallStatus: "stale",
          overallStatusLabel: "Mesh Stale",
          subheadline:
            "Scene geometry or mesh policies changed since the last build. Rebuild the shared-domain mesh before running the solver.",
        };
      }
      if (buildStep.status === "missing") {
        return {
          headline:
            materialsStep.status !== "ready"
              ? "Assign object materials, then build the shared-domain mesh"
              : "Ready to build the shared-domain FEM mesh",
          overallStatus: "needs-build",
          overallStatusLabel: "Needs Mesh Build",
          subheadline:
            "Review optional Airbox and per-object sizing overrides below, or build the shared-domain mesh now.",
        };
      }
      if (
        qualityStep.status === "failed" ||
        qualityStep.status === "warning" ||
        materialsStep.status !== "ready"
      ) {
        return {
          headline:
            materialsStep.status !== "ready"
              ? "Shared-domain mesh is built, but material assignment is incomplete"
              : "Shared-domain mesh is built with quality advisories",
          overallStatus: "quality-warning",
          overallStatusLabel: "Review Warnings",
          subheadline:
            materialsStep.status !== "ready"
              ? materialsStep.detail
              : qualityStep.detail,
        };
      }
      return {
        headline: "Shared-domain FEM mesh is current and solver-ready",
        overallStatus: "ready",
        overallStatusLabel: "Mesh Ready",
        subheadline:
          "All required geometry, material, and shared-domain mesh checks are satisfied.",
      };
    })();

  const selectedObjectContext = selectedObject
    ? {
        hasExplicitPolicy: Boolean(
          objectPolicySummary.byObjectId.get(selectedObject.id)?.authored,
        ),
        objectId: selectedObject.id,
        objectName: selectedObject.name,
      }
    : null;

  return {
    completedRequiredSteps,
    headline,
    nextRecommendedStep,
    overallStatus,
    overallStatusLabel,
    progressRatio,
    selectedObjectContext,
    steps,
    subheadline,
    totalRequiredSteps,
  };
}
