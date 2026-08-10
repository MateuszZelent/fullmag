import { describe, expect, it } from "vitest";

import type {
  FrequencyDomainManifestResource,
  FrequencyDomainSweepProgressResource,
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
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_CANCEL_REQUESTED_V1_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_DIAGNOSTICS_V1_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_FREQUENCY_POINT_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_PROGRESS_V1_PATH,
} from "@/kernel/api/apiPaths";

import {
  buildExplorerTree,
  buildModelTree,
  flattenExplorerNodes,
} from "../explorer/builders/buildModelTree";
import { modelTreeSnapshotFromScene } from "../explorer/builders/sceneModelTreeAdapter";
import { resolveInspectorPanel } from "./inspectorRegistry";
import { resolveInspectorRoute } from "./inspectorRouteCatalog";

const frequencyDomainResponseProgress: FrequencyDomainSweepProgressResource = {
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

const frequencyDomainCancelRequested: FrequencyDomainSweepProgressResource = {
  ...frequencyDomainResponseProgress,
  completed_frequency_points: 4,
  current_frequency_hz: 10.0e9,
  latest_artifact_manifest_path: "frequency_domain/manifest.cancelled.v1.json",
  progress_json:
    '{"schema_version":"frequency_domain_sweep_progress.v1","state":"cancel_requested"}',
  state: "cancel_requested",
  written_frequency_point_artifacts: 4,
};

const frequencyDomainManifest = {
  capabilities: {} as FrequencyDomainManifestResource["capabilities"],
  eigen_namespace: "eigen",
  eigenmodes: {
    diagnostics_json: "{}",
    driven_response_available: false,
    dynamic_demag_k_available: false,
    floquet_modal_available: true,
    floquet_response_available: false,
    gpu_available: false,
    modal_solver_available: true,
    static_periodic_response_available: false,
    reason: "fixture",
    status: "ok",
    study_kind: "eigenmodes",
  },
  existing_frequency_response_namespace_preserved: true,
  family_namespace: "frequencyDomain",
  floquet_nonzero_k_demag_supported: false,
  floquet_nonzero_k_response_supported: false,
  response: {
    diagnostics_json: "{}",
    driven_response_available: true,
    dynamic_demag_k_available: false,
    floquet_modal_available: false,
    floquet_response_available: false,
    gpu_available: false,
    magnetic_cpu: "reference_executable",
    magnetic_gpu: "unsupported",
    magnetoelastic_elastodynamic: "unsupported",
    magnetoelastic_quasistatic: "unsupported",
    mode_projected: "unsupported",
    modal_solver_available: false,
    static_periodic_response_available: true,
    reason: "fixture",
    status: "ok",
    study_kind: "frequency_response",
  },
  response_cancel_requested: frequencyDomainCancelRequested,
  response_progress: frequencyDomainResponseProgress,
  result_manifest: {
    artifact_path: "frequency_domain/manifest.v1.json",
    missing_reason: null,
    payload: {
      artifacts: {
        branches_v2_path: "eigen/branches.v2.json",
        dispersion_csv_path: "eigen/dispersion.csv",
        eigen_diagnostics_v2_path: "eigen/diagnostics.v2.json",
        frequency_point_paths: [
          "response/frequency_points/frequency_0000.json",
        ],
        mode_metadata_paths: ["eigen/modes/sample_0000/mode_0002.json"],
        response_cancel_requested_v1_path:
          "response/cancel_requested.v1.json",
        response_diagnostics_v1_path: "response/diagnostics/solver.v1.json",
        response_progress_v1_path: "response/progress.v1.json",
        response_sweep_v2_path: "response/magnetic_response_sweep.v2.json",
        spectrum_v2_path: "eigen/spectrum.v2.json",
      },
      resources: {
        branches_resource_key: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_BRANCHES_V2_PATH,
        dispersion_resource_key: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_DISPERSION_PATH,
        eigen_diagnostics_resource_key:
          ANALYSIS_FREQUENCY_DOMAIN_EIGEN_DIAGNOSTICS_V2_PATH,
        mode_field_resources: [
          ANALYSIS_FREQUENCY_DOMAIN_EIGEN_MODE_FIELD_META_PATH
            .replace("{sample_index}", "0")
            .replace("{mode_index}", "2"),
        ],
        mode_metadata_resource_key: ANALYSIS_EIGEN_MODE_V2_PATH,
        response_cancel_requested_resource_key:
          ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_CANCEL_REQUESTED_V1_PATH,
        response_diagnostics_resource_key:
          ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_DIAGNOSTICS_V1_PATH,
        response_field_resources: [
          {
            field_resource_id: "analysis:frequency-response:field-0000",
            frequency_index: 0,
            payload_path: "response/fields/frequency_0000.bin",
          },
        ],
        response_frequency_point_resource_keys: [
          ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_FREQUENCY_POINT_PATH.replace(
            "{frequency_index}",
            "0",
          ),
        ],
        response_progress_resource_key:
          ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_PROGRESS_V1_PATH,
        response_sweep_resource_key:
          ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
        spectrum_resource_key: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH,
      },
    },
    resource_key: ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
    schema_version: "frequency_domain_manifest.v1",
    status: "ready",
  },
  schema_version: "frequency_domain_manifest.v1",
} as unknown as FrequencyDomainManifestResource;

const frequencyDomainSpectrum = {
  artifact_path: "eigen/spectrum.v2.json",
  missing_reason: null,
  payload: {
    modes: [
      {
        branch_id: "branch-0",
        frequency_hz: 12.5e9,
        mode_field_id: "analysis:eigen:sample-0000:mode-0002",
        mode_field_resource_key:
          "data/fields/analysis:eigen:sample-0000:mode-0002",
        raw_mode_index: 2,
        residual_norm: 1e-8,
        sample_index: 0,
      },
    ],
    schema_version: "eigen_spectrum.v2",
  },
  resource_key: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH,
  schema_version: "frequency_domain_eigen_spectrum.v2",
  status: "ready",
} as never;

const frequencyDomainBranches = {
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
        ],
      },
    ],
    schema_version: "eigen_branches.v2",
    solver_model: "linearized_llg_reference",
  },
  resource_key: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_BRANCHES_V2_PATH,
  schema_version: "frequency_domain_eigen_branches.v2",
  status: "ready",
} as never;

const frequencyDomainDispersion = {
  artifact_path: "eigen/dispersion.csv",
  content_type: "text/csv",
  missing_reason: null,
  resource_key: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_DISPERSION_PATH,
  schema_version: "frequency_domain_eigen_dispersion.csv",
  status: "ready",
  text: "sample_index,raw_mode_index,branch_id,path_s,frequency_hz,residual_norm\n0,2,branch-0,0,12.5e9,1e-8",
} as never;

const frequencyDomainResponseSweep = {
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
    ],
    schema_version: "magnetic_response_sweep.v2",
  },
  resource_key: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
  schema_version: "frequency_domain_response_sweep_resource.v1",
  status: "ready",
} as never;

const modelSnapshot = (() => {
  const sceneSnapshot = modelTreeSnapshotFromScene(
    {
      objects: [
        {
          geometry: { geometry_kind: "Box" },
          id: "film",
          name: "Film",
          role: "magnet",
        },
      ],
      study: {
        stages: [
          { kind: "relax", stage_id: "relax" },
          { kind: "run", stage_id: "run" },
        ],
      },
      universe: {
        id: "universe",
        name: "Universe",
        size: [2e-6, 1e-6, 5e-8],
      },
    } as SceneResource,
    {
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
      ] as never,
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
            mesh_part_ids: ["part:core"],
            mesh_policy: { maximum_element_size: 1e-9 },
            name: "Core",
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

  return {
    ...sceneSnapshot,
    airbox: { authoredPolicy: true, realizedCarrier: true },
    domainDiscretization: "fem" as const,
    mesh: {
      manifestSourceSceneRevision: 3,
      meshName: "shared-domain",
      meshRevision: 3,
      outerBoundaryPartCount: 1,
      sourceSceneRevision: 3,
    },
    objects: sceneSnapshot.objects?.map((object) => ({
      ...object,
      meshStatus: "mesh-ready" as const,
    })),
  };
})();

const resources = {
  frequencyDomainBranches,
  frequencyDomainCancelRequested,
  frequencyDomainDispersion,
  frequencyDomainManifest,
  frequencyDomainResponseProgress,
  frequencyDomainResponseSweep,
  frequencyDomainSpectrum,
};

const tabIds = [
  "model",
  "resources",
  "results",
  "jobs",
  "diagnostics",
] as const;

function nodesForTab(tabId: (typeof tabIds)[number]) {
  const resourceTree = buildExplorerTree(tabId, resources);
  // buildExplorerTree currently has no snapshot parameter; preserve its public
  // resource contract for every tab and inject the complete model fixture at
  // the existing buildModelTree seam for the model tab.
  return tabId === "model"
    ? flattenExplorerNodes(buildModelTree(modelSnapshot, resources))
    : flattenExplorerNodes(resourceTree);
}

describe("inspector route coverage", () => {
  it("covers the complete model and conditional resource trees before routing every selectable node", () => {
    const nodesByTab = new Map(tabIds.map((tabId) => [tabId, nodesForTab(tabId)]));
    const kindsByTab = (tabId: (typeof tabIds)[number]) =>
      nodesByTab.get(tabId)?.map((node) => node.kind) ?? [];

    expect(kindsByTab("model")).toEqual(
      expect.arrayContaining([
        "object.root",
        "object.visualization",
        "object.region",
        "object.region.visualization",
        "airbox.root",
        "airbox.visualization",
        "mesh.root",
        "study.root",
        "study.stage.relax",
        "study.stage.run",
      ]),
    );
    expect(kindsByTab("resources")).toEqual(
      expect.arrayContaining([
        "resources.analysis.frequency_domain",
        "resources.analysis.eigen.spectrum",
        "resources.analysis.frequency_response.sweep",
        "resources.analysis.frequency_response.field",
      ]),
    );
    expect(kindsByTab("results")).toEqual(
      expect.arrayContaining([
        "results.frequency_domain.fmr_modal_spectrum",
        "results.frequency_domain.fmr_response_sweep",
        "results.eigen.mode",
        "results.frequency_response.root",
        "results.frequency_response.frequency_point",
      ]),
    );
    expect(kindsByTab("jobs")).toEqual(
      expect.arrayContaining([
        "jobs.frequency_domain.root",
        "jobs.frequency_domain.stage_run",
        "jobs.frequency_domain.eigen_sample",
        "jobs.frequency_domain.response_progress",
        "jobs.frequency_domain.artifact_export",
      ]),
    );
    expect(kindsByTab("diagnostics")).toEqual(
      expect.arrayContaining([
        "diagnostics.frequency_domain.root",
        "diagnostics.frequency_domain.capabilities",
        "diagnostics.frequency_domain.operator",
        "diagnostics.frequency_domain.periodic_floquet",
      ]),
    );

    const selectableNodes = tabIds.flatMap((tabId) =>
      nodesByTab.get(tabId)?.filter((node) => node.selectable !== false) ?? [],
    );

    const uncoveredNodes = selectableNodes
      .filter((node) => resolveInspectorRoute(node.kind) === null)
      .map((node) => `${node.id} (${node.kind})`);
    expect(uncoveredNodes).toEqual([]);

    for (const node of selectableNodes) {
      const route = resolveInspectorRoute(node.kind);
      const panel = resolveInspectorPanel({ kind: node.kind });
      expect(route?.id, `missing route for ${node.id}`).toBeTruthy();
      expect(panel?.id, `missing Inspector for ${node.id}`).toBeTruthy();
      expect(panel?.id, `placeholder for ${node.id}`).not.toBe("placeholder");
      expect(panel).toBe(route?.contribution);
    }
  });
});
