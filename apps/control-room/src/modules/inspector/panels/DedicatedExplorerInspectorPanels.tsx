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
  return (
    <DedicatedInspectorRouteFrame owner="analysis.chart" selection={props.selection}>
      <ChartInspectorPanel {...props} sectionScope="chart" />
    </DedicatedInspectorRouteFrame>
  );
}

export function AnalysisChartPointInspectorPanel(props: InspectorPanelProps) {
  return (
    <DedicatedInspectorRouteFrame owner="analysis.chart-point" selection={props.selection}>
      <ChartInspectorPanel {...props} sectionScope="point" />
    </DedicatedInspectorRouteFrame>
  );
}

export function LiveChartInspectorPanel(props: InspectorPanelProps) {
  return (
    <DedicatedInspectorRouteFrame owner="live.chart" selection={props.selection}>
      <LiveChartPanel {...props} sectionScope="chart" />
    </DedicatedInspectorRouteFrame>
  );
}

export function LiveChartPointInspectorPanel(props: InspectorPanelProps) {
  return (
    <DedicatedInspectorRouteFrame owner="live.chart-point" selection={props.selection}>
      <LiveChartPanel {...props} sectionScope="point" />
    </DedicatedInspectorRouteFrame>
  );
}

export function GeometryObjectInspectorPanel(props: InspectorPanelProps) {
  return renderDedicatedPanel(props, "object.geometry", GeometryObjectPanel);
}

export function BuilderPrimitiveInspectorPanel(props: InspectorPanelProps) {
  return renderDedicatedPanel(props, "builder.primitive", GeometryObjectPanel);
}

export function AirboxVisualizationInspectorPanel(props: InspectorPanelProps) {
  return <AirboxVisualizationPanel {...props} />;
}

export function MeshPartAirboxInspectorPanel(props: InspectorPanelProps) {
  return <AirboxVisualizationPanel {...props} />;
}

export function FieldDrivesInspectorPanel(props: InspectorPanelProps) {
  return (
    <DedicatedInspectorRouteFrame owner="physics.field-drives" selection={props.selection}>
      <RegionalFieldDrivePanel {...props} sectionScope="list" />
    </DedicatedInspectorRouteFrame>
  );
}

export function FieldDriveInspectorPanel(props: InspectorPanelProps) {
  return (
    <DedicatedInspectorRouteFrame owner="physics.field-drive" selection={props.selection}>
      <RegionalFieldDrivePanel {...props} sectionScope="item" />
    </DedicatedInspectorRouteFrame>
  );
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
  return (
    <DedicatedInspectorRouteFrame owner="object.magnetic-texture" selection={props.selection}>
      <ObjectMagneticTexturePanel {...props} sectionScope="overview" />
    </DedicatedInspectorRouteFrame>
  );
}

export function ObjectMagneticTextureAssetInspectorPanel(props: InspectorPanelProps) {
  return (
    <DedicatedInspectorRouteFrame owner="object.magnetic-texture.asset" selection={props.selection}>
      <ObjectMagneticTexturePanel {...props} sectionScope="asset" />
    </DedicatedInspectorRouteFrame>
  );
}

export function ObjectMagneticTextureLoadInspectorPanel(props: InspectorPanelProps) {
  return (
    <DedicatedInspectorRouteFrame owner="object.magnetic-texture.load" selection={props.selection}>
      <ObjectMagneticTexturePanel {...props} sectionScope="load" />
    </DedicatedInspectorRouteFrame>
  );
}

export function ObjectMagneticTextureTransformInspectorPanel(props: InspectorPanelProps) {
  return (
    <DedicatedInspectorRouteFrame owner="object.magnetic-texture.transform" selection={props.selection}>
      <ObjectMagneticTexturePanel {...props} sectionScope="transform" />
    </DedicatedInspectorRouteFrame>
  );
}

export function MeshRootInspectorPanel(props: InspectorPanelProps) {
  return (
    <DedicatedInspectorRouteFrame owner="mesh.root" selection={props.selection}>
      <MeshDetailsPanel {...props} sectionScope="mesh.root" />
    </DedicatedInspectorRouteFrame>
  );
}

export function MeshSharedDomainInspectorPanel(props: InspectorPanelProps) {
  return (
    <DedicatedInspectorRouteFrame owner="mesh.shared-domain" selection={props.selection}>
      <MeshDetailsPanel {...props} sectionScope="mesh.shared-domain" />
    </DedicatedInspectorRouteFrame>
  );
}

export function MeshBuildsInspectorPanel(props: InspectorPanelProps) {
  return (
    <DedicatedInspectorRouteFrame owner="mesh.builds" selection={props.selection}>
      <MeshDetailsPanel {...props} sectionScope="mesh.builds" />
    </DedicatedInspectorRouteFrame>
  );
}

export function MeshQualityInspectorPanel(props: InspectorPanelProps) {
  return (
    <DedicatedInspectorRouteFrame owner="mesh.quality" selection={props.selection}>
      <MeshDetailsPanel {...props} sectionScope="mesh.quality" />
    </DedicatedInspectorRouteFrame>
  );
}

export function MeshSizeFieldsInspectorPanel(props: InspectorPanelProps) {
  return (
    <DedicatedInspectorRouteFrame owner="mesh.size-fields" selection={props.selection}>
      <MeshDetailsPanel {...props} sectionScope="mesh.size-fields" />
    </DedicatedInspectorRouteFrame>
  );
}

export function MeshRegionsInspectorPanel(props: InspectorPanelProps) {
  return (
    <DedicatedInspectorRouteFrame owner="mesh.regions" selection={props.selection}>
      <MeshDetailsPanel {...props} sectionScope="mesh.regions" />
    </DedicatedInspectorRouteFrame>
  );
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
  return (
    <DedicatedInspectorRouteFrame owner="mesh.cross-section" selection={props.selection}>
      <CrossSectionInspectorPanel {...props} sectionScope="overview" />
    </DedicatedInspectorRouteFrame>
  );
}

export function CrossSectionDraftInspectorPanel(props: InspectorPanelProps) {
  return (
    <DedicatedInspectorRouteFrame owner="mesh.cross-section.draft" selection={props.selection}>
      <CrossSectionInspectorPanel {...props} sectionScope="draft" />
    </DedicatedInspectorRouteFrame>
  );
}

export function CrossSectionPlotInspectorPanel(props: InspectorPanelProps) {
  return (
    <DedicatedInspectorRouteFrame owner="mesh.cross-section.plot" selection={props.selection}>
      <CrossSectionInspectorPanel {...props} sectionScope="plot" />
    </DedicatedInspectorRouteFrame>
  );
}

export function StudyRootInspectorPanel(props: InspectorPanelProps) {
  return (
    <DedicatedInspectorRouteFrame owner="study.root" selection={props.selection}>
      <StudyInspectorPanel {...props} sectionScope="overview" />
    </DedicatedInspectorRouteFrame>
  );
}

export function StudyStagesInspectorPanel(props: InspectorPanelProps) {
  return (
    <DedicatedInspectorRouteFrame owner="study.stages" selection={props.selection}>
      <StudyInspectorPanel {...props} sectionScope="stages" />
    </DedicatedInspectorRouteFrame>
  );
}

export function StudyExecutionInspectorPanel(props: InspectorPanelProps) {
  return (
    <DedicatedInspectorRouteFrame owner="study.execution" selection={props.selection}>
      <StudyInspectorPanel {...props} sectionScope="execution" />
    </DedicatedInspectorRouteFrame>
  );
}

export function StudyRecoveryInspectorPanel(props: InspectorPanelProps) {
  return (
    <DedicatedInspectorRouteFrame owner="study.recovery" selection={props.selection}>
      <StudyInspectorPanel {...props} sectionScope="recovery" />
    </DedicatedInspectorRouteFrame>
  );
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
