import type { SceneResource } from "@/kernel/api/apiTypes";

export type AntennaPortModeResource = NonNullable<
  SceneResource["antenna_port_modes"]
>[number];

export function antennaPortValidationMessages(
  mode: AntennaPortModeResource,
): string[] {
  const messages: string[] = [];
  if (mode.schema_version !== "antenna_port_mode.v2") {
    messages.push("schema must be antenna_port_mode.v2");
  }
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
    if (!Number.isFinite(branch.signed_weight) || branch.signed_weight === 0) {
      messages.push(`branch ${branch.id} weight must be finite and non-zero`);
      continue;
    }
    totalWeight += branch.signed_weight;
    if (branch.signed_weight > 0) positiveWeight += branch.signed_weight;
    if (branch.signed_weight < 0) hasNegativeWeight = true;
  }
  if (Math.abs(positiveWeight - 1) > 1e-12 || !hasNegativeWeight) {
    messages.push("positive branch weights must sum to 1 and include a return branch");
  }
  if (Math.abs(totalWeight) > 1e-12) {
    messages.push("all branch weights must sum to 0");
  }
  return messages;
}

export function antennaPortStatus(
  mode: AntennaPortModeResource,
): "ready" | "warning" {
  return antennaPortValidationMessages(mode).length === 0 ? "ready" : "warning";
}
