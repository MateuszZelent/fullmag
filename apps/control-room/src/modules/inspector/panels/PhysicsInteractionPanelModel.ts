import type {
  JsonObject,
  ObjectInteractionKind,
  ObjectInteractionPatchRequest,
  ObjectInteractionResource,
} from "@/kernel/api/apiTypes";
import {
  isOptionalObjectInteractionKind,
  OBJECT_INTERACTION_KINDS,
} from "@/kernel/api/apiTypes";

export { OBJECT_INTERACTION_KINDS };
export type { ObjectInteractionKind };

export interface PhysicsInteractionDraft {
  enabled: boolean;
  interactionKind: ObjectInteractionKind;
  paramsText: string;
  present: boolean;
}

export function interactionLabel(kind: ObjectInteractionKind): string {
  if (kind === "exchange") return "Exchange";
  if (kind === "demag") return "Demagnetization";
  if (kind === "interfacial_dmi") return "Interfacial DMI";
  return "Uniaxial anisotropy";
}

export function isOptionalInteraction(kind: ObjectInteractionKind): boolean {
  return isOptionalObjectInteractionKind(kind);
}

export function defaultObjectInteractionResource(
  objectId: string,
  interactionKind: ObjectInteractionKind,
): ObjectInteractionResource {
  return {
    enabled: false,
    interaction_kind: interactionKind,
    object_id: objectId,
    params: {},
    present: false,
  };
}

export function draftFromInteractionResource(
  interactionKind: ObjectInteractionKind,
  resource: ObjectInteractionResource,
): PhysicsInteractionDraft {
  const optional = isOptionalInteraction(interactionKind);
  const present = resource.present || !optional;
  return {
    enabled: resource.present ? resource.enabled : !optional,
    interactionKind,
    paramsText: formatInteractionParams(resource.params),
    present,
  };
}

export function draftKeyForInteractionResource(
  objectId: string | null,
  interactionKind: ObjectInteractionKind,
  resource: ObjectInteractionResource,
): string {
  return [
    objectId ?? "",
    interactionKind,
    resource.present ? "present" : "absent",
    resource.enabled ? "enabled" : "disabled",
    formatInteractionParams(resource.params),
  ].join(":");
}

export function formatInteractionParams(params: JsonObject): string {
  if (Object.keys(params).length === 0) return "{}";
  return JSON.stringify(params, null, 2);
}

export function buildInteractionPatch({
  enabled,
  interactionKind,
  paramsText,
  present,
}: PhysicsInteractionDraft): { error: string } | { patch: ObjectInteractionPatchRequest } {
  if (!present && !isOptionalInteraction(interactionKind)) {
    return {
      error: `${interactionLabel(interactionKind)} is required and cannot be removed.`,
    };
  }

  const params = parseParams(paramsText);
  if (!params.ok) {
    return { error: params.error };
  }

  return {
    patch: {
      enabled,
      params: params.value,
      present,
    },
  };
}

function parseParams(
  paramsText: string,
): { ok: true; value: JsonObject } | { error: string; ok: false } {
  try {
    const parsed = JSON.parse(paramsText || "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        error: "Interaction parameters must be a JSON object.",
        ok: false,
      };
    }
    return { ok: true, value: parsed as JsonObject };
  } catch {
    return {
      error: "Interaction parameters must be a JSON object.",
      ok: false,
    };
  }
}
