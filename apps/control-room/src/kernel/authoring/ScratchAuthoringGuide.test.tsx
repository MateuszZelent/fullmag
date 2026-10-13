import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { ModelReadinessResource } from "../api/apiTypes";
import type { KernelApi } from "../types";
import type { ResourceResult } from "../resources/resourceTypes";
import { ScratchAuthoringGuide } from "./ScratchAuthoringGuide";

function renderGuide(
  readiness: ModelReadinessResource,
  status: ResourceResult<ModelReadinessResource>["status"] = "ready",
): string {
  const kernel = {
    commands: { execute: vi.fn() },
    layout: {
      openBottomPanel: vi.fn(),
      setPanelVisible: vi.fn(),
    },
    selection: { set: vi.fn() },
  } as unknown as KernelApi;

  return renderToStaticMarkup(
    <ScratchAuthoringGuide
      commandContext={{} as never}
      kernel={kernel}
      readiness={{
        data: readiness,
        error: null,
        refetch: vi.fn(),
        revision: readiness.scene_revision,
        status,
      }}
    />,
  );
}

function readinessWithChecks(
  checks: ModelReadinessResource["checks"],
  overrides: Partial<ModelReadinessResource> = {},
): ModelReadinessResource {
  return {
    blockers: [],
    capabilities: {
      move: { available: true, reason: null },
      rotate: { available: true, reason: null },
      scale: { available: true, reason: null },
    },
    checks,
    ready_to_export: false,
    ready_to_run: false,
    scene_revision: 17,
    ...overrides,
  };
}

describe("ScratchAuthoringGuide", () => {
  it("renders an incomplete checklist, an always-available refresh, and unknown checks", () => {
    const markup = renderGuide(
      readinessWithChecks([
        {
          id: "geometry",
          label: "Geometry",
          reason: "Add at least one magnetic object.",
          state: "blocked",
        },
        {
          id: "future-check",
          label: "Future check",
          reason: "Review this target.",
          state: "blocked",
          target_resource: "future/resource/1",
        },
      ]),
    );

    expect(markup).toContain('data-readiness-revision="17"');
    expect(markup).toContain("Check readiness");
    expect(markup).toContain("Hide steps");
    expect(markup).toContain("Add at least one magnetic object.");
    expect(markup).toContain("Future check");
    expect(markup).toContain("Open Explorer");
    expect(markup).toContain("future/resource/1");
  });

  it("keeps a stale readiness check visibly out of date", () => {
    const markup = renderGuide(
      readinessWithChecks([
        {
          id: "discretization",
          label: "Discretization",
          reason: "Mesh is out of date.",
          state: "stale",
          target_resource: "meshing/builds/current",
        },
      ]),
      "stale",
    );

    expect(markup).toContain('data-check-state="stale"');
    expect(markup).toContain("Out of date");
    expect(markup).toContain("Mesh is out of date.");
    expect(markup).toContain("Build FEM mesh");
    expect(markup).toContain("Cached result: server reported not ready to run.");
    expect(markup).toContain("Readiness data is out of date.");
  });

  it("reports an empty model as not ready and preserves extra server blockers", () => {
    const markup = renderGuide(
      readinessWithChecks([], {
        blockers: ["A server-side validation rule is not satisfied."],
        ready_to_run: false,
      }),
    );

    expect(markup).toContain("Server reports not ready to run.");
    expect(markup).toContain("The readiness resource did not report any checks.");
    expect(markup).toContain("A server-side validation rule is not satisfied.");
    expect(markup).toContain("View diagnostics");
    expect(markup).not.toContain("All reported checks are complete.");
  });

  it("keeps domain and execution configuration actions available after checks complete", () => {
    const markup = renderGuide(
      readinessWithChecks(
        [
          { id: "domain", label: "Domain", reason: null, state: "complete" },
          { id: "execution", label: "Execution", reason: null, state: "complete" },
        ],
        { ready_to_run: true },
      ),
    );

    expect(markup).toContain("Server reports ready to run.");
    expect(markup).toContain("Configure domain");
    expect(markup).toContain("Configure run settings");
  });

  it("does not infer readiness when the server returns no checks or blocker details", () => {
    const markup = renderGuide(
      readinessWithChecks([], { blockers: [], ready_to_run: false }),
    );

    expect(markup).toContain("Server reports not ready to run.");
    expect(markup).toContain(
      "The server reports that this model is not ready to run, but did not report an incomplete check or additional blocker detail.",
    );
  });
});
