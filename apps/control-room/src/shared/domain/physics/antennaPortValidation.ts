import type { SceneResource } from "@/kernel/api/apiTypes";

export type AntennaPortModeResource = NonNullable<
  SceneResource["antenna_port_modes"]
>[number];

function portStructureMessages(
  mode: AntennaPortModeResource,
): string[] {
  const messages: string[] = [];
  const closedLoop = mode.schema_version === "antenna_port_mode.v3";
  if (mode.schema_version !== "antenna_port_mode.v2" && !closedLoop) {
    messages.push("schema must be antenna_port_mode.v2 or antenna_port_mode.v3");
  }
  const normalization = record(record(mode)?.normalization);
  if (closedLoop && (normalization?.kind !== "source_cut_rt0" || !text(normalization.source_cut_ref)
      || normalization.orientation !== "minus_outward")) {
    messages.push("v3 normalization requires an explicit source_cut_rt0 reference with minus_outward orientation");
  }
  if (!closedLoop && normalization) messages.push("source-cut normalization requires explicit port v3");
  if (mode.branches.length < 2) {
    messages.push("requires at least two branches");
  }
  if (
    mode.normalization_current_a !== undefined &&
    mode.normalization_current_a !== 1
  ) {
    messages.push("normalization current must equal 1 A");
  }

  const branchIds = mode.branches.map((branch) => branch.id);
  if (
    branchIds.some((id) => id.trim().length === 0) ||
    new Set(branchIds).size !== branchIds.length
  ) {
    messages.push("branch ids must be non-empty and unique");
  }

  const terminalRefs = mode.branches.flatMap((branch) => [
    branch.inlet_terminal_ref,
    branch.outlet_terminal_ref,
  ]);
  if (terminalRefs.some((reference) => reference.trim().length === 0)) {
    messages.push("all terminal references must be non-empty");
  }
  if (new Set(terminalRefs).size !== terminalRefs.length) {
    messages.push("terminal references must be unique");
  }

  let totalWeight = 0;
  let positiveWeight = 0;
  let hasNegativeWeight = false;
  for (const branch of mode.branches) {
    if (!Number.isFinite(branch.signed_weight) || (!closedLoop && branch.signed_weight === 0)) {
      messages.push(`branch ${branch.id} weight must be ${closedLoop ? "finite" : "finite and non-zero"}`);
      continue;
    }
    totalWeight += branch.signed_weight;
    if (branch.signed_weight > 0) positiveWeight += branch.signed_weight;
    if (branch.signed_weight < 0) hasNegativeWeight = true;
  }
  if (!closedLoop && (Math.abs(positiveWeight - 1) > 1e-12 || !hasNegativeWeight)) {
    messages.push("positive branch weights must sum to 1 and include a return branch");
  }
  if (!closedLoop && Math.abs(totalWeight) > 1e-12) {
    messages.push("all branch weights must sum to 0");
  }
  return messages;
}

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as RecordValue : null;
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && !value.includes("\0");
}

/** v3 uses its explicit source cut, never legacy boundary-current normalization. */
function closedLoopReferenceMessages(mode: AntennaPortModeResource, transport: RecordValue): string[] {
  const normalization = record(record(mode)?.normalization);
  const authored = record(transport.structured_current_closure);
  const prepared = record(transport.conservative_current_source);
  const pending = authored?.kind === "closed_geometry" && authored.schema_version === "structured_current_closure.v2";
  const source = prepared?.kind === "closed_geometry_potential_jump" && prepared.schema_version === "conservative_current_source.v2"
    ? prepared : null;
  const closure = pending ? authored : record(source?.closure);
  const cuts = Array.isArray(closure?.source_cuts) ? closure.source_cuts.map(record) : [];
  const cutId = cuts.length === 1 ? cuts[0]?.[pending ? "source_cut_id" : "id"] : null;
  const messages: string[] = [];
  if ((!pending && (!source || closure?.kind !== "closed_geometry")) || !text(cutId)
      || normalization?.source_cut_ref !== cutId) {
    messages.push("v3 port requires its exact single authored or prepared closed-loop source cut");
    return messages;
  }
  if (pending) {
    if (record(cuts[0]?.region)?.object_id !== mode.source_object_id) messages.push("source cut belongs to a different object");
    return messages;
  }
  if (source?.object_id !== mode.source_object_id || mode.branches.length !== 2) {
    messages.push("prepared v3 requires two observed branches of the same source object");
  }
  const observations = Array.isArray(source?.terminal_observations) ? source.terminal_observations.map(record) : [];
  for (const branch of mode.branches) {
    const inlet = observations.filter((item) => item?.id === branch.inlet_terminal_ref);
    const outlet = observations.filter((item) => item?.id === branch.outlet_terminal_ref);
    if (inlet.length !== 1 || outlet.length !== 1 || !text(inlet[0]?.part_id)
        || inlet[0]?.part_id !== outlet[0]?.part_id || inlet[0]?.selector !== "local_u_min"
        || outlet[0]?.selector !== "local_u_max") {
      messages.push(`branch '${branch.id}' requires unique inlet/outlet observations on the same conductor part`);
    }
  }
  return messages;
}

function terminalInventory(mode: AntennaPortModeResource, transport: RecordValue) {
  const messages: string[] = [];
  const terminals = new Map<string, { objectId: string | null; valid: boolean }>();
  let inventory: unknown[];
  let inventoryKind: string;
  let observationKey: "id" | "observation_id" | null = null;

  // Match fullmag-ir::validate_v2_port_structure: never fall back from a
  // present authored source to preparation or unrelated boundary IDs.
  const hasSource = transport.conservative_current_source != null;
  const hasPreparation = transport.external_lead_preparation != null;
  if (hasSource || hasPreparation) {
    inventoryKind = hasSource ? "current-source terminal_observations" : "lead-preparation extensions";
    const authored = record(hasSource ? transport.conservative_current_source : transport.external_lead_preparation);
    const expectedKind = hasSource ? "external_lead_current" : "isolated_branch_straight_stubs";
    const expectedSchema = hasSource ? "conservative_current_source.v1" : "antenna_external_lead_preparation.v1";
    const entries = authored?.[hasSource ? "terminal_observations" : "extensions"];
    const drives = authored?.drives;
    observationKey = hasSource ? "id" : "observation_id";
    if (!authored || authored.kind !== expectedKind || authored.schema_version !== expectedSchema ||
        !Array.isArray(entries) || entries.length === 0 || !Array.isArray(drives) ||
        entries.some((entry) => !text(record(entry)?.[observationKey!]) || !text(record(entry)?.object_id)) ||
        drives.some((drive) => !text(record(drive)?.id) || !text(record(drive)?.port_mode_ref))) {
      messages.push(`${inventoryKind} is unsupported or malformed; boundary fallback is not allowed`);
      return { terminals, inventoryKind, messages, available: false };
    }
    if (drives.filter((drive) => record(drive)?.port_mode_ref === mode.id).length !== 1) {
      messages.push(`port '${mode.id}' requires exactly one explicitly authored current-source drive`);
    }
    inventory = entries;
  } else {
    inventoryKind = "CurrentTransport boundaries";
    if (!Array.isArray(transport.boundaries)) {
      messages.push(`current transport '${mode.current_transport_id}' boundaries are unavailable`);
      return { terminals, inventoryKind, messages, available: false };
    }
    inventory = transport.boundaries;
  }

  for (const entry of inventory) {
    const item = record(entry);
    const id = item?.[observationKey ?? "id"];
    if (!item || !text(id)) {
      messages.push(`${inventoryKind} contains a malformed terminal identity`);
      continue;
    }
    if (terminals.has(id)) {
      messages.push(`terminal '${id}' is ambiguous in ${inventoryKind}`);
      terminals.set(id, { objectId: null, valid: false });
      continue;
    }
    if (observationKey) {
      terminals.set(id, { objectId: item.object_id as string, valid: true });
    } else {
      const surfaces = item.surfaces;
      const objectIds = Array.isArray(surfaces) && surfaces.every((surface) => text(record(surface)?.object_id))
        ? new Set(surfaces.map((surface) => record(surface)!.object_id as string)) : new Set<string>();
      const valid = ["equipotential_current_terminal", "voltage_electrode", "normal_current_electrode"].includes(String(item.kind))
        && objectIds.size === 1;
      terminals.set(id, { objectId: objectIds.size === 1 ? [...objectIds][0] : null, valid });
    }
  }
  return { terminals, inventoryKind, messages, available: true };
}

export interface AntennaPortTerminalChoice {
  id: string;
  label: string;
}

/** Resolve existing terminal identities from the same inventory used by validation. */
export function antennaPortTerminalChoices(
  scene: SceneResource | null, mode: AntennaPortModeResource,
): AntennaPortTerminalChoice[] {
  const matches = (scene?.current_transports ?? []).filter(item => item.name === mode.current_transport_id);
  if (!scene || matches.length !== 1) return [];
  const transport = record(matches[0]);
  if (!transport || transport.kind !== "current_transport" || transport.model !== "ohmic_poisson" ||
      (transport.coupling !== undefined && transport.coupling !== "one_way") || transport.time_envelope != null ||
      (transport.structured_current_closure != null && transport.conservative_current_source != null)) return [];
  const objects = scene.objects ?? [];
  const domain = transport.domain;
  if (!Array.isArray(domain) || domain.length === 0 || domain.some(region => !text(record(region)?.object_id))) return [];
  const domainIds = new Set(domain.map(region => record(region)!.object_id));
  let terminals: Map<string, { objectId: string | null; valid: boolean }>;
  const observationLabels = new Map<string, string>();
  if (mode.schema_version === "antenna_port_mode.v3") {
    const source = record(transport.conservative_current_source);
    if (transport.structured_current_closure != null || source?.schema_version !== "conservative_current_source.v2" ||
        source.kind !== "closed_geometry_potential_jump" || source.object_id !== mode.source_object_id ||
        !Array.isArray(source.terminal_observations)) return [];
    terminals = new Map();
    for (const value of source.terminal_observations) {
      const item = record(value);
      if (!text(item?.id)) continue;
      observationLabels.set(item.id, `${item.part_id} · ${item.selector}`);
      const duplicate = terminals.has(item.id);
      terminals.set(item.id, { objectId: mode.source_object_id, valid: !duplicate && text(item.part_id) &&
        (item.selector === "local_u_min" || item.selector === "local_u_max") });
    }
  } else if (mode.schema_version === "antenna_port_mode.v2") {
    const inventory = terminalInventory(mode, transport);
    if (!inventory.available) return [];
    terminals = inventory.terminals;
  } else return [];
  const choices: AntennaPortTerminalChoice[] = [];
  for (const [id, terminal] of terminals) {
    const owners = objects.filter(object => object.id === terminal.objectId);
    if (!terminal.valid || !terminal.objectId || !domainIds.has(terminal.objectId) || owners.length !== 1) continue;
    choices.push({ id, label: `${id} · ${owners[0].name || terminal.objectId}${observationLabels.has(id) ? ` · ${observationLabels.get(id)}` : ""}` });
  }
  return choices;
}

/** Only reference authoring is checked here; native mesh/source validation remains authoritative. */
function portReferenceMessages(mode: AntennaPortModeResource, scene: SceneResource | null): string[] {
  if (!scene) return ["scene is unavailable; port references cannot be validated"];
  const messages: string[] = [];
  const objects = scene.objects ?? [];
  const source = objects.filter((object) => object.id === mode.source_object_id);
  if (source.length !== 1) {
    messages.push(`source object '${mode.source_object_id}' is missing or ambiguous`);
  } else if (source[0].role !== "antenna" && source[0].role !== "conductor") {
    messages.push(`source object '${mode.source_object_id}' must be an authored antenna or conductor`);
  }
  const transports = (scene.current_transports ?? []).filter((item) => item.name === mode.current_transport_id);
  if (transports.length !== 1) {
    messages.push(`current transport '${mode.current_transport_id}' is missing or ambiguous`);
    return messages;
  }
  const transport = record(transports[0]);
  if (!transport || transport.kind !== "current_transport" || transport.model !== "ohmic_poisson" ||
      (transport.coupling !== undefined && transport.coupling !== "one_way") ||
      transport.time_envelope != null) {
    messages.push(`current transport '${mode.current_transport_id}' requires static one-way OhmicPoisson authoring`);
    return messages;
  }
  if (transport.structured_current_closure != null && transport.conservative_current_source != null) {
    messages.push("current transport cannot combine structured_current_closure with conservative_current_source; choose one explicit source");
    return messages;
  }
  const domain = transport.domain;
  if (!Array.isArray(domain) || domain.length === 0 || domain.some((region) => !text(record(region)?.object_id))) {
    messages.push(`current transport '${mode.current_transport_id}' has an unavailable or malformed domain`);
    return messages;
  }
  const domainObjects = new Set(domain.map((region) => record(region)!.object_id as string));
  if (mode.schema_version === "antenna_port_mode.v3") {
    if (!domainObjects.has(mode.source_object_id)) messages.push("v3 source object is outside the transport domain");
    return [...messages, ...closedLoopReferenceMessages(mode, transport)];
  }
  const { terminals, inventoryKind, messages: inventoryMessages, available } = terminalInventory(mode, transport);
  messages.push(...inventoryMessages);
  if (!available) return messages;
  for (const branch of mode.branches) {
    const branchObjects: string[] = [];
    for (const [role, reference] of [["inlet", branch.inlet_terminal_ref], ["outlet", branch.outlet_terminal_ref]]) {
      const terminal = terminals.get(reference);
      if (!terminal) {
        messages.push(`branch '${branch.id}' ${role} terminal '${reference}' does not exist in ${inventoryKind}`);
      } else if (!terminal.valid || !terminal.objectId || !domainObjects.has(terminal.objectId) ||
                 objects.filter((object) => object.id === terminal.objectId).length !== 1) {
        messages.push(`branch '${branch.id}' ${role} terminal '${reference}' must belong to one existing conductor object in the CurrentTransport domain`);
      } else {
        branchObjects.push(terminal.objectId);
      }
    }
    if (branchObjects.length === 2 && branchObjects[0] !== branchObjects[1]) {
      messages.push(`branch '${branch.id}' inlet and outlet must belong to the same conductor object`);
    }
    if (branch.signed_weight > 0 && branchObjects.length === 2 && branchObjects[0] !== mode.source_object_id) {
      messages.push(`branch '${branch.id}' positive signal path must belong to source object '${mode.source_object_id}'`);
    }
  }
  return messages;
}

export function antennaPortValidationMessages(
  mode: AntennaPortModeResource,
  scene: SceneResource | null,
): string[] {
  return [...portStructureMessages(mode), ...portReferenceMessages(mode, scene)];
}

export function antennaPortStatus(
  mode: AntennaPortModeResource,
  scene: SceneResource | null,
): "ready" | "warning" {
  return antennaPortValidationMessages(mode, scene).length === 0 ? "ready" : "warning";
}
