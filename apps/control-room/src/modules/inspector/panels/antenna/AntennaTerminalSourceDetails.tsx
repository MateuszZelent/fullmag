import type { AntennaTerminalSourceState } from "./AntennaTerminalSourceModel";
import { terminalSourceRecord as record } from "./AntennaTerminalSourceModel";
import { Button } from "@/shared/ui/Button";
import { FeedbackBanner } from "../../primitives/FeedbackBanner";
import { FieldRow } from "../../primitives/FieldRow";
import { InspectorGroup } from "../../primitives/InspectorGroup";

const value = (entry: unknown) => typeof entry === "string" && entry.trim() ? entry : "Unavailable";
const number = (entry: unknown) => typeof entry === "number" && Number.isFinite(entry)
  ? new Intl.NumberFormat("en", { maximumSignificantDigits: 6 }).format(entry) : "Unavailable";

export function AntennaTerminalSourceDetails({ model, current, onGeometry, onPort }: {
  model: AntennaTerminalSourceState;
  current: boolean;
  onGeometry: () => void;
  onPort: (portId: string) => void;
}) {
  return <div data-testid="antenna-terminal-source">
    <InspectorGroup title="Circuit source and port observations" badge="source definition"
      description="Explicit source data from the scene. Execution and computed fields have separate validation gates.">
      {!current ? <FeedbackBanner kind="warning" message="Waiting for the current session-scoped scene; navigation is unavailable." /> : null}
      {model.messages.map(message => <FeedbackBanner key={message} kind="error" message={message} />)}
      <p className="fm-inspector-hint">Source voltage drives the circuit. Port inlet/outlet references observe current; signed branch weights do not impose electrode currents.</p>
      <Button type="button" disabled={!current} onClick={onGeometry}>Open Geometry</Button>
    </InspectorGroup>
    {model.sources.map((source, sourceIndex) => <InspectorGroup key={`${source.transport.name}:${sourceIndex}`}
      title={source.kind === "authored" ? "Authored voltage source" : source.kind === "prepared" ? "Prepared mesh source" : "Explicit current source"}
      badge={source.kind === "authored" ? "authored" : source.kind === "prepared" ? "prepared descriptor" : "review required"}>
      <FieldRow label="Current transport" value={value(source.transport.name)} mono />
      <FieldRow label="Source schema" value={value(source.definition?.schema_version)} mono />
      {source.messages.map(message => <FeedbackBanner key={message} kind="error" message={message} />)}
      {source.kind === "authored" ? <>
        <FieldRow label="Closure ID" value={value(source.definition?.closure_id)} mono />
        {source.cuts.map((cut, index) => {
          const plane = record(cut.plane), drive = record(cut.drive), region = record(cut.region);
          return <InspectorGroup key={`${String(cut.source_cut_id)}:${index}`} title={`Voltage source cut ${index + 1}`}>
            <FieldRow label="Source cut ID" value={value(cut.source_cut_id)} mono />
            <FieldRow label="Circuit ID" value={value(cut.circuit_id)} mono />
            <FieldRow label="Conductor part" value={value(region?.region_id)} mono />
            <FieldRow label="Drive ID" value={value(drive?.drive_id)} mono />
            <FieldRow label="Impressed potential jump V⁺ − V⁻" value={number(drive?.potential_jump_V)} unit="V" />
            <FieldRow label="Coordinate frame" value={plane?.coordinate_frame === undefined ? "world (legacy default)" : value(plane.coordinate_frame)} />
            <FieldRow label="Cut plane axis" value={value(plane?.axis)} />
            <FieldRow label="Cut plane offset" value={number(plane?.offset_m)} unit="m" />
            <FieldRow label="Oriented cut normal" value={plane?.normal === "positive_axis" ? `+${value(plane.axis)}` : plane?.normal === "negative_axis" ? `−${value(plane.axis)}` : "Unavailable"} />
          </InspectorGroup>;
        })}
      </> : null}
      {source.kind === "prepared" ? <>
        <FieldRow label="Prepared revision" value={value(source.definition?.revision)} mono />
        <FieldRow label="Mesh digest" value={value(source.definition?.mesh_digest)} mono />
        <FieldRow label="Authored input digest" value={value(source.definition?.authored_input_digest)} mono />
        <p className="fm-inspector-hint">Mesh-bound source descriptor. These cuts contain paired faces; an authored plane is not reconstructed from them.</p>
        {source.cuts.map((cut, index) => <InspectorGroup key={`${String(cut.id)}:${index}`} title={`Prepared source cut ${index + 1}`}>
          <FieldRow label="Source cut ID" value={value(cut.id)} mono />
          <FieldRow label="Prepared potential drop" value={number(cut.potential_drop_v)} unit="V" />
          <FieldRow label="Paired mesh faces" value={Array.isArray(cut.face_pairs) ? cut.face_pairs.length : "Unavailable"} />
        </InspectorGroup>)}
      </> : null}
      {source.ports.map((port, index) => <InspectorGroup key={`${port.id}:${index}`} title={`Observation port ${index + 1}`}>
        <FieldRow label="Port ID" value={value(port.id)} mono />
        <FieldRow label="Source cut reference" value={value(record(record(port)?.normalization)?.source_cut_ref)} mono />
        <FieldRow label="Normalization orientation" value={value(record(record(port)?.normalization)?.orientation)} mono />
        {(Array.isArray(port.branches) ? port.branches : []).filter(branch => branch != null).map((branch, ordinal) => <InspectorGroup key={`${branch.id}:${ordinal}`} title={`Observed branch ${ordinal + 1}`}>
          <FieldRow label="Branch ID" value={value(branch.id)} mono />
          <FieldRow label="Inlet observation" value={value(branch.inlet_terminal_ref)} mono />
          <FieldRow label="Outlet observation" value={value(branch.outlet_terminal_ref)} mono />
          <FieldRow label="Signed observation weight" value={number(branch.signed_weight)} unit="1" />
        </InspectorGroup>)}
        <Button type="button" disabled={!current || typeof port.id !== "string" || !port.id.trim() || model.messages.length > 0 || source.messages.length > 0} onClick={() => onPort(port.id)}>Open port {value(port.id)}</Button>
      </InspectorGroup>)}
    </InspectorGroup>)}
  </div>;
}