import { describe, expect, it } from "vitest";

import {
  FREQUENCY_DOMAIN_INSPECTOR_SELECTION_KINDS,
  resolveInspectorPanel,
} from "./inspectorRegistry";
import {
  ObjectRegionTexturePanel,
  ObjectRegionVisualizationPanel,
} from "./panels/ObjectRegionsPanel";

describe("inspectorRegistry", () => {
  it("resolves geometry object selections to their correct panels", () => {
    expect(resolveInspectorPanel({ kind: "object.root" })?.id).toBe(
      "object-general",
    );
    expect(resolveInspectorPanel({ kind: "object.geometry" })?.id).toBe(
      "geometry-object",
    );
  });

  it("resolves object physics selections to the physics interaction panel", () => {
    expect(resolveInspectorPanel({ kind: "object.physics" })?.id).toBe(
      "physics-interaction",
    );
    expect(resolveInspectorPanel({ kind: "physics.coupling" })?.id).toBe(
      "physics-coupling",
    );
  });

  it("resolves object material selections to the material assignment panel", () => {
    expect(resolveInspectorPanel({ kind: "object.material" })?.id).toBe(
      "object-material",
    );
    expect(resolveInspectorPanel({ kind: "object.magnetic-parameters" })?.id).toBe(
      "object-material",
    );
  });

  it("resolves object region and magnetic texture groups", () => {
    expect(resolveInspectorPanel({ kind: "object.regions" })?.id).toBe(
      "object-regions",
    );
    expect(resolveInspectorPanel({ kind: "object.region" })?.id).toBe(
      "object-region",
    );
    expect(resolveInspectorPanel({ kind: "object.region.geometry" })?.id).toBe(
      "object-region-geometry",
    );
    expect(resolveInspectorPanel({ kind: "object.region.shape" })?.id).toBe(
      "object-region-geometry",
    );
    expect(
      resolveInspectorPanel({ kind: "object.region.magnetic-parameters" })?.id,
    ).toBe("object-region-magnetic-parameters");
    expect(resolveInspectorPanel({ kind: "object.region.material" })?.id).toBe(
      "object-region-magnetic-parameters",
    );
    expect(resolveInspectorPanel({ kind: "object.region.mesh" })?.id).toBe(
      "object-region-mesh",
    );
    expect(resolveInspectorPanel({ kind: "object.region.regions" })?.id).toBe(
      "object-region-regions",
    );
    expect(resolveInspectorPanel({ kind: "object.region.diagnostics" })?.id).toBe(
      "object-region-diagnostics",
    );
    expect(resolveInspectorPanel({ kind: "object.region.texture" })?.id).toBe(
      "object-region-texture",
    );
    expect(resolveInspectorPanel({ kind: "object.region.texture" })?.component).toBe(
      ObjectRegionTexturePanel,
    );
    expect(
      resolveInspectorPanel({ kind: "object.region-magnetic-texture" })?.id,
    ).toBe("object-region-texture");
    expect(resolveInspectorPanel({ kind: "object.region.visualization" })?.id).toBe(
      "object-region-visualization",
    );
    expect(
      resolveInspectorPanel({ kind: "object.region.visualization" })?.component,
    ).toBe(ObjectRegionVisualizationPanel);
    expect(resolveInspectorPanel({ kind: "object.magnetic-texture" })?.id).toBe(
      "object-magnetic-texture",
    );
    expect(
      resolveInspectorPanel({ kind: "object.magnetic-texture.asset" })?.id,
    ).toBe("object-magnetic-texture");
    expect(
      resolveInspectorPanel({ kind: "object.magnetic-texture.load" })?.id,
    ).toBe("object-magnetic-texture");
    expect(
      resolveInspectorPanel({ kind: "object.magnetic-texture.transform" })?.id,
    ).toBe("object-magnetic-texture");
  });

  it("resolves object mesh selections to the object mesh policy panel", () => {
    expect(resolveInspectorPanel({ kind: "object.mesh" })?.id).toBe(
      "object-mesh-policy",
    );
  });

  it("falls back to the placeholder panel for known but unsupported selections", () => {
    expect(resolveInspectorPanel({ kind: "results.field_quantity" })?.id).toBe(
      "placeholder",
    );
  });

  it("resolves object and airbox visualization selections to the visualization panel", () => {
    expect(resolveInspectorPanel({ kind: "object.visualization" })?.id).toBe(
      "object-visualization",
    );
    expect(resolveInspectorPanel({ kind: "airbox.visualization" })?.id).toBe(
      "object-visualization",
    );
  });

  it("resolves Airbox mesh policy selections to the Airbox mesh policy panel", () => {
    expect(resolveInspectorPanel({ kind: "airbox.mesh" })?.id).toBe(
      "airbox-mesh-policy",
    );
  });

  it("resolves Airbox mesh quality selections to the Airbox mesh quality panel", () => {
    expect(resolveInspectorPanel({ kind: "airbox.mesh-quality" })?.id).toBe(
      "airbox-mesh-quality",
    );
  });

  it("resolves cross-section selections to the cross-section inspector", () => {
    expect(resolveInspectorPanel({ kind: "mesh.cross-section" })?.id).toBe(
      "cross-section",
    );
    expect(resolveInspectorPanel({ kind: "mesh.cross-section.draft" })?.id).toBe(
      "cross-section",
    );
    expect(resolveInspectorPanel({ kind: "mesh.cross-section.plot" })?.id).toBe(
      "cross-section",
    );
  });

  it("routes study root separately from concrete study stage inspectors", () => {
    expect(resolveInspectorPanel({ kind: "study.root" })?.id).toBe(
      "study-root",
    );
    expect(resolveInspectorPanel({ kind: "study.stage.relax" })?.id).toBe(
      "study-stage",
    );
    expect(resolveInspectorPanel({ kind: "study.stage.run" })?.id).toBe(
      "study-stage",
    );
    expect(resolveInspectorPanel({ kind: "study.stage.hysteresis" })?.id).toBe(
      "study-stage",
    );
    expect(
      resolveInspectorPanel({ kind: "study.stage.frequency_response" })?.id,
    ).toBe("study-stage");
    expect(
      resolveInspectorPanel({ kind: "study.stage.frequency_response.excitation" })
        ?.id,
    ).toBe("frequency-domain");
    expect(resolveInspectorPanel({ kind: "study.stage.save_state" })?.id).toBe(
      "study-stage",
    );
  });

  it("routes frequency-domain stage child nodes to the frequency-domain inspector", () => {
    expect(resolveInspectorPanel({ kind: "study.stage.eigenmodes.setup" })?.id).toBe(
      "frequency-domain",
    );
    expect(
      resolveInspectorPanel({ kind: "study.stage.eigenmodes.calculation_mode" })
        ?.id,
    ).toBe("frequency-domain");
    expect(
      resolveInspectorPanel({ kind: "study.stage.eigenmodes.equilibrium" })?.id,
    ).toBe("frequency-domain");
    expect(
      resolveInspectorPanel({ kind: "study.stage.eigenmodes.operator" })?.id,
    ).toBe("frequency-domain");
    expect(
      resolveInspectorPanel({ kind: "study.stage.eigenmodes.boundary" })?.id,
    ).toBe("frequency-domain");
    expect(
      resolveInspectorPanel({ kind: "study.stage.eigenmodes.k_path" })?.id,
    ).toBe("frequency-domain");
    expect(
      resolveInspectorPanel({ kind: "study.stage.eigenmodes.periodic_pairs" })?.id,
    ).toBe("frequency-domain");
    expect(
      resolveInspectorPanel({ kind: "study.stage.eigenmodes.solver" })?.id,
    ).toBe("frequency-domain");
    expect(
      resolveInspectorPanel({ kind: "study.stage.eigenmodes.outputs" })?.id,
    ).toBe("frequency-domain");
    expect(
      resolveInspectorPanel({ kind: "study.stage.eigenmodes.diagnostics" })?.id,
    ).toBe("frequency-domain");
    expect(
      resolveInspectorPanel({ kind: "study.stage.frequency_response.setup" })?.id,
    ).toBe("frequency-domain");
    expect(
      resolveInspectorPanel({
        kind: "study.stage.frequency_response.calculation_mode",
      })?.id,
    ).toBe("frequency-domain");
    expect(
      resolveInspectorPanel({
        kind: "study.stage.frequency_response.equilibrium",
      })?.id,
    ).toBe("frequency-domain");
    expect(
      resolveInspectorPanel({ kind: "study.stage.frequency_response.operator" })
        ?.id,
    ).toBe("frequency-domain");
    expect(
      resolveInspectorPanel({ kind: "study.stage.frequency_response.boundary" })
        ?.id,
    ).toBe("frequency-domain");
    expect(
      resolveInspectorPanel({
        kind: "study.stage.frequency_response.periodic_pairs",
      })?.id,
    ).toBe("frequency-domain");
    expect(
      resolveInspectorPanel({ kind: "study.stage.frequency_response.k_grid" })?.id,
    ).toBe("frequency-domain");
    expect(
      resolveInspectorPanel({ kind: "study.stage.frequency_response.sweep" })?.id,
    ).toBe("frequency-domain");
    expect(
      resolveInspectorPanel({ kind: "study.stage.frequency_response.solver" })?.id,
    ).toBe("frequency-domain");
    expect(
      resolveInspectorPanel({ kind: "study.stage.frequency_response.outputs" })?.id,
    ).toBe("frequency-domain");
    expect(
      resolveInspectorPanel({
        kind: "study.stage.frequency_response.diagnostics",
      })?.id,
    ).toBe("frequency-domain");
  });

  it("routes all frequency-domain result, resource, job, and diagnostic nodes away from placeholder", () => {
    for (const kind of FREQUENCY_DOMAIN_INSPECTOR_SELECTION_KINDS) {
      expect(resolveInspectorPanel({ kind })?.id, kind).toBe("frequency-domain");
    }
  });

  it("returns null when there is no selection kind", () => {
    expect(resolveInspectorPanel({ kind: null })).toBeNull();
  });
});
