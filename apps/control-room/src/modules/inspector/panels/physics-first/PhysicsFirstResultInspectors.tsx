import type { ComponentType } from "react";

import type { InspectorPanelProps } from "../../inspectorTypes";
import {
  EigenBranchesInspectorPanel,
  EigenKPathInspectorPanel,
  EigenModesInspectorPanel,
  EigenSpectrumInspectorPanel,
  EigenStudyInspectorPanel,
  FrequencyResponseFrequencyPointsInspectorPanel,
  FrequencyResponseFieldsInspectorPanel,
  FrequencyResponsePointInspectorPanel,
  FrequencyResponseStudyInspectorPanel,
  FmrPeaksInspectorPanel,
} from "../frequency-domain/FrequencyDomainResultInspectors";
import { EigenDispersionInspectorPanel } from "../frequency-domain/EigenDispersionInspectorPanel";
import { EigenModeInspectorPanel } from "../frequency-domain/EigenModeInspectorPanel";
import { PhysicsFirstResultInspectorPanel } from "./PhysicsFirstResultInspectorPanel";

function render(
  Panel: ComponentType<InspectorPanelProps>,
  props: InspectorPanelProps,
) {
  return <Panel {...props} />;
}

export function DynamicsResultInspector(props: InspectorPanelProps) {
  return render(PhysicsFirstResultInspectorPanel, props);
}

export function ResonanceOverviewResultInspector(props: InspectorPanelProps) {
  return render(PhysicsFirstResultInspectorPanel, props);
}

export function ResonanceModalStageResultInspector(props: InspectorPanelProps) {
  return render(EigenStudyInspectorPanel, props);
}

export function ResonanceDrivenStageResultInspector(props: InspectorPanelProps) {
  return render(FrequencyResponseStudyInspectorPanel, props);
}

export function ResonanceModalSpectrumResultInspector(props: InspectorPanelProps) {
  return render(EigenSpectrumInspectorPanel, props);
}

export function ResonanceModeShapesResultInspector(props: InspectorPanelProps) {
  return render(EigenModesInspectorPanel, props);
}

export function ResonanceModalModeResultInspector(props: InspectorPanelProps) {
  return render(EigenModeInspectorPanel, props);
}

export function ResonanceModalCouplingResultInspector(props: InspectorPanelProps) {
  return render(PhysicsFirstResultInspectorPanel, props);
}

export function ResonanceDrivenSpectrumResultInspector(props: InspectorPanelProps) {
  return render(PhysicsFirstResultInspectorPanel, props);
}

export function ResonanceDrivenPeaksResultInspector(props: InspectorPanelProps) {
  return render(FmrPeaksInspectorPanel, props);
}

export function ResonanceFrequencyPointsResultInspector(props: InspectorPanelProps) {
  return render(FrequencyResponseFrequencyPointsInspectorPanel, props);
}

export function ResonanceResponseFieldsResultInspector(props: InspectorPanelProps) {
  return render(FrequencyResponseFieldsInspectorPanel, props);
}

export function ResonanceResponseFieldResultInspector(props: InspectorPanelProps) {
  return render(FrequencyResponsePointInspectorPanel, props);
}

export function DispersionOverviewResultInspector(props: InspectorPanelProps) {
  return render(PhysicsFirstResultInspectorPanel, props);
}

export function DispersionModalStageResultInspector(props: InspectorPanelProps) {
  return render(EigenStudyInspectorPanel, props);
}

export function DispersionDrivenStageResultInspector(props: InspectorPanelProps) {
  return render(FrequencyResponseStudyInspectorPanel, props);
}

export function DispersionKSamplingResultInspector(props: InspectorPanelProps) {
  return render(EigenKPathInspectorPanel, props);
}

export function DispersionRelationResultInspector(props: InspectorPanelProps) {
  return render(EigenDispersionInspectorPanel, props);
}

export function DispersionBranchesResultInspector(props: InspectorPanelProps) {
  return render(EigenBranchesInspectorPanel, props);
}

export function DispersionModesAtKResultInspector(props: InspectorPanelProps) {
  return render(EigenModesInspectorPanel, props);
}

export function DispersionModeAtKResultInspector(props: InspectorPanelProps) {
  return render(EigenModeInspectorPanel, props);
}

export function DispersionResponseMapResultInspector(props: InspectorPanelProps) {
  return render(PhysicsFirstResultInspectorPanel, props);
}

export function DispersionResponseFieldAtKResultInspector(props: InspectorPanelProps) {
  return render(FrequencyResponsePointInspectorPanel, props);
}

export function HysteresisResultInspector(props: InspectorPanelProps) {
  return render(PhysicsFirstResultInspectorPanel, props);
}
