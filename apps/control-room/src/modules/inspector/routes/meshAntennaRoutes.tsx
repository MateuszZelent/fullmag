import { AntennaObjectPanel } from "../panels/AntennaObjectPanel";
import {
  FdmCellInspectorPanel,
  FdmGridInspectorPanelRoute,
  FdmGridLayerInspectorPanel,
  MeshBuildsInspectorPanel,
  MeshQualityInspectorPanel,
  MeshRegionsInspectorPanel,
  MeshRootInspectorPanel,
  MeshSharedDomainInspectorPanel,
  MeshSizeFieldsInspectorPanel,
} from "../panels/DedicatedExplorerInspectorPanels";
import {
  MeshUnassignedInspectorPanel,
  MeshUnassignedPartInspectorPanel,
  Visualizations2DDraftInspectorPanel,
  Visualizations2DOverviewInspectorPanel,
  Visualizations2DPlotInspectorPanel,
} from "../panels/ModelTreeOverviewInspectorPanels";
import { ObjectMeshPolicyPanel } from "../panels/ObjectMeshPolicyPanel";
import {
  AirboxMeshBuildLanePanel,
  AirboxMeshOverviewLanePanel,
  AirboxMeshParametersLanePanel,
  AirboxMeshQualityGatesLanePanel,
  AirboxMeshStatisticsLanePanel,
  AirboxMeshTopologyLanePanel,
  AirboxOverviewLanePanel,
} from "../panels/airbox/AirboxInspectorLanePanel";
import { FdmMultilayerAirboxTargetPanel } from "../panels/airbox/FdmMultilayerAirboxTargetPanel";
import {
  AntennaConductorPanel,
  AntennaPortPanel,
  AntennaProjectionPanel,
  AntennaSolutionPanel,
  AntennaSpectrumPanel,
  SolvedAntennaDrivePanel,
} from "../panels/antenna/AntennaCompositionPanels";
import { AntennaCompositionSummaryPanel } from "../panels/antenna/AntennaCompositionSummaryPanel";
import { AntennaGeometryPanel } from "../panels/antenna/AntennaGeometryPanel";
import { AntennaTerminalsPanel } from "../panels/antenna/AntennaTerminalsPanel";
import { AntennaVisualizationPanel } from "../panels/antenna/AntennaVisualizationPanel";
import { BoundaryFacesOverviewPanel } from "../panels/boundary-faces/BoundaryFacesOverviewPanel";

import { defineInspectorRoute, type InspectorRoute } from "./routeTypes";

/**
 * Canonical Wave 5 (Volume IV) domain route registry: Mesh FEM/FDM, FDM Grid & Cell,
 * Airbox, Boundary Faces, 2D Cross-Sections, and Antenna subsystem (35 routes).
 */
export const MESH_ANTENNA_ROUTES: readonly InspectorRoute[] = [
  defineInspectorRoute({
    component: MeshUnassignedInspectorPanel,
    id: "mesh-unassigned",
    selectionKinds: ["mesh.unassigned"],
    title: "Unassigned Mesh Parts",
  }),
  defineInspectorRoute({
    component: MeshUnassignedPartInspectorPanel,
    id: "mesh-unassigned-part",
    selectionKinds: ["mesh.unassigned.part"],
    title: "Unassigned Mesh Part",
  }),
  defineInspectorRoute({
    component: Visualizations2DOverviewInspectorPanel,
    id: "visualizations-2d-root",
    selectionKinds: ["visualizations-2d.root"],
    title: "Visualizations 2D",
  }),
  defineInspectorRoute({
    component: Visualizations2DDraftInspectorPanel,
    id: "visualizations-2d-draft",
    selectionKinds: ["visualizations-2d.draft"],
    title: "2D Visualization Draft",
  }),
  defineInspectorRoute({
    component: Visualizations2DPlotInspectorPanel,
    id: "visualizations-2d-plot",
    selectionKinds: ["visualizations-2d.plot"],
    title: "2D Visualization Plot",
  }),
  defineInspectorRoute({
    component: AntennaCompositionSummaryPanel,
    id: "antenna-composition",
    selectionKinds: ["object.antenna"],
    title: "Antenna composition",
  }),
  defineInspectorRoute({
    component: AntennaObjectPanel,
    id: "antenna-object",
    selectionKinds: ["object.antenna.regional"],
    title: "Regional field drive",
  }),
  defineInspectorRoute({
    component: AntennaGeometryPanel,
    id: "antenna-geometry",
    selectionKinds: ["object.antenna.geometry"],
    title: "Antenna geometry",
  }),
  defineInspectorRoute({
    component: AntennaTerminalsPanel,
    id: "antenna-terminals",
    selectionKinds: ["object.antenna.terminals"],
    title: "Antenna terminals",
  }),
  defineInspectorRoute({
    component: AntennaConductorPanel,
    id: "antenna-conductor",
    selectionKinds: ["object.antenna.conductor"],
    title: "Antenna conductor",
  }),
  defineInspectorRoute({
    component: AntennaPortPanel,
    id: "antenna-port",
    selectionKinds: ["object.antenna.port"],
    title: "Antenna port",
  }),
  defineInspectorRoute({
    component: AntennaSolutionPanel,
    id: "antenna-solution",
    selectionKinds: ["object.antenna.solution"],
    title: "Antenna field solve",
  }),
  defineInspectorRoute({
    component: AntennaProjectionPanel,
    id: "antenna-projection",
    selectionKinds: ["object.antenna.projection"],
    title: "Antenna target projection",
  }),
  defineInspectorRoute({
    component: SolvedAntennaDrivePanel,
    id: "antenna-drive",
    selectionKinds: ["object.antenna.drive"],
    title: "Solved antenna drive",
  }),
  defineInspectorRoute({
    component: AntennaSpectrumPanel,
    id: "antenna-spectrum",
    selectionKinds: ["object.antenna.spectrum"],
    title: "Antenna spectrum",
  }),
  defineInspectorRoute({
    component: AirboxOverviewLanePanel,
    id: "airbox-overview",
    selectionKinds: ["airbox.root"],
    title: "Airbox Overview",
  }),
  defineInspectorRoute({
    component: FdmMultilayerAirboxTargetPanel,
    id: "fdm-multilayer-airbox-target",
    selectionKinds: ["airbox.multilayer.target"],
    title: "Multilayer Airbox target",
  }),
  defineInspectorRoute({
    component: BoundaryFacesOverviewPanel,
    id: "boundary-faces-overview",
    selectionKinds: ["boundary-faces.root"],
    title: "Boundary Faces",
  }),
  defineInspectorRoute({
    component: AntennaVisualizationPanel,
    id: "antenna-visualization",
    selectionKinds: ["object.antenna.visualization"],
    title: "Antenna Visualization",
  }),
  defineInspectorRoute({
    component: AirboxMeshOverviewLanePanel,
    id: "airbox-mesh-overview",
    selectionKinds: ["airbox.mesh"],
    title: "Airbox Mesh Overview",
  }),
  defineInspectorRoute({
    component: AirboxMeshParametersLanePanel,
    id: "airbox-mesh-parameters",
    selectionKinds: ["airbox.mesh.parameters"],
    title: "Airbox Mesh Parameters",
  }),
  defineInspectorRoute({
    component: AirboxMeshQualityGatesLanePanel,
    id: "airbox-mesh-quality-gates",
    selectionKinds: ["airbox.mesh.quality-gates"],
    title: "Airbox Mesh Quality Gates",
  }),
  defineInspectorRoute({
    component: AirboxMeshStatisticsLanePanel,
    id: "airbox-mesh-statistics",
    selectionKinds: ["airbox.mesh.statistics"],
    title: "Airbox Mesh Statistics",
  }),
  defineInspectorRoute({
    component: AirboxMeshTopologyLanePanel,
    id: "airbox-mesh-topology",
    selectionKinds: ["airbox.mesh.topology"],
    title: "Airbox Mesh Topology",
  }),
  defineInspectorRoute({
    component: AirboxMeshBuildLanePanel,
    id: "airbox-mesh-build",
    selectionKinds: ["airbox.mesh.build"],
    title: "Airbox Mesh Build",
  }),
  defineInspectorRoute({
    component: ObjectMeshPolicyPanel,
    id: "object-mesh-policy",
    selectionKinds: ["object.mesh"],
    title: "Object Mesh Policy",
  }),
  defineInspectorRoute({
    component: MeshRootInspectorPanel,
    id: "mesh-details",
    selectionKinds: ["mesh.root"],
    title: "Mesh",
  }),
  defineInspectorRoute({
    component: MeshSharedDomainInspectorPanel,
    id: "mesh-shared-domain",
    selectionKinds: ["mesh.shared-domain"],
    title: "Shared Domain Mesh",
  }),
  defineInspectorRoute({
    component: MeshBuildsInspectorPanel,
    id: "mesh-builds",
    selectionKinds: ["mesh.builds"],
    title: "Mesh Builds",
  }),
  defineInspectorRoute({
    component: MeshQualityInspectorPanel,
    id: "mesh-quality",
    selectionKinds: ["mesh.quality"],
    title: "Mesh Quality",
  }),
  defineInspectorRoute({
    component: MeshSizeFieldsInspectorPanel,
    id: "mesh-size-fields",
    selectionKinds: ["mesh.size-fields"],
    title: "Mesh Size Fields",
  }),
  defineInspectorRoute({
    component: MeshRegionsInspectorPanel,
    id: "mesh-regions",
    selectionKinds: ["mesh.regions"],
    title: "Mesh Regions",
  }),
  defineInspectorRoute({
    component: FdmGridInspectorPanelRoute,
    id: "fdm-grid",
    selectionKinds: ["mesh.grid"],
    title: "FDM Mesh",
  }),
  defineInspectorRoute({
    component: FdmGridLayerInspectorPanel,
    id: "fdm-grid-layer",
    selectionKinds: ["mesh.grid.layer"],
    title: "FDM Grid Layer",
  }),
  defineInspectorRoute({
    component: FdmCellInspectorPanel,
    id: "fdm-cell",
    selectionKinds: ["fdm.cell"],
    title: "FDM Cell",
  }),
];
