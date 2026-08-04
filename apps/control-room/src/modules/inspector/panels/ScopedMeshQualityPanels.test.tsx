import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { Selection } from "@/kernel/selection/selectionTypes";
import { Accordion } from "@/shared/ui/Accordion";

const mixedTopologyCapabilityStatus = vi.hoisted(() => ({
  value: "validated",
}));

vi.mock("../InspectorTabState", () => ({
  useInspectorActiveTab: () => "policy",
}));

vi.mock("@/kernel/KernelContext", () => ({
  useKernel: () => ({
    api: {
      meshing: {
        replaceObjectPolicy: vi.fn(),
        replaceUniversePolicy: vi.fn(),
      },
    },
    commands: {
      execute: vi.fn(),
    },
    bus: {
      emit: vi.fn(),
    },
    resources: {
      invalidate: vi.fn(),
    },
  }),
}));

vi.mock("@/kernel/resources/studyRuntimeResources", () => ({
  shouldLoadRuntimeMeshBuild: () => true,
  shouldLoadRuntimeMeshManifest: () => true,
  shouldLoadRuntimeMeshSummary: () => true,
}));

const sessionStatusMock = {
  data: {
    capabilities: {
      explicit_topology: true,
    },
    domain: {
      discretization: "fem",
    },
    resources: {
      mesh_build_revision: 3,
      mesh_revision: 3,
    },
  },
  error: null,
  refetch: vi.fn(),
  revision: 3,
  status: "ready",
};

vi.mock("@/kernel/resources/useSessionStatus", () => ({
  useSessionStatus: () => sessionStatusMock,
  useSessionStatusSelector: (selector: (status: typeof sessionStatusMock) => unknown) =>
    selector(sessionStatusMock),
}));

const qualityPayload = {
  global: {
    warnings: Array.from({ length: 51 }, (_, index) => `warning-${index}-${"界".repeat(1_000)}`),
    characteristic_size: {
      histogram: [
        { count: 3, hi: 3e-9, lo: 1e-9 },
        { count: 7, hi: 9e-9, lo: 3e-9 },
      ],
      max: 9e-9,
      mean: 5e-9,
      min: 1e-9,
      std: 1e-9,
    },
    edge_length: {
      histogram: [
        { count: 2, hi: 2e-9, lo: 1e-9 },
        { count: 8, hi: 4e-9, lo: 2e-9 },
      ],
      max: 4e-9,
      mean: 2.5e-9,
      min: 1e-9,
      std: 0.5e-9,
    },
    element_count: 10,
    gamma: {
      below_threshold_count: 1,
      below_threshold_fraction: 0.1,
      histogram: [
        { count: 1, hi: 0.08, lo: 0 },
        { count: 9, hi: 1, lo: 0.08 },
      ],
      mean: 0.72,
      min: 0.03,
      threshold: 0.08,
    },
    sicn: {
      below_threshold_count: 2,
      below_threshold_fraction: 0.2,
      histogram: [
        { count: 2, hi: 0.1, lo: 0 },
        { count: 8, hi: 1, lo: 0.1 },
      ],
      mean: 0.81,
      min: 0.05,
      threshold: 0.1,
    },
    volume: {
      histogram: [{ count: 10, hi: 4e-27, lo: 1e-27 }],
      ratio: 14,
    },
  },
  worst_elements: [
    {
      element_index: 4,
      gamma: 0.03,
      scope_label: "region:film:core",
      sicn: 0.05,
    },
  ],
  quality_source: "region_membership",
};

const objectQualityPayload = {
  ...qualityPayload,
  quality_source: "object",
  worst_elements: [
    {
      element_index: 4,
      gamma: 0.03,
      scope_label: "object:waveguide",
      sicn: 0.05,
    },
  ],
};

vi.mock("@/kernel/resources/geometryLifecycleResources", () => ({
  MESH_BUILD_CURRENT_RESOURCE_KEY: "meshing/builds/current",
  MESH_BUILD_LATEST_SUCCESSFUL_RESOURCE_KEY: "meshing/builds/latest-successful",
  MESH_UNIVERSE_POLICY_RESOURCE_KEY: "meshing/universe/policy",
  SCENE_RESOURCE_KEY: "model/scene",
  resolveObjectMeshPolicyResourceKey: (objectId: string) =>
    `meshing/objects/${objectId}/policy`,
  resolveObjectMeshQualityResourceKey: (objectId: string) =>
    `meshing/objects/${objectId}/quality`,
  resolveObjectMeshReportResourceKey: (objectId: string) =>
    `meshing/objects/${objectId}/report`,
  resolveMeshRegionQualityResourceKey: (regionId: string) =>
    `meshing/regions/${regionId}/quality`,
  useMeshSummaryResource: () => ({
    data: {
      effective_airbox_target: {
        growth_rate: 1.4,
        maximum_element_size: 2e-8,
        minimum_element_size: 4e-9,
      },
      revision: 3,
    },
    error: null,
    refetch: vi.fn(),
    revision: 3,
    status: "ready",
  }),
  useMeshCapabilitiesResource: () => ({
    data: {
      revision: 3,
      mesh_capabilities: {
        "mesh.topology.mixed_p1": { status: mixedTopologyCapabilityStatus.value },
        "mesh.swept.prism": { status: "production_executable" },
        "mesh.transition.pyramid_tet": { status: "validated" },
        "mesh.exact_layer_count": {
          status: "production_executable",
          supported_layer_counts: [1, 2, 3],
        },
      },
    },
    error: null,
    refetch: vi.fn(),
    revision: 3,
    status: "ready",
  }),
  useDomainMetaResource: () => ({
    data: null,
    error: null,
    refetch: vi.fn(),
    revision: 3,
    status: "ready",
  }),
  useFdmRegionMembershipResource: () => ({
    data: null,
    error: null,
    refetch: vi.fn(),
    revision: 3,
    status: "ready",
  }),
  useFdmRegionMembershipBinaryResource: () => ({
    data: null,
    error: null,
    refetch: vi.fn(),
    revision: 3,
    status: "ready",
  }),
  useMeshBuildCurrent: () => ({
    data: {
      effective_airbox_target: { growth_rate: 1.4, hmax: 2e-8, hmin: 4e-9 },
      last_build_error: "tetrahedralization failed",
      last_build_summary: { status: "failed" },
      mesh_pipeline_status: [{ id: "tetrahedralize", status: "failed" }],
      revision: 5,
    },
    error: null,
    refetch: vi.fn(),
    revision: 5,
    status: "ready",
  }),
  useMeshBuildLatestSuccessful: () => ({
    data: { revision: 4 },
    error: null,
    refetch: vi.fn(),
    revision: 4,
    status: "ready",
  }),
  useMeshSharedDomainManifestResource: () => ({
    data: {
      domain_mesh_mode: "shared_domain_mesh_with_air",
      generation_id: "generation-3",
      geometry_realization_revision: 2,
      mesh_id: "study_domain:3",
      mesh_name: "study_domain",
      mesh_parts: [
        {
          boundary_face_count: 12,
          boundary_face_indices: [0, 1, 2],
          boundary_face_start: 0,
          element_count: 59_244,
          element_counts_by_type: { pyramid5: 244, tet4: 59_000 },
          element_start: 0,
          id: "part:__air__",
          label: "Airbox",
          node_count: 12_345,
          node_indices: [0, 1, 2, 3],
          node_start: 0,
          role: "air",
          surface_faces: [
            [0, 1, 2],
            [0, 2, 3],
          ],
        },
      ],
      object_segments: [],
      regions: [],
      revision: 3,
      source_scene_revision: 1,
    },
    error: null,
    refetch: vi.fn(),
    revision: 3,
    status: "ready",
  }),
  useMeshRegionMembershipResource: () => ({
    data: {
      boundary_face_indices: [],
      element_indices: [0, 1],
      mesh_id: "shared-domain",
      mesh_part_ids: ["part:film:core"],
      mesh_revision: 3,
      node_indices: [0, 1, 2, 3, 4],
      realization_method: "conformal",
      realization_warnings: [],
      region_id: "film:core",
      source: "realized_region",
    },
    error: null,
    refetch: vi.fn(),
    revision: 3,
    status: "ready",
  }),
  useMeshRegionQualityResource: () => ({
    data: {
      quality: qualityPayload,
      region_id: "film:core",
      revision: 3,
    },
    error: null,
    refetch: vi.fn(),
    revision: 3,
    status: "ready",
  }),
  useMeshSharedDomainQualityDataResource: () => ({
    data: {
      elementCount: 2,
      gamma: new Float64Array([0.03, 0.72]),
      sicn: new Float64Array([0.05, 0.81]),
      volume: new Float64Array([1 / 6, 8 / 6]),
    },
    error: null,
    refetch: vi.fn(),
    revision: 3,
    status: "ready",
  }),
  useMeshSharedDomainTopologyResource: () => ({
    data: {
      boundaryFaceCount: 0,
      boundaryFaces: new Uint32Array(),
      boundaryMarkers: new Uint32Array(),
      elementCount: 2,
      elementMarkers: new Uint32Array([1, 1]),
      indices: new Uint32Array([
        0, 1, 2, 3,
        0, 4, 5, 6,
      ]),
      nodeCount: 7,
      positions: new Float64Array([
        0, 0, 0,
        1, 0, 0,
        0, 1, 0,
        0, 0, 1,
        2, 0, 0,
        0, 2, 0,
        0, 0, 2,
      ]),
    },
    error: null,
    refetch: vi.fn(),
    revision: 3,
    status: "ready",
  }),
  useMeshUniverseQualityResource: () => ({
    data: {
      quality: qualityPayload,
      revision: 3,
    },
    error: null,
    refetch: vi.fn(),
    revision: 3,
    status: "ready",
  }),
  useMeshUniverseReportResource: () => ({
    data: {
      report: null,
      revision: 3,
    },
    error: null,
    refetch: vi.fn(),
    revision: 3,
    status: "ready",
  }),
  useObjectMeshPolicyResource: (objectId: string) => ({
    data: {
      config: {
        algorithm_2d: 6,
        algorithm_3d: 1,
        compute_quality: true,
        curvature_factor: "0.35",
        maximum_element_growth_rate: "1.22",
        maximum_element_size: "6e-09",
        minimum_element_size: "1.8e-09",
        mesh_strategy: "swept_prism",
        topology: "prismatic",
        exact_layer_count: true,
        transition_policy: "pyramid_to_tetrahedra",
        through_thickness_elements: 1,
        narrow_regions: 2,
        narrow_region_resolution: "1",
        optimize: "Netgen",
        optimize_iterations: 8,
        per_element_quality: true,
        size_fields: [
          {
            kind: "ObjectCoreRelaxation",
            params: {
              GeometryName: objectId,
              core_maximum_element_size: 6e-9,
              edge_distance: 50e-9,
              edge_maximum_element_size: 1.8e-9,
              sampling_edge: 40,
              sampling_surface: 20,
              surface_distance: 80e-9,
              surface_maximum_element_size: 2e-9,
            },
          },
        ],
        size_from_curvature: 16,
        smoothing_steps: 8,
      },
      object_id: objectId,
      revision: 3,
    },
    error: null,
    refetch: vi.fn(),
    revision: 3,
    status: "ready",
  }),
  useObjectMeshQualityResource: (objectId: string) => ({
    data: {
      object_id: objectId,
      quality: objectQualityPayload,
      revision: 3,
    },
    error: null,
    refetch: vi.fn(),
    revision: 3,
    status: "ready",
  }),
  useObjectMeshReportResource: (objectId: string) => ({
    data: {
      object_id: objectId,
      report: {
        effective_target: {
          maximum_element_size: 2e-9,
          minimum_element_size: 1e-9,
          source: "object",
        },
      },
      revision: 3,
    },
    error: null,
    refetch: vi.fn(),
    revision: 3,
    status: "ready",
  }),
  useObjectMeshSizeFieldResource: (objectId: string) => ({
    data: {
      object_id: objectId,
      revision: 3,
      size_field: {
        operations: [],
        size_fields: [
          {
            kind: "ObjectCoreRelaxation",
            params: {
              GeometryName: objectId,
              core_maximum_element_size: 6e-9,
              edge_distance: 50e-9,
              edge_maximum_element_size: 1.8e-9,
              sampling_edge: 40,
              sampling_surface: 20,
              surface_distance: 80e-9,
              surface_maximum_element_size: 2e-9,
            },
          },
        ],
      },
    },
    error: null,
    refetch: vi.fn(),
    revision: 3,
    status: "ready",
  }),
  useObjectTopologyResource: () => ({
    data: {
      boundaryFaceCount: 6,
      elementCount: 10,
      nodeCount: 8,
    },
    error: null,
    refetch: vi.fn(),
    revision: 3,
    status: "ready",
  }),
  useUniverseMeshPolicyResource: () => ({
    data: {
      config: { center: [0, 1e-9, 2e-9], mode: "manual", padding: [1e-7, 2e-7, 3e-7], size: [1e-6, 2e-6, 3e-6] },
      effective_config: { airbox_hmax: 2e-8, center: [0, 1e-9, 2e-9], mode: "manual", padding: [1e-7, 2e-7, 3e-7], payload: "ż".repeat(5_000), size: [1e-6, 2e-6, 3e-6] },
      revision: 3,
    },
    error: null,
    refetch: vi.fn(),
    revision: 3,
    status: "ready",
  }),
}));

vi.mock("@/kernel/visualization/useVisualizationStateResource", () => ({
  useVisualizationStateResource: () => ({
    data: { active_quantity_id: "m", overrides: [] },
    status: "ready",
  }),
}));

import { AirboxMeshParametersPanel } from "./airbox/AirboxMeshParametersPanel";
import { AirboxMeshBuildPanel } from "./airbox/AirboxMeshBuildPanel";
import { AirboxMeshQualityGatesPanel } from "./airbox/AirboxMeshQualityGatesPanel";
import { AirboxMeshStatisticsPanel } from "./airbox/AirboxMeshStatisticsPanel";
import { AirboxMeshTopologyPanel } from "./airbox/AirboxMeshTopologyPanel";
import { AirboxMeshOverviewPanel } from "./airbox/AirboxMeshOverviewPanel";
import { AirboxOverviewPanel } from "./airbox/AirboxOverviewPanel";
import {
  ObjectMeshPolicyPanel,
  ObjectMeshTransactionsSection,
} from "./ObjectMeshPolicyPanel";
import { ObjectRegionMeshPanel } from "./region/ObjectRegionMeshPanel";

const objectSelection: Selection = {
  kind: "object.mesh",
  label: "Waveguide mesh",
  moduleSource: "inspector",
  nodeId: "object:waveguide:mesh",
  objectId: "waveguide",
  ref: null,
};

const airboxSelection: Selection = {
  kind: "airbox.mesh",
  label: "Airbox mesh",
  moduleSource: "inspector",
  nodeId: "airbox:mesh",
  objectId: null,
  ref: null,
};

const airboxQualitySelection: Selection = {
  kind: "airbox.mesh.statistics",
  label: "Airbox quality",
  moduleSource: "inspector",
  nodeId: "airbox:mesh-quality",
  objectId: null,
  ref: null,
};

describe("scoped mesh quality panels", () => {
  it("renders region quality and element-size histograms in the region mesh panel", () => {
    const html = renderToStaticMarkup(
      <ObjectRegionMeshPanel
        addMaterialOverride={vi.fn()}
        applyRegion={vi.fn()}
        buildRegion={vi.fn()}
        canWriteRegion
        couplingDependencies={[]}
        deleteRegion={vi.fn()}
        draftDirty={false}
        meshLane="fem"
        draft={{
          enabled: true,
          frame: "object",
          materialOverrides: [],
          meshPolicy: {
            enabled: true,
            maximumElementSize: 6e-9,
            minimumElementSize: 2e-9,
            order: 1,
            transitionDistance: 10e-9,
          },
          name: "core",
          ownerBounds: null,
          priority: 10,
          realizationPolicy: "conformal",
          shape: {
            axis: [0, 0, 1],
            center: [0, 0, 0],
            height: 1,
            kind: "box",
            radius: 1,
            size: [1, 1, 1],
          },
        }}
        duplicateRegion={vi.fn()}
        feedback={null}
        materialFields={null}
        model={{
          diagnosticCount: 0,
          diagnostics: [],
          effectiveMagnetizationRef: "m0",
          enabled: true,
          errorCount: 0,
          frame: "object",
          magnetizationRef: "m0",
          materialFieldCount: 0,
          materialOverrideCount: 0,
          materialOverrides: [],
          materialRef: "permalloy",
          meshPolicy: {
            enabled: true,
            maximumElementSize: 6e-9,
            minimumElementSize: 2e-9,
            order: 1,
            transitionDistance: 10e-9,
          },
          mode: "committed",
          objectId: "film",
          ownerBounds: null,
          priority: 10,
          realizationPolicy: "conformal",
          realizationStatus: "realized",
          regionId: "film:core",
          regionMagnetizationRef: "inherits object",
          regionName: "core",
          revision: 3,
          shape: {
            axis: [0, 0, 1],
            center: [0, 0, 0],
            height: 1,
            kind: "box",
            radius: 1,
            size: [1, 1, 1],
          },
          source: "authored_object_region",
          textureAssignment: "inherited",
          textureOverrideKind: "none",
          warningCount: 0,
        }}
        pending={false}
        regionMeshLifecycle={{
          generationId: "generation-3",
          membershipRevision: 4,
          reason: "Certified conformal mesh membership is current.",
          status: "current",
          topologyFingerprint: "topology-3",
        }}
        removeMaterialOverride={vi.fn()}
        revert={vi.fn()}
        updateDraft={vi.fn()}
        updateMaterialOverride={vi.fn()}
        updateMeshPolicy={vi.fn()}
        updateShape={vi.fn()}
        updateShapeVector={vi.fn()}
      />,
    );

    expect(html).toContain("Region Quality Distributions");
    expect(html).toContain("SICN");
    expect(html).toContain("Gamma");
    expect(html).toContain("Element size distributions");
    expect(html).toContain("Tetra size");
    expect(html).toContain("Worst elements");
    expect(html).toContain("region:film:core");
  });

  it("keeps object mesh quality unmounted while Policy is active", () => {
    const html = renderToStaticMarkup(
      <ObjectMeshPolicyPanel selection={objectSelection} />,
    );

    expect(html).toContain("Object Mesh Policy");
    expect(html).toContain("Effective Target");
    expect(html).toContain("Object Core Relaxation");
    expect(html).not.toContain("Object Quality Distributions");
  });

  it("renders capability-gated topology authoring without presenting hex as available", () => {
    const html = renderToStaticMarkup(
      <ObjectMeshPolicyPanel selection={objectSelection} />,
    );

    expect(html).toContain("Free tetrahedral");
    expect(html).toContain("Layered prism (exact)");
    expect(html).toContain("Swept hex — unsupported");
    expect(html).toMatch(/<option disabled=""[^>]*value="swept_hex"/);
    expect(html).not.toMatch(/<option disabled=""[^>]*value="swept_prism"/);
    expect(html).toContain("Maximum element size");
    expect(html).toContain("Minimum element size");
    expect(html).toContain("Resulting node planes");
    expect(html).toContain("2");
    expect(html).toContain("pyramid_to_tetrahedra");
    expect(html).toContain("strict: none");
    expect(html).toContain("layer-convergence evidence");
  });

  it("gives every native object-policy option an explicit canonical value", () => {
    const html = renderToStaticMarkup(
      <ObjectMeshPolicyPanel selection={objectSelection} />,
    );
    const optionTags = html.match(/<option\b[^>]*>/g) ?? [];

    expect(optionTags.length).toBeGreaterThan(0);
    expect(optionTags.every((tag) => /\bvalue=/.test(tag))).toBe(true);
    expect(html).toContain('<option value="fixed">Fixed</option>');
    expect(html).toContain('<option value="triangular">Triangular</option>');
    expect(html).toContain('<option value="true">Enabled</option>');
    expect(html).toContain('<option value="false">Disabled</option>');
    expect(html).toContain('<option value="HighOrder">High order</option>');
    expect(html).toContain('<option value="Relocate3D">Relocate 3D</option>');
  });

  it("disables layered prism authoring when its capability is semantic-only", () => {
    mixedTopologyCapabilityStatus.value = "semantic_only";
    try {
      const html = renderToStaticMarkup(
        <ObjectMeshPolicyPanel selection={objectSelection} />,
      );

      expect(html).toMatch(/<option disabled=""[^>]*value="swept_prism"/);
      expect(html).toContain("semantic_only");
    } finally {
      mixedTopologyCapabilityStatus.value = "validated";
    }
  });

  it("warns when object mesh policy edits are not applied", () => {
    const html = renderToStaticMarkup(
      <Accordion type="multiple" defaultValue={["transactions"]}>
        <ObjectMeshTransactionsSection
          buildLabel="Apply & Build Mesh"
          feedback={null}
          isDirty
          objectId="waveguide"
          onApply={vi.fn()}
          onBuild={vi.fn()}
          onRevert={vi.fn()}
          pending={false}
        />
      </Accordion>,
    );

    expect(html).toContain("Unapplied changes");
    expect(html).toContain("Apply Policy or Apply &amp; Build Mesh");
  });

  it("warns when airbox mesh policy edits are not applied", () => {
    const html = renderToStaticMarkup(
      <AirboxMeshParametersPanel
        selection={{ ...airboxSelection, kind: "airbox.mesh.parameters" }}
      />,
    );

    expect(html).toContain("Transactions");
    expect(html).toContain("Apply Airbox Policy");
  });

  it("renders airbox quality histograms in the airbox mesh panel", () => {
    const html = renderToStaticMarkup(
      <AirboxMeshStatisticsPanel selection={airboxQualitySelection} />,
    );

    expect(html).toContain("Shared-domain Quality Distributions");
    expect(html).toContain("cross-reference, not Airbox-scoped");
    expect(html).toContain("SICN");
    expect(html).toContain("Gamma");
    expect(html).toContain("Below target");
    expect(html).toContain("Element size distributions");
    expect(html).toContain("Tetra size");
    expect(html).toContain("Airbox Mesh Statistics");
    expect(html).toContain("Points / nodes");
    expect(html).toContain("12,345");
    expect(html).toContain("Volume elements");
    expect(html).toContain("59,244");
    expect(html).toContain("tet4");
    expect(html).toContain("59,000");
    expect(html).toContain("pyramid5");
    expect(html).toContain("244");
    expect(html).toContain("shared, not exclusive Airbox memory");
  });

  it("renders airbox mesh policy inputs in the airbox mesh panel", () => {
    const html = renderToStaticMarkup(
      <AirboxMeshParametersPanel
        selection={{ ...airboxSelection, kind: "airbox.mesh.parameters" }}
      />,
    );

    expect(html).toContain("Canonical Authored Parameters");
    expect(html).toContain("Maximum element size");
    expect(html).toContain("Minimum element size");
    expect(html).toContain("Maximum element growth rate");
    expect(html).toContain("Curvature factor");
    expect(html).toContain("Airbox Geometry");
    expect(html).toContain("Padding X");
    expect(html).toContain("Size X");
    expect(html).toContain("Effective maximum element size");
    expect(html).toContain("Effective domain mode");
    expect(html).toContain("Effective center");
    expect(html).toContain("Unknown effective keys");
    expect(html).not.toContain("ż".repeat(513));
  });

  it("labels absent Airbox-scoped quality gates as unknown backend evidence", () => {
    const html = renderToStaticMarkup(
      <AirboxMeshQualityGatesPanel
        selection={{ ...airboxSelection, kind: "airbox.mesh.quality-gates" }}
      />,
    );

    expect(html).toContain("Airbox-scoped quality gates are not published");
    expect(html).toContain("unknown");
    expect(html).toContain("ui-derived");
    expect(html).toContain("cross-reference only");
  });

  it("renders topology metadata from the manifest without a binary topology hook", () => {
    const html = renderToStaticMarkup(
      <AirboxMeshTopologyPanel
        selection={{ ...airboxSelection, kind: "airbox.mesh.topology" }}
      />,
    );

    expect(html).toContain("Airbox Mesh Topology");
    expect(html).toContain("part:__air__");
    expect(html).toContain("explicit node_indices");
    expect(html).toContain("explicit boundary_face_indices");
    expect(html).toContain("generation-3");
    expect(html).toContain("Shared-interface caveat");
    expect(html).toContain("Canonical marker");
    expect(html).toContain("not published");
    expect(html).toContain("binary topology is not refetched");
  });

  it("renders approved Airbox overview and mesh overview facts", () => {
    const overview = renderToStaticMarkup(<AirboxOverviewPanel selection={airboxSelection} />);
    const mesh = renderToStaticMarkup(<AirboxMeshOverviewPanel selection={airboxSelection} />);

    expect(overview).toContain("manual");
    expect(overview).toContain("1e-7, 2e-7, 3e-7");
    expect(overview).toContain("0.000001, 0.000002, 0.000003");
    expect(overview).toContain("12,345");
    expect(overview).toContain("59,244");
    expect(overview).toContain("Active quantity");
    expect(overview).toContain("m");
    expect(overview).toContain("Shortcuts");
    expect(mesh).toContain("2e-8");
    expect(mesh).toContain("Parameters status");
    expect(mesh).toContain("Quality Gates status");
    expect(mesh).toContain("Statistics status");
    expect(mesh).toContain("Topology status");
    expect(mesh).toContain("Build status");
    expect(mesh).not.toContain("Child status:");
    expect(mesh).toContain("4e-9");
    expect(mesh).toContain("Last build summary");
  });

  it("bounds shared-domain quality cross-reference strings and collections", () => {
    const html = renderToStaticMarkup(<AirboxMeshStatisticsPanel selection={airboxQualitySelection} />);
    expect(html).toContain("Shared-domain cross-reference");
    expect(html).not.toContain("warning-50-");
    expect(html).not.toContain("界".repeat(513));
  });

  it("renders degraded build lifecycle and the direct backend reason", () => {
    const html = renderToStaticMarkup(
      <AirboxMeshBuildPanel
        selection={{ ...airboxSelection, kind: "airbox.mesh.build" }}
      />,
    );

    expect(html).toContain("degraded");
    expect(html).toContain("tetrahedralization failed");
    expect(html).toContain("Current build revision");
  });
});
