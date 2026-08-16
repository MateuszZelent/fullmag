import { describe, expect, it } from "vitest";

import {
  FREQUENCY_DOMAIN_INSPECTOR_SELECTION_KINDS,
  resolveInspectorPanel,
} from "./inspectorRegistry";
import {
  resolveInspectorRoute,
  resolveUnknownInspectorRoute,
} from "./inspectorRouteCatalog";
import { ObjectRegionVisualizationPanel } from "./panels/ObjectRegionsPanel";
import {
  AirboxMeshBuildLanePanel,
  AirboxMeshOverviewLanePanel,
  AirboxMeshParametersLanePanel,
  AirboxMeshQualityGatesLanePanel,
  AirboxMeshStatisticsLanePanel,
  AirboxMeshTopologyLanePanel,
  AirboxOverviewLanePanel,
} from "./panels/airbox/AirboxInspectorLanePanel";
import { FdmMultilayerAirboxTargetPanel } from "./panels/airbox/FdmMultilayerAirboxTargetPanel";
import { AirboxVisualizationDebugInspectorPanel } from "./panels/airbox/AirboxVisualizationDebugInspectorPanel";
import {
  FdmCellInspectorPanel,
  FdmGridActiveUnassignedInspectorPanel,
  FdmGridDescriptorInspectorPanel,
  FdmGridInspectorPanelRoute,
  FdmGridMagneticSupportInspectorPanel,
  FdmGridMaskInspectorPanel,
  FdmGridProvenanceInspectorPanel,
  FdmGridRegionInspectorPanel,
  FdmGridUniverseOutsideSupportInspectorPanel,
  ObjectMagneticTextureAssetInspectorPanel,
  ObjectMagneticTextureLoadInspectorPanel,
  ObjectMagneticTextureTransformInspectorPanel,
  ObjectRegionMagneticTextureInspectorPanel,
  ObjectRegionTextureInspectorPanel,
} from "./panels/DedicatedExplorerInspectorPanels";
import {
  EigenModeInspectorPanel,
  EigenBranchInspectorPanel,
  EigenBranchesInspectorPanel,
  EigenDiagnosticsInspectorPanel,
  EigenKPathInspectorPanel,
  EigenDispersionInspectorPanel,
  EigenModesInspectorPanel,
  EigenOverviewInspectorPanel,
  EigenProvenanceInspectorPanel,
  EigenSpectrumInspectorPanel,
  EigenStudyInspectorPanel,
  FrequencyDomainCalculationModesInspectorPanel,
  FrequencyDomainDispersionInspectorPanel,
  FrequencyDomainExportsInspectorPanel,
  FrequencyDomainOverviewInspectorPanel,
  FrequencyDomainResponseMapInspectorPanel,
  FrequencyDomainRunInspectorPanel,
  FrequencyResponseOverviewInspectorPanel,
  FrequencyResponseCancelRequestedInspectorPanel,
  FrequencyResponseDiagnosticsInspectorPanel,
  FrequencyResponseObservableInspectorPanel,
  FrequencyResponseObservablesInspectorPanel,
  FrequencyResponseFrequencyPointsInspectorPanel,
  FrequencyResponsePointInspectorPanel,
  FrequencyResponseProvenanceInspectorPanel,
  FrequencyResponseProgressInspectorPanel,
  FrequencyResponseStudyInspectorPanel,
  FrequencyResponseSweepInspectorPanel,
  FmrComparisonInspectorPanel,
  FmrModalSpectrumInspectorPanel,
  FmrOverviewInspectorPanel,
  FmrPeakInspectorPanel,
  FmrPeaksInspectorPanel,
} from "./panels/frequency-domain/FrequencyDomainResultInspectors";
import {
  DispersionDrivenProvenanceResultInspector,
  DispersionModalProvenanceResultInspector,
  ResonanceDrivenProvenanceResultInspector,
  ResonanceModalProvenanceResultInspector,
} from "./panels/physics-first/PhysicsFirstResultInspectors";
import {
  EigenmodesBoundaryStageInspectorPanel,
  EigenmodesCalculationModeStageInspectorPanel,
  EigenmodesDiagnosticsStageInspectorPanel,
  EigenmodesEquilibriumStageInspectorPanel,
  EigenmodesKPathStageInspectorPanel,
  EigenmodesOperatorStageInspectorPanel,
  EigenmodesOutputsStageInspectorPanel,
  EigenmodesPeriodicPairsStageInspectorPanel,
  EigenmodesSetupStageInspectorPanel,
  EigenmodesSolverStageInspectorPanel,
  EigenmodesStageOverviewInspectorPanel,
  FrequencyResponseBoundaryStageInspectorPanel,
  FrequencyResponseCalculationModeStageInspectorPanel,
  FrequencyResponseDiagnosticsStageInspectorPanel,
  FrequencyResponseEquilibriumStageInspectorPanel,
  FrequencyResponseExcitationStageInspectorPanel,
  FrequencyResponseKGridStageInspectorPanel,
  FrequencyResponseOperatorStageInspectorPanel,
  FrequencyResponseOutputsStageInspectorPanel,
  FrequencyResponsePeriodicPairsStageInspectorPanel,
  FrequencyResponseSetupStageInspectorPanel,
  FrequencyResponseSolverStageInspectorPanel,
  FrequencyResponseStageOverviewInspectorPanel,
  FrequencyResponseSweepStageInspectorPanel,
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

  it("gives runtime tree roots and resource diagnostics dedicated Inspectors", () => {
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
      "RuntimeResourceDiagnosticInspectorPanel",
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

  it("resolves object material selections to the material assignment panel", () => {
    expect(resolveInspectorPanel({ kind: "object.material" })?.id).toBe(
      "object-material-assignment",
    );
    expect(resolveInspectorPanel({ kind: "object.magnetic-parameters" })?.id).toBe(
      "object-material",
    );
  });

  it("resolves only the canonical mode visualization owner panel", () => {
    expect(resolveInspectorPanel({ kind: "object.mode_visualization" })?.id).toBe(
      "object-mode-visualization-overview",
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
      "object-region-shape",
    );
    expect(
      resolveInspectorPanel({ kind: "object.region.magnetic-parameters" })?.id,
    ).toBe("object-region-magnetic-parameters");
    expect(resolveInspectorPanel({ kind: "object.region.material" })?.id).toBe(
      "object-region-material",
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
      ObjectRegionTextureInspectorPanel,
    );
    expect(
      resolveInspectorPanel({ kind: "object.region-magnetic-texture" })?.id,
    ).toBe("object-region-magnetic-texture");
    expect(
      resolveInspectorPanel({ kind: "object.region-magnetic-texture" })?.component,
    ).toBe(ObjectRegionMagneticTextureInspectorPanel);
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
    ).toBe("object-magnetic-texture-asset");
    expect(
      resolveInspectorPanel({ kind: "object.magnetic-texture.load" })?.id,
    ).toBe("object-magnetic-texture-load");
    expect(
      resolveInspectorPanel({ kind: "object.magnetic-texture.transform" })?.id,
    ).toBe("object-magnetic-texture-transform");
  });

  it("keeps magnetic texture asset, load, and transform routes independently addressable", () => {
    const panels = [
      resolveInspectorPanel({ kind: "object.magnetic-texture.asset" }),
      resolveInspectorPanel({ kind: "object.magnetic-texture.load" }),
      resolveInspectorPanel({ kind: "object.magnetic-texture.transform" }),
    ];

    expect(new Set(panels.map((panel) => panel?.id)).size).toBe(3);
    expect(panels.map((panel) => panel?.component)).toEqual([
      ObjectMagneticTextureAssetInspectorPanel,
      ObjectMagneticTextureLoadInspectorPanel,
      ObjectMagneticTextureTransformInspectorPanel,
    ]);
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
      "FDM Grid Descriptor",
    );
  });

  it("routes every structured FDM grid node and FDM cell to the dedicated grid inspector", () => {
    const kinds = [
      "mesh.grid",
      "mesh.grid.descriptor",
      "mesh.grid.magnetic-support",
      "mesh.grid.active-unassigned",
      "mesh.grid.mask",
      "mesh.grid.provenance",
      "mesh.grid.region",
      "mesh.grid.universe-outside-support",
      "fdm.cell",
    ] as const;

    const panels = kinds.map((kind) => resolveInspectorPanel({ kind }));

    expect(panels.map((panel) => panel?.id)).toEqual([
      "fdm-grid",
      "fdm-grid-descriptor",
      "fdm-grid-magnetic-support",
      "fdm-grid-active-unassigned",
      "fdm-grid-mask",
      "fdm-grid-provenance",
      "fdm-grid-region",
      "fdm-grid-universe-outside-support",
      "fdm-cell",
    ]);
    expect(panels.map((panel) => panel?.component)).toEqual([
      FdmGridInspectorPanelRoute,
      FdmGridDescriptorInspectorPanel,
      FdmGridMagneticSupportInspectorPanel,
      FdmGridActiveUnassignedInspectorPanel,
      FdmGridMaskInspectorPanel,
      FdmGridProvenanceInspectorPanel,
      FdmGridRegionInspectorPanel,
      FdmGridUniverseOutsideSupportInspectorPanel,
      FdmCellInspectorPanel,
    ]);
    expect(panels.every((panel) => panel?.id !== "placeholder")).toBe(true);
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
    expect(panel?.component).toBe(FdmMultilayerAirboxTargetPanel);
  });

  it("gives every Airbox mesh branch a distinct single-purpose panel", () => {
    const expected = [
      ["airbox.root", "airbox-overview", AirboxOverviewLanePanel],
      ["airbox.mesh", "airbox-mesh-overview", AirboxMeshOverviewLanePanel],
      [
        "airbox.mesh.parameters",
        "airbox-mesh-parameters",
        AirboxMeshParametersLanePanel,
      ],
      [
        "airbox.mesh.quality-gates",
        "airbox-mesh-quality-gates",
        AirboxMeshQualityGatesLanePanel,
      ],
      [
        "airbox.mesh.statistics",
        "airbox-mesh-statistics",
        AirboxMeshStatisticsLanePanel,
      ],
      ["airbox.mesh.topology", "airbox-mesh-topology", AirboxMeshTopologyLanePanel],
      ["airbox.mesh.build", "airbox-mesh-build", AirboxMeshBuildLanePanel],
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

  it("resolves cross-section selections to the cross-section inspector", () => {
    expect(resolveInspectorPanel({ kind: "mesh.cross-section" })?.id).toBe(
      "cross-section",
    );
    expect(resolveInspectorPanel({ kind: "mesh.cross-section.draft" })?.id).toBe(
      "cross-section-draft",
    );
    expect(resolveInspectorPanel({ kind: "mesh.cross-section.plot" })?.id).toBe(
      "cross-section-plot",
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
    ).toBe(frequencyDomainPanelId("study.stage.frequency_response.excitation"));
    expect(resolveInspectorPanel({ kind: "study.stage.save_state" })?.id).toBe(
      "study-stage-save-state",
    );
  });

  it.each([
    ["study.stage.eigenmodes", EigenmodesStageOverviewInspectorPanel],
    ["study.stage.eigenmodes.setup", EigenmodesSetupStageInspectorPanel],
    [
      "study.stage.eigenmodes.calculation_mode",
      EigenmodesCalculationModeStageInspectorPanel,
    ],
    [
      "study.stage.eigenmodes.equilibrium",
      EigenmodesEquilibriumStageInspectorPanel,
    ],
    ["study.stage.eigenmodes.operator", EigenmodesOperatorStageInspectorPanel],
    ["study.stage.eigenmodes.boundary", EigenmodesBoundaryStageInspectorPanel],
    [
      "study.stage.eigenmodes.periodic_pairs",
      EigenmodesPeriodicPairsStageInspectorPanel,
    ],
    ["study.stage.eigenmodes.k_path", EigenmodesKPathStageInspectorPanel],
    ["study.stage.eigenmodes.solver", EigenmodesSolverStageInspectorPanel],
    ["study.stage.eigenmodes.outputs", EigenmodesOutputsStageInspectorPanel],
    [
      "study.stage.eigenmodes.diagnostics",
      EigenmodesDiagnosticsStageInspectorPanel,
    ],
    [
      "study.stage.frequency_response",
      FrequencyResponseStageOverviewInspectorPanel,
    ],
    [
      "study.stage.frequency_response.setup",
      FrequencyResponseSetupStageInspectorPanel,
    ],
    [
      "study.stage.frequency_response.calculation_mode",
      FrequencyResponseCalculationModeStageInspectorPanel,
    ],
    [
      "study.stage.frequency_response.equilibrium",
      FrequencyResponseEquilibriumStageInspectorPanel,
    ],
    [
      "study.stage.frequency_response.operator",
      FrequencyResponseOperatorStageInspectorPanel,
    ],
    [
      "study.stage.frequency_response.boundary",
      FrequencyResponseBoundaryStageInspectorPanel,
    ],
    [
      "study.stage.frequency_response.periodic_pairs",
      FrequencyResponsePeriodicPairsStageInspectorPanel,
    ],
    [
      "study.stage.frequency_response.k_grid",
      FrequencyResponseKGridStageInspectorPanel,
    ],
    [
      "study.stage.frequency_response.excitation",
      FrequencyResponseExcitationStageInspectorPanel,
    ],
    [
      "study.stage.frequency_response.sweep",
      FrequencyResponseSweepStageInspectorPanel,
    ],
    [
      "study.stage.frequency_response.solver",
      FrequencyResponseSolverStageInspectorPanel,
    ],
    [
      "study.stage.frequency_response.outputs",
      FrequencyResponseOutputsStageInspectorPanel,
    ],
    [
      "study.stage.frequency_response.diagnostics",
      FrequencyResponseDiagnosticsStageInspectorPanel,
    ],
  ])(
    "routes frequency-domain stage node %s to its dedicated inspector component",
    (kind, expectedComponent) => {
      const panel = resolveInspectorPanel({ kind });
      expect(panel?.id).toBe(frequencyDomainPanelId(kind));
      expect(panel?.component).toBe(expectedComponent);
      expect(panel?.component).not.toBe(StudyStageInspectorRouter);
    },
  );

  it("routes all frequency-domain result, resource, job, and diagnostic nodes away from placeholder", () => {
    for (const kind of FREQUENCY_DOMAIN_INSPECTOR_SELECTION_KINDS) {
      expect(resolveInspectorPanel({ kind })?.id, kind).toBe(
        frequencyDomainPanelId(kind),
      );
    }
  });

  it("routes primary frequency-domain workflow nodes to dedicated inspector components", () => {
    expect(
      resolveInspectorPanel({ kind: "results.frequency_domain.root" })
        ?.component,
    ).toBe(FrequencyDomainOverviewInspectorPanel);
    expect(
      resolveInspectorPanel({ kind: "results.frequency_domain.run" })
        ?.component,
    ).toBe(FrequencyDomainRunInspectorPanel);
    expect(
      resolveInspectorPanel({ kind: "results.frequency_domain.calculation_modes" })
        ?.component,
    ).toBe(FrequencyDomainCalculationModesInspectorPanel);
    expect(
      resolveInspectorPanel({ kind: "results.frequency_domain.dispersion" })
        ?.component,
    ).toBe(FrequencyDomainDispersionInspectorPanel);
    expect(
      resolveInspectorPanel({ kind: "results.frequency_domain.response_map" })
        ?.component,
    ).toBe(FrequencyDomainResponseMapInspectorPanel);
  });

  it("routes primary FMR result objects to dedicated inspector components", () => {
    expect(
      resolveInspectorPanel({ kind: "results.frequency_domain.fmr" })
        ?.component,
    ).toBe(FmrOverviewInspectorPanel);
    expect(
      resolveInspectorPanel({
        kind: "results.frequency_domain.fmr_modal_spectrum",
      })?.component,
    ).toBe(FmrModalSpectrumInspectorPanel);
    expect(
      resolveInspectorPanel({ kind: "results.frequency_domain.fmr_peaks" })
        ?.component,
    ).toBe(FmrPeaksInspectorPanel);
    expect(
      resolveInspectorPanel({ kind: "results.frequency_domain.fmr_peak" })
        ?.component,
    ).toBe(FmrPeakInspectorPanel);
    expect(
      resolveInspectorPanel({ kind: "results.frequency_domain.comparison" })
        ?.component,
    ).toBe(FmrComparisonInspectorPanel);
    expect(
      resolveInspectorPanel({ kind: "results.frequency_domain.exports" })
        ?.component,
    ).toBe(FrequencyDomainExportsInspectorPanel);
    expect(
      resolveInspectorPanel({ kind: "results.eigen.root" })?.component,
    ).toBe(EigenOverviewInspectorPanel);
    expect(
      resolveInspectorPanel({ kind: "results.eigen.study" })?.component,
    ).toBe(EigenStudyInspectorPanel);
    expect(
      resolveInspectorPanel({ kind: "results.eigen.mode" })?.component,
    ).toBe(EigenModeInspectorPanel);
    expect(
      resolveInspectorPanel({ kind: "results.eigen.modes" })?.component,
    ).toBe(EigenModesInspectorPanel);
    expect(
      resolveInspectorPanel({ kind: "results.eigen.spectrum" })?.component,
    ).toBe(EigenSpectrumInspectorPanel);
    expect(
      resolveInspectorPanel({ kind: "results.eigen.k_path" })?.component,
    ).toBe(EigenKPathInspectorPanel);
    expect(
      resolveInspectorPanel({ kind: "results.eigen.dispersion" })?.component,
    ).toBe(EigenDispersionInspectorPanel);
    expect(
      resolveInspectorPanel({ kind: "results.eigen.branches" })?.component,
    ).toBe(EigenBranchesInspectorPanel);
    expect(
      resolveInspectorPanel({ kind: "results.eigen.branch" })?.component,
    ).toBe(EigenBranchInspectorPanel);
    expect(
      resolveInspectorPanel({ kind: "results.eigen.provenance" })?.component,
    ).toBe(EigenProvenanceInspectorPanel);
    expect(
      resolveInspectorPanel({ kind: "results.eigen.diagnostics" })?.component,
    ).toBe(EigenDiagnosticsInspectorPanel);
    expect(
      resolveInspectorPanel({ kind: "results.frequency_response.root" })
        ?.component,
    ).toBe(FrequencyResponseOverviewInspectorPanel);
    expect(
      resolveInspectorPanel({ kind: "results.frequency_response.study" })
        ?.component,
    ).toBe(FrequencyResponseStudyInspectorPanel);
    expect(
      resolveInspectorPanel({
        kind: "results.frequency_response.frequency_points",
      })?.component,
    ).toBe(FrequencyResponseFrequencyPointsInspectorPanel);
    expect(
      resolveInspectorPanel({
        kind: "results.frequency_response.frequency_point",
      })?.component,
    ).toBe(FrequencyResponsePointInspectorPanel);
    expect(
      resolveInspectorPanel({
        kind: "results.frequency_response.observable",
      })?.component,
    ).toBe(FrequencyResponseObservableInspectorPanel);
    expect(
      resolveInspectorPanel({
        kind: "results.frequency_response.observables",
      })?.component,
    ).toBe(FrequencyResponseObservablesInspectorPanel);
    expect(
      resolveInspectorPanel({ kind: "results.frequency_response.sweep" })
        ?.component,
    ).toBe(FrequencyResponseSweepInspectorPanel);
    expect(
      resolveInspectorPanel({ kind: "results.frequency_response.progress" })
        ?.component,
    ).toBe(FrequencyResponseProgressInspectorPanel);
    expect(
      resolveInspectorPanel({
        kind: "results.frequency_response.cancel_requested",
      })?.component,
    ).toBe(FrequencyResponseCancelRequestedInspectorPanel);
    expect(
      resolveInspectorPanel({
        kind: "results.frequency_response.provenance",
      })?.component,
    ).toBe(FrequencyResponseProvenanceInspectorPanel);
    expect(
      resolveInspectorPanel({
        kind: "results.frequency_response.diagnostics",
      })?.component,
    ).toBe(FrequencyResponseDiagnosticsInspectorPanel);
  });

  it("keeps physics-first provenance inspectors distinct by product family", () => {
    expect(
      resolveInspectorPanel({ kind: "results.resonance.modal.provenance" })
        ?.component,
    ).toBe(ResonanceModalProvenanceResultInspector);
    expect(
      resolveInspectorPanel({ kind: "results.resonance.driven.provenance" })
        ?.component,
    ).toBe(ResonanceDrivenProvenanceResultInspector);
    expect(
      resolveInspectorPanel({ kind: "results.dispersion.modal.provenance" })
        ?.component,
    ).toBe(DispersionModalProvenanceResultInspector);
    expect(
      resolveInspectorPanel({ kind: "results.dispersion.driven.provenance" })
        ?.component,
    ).toBe(DispersionDrivenProvenanceResultInspector);
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
      "results.resonance.driven.frequency_points",
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
