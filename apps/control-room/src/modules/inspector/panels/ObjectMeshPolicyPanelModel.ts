import type {
  JsonObject,
  MeshObjectConfigReplaceRequest,
  MeshObjectConfigResource,
} from "@/kernel/api/apiTypes";
import { defaultObjectMeshPolicyResource } from "@/kernel/resources/geometryLifecycleResources";

export { defaultObjectMeshPolicyResource };

export interface ObjectMeshPolicyDraft {
  configText: string;
  present: boolean;
}

export function formatObjectMeshPolicyConfig(
  config: JsonObject | null | undefined,
): string {
  if (!config || Object.keys(config).length === 0) return "{}";
  return JSON.stringify(config, null, 2);
}

export function draftFromObjectMeshPolicyResource(
  resource: MeshObjectConfigResource,
): ObjectMeshPolicyDraft {
  return {
    configText: formatObjectMeshPolicyConfig(resource.config),
    present: resource.config !== null && resource.config !== undefined,
  };
}

export function draftKeyForObjectMeshPolicyResource(
  objectId: string | null | undefined,
  resource: MeshObjectConfigResource,
): string {
  return [
    objectId ?? "",
    resource.revision,
    formatObjectMeshPolicyConfig(resource.config),
  ].join(":");
}

export function buildObjectMeshPolicyReplaceRequest({
  configText,
  present,
}: ObjectMeshPolicyDraft):
  | { error: string }
  | { request: MeshObjectConfigReplaceRequest } {
  if (!present) {
    return { request: { config: null } };
  }

  const config = parseConfig(configText);
  if (!config.ok) return { error: config.error };
  return { request: { config: config.value } };
}

function parseConfig(
  configText: string,
): { ok: true; value: JsonObject } | { error: string; ok: false } {
  try {
    const parsed = JSON.parse(configText || "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        error: "Object mesh policy config must be a JSON object.",
        ok: false,
      };
    }
    return { ok: true, value: parsed as JsonObject };
  } catch {
    return {
      error: "Object mesh policy config must be a JSON object.",
      ok: false,
    };
  }
}
