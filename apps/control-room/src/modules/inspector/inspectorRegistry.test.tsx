import { describe, expect, it } from "vitest";

import {
  FREQUENCY_DOMAIN_INSPECTOR_SELECTION_KINDS,
  resolveInspectorPanel,
} from "./inspectorRegistry";
import {
  resolveInspectorRoute,
  resolveUnknownInspectorRoute,
} from "./inspectorRouteCatalog";
import {
  ObjectRegionTexturePanel,
  ObjectRegionVisualizationPanel,
} from "./panels/ObjectRegionsPanel";
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
import { FdmGridInspectorPanel } from "./panels/fdm-grid/FdmGridInspectorPanel";
import {
  EigenModeInspectorPanel,
  EigenBranchInspectorPanel,
  EigenBranchesInspectorPanel,
  EigenDiagnosticsInspectorPanel,
  FrequencyDomainApiResourcesDiagnosticInspectorPanel,
  FrequencyDomainArtifactsDiagnosticInspectorPanel,
  FrequencyDomainCapabilitiesDiagnosticInspectorPanel,
  FrequencyDomainDiagnosticsOverviewInspectorPanel,
  FrequencyDomainEquilibriumDiagnosticInspectorPanel,
  FrequencyDomainPeriodicFloquetDiagnosticInspectorPanel,
  FrequencyDomainPeriodicPairsResourceInspectorPanel,
  FrequencyDomainResourceFamilyInspectorPanel,
  FrequencyDomainManifestResourceInspectorPanel,
  FrequencyDomainCalculationModesResourceInspectorPanel,
  FrequencyDomainFmrResourceInspectorPanel,
  FrequencyDomainDispersionResourceInspectorPanel,
  FrequencyDomainResponseMapResourceInspectorPanel,
  EigenSpectrumResourceInspectorPanel,
  EigenBranchesResourceInspectorPanel,
  EigenDispersionResourceInspectorPanel,
  EigenDiagnosticsResourceInspectorPanel,
  EigenModeMetadataResourceInspectorPanel,
  EigenModeFieldResourceInspectorPanel,
  FrequencyResponseSweepResourceInspectorPanel,
  FrequencyResponseProgressResourceInspectorPanel,
  FrequencyResponseCancelRequestedResourceInspectorPanel,
  FrequencyResponseFrequencyPointResourceInspectorPanel,
  FrequencyResponseFieldResourceInspectorPanel,
  FrequencyResponseObservablesResourceInspectorPanel,
  FrequencyResponseDiagnosticsResourceInspectorPanel,
  FrequencyDomainOperatorDiagnosticInspectorPanel,
  FrequencyDomainSolverDiagnosticInspectorPanel,
  FrequencyDomainVisualizationDiagnosticInspectorPanel,
  EigenKPathInspectorPanel,
  EigenDispersionInspectorPanel,
  EigenModesInspectorPanel,
  EigenOverviewInspectorPanel,
  EigenProvenanceInspectorPanel,
  EigenSpectrumInspectorPanel,
  EigenStudyInspectorPanel,
  EigenSampleJobInspectorPanel,
  FrequencyDomainArtifactExportJobInspectorPanel,
  FrequencyDomainCalculationModesInspectorPanel,
  FrequencyDomainDispersionInspectorPanel,
  FrequencyDomainExportsInspectorPanel,
  FrequencyDomainJobsOverviewInspectorPanel,
  FrequencyDomainOverviewInspectorPanel,
  FrequencyDomainResponseMapInspectorPanel,
  FrequencyDomainRunInspectorPanel,
  FrequencyDomainStageRunJobInspectorPanel,
  FrequencyResponseOverviewInspectorPanel,
  FrequencyResponseCancelRequestedInspectorPanel,
  FrequencyResponseDiagnosticsInspectorPanel,
  FrequencyResponseObservableInspectorPanel,
  FrequencyResponseObservablesInspectorPanel,
  FrequencyResponseFrequencyPointsInspectorPanel,
  FrequencyResponsePointInspectorPanel,
  FrequencyResponseProvenanceInspectorPanel,
  FrequencyResponseProgressInspectorPanel,
  FrequencyResponseProgressJobInspectorPanel,
  FrequencyResponseFrequencyJobInspectorPanel,
  FrequencyResponseStudyInspectorPanel,
  FrequencyResponseSweepInspectorPanel,
  FmrComparisonInspectorPanel,
  FmrModalSpectrumInspectorPanel,
  FmrOverviewInspectorPanel,
  FmrPeakInspectorPanel,
  FmrPeaksInspectorPanel,
} from "./panels/frequency-domain/FrequencyDomainResultInspectors";
import { FrequencyDomainInspectorPanel } from "./panels/FrequencyDomainInspectorPanel";
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
  it("routes a pinned Quick Chart to its preview-only Inspector", () => {
    expect(resolveInspectorPanel({ kind: "results.quick_chart" })?.id).toBe(
      "quick-chart",
    );
  });

  it("resolves Live Chart and Live Chart point selections to their own Inspector", () => {
    expect(resolveInspectorPanel({ kind: "live.chart" })?.id).toBe("live-chart");
    expect(resolveInspectorPanel({ kind: "live.chart-point" })?.id).toBe(
      "live-chart",
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
      "object-material",
    );
    expect(resolveInspectorPanel({ kind: "object.magnetic-parameters" })?.id).toBe(
      "object-material",
    );
  });

  it("resolves mode visualization levels to distinct owner panels", () => {
    expect(resolveInspectorPanel({ kind: "object.mode_visualization" })?.id).toBe(
      "object-mode-visualization-overview",
    );
    expect(
      resolveInspectorPanel({ kind: "object.mode_visualization.view" })?.id,
    ).toBe("object-mode-visualization-view");
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

  it("registers one Mesh inspector contract for global, object, region, and Airbox scopes", () => {
    const expected = new Map([
      ["mesh.root", "mesh-details"],
      ["mesh.shared-domain", "mesh-details"],
      ["mesh.builds", "mesh-details"],
      ["mesh.quality", "mesh-details"],
      ["mesh.size-fields", "mesh-details"],
      ["mesh.regions", "mesh-details"],
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

    expect(panels.map((panel) => panel?.id)).toEqual(
      kinds.map(() => "fdm-grid"),
    );
    expect(panels.every((panel) => panel?.component === FdmGridInspectorPanel)).toBe(
      true,
    );
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
      "study-stage",
    );
    expect(resolveInspectorPanel({ kind: "study.stage.run" })?.id).toBe(
      "study-stage",
    );
    expect(
      resolveInspectorPanel({ kind: "study.stage.change_device" })?.id,
    ).toBe("study-stage");
    expect(resolveInspectorPanel({ kind: "study.stage.hysteresis" })?.id).toBe(
      "study-stage",
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
      "study-stage",
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

  it("assigns every non-authoring frequency-domain node its own inspector component", () => {
    const kinds = FREQUENCY_DOMAIN_INSPECTOR_SELECTION_KINDS.filter(
      (kind) => !kind.startsWith("study.stage."),
    );
    const components = kinds.map(
      (kind) => resolveInspectorPanel({ kind })?.component,
    );

    expect(components).not.toContain(FrequencyDomainInspectorPanel);
    expect(new Set(components).size).toBe(kinds.length);
  });

  it("routes frequency-domain job nodes to dedicated inspector components", () => {
    expect(
      resolveInspectorPanel({ kind: "jobs.frequency_domain.root" })?.component,
    ).toBe(FrequencyDomainJobsOverviewInspectorPanel);
    expect(
      resolveInspectorPanel({ kind: "jobs.frequency_domain.stage_run" })
        ?.component,
    ).toBe(FrequencyDomainStageRunJobInspectorPanel);
    expect(
      resolveInspectorPanel({ kind: "jobs.frequency_domain.eigen_sample" })
        ?.component,
    ).toBe(EigenSampleJobInspectorPanel);
    expect(
      resolveInspectorPanel({ kind: "jobs.frequency_domain.response_frequency" })
        ?.component,
    ).toBe(FrequencyResponseFrequencyJobInspectorPanel);
    expect(
      resolveInspectorPanel({ kind: "jobs.frequency_domain.response_progress" })
        ?.component,
    ).toBe(FrequencyResponseProgressJobInspectorPanel);
    expect(
      resolveInspectorPanel({ kind: "jobs.frequency_domain.artifact_export" })
        ?.component,
    ).toBe(FrequencyDomainArtifactExportJobInspectorPanel);
  });

  it("routes frequency-domain diagnostic nodes to dedicated inspector components", () => {
    expect(
      resolveInspectorPanel({ kind: "diagnostics.frequency_domain.root" })
        ?.component,
    ).toBe(FrequencyDomainDiagnosticsOverviewInspectorPanel);
    expect(
      resolveInspectorPanel({ kind: "diagnostics.frequency_domain.capabilities" })
        ?.component,
    ).toBe(FrequencyDomainCapabilitiesDiagnosticInspectorPanel);
    expect(
      resolveInspectorPanel({ kind: "diagnostics.frequency_domain.equilibrium" })
        ?.component,
    ).toBe(FrequencyDomainEquilibriumDiagnosticInspectorPanel);
    expect(
      resolveInspectorPanel({ kind: "diagnostics.frequency_domain.operator" })
        ?.component,
    ).toBe(FrequencyDomainOperatorDiagnosticInspectorPanel);
    expect(
      resolveInspectorPanel({ kind: "diagnostics.frequency_domain.solver" })
        ?.component,
    ).toBe(FrequencyDomainSolverDiagnosticInspectorPanel);
    expect(
      resolveInspectorPanel({ kind: "diagnostics.frequency_domain.artifacts" })
        ?.component,
    ).toBe(FrequencyDomainArtifactsDiagnosticInspectorPanel);
    expect(
      resolveInspectorPanel({ kind: "diagnostics.frequency_domain.api_resources" })
        ?.component,
    ).toBe(FrequencyDomainApiResourcesDiagnosticInspectorPanel);
    expect(
      resolveInspectorPanel({ kind: "diagnostics.frequency_domain.visualization" })
        ?.component,
    ).toBe(FrequencyDomainVisualizationDiagnosticInspectorPanel);
    expect(
      resolveInspectorPanel({
        kind: "diagnostics.frequency_domain.periodic_floquet",
      })?.component,
    ).toBe(FrequencyDomainPeriodicFloquetDiagnosticInspectorPanel);
  });

  it("routes frequency-domain resource nodes to dedicated inspector components", () => {
    expect(
      resolveInspectorPanel({ kind: "resources.analysis.frequency_domain" })
        ?.component,
    ).toBe(FrequencyDomainResourceFamilyInspectorPanel);
    expect(
      resolveInspectorPanel({ kind: "resources.analysis.frequency_domain.manifest" })
        ?.component,
    ).toBe(FrequencyDomainManifestResourceInspectorPanel);
    expect(
      resolveInspectorPanel({
        kind: "resources.analysis.frequency_domain.calculation_modes",
      })?.component,
    ).toBe(FrequencyDomainCalculationModesResourceInspectorPanel);
    expect(
      resolveInspectorPanel({ kind: "resources.analysis.frequency_domain.fmr" })
        ?.component,
    ).toBe(FrequencyDomainFmrResourceInspectorPanel);
    expect(
      resolveInspectorPanel({ kind: "resources.analysis.frequency_domain.dispersion" })
        ?.component,
    ).toBe(FrequencyDomainDispersionResourceInspectorPanel);
    expect(
      resolveInspectorPanel({ kind: "resources.analysis.frequency_domain.response_map" })
        ?.component,
    ).toBe(FrequencyDomainResponseMapResourceInspectorPanel);
    expect(
      resolveInspectorPanel({ kind: "resources.mesh.periodic_pairs" })?.component,
    ).toBe(FrequencyDomainPeriodicPairsResourceInspectorPanel);
    expect(
      resolveInspectorPanel({ kind: "resources.analysis.eigen.spectrum" })
        ?.component,
    ).toBe(EigenSpectrumResourceInspectorPanel);
    expect(
      resolveInspectorPanel({ kind: "resources.analysis.eigen.branches" })
        ?.component,
    ).toBe(EigenBranchesResourceInspectorPanel);
    expect(
      resolveInspectorPanel({ kind: "resources.analysis.eigen.dispersion" })
        ?.component,
    ).toBe(EigenDispersionResourceInspectorPanel);
    expect(
      resolveInspectorPanel({ kind: "resources.analysis.eigen.diagnostics" })
        ?.component,
    ).toBe(EigenDiagnosticsResourceInspectorPanel);
    expect(
      resolveInspectorPanel({ kind: "resources.analysis.eigen.mode_metadata" })
        ?.component,
    ).toBe(EigenModeMetadataResourceInspectorPanel);
    expect(
      resolveInspectorPanel({ kind: "resources.analysis.eigen.mode_field" })
        ?.component,
    ).toBe(EigenModeFieldResourceInspectorPanel);
    expect(
      resolveInspectorPanel({ kind: "resources.analysis.frequency_response.sweep" })
        ?.component,
    ).toBe(FrequencyResponseSweepResourceInspectorPanel);
    expect(
      resolveInspectorPanel({ kind: "resources.analysis.frequency_response.progress" })
        ?.component,
    ).toBe(FrequencyResponseProgressResourceInspectorPanel);
    expect(
      resolveInspectorPanel({
        kind: "resources.analysis.frequency_response.cancel_requested",
      })?.component,
    ).toBe(FrequencyResponseCancelRequestedResourceInspectorPanel);
    expect(
      resolveInspectorPanel({
        kind: "resources.analysis.frequency_response.frequency_point",
      })?.component,
    ).toBe(FrequencyResponseFrequencyPointResourceInspectorPanel);
    expect(
      resolveInspectorPanel({ kind: "resources.analysis.frequency_response.field" })
        ?.component,
    ).toBe(FrequencyResponseFieldResourceInspectorPanel);
    expect(
      resolveInspectorPanel({
        kind: "resources.analysis.frequency_response.observables",
      })?.component,
    ).toBe(FrequencyResponseObservablesResourceInspectorPanel);
    expect(
      resolveInspectorPanel({
        kind: "resources.analysis.frequency_response.diagnostics",
      })?.component,
    ).toBe(FrequencyResponseDiagnosticsResourceInspectorPanel);
  });

  it("returns null when there is no selection kind", () => {
    expect(resolveInspectorPanel({ kind: null })).toBeNull();
  });
});
