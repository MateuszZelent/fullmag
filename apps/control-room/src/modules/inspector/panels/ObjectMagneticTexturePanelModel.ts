import type {
  JsonObject,
  ObjectPatchRequest,
  RegionListResource,
  SceneResource,
} from "@/kernel/api/apiTypes";
import type { Selection } from "@/kernel/selection/selectionTypes";
import {
  magnetizationTextureAssetId,
  presetMagnetizationAsset,
} from "@/shared/domain/magnetization-texture/assetFactory";
import { resolveMagnetizationTextureModel } from "@/shared/domain/magnetization-texture/draftModel";
import { resolveMagnetizationTextureTarget } from "@/shared/domain/magnetization-texture/targetResolver";
import type { MagnetizationTexturePresetId } from "@/shared/domain/magnetization-texture/texturePresets";
import type { MagnetizationAssetDraft } from "@/shared/domain/magnetization-texture/types";

interface JsonRecord {
  [key: string]: unknown;
}

export interface ObjectMagneticTexturePanelModel {
  assignment: string;
  asset: MagnetizationAssetDraft | null;
  assetId: string;
  assetKind: string;
  assetLabel: string;
  baseRevision: number | null;
  mapping: string;
  mode: "committed" | "missing";
  objectId: string;
  presetKind: string;
  regionId: string | null;
  targetKind: "object" | "region";
  textureTransform: string;
  boundsMin?: number[] | null;
  boundsMax?: number[] | null;
}

export interface ObjectMagneticTextureDraft {
  assetLabel: string;
  chirality: string;
  clampMode: string;
  directionX: string;
  directionY: string;
  directionZ: string;
  magnetizationRef: string;
  mappingProjection: string;
  mappingSpace: string;
  pivotX: string;
  pivotY: string;
  pivotZ: string;
  polarity: string;
  presetKind: MagnetizationTexturePresetId;
  rotationXDeg: string;
  rotationYDeg: string;
  rotationZDeg: string;
  scaleX: string;
  scaleY: string;
  scaleZ: string;
  seed: string;
  translationX: string;
  translationY: string;
  translationZ: string;
  // New presets fields:
  plane: string;
  circulation: string;
  core_polarity: string;
  core_radius: string;
  radius: string;
  wall_width: string;
  normal_axis: string;
  center_offset: string;
  leftX: string;
  leftY: string;
  leftZ: string;
  rightX: string;
  rightY: string;
  rightZ: string;
  wallX: string;
  wallY: string;
  wallZ: string;
  kind: string;
  wavevectorX: string;
  wavevectorY: string;
  wavevectorZ: string;
  e1X: string;
  e1Y: string;
  e1Z: string;
  e2X: string;
  e2Y: string;
  e2Z: string;
  phase_rad: string;
  cone_axisX: string;
  cone_axisY: string;
  cone_axisZ: string;
  cone_angle_rad: string;
}

function asRecord(value: unknown): JsonRecord | null {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNumber (value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asNumberArray(value: unknown): number[] | null {
  return Array.isArray(value) &&
    value.every((entry) => typeof entry === "number" && Number.isFinite(entry))
    ? value
    : null;
}

const PRESET_IDS = new Set<string>([
  "uniform",
  "random_seeded",
  "vortex",
  "antivortex",
  "bloch_skyrmion",
  "neel_skyrmion",
  "domain_wall",
  "two_domain",
  "helical",
  "conical",
]);

function asPresetKind(value: unknown): MagnetizationTexturePresetId | null {
  return typeof value === "string" && PRESET_IDS.has(value)
    ? (value as MagnetizationTexturePresetId)
    : null;
}

function selectedObjectId(selection: Selection): string | null {
  return selection.ref?.type === "scene-object"
    ? selection.ref.objectId
    : selection.objectId;
}

function sceneObjectForSelection(
  selection: Selection,
  scene: SceneResource | null,
): { object: JsonRecord | null; objectId: string | null; revision: number | null } {
  const objectId = selectedObjectId(selection);
  const sceneRecord = asRecord(scene);
  const object = Array.isArray(sceneRecord?.objects)
    ? sceneRecord.objects
        .map(asRecord)
        .find((entry) => asString(entry?.id) === objectId) ?? null
    : null;

  return {
    object,
    objectId,
    revision: asNumber(sceneRecord?.revision),
  };
}

function formatJson(value: unknown): string {
  if (!value || typeof value !== "object") return "not configured";
  return JSON.stringify(value, null, 2);
}

function vectorFromRecord(
  record: JsonRecord | null,
  key: string,
  fallback: [number, number, number],
): [number, number, number] {
  const value = record?.[key];
  if (!Array.isArray(value)) return fallback;
  const numbers = value.map(asNumber);
  return numbers.length >= 3 && numbers.slice(0, 3).every((entry) => entry !== null)
    ? ([numbers[0], numbers[1], numbers[2]] as [number, number, number])
    : fallback;
}

function quatFromRecord(
  record: JsonRecord | null,
  key: string,
): [number, number, number, number] {
  const value = record?.[key];
  if (!Array.isArray(value)) return [0, 0, 0, 1];
  const numbers = value.map(asNumber);
  return numbers.length >= 4 && numbers.slice(0, 4).every((entry) => entry !== null)
    ? ([numbers[0], numbers[1], numbers[2], numbers[3]] as [
        number,
        number,
        number,
        number,
      ])
    : [0, 0, 0, 1];
}

function numberText(value: number): string {
  if (value === 0) return "0";
  return Number(value.toPrecision(12)).toString();
}

function vec3Text(
  value: [number, number, number],
): [string, string, string] {
  return [numberText(value[0]), numberText(value[1]), numberText(value[2])];
}

function quatToEulerDegrees(
  quat: [number, number, number, number],
): [number, number, number] {
  const [x, y, z, w] = quat;
  const roll = Math.atan2(
    2 * (w * x + y * z),
    1 - 2 * (x * x + y * y),
  );
  const pitch = Math.asin(Math.max(-1, Math.min(1, 2 * (w * y - z * x))));
  const yaw = Math.atan2(
    2 * (w * z + x * y),
    1 - 2 * (y * y + z * z),
  );
  return [roll, pitch, yaw].map((radians) => (radians * 180) / Math.PI) as [
    number,
    number,
    number,
  ];
}

function eulerDegreesToQuat(
  euler: [number, number, number],
): [number, number, number, number] {
  const [roll, pitch, yaw] = euler.map((degrees) => (degrees * Math.PI) / 180);
  const cx = Math.cos(roll / 2);
  const sx = Math.sin(roll / 2);
  const cy = Math.cos(pitch / 2);
  const sy = Math.sin(pitch / 2);
  const cz = Math.cos(yaw / 2);
  const sz = Math.sin(yaw / 2);
  return [
    sx * cy * cz + cx * sy * sz,
    cx * sy * cz - sx * cy * sz,
    cx * cy * sz + sx * sy * cz,
    cx * cy * cz - sx * sy * sz,
  ];
}

function requiredNumber(value: string | undefined, label: string): number {
  const trimmed = value?.trim();
  const parsed = trimmed ? Number(trimmed) : NaN;
  if (!Number.isFinite(parsed)) {
    throw new Error(`${label} must be a finite number.`);
  }
  return parsed;
}

function requiredInteger(value: string | undefined, label: string): number {
  const parsed = requiredNumber(value, label);
  if (!Number.isInteger(parsed)) {
    throw new Error(`${label} must be an integer.`);
  }
  return parsed;
}

function stringOrDefault(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : fallback;
}

export function normalizeMagnetizationRef(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "unassigned") return null;
  return trimmed;
}

export function resolveObjectMagneticTexturePanelModel(
  selection: Selection,
  scene: SceneResource | null,
  regionList: RegionListResource | null = null,
): ObjectMagneticTexturePanelModel {
  const { object, objectId, revision } = sceneObjectForSelection(selection, scene);
  const regionId =
    selection.ref?.type === "scene-object" ? selection.ref.regionId ?? null : null;
  const target = resolveMagnetizationTextureTarget({
    kind: selection.kind,
    objectId,
    regionId,
  });

  if (!object || !objectId || !target) {
    return {
      assignment: "missing",
      asset: null,
      assetId: "unassigned",
      assetKind: "unassigned",
      assetLabel: "unassigned",
      baseRevision: revision,
      mapping: "not configured",
      mode: "missing",
      objectId: objectId ?? "none",
      presetKind: "unassigned",
      regionId: regionId ?? null,
      targetKind: target?.kind ?? "object",
      textureTransform: "not configured",
    };
  }

  const textureModel = resolveMagnetizationTextureModel({
    regionList,
    scene,
    target,
  });
  const asset = textureModel.asset;
  const assetId = textureModel.effectiveMagnetizationRef;
  const assetKind = asString(asset?.kind) ?? "unassigned";
  const assetLabel =
    asString(asset?.ui_label) ??
    asString(asset?.name) ??
    asString(asset?.preset_kind) ??
    assetId ??
    "unassigned";

  const geometryRecord = asRecord(object?.geometry);
  const boundsMin = asNumberArray(geometryRecord?.bounds_min);
  const boundsMax = asNumberArray(geometryRecord?.bounds_max);

  return {
    assignment: textureModel.assignment,
    asset,
    assetId: assetId ?? "unassigned",
    assetKind,
    assetLabel,
    baseRevision: revision,
    mapping: formatJson(asset?.mapping),
    mode: "committed",
    objectId,
    presetKind: asString(asset?.preset_kind) ?? "unassigned",
    regionId: target.kind === "region" ? target.regionId : null,
    targetKind: target.kind,
    textureTransform: formatJson(asset?.texture_transform),
    boundsMin,
    boundsMax,
  };
}

export function objectMagneticTextureDraftFromModel(
  model: ObjectMagneticTexturePanelModel,
): ObjectMagneticTextureDraft {
  const asset = model.asset;
  const mapping = asRecord(asset?.mapping);
  const params = asRecord(asset?.preset_params);
  const transform = asRecord(asset?.texture_transform);
  const presetKind = asPresetKind(model.presetKind) ?? "uniform";
  const direction = vec3Text(vectorFromRecord(params, "direction", [1, 0, 0]));
  const translation = vec3Text(
    vectorFromRecord(transform, "translation", [0, 0, 0]),
  );
  const rotation = vec3Text(
    quatToEulerDegrees(quatFromRecord(transform, "rotation_quat")),
  );
  const scale = vec3Text(vectorFromRecord(transform, "scale", [1, 1, 1]));
  const pivot = vec3Text(vectorFromRecord(transform, "pivot", [0, 0, 0]));

  const left = vec3Text(vectorFromRecord(params, "left", [1, 0, 0]));
  const right = vec3Text(vectorFromRecord(params, "right", [-1, 0, 0]));
  const wall = vec3Text(vectorFromRecord(params, "wall", [0, 1, 0]));
  const wavevector = vec3Text(vectorFromRecord(params, "wavevector", [1, 0, 0]));
  const e1 = vec3Text(vectorFromRecord(params, "e1", [1, 0, 0]));
  const e2 = vec3Text(vectorFromRecord(params, "e2", [0, 1, 0]));
  const cone_axis = vec3Text(vectorFromRecord(params, "cone_axis", [0, 0, 1]));
  const wallWidth =
    presetKind === "domain_wall" ? asNumber(params?.width) : asNumber(params?.wall_width);

  return {
    assetLabel: model.assetLabel === "unassigned" ? "" : model.assetLabel,
    chirality: numberText(asNumber(params?.chirality) ?? 1),
    clampMode: asString(mapping?.clamp_mode) ?? "none",
    directionX: direction[0],
    directionY: direction[1],
    directionZ: direction[2],
    magnetizationRef: model.assetId === "unassigned" ? "" : model.assetId,
    mappingProjection: asString(mapping?.projection) ?? "object_local",
    mappingSpace: asString(mapping?.space) ?? "object",
    pivotX: pivot[0],
    pivotY: pivot[1],
    pivotZ: pivot[2],
    polarity: numberText(asNumber(params?.polarity) ?? 1),
    presetKind,
    rotationXDeg: rotation[0],
    rotationYDeg: rotation[1],
    rotationZDeg: rotation[2],
    scaleX: scale[0],
    scaleY: scale[1],
    scaleZ: scale[2],
    seed: numberText(asNumber(params?.seed) ?? 1),
    translationX: translation[0],
    translationY: translation[1],
    translationZ: translation[2],
    plane: asString(params?.plane) ?? "xy",
    circulation: numberText(asNumber(params?.circulation) ?? 1),
    core_polarity: numberText(asNumber(params?.core_polarity) ?? (presetKind === "bloch_skyrmion" || presetKind === "neel_skyrmion" ? -1 : 1)),
    core_radius: numberText(asNumber(params?.core_radius) ?? 1e-9),
    radius: numberText(asNumber(params?.radius) ?? 10e-9),
    wall_width: numberText(wallWidth ?? (presetKind === "domain_wall" ? 10e-9 : 2e-9)),
    normal_axis: asString(params?.normal_axis) ?? "x",
    center_offset: numberText(asNumber(params?.center_offset) ?? 0.0),
    leftX: left[0],
    leftY: left[1],
    leftZ: left[2],
    rightX: right[0],
    rightY: right[1],
    rightZ: right[2],
    wallX: wall[0],
    wallY: wall[1],
    wallZ: wall[2],
    kind: asString(params?.kind) ?? "neel",
    wavevectorX: wavevector[0],
    wavevectorY: wavevector[1],
    wavevectorZ: wavevector[2],
    e1X: e1[0],
    e1Y: e1[1],
    e1Z: e1[2],
    e2X: e2[0],
    e2Y: e2[1],
    e2Z: e2[2],
    phase_rad: numberText(asNumber(params?.phase_rad) ?? 0.0),
    cone_axisX: cone_axis[0],
    cone_axisY: cone_axis[1],
    cone_axisZ: cone_axis[2],
    cone_angle_rad: numberText(asNumber(params?.cone_angle_rad) ?? 0.785398),
  };
}

export function objectMagneticTextureDraftKey(
  model: ObjectMagneticTexturePanelModel,
): string {
  return [
    model.objectId,
    model.assetId,
    model.assetKind,
    model.regionId ?? "object",
    model.baseRevision ?? "unknown",
  ].join(":");
}

export function buildMagnetizationAssignmentPatch(
  draft: ObjectMagneticTextureDraft,
  baseRevision: number | null,
): ObjectPatchRequest {
  return {
    base_revision: baseRevision,
    magnetization_ref: normalizeMagnetizationRef(draft.magnetizationRef),
  };
}

export function objectMagneticTexturePresetChangePatch(
  model: ObjectMagneticTexturePanelModel,
  draft: ObjectMagneticTextureDraft,
  presetKind: MagnetizationTexturePresetId,
): Partial<ObjectMagneticTextureDraft> {
  const patch: Partial<ObjectMagneticTextureDraft> = {
    presetKind,
    ...defaultPresetDraftPatch(presetKind),
  };
  const committedRef = normalizeMagnetizationRef(model.assetId);
  const draftRef = normalizeMagnetizationRef(draft.magnetizationRef);
  if (!draftRef || (committedRef && draftRef === committedRef)) {
    patch.magnetizationRef = "";
  }

  const currentLabel = draft.assetLabel.trim();
  const oldDefaultLabel = defaultLabel(asPresetKind(model.presetKind) ?? "uniform");
  if (!currentLabel || currentLabel === oldDefaultLabel) {
    patch.assetLabel = defaultLabel(presetKind);
  }

  return patch;
}

function defaultPresetDraftPatch(
  presetKind: MagnetizationTexturePresetId,
): Partial<ObjectMagneticTextureDraft> {
  if (presetKind === "random_seeded") {
    return { seed: "1" };
  }

  if (presetKind === "vortex" || presetKind === "antivortex") {
    return {
      circulation: "1",
      core_polarity: "1",
      core_radius: numberText(1e-9),
      plane: "xy",
    };
  }

  if (presetKind === "bloch_skyrmion" || presetKind === "neel_skyrmion") {
    return {
      chirality: "1",
      core_polarity: "-1",
      plane: "xy",
      radius: numberText(10e-9),
      wall_width: numberText(2e-9),
    };
  }

  if (presetKind === "domain_wall") {
    const left = vec3Text([1, 0, 0]);
    const right = vec3Text([-1, 0, 0]);
    return {
      center_offset: "0",
      kind: "neel",
      leftX: left[0],
      leftY: left[1],
      leftZ: left[2],
      normal_axis: "x",
      rightX: right[0],
      rightY: right[1],
      rightZ: right[2],
      wall_width: numberText(10e-9),
    };
  }

  if (presetKind === "two_domain") {
    const left = vec3Text([1, 0, 0]);
    const right = vec3Text([-1, 0, 0]);
    const wall = vec3Text([0, 1, 0]);
    return {
      leftX: left[0],
      leftY: left[1],
      leftZ: left[2],
      normal_axis: "x",
      rightX: right[0],
      rightY: right[1],
      rightZ: right[2],
      wallX: wall[0],
      wallY: wall[1],
      wallZ: wall[2],
    };
  }

  if (presetKind === "helical") {
    const wavevector = vec3Text([1, 0, 0]);
    const e1 = vec3Text([1, 0, 0]);
    const e2 = vec3Text([0, 1, 0]);
    return {
      e1X: e1[0],
      e1Y: e1[1],
      e1Z: e1[2],
      e2X: e2[0],
      e2Y: e2[1],
      e2Z: e2[2],
      phase_rad: "0",
      wavevectorX: wavevector[0],
      wavevectorY: wavevector[1],
      wavevectorZ: wavevector[2],
    };
  }

  if (presetKind === "conical") {
    const wavevector = vec3Text([1, 0, 0]);
    const coneAxis = vec3Text([0, 0, 1]);
    return {
      cone_angle_rad: numberText(0.785398),
      cone_axisX: coneAxis[0],
      cone_axisY: coneAxis[1],
      cone_axisZ: coneAxis[2],
      phase_rad: "0",
      wavevectorX: wavevector[0],
      wavevectorY: wavevector[1],
      wavevectorZ: wavevector[2],
    };
  }

  const direction = vec3Text([1, 0, 0]);
  return {
    directionX: direction[0],
    directionY: direction[1],
    directionZ: direction[2],
  };
}

export function buildObjectMagneticTextureAssetDraft(
  model: ObjectMagneticTexturePanelModel,
  draft: ObjectMagneticTextureDraft,
): MagnetizationAssetDraft {
  if (model.mode !== "committed") {
    throw new Error("No committed scene object.");
  }

  const presetKind = asPresetKind(draft.presetKind) ?? "uniform";
  const target =
    model.targetKind === "region" && model.regionId
      ? {
          kind: "region" as const,
          objectId: model.objectId,
          regionId: model.regionId,
        }
      : { kind: "object" as const, objectId: model.objectId };
  const committedRef = normalizeMagnetizationRef(model.assetId);
  const draftRef = normalizeMagnetizationRef(draft.magnetizationRef);
  const presetChanged = asPresetKind(model.presetKind) !== presetKind;
  const assetId =
    presetChanged && committedRef && draftRef === committedRef
      ? magnetizationTextureAssetId(target, presetKind)
      : (draftRef ?? magnetizationTextureAssetId(target, presetKind));
  const oldDefaultLabel = defaultLabel(asPresetKind(model.presetKind) ?? "uniform");
  const draftLabel = draft.assetLabel.trim();
  const label =
    presetChanged && (!draftLabel || draftLabel === oldDefaultLabel)
      ? defaultLabel(presetKind)
      : stringOrDefault(draft.assetLabel, defaultLabel(presetKind));
  const asset = presetMagnetizationAsset({
    id: assetId,
    label,
    mapping: {
      clamp_mode: stringOrDefault(draft.clampMode, "none"),
      projection: stringOrDefault(draft.mappingProjection, "object_local"),
      space: stringOrDefault(draft.mappingSpace, "object"),
    },
    presetKind,
    presetParams: presetParamsFromDraft(presetKind, draft),
    textureTransform: {
      pivot: [
        requiredNumber(draft.pivotX, "Pivot X"),
        requiredNumber(draft.pivotY, "Pivot Y"),
        requiredNumber(draft.pivotZ, "Pivot Z"),
      ],
      rotation_quat: eulerDegreesToQuat([
        requiredNumber(draft.rotationXDeg, "Rotation X"),
        requiredNumber(draft.rotationYDeg, "Rotation Y"),
        requiredNumber(draft.rotationZDeg, "Rotation Z"),
      ]),
      scale: [
        requiredNumber(draft.scaleX, "Scale X"),
        requiredNumber(draft.scaleY, "Scale Y"),
        requiredNumber(draft.scaleZ, "Scale Z"),
      ],
      translation: [
        requiredNumber(draft.translationX, "Translation X"),
        requiredNumber(draft.translationY, "Translation Y"),
        requiredNumber(draft.translationZ, "Translation Z"),
      ],
    },
  });

  return asset as unknown as MagnetizationAssetDraft;
}

function presetParamsFromDraft(
  presetKind: MagnetizationTexturePresetId,
  draft: ObjectMagneticTextureDraft,
): JsonObject {
  if (presetKind === "random_seeded") {
    return {
      seed: requiredInteger(draft.seed, "Random seed"),
    };
  }

  if (presetKind === "vortex" || presetKind === "antivortex") {
    return {
      plane: stringOrDefault(draft.plane, "xy"),
      circulation: requiredInteger(draft.circulation, "Circulation"),
      core_polarity: requiredInteger(draft.core_polarity, "Core polarity"),
      core_radius: requiredNumber(draft.core_radius, "Core radius"),
    };
  }

  if (presetKind === "bloch_skyrmion" || presetKind === "neel_skyrmion") {
    return {
      plane: stringOrDefault(draft.plane, "xy"),
      radius: requiredNumber(draft.radius, "Radius"),
      wall_width: requiredNumber(draft.wall_width, "Wall width"),
      core_polarity: requiredInteger(draft.core_polarity, "Core polarity"),
      chirality: requiredInteger(draft.chirality, "Chirality"),
    };
  }

  if (presetKind === "domain_wall") {
    return {
      normal_axis: stringOrDefault(draft.normal_axis, "x"),
      center_offset: requiredNumber(draft.center_offset, "Center offset"),
      width: requiredNumber(draft.wall_width, "Wall width"),
      left: [
        requiredNumber(draft.leftX, "Left X"),
        requiredNumber(draft.leftY, "Left Y"),
        requiredNumber(draft.leftZ, "Left Z"),
      ],
      right: [
        requiredNumber(draft.rightX, "Right X"),
        requiredNumber(draft.rightY, "Right Y"),
        requiredNumber(draft.rightZ, "Right Z"),
      ],
      kind: stringOrDefault(draft.kind, "neel"),
    };
  }

  if (presetKind === "two_domain") {
    return {
      normal_axis: stringOrDefault(draft.normal_axis, "x"),
      left: [
        requiredNumber(draft.leftX, "Left X"),
        requiredNumber(draft.leftY, "Left Y"),
        requiredNumber(draft.leftZ, "Left Z"),
      ],
      right: [
        requiredNumber(draft.rightX, "Right X"),
        requiredNumber(draft.rightY, "Right Y"),
        requiredNumber(draft.rightZ, "Right Z"),
      ],
      wall: [
        requiredNumber(draft.wallX, "Wall X"),
        requiredNumber(draft.wallY, "Wall Y"),
        requiredNumber(draft.wallZ, "Wall Z"),
      ],
    };
  }

  if (presetKind === "helical") {
    return {
      wavevector: [
        requiredNumber(draft.wavevectorX, "Wavevector X"),
        requiredNumber(draft.wavevectorY, "Wavevector Y"),
        requiredNumber(draft.wavevectorZ, "Wavevector Z"),
      ],
      e1: [
        requiredNumber(draft.e1X, "E1 X"),
        requiredNumber(draft.e1Y, "E1 Y"),
        requiredNumber(draft.e1Z, "E1 Z"),
      ],
      e2: [
        requiredNumber(draft.e2X, "E2 X"),
        requiredNumber(draft.e2Y, "E2 Y"),
        requiredNumber(draft.e2Z, "E2 Z"),
      ],
      phase_rad: requiredNumber(draft.phase_rad, "Phase (rad)"),
    };
  }

  if (presetKind === "conical") {
    return {
      wavevector: [
        requiredNumber(draft.wavevectorX, "Wavevector X"),
        requiredNumber(draft.wavevectorY, "Wavevector Y"),
        requiredNumber(draft.wavevectorZ, "Wavevector Z"),
      ],
      cone_axis: [
        requiredNumber(draft.cone_axisX, "Cone axis X"),
        requiredNumber(draft.cone_axisY, "Cone axis Y"),
        requiredNumber(draft.cone_axisZ, "Cone axis Z"),
      ],
      phase_rad: requiredNumber(draft.phase_rad, "Phase (rad)"),
      cone_angle_rad: requiredNumber(draft.cone_angle_rad, "Cone angle (rad)"),
    };
  }

  return {
    direction: [
      requiredNumber(draft.directionX, "Direction X"),
      requiredNumber(draft.directionY, "Direction Y"),
      requiredNumber(draft.directionZ, "Direction Z"),
    ],
  };
}

function defaultLabel(presetKind: MagnetizationTexturePresetId): string {
  switch (presetKind) {
    case "uniform":
      return "Uniform texture";
    case "random_seeded":
      return "Random seeded texture";
    case "vortex":
      return "Vortex texture";
    case "antivortex":
      return "Antivortex texture";
    case "bloch_skyrmion":
      return "Bloch Skyrmion texture";
    case "neel_skyrmion":
      return "Néel Skyrmion texture";
    case "domain_wall":
      return "Domain Wall texture";
    case "two_domain":
      return "Two Domain texture";
    case "helical":
      return "Helical texture";
    case "conical":
      return "Conical texture";
    default:
      return "Custom texture";
  }
}
