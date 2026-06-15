import { describe, expect, it } from "vitest";

import type {
  FrequencyDomainManifestResource,
  FrequencyDomainSweepProgressResource,
  HysteresisExecutionTreeResource,
  SceneResource,
} from "@/kernel/api/apiTypes";
import {
  ANALYSIS_EIGEN_MODE_V2_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_EIGEN_BRANCHES_V2_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_EIGEN_DIAGNOSTICS_V2_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_EIGEN_DISPERSION_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_EIGEN_MODE_FIELD_META_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_DIAGNOSTICS_V1_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_FIELD_META_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_FREQUENCY_POINT_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_CANCEL_REQUESTED_V1_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_PROGRESS_V1_PATH,
  ANALYSIS_HYSTERESIS_POINT_PATH,
  DATA_FIELD_VECTOR_PATH,
  MESHING_PERIODIC_PAIRS_PATH,
} from "@/kernel/api/apiPaths";

import {
  buildExplorerTree,
  buildModelTree,
  flattenExplorerNodes,
} from "./buildModelTree";
import {
  modelTreeSnapshotFromScene,
  modelTreeSnapshotWithStageExecution,
} from "./sceneModelTreeAdapter";

const TORQUE_TOLERANCE_FOR_1E_4_T = 1e-4 / (4 * Math.PI * 1e-7);

const capability = (status: string, reason = "test fixture") => ({ status, reason });

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

const FREQUENCY_DOMAIN_BRANCHES = {
  artifact_path: "eigen/branches.v2.json",
  missing_reason: null,
  payload: {
    branches: [
      {
        branch_id: "branch-0",
        label: "acoustic",
        points: [
          {
            frequency_imag_hz: -1.2e7,
            frequency_real_hz: 12.5e9,
            overlap_prev: null,
            raw_mode_index: 2,
            sample_index: 0,
            tracking_confidence: 1,
          },
          {
            frequency_imag_hz: -1.4e7,
            frequency_real_hz: 13.1e9,
            overlap_prev: 0.97,
            raw_mode_index: 1,
            sample_index: 1,
            tracking_confidence: 0.98,
          },
        ],
      },
    ],
    schema_version: "eigen_branches.v2",
    solver_model: "linearized_llg_reference",
  },
  resource_key: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_BRANCHES_V2_PATH,
  schema_version: "frequency_domain_eigen_branches.v2",
  status: "ready",
} as const;

const FREQUENCY_DOMAIN_DISPERSION = {
  artifact_path: "eigen/dispersion/branch_table.csv",
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
  current_frequency_hz: null,
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
  it("builds a typed model tree from a scene snapshot without storing API data", () => {
    const nodes = buildModelTree({
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
        "model:airbox:mesh",
        "model:airbox:visualization",
        "model:mesh",
        "model:mesh:airbox-quality",
        "model:study",
      ]),
    );
    expect(
      flattened.find((node) => node.id === "model:object:free-layer:mesh")
        ?.status,
    ).toBe("stale");
    expect(
      flattened.find((node) => node.id === "model:mesh:airbox-quality"),
    ).toMatchObject({
      kind: "airbox.mesh-quality",
      label: "Airbox Quality",
      parentId: "model:mesh",
    });
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

  it("labels the shared-domain mesh node from mesh build freshness", () => {
    const flattened = flattenExplorerNodes(
      buildModelTree({
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
      },
    );

    const flattened = flattenExplorerNodes(buildModelTree(snapshot));

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
            kind: "eigenmodes",
            stage_id: "eigen-1",
          },
          {
            kind: "frequency_response",
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

  it("builds frequency-domain result, resource, job, and diagnostic trees from the manifest", () => {
    const results = flattenExplorerNodes(
      buildExplorerTree("results", {
        frequencyDomainBranches: FREQUENCY_DOMAIN_BRANCHES,
        frequencyDomainDispersion: FREQUENCY_DOMAIN_DISPERSION,
        frequencyDomainManifest: FREQUENCY_DOMAIN_MANIFEST,
        frequencyDomainResponseSweep: FREQUENCY_DOMAIN_RESPONSE_SWEEP,
        frequencyDomainSpectrum: FREQUENCY_DOMAIN_SPECTRUM,
      }),
    );
    expect(results.map((node) => node.id)).toEqual(
      expect.arrayContaining([
        "results:frequency-domain",
        "results:frequency-domain:run",
        "results:frequency-domain:fmr",
        "results:frequency-domain:fmr:modal-spectrum",
        "results:frequency-domain:fmr:response-sweep",
        "results:frequency-domain:dispersion",
        "results:eigen:k-path",
        "results:eigen",
        "results:eigen:spectrum",
        "results:eigen:branches",
        "results:eigen:branches:branch:branch-0",
        "results:eigen:sample:0:mode:2",
        "results:eigen:dispersion",
        "results:frequency-response",
        "results:frequency-response:sweep",
        "results:frequency-response:frequency-points",
        "results:frequency-response:frequency-points:0",
        "results:frequency-response:frequency-points:1",
        "results:frequency-response:observables",
        "results:frequency-response:observables:mx",
        "results:frequency-response:observables:my",
      ]),
    );
    expect(results.map((node) => node.id)).not.toContain(
      "results:frequency-domain:response-map",
    );
    expect(results.map((node) => node.id)).not.toContain(
      "results:frequency-response:cancel-requested",
    );
    expect(
      results.find((node) => node.id === "results:frequency-domain"),
    ).toMatchObject({
      badge: "frequency_domain_manifest.v1",
      kind: "results.frequency_domain.root",
      status: "ready",
    });
    expect(
      results.find((node) => node.id === "results:frequency-domain:run"),
    ).toMatchObject({
      badge: "manifest",
      kind: "results.frequency_domain.run",
      resourceRef: ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
      status: "ready",
    });
    expect(
      results.find(
        (node) => node.id === "results:frequency-domain:dispersion",
      ),
    ).toMatchObject({
      badge: "2 point(s)",
      kind: "results.frequency_domain.dispersion",
      status: "ready",
    });
    expect(
      results.find((node) => node.id === "results:eigen:k-path"),
    ).toMatchObject({
      badge: "2 k sample(s)",
      kind: "results.eigen.k_path",
      resourceRef: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_DISPERSION_PATH,
      status: "ready",
    });
    expect(
      results.find((node) => node.id === "results:frequency-domain:fmr:peaks"),
    ).toMatchObject({
      artifactPath: "response/magnetic_response_sweep.v2.json",
      badge: "4 peak(s)",
      children: expect.any(Array),
      calculationMode: "fmr_response",
      kind: "results.frequency_domain.fmr_peaks",
      resourceRef: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
      status: "ready",
    });
    expect(
      results.find(
        (node) => node.id === "results:frequency-domain:fmr:peaks:peak:0",
      ),
    ).toMatchObject({
      artifactPath: "response/magnetic_response_sweep.v2.json",
      badge: "9.5 GHz",
      calculationMode: "fmr_response",
      fieldId: undefined,
      fmrPeakIndex: 0,
      frequencyIndex: 0,
      kind: "results.frequency_domain.fmr_peak",
      label: "Driven Peak 1",
      parentId: "results:frequency-domain:fmr:peaks",
      resourceRef: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
      status: "ready",
    });
    expect(
      results.find(
        (node) => node.id === "results:frequency-domain:fmr:peaks:peak:2",
      ),
    ).toMatchObject({
      artifactPath: "eigen/spectrum.v2.json",
      badge: "12.5 GHz",
      calculationMode: "fmr_modal",
      contextCommands: [
        "analysis.eigen.plot-mode-3d",
        "analysis.eigen.plot-mode-3d-real",
        "analysis.eigen.plot-mode-3d-imag",
        "analysis.eigen.plot-mode-3d-amplitude",
        "analysis.eigen.plot-mode-3d-abs",
        "analysis.eigen.plot-mode-3d-phase",
        "analysis.eigen.plot-mode-3d-phase-rotated-real",
        "analysis.eigen.set-mode-3d-animation",
      ],
      fieldId: "analysis:eigen:sample-0000:mode-0002",
      fmrPeakIndex: 2,
      kind: "results.frequency_domain.fmr_peak",
      label: "Modal Peak 3",
      modeIndex: 2,
      parentId: "results:frequency-domain:fmr:peaks",
      resourceRef: analysisFieldVectorResourceKey(
        "analysis:eigen:sample-0000:mode-0002",
      ),
      sampleIndex: 0,
      status: "ready",
    });
    expect(
      results.find(
        (node) => node.id === "results:frequency-domain:fmr:modal-spectrum",
      ),
    ).toMatchObject({
      artifactPath: "eigen/spectrum.v2.json",
      badge: "2 mode(s)",
      calculationMode: "fmr_modal",
      kind: "results.frequency_domain.fmr_modal_spectrum",
      resourceRef: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH,
      status: "ready",
    });
    expect(
      results.find(
        (node) => node.id === "results:frequency-domain:calculation-modes",
      ),
    ).toMatchObject({
      badge: "FMR + dispersion",
      kind: "results.frequency_domain.calculation_modes",
      resourceRef: ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
      status: "ready",
    });
    expect(
      results.find(
        (node) =>
          node.id === "results:frequency-domain:calculation-modes:fmr",
      ),
    ).toMatchObject({
      badge: "modal + driven",
      calculationMode: "fmr_response",
      kind: "results.frequency_domain.fmr",
      status: "ready",
    });
    expect(
      results.find(
        (node) =>
          node.id ===
          "results:frequency-domain:calculation-modes:response-map",
      ),
    ).toMatchObject({
      badge: "unsupported",
      calculationMode: "response_map",
      kind: "results.frequency_domain.response_map",
      status: "unsupported",
    });
    expect(
      results.find(
        (node) => node.id === "results:frequency-domain:fmr:response-sweep",
      ),
    ).toMatchObject({
      artifactPath: "response/magnetic_response_sweep.v2.json",
      badge: "3 point(s)",
      calculationMode: "fmr_response",
      kind: "results.frequency_domain.fmr_response_sweep",
      resourceRef: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
      status: "ready",
    });
    expect(
      results.find((node) => node.id === "results:frequency-response:sweep"),
    ).toMatchObject({
      badge: "3 point(s)",
      kind: "results.frequency_response.sweep",
      status: "ready",
    });
    expect(
      results.find((node) => node.id === "results:eigen:dispersion"),
    ).toMatchObject({
      badge: "2 point(s)",
      kind: "results.eigen.dispersion",
      resourceRef: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_DISPERSION_PATH,
      status: "ready",
    });
    expect(
      results.find((node) => node.id === "results:eigen:modes"),
    ).toMatchObject({
      badge: "2 listed",
      status: "ready",
    });
    expect(
      results.find((node) => node.id === "results:eigen:modes:visualization"),
    ).toMatchObject({
      badge: "1 mode field(s)",
      contextCommands: [
        "analysis.eigen.plot-mode-3d",
        "analysis.eigen.plot-mode-3d-real",
        "analysis.eigen.plot-mode-3d-imag",
        "analysis.eigen.plot-mode-3d-amplitude",
        "analysis.eigen.plot-mode-3d-abs",
        "analysis.eigen.plot-mode-3d-phase",
        "analysis.eigen.plot-mode-3d-phase-rotated-real",
        "analysis.eigen.set-mode-3d-animation",
      ],
      fieldId: "analysis:eigen:sample-0000:mode-0002",
      kind: "results.eigen.modes.visualization",
      parentId: "results:eigen:modes",
      resourceRef: analysisFieldVectorResourceKey(
        "analysis:eigen:sample-0000:mode-0002",
      ),
      status: "ready",
    });
    expect(
      results.find((node) => node.id === "results:eigen:sample:0:mode:2"),
    ).toMatchObject({
      badge: "12.5 GHz",
      branchId: "branch-0",
      contextCommands: [
        "analysis.eigen.plot-mode-3d",
        "analysis.eigen.plot-mode-3d-real",
        "analysis.eigen.plot-mode-3d-imag",
        "analysis.eigen.plot-mode-3d-amplitude",
        "analysis.eigen.plot-mode-3d-abs",
        "analysis.eigen.plot-mode-3d-phase",
        "analysis.eigen.plot-mode-3d-phase-rotated-real",
        "analysis.eigen.set-mode-3d-animation",
      ],
      fieldId: "analysis:eigen:sample-0000:mode-0002",
      kind: "results.eigen.mode",
      modeIndex: 2,
      resourceRef: analysisFieldVectorResourceKey(
        "analysis:eigen:sample-0000:mode-0002",
      ),
      sampleIndex: 0,
      status: "ready",
    });
    expect(
      results.find((node) => node.id === "results:eigen:sample:0:mode:3"),
    ).toMatchObject({
      badge: "14.25 GHz",
      contextCommands: undefined,
      fieldId: undefined,
      kind: "results.eigen.mode",
      modeIndex: 3,
      resourceRef: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH,
      sampleIndex: 0,
      status: "stale",
    });
    expect(
      results.find(
        (node) => node.id === "results:eigen:sample:0:mode:2:visualization",
      ),
    ).toBeUndefined();
    expect(
      results.find((node) => node.id === "results:eigen:branches"),
    ).toMatchObject({
      badge: "1 tracked",
      kind: "results.eigen.branches",
      resourceRef: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_BRANCHES_V2_PATH,
      status: "ready",
    });
    expect(
      results.find((node) => node.id === "results:eigen:branches:branch:branch-0"),
    ).toMatchObject({
      badge: "12.5 GHz-13.1 GHz",
      branchId: "branch-0",
      calculationMode: "dispersion_modal",
      kind: "results.eigen.branch",
      label: "acoustic",
      resourceRef: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_BRANCHES_V2_PATH,
      status: "ready",
    });
    expect(
      results.find(
        (node) => node.id === "results:frequency-response:frequency-points",
      ),
    ).toMatchObject({
      badge: "2 listed",
      kind: "results.frequency_response.frequency_points",
      status: "ready",
    });
    expect(
      results.find(
        (node) => node.id === "results:frequency-response:frequency-points:0",
      ),
    ).toMatchObject({
      badge: "9.5 GHz, 2 observable(s)",
      contextCommands: undefined,
      fieldId: undefined,
      frequencyIndex: 0,
      kind: "results.frequency_response.frequency_point",
      resourceRef: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
      status: "stale",
    });
    expect(
      results.find(
        (node) => node.id === "results:frequency-response:observables",
      ),
    ).toMatchObject({
      badge: "2 observable(s)",
      kind: "results.frequency_response.observables",
      status: "ready",
    });
    expect(
      results.find(
        (node) => node.id === "results:frequency-response:observables:mx",
      ),
    ).toMatchObject({
      badge: "2 point(s)",
      kind: "results.frequency_response.observable",
      label: "mx",
      observableId: "mx",
      resourceRef: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
      status: "ready",
    });

    const responseResults = flattenExplorerNodes(
      buildExplorerTree("results", {
        frequencyDomainManifest: {
          ...FREQUENCY_DOMAIN_MANIFEST,
          response_progress: {
            complete: false,
            completed_frequency_points: 2,
            current_frequency_hz: 2.0e9,
            latest_artifact_manifest_path: "response/artifact_manifest.json",
            missing_reason: null,
            partial_artifacts_available: true,
            schema_version: "frequency_domain_sweep_progress.v1",
            state: "running",
            status: "ready",
            total_frequency_points: 4,
            written_frequency_point_artifacts: 2,
          },
          response_cancel_requested: {
            complete: false,
            completed_frequency_points: 1,
            current_frequency_hz: 1.0e9,
            latest_artifact_manifest_path: "response/artifact_manifest.json",
            missing_reason: null,
            partial_artifacts_available: true,
            progress_json:
              '{"schema_version":"frequency_domain_sweep_progress.v1","state":"cancel_requested"}',
            schema_version: "frequency_domain_sweep_progress.v1",
            state: "cancel_requested",
            status: "cancel_requested",
            total_frequency_points: 4,
            written_frequency_point_artifacts: 1,
          },
        },
      }),
    );
    const cancelRequestedNode = responseResults.find(
      (node) => node.kind === "results.frequency_response.cancel_requested",
    );
    expect(cancelRequestedNode).toMatchObject({
      artifactPath: "response/cancel_requested.v1.json",
      badge: "1/4",
      resourceRef:
        ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_CANCEL_REQUESTED_V1_PATH,
      status: "ready",
    });
    const responsePointNodes = responseResults.filter(
      (node) => node.kind === "results.frequency_response.frequency_point",
    );
    expect(responsePointNodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          contextCommands: undefined,
          fieldId: undefined,
          frequencyIndex: 0,
          id: "results:frequency-response:frequency-points:0",
          status: "stale",
        }),
        expect.objectContaining({
          fieldId: undefined,
          frequencyIndex: 1,
          id: "results:frequency-response:frequency-points:1",
          status: "stale",
        }),
      ]),
    );

    const resources = flattenExplorerNodes(
      buildExplorerTree("resources", {
        frequencyDomainManifest: {
          ...FREQUENCY_DOMAIN_MANIFEST,
          result_manifest: {
            artifact_path: "frequency_domain/manifest.v1.json",
            missing_reason: null,
            payload: {
              artifacts: {
                branches_v2_path: "eigen/branches.v2.json",
                dispersion_csv_path: "eigen/dispersion/branch_table.csv",
                eigen_diagnostics_v2_path: "eigen/diagnostics.v2.json",
                mode_metadata_paths: [
                  "eigen/modes/sample_0000/mode_0002.json",
                ],
                frequency_point_paths: [
                  "response/frequency_points/frequency_0000.json",
                  "response/frequency_points/frequency_0001.json",
                ],
                response_diagnostics_v1_path:
                  "response/diagnostics/solver.v1.json",
                response_cancel_requested_v1_path:
                  "response/cancel_requested.v1.json",
                response_progress_v1_path: "response/progress.v1.json",
                response_sweep_v1_path:
                  "response/magnetic_response_sweep.v1.json",
                spectrum_v2_path: "eigen/spectrum.v2.json",
              },
              resources: {
                branches_resource_key:
                  ANALYSIS_FREQUENCY_DOMAIN_EIGEN_BRANCHES_V2_PATH,
                dispersion_resource_key:
                  ANALYSIS_FREQUENCY_DOMAIN_EIGEN_DISPERSION_PATH,
                eigen_diagnostics_resource_key:
                  ANALYSIS_FREQUENCY_DOMAIN_EIGEN_DIAGNOSTICS_V2_PATH,
                mode_field_resources: [
                  ANALYSIS_FREQUENCY_DOMAIN_EIGEN_MODE_FIELD_META_PATH
                    .replace("{sample_index}", "0")
                    .replace("{mode_index}", "2"),
                ],
                response_diagnostics_resource_key:
                  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_DIAGNOSTICS_V1_PATH,
                response_cancel_requested_resource_key:
                  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_CANCEL_REQUESTED_V1_PATH,
                response_progress_resource_key:
                  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_PROGRESS_V1_PATH,
                response_field_resources: [
                  {
                    field_resource_id:
                      "analysis:frequency-response:frequency-0000",
                    frequency_index: 0,
                    payload_path:
                      "response/field_payloads/frequency_0000/vector_xyz.bin",
                  },
                  {
                    field_resource_id:
                      "analysis:frequency-response:frequency-0001",
                    frequency_index: 1,
                    payload_path:
                      "response/field_payloads/frequency_0001/vector_xyz.bin",
                  },
                ],
                response_sweep_resource_key:
                  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
                spectrum_resource_key:
                  ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH,
              },
            },
            resource_key: ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
            schema_version: "frequency_domain_manifest.v1",
            status: "ready",
          },
        },
      }),
    );
    expect(resources.map((node) => node.kind)).toEqual(
      expect.arrayContaining([
        "resources.analysis.frequency_domain.manifest",
        "resources.analysis.eigen.mode_field",
        "resources.analysis.frequency_response.field",
        "resources.analysis.frequency_response.progress",
        "resources.analysis.frequency_response.cancel_requested",
        "resources.analysis.frequency_response.observables",
        "resources.analysis.frequency_response.diagnostics",
      ]),
    );
    expect(
      resources.find(
        (node) =>
          node.kind === "resources.analysis.frequency_response.progress",
      ),
    ).toMatchObject({
      artifactPath: "response/progress.v1.json",
      resourceRef: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_PROGRESS_V1_PATH,
    });
    expect(
      resources.find(
        (node) =>
          node.kind ===
          "resources.analysis.frequency_response.cancel_requested",
      ),
    ).toMatchObject({
      artifactPath: "response/cancel_requested.v1.json",
      resourceRef:
        ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_CANCEL_REQUESTED_V1_PATH,
    });
    expect(
      resources.find(
        (node) => node.kind === "resources.analysis.frequency_response.sweep",
      ),
    ).toMatchObject({
      artifactPath: "response/magnetic_response_sweep.v1.json",
      resourceRef: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
    });
    expect(
      resources.find(
        (node) =>
          node.kind === "resources.analysis.frequency_response.frequency_point",
      ),
    ).toMatchObject({
      artifactPath: "response/frequency_points/frequency_0000.json",
      badge: "2 frequency points",
      resourceRef:
        ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_FREQUENCY_POINT_PATH.replace(
          "{frequency_index}",
          "0",
        ),
      status: "ready",
    });
    expect(
      resources.find(
        (node) =>
          node.kind === "resources.analysis.frequency_response.diagnostics",
      ),
    ).toMatchObject({
      artifactPath: "response/diagnostics/solver.v1.json",
      resourceRef: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_DIAGNOSTICS_V1_PATH,
    });
    expect(
      resources.find(
        (node) => node.kind === "resources.analysis.frequency_response.field",
      ),
    ).toMatchObject({
      artifactPath: "response/field_payloads/frequency_0000/vector_xyz.bin",
      badge: "2 response fields",
      resourceRef: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_FIELD_META_PATH.replace(
        "{frequency_index}",
        "0",
      ),
      status: "ready",
    });
    expect(
      resources.find(
        (node) =>
          node.kind === "resources.analysis.frequency_response.observables",
      ),
    ).toMatchObject({
      artifactPath: "response/magnetic_response_sweep.v1.json",
      resourceRef: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
      status: "ready",
    });
    expect(
      resources.find((node) => node.kind === "resources.analysis.eigen.spectrum"),
    ).toMatchObject({
      artifactPath: "eigen/spectrum.v2.json",
      resourceRef: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH,
    });
    expect(
      resources.find((node) => node.kind === "resources.analysis.eigen.branches"),
    ).toMatchObject({
      artifactPath: "eigen/branches.v2.json",
      resourceRef: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_BRANCHES_V2_PATH,
    });
    expect(
      resources.find(
        (node) => node.kind === "resources.analysis.eigen.dispersion",
      ),
    ).toMatchObject({
      artifactPath: "eigen/dispersion/branch_table.csv",
      resourceRef: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_DISPERSION_PATH,
    });
    expect(
      resources.find(
        (node) => node.kind === "resources.analysis.eigen.diagnostics",
      ),
    ).toMatchObject({
      artifactPath: "eigen/diagnostics.v2.json",
      resourceRef: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_DIAGNOSTICS_V2_PATH,
    });
    expect(
      resources.find(
        (node) => node.kind === "resources.analysis.eigen.mode_metadata",
      ),
    ).toMatchObject({
      artifactPath: "eigen/modes/sample_0000/mode_0002.json",
      badge: "1 mode metadata",
      resourceRef: ANALYSIS_EIGEN_MODE_V2_PATH,
      status: "ready",
    });
    expect(
      resources.find((node) => node.kind === "resources.analysis.eigen.mode_field"),
    ).toMatchObject({
      badge: "1 mode fields",
      resourceRef: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_MODE_FIELD_META_PATH
        .replace("{sample_index}", "0")
        .replace("{mode_index}", "2"),
      status: "ready",
    });

    const v2OnlyResponseSweepManifest: FrequencyDomainManifestResource = {
      ...FREQUENCY_DOMAIN_MANIFEST,
      result_manifest: {
        artifact_path: "frequency_domain/manifest.v1.json",
        missing_reason: null,
        payload: {
          artifacts: {
            response_sweep_v2_path:
              "response/magnetic_response_sweep.v2.json",
          },
          resources: {
            response_sweep_resource_key:
              ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
          },
        },
        resource_key: ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
        schema_version: "frequency_domain_manifest.v1",
        status: "ready",
      },
    };
    const v2OnlyResponseResources = flattenExplorerNodes(
      buildExplorerTree("resources", {
        frequencyDomainManifest: v2OnlyResponseSweepManifest,
      }),
    );
    expect(
      v2OnlyResponseResources.find(
        (node) => node.kind === "resources.analysis.frequency_response.sweep",
      ),
    ).toMatchObject({
      artifactPath: "response/magnetic_response_sweep.v2.json",
      resourceRef: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
      status: "ready",
    });
    expect(
      v2OnlyResponseResources.find(
        (node) =>
          node.kind === "resources.analysis.frequency_response.observables",
      ),
    ).toMatchObject({
      artifactPath: "response/magnetic_response_sweep.v2.json",
      resourceRef: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
      status: "ready",
    });

    const emptyArtifactResources = flattenExplorerNodes(
      buildExplorerTree("resources", {
        frequencyDomainManifest: FREQUENCY_DOMAIN_MANIFEST,
      }),
    );
    expect(
      emptyArtifactResources.flatMap((node) =>
        node.id.startsWith("resources:analysis:frequency-domain")
          ? [node.kind]
          : [],
      ),
    ).toEqual([
      "resources.analysis.frequency_domain",
      "resources.analysis.frequency_domain.manifest",
      "resources.analysis.frequency_domain.calculation_modes",
      "resources.analysis.frequency_domain.fmr",
      "resources.analysis.frequency_domain.dispersion",
      "resources.analysis.frequency_domain.response_map",
    ]);
    expect(
      emptyArtifactResources.find(
        (node) =>
          node.kind === "resources.analysis.frequency_domain.calculation_modes",
      ),
    ).toMatchObject({
      badge: "workflow presets",
      resourceRef: ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
      status: "ready",
    });
    expect(
      emptyArtifactResources.find(
        (node) => node.kind === "resources.analysis.frequency_domain.fmr",
      ),
    ).toMatchObject({
      badge: "driven",
      resourceRef: ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
      status: "ready",
    });
    expect(
      emptyArtifactResources.find(
        (node) =>
          node.kind === "resources.analysis.frequency_domain.dispersion",
      ),
    ).toMatchObject({
      badge: "demag-k rejected",
      resourceRef: ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
      status: "unsupported",
    });
    expect(
      emptyArtifactResources.find(
        (node) =>
          node.kind === "resources.analysis.frequency_domain.response_map",
      ),
    ).toMatchObject({
      badge: "unsupported",
      resourceRef: ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
      status: "unsupported",
    });
    expect(
      emptyArtifactResources.find(
        (node) => node.kind === "resources.mesh.periodic_pairs",
      ),
    ).toMatchObject({
      id: "resources:mesh:periodic-pairs",
      label: "Periodic Pairs",
      parentId: "resources:mesh",
      resourceRef: MESHING_PERIODIC_PAIRS_PATH,
      status: "stale",
    });

    const emptyArtifactResults = flattenExplorerNodes(
      buildExplorerTree("results", {
        frequencyDomainManifest: FREQUENCY_DOMAIN_MANIFEST,
      }),
    );
    expect(
      emptyArtifactResults.flatMap((node) =>
        node.id.startsWith("results:frequency-domain") ? [node.kind] : [],
      ),
    ).toEqual([
      "results.frequency_domain.root",
      "results.frequency_domain.run",
      "results.frequency_domain.calculation_modes",
    ]);
    expect(emptyArtifactResults.map((node) => node.id)).not.toContain(
      "results:eigen",
    );
    expect(emptyArtifactResults.map((node) => node.id)).not.toContain(
      "results:frequency-response",
    );

    const inconsistentModeFieldManifest: FrequencyDomainManifestResource = {
      ...FREQUENCY_DOMAIN_MANIFEST,
      result_manifest: {
        artifact_path: "frequency_domain/manifest.v1.json",
        missing_reason: null,
        payload: {
          artifacts: {
            mode_metadata_paths: [],
          },
          resources: {
            mode_field_resources: [
              ANALYSIS_FREQUENCY_DOMAIN_EIGEN_MODE_FIELD_META_PATH
                .replace("{sample_index}", "0")
                .replace("{mode_index}", "2"),
            ],
          },
        },
        resource_key: ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
        schema_version: "frequency_domain_manifest.v1",
        status: "ready",
      },
    };
    const inconsistentResources = flattenExplorerNodes(
      buildExplorerTree("resources", {
        frequencyDomainManifest: inconsistentModeFieldManifest,
      }),
    );
    expect(
      inconsistentResources.find(
        (node) => node.kind === "resources.analysis.eigen.mode_field",
      ),
    ).toMatchObject({
      badge: "metadata missing",
      status: "stale",
    });

    const jobs = flattenExplorerNodes(buildExplorerTree("jobs"));
    expect(jobs.map((node) => node.kind)).toEqual(
      expect.arrayContaining([
        "jobs.frequency_domain.root",
        "jobs.frequency_domain.stage_run",
        "jobs.frequency_domain.eigen_sample",
        "jobs.frequency_domain.response_frequency",
        "jobs.frequency_domain.response_progress",
        "jobs.frequency_domain.artifact_export",
      ]),
    );

    const diagnostics = flattenExplorerNodes(
      buildExplorerTree("diagnostics", {
        frequencyDomainManifest: FREQUENCY_DOMAIN_MANIFEST,
      }),
    );
    expect(diagnostics.map((node) => node.kind)).toEqual(
      expect.arrayContaining([
        "diagnostics.frequency_domain.capabilities",
        "diagnostics.frequency_domain.operator",
        "diagnostics.frequency_domain.api_resources",
        "diagnostics.frequency_domain.periodic_floquet",
      ]),
    );
  });

  it("builds frequency-domain jobs from live progress resources", () => {
    const jobs = flattenExplorerNodes(
      buildExplorerTree("jobs", {
        frequencyDomainCancelRequested: FREQUENCY_DOMAIN_RESPONSE_CANCEL_REQUESTED,
        frequencyDomainManifest: FREQUENCY_DOMAIN_MANIFEST,
        frequencyDomainResponseProgress: FREQUENCY_DOMAIN_RESPONSE_PROGRESS,
        frequencyDomainResponseSweep: FREQUENCY_DOMAIN_RESPONSE_SWEEP,
        frequencyDomainSpectrum: FREQUENCY_DOMAIN_SPECTRUM,
      }),
    );

    expect(
      jobs.find((node) => node.id === "jobs:frequency-domain"),
    ).toMatchObject({
      badge: "3/10 running",
      kind: "jobs.frequency_domain.root",
      status: "cancelled",
    });
    expect(
      jobs.find((node) => node.id === "jobs:frequency-domain:stage-run"),
    ).toMatchObject({
      badge: "frequency_domain_manifest.v1",
      resourceRef: ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
      status: "cancelled",
    });
    expect(
      jobs.find((node) => node.id === "jobs:frequency-domain:eigen-sample"),
    ).toMatchObject({
      badge: "2 mode(s)",
      resourceRef: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH,
      status: "completed",
    });
    expect(
      jobs.find(
        (node) => node.id === "jobs:frequency-domain:response-frequency",
      ),
    ).toMatchObject({
      badge: "3/10",
      resourceRef: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_PROGRESS_V1_PATH,
      status: "cancelled",
    });
    expect(
      jobs.find((node) => node.id === "jobs:frequency-domain:response-progress"),
    ).toMatchObject({
      badge: "3/10 running",
      resourceRef: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_PROGRESS_V1_PATH,
      status: "cancelled",
    });
    expect(
      jobs.find((node) => node.id === "jobs:frequency-domain:artifact-export"),
    ).toMatchObject({
      badge: "frequency_domain/manifest.partial.v1.json",
      resourceRef: ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
      status: "ready",
    });
  });

  it("uses manifest response field resources for frequency-domain response point field ids", () => {
    const manifest = {
      ...FREQUENCY_DOMAIN_MANIFEST,
      result_manifest: {
        artifact_path: "frequency_domain/manifest.v1.json",
        missing_reason: null,
        payload: {
          resources: {
            response_field_resources: [
              {
                field_resource_id:
                  "analysis:frequency-response:frequency-0042",
                frequency_index: 1,
                payload_path:
                  "response/field_payloads/frequency_0001/vector_xyz.bin",
              },
            ],
          },
        },
        resource_key: ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
        schema_version: "frequency_domain_manifest.v1",
        status: "ready",
      },
    } satisfies FrequencyDomainManifestResource;

    const results = flattenExplorerNodes(
      buildExplorerTree("results", {
        frequencyDomainManifest: manifest,
        frequencyDomainResponseSweep: FREQUENCY_DOMAIN_RESPONSE_SWEEP,
      }),
    );

    expect(
      results.find(
        (node) => node.id === "results:frequency-response:frequency-points:0",
      ),
    ).toMatchObject({
      fieldId: undefined,
      frequencyIndex: 0,
      kind: "results.frequency_response.frequency_point",
      status: "stale",
    });
    expect(
      results.find(
        (node) => node.id === "results:frequency-response:frequency-points:1",
      ),
    ).toMatchObject({
      fieldId: "analysis:frequency-response:frequency-0042",
      frequencyIndex: 1,
      kind: "results.frequency_response.frequency_point",
      status: "ready",
    });
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
              settle_step_id: "relax",
              stage_id: "hysteresis-1",
              status: "done",
              updated_revision: 22,
            },
            {
              kind: "settle_algorithm",
              label: "Minimize",
              node_id: "point-7:minimize",
              settle_step_id: "minimize",
              stage_id: "hysteresis-1",
              status: "active",
              updated_revision: 22,
            },
            {
              kind: "settle_algorithm",
              label: "Dynamics settle",
              node_id: "point-7:dynamics",
              settle_step_id: "dynamics",
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
      label: "Field +30 mT",
      status: "running",
    });
    expect(
      flattened.find((node) => node.id === `${stageId}:field-point:7:algorithm:relax`),
    ).toMatchObject({
      label: "Relax",
      status: "completed",
    });
    expect(
      flattened.find((node) => node.id === `${stageId}:field-point:7:algorithm:minimize`),
    ).toMatchObject({
      label: "Minimize",
      status: "running",
    });
    expect(
      flattened.find((node) => node.id === `${stageId}:field-point:7:algorithm:dynamics`),
    ).toMatchObject({
      label: "Dynamics settle",
      status: "queued",
    });
    expect(
      flattened.find((node) => node.id === `${stageId}:field-point:7:snapshot:hysteresis_point_007`),
    ).toMatchObject({
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
      flattened.find((node) => node.id === `${stageId}:transitions:export-loop`),
    ).toMatchObject({
      label: "Export loop CSV",
      badge: "after completion",
      status: "queued",
    });
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
    expect(
      resources.find(
        (node) =>
          node.kind === "resources.analysis.frequency_domain.dispersion",
      ),
    ).toMatchObject({
      badge: "demag-k rejected",
      status: "unsupported",
    });
    expect(
      resources.find(
        (node) =>
          node.kind === "resources.analysis.frequency_domain.response_map",
      ),
    ).toMatchObject({
      badge: "available",
      status: "ready",
    });
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
});
