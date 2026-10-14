import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const kernelMock = vi.hoisted(() => ({
  api: {},
  bus: { emit: vi.fn(), on: () => () => undefined },
  commands: { execute: vi.fn() },
  diagnosticRecorder: { record: vi.fn() },
  resources: {
    get: () => null,
    getRevision: () => 1,
    invalidate: vi.fn(),
    subscribe: () => () => undefined,
  },
  selection: { set: vi.fn() },
}));

vi.mock("@/kernel/KernelContext", async () => {
  const { createContext } = await import("react");
  return {
    KernelContext: createContext<unknown>(kernelMock),
    useKernel: () => kernelMock,
  };
});

vi.mock("@/kernel/resources/useSessionStatus", () => ({
  useSessionResourceIdentity: () => ({
    requestScopeEpoch: "1",
    sessionEpoch: "1",
    sessionId: "session-fem",
  }),
  useSessionStatusSelector: (selector: (value: never) => unknown) =>
    selector({
      data: {
        domain: { discretization: "fem" },
        resources: {
          mesh_build_revision: 0,
          mesh_revision: 0,
          scene_revision: 2,
        },
      },
    } as never),
}));

vi.mock("@/kernel/resources/geometryLifecycleResources", () => {
  const ready = <T,>(data: T) => ({
    data,
    error: null,
    refetch: vi.fn(),
    revision: 1,
    status: "ready" as const,
  });
  return {
    useGeometryValidationResource: () => ready({ errors: [], valid: true }),
    useMeshBuildCurrent: () => ready(null),
    useMeshBuildLatestSuccessful: () => ready(null),
    useMeshQualityGatesResource: () => ready(null),
    useMeshSemanticsResource: () => ready(null),
    useMeshSharedDomainPolicyResource: () =>
      ready({
        config: null,
        effective_config: { maximum_element_size: 5e-9, minimum_element_size: 1e-9 },
        revision: 0,
      }),
    useMeshSummaryResource: () =>
      ready({
        revision: 0,
      }),
    useObjectMeshPolicyResource: () =>
      ready({
        config: null,
        effective_config: null,
        object_id: "disk-1",
        revision: 0,
      }),
    useSceneResource: () =>
      ready({
        objects: [
          {
            id: "disk-1",
            material_ref: "Permalloy",
            name: "CoFeB Disk",
          },
        ],
        scene_revision: 2,
      }),
    useUniverseMeshPolicyResource: () =>
      ready({
        config: null,
        effective_config: {
          airbox_grading: "geometric",
          airbox_growth_rate: 1.3,
          airbox_hmax: 2e-8,
          airbox_hmin: 2e-9,
          mode: "auto",
        },
        revision: 0,
      }),
  };
});

import { FemMeshReadinessGuideCard } from "./FemMeshReadinessGuideCard";

describe("FemMeshReadinessGuideCard", () => {
  it("renders the interactive 6-step quest checklist, progress bar, parameter chips, and recommended action in FEM mode", () => {
    const markup = renderToStaticMarkup(
      <FemMeshReadinessGuideCard selectedObjectId="disk-1" />,
    );

    expect(markup).toContain("FEM Mesh Readiness Guide");
    expect(markup).toContain("Needs Mesh Build (2/3)");
    expect(markup).toContain("1. Scene Geometry &amp; Validation");
    expect(markup).toContain("2. Object Material Assignment");
    expect(markup).toContain("3. Airbox &amp; Exterior Domain Policy");
    expect(markup).toContain("4. Per-Object Mesh Sizing &amp; Strategy");
    expect(markup).toContain("5. Shared-Domain FEM Mesh Build");
    expect(markup).toContain("6. Mesh Quality Gates &amp; Inspection");
    expect(markup).toContain("Build Shared-Domain Mesh");
  });

  it("collapses quest list by default when compact=true while keeping the next-step banner", () => {
    const markup = renderToStaticMarkup(
      <FemMeshReadinessGuideCard compact selectedObjectId="disk-1" />,
    );

    expect(markup).toContain("FEM Mesh Readiness Guide");
    expect(markup).toContain("Build Shared-Domain Mesh");
    expect(markup).not.toContain("1. Scene Geometry &amp; Validation");
  });
});
