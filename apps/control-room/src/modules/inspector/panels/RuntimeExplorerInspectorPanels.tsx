import type {
  RuntimeExecutionDetail,
  RuntimeExplorerDetail,
} from "@/kernel/resources/runtimeExplorerTypes";
import { useRuntimeExplorerDetail } from "@/kernel/resources/runtimeExplorerDetailStore";

import type { InspectorPanelProps } from "../inspectorTypes";
import { FieldRow } from "../primitives/FieldRow";
import { InspectorGroup } from "../primitives/InspectorGroup";

function available(value: number | string | null): string {
  return value === null ? "Unavailable" : String(value);
}

function ownerIdentity(value: string | null): string {
  return value === null ? "Unavailable / unverified" : value;
}

function useDetailFromSelection(
  selection: InspectorPanelProps["selection"],
): RuntimeExplorerDetail | null {
  const ref = selection.ref?.type === "runtime-explorer"
    ? selection.ref
    : null;
  return useRuntimeExplorerDetail(ref);
}

function ExecutionGroup({
  detail,
  title,
}: {
  detail: RuntimeExecutionDetail | null;
  title: string;
}) {
  return (
    <InspectorGroup title={title}>
      <FieldRow label="Backend" value={available(detail?.backend ?? null)} />
      <FieldRow label="Device" value={available(detail?.device ?? null)} />
      <FieldRow label="Mode" value={available(detail?.mode ?? null)} />
      <FieldRow label="Precision" value={available(detail?.precision ?? null)} />
      <FieldRow label="Engine" value={available(detail?.engineId ?? null)} mono />
      <FieldRow label="Runtime family" value={available(detail?.runtimeFamily ?? null)} />
      <FieldRow label="Worker" value={available(detail?.worker ?? null)} mono />
    </InspectorGroup>
  );
}

function EvidenceGroup({ detail }: { detail: RuntimeExplorerDetail }) {
  if (detail.facts.length === 0) return null;
  return (
    <InspectorGroup title="Evidence">
      {detail.facts.map((fact) => (
        <FieldRow key={`${fact.label}:${fact.value}`} label={fact.label} value={fact.value} />
      ))}
    </InspectorGroup>
  );
}

function MissingSelectionPanel() {
  return (
    <div className="fm-inspector-panel">
      <InspectorGroup title="Unavailable">
        <FieldRow label="Reason" value="Typed runtime selection is unavailable." />
      </InspectorGroup>
    </div>
  );
}

function RuntimeResourcePanel({ selection }: InspectorPanelProps) {
  const detail = useDetailFromSelection(selection);
  if (!detail) return <MissingSelectionPanel />;
  return (
    <div className="fm-inspector-panel">
      <InspectorGroup title="Identity">
        <FieldRow label="Resource key" value={detail.key} mono />
        <FieldRow label="Schema" value={available(detail.schema)} mono />
        <FieldRow label="Owner" value={ownerIdentity(detail.owner)} mono />
      </InspectorGroup>
      <InspectorGroup title="Version">
        <FieldRow label="Revision" value={available(detail.revision)} />
        <FieldRow label="Generation" value={available(detail.generation)} mono />
        <FieldRow label="Condition" value={detail.condition} status={detail.condition} />
        <FieldRow label="Source state" value={detail.sourceStatus} status={detail.sourceStatus} />
      </InspectorGroup>
      <InspectorGroup title="Storage">
        <FieldRow label="Size" value={detail.sizeBytes === null ? "Unavailable" : `${detail.sizeBytes} B`} />
        <FieldRow label="Cache" value={available(detail.cache)} />
        <FieldRow label="Location" value={available(detail.location)} mono />
      </InspectorGroup>
      {detail.message ? (
        <InspectorGroup title="Status">
          <FieldRow label="Message" value={detail.message} status={detail.sourceStatus} />
        </InspectorGroup>
      ) : null}
      <EvidenceGroup detail={detail} />
    </div>
  );
}

function RuntimeJobPanel({
  selection,
  title,
}: InspectorPanelProps & { title: string }) {
  const detail = useDetailFromSelection(selection);
  if (!detail) return <MissingSelectionPanel />;
  return (
    <div className="fm-inspector-panel">
      <InspectorGroup title={title}>
        <FieldRow label="Resource key" value={detail.key} mono />
        <FieldRow label="Owner" value={ownerIdentity(detail.owner)} mono />
        <FieldRow label="Revision" value={available(detail.revision)} />
        <FieldRow label="Lifecycle status" value={available(detail.lifecycleStatus)} status={detail.condition} />
        <FieldRow label="Condition" value={detail.condition} status={detail.condition} />
        <FieldRow label="Source state" value={detail.sourceStatus} status={detail.sourceStatus} />
        <FieldRow label="Message" value={available(detail.message)} />
      </InspectorGroup>
      <ExecutionGroup detail={detail.requestedExecution} title="Requested execution" />
      <ExecutionGroup detail={detail.resolvedExecution} title="Resolved execution" />
      <EvidenceGroup detail={detail} />
    </div>
  );
}

function RuntimeDiagnosticPanel({
  selection,
  title,
}: InspectorPanelProps & { title: string }) {
  const detail = useDetailFromSelection(selection);
  if (!detail) return <MissingSelectionPanel />;
  return (
    <div className="fm-inspector-panel">
      <InspectorGroup title={detail.contractGap ? "Contract gap" : title}>
        <FieldRow label="Resource key" value={detail.key} mono />
        <FieldRow label="Owner" value={ownerIdentity(detail.owner)} mono />
        <FieldRow label="Revision" value={available(detail.revision)} />
        <FieldRow label="Condition" value={detail.condition} status={detail.condition} />
        <FieldRow label="Source state" value={detail.sourceStatus} status={detail.sourceStatus} />
        <FieldRow label="Message" value={available(detail.message)} />
      </InspectorGroup>
      <EvidenceGroup detail={detail} />
    </div>
  );
}

export function RuntimeResourceInspectorPanel(props: InspectorPanelProps) {
  return <RuntimeResourcePanel {...props} />;
}

export function RuntimeRunJobInspectorPanel(props: InspectorPanelProps) {
  return <RuntimeJobPanel {...props} title="Run lifecycle" />;
}

export function RuntimeStageJobInspectorPanel(props: InspectorPanelProps) {
  return <RuntimeJobPanel {...props} title="Stage lifecycle" />;
}

export function RuntimeCommandJobInspectorPanel(props: InspectorPanelProps) {
  return <RuntimeJobPanel {...props} title="Command lifecycle" />;
}

export function RuntimeProblemDiagnosticInspectorPanel(props: InspectorPanelProps) {
  return <RuntimeDiagnosticPanel {...props} title="Problem diagnostic" />;
}

export function RuntimeHealthDiagnosticInspectorPanel(props: InspectorPanelProps) {
  return <RuntimeDiagnosticPanel {...props} title="Health diagnostic" />;
}

export function RuntimeCapabilityDiagnosticInspectorPanel(props: InspectorPanelProps) {
  return <RuntimeDiagnosticPanel {...props} title="Capability diagnostic" />;
}

export function RuntimeSolverDiagnosticInspectorPanel(props: InspectorPanelProps) {
  return <RuntimeDiagnosticPanel {...props} title="Solver diagnostic" />;
}

export function RuntimeMeshDiagnosticInspectorPanel(props: InspectorPanelProps) {
  return <RuntimeDiagnosticPanel {...props} title="Mesh diagnostic" />;
}

export function RuntimeFrequencyDiagnosticInspectorPanel(props: InspectorPanelProps) {
  return <RuntimeDiagnosticPanel {...props} title="Frequency-domain diagnostic" />;
}

export function RuntimePerformanceDiagnosticInspectorPanel(props: InspectorPanelProps) {
  return <RuntimeDiagnosticPanel {...props} title="Performance diagnostic" />;
}
