import type { SceneResource } from "@/kernel/api/apiTypes";

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function numberValue(value: unknown, unit = ""): string {
  return typeof value === "number" && Number.isFinite(value)
    ? `${value.toExponential(4)}${unit ? ` ${unit}` : ""}`
    : `unavailable${unit ? ` ${unit}` : ""}`;
}

export function antennaWaveformBandwidthValue(value: unknown): string {
  const declaration = recordValue(value);
  if (!declaration) return "not declared";
  return typeof declaration.f_max_hz === "number" && Number.isFinite(declaration.f_max_hz)
    ? numberValue(declaration.f_max_hz, "Hz")
    : "invalid declaration";
}

type EquilibriumReference = NonNullable<SceneResource["antenna_spectrum_requests"]>[number]["equilibrium_ref"];

export function antennaEquilibriumReferenceIsValid(reference: EquilibriumReference): boolean {
  const digest = (value: string) => value.length === 71 && /^sha256:[0-9a-f]{64}$/.test(value);
  const identity = (value: string) => ["antenna_accepted_equilibrium.v1:", "equilibrium_artifact.v7:"]
    .some((prefix) => value.startsWith(prefix) && digest(`sha256:${value.slice(prefix.length)}`));
  if (!reference) return false;
  if (typeof reference === "string") return identity(reference);
  if (reference.kind === "stage_output") {
    return Boolean(reference.stage_id.trim() && reference.output_id.trim());
  }
  return digest(`sha256:${reference.asset_id}`) && identity(reference.equilibrium_id) && digest(reference.content_digest);
}

export function antennaEquilibriumReferenceValue(reference: EquilibriumReference): string {
  if (!reference) return "none";
  if (typeof reference === "string") return reference || "none";
  return reference.kind === "stage_output"
    ? `${reference.stage_id} / ${reference.output_id}`
    : `${reference.equilibrium_id} / asset ${reference.asset_id} / ${reference.content_digest}`;
}
