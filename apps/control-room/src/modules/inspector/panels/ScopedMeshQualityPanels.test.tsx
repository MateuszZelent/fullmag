import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { Selection } from "@/kernel/selection/selectionTypes";

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
    resources: {
      invalidate: vi.fn(),
    },
  }),
}));

vi.mock("@/kernel/resources/studyRuntimeResources", () => ({
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
  useMeshSharedDomainManifestResource: () => ({
    data: {
      domain_mesh_mode: "shared_domain_mesh_with_air",
      mesh_id: "study_domain:3",
      mesh_name: "study_domain",
      mesh_parts: [
        {
          boundary_face_count: 12,
          boundary_face_indices: [0, 1, 2],
          boundary_face_start: 0,
          element_count: 59_244,
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
      quality: qualityPayload,
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
      config: null,
      revision: 3,
    },
    error: null,
    refetch: vi.fn(),
    revision: 3,
    status: "ready",
  }),
}));

import { AirboxMeshPolicyPanel } from "./AirboxMeshPolicyPanel";
import { ObjectMeshPolicyPanel } from "./ObjectMeshPolicyPanel";

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

describe("scoped mesh quality panels", () => {
  it("renders object quality histograms in the object mesh panel", () => {
    const html = renderToStaticMarkup(
      <ObjectMeshPolicyPanel selection={objectSelection} />,
    );

    expect(html).toContain("Object Quality Distributions");
    expect(html).toContain("SICN");
    expect(html).toContain("Gamma");
    expect(html).toContain("Below target");
    expect(html).toContain("Element size distributions");
    expect(html).toContain("object:waveguide");
    expect(html).toContain("Size from curvature");
    expect(html).toContain("Narrow regions");
    expect(html).toContain("Object Core Relaxation");
    expect(html).toContain("Core maximum element size");
    expect(html).toContain("Edge distance");
    expect(html).toContain("Size-field kinds");
    expect(html).toContain("ObjectCoreRelaxation");
  });

  it("renders airbox quality histograms in the airbox mesh panel", () => {
    const html = renderToStaticMarkup(
      <AirboxMeshPolicyPanel selection={airboxSelection} />,
    );

    expect(html).toContain("Airbox Quality Distributions");
    expect(html).toContain("SICN");
    expect(html).toContain("Gamma");
    expect(html).toContain("Below target");
    expect(html).toContain("Element size distributions");
    expect(html).toContain("Airbox Mesh Part");
    expect(html).toContain("Points / nodes");
    expect(html).toContain("12,345");
    expect(html).toContain("Tetrahedra");
    expect(html).toContain("59,244");
    expect(html).toContain("explicit node_indices");
  });
});
