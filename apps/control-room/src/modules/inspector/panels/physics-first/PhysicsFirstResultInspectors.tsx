import type { ComponentType } from "react";

import type { InspectorPanelProps } from "../../inspectorTypes";
import { FieldRow } from "../../primitives/FieldRow";
import { InspectorGroup } from "../../primitives/InspectorGroup";
import {
  EigenBranchesInspectorPanel,
  EigenKPathInspectorPanel,
  EigenModesInspectorPanel,
  EigenProvenanceInspectorPanel,
  EigenSpectrumInspectorPanel,
  EigenStudyInspectorPanel,
  FrequencyDomainResponseMapInspectorPanel,
  FrequencyResponseFrequencyPointsInspectorPanel,
  FrequencyResponseFieldsInspectorPanel,
  FrequencyResponsePointInspectorPanel,
  FrequencyResponseProvenanceInspectorPanel,
  FrequencyResponseSweepInspectorPanel,
  FrequencyResponseStudyInspectorPanel,
  FmrPeaksInspectorPanel,
} from "../frequency-domain/FrequencyDomainResultInspectors";
import { EigenDispersionInspectorPanel } from "../frequency-domain/EigenDispersionInspectorPanel";
import { EigenModeInspectorPanel } from "../frequency-domain/EigenModeInspectorPanel";
import {
  PhysicsFirstResultInspectorFrame,
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
  return (
    <PhysicsFirstResultInspectorFrame selection={props.selection}>
      <InspectorGroup title="Time-domain observables" badge="Dynamics">
        <FieldRow label="Primary axis" value="Time t; published SI/display unit is shown by the dataset" />
        <FieldRow
          label="Published traces"
          value="Magnetization, energy, torque and other owner-backed observables"
        />
        <FieldRow label="Saved states" value="State snapshots appear only when the runtime publishes them" />
      </InspectorGroup>
      <InspectorGroup title="Spectral handoff" badge="Analysis">
        <FieldRow label="Temporal Spectrum" value="FFT of a published time trace; not an eigenfrequency result" />
        <FieldRow label="Spin-Wave Spectrum" value="S(k,f) only when wavevector-resolved samples are published" />
        <FieldRow label="Handoff rule" value="Choose an owned dataset before opening Analysis" />
      </InspectorGroup>
    </PhysicsFirstResultInspectorFrame>
  );
}

export function LegacyTimeDomainResultInspector({
  selection,
}: InspectorPanelProps) {
  const ref = selection.ref?.type === "frequency-domain" ? selection.ref : null;
  const isDsf = selection.kind === "results.time_domain.dsf_point";
  return (
    <PhysicsFirstResultInspectorFrame selection={selection}>
      <InspectorGroup title="Legacy time-domain selection" badge="legacy/partial">
        <FieldRow label="Selected item" mono value={ref?.pointId ?? selection.nodeId ?? "Unavailable"} />
        <FieldRow label="Sample" mono value={ref?.sampleId ?? "Unavailable"} />
        <FieldRow label="Frequency" value={formatLegacyFrequency(ref?.frequencyHz)} />
        <FieldRow label="Frequency bin" value={formatLegacyValue(ref?.frequencyIndex)} />
        {isDsf ? (
          <>
            <FieldRow label="k context" value={ref?.kContextKind ?? "Unavailable"} />
            <FieldRow label="Wavevector" value={formatLegacyWavevector(ref?.kPathCoordinateRadPerM)} />
          </>
        ) : null}
        <FieldRow label="Field payload" value="Unavailable from legacy reader" />
        <FieldRow label="Canonical dataset" value="Not published; keep this selection legacy/partial" />
      </InspectorGroup>
    </PhysicsFirstResultInspectorFrame>
  );
}

export function ResonanceOverviewResultInspector(props: InspectorPanelProps) {
  return (
    <PhysicsFirstResultInspectorFrame selection={props.selection}>
      <InspectorGroup title="Modal lane" badge="Eigenmodes">
        <FieldRow label="Product" value="Eigenfrequency Spectrum and complex Mode Shapes" />
        <FieldRow label="Equilibrium" value="Linearization about the published equilibrium state" />
        <FieldRow label="FMR activity" value="Only when RF coupling or oscillator-strength evidence is published" />
      </InspectorGroup>
      <InspectorGroup title="Driven lane" badge="Frequency-driven">
        <FieldRow label="Product" value="FMR Response Spectrum when qualified; otherwise Harmonic Response Spectrum" />
        <FieldRow label="Drive" value="Requires a published magnetic RF excitation and observable contract" />
        <FieldRow label="FMR naming gate" value="No drive or observable evidence means no FMR label" />
      </InspectorGroup>
      <InspectorGroup title="Comparison boundary" badge="Compatibility">
        <FieldRow label="Allowed comparison" value="Matching equilibrium, geometry/mesh, k context, units and observable definition" />
        <FieldRow label="Mismatch policy" value="Explain the mismatch; do not draw a misleading modal-driven overlay" />
      </InspectorGroup>
    </PhysicsFirstResultInspectorFrame>
  );
}

function formatLegacyFrequency(value: number | undefined): string {
  return value == null || !Number.isFinite(value)
    ? "Unavailable"
    : `${value.toExponential(6)} Hz`;
}

function formatLegacyValue(value: number | string | undefined): string {
  return value == null ? "Unavailable" : String(value);
}

function formatLegacyWavevector(value: number | undefined): string {
  return value == null || !Number.isFinite(value)
    ? "Unavailable"
    : `${value.toExponential(6)} rad/m`;
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
  const ref = props.selection.ref?.type === "frequency-domain"
    ? props.selection.ref
    : null;
  return (
    <PhysicsFirstResultInspectorFrame selection={props.selection}>
      <InspectorGroup title="Published RF Coupling" badge="qualified">
        <FieldRow
          label="Observable evidence"
          value={ref?.observableId ?? "rf coupling observable"}
        />
        <FieldRow
          label="Physical meaning"
          value="Modal drive overlap / oscillator-strength evidence"
        />
        <FieldRow
          label="FMR naming gate"
          value="FMR-active only because the manifest publishes coupling evidence"
        />
        <FieldRow
          label="Visualization handoff"
          value="Select a mode field to inspect phase-resolved 3D data"
        />
      </InspectorGroup>
    </PhysicsFirstResultInspectorFrame>
  );
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
  return (
    <ScientificFrameRoute Panel={FrequencyResponseSweepInspectorPanel} props={props} />
  );
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
  return (
    <PhysicsFirstResultInspectorFrame selection={props.selection}>
      <InspectorGroup title="Wavevector products" badge="k-resolved">
        <FieldRow label="Modal relation" value="Modal relation fₙ(k) from eigenfrequency branches" />
        <FieldRow label="Driven map" value="Driven map A(k,f), χ(k,f) or P_abs(k,f), with the published observable unit" />
        <FieldRow label="k context" value="Fixed k, k path or k grid; a single nonzero-k sample is not a dispersion relation" />
      </InspectorGroup>
      <InspectorGroup title="Product boundary" badge="Physics-first">
        <FieldRow label="Meaning" value="A driven response map is not a modal dispersion relation" />
        <FieldRow label="Modal handoff" value="Open branches, modes at k and the exact complex mode field" />
        <FieldRow label="Driven handoff" value="Open response map, frequency points and response field at k" />
      </InspectorGroup>
    </PhysicsFirstResultInspectorFrame>
  );
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
  return (
    <ScientificFrameRoute Panel={FrequencyDomainResponseMapInspectorPanel} props={props} />
  );
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
  return (
    <PhysicsFirstResultInspectorFrame selection={props.selection}>
      <InspectorGroup title="Field sweep" badge="branch-aware">
        <FieldRow label="Field axis" value="Applied field H or B, using the unit published by the sweep resource" />
        <FieldRow label="Magnetization observable" value="M, normalized M/Ms or another explicitly published quantity" />
        <FieldRow label="Branch and turning-point data" value="Major/minor branches, reversals and coercive-point metadata when available" />
      </InspectorGroup>
      <InspectorGroup title="Analysis handoff" badge="Dataset-backed">
        <FieldRow label="Loop interpretation" value="Do not infer coercivity, remanence or saturation from a missing dataset" />
        <FieldRow label="Published artifacts" value="Sweep table, branch metadata and saved states remain owner-scoped" />
        <FieldRow label="Next surface" value="Open the selected sweep in Analysis after the resource is ready" />
      </InspectorGroup>
    </PhysicsFirstResultInspectorFrame>
  );
}
