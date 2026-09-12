import type {
  FrequencyDomainJsonArtifactResource,
  SceneResource,
} from "@/kernel/api/apiTypes";
import type {
  ModeCompositionController,
  ModeCompositionResource,
} from "@/kernel/visualization/ModeCompositionController";

import type {
  ModeCompositionCompatibleObject,
  ModeCompositionInspectorDependencies,
  ModeCompositionInspectorSpectrum,
  ModeCompositionSpectrumParticipation,
  ModeCompositionSpectrumParticipationFractions,
  ModeCompositionSpectrumMode,
  ModeCompositionSpectrumSample,
} from "./modeCompositionInspectorTypes";

type JsonRecord = Record<string, unknown>;

export interface ModeCompositionInspectorResourceInputs {
  readonly controller: Pick<
    ModeCompositionController,
    "assign" | "mutate" | "remove" | "setPhaseClock" | "updateLayer"
  >;
  readonly composition: ModeCompositionResource | null;
  readonly scene: SceneResource | null;
  readonly spectrumArtifact: FrequencyDomainJsonArtifactResource | null;
}

/**
 * Maps only the published `spectrum.v3` identity and participation metadata.
 * It deliberately does not fetch a mode field: field bytes remain demand-driven
 * when the viewport accepts an enabled composition layer.
 */
export function modeCompositionInspectorDependenciesFromResources({
  composition,
  controller,
  scene,
  spectrumArtifact,
}: ModeCompositionInspectorResourceInputs): ModeCompositionInspectorDependencies {
  const spectrum = modeCompositionSpectrumFromArtifact(spectrumArtifact);
  const compatibleObjects = compatibleObjectsFromScene(scene, spectrumArtifact);

  return {
    compatibleObjects,
    controller: composition ? controller : null,
    resource: composition,
    spectrum,
  };
}

export function modeCompositionSpectrumFromArtifact(
  artifact: FrequencyDomainJsonArtifactResource | null,
): ModeCompositionInspectorSpectrum | null {
  const payload = unwrapArtifactPayload(artifact);
  const samples = array(payload?.samples)
    .map(mapSpectrumSample)
    .filter((sample): sample is ModeCompositionSpectrumSample => sample !== null);
  return samples.length > 0 ? { samples } : null;
}

export function compatibleObjectsFromScene(
  scene: SceneResource | null,
  artifact: FrequencyDomainJsonArtifactResource | null,
): readonly ModeCompositionCompatibleObject[] {
  const participantIds = participatingObjectIds(unwrapArtifactPayload(artifact));
  if (participantIds.size === 0) return [];

  return (scene?.objects ?? [])
    .filter((object) => participantIds.has(object.id))
    .map((object) => ({
      label: nonEmptyString(object.name) ?? object.id,
      objectId: object.id,
      targetId: `object:${object.id}`,
    }));
}

function mapSpectrumSample(value: unknown): ModeCompositionSpectrumSample | null {
  const record = asRecord(value);
  const sampleId = nonEmptyString(record?.sample_id);
  if (!record || !sampleId) return null;
  const sampleIndex = finiteInteger(record.sample_index);
  const modes = array(record.modes)
    .map(mapSpectrumMode)
    .filter((mode): mode is ModeCompositionSpectrumMode => mode !== null);
  return {
    label: sampleIndex === null ? sampleId : `Sample ${sampleIndex}`,
    modes,
    sampleId,
  };
}

function mapSpectrumMode(value: unknown): ModeCompositionSpectrumMode | null {
  const record = asRecord(value);
  const frequencyHz = finiteNumber(record?.frequency_hz);
  const modeId = nonEmptyString(record?.mode_id);
  if (!record || frequencyHz === null || !modeId) return null;
  const branchId = modeBranchId(record.branch_id);
  const rawModeIndex = finiteInteger(record.raw_mode_index);
  const residualNorm = finiteNumber(record.residual_relative_l2);
  const participation = mapSpectrumParticipation(record.component_participation);
  return {
    ...(branchId ? { branchId } : {}),
    fieldId: nonEmptyString(record.mode_field_id),
    frequencyHz,
    modeId,
    ...(participation ? { participation } : {}),
    ...(rawModeIndex !== null
      ? { rawModeIndex }
      : {}),
    ...(residualNorm !== null
      ? { residualNorm }
      : {}),
  };
}

function mapSpectrumParticipation(value: unknown): ModeCompositionSpectrumParticipation | null {
  const record = asRecord(value);
  if (!record || record.status !== "ready") return null;
  const global = mapParticipationFractions(record.global);
  if (!global) return null;
  const objects = array(record.objects)
    .map((object) => {
      const objectRecord = asRecord(object);
      const objectId = nonEmptyString(objectRecord?.object_id);
      const fractions = mapParticipationFractions(objectRecord?.components);
      return objectId && fractions ? { fractions, objectId } : null;
    })
    .filter((object): object is NonNullable<typeof object> => object !== null);
  return { global, objects };
}

function mapParticipationFractions(
  value: unknown,
): ModeCompositionSpectrumParticipationFractions | null {
  const record = asRecord(value);
  if (!record) return null;
  const total = finiteNumber(record.total);
  const x = finiteNumber(record.x);
  const y = finiteNumber(record.y);
  const z = finiteNumber(record.z);
  return total === null || x === null || y === null || z === null
    ? null
    : { total, x, y, z };
}

function participatingObjectIds(payload: JsonRecord | null): ReadonlySet<string> {
  const objectIds = new Set<string>();
  for (const sample of array(payload?.samples)) {
    const sampleRecord = asRecord(sample);
    for (const mode of array(sampleRecord?.modes)) {
      const modeRecord = asRecord(mode);
      const participation = asRecord(modeRecord?.component_participation);
      for (const object of array(participation?.objects)) {
        const objectId = nonEmptyString(asRecord(object)?.object_id);
        if (objectId) objectIds.add(objectId);
      }
    }
  }
  return objectIds;
}

function unwrapArtifactPayload(
  artifact: FrequencyDomainJsonArtifactResource | null,
): JsonRecord | null {
  const record = asRecord(artifact);
  return asRecord(record?.payload) ?? record;
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function array(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function finiteInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function modeBranchId(value: unknown): string | null {
  const integer = finiteInteger(value);
  return integer === null ? nonEmptyString(value) : String(integer);
}
