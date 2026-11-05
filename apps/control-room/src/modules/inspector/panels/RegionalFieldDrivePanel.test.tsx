import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { KernelContext } from "@/kernel/KernelContext";
import type { KernelApi } from "@/kernel/types";

vi.mock("@/kernel/resources/fieldDriveResources", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/kernel/resources/fieldDriveResources")
  >();
  return {
    ...actual,
    useFieldDrivesResource: () => ({
      data: {
        scene_revision: 11,
        drives: [{
          activation: { kind: "all_time_evolution" },
          amplitude_B_T: 1e-3,
          direction: [0, 1, 0],
          enabled: true,
          id: "field-drive",
          kind: "regional",
          name: "Existing",
          spatial_profile: { kind: "uniform" },
          target: { kind: "global" },
          time_origin: "stage_local",
          waveform: { kind: "constant" },
        }],
      },
      status: "ready",
    }),
  };
});

vi.mock("@/kernel/resources/geometryLifecycleResources", () => ({
  useSceneResource: () => ({ data: { objects: [] }, status: "ready" }),
}));

import { RegionalFieldDrivePanel } from "./RegionalFieldDrivePanel";

const kernel = {
  api: { model: {} },
  commands: { getSessionScopeKey: () => null },
  resources: { invalidate: vi.fn() },
  selection: { set: vi.fn() },
} as unknown as KernelApi;

describe("RegionalFieldDrivePanel create mode", () => {
  it("renders a configured global draft with an editable unique ID", () => {
    const html = renderToStaticMarkup(
      <KernelContext.Provider value={kernel}>
        <RegionalFieldDrivePanel selection={{
          kind: "physics.field-drive",
          label: "New field drive",
          moduleSource: "ribbon",
          nodeId: "model:physics:field-drive:draft",
          objectId: null,
          ref: {
            draft: true,
            kind: "physics.field-drive",
            nodeId: "model:physics:field-drive:draft",
            type: "physics-field-drive",
          },
        }} />
      </KernelContext.Provider>,
    );

    expect(html).toContain("Configured");
    expect(html).toContain('aria-label="ID"');
    expect(html).toContain('value="field-drive-2"');
    expect(html).toContain('value="global" selected=""');
    expect(html).not.toContain("Selected field drive is unavailable");
  });

  it("renders a collection overview when the parent physics.field-drives node is selected", () => {
    const html = renderToStaticMarkup(
      <KernelContext.Provider value={kernel}>
        <RegionalFieldDrivePanel
          sectionScope="list"
          selection={{
            kind: "physics.field-drives",
            label: "Field Drives",
            moduleSource: "explorer",
            nodeId: "model:physics:field-drives",
            objectId: null,
          }}
        />
      </KernelContext.Provider>,
    );

    expect(html).toContain("Field Drives");
    expect(html).toContain("Existing");
    expect(html).toContain("constant · 1 mT · active");
    expect(html).toContain("Inspect Drive");
    expect(html).toContain("New Field Drive");
    expect(html).not.toContain("Selected field drive is unavailable");
  });
});
