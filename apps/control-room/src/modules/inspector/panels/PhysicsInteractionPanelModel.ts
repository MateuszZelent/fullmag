import type {
  JsonObject,
  JsonValue,
  ObjectInteractionKind,
  ObjectInteractionPatchRequest,
  ObjectInteractionResource,
  SceneResource,
} from "@/kernel/api/apiTypes";
import {
  allInteractionSpecs,
  buildObjectInteractionPatchFromDraft,
  buildStudyInteractionPatchFromDraft,
  defaultDraftForInteraction,
  draftFromObjectInteractionResource,
  findInteractionSpec,
  type InteractionSpec,
  type PhysicsInteractionDraft,
  type PhysicsInteractionId,
} from "@/shared/domain/physics/interactions";

export type { ObjectInteractionKind, PhysicsInteractionDraft, PhysicsInteractionId };

export type InteractionApplyPatchResult =
  | { error: string }
  | { patch: JsonObject; storage: "study" }
  | { patch: ObjectInteractionPatchRequest; storage: "object_interaction" };

export function interactionSelectOptions(): readonly InteractionSpec[] {
  return allInteractionSpecs();
}

export function interactionLabel(id: PhysicsInteractionId): string {
  return findInteractionSpec(id)?.label ?? id;
}

export function isWritableObjectInteraction(
  id: PhysicsInteractionId,
): id is ObjectInteractionKind {
  return isObjectInteractionKind(id) && findInteractionSpec(id)?.storage === "object_interaction";
}

export function isWritableStudyInteraction(id: PhysicsInteractionId): boolean {
  return findInteractionSpec(id)?.storage === "study";
}

export function isDeferredInteraction(id: PhysicsInteractionId): boolean {
  return findInteractionSpec(id)?.availability === "deferred";
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
    scene_revision: 0,
  };
}

export function draftFromInteractionResource(
  interactionKind: ObjectInteractionKind,
  resource: ObjectInteractionResource,
): PhysicsInteractionDraft {
  return draftFromObjectInteractionResource(
    interactionKind,
    resource.params,
    resource.present,
    resource.enabled,
  );
}

export function draftFromStudyScene(
  id: PhysicsInteractionId,
  scene: SceneResource | null | undefined,
): PhysicsInteractionDraft {
  const draft = defaultDraftForInteraction(id);
  const study = jsonObject(scene?.study);

  if (id === "demag") {
    const enabled = booleanValue(study?.demag_enabled, true);
    return {
      ...draft,
      enabled,
      present: true,
      values: {
        ...draft.values,
        method: textValue(study?.demag_realization, "auto"),
      },
    };
  }

  if (id === "exchange") {
    return {
      ...draft,
      enabled: booleanValue(study?.exchange_enabled, true),
      present: true,
    };
  }

  if (id === "zeeman") {
    const field = vector3Value(study?.external_field);
    return {
      ...draft,
      enabled: field !== null,
      present: field !== null,
      values: {
        ...draft.values,
        field: field ?? ["0", "0", "0"],
      },
    };
  }

  return draft;
}

export function draftKeyForInteraction(
  objectId: string | null | undefined,
  draft: PhysicsInteractionDraft,
): string {
  return [
    objectId ?? "",
    draft.id,
    draft.present ? "present" : "absent",
    draft.enabled ? "enabled" : "disabled",
    JSON.stringify(draft.values),
  ].join(":");
}

export function buildInteractionApplyPatch(
  draft: PhysicsInteractionDraft,
): InteractionApplyPatchResult {
  const spec = findInteractionSpec(draft.id);
  if (!spec) return { error: `Unknown physics interaction: ${draft.id}` };

  if (spec.storage === "object_interaction") {
    const result = buildObjectInteractionPatchFromDraft(draft);
    return "error" in result
      ? result
      : { patch: result.patch, storage: "object_interaction" };
  }

  if (spec.storage === "study") {
    const result = buildStudyInteractionPatchFromDraft(draft);
    return "error" in result ? result : { patch: result.patch, storage: "study" };
  }

  return {
    error:
      spec.writableReason ??
      `${spec.label} is not writable from the current control-room authoring surface.`,
  };
}

function isObjectInteractionKind(id: PhysicsInteractionId): id is ObjectInteractionKind {
  return (
    id === "exchange" ||
    id === "demag" ||
    id === "interfacial_dmi" ||
    id === "uniaxial_anisotropy"
  );
}

function jsonObject(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function textValue(value: JsonValue | undefined, fallback: string): string {
  if (typeof value === "string" && value.trim()) return value;
  return fallback;
}

function booleanValue(value: JsonValue | undefined, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function vector3Value(value: JsonValue | undefined): string[] | null {
  if (!Array.isArray(value) || value.length !== 3) return null;
  const values = value.map((entry) =>
    typeof entry === "number" || typeof entry === "string" ? String(entry) : "",
  );
  return values.every((entry) => entry.trim() !== "") ? values : null;
}
