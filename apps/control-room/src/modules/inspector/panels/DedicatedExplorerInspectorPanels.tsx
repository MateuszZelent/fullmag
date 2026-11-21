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
import { MaskAntennaListSection, MaskAntennaPanel } from "./MaskAntennaPanel";
import { RegionalFieldDrivePanel } from "./RegionalFieldDrivePanel";
import { StudyInspectorPanel } from "./StudyInspectorPanel";
import { StudyStageInspectorRouter } from "./StudyStageInspectorRouter";
import { AirboxVisualizationPanel } from "./airbox/AirboxVisualizationPanel";
import { FdmGridInspectorPanel } from "./fdm-grid/FdmGridInspectorPanel";
import type { InspectorPanelProps } from "../inspectorTypes";
import { DedicatedInspectorRouteFrame } from "./DedicatedInspectorRouteFrame";

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
  return (
    <DedicatedInspectorRouteFrame owner="object.geometry" selection={props.selection}>
      <GeometryObjectPanel {...props} />
    </DedicatedInspectorRouteFrame>
  );
}

export function BuilderPrimitiveInspectorPanel(props: InspectorPanelProps) {
  return (
    <DedicatedInspectorRouteFrame owner="builder.primitive" selection={props.selection}>
      <GeometryObjectPanel {...props} />
    </DedicatedInspectorRouteFrame>
  );
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
      <MaskAntennaListSection />
    </DedicatedInspectorRouteFrame>
  );
}

export function FieldDriveInspectorPanel(props: InspectorPanelProps) {
  // A hand-written mask antenna is a field drive with its own panel.
  const ref = props.selection.ref;
  const isMaskAntenna = ref?.type === "physics-field-drive" && ref.fieldDriveKind === "mask";
  return (
    <DedicatedInspectorRouteFrame owner="physics.field-drive" selection={props.selection}>
      {isMaskAntenna
        ? <MaskAntennaPanel {...props} />
        : <RegionalFieldDrivePanel {...props} sectionScope="item" />}
    </DedicatedInspectorRouteFrame>
  );
}

export function ObjectMagneticParametersInspectorPanel(props: InspectorPanelProps) {
  return (
    <DedicatedInspectorRouteFrame owner="object.magnetic-parameters" selection={props.selection}>
      <ObjectMaterialPanel {...props} />
    </DedicatedInspectorRouteFrame>
  );
}

export function ObjectMaterialInspectorPanel(props: InspectorPanelProps) {
  return (
    <DedicatedInspectorRouteFrame owner="object.material" selection={props.selection}>
      <ObjectMaterialPanel {...props} />
    </DedicatedInspectorRouteFrame>
  );
}

export function ObjectRegionGeometryInspectorPanel(props: InspectorPanelProps) {
  return (
    <DedicatedInspectorRouteFrame owner="object.region.geometry" selection={props.selection}>
      <ObjectRegionGeometryPanel {...props} />
    </DedicatedInspectorRouteFrame>
  );
}

export function ObjectRegionShapeInspectorPanel(props: InspectorPanelProps) {
  return (
    <DedicatedInspectorRouteFrame owner="object.region.shape" selection={props.selection}>
      <ObjectRegionGeometryPanel {...props} />
    </DedicatedInspectorRouteFrame>
  );
}

export function ObjectRegionMagneticParametersInspectorPanel(props: InspectorPanelProps) {
  return (
    <DedicatedInspectorRouteFrame owner="object.region.magnetic-parameters" selection={props.selection}>
      <ObjectRegionMagneticParametersPanel {...props} />
    </DedicatedInspectorRouteFrame>
  );
}

export function ObjectRegionMaterialInspectorPanel(props: InspectorPanelProps) {
  return (
    <DedicatedInspectorRouteFrame owner="object.region.material" selection={props.selection}>
      <ObjectRegionMagneticParametersPanel {...props} />
    </DedicatedInspectorRouteFrame>
  );
}

export function ObjectRegionTextureInspectorPanel(props: InspectorPanelProps) {
  return (
    <DedicatedInspectorRouteFrame owner="object.region.texture" selection={props.selection}>
      <ObjectRegionTexturePanel {...props} />
    </DedicatedInspectorRouteFrame>
  );
}

export function ObjectRegionMagneticTextureInspectorPanel(props: InspectorPanelProps) {
  return (
    <DedicatedInspectorRouteFrame owner="object.region-magnetic-texture" selection={props.selection}>
      <ObjectRegionTexturePanel {...props} />
    </DedicatedInspectorRouteFrame>
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
  return (
    <DedicatedInspectorRouteFrame owner="mesh.grid" selection={props.selection}>
      <FdmGridInspectorPanel {...props} />
    </DedicatedInspectorRouteFrame>
  );
}

export function FdmGridDescriptorInspectorPanel(props: InspectorPanelProps) {
  return (
    <DedicatedInspectorRouteFrame owner="mesh.grid.descriptor" selection={props.selection}>
      <FdmGridInspectorPanel {...props} />
    </DedicatedInspectorRouteFrame>
  );
}

export function FdmGridCommonInspectorPanel(props: InspectorPanelProps) {
  return (
    <DedicatedInspectorRouteFrame owner="mesh.grid.common" selection={props.selection}>
      <FdmGridInspectorPanel {...props} />
    </DedicatedInspectorRouteFrame>
  );
}

export function FdmGridLayersInspectorPanel(props: InspectorPanelProps) {
  return (
    <DedicatedInspectorRouteFrame owner="mesh.grid.layers" selection={props.selection}>
      <FdmGridInspectorPanel {...props} />
    </DedicatedInspectorRouteFrame>
  );
}

export function FdmGridLayerInspectorPanel(props: InspectorPanelProps) {
  return (
    <DedicatedInspectorRouteFrame owner="mesh.grid.layer" selection={props.selection}>
      <FdmGridInspectorPanel {...props} />
    </DedicatedInspectorRouteFrame>
  );
}

export function FdmGridNativeGridInspectorPanel(props: InspectorPanelProps) {
  return (
    <DedicatedInspectorRouteFrame owner="mesh.grid.layer.native-grid" selection={props.selection}>
      <FdmGridInspectorPanel {...props} />
    </DedicatedInspectorRouteFrame>
  );
}

export function FdmGridLayerMaskInspectorPanel(props: InspectorPanelProps) {
  return (
    <DedicatedInspectorRouteFrame owner="mesh.grid.layer.mask" selection={props.selection}>
      <FdmGridInspectorPanel {...props} />
    </DedicatedInspectorRouteFrame>
  );
}

export function FdmGridLayerTransferInspectorPanel(props: InspectorPanelProps) {
  return (
    <DedicatedInspectorRouteFrame owner="mesh.grid.layer.transfer" selection={props.selection}>
      <FdmGridInspectorPanel {...props} />
    </DedicatedInspectorRouteFrame>
  );
}

export function FdmGridLayerProvenanceInspectorPanel(props: InspectorPanelProps) {
  return (
    <DedicatedInspectorRouteFrame owner="mesh.grid.layer.provenance" selection={props.selection}>
      <FdmGridInspectorPanel {...props} />
    </DedicatedInspectorRouteFrame>
  );
}

export function FdmGridMagneticSupportInspectorPanel(props: InspectorPanelProps) {
  return (
    <DedicatedInspectorRouteFrame owner="mesh.grid.magnetic-support" selection={props.selection}>
      <FdmGridInspectorPanel {...props} />
    </DedicatedInspectorRouteFrame>
  );
}

export function FdmGridActiveUnassignedInspectorPanel(props: InspectorPanelProps) {
  return (
    <DedicatedInspectorRouteFrame owner="mesh.grid.active-unassigned" selection={props.selection}>
      <FdmGridInspectorPanel {...props} />
    </DedicatedInspectorRouteFrame>
  );
}

export function FdmGridMaskInspectorPanel(props: InspectorPanelProps) {
  return (
    <DedicatedInspectorRouteFrame owner="mesh.grid.mask" selection={props.selection}>
      <FdmGridInspectorPanel {...props} />
    </DedicatedInspectorRouteFrame>
  );
}

export function FdmGridProvenanceInspectorPanel(props: InspectorPanelProps) {
  return (
    <DedicatedInspectorRouteFrame owner="mesh.grid.provenance" selection={props.selection}>
      <FdmGridInspectorPanel {...props} />
    </DedicatedInspectorRouteFrame>
  );
}

export function FdmGridRegionInspectorPanel(props: InspectorPanelProps) {
  return (
    <DedicatedInspectorRouteFrame owner="mesh.grid.region" selection={props.selection}>
      <FdmGridInspectorPanel {...props} />
    </DedicatedInspectorRouteFrame>
  );
}

export function FdmGridUniverseOutsideSupportInspectorPanel(props: InspectorPanelProps) {
  return (
    <DedicatedInspectorRouteFrame owner="mesh.grid.universe-outside-support" selection={props.selection}>
      <FdmGridInspectorPanel {...props} />
    </DedicatedInspectorRouteFrame>
  );
}

export function FdmCellInspectorPanel(props: InspectorPanelProps) {
  return (
    <DedicatedInspectorRouteFrame owner="fdm.cell" selection={props.selection}>
      <FdmGridInspectorPanel {...props} />
    </DedicatedInspectorRouteFrame>
  );
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
  return (
    <DedicatedInspectorRouteFrame owner="study.stage.action" selection={props.selection}>
      <StudyStageInspectorRouter {...props} />
    </DedicatedInspectorRouteFrame>
  );
}

export function StudyStageAddFieldDriveInspectorPanel(props: InspectorPanelProps) {
  return (
    <DedicatedInspectorRouteFrame owner="study.stage.add_field_drive" selection={props.selection}>
      <StudyStageInspectorRouter {...props} />
    </DedicatedInspectorRouteFrame>
  );
}

export function StudyStageAutosaveInspectorPanel(props: InspectorPanelProps) {
  return (
    <DedicatedInspectorRouteFrame owner="study.stage.autosave" selection={props.selection}>
      <StudyStageInspectorRouter {...props} />
    </DedicatedInspectorRouteFrame>
  );
}

export function StudyStageFftResponseInspectorPanel(props: InspectorPanelProps) {
  return (
    <DedicatedInspectorRouteFrame owner="study.stage.fft_response" selection={props.selection}>
      <StudyStageInspectorRouter {...props} />
    </DedicatedInspectorRouteFrame>
  );
}

export function StudyStageHysteresisInspectorPanel(props: InspectorPanelProps) {
  return (
    <DedicatedInspectorRouteFrame owner="study.stage.hysteresis" selection={props.selection}>
      <StudyStageInspectorRouter {...props} />
    </DedicatedInspectorRouteFrame>
  );
}

export function StudyStageRelaxInspectorPanel(props: InspectorPanelProps) {
  return (
    <DedicatedInspectorRouteFrame owner="study.stage.relax" selection={props.selection}>
      <StudyStageInspectorRouter {...props} />
    </DedicatedInspectorRouteFrame>
  );
}

export function StudyStageRunInspectorPanel(props: InspectorPanelProps) {
  return (
    <DedicatedInspectorRouteFrame owner="study.stage.run" selection={props.selection}>
      <StudyStageInspectorRouter {...props} />
    </DedicatedInspectorRouteFrame>
  );
}

export function StudyStageTableAutosaveInspectorPanel(props: InspectorPanelProps) {
  return (
    <DedicatedInspectorRouteFrame owner="study.stage.table_autosave" selection={props.selection}>
      <StudyStageInspectorRouter {...props} />
    </DedicatedInspectorRouteFrame>
  );
}

export function StudyStageChangeDeviceInspectorPanel(props: InspectorPanelProps) {
  return (
    <DedicatedInspectorRouteFrame owner="study.stage.change_device" selection={props.selection}>
      <StudyStageInspectorRouter {...props} />
    </DedicatedInspectorRouteFrame>
  );
}

export function StudyStageSaveStateInspectorPanel(props: InspectorPanelProps) {
  return (
    <DedicatedInspectorRouteFrame owner="study.stage.save_state" selection={props.selection}>
      <StudyStageInspectorRouter {...props} />
    </DedicatedInspectorRouteFrame>
  );
}
