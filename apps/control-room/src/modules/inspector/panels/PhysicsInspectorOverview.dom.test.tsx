import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PhysicsInspectorOverview } from "./PhysicsInspectorOverview";

describe("PhysicsInspectorOverview", () => {
  it("shows scope, dependency, solver and diagnostics sections with SI values", () => {
    const html = renderToStaticMarkup(
      <PhysicsInspectorOverview
        actions={<button type="button">Apply</button>}
        model={{
          dependency: {
            requiredSourceIds: ["current:main"],
            reason: "Current source is absent.",
            status: "blocked",
          },
          execution: {
            capability: "semantic_only",
            graphRevision: 3,
            requestedLane: "fem",
            resolvedLane: null,
            sceneRevision: 7,
          },
          family: "spin_torque",
          scope: {
            kind: "object",
            label: "Object",
            objectId: "free-layer",
            stableRef: "object:free-layer",
          },
          source: {
            id: "torque:stt",
            kind: "spin_torque",
            path: "scene.spin_torques[0]",
            status: "blocked",
          },
          status: "blocked",
          statusReason: "No current transport module is present.",
          values: [{ label: "Current density", unit: "A/m²", value: "1e11" }],
        }}
      />,
    );

    expect(html).toContain("Scope");
    expect(html).toContain("object:free-layer");
    expect(html).toContain("Dependency");
    expect(html).toContain("Solver / Execution");
    expect(html).toContain("Diagnostics");
    expect(html).toContain("Current density");
    expect(html).toContain("A/m²");
    expect(html).toContain("No current transport module is present.");
    expect(html).toContain('data-slot="inspector-overview-actions"');
    expect(html).toContain('aria-label="Inspector overview actions"');
    expect(html).toContain('role="group"');
    expect(html).toContain('data-state="blocked"');

    const disclosureTriggers = html.match(/data-slot="inspector-group-trigger"/g) ?? [];
    const disclosureControls = html.match(/aria-controls="[^"]+"/g) ?? [];
    expect(disclosureTriggers).toHaveLength(5);
    expect(disclosureControls).toHaveLength(5);
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('aria-expanded="false"');
  });

  it("renders an explicit absent state without an editable default payload", () => {
    const html = renderToStaticMarkup(
      <PhysicsInspectorOverview
        model={{
          family: "oersted_field",
          scope: { kind: "global", stableRef: "global:physics" },
          source: { id: "none", kind: "oersted_field", status: "absent" },
          status: "absent",
        }}
      />,
    );

    expect(html).toContain("Absent");
    expect(html).toContain("No editable physics module is selected.");
    expect(html).not.toContain("Create");
  });
});
