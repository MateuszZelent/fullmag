import { describe, expect, it } from "vitest";

import type {
  CurrentRunResource,
  DomainMetaResource,
  FdmMultilayerLayoutResource,
  FdmRegionMembershipResource,
  FrequencyDomainManifestResource,
  FrequencyDomainSweepProgressResource,
  HysteresisExecutionTreeResource,
  SceneResource,
} from "@/kernel/api/apiTypes";
import { buildDomainPresentation } from "@/shared/domain/mesh/domainPresentation";
import type { FdmDomainPresentation } from "@/shared/domain/mesh/domainPresentation";
import {
  ANALYSIS_FREQUENCY_DOMAIN_EIGEN_DISPERSION_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
  ANALYSIS_HYSTERESIS_POINT_PATH,
  ANALYSIS_HYSTERESIS_SETTLE_TRACE_PATH,
  DATA_FIELD_VECTOR_PATH,
} from "@/kernel/api/apiPaths";
import {
  createObjectExtensionActivationState,
  resolveActiveObjectExtensionExplorerItems,
  setObjectExtensionEnabled,
} from "@/kernel/object-extensions/ObjectExtensionsSectionModel";
import type { ExplorerNode, ExplorerNodeKind } from "../explorerTypes";

import {
  buildExplorerTree,
  buildModelTree,
  filterExplorerNodes,
  findExplorerNodePath,
  flattenExplorerNodes,
} from "./buildModelTree";
import { createExplorerNode } from "./explorerNodeContract";
import {
  modelTreeSnapshotFromScene,
  modelTreeSnapshotWithStageExecution,
} from "./sceneModelTreeAdapter";

describe("Explorer node contract", () => {
  it("preserves a valid node and its exported kind", () => {
    const kind: ExplorerNodeKind = "object.root";
    const node: ExplorerNode = {
      id: "model:object:sample",
      kind,
      label: "Sample",
      parentId: "model:objects",
    };

    expect(createExplorerNode(node)).toBe(node);
  });

  it("rejects an empty node id", () => {
    expect(() =>
      createExplorerNode({
        id: "   ",
        kind: "object.root",
        label: "Sample",
        parentId: "model:objects",
      }),
    ).toThrow("Explorer node requires a non-empty id");
  });
});

const TORQUE_TOLERANCE_FOR_1E_4_T = 1e-4 / (4 * Math.PI * 1e-7);
const capability = (status: string, reason = "test fixture") => ({ status, reason });

function currentRun(runId: string, revision: number): CurrentRunResource {
  return {
    artifact_dir: `/tmp/fullmag/${runId}`,
    requested_backend: "fem",
    requested_device: "cpu",
    requested_mode: "strict",
    requested_precision: "double",
    revision,
    run_id: runId,
    session_id: "session-test",
    started_at: "2026-08-11T00:00:00Z",
    status: "completed",
    total_steps: 0,
  };
}

function fdmExplorerPresentation() {
  const domainMeta: DomainMetaResource = {
    bounds: { min: [0, 0, 0], max: [4, 2, 1] }, coordinate_system: "cartesian",
    counts: { cells: 8 }, dimension: 3, discretization: "fdm", domain_id: "domain:fdm",
    generation_id: "generation-7", grid: { origin: [0, 0, 0], shape: [2, 2, 2], spacing: [2, 1, 0.5] }, units: { length: "m" },
  };
  const membership: FdmRegionMembershipResource = {
    binary_path: "fdm.bin", cell_count: 8, cell_m: [2, 1, 0.5], counts: [2, 2, 2], domain_generation_id: "generation-7", encoding: "u32le", freshness: "current", grid_fingerprint: "grid-7", mesh_revision: 11, origin_m: [0, 0, 0], region_legend: [{ numeric_id: 7, object_id: "object:core", priority: 0, region_id: "region:core" }], region_membership_revision: 12, schema_version: "fdm_region_membership.v1",
  };
  return buildDomainPresentation({ domainMeta, fdmMembership: membership, fdmMembershipStatus: "ready" });
}

function snapshotVectorResourceKey(snapshotId: string): string {
  return `${DATA_FIELD_VECTOR_PATH.replace("{quantity_id}", "m")}?component=full&scope_kind=full&snapshot_id=${snapshotId}`;
}

function analysisFieldVectorResourceKey(fieldId: string): string {
  return `${DATA_FIELD_VECTOR_PATH.replace("{quantity_id}", fieldId)}?view=phase_rotated_real&phase_rad=0`;
}

function hysteresisPointResourceKey(stageId: string, pointId: number): string {
  return ANALYSIS_HYSTERESIS_POINT_PATH.replace("{stage_id}", stageId).replace(
    "{point_id}",
    String(pointId),
  );
}

function hysteresisSettleTraceResourceKey(stageId: string, pointId: number): string {
  return ANALYSIS_HYSTERESIS_SETTLE_TRACE_PATH.replace("{stage_id}", stageId).replace(
    "{point_id}",
    String(pointId),
  );
}

const frequencyDomainCapabilityFixture = {
  boundary: {
    floquet_modal: capability("semantic_only"),
    floquet_response: capability("unsupported"),
    periodic_pair_diagnostics: capability("reference_executable"),
    static_periodic: capability("partial_production_executable"),
  },
  demag: {
    floquet_dynamic_k: capability("unsupported"),
    static_periodic_pbc: capability("semantic_only"),
  },
  dispersion: {
    branch_tracking: capability("reference_executable"),
    k_path: capability("reference_executable"),
    production_cpu: capability("partial_production_executable"),
    production_cpu_gamma_k_path: capability("partial_production_executable"),
    production_gpu: capability("unsupported"),
    reference_cpu: capability("reference_executable"),
  },
  modal: {
    absorption_from_modes: capability("unsupported"),
    k_path: capability("reference_executable"),
    linewidths: capability("reference_executable"),
    mode_field_payload: capability("reference_executable"),
    mode_tracking: capability("reference_executable"),
    production_cpu: capability("unsupported"),
    production_gpu: capability("unsupported"),
    reference_cpu: capability("reference_executable"),
  },
  response: {
    frequency_sweep: capability("reference_executable"),
    magnetic_cpu: capability("partial_production_executable"),
    magnetic_gpu: capability("unsupported"),
    magnetoelastic_elastodynamic: capability("unsupported"),
    magnetoelastic_quasistatic: capability("unsupported"),
    mode_projected: capability("unsupported"),
  },
  schema_version: "frequency_domain_capabilities.v1",
  validation: {
    fmr_k0: capability("source_visible"),
  },
  visualization: {
    modal_dispersion_chart: capability("reference_executable"),
    modal_spectrum_chart: capability("reference_executable"),
    mode_3d_overlay: capability("reference_executable"),
    mode_table: capability("reference_executable"),
    response_field_3d_overlay: capability("reference_executable"),
    response_sweep_chart: capability("reference_executable"),
  },
} satisfies FrequencyDomainManifestResource["capabilities"];

const FREQUENCY_DOMAIN_MANIFEST: FrequencyDomainManifestResource = {
  capabilities: frequencyDomainCapabilityFixture,
  eigen_namespace: "eigen",
  eigenmodes: {
    diagnostics_json: "{}",
    driven_response_available: false,
    dynamic_demag_k_available: false,
    floquet_modal_available: true,
    floquet_response_available: false,
    gpu_available: false,
    modal_solver_available: false,
    static_periodic_response_available: false,
    reason: "production modal solver is not implemented",
    status: "unavailable",
    study_kind: "eigenmodes",
  },
  existing_frequency_response_namespace_preserved: true,
  family_namespace: "frequencyDomain",
  floquet_nonzero_k_demag_supported: false,
  floquet_nonzero_k_response_supported: false,
  response: {
    diagnostics_json:
      '{"schema_version":"frequency_domain_availability.v1","execution_lane":"native_fem_mfem_frequency_domain_cpu","scope":"gamma_free_or_static_periodic_magnetic_response"}',
    driven_response_available: true,
    dynamic_demag_k_available: false,
    floquet_modal_available: false,
    floquet_response_available: false,
    gpu_available: false,
    modal_solver_available: false,
    static_periodic_response_available: true,
    reason: "",
    status: "ok",
    study_kind: "frequency_response",
  },
  response_cancel_requested: null,
  response_progress: null,
  schema_version: "frequency_domain_manifest.v1",
};

const FREQUENCY_DOMAIN_SPECTRUM = {
  artifact_path: "eigen/spectrum.v2.json",
  missing_reason: null,
  payload: {
    modes: [
      {
        branch_id: "branch-0",
        frequency_hz: 12.5e9,
        mode_field_id: "analysis:eigen:sample-0000:mode-0002",
        mode_field_resource_key: analysisFieldVectorResourceKey(
          "analysis:eigen:sample-0000:mode-0002",
        ),
        raw_mode_index: 2,
        residual_norm: 1e-8,
        sample_index: 0,
      },
      {
        frequency_hz: 14.25e9,
        raw_mode_index: 3,
        sample_index: 0,
      },
    ],
    schema_version: "eigen_spectrum.v2",
  },
  resource_key: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH,
  schema_version: "frequency_domain_eigen_spectrum.v2",
  status: "ready",
} as const;

const FREQUENCY_DOMAIN_DISPERSION = {
  artifact_path: "eigen/dispersion.csv",
  content_type: "text/csv",
  missing_reason: null,
  resource_key: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_DISPERSION_PATH,
  schema_version: "frequency_domain_eigen_dispersion.csv",
  status: "ready",
  text: [
    "sample_index,raw_mode_index,branch_id,path_s,frequency_hz,residual_norm",
    "0,2,branch-0,0,12.5e9,1e-8",
    "1,1,branch-0,3.14e7,13.1e9,2e-8",
  ].join("\n"),
} as const;

const FREQUENCY_DOMAIN_RESPONSE_SWEEP = {
  artifact_path: "response/magnetic_response_sweep.v2.json",
  missing_reason: null,
  payload: {
    points: [
      {
        absorbed_power_density: 4.5,
        frequency_hz: 9.5e9,
        frequency_index: 0,
        max_response_amplitude: 1.5,
        observable_id: "mx",
      },
      {
        absorbed_power_density: 2.5,
        frequency_hz: 10.5e9,
        frequency_index: 1,
        max_response_amplitude: 1.1,
        observable_id: "mx",
      },
      {
        frequency_hz: 9.5e9,
        frequency_index: 0,
        max_response_amplitude: 0.5,
        observable_id: "my",
      },
    ],
    schema_version: "magnetic_response_sweep.v2",
  },
  resource_key: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
  schema_version: "frequency_domain_response_sweep_resource.v1",
  status: "ready",
} as const;

const FREQUENCY_DOMAIN_RESPONSE_PROGRESS: FrequencyDomainSweepProgressResource = {
  complete: false,
  completed_frequency_points: 3,
  current_frequency_hz: 10.5e9,
  demag_mode: "periodic_airbox_k0",
  frequency_max_hz: 12.0e9,
  frequency_min_hz: 8.0e9,
  latest_artifact_manifest_path: "frequency_domain/manifest.partial.v1.json",
  missing_reason: null,
  partial_artifacts_available: true,
  progress_json:
    '{"schema_version":"frequency_domain_sweep_progress.v1","state":"running"}',
  schema_version: "frequency_domain_sweep_progress.v1",
  state: "running",
  status: "ok",
  total_frequency_points: 10,
  written_frequency_point_artifacts: 3,
};

const FREQUENCY_DOMAIN_RESPONSE_CANCEL_REQUESTED: FrequencyDomainSweepProgressResource = {
  complete: false,
  completed_frequency_points: 4,
  current_frequency_hz: 10.0e9,
  demag_mode: "periodic_airbox_k0",
  frequency_max_hz: 12.0e9,
  frequency_min_hz: 8.0e9,
  latest_artifact_manifest_path: "frequency_domain/manifest.cancelled.v1.json",
  missing_reason: null,
  partial_artifacts_available: true,
  progress_json:
    '{"schema_version":"frequency_domain_sweep_progress.v1","state":"cancel_requested"}',
  schema_version: "frequency_domain_sweep_progress.v1",
  state: "cancel_requested",
  status: "ok",
  total_frequency_points: 10,
  written_frequency_point_artifacts: 4,
};

describe("buildModelTree", () => {
  it("keeps Visualization available for a primitive-only scene object", () => {
    const snapshot = modelTreeSnapshotFromScene({
      objects: [
        { id: "fem-owned", regions: [], transform: { translation: [0, 0, 0] }, visible: true },
        { id: "fem-fallback", regions: [], transform: { translation: [0.5, 0, 0] }, visible: true },
      ],
    } as SceneResource, {
      domainDiscretization: "fem",
    });

    expect(snapshot.objects).toEqual([
      expect.objectContaining({ id: "fem-owned", meshStatus: "primitive-only" }),
      expect.objectContaining({ id: "fem-fallback", meshStatus: "primitive-only" }),
    ]);

    const flattened = flattenExplorerNodes(buildModelTree(snapshot));
    for (const objectId of ["fem-owned", "fem-fallback"]) {
      expect(
        flattened.find(
          (node) => node.id === `model:object:${objectId}:visualization`,
        ),
      ).toMatchObject({
        kind: "object.visualization",
        label: "Visualization",
        objectId,
        parentId: `model:object:${objectId}`,
        status: "ready",
      });
    }
  });

  it("uses manifest ownership to mark a meshed object ready without a mesh-ready tag", () => {
    const snapshot = modelTreeSnapshotFromScene(
      {
        objects: [{ id: "film", name: "Film", role: "magnet" }],
      } as SceneResource,
      {
        meshManifest: {
          object_segments: [{ object_id: "film" }],
        } as never,
      },
    );

    expect(snapshot.objects?.[0]?.meshStatus).toBe("mesh-ready");
  });

  it("marks an object ready when the current FDM membership owns its realized cells", () => {
    const snapshot = modelTreeSnapshotFromScene(
      {
        objects: [{ id: "film", name: "Film", role: "magnet" }],
      } as SceneResource,
      {
        domainPresentation: {
          discretization: "fdm",
          fdmGrid: {
            membership: {
              freshness: "current",
              object_ids: ["film", "film_geom"],
              region_legend: [],
            },
          },
          resourceStatus: "realized",
        } as never,
      },
    );

    expect(snapshot.objects?.[0]?.meshStatus).toBe("mesh-ready");
  });

  it("fails closed instead of throwing when an incomplete FDM membership omits freshness", () => {
    const snapshot = modelTreeSnapshotFromScene(
      {
        objects: [{ id: "film", name: "Film", role: "magnet" }],
      } as SceneResource,
      {
        domainPresentation: {
          discretization: "fdm",
          fdmGrid: {
            membership: {
              object_ids: ["film"],
              region_legend: [],
            },
          },
          resourceStatus: "realized",
        } as never,
      },
    );

    expect(snapshot.objects?.[0]?.meshStatus).toBe("primitive-only");
  });

  it("drops legacy electrical list resources at the model-tree adapter boundary", () => {
    const snapshot = modelTreeSnapshotFromScene(null, {
      currentTransports: { items: [{ id: "legacy-current" }] },
      oerstedFields: { items: [{ id: "legacy-oersted" }] },
      spinInterfaces: { items: [{ interface_id: "legacy-interface" }] },
      spinTorques: { items: [{ id: "legacy-torque" }] },
      spinTransports: { items: [{ id: "legacy-spin" }] },
    } as never);

    expect(snapshot).not.toHaveProperty("currentTransports");
    expect(snapshot).not.toHaveProperty("spinTransports");
    expect(snapshot).not.toHaveProperty("spinInterfaces");
    expect(snapshot).not.toHaveProperty("spinTorques");
    expect(snapshot).not.toHaveProperty("oerstedFields");
  });

  it("removes synthetic air-role scene objects before they can become Explorer nodes", () => {
    const snapshot = modelTreeSnapshotFromScene({
      objects: [
        { id: "film", name: "Film", role: "magnet" },
        { id: "__air__", name: "Synthetic air", role: "air" },
        { id: "__airbox__", name: "Legacy synthetic airbox" },
        { id: "compat-air", name: "Legacy Airbox", role: "airbox" },
      ],
    } as SceneResource);

    expect(snapshot.objects?.map((object) => object.id)).toEqual(["film"]);
  });

  it("builds a typed model tree from a scene snapshot without storing API data", () => {
    const nodes = buildModelTree({
      airbox: { authoredPolicy: true, realizedCarrier: false },
      domainDiscretization: "fem",
      universe: {
        id: "u0",
        label: "Universe",
        size: [2e-6, 1e-6, 5e-8],
      },
      materials: [
        {
          id: "mat:free-layer",
          label: "Free layer material",
          propertyKeys: ["Aex", "Ms", "alpha"],
        },
      ],
      objects: [
        {
          id: "free-layer",
          label: "Free layer",
          geometryKind: "thin film",
          material: "Permalloy",
          materialLabel: "Free layer material",
          materialPropertyKeys: ["Aex", "Ms", "alpha"],
          meshStatus: "stale",
          physicsInteractions: [
            {
              enabledCount: 1,
              id: "uniaxial_anisotropy",
              label: "Uniaxial anisotropy",
              objectCount: 1,
            },
          ],
        },
      ],
      physicsInteractions: [
        {
          enabledCount: 1,
          id: "uniaxial_anisotropy",
          label: "Uniaxial anisotropy",
          objectCount: 1,
        },
      ],
    });

    const flattened = flattenExplorerNodes(nodes);

    expect(nodes[0]?.kind).toBe("session.root");
    expect(flattened.map((node) => node.id)).toEqual(
      expect.arrayContaining([
        "model:universe",
        "model:objects",
        "model:object:free-layer",
        "model:object:free-layer:geometry",
        "model:object:free-layer:regions",
        "model:object:free-layer:magnetic-parameters",
        "model:object:free-layer:magnetic-parameters:material",
        "model:object:free-layer:magnetic-parameters:uniaxial_anisotropy",
        "model:object:free-layer:magnetic-texture",
        "model:object:free-layer:magnetic-texture:asset",
        "model:object:free-layer:mesh",
        "model:object:free-layer:visualization",
        "model:object:free-layer:visualization:debug",
        "model:airbox",
        "model:airbox:mesh",
        "model:airbox:mesh:parameters",
        "model:airbox:mesh:quality-gates",
        "model:airbox:mesh:statistics",
        "model:airbox:mesh:topology",
        "model:airbox:mesh:build",
        "model:airbox:visualization",
        "model:airbox:visualization:debug",
        "model:mesh",
        "model:study",
      ]),
    );
    expect(
      flattened.find((node) => node.id === "model:object:free-layer:mesh")
        ?.status,
    ).toBe("stale");
    expect(
      flattened.find((node) => node.id === "model:object:free-layer:regions"),
    ).toMatchObject({
      badge: "0",
      children: [],
      kind: "object.regions",
      label: "Regions",
    });
    expect(flattened.map((node) => node.id)).not.toContain(
      "model:object:free-layer:regions:primary",
    );
  });

  it("builds the exact stable Airbox subtree in semantic order", () => {
    const [session] = buildModelTree({
      airbox: { authoredPolicy: true, realizedCarrier: false },
      domainDiscretization: "fem",
    });
    const universe = session?.children?.find((node) => node.id === "model:universe");
    const airbox = universe?.children?.find((node) => node.id === "model:airbox");

    expect(airbox).toMatchObject({
      id: "model:airbox",
      kind: "airbox.root",
      label: "Airbox",
      parentId: "model:universe",
    });
    expect(airbox?.children?.map(({ id, kind, label, parentId }) => ({
      id,
      kind,
      label,
      parentId,
    }))).toEqual([
      {
        id: "model:airbox:mesh",
        kind: "airbox.mesh",
        label: "Mesh",
        parentId: "model:airbox",
      },
      {
        id: "model:airbox:visualization",
        kind: "airbox.visualization",
        label: "Visualization",
        parentId: "model:airbox",
      },
    ]);

    const mesh = airbox?.children?.[0];
    expect(mesh?.children?.map(({ id, kind, label, parentId }) => ({
      id,
      kind,
      label,
      parentId,
    }))).toEqual([
      {
        id: "model:airbox:mesh:parameters",
        kind: "airbox.mesh.parameters",
        label: "Parameters",
        parentId: "model:airbox:mesh",
      },
      {
        id: "model:airbox:mesh:quality-gates",
        kind: "airbox.mesh.quality-gates",
        label: "Quality Gates",
        parentId: "model:airbox:mesh",
      },
      {
        id: "model:airbox:mesh:statistics",
        kind: "airbox.mesh.statistics",
        label: "Statistics",
        parentId: "model:airbox:mesh",
      },
      {
        id: "model:airbox:mesh:topology",
        kind: "airbox.mesh.topology",
        label: "Topology",
        parentId: "model:airbox:mesh",
      },
      {
        id: "model:airbox:mesh:build",
        kind: "airbox.mesh.build",
        label: "Build & Provenance",
        parentId: "model:airbox:mesh",
      },
    ]);

    expect(airbox?.children?.[1]?.children?.at(-1)).toMatchObject({
      badge: "debug",
      id: "model:airbox:visualization:debug",
      kind: "airbox.visualization.debug",
      label: "Debug",
      parentId: "model:airbox:visualization",
    });
  });

  it("places Boundary Faces beside Airbox under Universe", () => {
    const [session] = buildModelTree({
      airbox: { authoredPolicy: true, realizedCarrier: false },
      domainDiscretization: "fem",
    });
    const universe = session?.children?.find((node) => node.id === "model:universe");

    expect(universe?.children?.map(({ id }) => id)).toEqual([
      "model:airbox",
      "model:boundary-faces",
    ]);
    expect(
      universe?.children?.find((node) => node.id === "model:boundary-faces"),
    ).toMatchObject({
      kind: "boundary-faces.root",
      label: "Boundary Faces",
      parentId: "model:universe",
      status: "unavailable",
    });
  });

  it("does not fabricate a FEM Airbox from discretization alone", () => {
    const flattened = flattenExplorerNodes(
      buildModelTree({ domainDiscretization: "fem" }),
    );

    expect(flattened.map((node) => node.kind)).not.toContain("airbox.root");
  });

  it("marks authored FEM Airbox policy stale until a matching carrier is realized", () => {
    const authored = flattenExplorerNodes(buildModelTree({
      airbox: { authoredPolicy: true, realizedCarrier: false },
      domainDiscretization: "fem",
    }));
    const realized = flattenExplorerNodes(buildModelTree({
      airbox: { authoredPolicy: true, realizedCarrier: true },
      domainDiscretization: "fem",
      mesh: {
        manifestSourceSceneRevision: 3,
        meshName: "shared-domain",
        meshRevision: 3,
        sourceSceneRevision: 3,
      },
    }));

    expect(authored.find((node) => node.id === "model:airbox")).toMatchObject({
      badge: "authored",
      status: "mesh-stale",
    });
    expect(
      authored.find((node) => node.id === "model:airbox:visualization"),
    ).toMatchObject({ status: "mesh-stale" });
    expect(realized.find((node) => node.id === "model:airbox")).toMatchObject({
      badge: "realized",
      status: "mesh-ready",
    });
  });

  it("marks grouping roots as nonselectable instead of routing them to placeholders", () => {
    const nodes = flattenExplorerNodes(buildModelTree({
      domainDiscretization: "fem",
      objects: [{ id: "film", label: "Film" }],
    }));

    for (const kind of [
      "session.root",
      "definitions.root",
      "model.planar.monitors",
      "universe.root",
      "objects.root",
    ]) {
      expect(nodes.find((node) => node.kind === kind), kind).toMatchObject({
        selectable: false,
      });
    }
  });

  it("marks Boundary Faces ready when the shared mesh is realized", () => {
    const [session] = buildModelTree({
      domainDiscretization: "fem",
      mesh: {
        manifestSourceSceneRevision: 1,
        meshName: "semantic-target-fixture",
        meshRevision: 1,
        outerBoundaryPartCount: 1,
        sourceSceneRevision: 1,
      },
    });
    const boundaryFaces = session?.children
      ?.find((node) => node.id === "model:universe")
      ?.children?.find((node) => node.id === "model:boundary-faces");

    expect(boundaryFaces).toMatchObject({
      badge: "realized",
      status: "mesh-ready",
    });
  });

  it("marks Boundary Faces stale when its realized carrier belongs to an older scene", () => {
    const [session] = buildModelTree({
      domainDiscretization: "fem",
      mesh: {
        manifestSourceSceneRevision: 1,
        meshName: "stale-boundary-fixture",
        meshRevision: 1,
        outerBoundaryPartCount: 1,
        sourceSceneRevision: 2,
      },
    });
    const boundaryFaces = session?.children
      ?.find((node) => node.id === "model:universe")
      ?.children?.find((node) => node.id === "model:boundary-faces");

    expect(boundaryFaces).toMatchObject({
      badge: "mesh stale",
      status: "mesh-stale",
    });
  });

  it("keeps Boundary Faces unavailable when a mesh has no outer-boundary carrier", () => {
    const [session] = buildModelTree({
      domainDiscretization: "fem",
      mesh: {
        meshName: "mesh-without-boundary-carrier",
        outerBoundaryPartCount: 0,
      },
    });
    const boundaryFaces = session?.children
      ?.find((node) => node.id === "model:universe")
      ?.children?.find((node) => node.id === "model:boundary-faces");

    expect(boundaryFaces).toMatchObject({
      badge: "mesh required",
      status: "unavailable",
    });
  });

  it("exposes every orphan render target as an explicit unassigned mesh-part node", () => {
    const nodes = buildModelTree({
      domainDiscretization: "fem",
      mesh: {
        partCount: 1,
        visualizationPartFallbacks: [
          {
            id: "part:orphan",
            label: "Recovered volume",
            visualizationTargetId: "part:part:orphan",
          },
        ],
      },
    });
    const flattened = flattenExplorerNodes(nodes);

    expect(flattened.find((node) => node.id === "model:mesh:unassigned")).toMatchObject({
      kind: "mesh.unassigned",
      label: "Unassigned mesh parts",
      parentId: "model:mesh",
    });
    expect(
      flattened.find(
        (node) => node.id === "model:mesh:unassigned:part%3Aorphan",
      ),
    ).toMatchObject({
      kind: "mesh.unassigned.part",
      label: "Recovered volume",
      meshPartId: "part:orphan",
      parentId: "model:mesh:unassigned",
    });
  });

  it("retains and resolves the selected path even when the active filter does not match it", () => {
    const nodes = buildModelTree({
      domainDiscretization: "fem",
      mesh: {
        visualizationPartFallbacks: [
          {
            id: "part:orphan",
            label: "Recovered volume",
            visualizationTargetId: "part:part:orphan",
          },
        ],
      },
    });
    const selectedNodeId = "model:mesh:unassigned:part%3Aorphan";
    const filtered = filterExplorerNodes(nodes, "energy", selectedNodeId);

    expect(flattenExplorerNodes(filtered).map((node) => node.id)).toContain(
      selectedNodeId,
    );
    expect(findExplorerNodePath(nodes, selectedNodeId)).toEqual([
      "model:session",
      "model:mesh",
      "model:mesh:unassigned",
      selectedNodeId,
    ]);
  });

  it("puts Debug last under antenna and ordinary object Visualization", () => {
    const flattened = flattenExplorerNodes(buildModelTree({
      domainDiscretization: "fem",
      objects: [
        { id: "film", label: "Film" },
        { id: "antenna", label: "Antenna", objectRole: "antenna" },
      ],
    }));

    for (const objectId of ["film", "antenna"]) {
      const visualization = flattened.find(
        (node) => node.id === `model:object:${objectId}:visualization`,
      );
      expect(visualization?.children?.at(-1)).toMatchObject({
        badge: "debug",
        id: `model:object:${objectId}:visualization:debug`,
        kind: "object.visualization.debug",
        label: "Debug",
        objectId,
        parentId: `model:object:${objectId}:visualization`,
      });
    }
  });

  it("adds active object extension nodes below the owning object", () => {
    const activation = setObjectExtensionEnabled(
      createObjectExtensionActivationState(),
      "permalloy_layer",
      "topological_charge",
      true,
    );
    const flattened = flattenExplorerNodes(
      buildModelTree({
        objects: [
          {
            extensions: resolveActiveObjectExtensionExplorerItems(
              "permalloy_layer",
              activation,
            ),
            id: "permalloy_layer",
            label: "permalloy_layer",
          },
          {
            extensions: resolveActiveObjectExtensionExplorerItems(
              "cofeb_ring",
              activation,
            ),
            id: "cofeb_ring",
            label: "cofeb_ring",
          },
        ],
      }),
    );

    expect(
      flattened.find(
        (node) =>
          node.id ===
          "model:object:permalloy_layer:extensions:topological_charge",
      ),
    ).toMatchObject({
      kind: "object.extension.topological-charge",
      label: "Topological Charge",
      objectId: "permalloy_layer",
      parentId: "model:object:permalloy_layer",
      status: "stale",
    });
    expect(flattened.map((node) => node.id)).not.toContain(
      "model:object:cofeb_ring:extensions:topological_charge",
    );
  });

  it("labels the shared-domain mesh node from mesh build freshness", () => {
    const flattened = flattenExplorerNodes(
      buildModelTree({
        domainDiscretization: "fem",
        mesh: {
          meshName: "shared-domain",
          meshRevision: 12,
          sourceSceneRevision: 5,
          manifestSourceSceneRevision: 4,
        },
      }),
    );

    expect(
      flattened.find((node) => node.id === "model:mesh:shared-domain"),
    ).toMatchObject({
      badge: "stale",
      status: "mesh-stale",
    });
  });

  it("projects canonical SceneDocument objects into lifecycle-aware nodes", () => {
    const snapshot = modelTreeSnapshotFromScene({
      materials: [
        {
          id: "mat-1",
          name: "Material 1",
          properties: { Aex: 1e-11, Dind: 0.001, Ms: 800000, alpha: 0.02 },
        },
      ],
      magnetization_assets: [
        {
          id: "mag-1",
          kind: "preset_texture",
          preset_kind: "vortex",
          texture_transform: {
            pivot: [0, 0, 0],
            rotation_quat: [0, 0, 0, 1],
            scale: [1, 1, 1],
            translation: [0, 0, 0],
          },
          ui_label: "Vortex texture",
        },
      ],
      objects: [
        {
          geometry: {
            geometry_kind: "Box",
            geometry_params: { size: [1, 2, 3] },
          },
          id: "box-1",
          magnetization_ref: "mag-1",
          material_ref: "mat-1",
          name: "Box 1",
          physics_stack: [
            { enabled: true, kind: "exchange" },
            { enabled: false, kind: "demag" },
          ],
          tags: ["mesh:dirty"],
        },
      ],
      revision: 4,
      universe: {
        size: [1e-6, 2e-6, 3e-6],
      },
    });

    const flattened = flattenExplorerNodes(buildModelTree(snapshot));

    expect(
      flattened.find((node) => node.id === "model:object:box-1")?.status,
    ).toBe("mesh-stale");
    expect(
      flattened.find((node) => node.id === "model:object:box-1:mesh")?.badge,
    ).toBe("mesh stale");
    expect(
      flattened.find((node) => node.id === "model:object:box-1:magnetic-parameters")
        ?.label,
    ).toBe("Magnetic Parameters");
    expect(
      flattened.find(
        (node) => node.id === "model:object:box-1:magnetic-parameters:material",
      )?.label,
    ).toBe("Material: Material 1");
    expect(
      flattened.find(
        (node) => node.id === "model:object:box-1:magnetic-parameters:material",
      )?.badge,
    ).toBe("Aex, Dind, Ms");
    expect(
      flattened.find(
        (node) =>
          node.id === "model:object:box-1:magnetic-parameters:interfacial_dmi",
      )?.badge,
    ).toBe("active");
    expect(
      flattened.find(
        (node) => node.id === "model:object:box-1:magnetic-parameters:exchange",
      )?.badge,
    ).toBe("active");
    expect(
      flattened.find(
        (node) => node.id === "model:object:box-1:magnetic-parameters:demag",
      )?.badge,
    ).toBe("disabled");
    expect(flattened.map((node) => node.id)).not.toContain(
      "model:materials",
    );
    expect(flattened.map((node) => node.id)).not.toContain("model:physics");
    expect(
      flattened.find(
        (node) => node.id === "model:object:box-1:magnetic-texture",
      )?.badge,
    ).toBe("preset_texture");
    expect(
      flattened.find(
        (node) => node.id === "model:object:box-1:magnetic-texture:asset",
      )?.label,
    ).toBe("Vortex texture");
    expect(
      flattened.find(
        (node) => node.id === "model:object:box-1:magnetic-texture:asset",
      )?.kind,
    ).toBe("object.magnetic-texture.asset");
    expect(flattened.map((node) => node.id)).not.toContain(
      "model:object:box-1:magnetic-texture:load",
    );
    expect(
      flattened.find(
        (node) => node.id === "model:object:box-1:magnetic-texture",
      )?.contextCommands,
    ).toEqual(expect.arrayContaining(["magnetization-texture.activate-load-file"]));
    expect(flattened.map((node) => node.id)).toContain(
      "model:object:box-1:magnetic-texture:transform",
    );
    expect(
      flattened.find(
        (node) => node.id === "model:object:box-1:magnetic-texture:transform",
      )?.kind,
    ).toBe("object.magnetic-texture.transform");
    expect(
      flattened.find((node) => node.id === "model:object:box-1")
        ?.contextCommands,
    ).toEqual(
      expect.arrayContaining([
        "geometry.focus-primitive",
        "geometry.delete-object",
        "mesh.build-selected",
      ]),
    );
  });

  it("projects antenna scene objects without magnetic object children", () => {
    const snapshot = modelTreeSnapshotFromScene({
      current_modules: {
        modules: [
          {
            kind: "antenna_field_source",
            model: "prescribed_zeeman_mask",
            name: "center_drive",
            object: "center_microstrip",
          },
        ],
      },
      objects: [
        {
          geometry: {
            geometry_kind: "Box",
            geometry_params: { size: [50e-9, 1e-6, 10e-9] },
          },
          id: "center_microstrip",
          name: "Center microstrip",
          role: "antenna",
          tags: ["role:antenna"],
          visualization_hint: { role: "antenna" },
        },
      ],
    });

    const flattened = flattenExplorerNodes(buildModelTree(snapshot));

    expect(
      flattened.find((node) => node.id === "model:object:center_microstrip"),
    ).toMatchObject({
      badge: "Box",
      icon: "wave",
      status: "ready",
    });
    expect(flattened.map((node) => node.id)).toEqual(
      expect.arrayContaining([
        "model:object:center_microstrip:geometry",
        "model:object:center_microstrip:antenna",
        "model:object:center_microstrip:visualization",
      ]),
    );
    expect(flattened.map((node) => node.id)).not.toContain(
      "model:object:center_microstrip:magnetic-parameters",
    );
    expect(flattened.map((node) => node.id)).not.toContain(
      "model:object:center_microstrip:magnetic-texture",
    );
    expect(flattened.map((node) => node.id)).not.toContain(
      "model:object:center_microstrip:mesh",
    );
  });

  it("shows authored object regions, material fields, and couplings from model resources", () => {
    const snapshot = modelTreeSnapshotFromScene(
      {
        objects: [
          {
            geometry: { geometry_kind: "Box" },
            id: "film",
            material_ref: "mat-film",
            name: "Film",
          },
        ],
      },
      {
        couplings: {
          couplings: [
            {
              coupling_id: "cpl-exchange",
              coupling_kind: "exchange",
              enabled: true,
              params: {},
              realization_status: "authored_pending_realization",
              source: { object: "film", region_id: "reg-core" },
              target: { object: "film", region_id: "reg-edge" },
            },
          ],
          scene_revision: 3,
        } as never,
        materialFields: {
          fields: [
            {
              assignment_id: "field-ms-core",
              field: {},
              owner_object_id: "film",
              parameter: "Ms",
              realization_status: "authored_pending_realization",
              source_region_id: "reg-core",
              unit: "A/m",
            },
          ],
          scene_revision: 3,
        } as never,
        regions: {
          geometry_realization_revision: 0,
          regions: [
            {
              bounds_max: [0, 0, 0],
              bounds_min: [0, 0, 0],
              enabled: true,
              interaction_refs: [],
              material_parameter_fields: [],
              material_overrides: [{ parameter: "Aex" }],
              material_ref: "mat-film",
              mesh_part_ids: [],
              mesh_policy: { maximum_element_size: 1e-9 },
              name: "Skyrmion core",
              owner_object_id: "film",
              priority: 10,
              region_id: "reg-core",
              region_kind: "object_region",
              realization_status: "authored_pending_realization",
              shape: { kind: "cylinder" },
              source: "authored_object_region",
              source_body_ids: [],
              source_object_ids: ["film"],
            },
          ],
          scene_revision: 3,
        } as never,
        regionMemberships: [
          {
            boundary_face_indices: [1],
            element_indices: [2],
            freshness: "current",
            mesh_generation_id: "generation-3",
            mesh_id: "shared-domain",
            mesh_part_ids: ["part:core"],
            mesh_revision: 3,
            node_indices: [3],
            owner_object_id: "film",
            realization: "conformal",
            region_id: "reg-core",
            region_membership_revision: 4,
            source: "fem_shared_domain",
            topology_fingerprint: "topology-3",
          },
        ],
      },
    );

    const flattened = flattenExplorerNodes(buildModelTree({
      ...snapshot,
      domainDiscretization: "fem",
    }));

    expect(
      flattened.find((node) => node.id === "model:object:film:regions")?.badge,
    ).toBe("1");
    expect(
      flattened.find((node) => node.id === "model:object:film:regions")
        ?.contextCommands,
    ).toEqual(
      expect.arrayContaining(["workspace.focus-selection", "mesh.open-regions"]),
    );
    expect(
      flattened.find((node) => node.id === "model:object:film:regions:reg-core"),
    ).toMatchObject({
      kind: "object.region",
      label: "Skyrmion core",
      objectId: "film",
      regionId: "reg-core",
    });
    expect(
      flattened.find((node) => node.id === "model:object:film:regions:reg-core")
        ?.contextCommands,
    ).toEqual(
      expect.arrayContaining([
        "regions.focus",
        "regions.duplicate",
        "regions.delete",
        "regions.priority-up",
        "regions.priority-down",
        "mesh.open-region-report",
      ]),
    );
    expect(
      flattened.find(
        (node) => node.id === "model:object:film:regions:reg-core:geometry",
      ),
    ).toMatchObject({ badge: "cylinder", kind: "object.region.geometry" });
    expect(
      flattened.find(
        (node) => node.id === "model:object:film:regions:reg-core:mesh",
      ),
    ).toMatchObject({ badge: "current", status: "mesh-ready" });
    expect(
      flattened.find(
        (node) =>
          node.id === "model:object:film:regions:reg-core:magnetic-parameters",
      )?.badge,
    ).toBe("1 override / 1 field");
    expect(
      flattened.find(
        (node) =>
          node.id ===
          "model:object:film:regions:reg-core:magnetic-parameters:field-ms-core",
      ),
    ).toMatchObject({ badge: "authored_pending_realization", label: "Ms (A/m)" });
    expect(
      flattened.find(
        (node) =>
          node.id === "model:object:film:regions:reg-core:visualization",
      ),
    ).toMatchObject({ kind: "object.region.visualization", badge: "display" });
    expect(
      flattened.find(
        (node) =>
          node.id === "model:object:film:regions:reg-core:visualization",
      )?.children?.at(-1),
    ).toMatchObject({
      badge: "debug",
      id: "model:object:film:regions:reg-core:visualization:debug",
      kind: "object.region.visualization.debug",
      label: "Debug",
      objectId: "film",
      parentId: "model:object:film:regions:reg-core:visualization",
      regionId: "reg-core",
    });
    expect(
      flattened.find(
        (node) => node.id === "model:object:film:regions:reg-core:regions",
      ),
    ).toMatchObject({ kind: "object.region.regions", badge: "inherits none" });
    expect(
      flattened.find((node) => node.id === "model:physics:couplings"),
    ).toMatchObject({ badge: "1", kind: "physics.couplings" });
    expect(
      flattened.find(
        (node) => node.id === "model:physics:couplings:cpl-exchange",
      ),
    ).toMatchObject({
      couplingId: "cpl-exchange",
      kind: "physics.coupling",
      status: "warning",
    });
    expect(
      flattened.find(
        (node) => node.id === "model:physics:couplings:cpl-exchange",
      )?.contextCommands,
    ).toEqual(
      expect.arrayContaining([
        "workspace.focus-selection",
        "couplings.disable",
        "couplings.delete",
      ]),
    );
  });

  it("uses typed scene material field owner_object when projecting region field nodes", () => {
    const scene: SceneResource = {
      objects: [
        {
          id: "film-a",
          material_parameter_fields: [
            {
              assignment_id: "field-ms-core",
              owner_object: "film-b",
              parameter: "ms",
              region_id: "reg-core",
              value: { kind: "constant", unit: "A/m", value: 800000 },
            },
          ],
        },
        {
          id: "film-b",
          regions: [
            {
              name: "Core",
              region_id: "reg-core",
              shape: { center: [0, 0, 0], kind: "sphere", radius: 1e-9 },
            },
          ],
        },
      ],
    };

    const flattened = flattenExplorerNodes(
      buildModelTree(modelTreeSnapshotFromScene(scene)),
    );

    expect(
      flattened.find(
        (node) =>
          node.id ===
          "model:object:film-b:regions:reg-core:magnetic-parameters:field-ms-core",
      ),
    ).toMatchObject({
      badge: "field",
      kind: "object.region.magnetic-parameters",
      label: "ms (A/m)",
      objectId: "film-b",
      regionId: "reg-core",
    });
    expect(
      flattened.map((node) => node.id),
    ).not.toContain(
      "model:object:film-a:regions:reg-core:magnetic-parameters:field-ms-core",
    );
  });

  it("qualifies colliding FEM region memberships through explicit owner identity", () => {
    const scene = {
      objects: [
        {
          id: "film-a",
          regions: [{
            mesh_policy: { maximum_element_size: 1e-9 },
            name: "Shared A",
            region_id: "shared",
            shape: { kind: "box", size: [1, 1, 1] },
          }],
        },
        {
          id: "film-b",
          regions: [{
            mesh_policy: { maximum_element_size: 1e-9 },
            name: "Shared B",
            region_id: "shared",
            shape: { kind: "box", size: [1, 1, 1] },
          }],
        },
      ],
    } as SceneResource;
    const membership = (ownerObjectId: string, freshness: string, revision: number) => ({
      boundary_face_indices: [],
      element_indices: [revision],
      freshness,
      mesh_generation_id: "generation-owners",
      mesh_id: "shared-domain",
      mesh_part_ids: [],
      mesh_revision: 4,
      node_indices: [revision],
      owner_object_id: ownerObjectId,
      realization: "conformal",
      region_id: "shared",
      region_membership_revision: revision,
      source: "fem_shared_domain",
      topology_fingerprint: "topology-owners",
    });

    const snapshot = modelTreeSnapshotFromScene(scene, {
      regionMemberships: [
        membership("film-a", "current", 11),
        membership("film-b", "preview", 12),
      ] as never,
    });

    expect(snapshot.objects?.find((object) => object.id === "film-a")?.regions?.[0])
      .toMatchObject({ id: "shared", meshLifecycleStatus: "current" });
    expect(snapshot.objects?.find((object) => object.id === "film-b")?.regions?.[0])
      .toMatchObject({ id: "shared", meshLifecycleStatus: "stale" });
  });

  it("withholds duplicate memberships for the same owner-qualified FEM region", () => {
    const snapshot = modelTreeSnapshotFromScene(
      {
        objects: [
          {
            id: "film-a",
            regions: [{
              mesh_policy: { maximum_element_size: 1e-9 },
              name: "Shared A",
              region_id: "shared",
              shape: { kind: "box", size: [1, 1, 1] },
            }],
          },
          {
            id: "film-b",
            regions: [{
              mesh_policy: { maximum_element_size: 1e-9 },
              name: "Shared B",
              region_id: "shared",
              shape: { kind: "box", size: [1, 1, 1] },
            }],
          },
        ],
      } as SceneResource,
      {
        regionMemberships: [13, 14].map((revision) => ({
          boundary_face_indices: [],
          element_indices: [1],
          freshness: "current",
          mesh_generation_id: "generation-ambiguous",
          mesh_id: "shared-domain",
          mesh_part_ids: [],
          mesh_revision: 4,
          node_indices: [1],
          owner_object_id: "film-a",
          realization: "conformal",
          region_id: "shared",
          region_membership_revision: revision,
          source: "fem_shared_domain",
          topology_fingerprint: "topology-ambiguous",
        })),
      },
    );

    expect(snapshot.objects?.flatMap((object) => object.regions ?? []).map(
      (region) => region.meshLifecycleStatus,
    )).toEqual(["stale", "stale"]);
  });

  it("shows object texture load nodes only after activation", () => {
    const flattened = flattenExplorerNodes(
      buildModelTree({
        objects: [
          {
            id: "box-1",
            label: "Box 1",
            textureLoadEnabled: true,
          },
        ],
      }),
    );

    expect(
      flattened.find(
        (node) => node.id === "model:object:box-1:magnetic-texture:load",
      ),
    ).toMatchObject({
      badge: "h5/zarr",
      contextCommands: ["study.load-field-state"],
      kind: "object.magnetic-texture.load",
      label: "Load texture",
      objectId: "box-1",
    });
  });

  it("keeps the explorer renderable before the scene resource is loaded", () => {
    const snapshot = modelTreeSnapshotFromScene(null);
    const flattened = flattenExplorerNodes(buildModelTree(snapshot));

    expect(snapshot.objects).toEqual([]);
    expect(flattened.map((node) => node.id)).toEqual(
      expect.arrayContaining(["model:universe", "model:objects"]),
    );
    expect(flattened.map((node) => node.id)).not.toContain(
      "model:object:free-layer",
    );
    expect(flattened.map((node) => node.id)).not.toContain("model:materials");
    expect(flattened.map((node) => node.id)).not.toContain("model:physics");
  });

  it("does not synthesize demo objects when the scene snapshot is missing", () => {
    const flattened = flattenExplorerNodes(buildModelTree(null));

    expect(flattened.map((node) => node.id)).toEqual(
      expect.arrayContaining(["model:universe", "model:objects"]),
    );
    expect(flattened.map((node) => node.id)).not.toContain(
      "model:object:free-layer",
    );
    expect(flattened.map((node) => node.id)).not.toContain(
      "model:object:reference-layer",
    );
    expect(flattened.map((node) => node.id)).not.toContain(
      "model:material:permalloy",
    );
    expect(flattened.map((node) => node.id)).not.toContain(
      "model:material:cofeb",
    );
    expect(flattened.map((node) => node.id)).not.toContain(
      "model:physics:exchange",
    );
    expect(flattened.map((node) => node.id)).not.toContain(
      "model:physics:demag",
    );
    expect(flattened.find((node) => node.id === "model:objects")?.badge).toBe(
      "0",
    );
  });

  it("builds study stages from the canonical scene instead of hardcoded demo stages", () => {
    const snapshot = modelTreeSnapshotFromScene({
      objects: [],
      study: {
        demag_realization: "poisson_robin",
        stages: [
          {
            stage_id: "stage-relax",
            kind: "relax",
            max_steps: "2000",
            torque_tolerance_apm: TORQUE_TOLERANCE_FOR_1E_4_T,
          },
          {
            kind: "run",
            until_seconds: "5e-9",
          },
          {
            artifact_name: "m-relaxed",
            kind: "save_state",
          },
          {
            device: "cpu",
            kind: "change_device",
          },
          {
            field_steps: 11,
            kind: "hysteresis",
            stage_id: "hysteresis-1",
          },
          {
            bc: "periodic",
            kind: "eigenmodes",
            k_sampling: { kind: "path" },
            stage_id: "eigen-1",
          },
          {
            bc: "periodic",
            calculation_mode: "response_map",
            kind: "frequency_response",
            k_sampling: { kind: "grid" },
            stage_id: "freq-1",
          },
        ],
      },
    });

    const flattened = flattenExplorerNodes(buildModelTree(snapshot));

    expect(flattened.find((node) => node.id === "model:study")?.badge).toBe(
      "7 stages",
    );
    expect(flattened.find((node) => node.id === "model:study")).toMatchObject({
      children: expect.arrayContaining([
        expect.objectContaining({ id: "model:study:stages" }),
        expect.objectContaining({ id: "model:study:execution" }),
        expect.objectContaining({ id: "model:study:recovery" }),
      ]),
    });
    expect(
      flattened.find((node) => node.id === "model:study:stages")
        ?.contextCommands,
    ).toEqual(
      expect.arrayContaining([
        "study.add-relax-stage",
        "study.add-field-drive-stage",
        "study.add-table-autosave-stage",
        "study.add-autosave-stage",
        "study.add-fft-response-stage",
        "study.add-run-stage",
        "study.add-hysteresis-stage",
        "study.add-eigenmodes-stage",
        "study.add-frequency-response-stage",
        "study.add-save-state-stage",
      ]),
    );
    expect(flattened.map((node) => node.id)).toEqual(
      expect.arrayContaining([
        "model:study:stages:stage:stage-relax",
        "model:study:stages:stage:1",
        "model:study:stages:stage:2",
        "model:study:stages:stage:3",
        "model:study:stages:stage:hysteresis-1",
        "model:study:stages:stage:eigen-1",
        "model:study:stages:stage:freq-1",
      ]),
    );
    expect(
      flattened.find(
        (node) => node.id === "model:study:stages:stage:stage-relax",
      ),
    ).toMatchObject({
      badge: "tau 1.000000e-4 T",
      contextCommands: expect.arrayContaining(["study.remove-selected-stage"]),
      kind: "study.stage.relax",
      label: "Relax 1",
      parentId: "model:study:stages",
    });
    expect(
      flattened.find((node) => node.id === "model:study:stages:stage:1"),
    ).toMatchObject({
      badge: "5e-9 s",
      kind: "study.stage.run",
      label: "Run 2",
    });
    expect(
      flattened.find((node) => node.id === "model:study:stages:stage:2"),
    ).toMatchObject({
      badge: "m-relaxed",
      kind: "study.stage.save_state",
      label: "Save State 3",
    });
    expect(
      flattened.find(
        (node) => node.id === "model:study:stages:stage:3",
      ),
    ).toMatchObject({
      badge: "cpu",
      kind: "study.stage.change_device",
      label: "Change Device 4",
    });
    expect(
      flattened.find(
        (node) => node.id === "model:study:stages:stage:hysteresis-1",
      ),
    ).toMatchObject({
      kind: "study.stage.hysteresis",
      label: "Hysteresis 5",
    });
    expect(
      flattened.find(
        (node) => node.id === "model:study:stages:stage:eigen-1",
      ),
    ).toMatchObject({
      kind: "study.stage.eigenmodes",
      label: "Eigenmodes 6",
    });
    expect(
      flattened.find(
        (node) => node.id === "model:study:stages:stage:eigen-1:k-path",
      ),
    ).toMatchObject({
      kind: "study.stage.eigenmodes.k_path",
      label: "k-Path",
      stageId: "eigen-1",
      stageIndex: 5,
    });
    expect(
      flattened.find(
        (node) =>
          node.id === "model:study:stages:stage:eigen-1:periodic-pairs",
      ),
    ).toMatchObject({
      kind: "study.stage.eigenmodes.periodic_pairs",
      label: "Periodic Pairs",
      stageId: "eigen-1",
      stageIndex: 5,
    });
    expect(
      flattened.find(
        (node) => node.id === "model:study:stages:stage:freq-1",
      ),
    ).toMatchObject({
      kind: "study.stage.frequency_response",
      label: "Frequency Response 7",
    });
    expect(
      flattened.find(
        (node) => node.id === "model:study:stages:stage:freq-1:excitation",
      ),
    ).toMatchObject({
      kind: "study.stage.frequency_response.excitation",
      label: "Excitation",
      stageId: "freq-1",
      stageIndex: 6,
    });
    expect(
      flattened.find(
        (node) =>
          node.id === "model:study:stages:stage:freq-1:periodic-pairs",
      ),
    ).toMatchObject({
      kind: "study.stage.frequency_response.periodic_pairs",
      label: "Periodic Pairs",
      stageId: "freq-1",
      stageIndex: 6,
    });
    expect(
      flattened.find(
        (node) => node.id === "model:study:stages:stage:freq-1:k-grid",
      ),
    ).toMatchObject({
      kind: "study.stage.frequency_response.k_grid",
      label: "k/f Grid",
      stageId: "freq-1",
      stageIndex: 6,
    });
    expect(flattened.map((node) => node.id)).not.toContain(
      "model:study:relax",
    );
    expect(flattened.map((node) => node.id)).not.toContain(
      "model:study:run",
    );
  });

  it("builds an explicit Add Antenna pipeline instruction node", () => {
    const snapshot = modelTreeSnapshotFromScene({
      objects: [],
      study: {
        stages: [
          {
            drive: {
              id: "k0-sinc-antenna",
              waveform: { kind: "sinc_pulse" },
            },
            kind: "add_field_drive",
            stage_id: "add-k0-antenna",
          },
        ],
      },
    });

    const node = flattenExplorerNodes(buildModelTree(snapshot)).find(
      (candidate) =>
        candidate.id === "model:study:stages:stage:add-k0-antenna",
    );
    expect(node).toMatchObject({
      badge: "field drive",
      kind: "study.stage.add_field_drive",
      label: "Add Antenna 1",
      stageId: "add-k0-antenna",
      stageIndex: 0,
    });
  });

  it("builds explicit workflow nodes for table autosave, autosave, and response FFT", () => {
    const snapshot = modelTreeSnapshotFromScene({
      objects: [],
      study: {
        stages: [
          { kind: "table_autosave", stage_id: "table-on" },
          { kind: "autosave", stage_id: "autosave-m" },
          { kind: "fft_response", stage_id: "fft-on" },
        ],
      },
    });

    const nodes = flattenExplorerNodes(buildModelTree(snapshot));
    expect(
      nodes.find((node) => node.id === "model:study:stages:stage:table-on"),
    ).toMatchObject({
      kind: "study.stage.table_autosave",
      label: "Table Autosave 1",
    });
    expect(
      nodes.find((node) => node.id === "model:study:stages:stage:autosave-m"),
    ).toMatchObject({
      kind: "study.stage.autosave",
      label: "Autosave 2",
    });
    expect(
      nodes.find((node) => node.id === "model:study:stages:stage:fft-on"),
    ).toMatchObject({
      kind: "study.stage.fft_response",
      label: "FFT Response 3",
    });
  });

  it("omits periodic and k-sampling eigenmode nodes for a free-boundary stage", () => {
    const snapshot = modelTreeSnapshotFromScene({
      objects: [],
      study: {
        stages: [
          {
            bc: "free",
            kind: "eigenmodes",
            stage_id: "eigen-free",
          },
        ],
      },
    });

    const flattened = flattenExplorerNodes(buildModelTree(snapshot));

    expect(flattened.map((node) => node.id)).toEqual(
      expect.arrayContaining([
        "model:study:stages:stage:eigen-free",
        "model:study:stages:stage:eigen-free:setup",
        "model:study:stages:stage:eigen-free:solver",
        "model:study:stages:stage:eigen-free:diagnostics",
      ]),
    );
    expect(flattened.map((node) => node.id)).not.toEqual(
      expect.arrayContaining([
        "model:study:stages:stage:eigen-free:periodic-pairs",
        "model:study:stages:stage:eigen-free:k-path",
      ]),
    );
  });

  it("reads object boundary conditions and namespaced k-sampling for eigenmode nodes", () => {
    const snapshot = modelTreeSnapshotFromScene({
      objects: [],
      study: {
        stages: [
          {
            eigen_k_sampling: { path: "gamma-x", points: 5 },
            eigen_spin_wave_bc: { axes: ["x"], kind: "periodic" },
            kind: "eigenmodes",
            stage_id: "eigen-periodic",
          },
        ],
      },
    });

    const flattened = flattenExplorerNodes(buildModelTree(snapshot));

    expect(flattened.map((node) => node.id)).toEqual(
      expect.arrayContaining([
        "model:study:stages:stage:eigen-periodic:boundary",
        "model:study:stages:stage:eigen-periodic:periodic-pairs",
        "model:study:stages:stage:eigen-periodic:k-path",
      ]),
    );
  });

  it("reads eigen k-path text as a path sampling node", () => {
    const snapshot = modelTreeSnapshotFromScene({
      objects: [],
      study: {
        stages: [
          {
            eigen_k_path: "Gamma:0,0,0; X:1e7,0,0 | samples=5",
            kind: "eigenmodes",
            stage_id: "eigen-path",
          },
        ],
      },
    });

    const flattened = flattenExplorerNodes(buildModelTree(snapshot));

    expect(flattened.map((node) => node.id)).toEqual(
      expect.arrayContaining([
        "model:study:stages:stage:eigen-path:k-path",
      ]),
    );
  });

  it("omits periodic and k-grid response nodes without response-map semantics", () => {
    const snapshot = modelTreeSnapshotFromScene({
      objects: [],
      study: {
        stages: [
          {
            bc: "free",
            calculation_mode: "fmr_response",
            kind: "frequency_response",
            stage_id: "response-free",
          },
        ],
      },
    });

    const flattened = flattenExplorerNodes(buildModelTree(snapshot));

    expect(flattened.map((node) => node.id)).toEqual(
      expect.arrayContaining([
        "model:study:stages:stage:response-free",
        "model:study:stages:stage:response-free:setup",
        "model:study:stages:stage:response-free:excitation",
        "model:study:stages:stage:response-free:sweep",
        "model:study:stages:stage:response-free:solver",
      ]),
    );
    expect(flattened.map((node) => node.id)).not.toEqual(
      expect.arrayContaining([
        "model:study:stages:stage:response-free:periodic-pairs",
        "model:study:stages:stage:response-free:k-grid",
      ]),
    );
  });

  it("uses stage execution ids and statuses for runtime study stage nodes", () => {
    const snapshot = modelTreeSnapshotWithStageExecution(
      modelTreeSnapshotFromScene({
        objects: [],
        study: {
          stages: [{ kind: "relax" }, { kind: "run" }],
        },
      }),
      {
        active_stage_index: 1,
        active_stage_kind: "run",
        completed_stage_indexes: [0],
        revision: 12,
        runtime_state: "running",
        stage_statuses: ["completed", "running"],
        stages: [
          { index: 0, stage_id: "runtime-relax", status: "completed" },
          { index: 1, stage_id: "runtime-run", status: "running" },
        ],
        total_stages: 2,
      } as never,
    );
    const flattened = flattenExplorerNodes(buildModelTree(snapshot));

    expect(
      flattened.find(
        (node) => node.id === "model:study:stages:stage:runtime-relax",
      ),
    ).toMatchObject({
      stageId: "runtime-relax",
      stageIndex: 0,
      status: "completed",
    });
    expect(
      flattened.find(
        (node) => node.id === "model:study:stages:stage:runtime-run",
      ),
    ).toMatchObject({
      label: "Run 2",
      status: "running",
    });
  });

  it("builds run-owned physics-first results from explicit manifest evidence", () => {
    const results = flattenExplorerNodes(
      buildExplorerTree("results", {
        currentRun: currentRun("run-fd-1", 7),
        frequencyDomainManifest: {
          ...FREQUENCY_DOMAIN_MANIFEST,
          result_manifest: {
            payload: {
              equilibrium_identity: "equilibrium-r4",
              requested_execution: { boundary_context: "finite_open" },
              revision: "spectrum-r7",
              stage_id: "eigen-stage",
              stage_label: "Eigenmodes",
              study_product: "modal_eigen",
            },
            status: "ready",
          },
        } as FrequencyDomainManifestResource,
        frequencyDomainSpectrum: FREQUENCY_DOMAIN_SPECTRUM,
      }),
    );

    expect(results.map((node) => node.id)).toEqual(
      expect.arrayContaining([
        "results:run:run-fd-1",
        "results:run:run-fd-1:resonance",
        "results:run:run-fd-1:resonance:stage:eigen-stage:modal_eigen",
        "results:run:run-fd-1:resonance:stage:eigen-stage:modal_eigen:spectrum",
        "results:run:run-fd-1:resonance:stage:eigen-stage:modal_eigen:modes",
      ]),
    );
    expect(
      results.find(
        (node) =>
          node.id ===
          "results:run:run-fd-1:resonance:stage:eigen-stage:modal_eigen:spectrum",
      ),
    ).toMatchObject({
      analysisRunId: "run-fd-1",
      analysisStageId: "eigen-stage",
      artifactRevision: "spectrum-r7",
      equilibriumId: "equilibrium-r4",
      kind: "results.resonance.modal.spectrum",
      label: "Eigenfrequency Spectrum",
      studyProduct: "modal_eigen",
    });
  });
  it("does not recreate removed solver-first result namespaces", () => {
    const results = flattenExplorerNodes(
      buildExplorerTree("results", {
        currentRun: currentRun("run-fd-1", 7),
        frequencyDomainManifest: {
          ...FREQUENCY_DOMAIN_MANIFEST,
          result_manifest: {
            payload: {
              equilibrium_identity: "equilibrium-r4",
              requested_execution: { boundary_context: "finite_open" },
              revision: "spectrum-r7",
              stage_id: "eigen-stage",
              study_product: "modal_eigen",
            },
            status: "ready",
          },
        } as FrequencyDomainManifestResource,
        frequencyDomainSpectrum: FREQUENCY_DOMAIN_SPECTRUM,
      }),
    );
    const ids = results.map((node) => node.id);

    expect(ids).toContain("results:run:run-fd-1:resonance");
    expect(ids).not.toContain("results:eigen");
    expect(ids).not.toContain("results:frequency-response");
    expect(ids).not.toContain("results:frequency-domain");
  });
  it("projects only the active analysis overlay under object visualization", () => {
    const flattened = flattenExplorerNodes(
      (
        buildModelTree as unknown as (
          snapshot: Parameters<typeof buildModelTree>[0],
          resources: Record<string, unknown>,
        ) => ReturnType<typeof buildModelTree>
      )(
        {
          objects: [
            {
              geometryKind: "box",
              id: "film",
              label: "Film",
              magnetization: "m",
              objectRole: "magnet",
            },
          ],
        },
        {
          activeAnalysisFieldOverlay: {
            fieldId: "analysis:frequency-response:field-0001",
            frequencyIndex: 1,
            label: "Response field 1",
            provenance: {
              artifactRevision: 9,
              equilibriumId: "equilibrium-2",
              kContextKind: "gamma",
              resourceRef: "data/fields/analysis:frequency-response:field-0001",
              runId: "run-response-2",
              stageId: "response-stage",
              studyProduct: "driven_response",
            },
            query: {
              component: "full",
              phase_rad: 0,
              scope_kind: "full",
              view: "real",
            },
            source: "frequency-response",
          },
        },
      ),
    );

    expect(
      flattened.find(
        (node) =>
          node.id === "model:object:film:visualization:mode-visualization",
      ),
    ).toMatchObject({
      badge: "Driven",
      fieldId: "analysis:frequency-response:field-0001",
      kind: "object.mode_visualization",
      label: "Active Analysis Overlay",
      objectId: "film",
      parentId: "model:object:film:visualization",
      status: "ready",
      analysisRunId: "run-response-2",
      analysisStageId: "response-stage",
      artifactRevision: 9,
      equilibriumId: "equilibrium-2",
      frequencyIndex: 1,
      kContextKind: "gamma",
      resourceRef: "data/fields/analysis:frequency-response:field-0001",
      studyProduct: "driven_response",
    });
    expect(
      flattened.filter((node) => node.label === "Active Analysis Overlay"),
    ).toHaveLength(1);
    expect(
      flattened.some((node) =>
        node.id.startsWith(
          "model:object:film:visualization:mode-visualization:",
        ),
      ),
    ).toBe(false);
  });
  it("does not derive resource fields from an untyped manifest payload", () => {
    const activeResources = flattenExplorerNodes(
      buildExplorerTree("resources", {
        activeAnalysisFieldOverlay: {
          fieldId: "analysis:frequency-response:field-0001",
          label: "Response field 1",
          query: {
            component: "full",
            phase_rad: 0,
            scope_kind: "full",
            view: "real",
          },
          source: "frequency-response",
        },
        currentRun: currentRun("run-fd-1", 7),
        frequencyDomainManifest: {
          ...FREQUENCY_DOMAIN_MANIFEST,
          result_manifest: {
            payload: {
              resources: {
                response_field_resources: [
                  {
                    field_resource_id: "analysis:frequency-response:field-0001",
                    frequency_index: 1,
                  },
                ],
              },
            },
          },
        } as FrequencyDomainManifestResource,
      }),
    );

    expect(activeResources).toHaveLength(1);
    expect(activeResources[0]).toMatchObject({
      id: "resources:root",
      status: "unavailable",
    });
  });
  it("does not infer jobs from frequency-domain artifacts or progress", () => {
    const jobs = flattenExplorerNodes(
      buildExplorerTree("jobs", {
        currentRun: currentRun("run-fd-1", 7),
        frequencyDomainCancelRequested: FREQUENCY_DOMAIN_RESPONSE_CANCEL_REQUESTED,
        frequencyDomainManifest: FREQUENCY_DOMAIN_MANIFEST,
        frequencyDomainResponseProgress: FREQUENCY_DOMAIN_RESPONSE_PROGRESS,
        frequencyDomainResponseSweep: FREQUENCY_DOMAIN_RESPONSE_SWEEP,
        frequencyDomainSpectrum: FREQUENCY_DOMAIN_SPECTRUM,
      }),
    );

    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ id: "jobs:root", status: "unavailable" });
  });

  it("does not project unowned legacy response points into Results", () => {
    const results = flattenExplorerNodes(
      buildExplorerTree("results", {
        currentRun: currentRun("run-fd-1", 7),
        frequencyDomainManifest: {
          ...FREQUENCY_DOMAIN_MANIFEST,
          result_manifest: {
            payload: {
              resources: {
                response_field_resources: [
                  {
                    field_resource_id: "analysis:frequency-response:frequency-0042",
                    frequency_index: 1,
                  },
                ],
              },
            },
            status: "ready",
          },
        } as FrequencyDomainManifestResource,
        frequencyDomainResponseSweep: FREQUENCY_DOMAIN_RESPONSE_SWEEP,
      }),
    );

    expect(results.map((node) => node.id)).not.toContain(
      "results:frequency-response:frequency-points:1",
    );
    expect(results.find((node) => node.kind === "results.resonance.driven.stage")).toBeUndefined();
  });
  it("renders hysteresis as one dynamic field node with settle algorithms", () => {
    const snapshot = modelTreeSnapshotWithStageExecution(
      modelTreeSnapshotFromScene({
        objects: [],
        study: {
          stages: [
            {
              kind: "hysteresis",
              stage_id: "hysteresis-1",
              field_max_mT: 100,
              field_min_mT: -100,
              field_step_mT: 10,
              initial_protocol: "positive_saturation",
              branch_mode: "major_loop",
              saturation: { mode: "auto" },
              settle_pipeline: {
                kind: "sequence",
                steps: [
                  {
                    kind: "relax",
                    method: "llg_overdamped",
                    alpha: 1,
                    torque_tolerance: 1e-5,
                    max_steps: 10000,
                  },
                  {
                    kind: "minimize",
                    method: "projected_gradient_bb",
                    torque_tolerance: 5e-6,
                    energy_tolerance: 1e-20,
                    max_steps: 2000,
                  },
                ],
              },
            },
          ],
        },
      }),
      {
        active_stage_index: 0,
        active_stage_kind: "hysteresis",
        completed_stage_indexes: [],
        revision: 13,
        runtime_state: "running",
        stage_statuses: ["running"],
        stages: [
          {
            index: 0,
            stage_id: "hysteresis-1",
            status: "running",
            current_field_mT: 25,
            current_point_index: 4,
            current_settle_step_index: 1,
            current_settle_step_kind: "minimize",
            current_settle_step_method: "projected_gradient_bb",
          },
        ],
        total_stages: 1,
      } as never,
    );
    const flattened = flattenExplorerNodes(buildModelTree(snapshot));

    expect(
      flattened.filter(
        (node) => node.id.includes(":field-point:") && !node.id.includes(":algorithm:"),
      ),
    ).toHaveLength(1);
    expect(
      flattened.find(
        (node) =>
          node.id ===
          "model:study:stages:stage:hysteresis-1:field-point:4",
      ),
    ).toMatchObject({
      badge: "25 mT / point 5",
      label: "Current Field",
      status: "running",
    });
    expect(
      flattened.find(
        (node) =>
          node.id ===
          "model:study:stages:stage:hysteresis-1:field-point:4:algorithm:0",
      ),
    ).toMatchObject({
      badge: "llg_overdamped",
      label: "Relax 1",
      status: "completed",
    });
    expect(
      flattened.find(
        (node) =>
          node.id ===
          "model:study:stages:stage:hysteresis-1:field-point:4:algorithm:1",
      ),
    ).toMatchObject({
      badge: "projected_gradient_bb",
      label: "Minimize 2",
      status: "running",
    });
  });

  it("renders hysteresis active window from the backend execution tree", () => {
    const snapshot = modelTreeSnapshotWithStageExecution(
      modelTreeSnapshotFromScene({
        objects: [],
        study: {
          stages: [
            {
              kind: "hysteresis",
              stage_id: "hysteresis-1",
              field_max_mT: 100,
              field_min_mT: -100,
              field_step_mT: 10,
            },
          ],
        },
      }),
      {
        active_stage_index: 0,
        active_stage_kind: "hysteresis",
        completed_stage_indexes: [],
        revision: 21,
        runtime_state: "running",
        stage_statuses: ["running"],
        stages: [
          {
            index: 0,
            stage_id: "hysteresis-1",
            status: "running",
            current_field_mT: 30,
            current_point_index: 7,
            current_settle_step_index: 1,
            current_settle_step_kind: "minimize",
            current_settle_step_method: "projected_gradient_bb",
          },
        ],
        total_stages: 1,
      } as never,
    );
    const executionTree: HysteresisExecutionTreeResource = {
      active_point_index: 7,
      after: 2,
      before: 2,
      include_bookmarks: false,
      include_snapshots: false,
      include_warnings: true,
      revision: 22,
      stage_id: "hysteresis-1",
      stage_index: 0,
      total_points: 21,
      window: "active",
      nodes: [
        {
          kind: "summary",
          label: "Completed points",
          node_id: "completed",
          stage_id: "hysteresis-1",
          status: "done",
          updated_revision: 22,
        },
        {
          children: [
            {
              kind: "settle_algorithm",
              label: "Relax",
              node_id: "point-7:relax",
              point_id: 7,
              resource_ref: hysteresisSettleTraceResourceKey("hysteresis-1", 7),
              settle_step_id: "relax",
              selection_ref: "hysteresis-settle:hysteresis-1:7:0",
              stage_id: "hysteresis-1",
              status: "done",
              updated_revision: 22,
            },
            {
              kind: "settle_algorithm",
              label: "Minimize",
              node_id: "point-7:minimize",
              point_id: 7,
              resource_ref: hysteresisSettleTraceResourceKey("hysteresis-1", 7),
              settle_step_id: "minimize",
              selection_ref: "hysteresis-settle:hysteresis-1:7:1",
              stage_id: "hysteresis-1",
              status: "active",
              updated_revision: 22,
            },
            {
              kind: "settle_algorithm",
              label: "Dynamics settle",
              node_id: "point-7:dynamics",
              point_id: 7,
              resource_ref: hysteresisSettleTraceResourceKey("hysteresis-1", 7),
              settle_step_id: "dynamics",
              selection_ref: "hysteresis-settle:hysteresis-1:7:2",
              stage_id: "hysteresis-1",
              status: "queued",
              updated_revision: 22,
            },
            {
              field_orientation: { kind: "preset", preset_name: "in_plane_x" },
              field_revision: 12,
              kind: "snapshot",
              label: "Snapshot hysteresis_point_007",
              measurement_axis: { kind: "custom", vector: [1, 0, 0] },
              mesh_identity: "study_domain:rev-12",
              node_id: "point-7:snapshot:hysteresis_point_007",
              point_id: 7,
              resource_ref: snapshotVectorResourceKey("hysteresis_point_007_from_resource"),
              selection_ref: "hysteresis-snapshot:hysteresis-1:7:hysteresis_point_007_from_selection",
              stage_id: "hysteresis-1",
              status: "done",
              updated_revision: 22,
            },
            {
              kind: "warning",
              label: "2 warning(s)",
              node_id: "point-7:warnings",
              point_id: 7,
              resource_ref: hysteresisPointResourceKey("hysteresis-1", 7),
              selection_ref: "hysteresis-warning:hysteresis-1:7",
              stage_id: "hysteresis-1",
              status: "warning",
              updated_revision: 22,
            },
            {
              kind: "snapshot",
              label: "Snapshot hysteresis_point_missing missing",
              node_id: "point-7:snapshot:hysteresis_point_missing",
              point_id: 7,
              resource_ref: snapshotVectorResourceKey("hysteresis_point_missing"),
              selection_ref: "hysteresis-snapshot:hysteresis-1:7:hysteresis_point_missing",
              stage_id: "hysteresis-1",
              status: "missing",
              updated_revision: 22,
            },
          ],
          kind: "field_point",
          label: "Field +30 mT",
          node_id: "point-7",
          point_id: 7,
          resource_ref: hysteresisPointResourceKey("hysteresis-1", 7),
          selection_ref: "hysteresis-point:hysteresis-1:7",
          stage_id: "hysteresis-1",
          status: "active",
          updated_revision: 22,
        },
      ],
    };
    (snapshot.study!.stages[0] as { hysteresisExecutionTree?: HysteresisExecutionTreeResource })
      .hysteresisExecutionTree = executionTree;

    const flattened = flattenExplorerNodes(buildModelTree(snapshot));
    const stageId = "model:study:stages:stage:hysteresis-1";

    expect(flattened.find((node) => node.id === `${stageId}:points`)).toMatchObject({
      badge: "8/21",
      label: "Points",
      status: "running",
    });
    expect(flattened.find((node) => node.id === `${stageId}:field-point:7`)).toMatchObject({
      badge: "Field +30 mT",
      hysteresisExecutionNodeId: "point-7",
      hysteresisExecutionNodeKind: "field_point",
      hysteresisPointId: 7,
      hysteresisSelectionRef: "hysteresis-point:hysteresis-1:7",
      label: "Field +30 mT",
      resourceRef: hysteresisPointResourceKey("hysteresis-1", 7),
      status: "running",
    });
    expect(
      flattened.find((node) => node.id === `${stageId}:field-point:7:algorithm:relax`),
    ).toMatchObject({
      hysteresisExecutionNodeId: "point-7:relax",
      hysteresisExecutionNodeKind: "settle_algorithm",
      hysteresisPointId: 7,
      hysteresisSelectionRef: "hysteresis-settle:hysteresis-1:7:0",
      label: "Relax",
      resourceRef: hysteresisSettleTraceResourceKey("hysteresis-1", 7),
      status: "completed",
    });
    expect(
      flattened.find((node) => node.id === `${stageId}:field-point:7:algorithm:minimize`),
    ).toMatchObject({
      hysteresisSelectionRef: "hysteresis-settle:hysteresis-1:7:1",
      label: "Minimize",
      resourceRef: hysteresisSettleTraceResourceKey("hysteresis-1", 7),
      status: "running",
    });
    expect(
      flattened.find((node) => node.id === `${stageId}:field-point:7:algorithm:dynamics`),
    ).toMatchObject({
      hysteresisSelectionRef: "hysteresis-settle:hysteresis-1:7:2",
      label: "Dynamics settle",
      resourceRef: hysteresisSettleTraceResourceKey("hysteresis-1", 7),
      status: "queued",
    });
    expect(
      flattened.find((node) => node.id === `${stageId}:field-point:7:snapshot:hysteresis_point_007`),
    ).toMatchObject({
      contextCommands: expect.arrayContaining([
        "hysteresis.use-point-as-initial-state",
        "workspace.focus-selection",
      ]),
      contextCommandInputs: {
        "hysteresis.use-point-as-initial-state": {
          snapshotId: "hysteresis_point_007_from_selection",
          snapshotResourceRef: snapshotVectorResourceKey("hysteresis_point_007_from_resource"),
          stageId: "hysteresis-1",
        },
      },
      fieldOrientation: JSON.stringify({ kind: "preset", preset_name: "in_plane_x" }),
      fieldRevision: 12,
      hysteresisSnapshotId: "hysteresis_point_007_from_selection",
      measurementAxis: JSON.stringify({ kind: "custom", vector: [1, 0, 0] }),
      meshIdentity: "study_domain:rev-12",
      resourceRef: snapshotVectorResourceKey("hysteresis_point_007_from_resource"),
      label: "Snapshot hysteresis_point_007",
      status: "completed",
    });
    expect(
      flattened.find(
        (node) => node.id === `${stageId}:points:bookmarks`,
      ),
    ).toMatchObject({
      badge: "1 event",
      label: "Bookmarks",
      status: "ready",
    });
    expect(
      flattened.find(
        (node) =>
          node.id === `${stageId}:points:bookmarks:snapshot:hysteresis_point_007`,
      ),
    ).toMatchObject({
      contextCommands: expect.arrayContaining([
        "hysteresis.use-point-as-initial-state",
        "workspace.focus-selection",
      ]),
      contextCommandInputs: {
        "hysteresis.use-point-as-initial-state": {
          snapshotId: "hysteresis_point_007_from_selection",
          snapshotResourceRef: snapshotVectorResourceKey("hysteresis_point_007_from_resource"),
          stageId: "hysteresis-1",
        },
      },
      fieldOrientation: JSON.stringify({ kind: "preset", preset_name: "in_plane_x" }),
      fieldRevision: 12,
      hysteresisSnapshotId: "hysteresis_point_007_from_selection",
      label: "Snapshot hysteresis_point_007",
      measurementAxis: JSON.stringify({ kind: "custom", vector: [1, 0, 0] }),
      meshIdentity: "study_domain:rev-12",
      resourceRef: snapshotVectorResourceKey("hysteresis_point_007_from_resource"),
      status: "completed",
    });
    expect(
      flattened.find((node) => node.id === `${stageId}:field-point:7:warning:point-7-warnings`),
    ).toMatchObject({
      hysteresisExecutionNodeId: "point-7:warnings",
      hysteresisExecutionNodeKind: "warning",
      hysteresisSelectionRef: "hysteresis-warning:hysteresis-1:7",
      hysteresisPointId: 7,
      label: "2 warning(s)",
      resourceRef: hysteresisPointResourceKey("hysteresis-1", 7),
      status: "warning",
    });
    expect(
      flattened.find((node) => node.id === `${stageId}:field-point:7:snapshot:hysteresis_point_missing`),
    ).toMatchObject({
      hysteresisExecutionNodeId: "point-7:snapshot:hysteresis_point_missing",
      hysteresisExecutionNodeKind: "snapshot",
      label: "Snapshot hysteresis_point_missing missing",
      status: "failed",
    });
    expect(
      flattened.find((node) => node.id === `${stageId}:field-point:7:snapshot:hysteresis_point_missing`),
    ).not.toMatchObject({
      contextCommands: expect.arrayContaining(["hysteresis.use-point-as-initial-state"]),
      hysteresisSnapshotId: "hysteresis_point_missing",
    });
  });

  it("renders hysteresis branches from the backend execution tree", () => {
    const snapshot = modelTreeSnapshotWithStageExecution(
      modelTreeSnapshotFromScene({
        objects: [],
        study: {
          stages: [
            {
              kind: "hysteresis",
              stage_id: "hysteresis-1",
              field_max_mT: 100,
              field_min_mT: -100,
              field_step_mT: 10,
              branch_mode: "major_loop",
            },
          ],
        },
      }),
      {
        active_stage_index: 0,
        active_stage_kind: "hysteresis",
        completed_stage_indexes: [],
        revision: 31,
        runtime_state: "running",
        stage_statuses: ["running"],
        stages: [
          {
            index: 0,
            stage_id: "hysteresis-1",
            status: "running",
            current_field_mT: -20,
            current_point_index: 12,
          },
        ],
        total_stages: 1,
      } as never,
    );
    const executionTree: HysteresisExecutionTreeResource = {
      active_point_index: 12,
      after: 2,
      before: 2,
      include_bookmarks: false,
      include_snapshots: false,
      include_warnings: true,
      revision: 32,
      stage_id: "hysteresis-1",
      stage_index: 0,
      total_points: 41,
      window: "active",
      nodes: [
        {
          kind: "branch",
          label: "Descending branch",
          node_id: "branch:descending",
          stage_id: "hysteresis-1",
          status: "done",
          updated_revision: 32,
        },
        {
          kind: "branch",
          label: "Ascending branch",
          node_id: "branch:ascending",
          stage_id: "hysteresis-1",
          status: "active",
          updated_revision: 32,
          children: [
            {
              kind: "field_point",
              label: "H = -20.000 mT",
              node_id: "branch:ascending:point:12",
              point_id: 12,
              resource_ref: hysteresisPointResourceKey("hysteresis-1", 12),
              stage_id: "hysteresis-1",
              status: "active",
              updated_revision: 32,
            },
          ],
        },
        {
          kind: "branch",
          label: "Minor loop 001",
          node_id: "branch:minor-loop-001",
          stage_id: "hysteresis-1",
          status: "queued",
          updated_revision: 32,
        },
      ],
    };
    (snapshot.study!.stages[0] as { hysteresisExecutionTree?: HysteresisExecutionTreeResource })
      .hysteresisExecutionTree = executionTree;

    const flattened = flattenExplorerNodes(buildModelTree(snapshot));
    const stageId = "model:study:stages:stage:hysteresis-1";

    expect(
      flattened.flatMap((node) =>
        node.parentId === `${stageId}:branches` ? [node.id] : [],
      ),
    ).toEqual([
      `${stageId}:branches:branch:descending`,
      `${stageId}:branches:branch:ascending`,
      `${stageId}:branches:branch:minor-loop-001`,
    ]);
    expect(
      flattened.find((node) => node.id === `${stageId}:branches:branch:ascending`),
    ).toMatchObject({
      branchId: "branch:ascending",
      hysteresisExecutionNodeId: "branch:ascending",
      hysteresisExecutionNodeKind: "branch",
      label: "Ascending branch",
      status: "running",
    });
    expect(
      flattened.find(
        (node) => node.id === `${stageId}:branches:branch:ascending:field-point:12`,
      ),
    ).toMatchObject({
      hysteresisExecutionNodeId: "branch:ascending:point:12",
      hysteresisExecutionNodeKind: "field_point",
      hysteresisPointId: 12,
      label: "H = -20.000 mT",
      resourceRef: hysteresisPointResourceKey("hysteresis-1", 12),
      status: "running",
    });
    expect(flattened.find((node) => node.id === `${stageId}:branches:forward`)).toBeUndefined();
    expect(flattened.find((node) => node.id === `${stageId}:branches:return`)).toBeUndefined();
    expect(
      flattened.find((node) => node.id === `${stageId}:branches:minor-loops`),
    ).toBeUndefined();
  });

  it("renders hysteresis experiment structure without expanding every field point", () => {
    const snapshot = modelTreeSnapshotWithStageExecution(
      modelTreeSnapshotFromScene({
        objects: [],
        study: {
          stages: [
            {
              kind: "hysteresis",
              stage_id: "hysteresis-1",
              field_max_mT: 100,
              field_min_mT: -100,
              field_step_mT: 10,
              initial_protocol: "positive_saturation",
              branch_mode: "major_loop",
              saturation: { mode: "auto" },
              settle_pipeline: {
                kind: "sequence",
                steps: [
                  {
                    kind: "minimize",
                    method: "projected_gradient_bb",
                    torque_tolerance: 5e-5,
                    energy_tolerance: 1e-20,
                    max_steps: 2000,
                  },
                  {
                    kind: "relax",
                    method: "llg_overdamped",
                    torque_tolerance: 1e-5,
                    max_steps: 10000,
                  },
                ],
              },
            },
          ],
        },
      }),
      {
        active_stage_index: 0,
        active_stage_kind: "hysteresis",
        completed_stage_indexes: [],
        revision: 15,
        runtime_state: "running",
        stage_statuses: ["running"],
        stages: [
          {
            index: 0,
            stage_id: "hysteresis-1",
            status: "running",
            current_field_mT: 25,
            current_point_index: 4,
            current_settle_step_index: 0,
            current_settle_step_kind: "minimize",
            current_settle_step_method: "projected_gradient_bb",
          },
        ],
        total_stages: 1,
      } as never,
    );
    const flattened = flattenExplorerNodes(buildModelTree(snapshot));
    const stageId = "model:study:stages:stage:hysteresis-1";

    expect(
      flattened.flatMap((node) =>
        node.parentId === stageId ? [node.id] : [],
      ),
    ).toEqual(expect.arrayContaining([
      `${stageId}:plan`,
      `${stageId}:protocol`,
      `${stageId}:orientation`,
      `${stageId}:saturation`,
      `${stageId}:adaptive-refinement`,
      `${stageId}:angular-family`,
      `${stageId}:settle-pipeline`,
      `${stageId}:live-run`,
      `${stageId}:branches`,
      `${stageId}:points`,
      `${stageId}:metrics`,
      `${stageId}:snapshots`,
      `${stageId}:field-point:4`,
      `${stageId}:transitions`,
    ]));
    expect(flattened.find((node) => node.id === `${stageId}:plan`)).toMatchObject({
      label: "Plan",
      badge: "-100..100 mT / step 10",
      status: "ready",
    });
    expect(flattened.find((node) => node.id === `${stageId}:live-run`)).toMatchObject({
      label: "Live Run",
      badge: "25 mT / point 5",
      status: "running",
    });
    expect(flattened.find((node) => node.id === `${stageId}:orientation`)).toMatchObject({
      label: "Orientation",
      badge: "field axis",
      status: "running",
    });
    expect(
      flattened.find((node) => node.id === `${stageId}:adaptive-refinement`),
    ).toMatchObject({
      label: "Adaptive Refinement",
      badge: "runtime pass",
      status: "running",
    });
    expect(
      flattened.find((node) => node.id === `${stageId}:angular-family`),
    ).toMatchObject({
      label: "Angular Family",
      badge: "variants",
      status: "running",
    });
    expect(
      flattened.find((node) => node.id === `${stageId}:settle-pipeline`),
    ).toMatchObject({
      badge: "2 steps",
      label: "Settle Pipeline",
      status: "running",
    });
    expect(flattened.find((node) => node.id === `${stageId}:protocol`)).toMatchObject({
      badge: "positive_saturation / major_loop",
    });
    expect(flattened.find((node) => node.id === `${stageId}:saturation`)).toMatchObject({
      badge: "auto",
      status: "ready",
    });
    expect(
      flattened.flatMap((node) =>
        node.parentId === `${stageId}:branches` ? [node.id] : [],
      ),
    ).toEqual(expect.arrayContaining([
      `${stageId}:branches:forward`,
      `${stageId}:branches:return`,
      `${stageId}:branches:minor-loops`,
    ]));
    expect(
      flattened.filter(
        (node) => node.id.includes(":point:") && !node.id.includes(":field-point:"),
      ),
    ).toHaveLength(0);
    expect(flattened.find((node) => node.id === `${stageId}:transitions`)).toMatchObject({
      badge: "after completion",
      label: "Transitions",
      status: "queued",
    });
    expect(
      flattened.find((node) => node.id === `${stageId}:transitions:continue`),
    ).toMatchObject({
      label: "Continue to next stage",
      badge: "pending",
      status: "queued",
    });
    expect(
      flattened.find((node) => node.id === `${stageId}:transitions:continue`)
        ?.contextCommands,
    ).not.toEqual(expect.arrayContaining(["hysteresis.continue-to-next-stage"]));
    expect(
      flattened.find((node) => node.id === `${stageId}:transitions:export-loop`),
    ).toMatchObject({
      label: "Export loop CSV",
      badge: "after completion",
      status: "queued",
    });
    expect(
      flattened.find((node) => node.id === `${stageId}:transitions:export-loop`)
        ?.contextCommands,
    ).not.toEqual(expect.arrayContaining(["hysteresis.export-loop-csv"]));
  });

  it("keeps completed hysteresis continuation explicit without marking it executable", () => {
    const snapshot = modelTreeSnapshotWithStageExecution(
      modelTreeSnapshotFromScene({
        objects: [],
        study: {
          stages: [
            {
              kind: "hysteresis",
              stage_id: "hysteresis-1",
              field_max_mT: 100,
              field_min_mT: -100,
              field_step_mT: 10,
            },
          ],
        },
      }),
      {
        active_stage_index: null,
        active_stage_kind: null,
        completed_stage_indexes: [0],
        revision: 16,
        runtime_state: "completed",
        stage_statuses: ["completed"],
        stages: [
          {
            index: 0,
            stage_id: "hysteresis-1",
            status: "completed",
          },
        ],
        total_stages: 1,
      } as never,
    );
    const flattened = flattenExplorerNodes(buildModelTree(snapshot));
    const stageId = "model:study:stages:stage:hysteresis-1";

    expect(flattened.find((node) => node.id === `${stageId}:transitions`)).toMatchObject({
      badge: "available",
      label: "Transitions",
      status: "ready",
    });
    expect(
      flattened.find((node) => node.id === `${stageId}:transitions:continue`),
    ).toMatchObject({
      label: "Continue to next stage",
      badge: "available",
      contextCommands: expect.arrayContaining(["hysteresis.continue-to-next-stage"]),
      contextCommandInputs: {
        "hysteresis.continue-to-next-stage": {
          stageId: "hysteresis-1",
        },
      },
      status: "ready",
    });
    expect(
      flattened.find(
        (node) => node.id === `${stageId}:transitions:use-selected-point`,
      ),
    ).toMatchObject({
      label: "Use selected point as initial state",
      badge: "explicit action",
      status: "ready",
    });
    expect(
      flattened.find((node) => node.id === `${stageId}:transitions:export-loop`),
    ).toMatchObject({
      label: "Export loop CSV",
      badge: "available",
      contextCommands: expect.arrayContaining(["hysteresis.export-loop-csv"]),
      contextCommandInputs: {
        "hysteresis.export-loop-csv": {
          stageId: "hysteresis-1",
        },
      },
      status: "ready",
    });
    expect(
      flattened.find(
        (node) => node.id === `${stageId}:transitions:open-snapshots`,
      ),
    ).toMatchObject({
      label: "Open snapshots",
      badge: "snapshot branch",
      status: "ready",
    });
  });

  it("renders hysteresis protocol and saturation from the stage contract", () => {
    const snapshot = modelTreeSnapshotFromScene({
      objects: [],
      study: {
        stages: [
          {
            kind: "hysteresis",
            stage_id: "virgin-hysteresis",
            field_max_mT: 80,
            field_min_mT: 0,
            field_step_mT: 2,
            initial_protocol: "zero_field_relaxed",
            branch_mode: "virgin_curve",
          },
        ],
      },
    });
    const flattened = flattenExplorerNodes(buildModelTree(snapshot));
    const stageId = "model:study:stages:stage:virgin-hysteresis";

    expect(flattened.find((node) => node.id === `${stageId}:protocol`)).toMatchObject({
      label: "Protocol",
      badge: "zero_field_relaxed / virgin_curve",
      status: "ready",
    });
    expect(flattened.find((node) => node.id === `${stageId}:saturation`)).toMatchObject({
      label: "Saturation",
      badge: "not configured",
      status: "skipped",
    });
    expect(flattened.find((node) => node.id === `${stageId}:branches`)).toMatchObject({
      label: "Branches",
      badge: "virgin_curve",
    });
  });

  it("summarizes dense hysteresis point plans without rendering every point", () => {
    const snapshot = modelTreeSnapshotWithStageExecution(
      modelTreeSnapshotFromScene({
        objects: [],
        study: {
          stages: [
            {
              kind: "hysteresis",
              stage_id: "hysteresis-1",
              field_max_mT: 1000,
              field_min_mT: -1000,
              field_step_mT: 10,
              settle_pipeline: {
                kind: "sequence",
                steps: [
                  {
                    kind: "relax",
                    method: "llg_overdamped",
                    torque_tolerance: 1e-5,
                    max_steps: 10000,
                  },
                ],
              },
            },
          ],
        },
      }),
      {
        active_stage_index: 0,
        active_stage_kind: "hysteresis",
        completed_stage_indexes: [],
        revision: 14,
        runtime_state: "running",
        stage_statuses: ["running"],
        stages: [
          {
            index: 0,
            stage_id: "hysteresis-1",
            status: "running",
            current_field_mT: -250,
            current_point_index: 125,
            current_settle_step_index: 0,
            current_settle_step_kind: "relax",
            current_settle_step_method: "llg_overdamped",
          },
        ],
        total_stages: 1,
      } as never,
    );
    const flattened = flattenExplorerNodes(buildModelTree(snapshot));

    expect(
      flattened.filter(
        (node) =>
          node.id.includes(":field-point:") &&
          !node.id.includes(":algorithm:"),
      ),
    ).toHaveLength(1);
    expect(
      flattened.find(
        (node) => node.id === "model:study:stages:stage:hysteresis-1:points",
      ),
    ).toMatchObject({
      badge: "126/201",
      label: "Points",
      status: "running",
    });
    expect(
      flattened.find(
        (node) =>
          node.id ===
          "model:study:stages:stage:hysteresis-1:points:completed",
      ),
    ).toMatchObject({
      badge: "+1000 mT ... -240 mT, 125 points",
      label: "Completed Points",
      status: "completed",
    });
    expect(
      flattened.find(
        (node) =>
          node.id ===
          "model:study:stages:stage:hysteresis-1:points:queued",
      ),
    ).toMatchObject({
      badge: "-260 mT ... -1000 mT, 75 points",
      label: "Queued Points",
      status: "queued",
    });
    expect(
      flattened.find(
        (node) =>
          node.id ===
          "model:study:stages:stage:hysteresis-1:field-point:125",
      ),
    ).toMatchObject({
      badge: "-250 mT / point 126",
      label: "Current Field",
      status: "running",
    });
  });

  it("adds visible study stage transition nodes from runtime metadata", () => {
    const snapshot = modelTreeSnapshotWithStageExecution(
      modelTreeSnapshotFromScene({
        objects: [],
        study: {
          stages: [{ kind: "relax" }, { kind: "run" }],
        },
      }),
      {
        active_stage_index: 1,
        active_stage_kind: "run",
        completed_stage_indexes: [0],
        revision: 12,
        runtime_state: "running",
        stage_statuses: ["completed", "running"],
        stages: [
          { index: 0, stage_id: "runtime-relax", status: "completed" },
          {
            index: 1,
            stage_id: "runtime-run",
            status: "running",
            state_transition: "continues",
            state_transition_kind: "continue_in_place",
            state_transition_reason: "same_runtime_context",
            state_transition_ui_presentation: "smooth_arrow",
          },
        ],
        total_stages: 2,
      } as never,
    );
    const flattened = flattenExplorerNodes(buildModelTree(snapshot));

    expect(
      flattened.find(
        (node) =>
          node.id ===
          "model:study:stages:stage:runtime-run:state-transition",
      ),
    ).toMatchObject({
      label: "State Transition",
      badge: "continues",
      parentId: "model:study:stages:stage:runtime-run",
      status: "ready",
    });
  });

  it("gates response-map nodes with response Floquet support instead of demag-k support", () => {
    const manifest = {
      ...FREQUENCY_DOMAIN_MANIFEST,
      floquet_nonzero_k_demag_supported: false,
      floquet_nonzero_k_response_supported: true,
    } satisfies FrequencyDomainManifestResource;

    const results = flattenExplorerNodes(
      buildExplorerTree("results", {
        frequencyDomainManifest: manifest,
      }),
    );
    expect(
      results.find(
        (node) => node.id === "results:frequency-domain:dispersion",
      ),
    ).toBeUndefined();
    expect(
      results.find(
        (node) => node.id === "results:frequency-domain:response-map",
      ),
    ).toBeUndefined();

    const resources = flattenExplorerNodes(
      buildExplorerTree("resources", {
        frequencyDomainManifest: manifest,
      }),
    );
    expect(resources).toHaveLength(1);
    expect(resources[0]).toMatchObject({ id: "resources:root", status: "unavailable" });
  });

  it("does not fabricate a driven response map from k metadata and a response sweep", () => {
    const results = flattenExplorerNodes(
      buildExplorerTree("results", {
        currentRun: currentRun("run-response-map", 8),
        frequencyDomainDispersion: {
          ...FREQUENCY_DOMAIN_DISPERSION,
          path_metadata: {
            sampling: {
              kind: "path",
              points: [
                { k_vector: [0, 0, 0], label: "Γ" },
                { k_vector: [1e7, 0, 0], label: "X" },
              ],
              samples_per_segment: [8],
            },
          },
        },
        frequencyDomainManifest: {
          ...FREQUENCY_DOMAIN_MANIFEST,
          result_manifest: {
            payload: {
              equilibrium_identity: "equilibrium-r5",
              requested_execution: { boundary_context: "floquet_periodic" },
              revision: "response-map-r8",
              stage_id: "response-stage",
              stage_label: "Driven k sweep",
              study_product: "driven_response",
            },
            status: "ready",
          },
        } as FrequencyDomainManifestResource,
        frequencyDomainResponseSweep: FREQUENCY_DOMAIN_RESPONSE_SWEEP,
      }),
    );

    expect(results.some((node) => node.kind === "results.dispersion.driven.response_map")).toBe(false);
  });
  it("exposes study runtime and recovery commands through explorer context menus", () => {
    const flattened = flattenExplorerNodes(
      buildModelTree(
        modelTreeSnapshotFromScene({
          objects: [],
          study: {
            stages: [{ kind: "relax" }],
          },
        }),
      ),
    );

    expect(
      flattened.find((node) => node.id === "model:study:execution")
        ?.contextCommands,
    ).toEqual(
      expect.arrayContaining([
        "study.run",
        "study.pause",
        "study.resume",
        "study.stop",
        "study.skip",
        "study.compute-fields",
        "study.compute-energies",
      ]),
    );
    expect(
      flattened.find((node) => node.id === "model:study:recovery")
        ?.contextCommands,
    ).toEqual(
      expect.arrayContaining([
        "study.save-checkpoint",
        "study.restore-checkpoint",
        "study.import-state",
        "study.export-state",
        "study.discard-paused-state",
      ]),
    );
    expect(
      flattened.find((node) => node.id === "model:study:stages:stage:0")
        ?.contextCommands,
    ).toEqual(expect.arrayContaining(["study.skip"]));
  });

  it("shows editable 2D visualization drafts and committed plots", () => {
    const flattened = flattenExplorerNodes(
      buildModelTree({
        crossSections: {
          activePlotId: "plot-1",
          draft: {
            colorScale: "jet",
            filterExpression: "",
            frameExtent: "universe",
            id: "draft",
            includeWireframe: true,
            metric: "skewness",
            name: "Draft Cross-Section",
            plane: "xy",
            positionPercent: 50,
            rotationDegrees: 0,
            shrinkFactor: 1,
          },
          plots: [
            {
              colorScale: "viridis",
              filterExpression: "quality < 0.3",
              frameExtent: "universe",
              id: "plot-1",
              metric: "aspect_ratio",
              name: "Plot 1",
              plane: "xz",
              positionPercent: 25,
              rotationDegrees: 0,
              shrinkFactor: 0.8,
              wireframeVisible: true,
            },
          ],
        },
      }),
    );

    expect(
      flattened.find((node) => node.id === "model:visualizations-2d"),
    ).toMatchObject({
      badge: "1 plot",
      kind: "visualizations-2d.root",
      label: "Visualizations 2D",
    });
    expect(
      flattened.find((node) => node.id === "model:visualizations-2d:draft"),
    ).toMatchObject({
      badge: "XY 50% / skewness",
      kind: "visualizations-2d.draft",
      label: "Draft Cross-Section",
    });
    expect(
      flattened.find((node) => node.id === "model:visualizations-2d:plot-1"),
    ).toMatchObject({
      badge: "XZ 25% / aspect_ratio",
      kind: "visualizations-2d.plot",
      label: "Plot 1",
      status: "ready",
    });
    expect(
      flattened.find(
        (node) => node.id === "model:visualizations-2d:plot-1:frame",
      ),
    ).toMatchObject({
      badge: "Universe / 0 deg",
      kind: "visualizations-2d.parameter",
      label: "Frame",
    });
    expect(
      flattened.find(
        (node) => node.id === "model:visualizations-2d:plot-1:quality",
      ),
    ).toMatchObject({
      badge: "aspect_ratio / viridis",
      kind: "visualizations-2d.parameter",
      label: "Quality",
    });
    expect(
      flattened.find(
        (node) => node.id === "model:visualizations-2d:plot-1:render",
      ),
    ).toMatchObject({
      badge: "wireframe on / shrink 0.8 / quality < 0.3",
      kind: "visualizations-2d.parameter",
      label: "Render",
      status: "warning",
    });
  });

  it("shows an uncommitted planar monitor draft under Definitions/Planar Monitors", () => {
    const flattened = flattenExplorerNodes(
      buildModelTree(
        modelTreeSnapshotFromScene({ objects: [] }),
        {
          planarMonitorDraft: {
            frameExtent: "universe",
            id: "draft",
            name: "Midplane",
            plane: "xy",
            positionPercent: 50,
            rotationDegrees: 0,
          },
          planarMonitors: null,
        },
      ),
    );

    expect(
      flattened.find(
        (node) => node.id === "model:definitions:planar-monitors:draft",
      ),
    ).toMatchObject({
      kind: "model.planar.monitor.draft",
      label: "Midplane",
      parentId: "model:definitions:planar-monitors",
      status: "queued",
    });
  });

  it("merges stage execution by stage id before falling back to index", () => {
    const sceneSnapshot = modelTreeSnapshotFromScene({
      objects: [],
      study: {
        stages: [
          { kind: "relax", stage_id: "relax-main" },
          { kind: "run", stage_id: "run-main" },
        ],
      },
    });

    const snapshot = modelTreeSnapshotWithStageExecution(sceneSnapshot, {
      active_stage_index: null,
      active_stage_kind: null,
      completed_stage_indexes: [1],
      revision: 9,
      runtime_state: "completed",
      stage_statuses: ["running", "completed"],
      stages: [
        { index: 1, stage_id: "run-main", status: "completed" },
        { index: 0, stage_id: "relax-main", status: "running" },
      ],
      total_stages: 2,
    } as never);

    const flattened = flattenExplorerNodes(buildModelTree(snapshot));

    expect(
      flattened.find(
        (node) => node.id === "model:study:stages:stage:relax-main",
      ),
    ).toMatchObject({ label: "Relax 1", status: "running" });
    expect(
      flattened.find(
        (node) => node.id === "model:study:stages:stage:run-main",
      ),
    ).toMatchObject({ label: "Run 2", status: "completed" });
  });

  it("does not synthesize legacy electrical families when physics graph status is omitted", () => {
    const nodes = flattenExplorerNodes(buildModelTree());

    expect(nodes.filter((node) => [
      "physics.current-transports",
      "physics.spin-transports",
      "physics.spin-interfaces",
      "physics.spin-torques",
      "physics.oersted-fields",
      "physics.module",
    ].includes(node.kind))).toHaveLength(0);
    expect(nodes.find((node) => node.kind === "physics.scope.unresolved")).toMatchObject({
      id: "model:physics:unresolved",
      status: "unavailable",
    });
  });

  it("keeps an authored zero-current graph module visible as inactive", () => {
    const nodes = flattenExplorerNodes(buildModelTree({
      physicsGraph: {
        edges: [],
        modules: [{
          activation: "inactive",
          applies_to: [{ kind: "global" }],
          capability: "semantic_only",
          family_payload: { current_density: [0, 0, 0] },
          id: "current:zero",
          kind: "current_transport",
          presentation: { family: "current_density", label: "Zero current density" },
        }],
        schema_version: "physics_graph.v1",
      },
      physicsGraphStatus: "ready",
    }));

    expect(nodes.find((node) => node.physicsModuleId === "current:zero")).toMatchObject({
      badge: "inactive · semantic_only",
      label: "Zero current density",
      physicsActivation: "inactive",
      status: "degraded",
    });
  });

  it("requires an explicit ready status before an empty physics graph is authoritative", () => {
    const nodes = flattenExplorerNodes(buildModelTree({
      physicsGraph: {
        edges: [],
        modules: [],
        provenance: { normalizer: "physics_graph.v1" },
        schema_version: "physics_graph.v1",
        scene_revision: 3,
      },
    }));

    expect(nodes.map((node) => node.kind)).not.toEqual(expect.arrayContaining([
      "physics.current-transports",
      "physics.spin-transports",
    ]));
    expect(nodes.find((node) => node.kind === "physics.scope.unresolved")).toMatchObject({
      status: "unavailable",
    });
  });

  it.each([
    ["idle", "unavailable"],
    ["loading", "queued"],
    ["stale", "stale"],
    ["error", "failed"],
  ] as const)(
    "fails closed to one diagnostic node while the physics graph is %s",
    (physicsGraphStatus, diagnosticStatus) => {
      const nodes = flattenExplorerNodes(buildModelTree({
        physicsGraph: null,
        physicsGraphStatus,
      }));

      expect(nodes.filter((node) => [
        "physics.current-transports",
        "physics.spin-transports",
        "physics.spin-interfaces",
        "physics.spin-torques",
        "physics.oersted-fields",
      ].includes(node.kind))).toHaveLength(0);
      expect(nodes.filter((node) => node.kind === "physics.scope.unresolved")).toEqual([
        expect.objectContaining({
          id: "model:physics:unresolved",
          selectable: false,
          status: diagnosticStatus,
        }),
      ]);
    },
  );

  it("does not retain object-scoped graph nodes while a stale graph resource is shown", () => {
    const nodes = flattenExplorerNodes(buildModelTree({
      objects: [{ id: "film", label: "Film", objectRole: "magnet" }],
      physicsGraph: {
        schema_version: "physics_graph.v1",
        modules: [{
          id: "current:film",
          kind: "current_transport",
          applies_to: [{ kind: "object", object_id: "film" }],
          depends_on: [],
          activation: "active",
          capability: "semantic_only",
        }],
        edges: [],
      },
      physicsGraphStatus: "stale",
    }));

    expect(nodes.filter((node) => [
      "object.physics.scope",
      "physics.module",
    ].includes(node.kind))).toHaveLength(0);
    expect(nodes.filter((node) => node.kind === "physics.scope.unresolved")).toEqual([
      expect.objectContaining({
        id: "model:physics:unresolved",
        selectable: false,
        status: "stale",
      }),
    ]);
  });

  it("keeps a ready empty physics graph authoritative when the resource status is explicit", () => {
    const nodes = flattenExplorerNodes(buildModelTree({
      physicsGraph: {
        edges: [],
        modules: [],
        schema_version: "physics_graph.v1",
      },
      physicsGraphStatus: "ready",
    }));

    expect(nodes.map((node) => node.kind)).not.toEqual(expect.arrayContaining([
      "physics.current-transports",
      "physics.scope.unresolved",
    ]));
  });

  it("builds one shared Mesh summary with FDM structured-grid details", () => {
    const nodes = flattenExplorerNodes(
      buildModelTree({ domainPresentation: fdmExplorerPresentation() }),
    );
    expect(nodes.find((node) => node.id === "model:mesh")).toMatchObject({
      kind: "mesh.root",
      label: "Mesh",
    });
    expect(nodes.map((node) => node.kind)).toEqual(
      expect.not.arrayContaining(["mesh.unassigned", "boundary-faces.root"]),
    );
    expect(nodes.map((node) => node.kind)).toEqual(expect.arrayContaining([
      "mesh.shared-domain", "mesh.builds", "mesh.quality", "mesh.size-fields",
      "mesh.regions",
    ]));
    expect(nodes.map((node) => node.id)).toEqual(expect.arrayContaining([
      "model:mesh:grid", "model:mesh:magnetic-support", "model:mesh:active-unassigned",
      "model:mesh:mask", "model:mesh:provenance", "model:mesh:region:region%3Acore",
    ]));
    expect(nodes.find((node) => node.id === "model:mesh")?.contextCommands).toEqual([
      "workspace.focus-selection",
    ]);
    for (const nodeId of [
      "model:mesh:builds",
      "model:mesh:quality",
      "model:mesh:size-fields",
      "model:mesh:regions",
    ]) {
      expect(nodes.find((node) => node.id === nodeId)).toMatchObject({
        selectable: false,
      });
    }
    expect(nodes.find((node) => node.id === "model:mesh:magnetic-support")?.label).toBe(
      "Magnetic Support",
    );
  });

  it("withholds FEM nodes during SSR hydration until an FDM lane is explicit", () => {
    const hydratedFromServer = flattenExplorerNodes(
      buildModelTree({ domainPresentationStatus: "loading" }),
    );
    const hydratedFdm = flattenExplorerNodes(
      buildModelTree({ domainPresentation: fdmExplorerPresentation() }),
    );
    const femOnlyKinds = ["mesh.unassigned", "boundary-faces.root"];

    expect(hydratedFromServer.find((node) => node.id === "model:mesh")).toMatchObject({
      kind: "mesh.root",
      label: "Mesh",
      badge: "lane loading",
      status: "queued",
    });
    for (const nodes of [hydratedFromServer, hydratedFdm]) {
      expect(nodes.map((node) => node.kind)).not.toEqual(expect.arrayContaining(femOnlyKinds));
    }
  });

  it("keeps a degraded FDM tree when DomainMeta presentation construction fails", () => {
    const nodes = flattenExplorerNodes(buildModelTree({
      domainDiscretization: "fdm",
      domainMeta: {
        bounds: { min: [0, 0, 0], max: [2, 2, 2] }, coordinate_system: "cartesian",
        counts: { cells: 8 }, dimension: 3, discretization: "fdm", domain_id: "domain:fdm",
        generation_id: "generation-8", grid: { origin: [0, 0, 0], shape: [2, 2, 2], spacing: [1, 1, 1] }, units: { length: "m" },
      },
      domainPresentation: null,
      domainPresentationStatus: "error",
    }));
    expect(nodes.find((node) => node.id === "model:mesh")).toMatchObject({
      kind: "mesh.root", status: "degraded", contextCommands: ["workspace.focus-selection"],
    });
    expect(nodes.map((node) => node.kind)).not.toEqual(expect.arrayContaining([
      "mesh.unassigned", "airbox.root", "boundary-faces.root",
    ]));
  });

  it("keeps the three shared mesh positions for both FEM and FDM", () => {
    const fdmPresentation: FdmDomainPresentation = {
      ...(fdmExplorerPresentation() as FdmDomainPresentation),
      universeOutsideMagneticSupport: {
        bounds: { min: [0, 0, 0] as const, max: [8, 4, 2] as const },
        kind: "universe-outside-magnetic-support" as const,
        reason: "explicit fixture extent",
      },
    };
    const fdmNodes = flattenExplorerNodes(buildModelTree({
      domainPresentation: fdmPresentation,
      objects: [{
        id: "film",
        label: "Film",
        regions: [{ id: "core", label: "Core" }],
      } as never],
    }));
    const femNodes = flattenExplorerNodes(buildModelTree({
      airbox: { authoredPolicy: true, realizedCarrier: false },
      domainDiscretization: "fem",
      objects: [{
        id: "film",
        label: "Film",
        regions: [{ id: "core", label: "Core" }],
      } as never],
    }));

    for (const nodes of [fdmNodes, femNodes]) {
      const meshRoot = nodes.find((node) => node.id === "model:mesh");
      expect(meshRoot).toMatchObject({
        kind: "mesh.root",
        label: "Mesh",
        parentId: "model:session",
      });
      expect(meshRoot?.children?.map(({ id, kind, label, parentId }) => ({
        id,
        kind,
        label,
        parentId,
      }))).toEqual([
        {
          id: "model:mesh:shared-domain",
          kind: "mesh.shared-domain",
          label: "Domain Mesh",
          parentId: "model:mesh",
        },
        {
          id: "model:mesh:builds",
          kind: "mesh.builds",
          label: "Build Pipeline",
          parentId: "model:mesh",
        },
        {
          id: "model:mesh:quality",
          kind: "mesh.quality",
          label: "Quality Gates",
          parentId: "model:mesh",
        },
        {
          id: "model:mesh:size-fields",
          kind: "mesh.size-fields",
          label: "Realized Size Fields",
          parentId: "model:mesh",
        },
        {
          id: "model:mesh:regions",
          kind: "mesh.regions",
          label: "Regions And Mesh Parts",
          parentId: "model:mesh",
        },
      ]);
      expect(nodes.find((node) => node.id === "model:object:film:mesh")).toMatchObject({
        kind: "object.mesh",
        label: "Mesh",
        parentId: "model:object:film",
      });
      expect(nodes.find((node) => node.id === "model:object:film:regions:core:mesh")).toMatchObject({
        kind: "object.region.mesh",
        label: "Mesh",
        parentId: "model:object:film:regions:core",
      });
      expect(nodes.find((node) => node.id === "model:airbox:mesh")).toMatchObject({
        kind: "airbox.mesh",
        label: "Mesh",
        parentId: "model:airbox",
      });
    }
  });

  it("adds the shared Airbox subtree for an explicit FDM universe", () => {
    const withUniverse: FdmDomainPresentation = {
      ...(fdmExplorerPresentation() as FdmDomainPresentation),
      universeOutsideMagneticSupport: {
        bounds: { min: [0, 0, 0] as const, max: [8, 4, 2] as const },
        kind: "universe-outside-magnetic-support" as const,
        reason: "explicit fixture extent",
      },
    };
    const nodes = flattenExplorerNodes(buildModelTree({ domainPresentation: withUniverse }));
    expect(nodes.find((node) => node.id === "model:airbox")).toMatchObject({
      kind: "airbox.root", label: "Airbox", parentId: "model:universe",
    });
    expect(nodes.find((node) => node.id === "model:airbox:mesh")).toMatchObject({
      kind: "airbox.mesh", label: "Mesh", parentId: "model:airbox",
    });
    expect(nodes.map((node) => node.id)).toEqual(expect.arrayContaining([
      "model:airbox:mesh:parameters",
      "model:airbox:mesh:quality-gates",
      "model:airbox:mesh:statistics",
      "model:airbox:mesh:topology",
      "model:airbox:mesh:build",
    ]));
    expect(nodes.find((node) => node.id === "model:airbox:visualization")).toMatchObject({
      kind: "airbox.visualization",
      label: "Visualization", parentId: "model:airbox",
      visualizationTargetId: "fdm-universe-outside-support",
    });
    expect(
      nodes.filter((node) => node.id === "model:airbox:visualization"),
    ).toHaveLength(1);
    expect(nodes.find((node) => node.id === "model:universe:grid")).toBeUndefined();
  });

  it("adds a separate target-only multilayer Airbox leaf without reusing the common FFT grid", () => {
    const withUniverse: FdmDomainPresentation = {
      ...(fdmExplorerPresentation() as FdmDomainPresentation),
      universeOutsideMagneticSupport: {
        bounds: { min: [0, 0, 0] as const, max: [8, 4, 2] as const },
        kind: "universe-outside-magnetic-support" as const,
        reason: "explicit fixture extent",
      },
    };
    const layout = {
      airbox: {
        carrier_available: true,
        carrier_fingerprint: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        cell_size_m: [3e-9, 5e-9, 7e-9],
        cells: [11, 13, 17],
        h_demag_available: true,
        h_eff_available: false,
        h_eff_unavailable_reason: "airbox_heff_not_available_v1",
        origin_m: [-2e-9, -4e-9, -6e-9],
        sample_count: 2431,
        source_grid_fingerprints: ["sha256:native-a", "sha256:native-b"],
        source_policy: "target_only",
        target_only: true,
        value_count: 7293,
      },
      available: true,
      backend: "fdm_multilayer",
      common_transform_layout: {
        cell_size: [101, 103, 107],
        fft_shape: [109, 113, 127],
        is_physical_mesh: false,
        origin: [131, 137, 139],
        provenance: "fft-scratch-only",
        shape: [149, 151, 157],
      },
      domain_generation_id: "generation-airbox-target",
      execution_revision: 3,
      layers: [],
      layout_revision: 5,
      observation_revision: 7,
      schema_version: "fdm-multilayer-layout.v1",
    } satisfies FdmMultilayerLayoutResource;

    const nodes = flattenExplorerNodes(buildModelTree({
      domainPresentation: withUniverse,
      fdmMultilayerLayout: layout,
      fdmMultilayerLayoutStatus: "ready",
    }));

    expect(nodes.filter((node) => node.kind === "airbox.multilayer.target")).toEqual([
      expect.objectContaining({
        id: "model:airbox:multilayer-target",
        parentId: "model:airbox",
        visualizationTargetId: "airbox",
        nativeGrid: [11, 13, 17],
        nativeCellSize: [3e-9, 5e-9, 7e-9],
        nativeOrigin: [-2e-9, -4e-9, -6e-9],
        gridFingerprint: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      }),
    ]);
    expect(nodes.find((node) => node.id === "model:airbox:multilayer-target")).not.toMatchObject({
      nativeGrid: layout.common_transform_layout?.shape,
      nativeCellSize: layout.common_transform_layout?.cell_size,
      nativeOrigin: layout.common_transform_layout?.origin,
    });
  });

  it("withholds the multilayer target Airbox leaf when the published carrier is incomplete", () => {
    const withUniverse: FdmDomainPresentation = {
      ...(fdmExplorerPresentation() as FdmDomainPresentation),
      universeOutsideMagneticSupport: {
        bounds: { min: [0, 0, 0] as const, max: [8, 4, 2] as const },
        kind: "universe-outside-magnetic-support" as const,
        reason: "explicit fixture extent",
      },
    };
    const nodes = flattenExplorerNodes(buildModelTree({
      domainPresentation: withUniverse,
      fdmMultilayerLayout: {
        airbox: {
          carrier_available: true,
          h_demag_available: true,
          h_eff_available: false,
          target_only: true,
        },
        available: true,
        backend: "fdm_multilayer",
        domain_generation_id: "generation-airbox-target",
        execution_revision: 3,
        layers: [],
        layout_revision: 5,
        observation_revision: 7,
        schema_version: "fdm-multilayer-layout.v1",
      },
    }));

    expect(nodes.map((node) => node.kind)).not.toContain("airbox.multilayer.target");
    expect(nodes.find((node) => node.id === "model:airbox")?.visualizationTargetId).toBe(
      "fdm-universe-outside-support",
    );
  });

  it("keeps the FDM Airbox visible from authored geometry before membership materializes", () => {
    const domainMeta: DomainMetaResource = {
      bounds: { min: [0, 0, 0], max: [4, 2, 1] },
      coordinate_system: "cartesian",
      counts: { cells: 8 },
      dimension: 3,
      discretization: "fdm",
      domain_id: "domain:fdm",
      generation_id: "generation-authored",
      grid: { origin: [0, 0, 0], shape: [2, 2, 2], spacing: [2, 1, 0.5] },
      units: { length: "m" },
    };
    const presentation = buildDomainPresentation({
      domainMeta,
      fdmMembership: null,
      fdmMembershipStatus: "ready",
      universeOutsideMagneticSupport: {
        bounds: { min: [0, 0, 0], max: [4, 2, 1] },
        reason: "authored-universe-exceeds-magnetic-support",
      },
    });
    const nodes = flattenExplorerNodes(buildModelTree({ domainPresentation: presentation }));

    expect(nodes.find((node) => node.id === "model:airbox")).toMatchObject({
      kind: "airbox.root",
      label: "Airbox",
      status: "mesh-stale",
    });
    expect(nodes.find((node) => node.id === "model:mesh")).toMatchObject({
      kind: "mesh.root",
      label: "Mesh",
      status: "mesh-stale",
    });
    expect(nodes.find((node) => node.id === "model:airbox:visualization")).toMatchObject({
      kind: "airbox.visualization",
      visualizationTargetId: "fdm-universe-outside-support",
    });
  });

  it("qualifies duplicate FDM region nodes by owner without changing unambiguous ids", () => {
    const base = fdmExplorerPresentation() as FdmDomainPresentation;
    const membership = base.fdmGrid.membership;
    expect(membership).not.toBeNull();
    const duplicateMembership = {
      ...membership!,
      region_legend: [
        ...membership!.region_legend,
        {
          ...membership!.region_legend[0],
          numeric_id: membership!.region_legend[0].numeric_id + 1,
          object_id: "object:other",
          region_id: membership!.region_legend[0].region_id,
        },
      ],
    };
    const presentation: FdmDomainPresentation = {
      ...base,
      fdmGrid: {
        ...base.fdmGrid,
        membership: duplicateMembership,
      },
    };
    const nodes = flattenExplorerNodes(buildModelTree({ domainPresentation: presentation }));
    const regionNodes = nodes.filter((node) => node.kind === "mesh.grid.region");

    expect(regionNodes.map((node) => node.id)).toEqual([
      "model:mesh:region:object%3Acore:region%3Acore",
      "model:mesh:region:object%3Aother:region%3Acore",
    ]);
    expect(regionNodes.map((node) => node.objectId)).toEqual([
      "object:core",
      "object:other",
    ]);
    expect(regionNodes.every((node) => node.parentId === "model:mesh:regions")).toBe(true);
  });

  it("canonicalizes FDM geometry aliases in region mesh nodes", () => {
    const base = fdmExplorerPresentation() as FdmDomainPresentation;
    const membership = base.fdmGrid.membership;
    expect(membership).not.toBeNull();
    const presentation: FdmDomainPresentation = {
      ...base,
      fdmGrid: {
        ...base.fdmGrid,
        membership: {
          ...membership!,
          region_legend: membership!.region_legend.map((entry) => ({
            ...entry,
            object_id: "film_geom",
          })),
        },
      },
    };
    const nodes = flattenExplorerNodes(buildModelTree({
      domainPresentation: presentation,
      objects: [{ id: "film", label: "Film" }] as never,
    }));
    const regionNode = nodes.find((node) => node.kind === "mesh.grid.region");

    expect(regionNode).toMatchObject({
      id: "model:mesh:region:region%3Acore",
      objectId: "film",
    });
  });

  it("keeps object visualization diagnostics available in an FDM model tree", () => {
    const nodes = flattenExplorerNodes(
      buildModelTree({
        domainPresentation: fdmExplorerPresentation(),
        objects: [
          {
            id: "film",
            label: "Film",
            regions: [
              {
                id: "core",
                label: "Core",
              },
            ],
          } as never,
        ] as never,
      }),
    );
    for (const kind of [
      "object.visualization.debug",
      "object.region.visualization.debug",
    ]) {
      expect(nodes.map((node) => node.kind)).toContain(kind);
    }
    expect(nodes.map((node) => node.kind)).not.toContain("airbox.visualization.debug");
  });
});
