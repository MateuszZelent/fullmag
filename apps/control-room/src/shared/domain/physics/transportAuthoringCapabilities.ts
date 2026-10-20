import type { SceneResource, TransportAuthoringCapabilityMap } from "@/kernel/api/apiTypes";

type CapabilityKey = Exclude<keyof TransportAuthoringCapabilityMap, "contract_version">;
type Family = "current_transport" | "spin_transport";
type TransportScene = Pick<SceneResource, "current_transports" | "spin_transports">;
const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const reciprocal = (source: Record<string, unknown> | null) => source?.coupling === "bidirectional" || source?.model === "magnetoresistive_poisson";

function spinRequirements(resource: Record<string, unknown>, source: Record<string, unknown> | null): CapabilityKey[] {
  const required: CapabilityKey[] = [];
  const isReciprocal = reciprocal(source) || resource.constitutive_version === "transport_constitutive.reciprocal.fullmag.v1";
  if (isReciprocal) required.push("m2_reciprocal");
  if (resource.mode === "transient") required.push("m3_transient");
  else if (!isReciprocal) required.push("m1_one_way_steady");
  const lane = record(resource.requested_execution);
  if (lane?.device === "gpu") required.push("gpu");
  if (lane?.precision === "single") required.push("single_precision");
  if (lane?.discretization === "hybrid" || lane?.execution_mode === "hybrid") required.push("hybrid");
  return required;
}

/** Intersect active-session authoring gates; canonical candidate validation remains authoritative. */
export function getTransportAuthoringCapability(
  family: Family,
  value: unknown,
  scene: TransportScene | null,
  capabilities: TransportAuthoringCapabilityMap | null,
) {
  const resource = record(value);
  if (!resource || !scene || !capabilities) return null;
  const required = new Set<CapabilityKey>();
  if (family === "current_transport") {
    required.add(reciprocal(resource) ? "m2_reciprocal" : "m1_one_way_steady");
    for (const transport of scene.spin_transports ?? []) {
      const spin = record(transport);
      if (spin && spin.current_source_id === resource.name) {
        for (const key of spinRequirements(spin, resource)) required.add(key);
      }
    }
  } else {
    const source = (scene.current_transports ?? []).map(record).find((item) => item?.name === resource.current_source_id) ?? null;
    for (const key of spinRequirements(resource, source)) required.add(key);
  }
  const entries = [...required].map((key) => ({ key, capability: capabilities[key] }));
  const blocked = entries.filter(({ capability }) => !capability?.authoring_allowed || !["semantic_only", "source_visible"].includes(capability.status));
  return {
    authoring_allowed: blocked.length === 0,
    reason: (blocked.length ? blocked : entries).map(({ key, capability }) => `${key}: ${capability?.reason ?? "Authoring capability is unavailable."}`).join(" "),
    status: blocked.length ? "unsupported" : "semantic_only",
    required: [...required],
  };
}