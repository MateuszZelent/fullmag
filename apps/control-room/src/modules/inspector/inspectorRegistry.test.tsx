import { describe, expect, it } from "vitest";

import {
  FREQUENCY_DOMAIN_INSPECTOR_SELECTION_KINDS,
  resolveInspectorPanel,
} from "./inspectorRegistry";
import {
  resolveInspectorRoute,
  resolveUnknownInspectorRoute,
} from "./inspectorRouteCatalog";
import { ObjectRegionVisualizationTemplatePanel } from "./panels/visualization/TargetVisualizationSpecs";
import {
  AirboxMeshBuildInspectorSpecPanel,
  AirboxMeshInspectorSpecPanel,
  AirboxMeshParametersInspectorSpecPanel,
  AirboxMeshQualityGatesInspectorSpecPanel,
  AirboxMeshStatisticsInspectorSpecPanel,
  AirboxMeshTopologyInspectorSpecPanel,
  AirboxMultilayerTargetInspectorSpecPanel,
  AirboxRootInspectorSpecPanel,
} from "./panels/airbox/AirboxAndBoundarySpecs";
import { AirboxVisualizationDebugInspectorPanel } from "./panels/airbox/AirboxVisualizationDebugInspectorPanel";
import {
  FdmCellInspectorSpecPanel,
  FdmGridInspectorSpecPanel,
} from "./panels/fdm-grid/FdmGridAndCellSpecs";
import { MagneticTextureInspectorPanel } from "./panels/magnetic-texture/MagneticTextureInspectorPanel";
import { FmrComparisonInspectorPanel } from "./panels/frequency-domain/FrequencyDomainResultInspectors";
import {
  DispersionDrivenStageResultInspector,
  DispersionModalStageResultInspector,
  DispersionResponseFieldAtKResultInspector,
  DynamicsResultInspector,
  ResonanceDrivenStageResultInspector,
  ResonanceModalStageResultInspector,
} from "./panels/physics-first/PhysicsFirstResultInspectors";
import {
  EigenmodesStageOverviewInspectorPanel,
  FrequencyResponseStageOverviewInspectorPanel,
  StudyStageInspectorRouter,
} from "./panels/StudyStageInspectorRouter";

function frequencyDomainPanelId(kind: string): string {
  return `frequency-domain-${kind.replace(/[.:]/g, "-")}`;
}

describe("inspectorRegistry", () => {
  it("does not retain orphan mode-visualization child routes", () => {
    expect(resolveInspectorRoute("object.mode_visualization")?.id).toBe(
      "object-mode-visualization-overview",
    );
    expect(resolveInspectorRoute("object.mode_visualization.group")).toBeNull();
    expect(resolveInspectorRoute("object.mode_visualization.field")).toBeNull();
    expect(resolveInspectorRoute("object.mode_visualization.view")).toBeNull();
  });

  it("routes a pinned Quick Chart to its preview-only Inspector", () => {
    expect(resolveInspectorPanel({ kind: "results.quick_chart" })?.id).toBe(
      "quick-chart",
    );
  });

  it("gives runtime tree roots dedicated Inspectors and redirects resource diagnostics to runtime resources", () => {
    expect(resolveInspectorPanel({ kind: "resources.root" })?.component.name).toBe(
      "ResourcesOverviewInspectorPanel",
    );
    expect(resolveInspectorPanel({ kind: "jobs.root" })?.component.name).toBe(
      "JobsOverviewInspectorPanel",
    );
    expect(resolveInspectorPanel({ kind: "diagnostics.root" })?.component.name).toBe(
      "DiagnosticsOverviewInspectorPanel",
    );
    expect(resolveInspectorPanel({ kind: "diagnostics.resource" })?.component.name).toBe(
      "RuntimeResourceInspectorPanel",
    );
  });

  it("keeps every semantic explorer kind on an explicit Inspector route", () => {
    for (const kind of [
      "session.root",
      "universe.root",
      "objects.root",
      "definitions.root",
      "model.planar.monitors",
      "object.physics.scope",
      "mesh.unassigned",
      "mesh.unassigned.part",
      "visualizations-2d.root",
      "visualizations-2d.draft",
      "visualizations-2d.parameter",
      "visualizations-2d.plot",
      "physics.couplings",
      "physics.scope.global",
      "physics.scope.cross-object",
      "physics.scope.unresolved",
    ]) {
      expect(resolveInspectorRoute(kind), kind).not.toBeNull();
    }
  });

  it("resolves Live Chart and Live Chart point selections to their own Inspector", () => {
    expect(resolveInspectorPanel({ kind: "live.chart" })?.id).toBe("live-chart");
    expect(resolveInspectorPanel({ kind: "live.chart-point" })?.id).toBe(
      "live-chart-point",
    );
  });

  it("resolves geometry object selections to their correct panels", () => {
    expect(resolveInspectorPanel({ kind: "object.root" })?.id).toBe(
      "object-general",
    );
    expect(resolveInspectorPanel({ kind: "object.geometry" })?.id).toBe(
      "geometry-object",
    );
    expect(
      resolveInspectorPanel({ kind: "object.extension.topological-charge" })?.id,
    ).toBe("object-extension-topological-charge");
  });

  it("resolves object physics selections to the physics interaction panel", () => {
    expect(resolveInspectorPanel({ kind: "object.physics" })?.id).toBe(
      "physics-interaction",
    );
    expect(resolveInspectorPanel({ kind: "physics.coupling" })?.id).toBe(
      "physics-coupling",
    );
    for (const legacyKind of [
      "physics.current-transports",
      "physics.spin-transports",
      "physics.spin-interfaces",
      "physics.spin-torques",
      "physics.oersted-fields",
    ]) {
      expect(resolveInspectorPanel({ kind: legacyKind } as never)).toBeNull();
    }
    expect(resolveInspectorPanel({ kind: "physics.current-transport" })?.id).toBe(
      "physics-current-transport",
    );
    expect(resolveInspectorPanel({ kind: "physics.spin-transport" })?.id).toBe(
      "physics-spin-transport",
    );
    expect(resolveInspectorPanel({ kind: "physics.spin-interface" })?.id).toBe(
      "physics-spin-interface",
    );
    expect(resolveInspectorPanel({ kind: "physics.spin-torque" })?.id).toBe(
      "physics-spin-torque",
    );
    expect(resolveInspectorPanel({ kind: "physics.oersted-field" })?.id).toBe(
      "physics-oersted-field",
    );
  });

  it("uses the racetrack transport vocabulary for dedicated inspector routes", () => {
    expect(resolveInspectorRoute("physics.current-transport")?.title).toBe(
      "Charge transport",
    );
    expect(resolveInspectorRoute("physics.spin-transport")?.title).toBe(
      "Spin transport",
    );
    expect(resolveInspectorRoute("physics.spin-interface")?.title).toBe(
      "HM/FM interface",
    );
    expect(resolveInspectorRoute("physics.spin-torque")?.title).toBe(
      "Transport torque",
    );
  });

  it("resolves object material selections and redirects legacy magnetic-parameters to object.material", () => {
    expect(resolveInspectorPanel({ kind: "object.material" })?.id).toBe(
      "object-material-assignment",
    );
    expect(resolveInspectorPanel({ kind: "object.absorbing-boundary" })?.id).toBe(
      "object-absorbing-boundary",
    );
    expect(resolveInspectorPanel({ kind: "object.magnetic-parameters" })?.id).toBe(
      "object-material-assignment",
    );
  });

  it("resolves only the canonical mode visualization owner panel", () => {
    expect(resolveInspectorPanel({ kind: "object.mode_visualization" })?.id).toBe(
      "object-mode-visualization-overview",
    );
  });

  it("resolves object region and magnetic texture groups through canonical routes and redirects", () => {
    expect(resolveInspectorPanel({ kind: "object.regions" })?.id).toBe(
      "object-regions",
    );
    expect(resolveInspectorPanel({ kind: "object.region" })?.id).toBe(
      "object-region",
    );
    expect(resolveInspectorPanel({ kind: "object.region.geometry" })?.id).toBe(
      "object-region",
    );
    expect(resolveInspectorPanel({ kind: "object.region.shape" })?.id).toBe(
      "object-region",
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
      "object-region",
    );
    expect(resolveInspectorPanel({ kind: "object.region.diagnostics" })?.id).toBe(
      "object-region",
    );
    expect(resolveInspectorPanel({ kind: "object.region.texture" })?.id).toBe(
      "object-region-texture",
    );
    expect(resolveInspectorPanel({ kind: "object.region.texture" })?.component).toBe(
      MagneticTextureInspectorPanel,
    );
    expect(
      resolveInspectorPanel({ kind: "object.region-magnetic-texture" })?.id,
    ).toBe("object-region-texture");
    expect(
      resolveInspectorPanel({ kind: "object.region-magnetic-texture" })?.component,
    ).toBe(MagneticTextureInspectorPanel);
    expect(resolveInspectorPanel({ kind: "object.region.visualization" })?.id).toBe(
      "object-region-visualization",
    );
    expect(
      resolveInspectorPanel({ kind: "object.region.visualization" })?.component,
    ).toBe(ObjectRegionVisualizationTemplatePanel);
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

  it("consolidates legacy magnetic texture asset, load, and transform aliases into object.magnetic-texture", () => {
    const canonical = resolveInspectorPanel({ kind: "object.magnetic-texture" });
    const panels = [
      resolveInspectorPanel({ kind: "object.magnetic-texture.asset" }),
      resolveInspectorPanel({ kind: "object.magnetic-texture.load" }),
      resolveInspectorPanel({ kind: "object.magnetic-texture.transform" }),
    ];

    expect(new Set(panels.map((panel) => panel?.id))).toEqual(
      new Set(["object-magnetic-texture"]),
    );
    expect(panels.every((panel) => panel?.component === canonical?.component)).toBe(
      true,
    );
  });

  it("resolves object mesh selections to the object mesh policy panel", () => {
    expect(resolveInspectorPanel({ kind: "object.mesh" })?.id).toBe(
      "object-mesh-policy",
    );
  });

  it("registers dedicated Mesh routes for each global mesh scope", () => {
    const expected = new Map([
      ["mesh.root", "mesh-details"],
      ["mesh.shared-domain", "mesh-shared-domain"],
      ["mesh.builds", "mesh-builds"],
      ["mesh.quality", "mesh-quality"],
      ["mesh.size-fields", "mesh-size-fields"],
      ["mesh.regions", "mesh-regions"],
      ["object.mesh", "object-mesh-policy"],
      ["object.region.mesh", "object-region-mesh"],
      ["airbox.mesh", "airbox-mesh-overview"],
    ] as const);

    for (const [kind, panelId] of expected) {
      expect(resolveInspectorPanel({ kind })?.id, kind).toBe(panelId);
      expect(resolveInspectorPanel({ kind })?.id).not.toBe("placeholder");
    }
  });

  it("keeps FDM grid as a technical detail below the product-level Mesh contract", () => {
    expect(resolveInspectorPanel({ kind: "mesh.root" })?.title).toBe("Mesh");
    expect(resolveInspectorPanel({ kind: "mesh.grid.descriptor" })?.title).toBe(
      "FDM Mesh",
    );
  });

  it("consolidates structured FDM grid sub-nodes onto mesh.grid while keeping fdm.cell distinct", () => {
    const gridSubKinds = [
      "mesh.grid",
      "mesh.grid.descriptor",
      "mesh.grid.magnetic-support",
      "mesh.grid.active-unassigned",
      "mesh.grid.mask",
      "mesh.grid.provenance",
      "mesh.grid.region",
      "mesh.grid.universe-outside-support",
    ] as const;

    const gridPanels = gridSubKinds.map((kind) => resolveInspectorPanel({ kind }));
    const cellPanel = resolveInspectorPanel({ kind: "fdm.cell" });

    expect(gridPanels.every((panel) => panel?.id === "fdm-grid")).toBe(true);
    expect(
      gridPanels.every((panel) => panel?.component === FdmGridInspectorSpecPanel),
    ).toBe(true);
    expect(cellPanel?.id).toBe("fdm-cell");
    expect(cellPanel?.component).toBe(FdmCellInspectorSpecPanel);
  });

  it("does not prefix-match a future structured-grid node", () => {
    expect(resolveInspectorRoute("mesh.grid.future-detail")).toBeNull();
    expect(resolveInspectorPanel({ kind: "mesh.grid.future-detail" })).toBeNull();
    expect(resolveUnknownInspectorRoute().contribution.id).toBe("placeholder");
  });

  it("routes field quantities to a dedicated scientific inspector", () => {
    expect(resolveInspectorPanel({ kind: "results.field_quantity" })?.id).toBe(
      "field-quantity",
    );
  });

  it("routes analysis-result selections to the typed result inspector", () => {
    expect(resolveInspectorPanel({ kind: "analysis.result" })?.id).toBe(
      "analysis-result",
    );
  });

  it("routes canonical hysteresis datasets to the dedicated hysteresis dataset inspector", () => {
    expect(resolveInspectorPanel({ kind: "results.hysteresis.dataset" })?.id).toBe(
      "results-hysteresis-dataset",
    );
  });

  it("redirects legacy time-domain selections to their canonical dynamics and dispersion owners", () => {
    const spectral = resolveInspectorPanel({
      kind: "results.time_domain.spectral_feature",
    });
    expect(spectral?.id).toBe("frequency-domain-results-dynamics-root");
    expect(spectral?.component).toBe(DynamicsResultInspector);

    const dsfPoint = resolveInspectorPanel({
      kind: "results.time_domain.dsf_point",
    });
    expect(dsfPoint?.id).toBe(
      "frequency-domain-results-dispersion-driven-field_at_k",
    );
    expect(dsfPoint?.component).toBe(DispersionResponseFieldAtKResultInspector);
  });

  it("routes the Results root to a Results overview rather than Field Quantity", () => {
    expect(resolveInspectorPanel({ kind: "results.root" })?.component.name).toBe(
      "ResultsOverviewInspectorPanel",
    );
  });

  it("keeps Airbox, object, and mesh-part visualization owners distinct", () => {
    expect(resolveInspectorPanel({ kind: "airbox.visualization" })?.id).toBe(
      "airbox-visualization",
    );
    expect(resolveInspectorPanel({ kind: "object.visualization" })?.id).toBe(
      "object-visualization",
    );
    expect(resolveInspectorPanel({ kind: "mesh-part" })?.id).toBe(
      "mesh-part-visualization",
    );
  });

  it("gives the multilayer Airbox target its own inspector", () => {
    const panel = resolveInspectorPanel({ kind: "airbox.multilayer.target" });
    expect(panel?.id).toBe("fdm-multilayer-airbox-target");
    expect(panel?.component).toBe(AirboxMultilayerTargetInspectorSpecPanel);
  });

  it("gives every Airbox mesh branch a distinct single-purpose panel", () => {
    const expected = [
      ["airbox.root", "airbox-overview", AirboxRootInspectorSpecPanel],
      ["airbox.mesh", "airbox-mesh-overview", AirboxMeshInspectorSpecPanel],
      [
        "airbox.mesh.parameters",
        "airbox-mesh-parameters",
        AirboxMeshParametersInspectorSpecPanel,
      ],
      [
        "airbox.mesh.quality-gates",
        "airbox-mesh-quality-gates",
        AirboxMeshQualityGatesInspectorSpecPanel,
      ],
      [
        "airbox.mesh.statistics",
        "airbox-mesh-statistics",
        AirboxMeshStatisticsInspectorSpecPanel,
      ],
      ["airbox.mesh.topology", "airbox-mesh-topology", AirboxMeshTopologyInspectorSpecPanel],
      ["airbox.mesh.build", "airbox-mesh-build", AirboxMeshBuildInspectorSpecPanel],
    ] as const;

    for (const [kind, panelId, component] of expected) {
      const panel = resolveInspectorPanel({ kind });
      expect(panel?.id).toBe(panelId);
      expect(panel?.component).toBe(component);
    }
    expect(new Set(expected.map(([, panelId]) => panelId)).size).toBe(
      expected.length,
    );
    expect(resolveInspectorPanel({ kind: "airbox.visualization" })?.id).toBe(
      "airbox-visualization",
    );
  });

  it("routes the Universe Boundary Faces node to its dedicated overview", () => {
    expect(resolveInspectorPanel({ kind: "boundary-faces.root" })?.id).toBe(
      "boundary-faces-overview",
    );
  });

  it("uses distinct Debug routes and owner components", () => {
    const kinds = [
      "airbox.visualization.debug",
      "object.visualization.debug",
      "object.region.visualization.debug",
    ] as const;

    const panels = kinds.map((kind) => resolveInspectorPanel({ kind }));

    expect(panels.map((panel) => panel?.id)).toEqual([
      "airbox-visualization-debug",
      "object-visualization-debug",
      "object-region-visualization-debug",
    ]);
    expect(new Set(panels.map((panel) => panel?.component)).size).toBe(3);
    expect(new Set(kinds).size).toBe(3);
    expect(panels[0]?.component).toBe(AirboxVisualizationDebugInspectorPanel);
  });

  it("redirects legacy cross-section selections to canonical visualizations-2d routes", () => {
    expect(resolveInspectorPanel({ kind: "mesh.cross-section" })?.id).toBe(
      "visualizations-2d-root",
    );
    expect(resolveInspectorPanel({ kind: "mesh.cross-section.draft" })?.id).toBe(
      "visualizations-2d-draft",
    );
    expect(resolveInspectorPanel({ kind: "mesh.cross-section.plot" })?.id).toBe(
      "visualizations-2d-plot",
    );
  });

  it("resolves planar monitor drafts independently from legacy cross-section images", () => {
    expect(
      resolveInspectorPanel({ kind: "model.planar.monitor.draft" })?.id,
    ).toBe("planar-monitor-draft");
  });

  it("routes study root separately from concrete study stage inspectors", () => {
    expect(resolveInspectorPanel({ kind: "study.root" })?.id).toBe(
      "study-root",
    );
    expect(resolveInspectorPanel({ kind: "study.stage.relax" })?.id).toBe(
      "study-stage-relax",
    );
    expect(resolveInspectorPanel({ kind: "study.stage.run" })?.id).toBe(
      "study-stage-run",
    );
    expect(
      resolveInspectorPanel({ kind: "study.stage.change_device" })?.id,
    ).toBe("study-stage-change-device");
    expect(resolveInspectorPanel({ kind: "study.stage.hysteresis" })?.id).toBe(
      "study-stage-hysteresis",
    );
    expect(
      resolveInspectorPanel({ kind: "study.stage.frequency_response" })?.id,
    ).toBe(frequencyDomainPanelId("study.stage.frequency_response"));
    expect(resolveInspectorPanel({ kind: "study.stage.eigenmodes" })?.id).toBe(
      frequencyDomainPanelId("study.stage.eigenmodes"),
    );
    expect(
      resolveInspectorPanel({ kind: "study.stage.frequency_response.excitation" })
        ?.id,
    ).toBe(frequencyDomainPanelId("study.stage.frequency_response"));
    expect(resolveInspectorPanel({ kind: "study.stage.save_state" })?.id).toBe(
      "study-stage-save-state",
    );
  });

  it.each([
    ["study.stage.eigenmodes", "study.stage.eigenmodes", EigenmodesStageOverviewInspectorPanel],
    ["study.stage.eigenmodes.setup", "study.stage.eigenmodes", EigenmodesStageOverviewInspectorPanel],
    [
      "study.stage.eigenmodes.calculation_mode",
      "study.stage.eigenmodes",
      EigenmodesStageOverviewInspectorPanel,
    ],
    [
      "study.stage.eigenmodes.equilibrium",
      "study.stage.eigenmodes",
      EigenmodesStageOverviewInspectorPanel,
    ],
    ["study.stage.eigenmodes.operator", "study.stage.eigenmodes", EigenmodesStageOverviewInspectorPanel],
    ["study.stage.eigenmodes.boundary", "study.stage.eigenmodes", EigenmodesStageOverviewInspectorPanel],
    [
      "study.stage.eigenmodes.periodic_pairs",
      "study.stage.eigenmodes",
      EigenmodesStageOverviewInspectorPanel,
    ],
    ["study.stage.eigenmodes.k_path", "study.stage.eigenmodes", EigenmodesStageOverviewInspectorPanel],
    ["study.stage.eigenmodes.solver", "study.stage.eigenmodes", EigenmodesStageOverviewInspectorPanel],
    ["study.stage.eigenmodes.outputs", "study.stage.eigenmodes", EigenmodesStageOverviewInspectorPanel],
    [
      "study.stage.eigenmodes.diagnostics",
      "study.stage.eigenmodes",
      EigenmodesStageOverviewInspectorPanel,
    ],
    [
      "study.stage.frequency_response",
      "study.stage.frequency_response",
      FrequencyResponseStageOverviewInspectorPanel,
    ],
    [
      "study.stage.frequency_response.setup",
      "study.stage.frequency_response",
      FrequencyResponseStageOverviewInspectorPanel,
    ],
    [
      "study.stage.frequency_response.calculation_mode",
      "study.stage.frequency_response",
      FrequencyResponseStageOverviewInspectorPanel,
    ],
    [
      "study.stage.frequency_response.equilibrium",
      "study.stage.frequency_response",
      FrequencyResponseStageOverviewInspectorPanel,
    ],
    [
      "study.stage.frequency_response.operator",
      "study.stage.frequency_response",
      FrequencyResponseStageOverviewInspectorPanel,
    ],
    [
      "study.stage.frequency_response.boundary",
      "study.stage.frequency_response",
      FrequencyResponseStageOverviewInspectorPanel,
    ],
    [
      "study.stage.frequency_response.periodic_pairs",
      "study.stage.frequency_response",
      FrequencyResponseStageOverviewInspectorPanel,
    ],
    [
      "study.stage.frequency_response.k_grid",
      "study.stage.frequency_response",
      FrequencyResponseStageOverviewInspectorPanel,
    ],
    [
      "study.stage.frequency_response.excitation",
      "study.stage.frequency_response",
      FrequencyResponseStageOverviewInspectorPanel,
    ],
    [
      "study.stage.frequency_response.sweep",
      "study.stage.frequency_response",
      FrequencyResponseStageOverviewInspectorPanel,
    ],
    [
      "study.stage.frequency_response.solver",
      "study.stage.frequency_response",
      FrequencyResponseStageOverviewInspectorPanel,
    ],
    [
      "study.stage.frequency_response.outputs",
      "study.stage.frequency_response",
      FrequencyResponseStageOverviewInspectorPanel,
    ],
    [
      "study.stage.frequency_response.diagnostics",
      "study.stage.frequency_response",
      FrequencyResponseStageOverviewInspectorPanel,
    ],
  ])(
    "consolidates frequency-domain stage node %s onto canonical stage route %s",
    (kind, canonicalKind, expectedComponent) => {
      const panel = resolveInspectorPanel({ kind });
      expect(panel?.id).toBe(frequencyDomainPanelId(canonicalKind));
      expect(panel?.component).toBe(expectedComponent);
      expect(panel?.component).not.toBe(StudyStageInspectorRouter);
    },
  );

  it("routes all canonical frequency-domain selection kinds away from placeholder", () => {
    for (const kind of FREQUENCY_DOMAIN_INSPECTOR_SELECTION_KINDS) {
      expect(resolveInspectorPanel({ kind })?.id, kind).toBe(
        frequencyDomainPanelId(kind),
      );
    }
  });

  it("redirects retired solver-first frequency-domain aliases to physics-first canonical owners", () => {
    expect(resolveInspectorPanel({ kind: "results.frequency_domain.root" })?.id).toBe(
      frequencyDomainPanelId("results.resonance.root"),
    );
    expect(resolveInspectorPanel({ kind: "results.frequency_domain.run" })?.id).toBe(
      "results-overview",
    );
    expect(
      resolveInspectorPanel({ kind: "results.frequency_domain.calculation_modes" })?.id,
    ).toBe(frequencyDomainPanelId("results.resonance.root"));
    expect(
      resolveInspectorPanel({ kind: "results.frequency_domain.dispersion" })?.id,
    ).toBe(frequencyDomainPanelId("results.dispersion.root"));
    expect(
      resolveInspectorPanel({ kind: "results.frequency_domain.response_map" })?.id,
    ).toBe(frequencyDomainPanelId("results.dispersion.driven.response_map"));
    expect(resolveInspectorPanel({ kind: "results.frequency_domain.fmr" })?.id).toBe(
      frequencyDomainPanelId("results.resonance.root"),
    );
    expect(
      resolveInspectorPanel({ kind: "results.frequency_domain.fmr_modal_spectrum" })?.id,
    ).toBe(frequencyDomainPanelId("results.resonance.modal.spectrum"));
    expect(
      resolveInspectorPanel({ kind: "results.frequency_domain.fmr_peaks" })?.id,
    ).toBe(frequencyDomainPanelId("results.resonance.driven.peaks"));
    expect(
      resolveInspectorPanel({ kind: "results.frequency_domain.fmr_peak" })?.id,
    ).toBe(frequencyDomainPanelId("results.resonance.driven.peaks"));
    expect(
      resolveInspectorPanel({ kind: "results.frequency_domain.comparison" })?.component,
    ).toBe(FmrComparisonInspectorPanel);
    expect(
      resolveInspectorPanel({ kind: "results.frequency_domain.exports" })?.id,
    ).toBe(frequencyDomainPanelId("results.exports.root"));
    expect(resolveInspectorPanel({ kind: "results.eigen.root" })?.id).toBe(
      frequencyDomainPanelId("results.resonance.modal.stage"),
    );
    expect(resolveInspectorPanel({ kind: "results.eigen.mode" })?.id).toBe(
      frequencyDomainPanelId("results.resonance.modal.mode"),
    );
    expect(resolveInspectorPanel({ kind: "results.eigen.branches" })?.id).toBe(
      frequencyDomainPanelId("results.dispersion.modal.branches"),
    );
    expect(
      resolveInspectorPanel({ kind: "results.frequency_response.root" })?.id,
    ).toBe(frequencyDomainPanelId("results.resonance.driven.stage"));
    expect(
      resolveInspectorPanel({ kind: "results.frequency_response.sweep" })?.id,
    ).toBe(frequencyDomainPanelId("results.resonance.driven.spectrum"));
  });

  it("folds physics-first provenance nodes into their parent stage inspectors", () => {
    expect(
      resolveInspectorPanel({ kind: "results.resonance.modal.provenance" })
        ?.component,
    ).toBe(ResonanceModalStageResultInspector);
    expect(
      resolveInspectorPanel({ kind: "results.resonance.driven.provenance" })
        ?.component,
    ).toBe(ResonanceDrivenStageResultInspector);
    expect(
      resolveInspectorPanel({ kind: "results.dispersion.modal.provenance" })
        ?.component,
    ).toBe(DispersionModalStageResultInspector);
    expect(
      resolveInspectorPanel({ kind: "results.dispersion.driven.provenance" })
        ?.component,
    ).toBe(DispersionDrivenStageResultInspector);
  });

  it("routes every non-authoring frequency-domain node to a dedicated inspector", () => {
    const kinds = FREQUENCY_DOMAIN_INSPECTOR_SELECTION_KINDS.filter(
      (kind) => !kind.startsWith("study.stage."),
    );
    const components = kinds.map(
      (kind) => resolveInspectorPanel({ kind })?.component,
    );

    expect(components.every((component) => component !== undefined)).toBe(true);
  });

  it("routes each postprocessing definition family to a distinct dedicated Inspector", () => {
    const kinds = [
      "results.analysis_views.definition",
      "results.derived_values.definition",
      "results.tables.definition",
      "results.exports.definition",
    ];
    const components = kinds.map((kind) => resolveInspectorPanel({ kind })?.component);

    expect(components.every((component) => component !== undefined)).toBe(true);
    expect(new Set(components).size).toBe(kinds.length);
  });

  it("gives every physics-first Results kind its own inspector component owner", () => {
    const kinds = [
      "results.dynamics.root",
      "results.resonance.root",
      "results.resonance.modal.stage",
      "results.resonance.driven.stage",
      "results.resonance.modal.spectrum",
      "results.resonance.modal.modes",
      "results.resonance.modal.mode",
      "results.resonance.modal.coupling",
      "results.resonance.driven.spectrum",
      "results.resonance.driven.peaks",
      "results.resonance.driven.fields",
      "results.resonance.driven.field",
      "results.dispersion.root",
      "results.dispersion.modal.stage",
      "results.dispersion.driven.stage",
      "results.dispersion.k_sampling",
      "results.dispersion.modal.relation",
      "results.dispersion.modal.branches",
      "results.dispersion.modal.modes_at_k",
      "results.dispersion.modal.mode_at_k",
      "results.dispersion.driven.response_map",
      "results.dispersion.driven.field_at_k",
      "results.hysteresis.root",
      "results.analysis_views.root",
      "results.analysis_views.definition",
      "results.derived_values.root",
      "results.derived_values.definition",
      "results.tables.root",
      "results.tables.definition",
      "results.exports.root",
      "results.exports.definition",
    ] as const;
    const components = kinds.map(
      (kind) => resolveInspectorPanel({ kind })?.component,
    );

    expect(components.every((component) => component !== undefined)).toBe(true);
    expect(new Set(components).size).toBe(kinds.length);
  });

  it("returns null when there is no selection kind", () => {
    expect(resolveInspectorPanel({ kind: null })).toBeNull();
  });
});
