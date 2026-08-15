import type { ComponentType } from "react";

import type { InspectorPanelProps } from "../../inspectorTypes";
import {
  EigenBranchesInspectorPanel,
  EigenKPathInspectorPanel,
  EigenModesInspectorPanel,
  EigenProvenanceInspectorPanel,
  EigenSpectrumInspectorPanel,
  EigenStudyInspectorPanel,
  FrequencyResponseFrequencyPointsInspectorPanel,
  FrequencyResponseFieldsInspectorPanel,
  FrequencyResponsePointInspectorPanel,
  FrequencyResponseProvenanceInspectorPanel,
  FrequencyResponseStudyInspectorPanel,
  FmrPeaksInspectorPanel,
} from "../frequency-domain/FrequencyDomainResultInspectors";
import { EigenDispersionInspectorPanel } from "../frequency-domain/EigenDispersionInspectorPanel";
import { EigenModeInspectorPanel } from "../frequency-domain/EigenModeInspectorPanel";
import {
  PhysicsFirstResultInspectorFrame,
  PhysicsFirstResultInspectorPanel,
} from "./PhysicsFirstResultInspectorPanel";

function ScientificFrameRoute({
  Panel,
  props,
}: {
  Panel: ComponentType<InspectorPanelProps>;
  props: InspectorPanelProps;
}) {
  return (
    <PhysicsFirstResultInspectorFrame selection={props.selection}>
      <Panel {...props} />
    </PhysicsFirstResultInspectorFrame>
  );
}

export function DynamicsResultInspector(props: InspectorPanelProps) {
  return <PhysicsFirstResultInspectorPanel {...props} />;
}

export function ResonanceOverviewResultInspector(props: InspectorPanelProps) {
  return <PhysicsFirstResultInspectorPanel {...props} />;
}

export function ResonanceModalStageResultInspector(props: InspectorPanelProps) {
  return <ScientificFrameRoute Panel={EigenStudyInspectorPanel} props={props} />;
}

export function ResonanceDrivenStageResultInspector(props: InspectorPanelProps) {
  return <ScientificFrameRoute Panel={FrequencyResponseStudyInspectorPanel} props={props} />;
}

export function ResonanceModalSpectrumResultInspector(props: InspectorPanelProps) {
  return <ScientificFrameRoute Panel={EigenSpectrumInspectorPanel} props={props} />;
}

export function ResonanceModeShapesResultInspector(props: InspectorPanelProps) {
  return <ScientificFrameRoute Panel={EigenModesInspectorPanel} props={props} />;
}

export function ResonanceModalModeResultInspector(props: InspectorPanelProps) {
  return <ScientificFrameRoute Panel={EigenModeInspectorPanel} props={props} />;
}

export function ResonanceModalCouplingResultInspector(props: InspectorPanelProps) {
  return <PhysicsFirstResultInspectorPanel {...props} />;
}

export function ResonanceModalProvenanceResultInspector(props: InspectorPanelProps) {
  return (
    <PhysicsFirstResultInspectorFrame selection={props.selection}>
      <EigenProvenanceInspectorPanel
        {...props}
        canonicalFamily="FMR modal lane · k = 0"
        linksTitle="FMR Modal Provenance Links"
        title="FMR Modal Provenance"
      />
    </PhysicsFirstResultInspectorFrame>
  );
}

export function ResonanceDrivenSpectrumResultInspector(props: InspectorPanelProps) {
  return <PhysicsFirstResultInspectorPanel {...props} />;
}

export function ResonanceDrivenPeaksResultInspector(props: InspectorPanelProps) {
  return <ScientificFrameRoute Panel={FmrPeaksInspectorPanel} props={props} />;
}

export function ResonanceFrequencyPointsResultInspector(props: InspectorPanelProps) {
  return <ScientificFrameRoute Panel={FrequencyResponseFrequencyPointsInspectorPanel} props={props} />;
}

export function ResonanceResponseFieldsResultInspector(props: InspectorPanelProps) {
  return <ScientificFrameRoute Panel={FrequencyResponseFieldsInspectorPanel} props={props} />;
}

export function ResonanceResponseFieldResultInspector(props: InspectorPanelProps) {
  return <ScientificFrameRoute Panel={FrequencyResponsePointInspectorPanel} props={props} />;
}

export function ResonanceDrivenProvenanceResultInspector(props: InspectorPanelProps) {
  return (
    <PhysicsFirstResultInspectorFrame selection={props.selection}>
      <FrequencyResponseProvenanceInspectorPanel
        {...props}
        canonicalFamily="FMR driven lane · A(0,f)"
        linksTitle="FMR Driven Provenance Links"
        title="FMR Driven Provenance"
      />
    </PhysicsFirstResultInspectorFrame>
  );
}

export function DispersionOverviewResultInspector(props: InspectorPanelProps) {
  return <PhysicsFirstResultInspectorPanel {...props} />;
}

export function DispersionModalStageResultInspector(props: InspectorPanelProps) {
  return <ScientificFrameRoute Panel={EigenStudyInspectorPanel} props={props} />;
}

export function DispersionDrivenStageResultInspector(props: InspectorPanelProps) {
  return <ScientificFrameRoute Panel={FrequencyResponseStudyInspectorPanel} props={props} />;
}

export function DispersionKSamplingResultInspector(props: InspectorPanelProps) {
  return <ScientificFrameRoute Panel={EigenKPathInspectorPanel} props={props} />;
}

export function DispersionRelationResultInspector(props: InspectorPanelProps) {
  return <ScientificFrameRoute Panel={EigenDispersionInspectorPanel} props={props} />;
}

export function DispersionBranchesResultInspector(props: InspectorPanelProps) {
  return <ScientificFrameRoute Panel={EigenBranchesInspectorPanel} props={props} />;
}

export function DispersionModesAtKResultInspector(props: InspectorPanelProps) {
  return <ScientificFrameRoute Panel={EigenModesInspectorPanel} props={props} />;
}

export function DispersionModeAtKResultInspector(props: InspectorPanelProps) {
  return <ScientificFrameRoute Panel={EigenModeInspectorPanel} props={props} />;
}

export function DispersionModalProvenanceResultInspector(props: InspectorPanelProps) {
  return (
    <PhysicsFirstResultInspectorFrame selection={props.selection}>
      <EigenProvenanceInspectorPanel
        {...props}
        canonicalFamily="Modal dispersion lane · fₙ(k)"
        linksTitle="Modal Dispersion Provenance Links"
        title="Modal Dispersion Provenance"
      />
    </PhysicsFirstResultInspectorFrame>
  );
}

export function DispersionResponseMapResultInspector(props: InspectorPanelProps) {
  return <PhysicsFirstResultInspectorPanel {...props} />;
}

export function DispersionResponseFieldAtKResultInspector(props: InspectorPanelProps) {
  return <ScientificFrameRoute Panel={FrequencyResponsePointInspectorPanel} props={props} />;
}

export function DispersionDrivenProvenanceResultInspector(props: InspectorPanelProps) {
  return (
    <PhysicsFirstResultInspectorFrame selection={props.selection}>
      <FrequencyResponseProvenanceInspectorPanel
        {...props}
        canonicalFamily="Driven response-map lane · A(k,f)"
        linksTitle="Driven Response-Map Provenance Links"
        title="Driven Response-Map Provenance"
      />
    </PhysicsFirstResultInspectorFrame>
  );
}

export function HysteresisResultInspector(props: InspectorPanelProps) {
  return <PhysicsFirstResultInspectorPanel {...props} />;
}
