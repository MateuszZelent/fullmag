import type { ComponentType } from "react";

import { ChartInspectorPanel } from "./ChartInspectorPanel";
import { CrossSectionInspectorPanel } from "./CrossSectionInspectorPanel";
import { GeometryObjectPanel } from "./GeometryObjectPanel";
import { LiveChartInspectorPanel as LiveChartPanel } from "./LiveChartInspectorPanel";
import { MeshDetailsPanel } from "./MeshDetailsPanel";
import { ObjectMagneticTexturePanel } from "./ObjectMagneticTexturePanel";
import { ObjectMaterialPanel } from "./ObjectMaterialPanel";
import {
  ObjectRegionGeometryPanel,
  ObjectRegionMagneticParametersPanel,
  ObjectRegionTexturePanel,
} from "./ObjectRegionsPanel";
import { RegionalFieldDrivePanel } from "./RegionalFieldDrivePanel";
import { StudyInspectorPanel } from "./StudyInspectorPanel";
import { StudyStageInspectorRouter } from "./StudyStageInspectorRouter";
import { AirboxVisualizationPanel } from "./airbox/AirboxVisualizationPanel";
import { FdmGridInspectorPanel } from "./fdm-grid/FdmGridInspectorPanel";
import type { InspectorPanelProps } from "../inspectorTypes";
import { DedicatedInspectorRouteFrame } from "./DedicatedInspectorRouteFrame";

function renderDedicatedPanel(
  props: InspectorPanelProps,
  owner: string,
  Panel: ComponentType<InspectorPanelProps>,
) {
  return (
    <DedicatedInspectorRouteFrame owner={owner} selection={props.selection}>
      <Panel {...props} />
    </DedicatedInspectorRouteFrame>
  );
}

export function AnalysisChartInspectorPanel(props: InspectorPanelProps) {
  return renderDedicatedPanel(props, "analysis.chart", ChartInspectorPanel);
}

export function AnalysisChartPointInspectorPanel(props: InspectorPanelProps) {
  return renderDedicatedPanel(props, "analysis.chart-point", ChartInspectorPanel);
}

export function LiveChartInspectorPanel(props: InspectorPanelProps) {
  return renderDedicatedPanel(props, "live.chart", LiveChartPanel);
}

export function LiveChartPointInspectorPanel(props: InspectorPanelProps) {
  return renderDedicatedPanel(props, "live.chart-point", LiveChartPanel);
}

export function GeometryObjectInspectorPanel(props: InspectorPanelProps) {
  return renderDedicatedPanel(props, "object.geometry", GeometryObjectPanel);
}

export function BuilderPrimitiveInspectorPanel(props: InspectorPanelProps) {
  return renderDedicatedPanel(props, "builder.primitive", GeometryObjectPanel);
}

export function AirboxVisualizationInspectorPanel(props: InspectorPanelProps) {
  return renderDedicatedPanel(props, "airbox.visualization", AirboxVisualizationPanel);
}

export function MeshPartAirboxInspectorPanel(props: InspectorPanelProps) {
  return renderDedicatedPanel(props, "mesh-part-airbox", AirboxVisualizationPanel);
}

export function FieldDrivesInspectorPanel(props: InspectorPanelProps) {
  return renderDedicatedPanel(props, "physics.field-drives", RegionalFieldDrivePanel);
}

export function FieldDriveInspectorPanel(props: InspectorPanelProps) {
  return renderDedicatedPanel(props, "physics.field-drive", RegionalFieldDrivePanel);
}

export function ObjectMagneticParametersInspectorPanel(props: InspectorPanelProps) {
  return renderDedicatedPanel(props, "object.magnetic-parameters", ObjectMaterialPanel);
}

export function ObjectMaterialInspectorPanel(props: InspectorPanelProps) {
  return renderDedicatedPanel(props, "object.material", ObjectMaterialPanel);
}

export function ObjectRegionGeometryInspectorPanel(props: InspectorPanelProps) {
  return renderDedicatedPanel(props, "object.region.geometry", ObjectRegionGeometryPanel);
}

export function ObjectRegionShapeInspectorPanel(props: InspectorPanelProps) {
  return renderDedicatedPanel(props, "object.region.shape", ObjectRegionGeometryPanel);
}

export function ObjectRegionMagneticParametersInspectorPanel(props: InspectorPanelProps) {
  return renderDedicatedPanel(
    props,
    "object.region.magnetic-parameters",
    ObjectRegionMagneticParametersPanel,
  );
}

export function ObjectRegionMaterialInspectorPanel(props: InspectorPanelProps) {
  return renderDedicatedPanel(props, "object.region.material", ObjectRegionMagneticParametersPanel);
}

export function ObjectRegionTextureInspectorPanel(props: InspectorPanelProps) {
  return renderDedicatedPanel(props, "object.region.texture", ObjectRegionTexturePanel);
}

export function ObjectRegionMagneticTextureInspectorPanel(props: InspectorPanelProps) {
  return renderDedicatedPanel(
    props,
    "object.region-magnetic-texture",
    ObjectRegionTexturePanel,
  );
}

export function ObjectMagneticTextureInspectorPanel(props: InspectorPanelProps) {
  return renderDedicatedPanel(props, "object.magnetic-texture", ObjectMagneticTexturePanel);
}

export function ObjectMagneticTextureAssetInspectorPanel(props: InspectorPanelProps) {
  return renderDedicatedPanel(
    props,
    "object.magnetic-texture.asset",
    ObjectMagneticTexturePanel,
  );
}

export function ObjectMagneticTextureLoadInspectorPanel(props: InspectorPanelProps) {
  return renderDedicatedPanel(
    props,
    "object.magnetic-texture.load",
    ObjectMagneticTexturePanel,
  );
}

export function ObjectMagneticTextureTransformInspectorPanel(props: InspectorPanelProps) {
  return renderDedicatedPanel(
    props,
    "object.magnetic-texture.transform",
    ObjectMagneticTexturePanel,
  );
}

export function MeshRootInspectorPanel(props: InspectorPanelProps) {
  return renderDedicatedPanel(props, "mesh.root", MeshDetailsPanel);
}

export function MeshSharedDomainInspectorPanel(props: InspectorPanelProps) {
  return renderDedicatedPanel(props, "mesh.shared-domain", MeshDetailsPanel);
}

export function MeshBuildsInspectorPanel(props: InspectorPanelProps) {
  return renderDedicatedPanel(props, "mesh.builds", MeshDetailsPanel);
}

export function MeshQualityInspectorPanel(props: InspectorPanelProps) {
  return renderDedicatedPanel(props, "mesh.quality", MeshDetailsPanel);
}

export function MeshSizeFieldsInspectorPanel(props: InspectorPanelProps) {
  return renderDedicatedPanel(props, "mesh.size-fields", MeshDetailsPanel);
}

export function MeshRegionsInspectorPanel(props: InspectorPanelProps) {
  return renderDedicatedPanel(props, "mesh.regions", MeshDetailsPanel);
}

export function FdmGridInspectorPanelRoute(props: InspectorPanelProps) {
  return renderDedicatedPanel(props, "mesh.grid", FdmGridInspectorPanel);
}

export function FdmGridDescriptorInspectorPanel(props: InspectorPanelProps) {
  return renderDedicatedPanel(props, "mesh.grid.descriptor", FdmGridInspectorPanel);
}

export function FdmGridCommonInspectorPanel(props: InspectorPanelProps) {
  return renderDedicatedPanel(props, "mesh.grid.common", FdmGridInspectorPanel);
}

export function FdmGridLayersInspectorPanel(props: InspectorPanelProps) {
  return renderDedicatedPanel(props, "mesh.grid.layers", FdmGridInspectorPanel);
}

export function FdmGridLayerInspectorPanel(props: InspectorPanelProps) {
  return renderDedicatedPanel(props, "mesh.grid.layer", FdmGridInspectorPanel);
}

export function FdmGridNativeGridInspectorPanel(props: InspectorPanelProps) {
  return renderDedicatedPanel(props, "mesh.grid.layer.native-grid", FdmGridInspectorPanel);
}

export function FdmGridLayerMaskInspectorPanel(props: InspectorPanelProps) {
  return renderDedicatedPanel(props, "mesh.grid.layer.mask", FdmGridInspectorPanel);
}

export function FdmGridLayerTransferInspectorPanel(props: InspectorPanelProps) {
  return renderDedicatedPanel(props, "mesh.grid.layer.transfer", FdmGridInspectorPanel);
}

export function FdmGridLayerProvenanceInspectorPanel(props: InspectorPanelProps) {
  return renderDedicatedPanel(props, "mesh.grid.layer.provenance", FdmGridInspectorPanel);
}

export function FdmGridMagneticSupportInspectorPanel(props: InspectorPanelProps) {
  return renderDedicatedPanel(props, "mesh.grid.magnetic-support", FdmGridInspectorPanel);
}

export function FdmGridActiveUnassignedInspectorPanel(props: InspectorPanelProps) {
  return renderDedicatedPanel(props, "mesh.grid.active-unassigned", FdmGridInspectorPanel);
}

export function FdmGridMaskInspectorPanel(props: InspectorPanelProps) {
  return renderDedicatedPanel(props, "mesh.grid.mask", FdmGridInspectorPanel);
}

export function FdmGridProvenanceInspectorPanel(props: InspectorPanelProps) {
  return renderDedicatedPanel(props, "mesh.grid.provenance", FdmGridInspectorPanel);
}

export function FdmGridRegionInspectorPanel(props: InspectorPanelProps) {
  return renderDedicatedPanel(props, "mesh.grid.region", FdmGridInspectorPanel);
}

export function FdmGridUniverseOutsideSupportInspectorPanel(props: InspectorPanelProps) {
  return renderDedicatedPanel(
    props,
    "mesh.grid.universe-outside-support",
    FdmGridInspectorPanel,
  );
}

export function FdmCellInspectorPanel(props: InspectorPanelProps) {
  return renderDedicatedPanel(props, "fdm.cell", FdmGridInspectorPanel);
}

export function CrossSectionInspectorPanelRoute(props: InspectorPanelProps) {
  return renderDedicatedPanel(props, "mesh.cross-section", CrossSectionInspectorPanel);
}

export function CrossSectionDraftInspectorPanel(props: InspectorPanelProps) {
  return renderDedicatedPanel(props, "mesh.cross-section.draft", CrossSectionInspectorPanel);
}

export function CrossSectionPlotInspectorPanel(props: InspectorPanelProps) {
  return renderDedicatedPanel(props, "mesh.cross-section.plot", CrossSectionInspectorPanel);
}

export function StudyRootInspectorPanel(props: InspectorPanelProps) {
  return renderDedicatedPanel(props, "study.root", StudyInspectorPanel);
}

export function StudyStagesInspectorPanel(props: InspectorPanelProps) {
  return renderDedicatedPanel(props, "study.stages", StudyInspectorPanel);
}

export function StudyExecutionInspectorPanel(props: InspectorPanelProps) {
  return renderDedicatedPanel(props, "study.execution", StudyInspectorPanel);
}

export function StudyRecoveryInspectorPanel(props: InspectorPanelProps) {
  return renderDedicatedPanel(props, "study.recovery", StudyInspectorPanel);
}

export function StudyStageActionInspectorPanel(props: InspectorPanelProps) {
  return renderDedicatedPanel(props, "study.stage.action", StudyStageInspectorRouter);
}

export function StudyStageAddFieldDriveInspectorPanel(props: InspectorPanelProps) {
  return renderDedicatedPanel(props, "study.stage.add_field_drive", StudyStageInspectorRouter);
}

export function StudyStageAutosaveInspectorPanel(props: InspectorPanelProps) {
  return renderDedicatedPanel(props, "study.stage.autosave", StudyStageInspectorRouter);
}

export function StudyStageFftResponseInspectorPanel(props: InspectorPanelProps) {
  return renderDedicatedPanel(props, "study.stage.fft_response", StudyStageInspectorRouter);
}

export function StudyStageHysteresisInspectorPanel(props: InspectorPanelProps) {
  return renderDedicatedPanel(props, "study.stage.hysteresis", StudyStageInspectorRouter);
}

export function StudyStageRelaxInspectorPanel(props: InspectorPanelProps) {
  return renderDedicatedPanel(props, "study.stage.relax", StudyStageInspectorRouter);
}

export function StudyStageRunInspectorPanel(props: InspectorPanelProps) {
  return renderDedicatedPanel(props, "study.stage.run", StudyStageInspectorRouter);
}

export function StudyStageTableAutosaveInspectorPanel(props: InspectorPanelProps) {
  return renderDedicatedPanel(props, "study.stage.table_autosave", StudyStageInspectorRouter);
}

export function StudyStageChangeDeviceInspectorPanel(props: InspectorPanelProps) {
  return renderDedicatedPanel(props, "study.stage.change_device", StudyStageInspectorRouter);
}

export function StudyStageSaveStateInspectorPanel(props: InspectorPanelProps) {
  return renderDedicatedPanel(props, "study.stage.save_state", StudyStageInspectorRouter);
}
