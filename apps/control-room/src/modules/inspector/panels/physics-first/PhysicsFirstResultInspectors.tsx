import type { InspectorPanelProps } from "../../inspectorTypes";
import { HysteresisRootResultInspector } from "./HysteresisResultSpecs";
import {
  DispersionBranchesResultInspector,
  DispersionDrivenStageResultInspector,
  DispersionKSamplingResultInspector,
  DispersionModalStageResultInspector,
  DispersionModeAtKResultInspector,
  DispersionModesAtKResultInspector,
  DispersionOverviewResultInspector,
  DispersionRelationResultInspector,
  DispersionResponseFieldAtKResultInspector,
  DispersionResponseMapResultInspector,
  DynamicsResultTemplateInspector,
  LegacyTimeDomainDsfPointInspector,
  ResonanceDrivenPeaksResultInspector,
  ResonanceDrivenSpectrumResultInspector,
  ResonanceDrivenStageResultInspector,
  ResonanceModalCouplingResultInspector,
  ResonanceModalModeResultInspector,
  ResonanceModalSpectrumResultInspector,
  ResonanceModalStageResultInspector,
  ResonanceModeShapesResultInspector,
  ResonanceOverviewResultInspector,
  ResonanceResponseFieldResultInspector,
  ResonanceResponseFieldsResultInspector,
} from "./ResonanceAndDispersionSpecs";

export {
  DispersionBranchesResultInspector,
  DispersionDrivenStageResultInspector,
  DispersionKSamplingResultInspector,
  DispersionModalStageResultInspector,
  DispersionModeAtKResultInspector,
  DispersionModesAtKResultInspector,
  DispersionOverviewResultInspector,
  DispersionRelationResultInspector,
  DispersionResponseFieldAtKResultInspector,
  DispersionResponseMapResultInspector,
  DynamicsResultTemplateInspector as DynamicsResultInspector,
  HysteresisRootResultInspector as HysteresisResultInspector,
  ResonanceDrivenPeaksResultInspector,
  ResonanceDrivenSpectrumResultInspector,
  ResonanceDrivenStageResultInspector,
  ResonanceModalCouplingResultInspector,
  ResonanceModalModeResultInspector,
  ResonanceModalSpectrumResultInspector,
  ResonanceModalStageResultInspector,
  ResonanceModeShapesResultInspector,
  ResonanceOverviewResultInspector,
  ResonanceResponseFieldResultInspector,
  ResonanceResponseFieldsResultInspector,
  ResonanceResponseFieldsResultInspector as ResonanceFrequencyPointsResultInspector,
  ResonanceModalStageResultInspector as ResonanceModalProvenanceResultInspector,
  ResonanceDrivenStageResultInspector as ResonanceDrivenProvenanceResultInspector,
  DispersionModalStageResultInspector as DispersionModalProvenanceResultInspector,
  DispersionDrivenStageResultInspector as DispersionDrivenProvenanceResultInspector,
};

export function LegacyTimeDomainResultInspector(props: InspectorPanelProps) {
  if (props.selection.kind === "results.time_domain.dsf_point") {
    return <LegacyTimeDomainDsfPointInspector {...props} />;
  }
  return <DynamicsResultTemplateInspector {...props} />;
}
