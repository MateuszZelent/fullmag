import type { SceneResource } from "@/kernel/api/apiTypes";
import { antennaPortValidationMessages } from "@/shared/domain/physics/antennaPortValidation";

type Port = NonNullable<SceneResource["antenna_port_modes"]>[number];
type Transport = NonNullable<SceneResource["current_transports"]>[number];
type RecordValue = Record<string, unknown>;
export interface AntennaTerminalSource {
  transport: Transport;
  ports: Port[];
  kind: "authored" | "prepared" | "unsupported" | "preparation";
  definition: RecordValue | null;
  cuts: RecordValue[];
  messages: string[];
}
export interface AntennaTerminalSourceState {
  mode: "explicit" | "preparation" | "unavailable";
  sources: AntennaTerminalSource[];
  messages: string[];
}
export function terminalSourceRecord(value: unknown): RecordValue | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : null;
}
const text = (value: unknown): value is string => typeof value === "string" && Boolean(value.trim()) && !value.includes("\0");
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** Presentation of explicit authored contracts; never a materialization or physics certificate. */
export function antennaTerminalSourceState(scene: SceneResource | null, objectId: string): AntennaTerminalSourceState {
  if (!scene) return { mode: "unavailable", sources: [], messages: ["Current scene is unavailable."] };
  const objects = (scene.objects ?? []).filter(object => object.id === objectId);
  const ports = (scene.antenna_port_modes ?? []).filter(port => port.source_object_id === objectId);
  const transports = (scene.current_transports ?? []).filter(transport => ports.some(port => port.current_transport_id === transport.name)
    || Array.isArray(transport.domain) && transport.domain.some(ref => terminalSourceRecord(ref)?.object_id === objectId));
  const messages: string[] = [];
  if (objects.length !== 1) messages.push("A unique source object is required.");
  if (ports.length === 0) messages.push("No observation port is bound to this source.");
  if (ports.some(port => !text(port.id))) messages.push("Observation port identity is missing or malformed.");
  if (new Set(ports.map(port => port.id)).size !== ports.length) messages.push("Observation port IDs are ambiguous.");
  if (new Set(transports.map(transport => transport.name)).size !== transports.length) messages.push("Current transport IDs are ambiguous.");
  for (const port of ports) {
    if (transports.filter(transport => transport.name === port.current_transport_id).length !== 1) messages.push(`Port '${port.id}' requires one current transport.`);
  }
  const sources = transports.map((transport): AntennaTerminalSource => {
    const ownPorts = ports.filter(port => port.current_transport_id === transport.name);
    const authored = terminalSourceRecord(transport.structured_current_closure);
    const prepared = terminalSourceRecord(transport.conservative_current_source);
    const explicit = transport.structured_current_closure != null || transport.conservative_current_source != null;
    const kind = authored?.kind === "closed_geometry" && authored.schema_version === "structured_current_closure.v2" ? "authored"
      : prepared?.kind === "closed_geometry_potential_jump" && prepared.schema_version === "conservative_current_source.v2" ? "prepared"
        : explicit ? "unsupported" : "preparation";
    const definition = kind === "authored" ? authored : kind === "prepared" ? prepared : authored ?? prepared;
    const closure = kind === "authored" ? authored : terminalSourceRecord(prepared?.closure);
    const cuts = Array.isArray(closure?.source_cuts) ? closure.source_cuts.map(terminalSourceRecord).filter((cut): cut is RecordValue => cut !== null) : [];
    const issues: string[] = [];
    if (!text(transport.name)) issues.push("Current transport identity is missing.");
    if (explicit && (transport.structured_current_closure != null && transport.conservative_current_source != null
      || transport.external_lead_preparation != null || transport.conservative_current_view != null
      || transport.boundaries != null && (!Array.isArray(transport.boundaries) || transport.boundaries.length > 0))) {
      issues.push("Conflicting source, preparation or legacy boundary/view definitions. Resolve them explicitly; no source is selected implicitly.");
    }
    if (kind === "unsupported") issues.push("This explicit source contract is not editable by the straight-stub form. Its definition is preserved.");
    if (kind === "authored" || kind === "prepared") {
      if (cuts.length !== 1 || !Array.isArray(closure?.source_cuts) || closure.source_cuts.length !== 1) issues.push("The current closed-circuit workflow requires exactly one explicit source cut.");
      if (ownPorts.length === 0) issues.push("The circuit has no observation port.");
      for (const port of ownPorts) {
        if (!Array.isArray(port.branches) || port.branches.some(branch => !branch || !text(branch.id) || !text(branch.inlet_terminal_ref) || !text(branch.outlet_terminal_ref))) issues.push(`Port '${port.id}' has malformed branches.`);
        else issues.push(...antennaPortValidationMessages(port, scene).map(message => `Port '${port.id}': ${message}`));
      }
    }
    if (kind === "authored") {
      if (!text(authored?.closure_id)) issues.push("Authored closure ID is missing.");
      for (const cut of cuts) {
        const plane = terminalSourceRecord(cut.plane), drive = terminalSourceRecord(cut.drive), region = terminalSourceRecord(cut.region);
        if (!text(cut.source_cut_id) || !text(cut.circuit_id) || region?.object_id !== objectId || !text(region.region_id)) issues.push("Source cut requires explicit IDs and a conductor part of this object.");
        if (plane?.coordinate_frame !== "object" || plane.axis !== "z" || !finite(plane.offset_m) || !["positive_axis", "negative_axis"].includes(String(plane.normal))) issues.push("Authored v2 cut requires an explicit object-frame z plane and oriented normal; an omitted frame is legacy world, not object.");
        if (drive?.schema_version !== "impressed_potential_jump.v1" || drive.kind !== "impressed_potential_jump" || !text(drive.drive_id) || !finite(drive.potential_jump_V) || drive.potential_jump_V === 0) issues.push("A finite nonzero impressed potential jump in V and an explicit drive ID are required.");
      }
    }
    if (kind === "prepared" && prepared?.object_id !== objectId) issues.push("Prepared source belongs to a different object.");
    return { transport, ports: ownPorts, kind, definition, cuts, messages: issues };
  });
  const explicit = sources.some(source => source.kind !== "preparation");
  return { mode: explicit ? "explicit" : messages.length ? "unavailable" : "preparation", sources, messages };
}