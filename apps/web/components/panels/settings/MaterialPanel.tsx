"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import MagneticTextureLibraryPanel from "../MagneticTextureLibraryPanel";
import {
  MAGNETIC_PRESET_CATALOG,
  type MagneticPresetDescriptor,
  type MagneticPresetKind,
} from "../../../lib/magnetizationPresetCatalog";
import { useCommand } from "../../runs/control-room/context-hooks";
import { useModel } from "../../runs/control-room/ControlRoomContext";
import { fmtSI } from "../../runs/control-room/shared";
import { TextField } from "../../ui/TextField";
import SelectField from "../../ui/SelectField";
import { Button } from "../../ui/button";
import { currentLiveApiClient } from "../../../lib/liveApiClient";
import type {
  MagnetizationAsset,
  SceneDocument,
  SceneMaterialAsset,
  ScriptBuilderMagneticInteractionEntry,
  ScriptBuilderMagneticInteractionKind,
} from "../../../lib/session/types";
import {
  ensureObjectPhysicsStack,
  hasObjectInteraction,
  magneticInteractionLabel,
  removeOptionalInteraction,
  upsertObjectInteraction,
} from "../../../lib/session/magneticPhysics";
import {
  buildPhysicsCapabilityView,
  getPhysicsCatalogEntry,
} from "../../../lib/session/physicsCatalog";
import {
  assignMagneticPreset,
  fitTextureToObject,
  resetTextureTransform,
} from "../../../lib/session/magnetizationAssetActions";
import { textureScaleSemantics } from "../../../lib/textureTransform";
import { findSceneObjectByNodeId } from "./objectSelection";
import {
  buildMagnetizationAssetFingerprint,
  DEFAULT_TEXTURE_MAPPING,
  DEFAULT_TEXTURE_TRANSFORM,
  describeMagnetizationApplyState,
} from "./materialPanelMagnetization";
import { SidebarSection, InfoRow, StatusBadge } from "./primitives";

function fallbackMaterial(name: string): SceneMaterialAsset {
  return {
    id: `mat:${name}`,
    name: `${name} material`,
    properties: {
      Ms: null,
      Aex: null,
      alpha: 0.01,
      Dind: null,
    },
  };
}

function fallbackMagnetization(name: string): MagnetizationAsset {
  return {
    id: `mag:${name}`,
    name: `${name} magnetization`,
    kind: "uniform",
    value: [0, 0, 1],
    seed: null,
    source_path: null,
    source_format: null,
    dataset: null,
    sample_index: null,
    mapping: {
      space: "object",
      projection: "object_local",
      clamp_mode: "none",
    },
    texture_transform: {
      translation: [0, 0, 0],
      rotation_quat: [0, 0, 0, 1],
      scale: [1, 1, 1],
      pivot: [0, 0, 0],
    },
    preset_kind: null,
    preset_params: null,
    preset_version: null,
    ui_label: null,
  };
}

type NumericTransformMode = "translate" | "rotate" | "scale";
type PresetTextureSyncStatus = "idle" | "syncing" | "refreshing" | "done" | "error";

type PresetTextureSyncState = {
  status: PresetTextureSyncStatus;
  totalSpins: number | null;
  processedSpins: number | null;
  message: string | null;
  canRetryRefresh: boolean;
};

function clampFinite(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function multiplyQuat(
  a: [number, number, number, number],
  b: [number, number, number, number],
): [number, number, number, number] {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

function normalizeQuat(
  q: [number, number, number, number],
): [number, number, number, number] {
  const n = Math.hypot(q[0], q[1], q[2], q[3]);
  if (n <= 1e-30) return [0, 0, 0, 1];
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

function quatFromEulerDeg(
  eulerDeg: [number, number, number],
): [number, number, number, number] {
  const ex = (eulerDeg[0] * Math.PI) / 180;
  const ey = (eulerDeg[1] * Math.PI) / 180;
  const ez = (eulerDeg[2] * Math.PI) / 180;
  const cx = Math.cos(ex * 0.5);
  const sx = Math.sin(ex * 0.5);
  const cy = Math.cos(ey * 0.5);
  const sy = Math.sin(ey * 0.5);
  const cz = Math.cos(ez * 0.5);
  const sz = Math.sin(ez * 0.5);
  const q: [number, number, number, number] = [
    sx * cy * cz + cx * sy * sz,
    cx * sy * cz - sx * cy * sz,
    cx * cy * sz + sx * sy * cz,
    cx * cy * cz - sx * sy * sz,
  ];
  return normalizeQuat(q);
}

function eulerDegFromQuat(
  q: [number, number, number, number],
): [number, number, number] {
  const nq = normalizeQuat(q);
  const [x, y, z, w] = nq;
  const sinrCosp = 2 * (w * x + y * z);
  const cosrCosp = 1 - 2 * (x * x + y * y);
  const roll = Math.atan2(sinrCosp, cosrCosp);
  const sinp = 2 * (w * y - z * x);
  const pitch =
    Math.abs(sinp) >= 1 ? Math.sign(sinp) * (Math.PI / 2) : Math.asin(sinp);
  const sinyCosp = 2 * (w * z + x * y);
  const cosyCosp = 1 - 2 * (y * y + z * z);
  const yaw = Math.atan2(sinyCosp, cosyCosp);
  return [(roll * 180) / Math.PI, (pitch * 180) / Math.PI, (yaw * 180) / Math.PI];
}

export default function MaterialPanel({
  nodeId,
  view = "full",
}: {
  nodeId?: string;
  view?: "full" | "magnetization";
}) {
  const cmd = useCommand();
  const model = useModel();
  const showFullSections = view !== "magnetization";

  const { object: sceneObject, material, magnetization } = useMemo(
    () => findSceneObjectByNodeId(nodeId, model.sceneDocument),
    [model.sceneDocument, nodeId],
  );
  const { magnetization: remoteMagnetization } = useMemo(
    () => findSceneObjectByNodeId(nodeId, model.remoteSceneDocument),
    [model.remoteSceneDocument, nodeId],
  );

  const materialAsset = material ?? (sceneObject ? fallbackMaterial(sceneObject.name) : null);
  const magnetizationAsset =
    magnetization ?? (sceneObject ? fallbackMagnetization(sceneObject.name) : null);
  const pivotLockedToVortexCore =
    magnetizationAsset?.kind === "preset_texture" &&
    magnetizationAsset?.preset_kind === "vortex";
  const metricScalePreset =
    magnetizationAsset?.kind === "preset_texture" &&
    textureScaleSemantics(magnetizationAsset?.preset_kind ?? "") === "identity_metric";
  const physicsStack = useMemo<ScriptBuilderMagneticInteractionEntry[]>(
    () => ensureObjectPhysicsStack(sceneObject?.physics_stack, materialAsset?.properties.Dind ?? null),
    [materialAsset?.properties.Dind, sceneObject?.physics_stack],
  );
  const physicsCapabilityView = useMemo(
    () => buildPhysicsCapabilityView(cmd.capabilities, physicsStack),
    [cmd.capabilities, physicsStack],
  );

  const updateMaterial = useCallback(
    (updater: (asset: SceneMaterialAsset) => SceneMaterialAsset) => {
      if (!sceneObject) return;
      model.setSceneDocument((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          materials: prev.materials.map((entry) =>
            entry.id === sceneObject.material_ref ? updater(entry) : entry,
          ),
        };
      });
    },
    [model, sceneObject],
  );

  const updateMagnetization = useCallback(
    (updater: (asset: MagnetizationAsset) => MagnetizationAsset) => {
      if (!sceneObject) return;
      model.setSceneDocument((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          magnetization_assets: prev.magnetization_assets.map((entry) =>
            entry.id === sceneObject.magnetization_ref ? updater(entry) : entry,
          ),
        };
      });
    },
    [model, sceneObject],
  );

  const updateObjectPhysicsStack = useCallback(
    (updater: (stack: ScriptBuilderMagneticInteractionEntry[]) => ScriptBuilderMagneticInteractionEntry[]) => {
      if (!sceneObject) return;
      model.setSceneDocument((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          objects: prev.objects.map((object) => {
            if (object.id !== sceneObject.id && object.name !== sceneObject.name) {
              return object;
            }
            const current = ensureObjectPhysicsStack(
              object.physics_stack,
              materialAsset?.properties.Dind ?? null,
            );
            return {
              ...object,
              physics_stack: ensureObjectPhysicsStack(
                updater(current),
                materialAsset?.properties.Dind ?? null,
              ),
            };
          }),
        };
      });
    },
    [materialAsset?.properties.Dind, model, sceneObject],
  );

  const assignPresetTexture = useCallback(
    (kind: MagneticPresetKind) => {
      const descriptor = MAGNETIC_PRESET_CATALOG.find((entry) => entry.kind === kind);
      const magnetizationRef = sceneObject?.magnetization_ref;
      if (!descriptor || !sceneObject || !magnetizationRef) return;
      model.setSceneDocument((prev) =>
        prev
          ? assignMagneticPreset(prev, magnetizationRef, descriptor, {
              objectId: sceneObject.id,
            })
          : prev,
      );
    },
    [model, sceneObject],
  );

  const handlePresetCardSelect = useCallback(
    (kind: MagneticPresetKind) => {
      assignPresetTexture(kind);
    },
    [assignPresetTexture],
  );

  const updatePresetParam = useCallback(
    (key: string, value: unknown) => {
      updateMagnetization((asset) => ({
        ...asset,
        kind: "preset_texture",
        preset_params: {
          ...(asset.preset_params ?? {}),
          [key]: value,
        },
      }));
    },
    [updateMagnetization],
  );

  const setViewportControlScope = useCallback(
    (scope: "camera" | "object" | "texture") => {
      const nextScope = scope === "camera" ? null : scope;
      model.setActiveTransformScope(nextScope);
      model.setSceneDocument((prev) =>
        prev
          ? {
              ...prev,
              editor: {
                ...prev.editor,
                active_transform_scope: nextScope,
                ...(scope === "texture" && !prev.editor.gizmo_mode
                  ? { gizmo_mode: "translate" }
                  : {}),
              },
            }
          : prev,
      );
    },
    [model],
  );

  const setTextureGizmoMode = useCallback(
    (mode: "translate" | "rotate" | "scale") => {
      setViewportControlScope("texture");
      model.setSceneDocument((prev) =>
        prev
          ? {
              ...prev,
              editor: {
                ...prev.editor,
                active_transform_scope: "texture",
                gizmo_mode: mode,
              },
            }
          : prev,
      );
    },
    [model, setViewportControlScope],
  );

  const handleTextureTransformVectorBlur = useCallback(
    (
      key: "translation" | "scale" | "pivot",
      axis: number,
      valueRaw: string,
    ) => {
      if (pivotLockedToVortexCore && key === "pivot") {
        return;
      }
      const parsed = Number.parseFloat(valueRaw);
      if (!Number.isFinite(parsed)) return;
      updateMagnetization((asset) => {
        const current = asset.texture_transform?.[key] ?? [0, 0, 0];
        const next = [...current] as [number, number, number];
        next[axis] = parsed;
        return {
          ...asset,
          texture_transform: {
            ...asset.texture_transform,
            [key]: next,
            ...(pivotLockedToVortexCore && key === "translation"
              ? { pivot: [0, 0, 0] as [number, number, number] }
              : {}),
          },
        };
      });
    },
    [pivotLockedToVortexCore, updateMagnetization],
  );

  const handleTextureRotationQuatBlur = useCallback(
    (axis: number, valueRaw: string) => {
      const parsed = Number.parseFloat(valueRaw);
      if (!Number.isFinite(parsed)) return;
      updateMagnetization((asset) => {
        const current = asset.texture_transform?.rotation_quat ?? [0, 0, 0, 1];
        const next = [...current] as [number, number, number, number];
        next[axis] = parsed;
        return {
          ...asset,
          texture_transform: {
            ...asset.texture_transform,
            rotation_quat: next,
          },
        };
      });
    },
    [updateMagnetization],
  );

  const handleFitTextureTransform = useCallback(() => {
    const magnetizationRef = sceneObject?.magnetization_ref;
    if (!sceneObject || !magnetizationRef) return;
    model.setSceneDocument((prev) =>
      prev
        ? fitTextureToObject(prev, sceneObject.id, magnetizationRef)
        : prev,
    );
  }, [model, sceneObject]);

  const handleResetTextureTransform = useCallback(() => {
    const magnetizationRef = sceneObject?.magnetization_ref;
    if (!sceneObject || !magnetizationRef) return;
    model.setSceneDocument((prev) =>
      prev
        ? resetTextureTransform(prev, magnetizationRef)
        : prev,
    );
  }, [model, sceneObject]);

  useEffect(() => {
    if (!pivotLockedToVortexCore) {
      return;
    }
    const pivot = magnetizationAsset?.texture_transform?.pivot ?? [0, 0, 0];
    if (pivot.every((component) => Math.abs(component) <= 1e-18)) {
      return;
    }
    updateMagnetization((asset) => ({
      ...asset,
      texture_transform: {
        ...(asset.texture_transform ?? DEFAULT_TEXTURE_TRANSFORM),
        pivot: [0, 0, 0],
      },
    }));
  }, [
    magnetizationAsset?.texture_transform?.pivot,
    pivotLockedToVortexCore,
    updateMagnetization,
  ]);

  const handleMatNum = (
    key: keyof SceneMaterialAsset["properties"],
    valStr: string,
  ) => {
    const val = parseFloat(valStr);
    const parsed = Number.isNaN(val) ? null : val;
    updateMaterial((asset) => ({
      ...asset,
      properties: {
        ...asset.properties,
        [key]: parsed as never,
      },
    }));
    if (key === "Dind") {
      updateObjectPhysicsStack((stack) => {
        if (!hasObjectInteraction(stack, "interfacial_dmi")) {
          return stack;
        }
        return upsertObjectInteraction(stack, "interfacial_dmi", {
          params: {
            ...(stack.find((entry) => entry.kind === "interfacial_dmi")?.params ?? {}),
            dind: parsed ?? 0,
          },
        });
      });
    }
  };

  const addInteraction = (kind: ScriptBuilderMagneticInteractionKind) => {
    updateObjectPhysicsStack((stack) =>
      upsertObjectInteraction(stack, kind, { enabled: true }),
    );
  };

  const toggleInteraction = (
    kind: ScriptBuilderMagneticInteractionKind,
    enabled: boolean,
  ) => {
    if (kind === "exchange" || kind === "demag") {
      return;
    }
    updateObjectPhysicsStack((stack) => upsertObjectInteraction(stack, kind, { enabled }));
  };

  const removeInteraction = (kind: ScriptBuilderMagneticInteractionKind) => {
    updateObjectPhysicsStack((stack) => removeOptionalInteraction(stack, kind));
  };

  const updateUniaxialParam = (key: "ku1" | "axis", value: unknown) => {
    updateObjectPhysicsStack((stack) => {
      const params = {
        ...(stack.find((entry) => entry.kind === "uniaxial_anisotropy")?.params ?? {}),
        [key]: value,
      };
      return upsertObjectInteraction(stack, "uniaxial_anisotropy", { params });
    });
  };

  const handleMagUniform = (idx: number, valStr: string) => {
    const val = parseFloat(valStr);
    if (Number.isNaN(val)) return;
    updateMagnetization((asset) => {
      const value = Array.isArray(asset.value) ? [...asset.value] : [0, 0, 1];
      value[idx] = val;
      return { ...asset, value };
    });
  };

  const handleMagStr = (
    key: keyof Pick<
      MagnetizationAsset,
      "source_path" | "source_format" | "dataset"
    >,
    valStr: string,
  ) => {
    const val = valStr.trim() === "" ? null : valStr.trim();
    updateMagnetization((asset) => ({
      ...asset,
      [key]: val,
    }));
  };

  const handleMagNum = (key: "sample_index" | "seed", valStr: string) => {
    const val = Number.parseInt(valStr, 10);
    const parsed = Number.isNaN(val) ? null : val;
    updateMagnetization((asset) => ({
      ...asset,
      [key]: parsed,
    }));
  };

  const selectedPresetKind =
    (magnetizationAsset?.preset_kind as MagneticPresetKind | null | undefined) ??
    null;
  const selectedPresetDescriptor: MagneticPresetDescriptor | null = selectedPresetKind
    ? MAGNETIC_PRESET_CATALOG.find((entry) => entry.kind === selectedPresetKind) ?? null
    : null;

  const liveApi = useMemo(() => currentLiveApiClient(), []);
  const [presetTextureSync, setPresetTextureSync] = useState<PresetTextureSyncState>({
    status: "idle",
    totalSpins: null,
    processedSpins: null,
    message: null,
    canRetryRefresh: false,
  });
  const [presetTextureModalOpen, setPresetTextureModalOpen] = useState(false);
  const presetTextureSyncTickerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const presetTextureSyncModalTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const presetTextureSyncGenerationRef = useRef(0);
  const pendingViewportRefreshRef = useRef<{
    scene: SceneDocument;
    magnetizationAssetHash: string;
    totalSpins: number | null;
    isPresetTexture: boolean;
  } | null>(null);
  const [numericTransformOpen, setNumericTransformOpen] = useState(false);
  const [numericMode, setNumericMode] = useState<NumericTransformMode>("translate");
  const [numericAbsolute, setNumericAbsolute] = useState<[number, number, number]>([0, 0, 0]);
  const [numericOffset, setNumericOffset] = useState<[number, number, number]>([0, 0, 0]);
  const targetSpinCount = useMemo(() => {
    if (!sceneObject) return null;
    const objectId = sceneObject.id;
    const objectName = sceneObject.name;
    const objectSegments = model.femMesh?.object_segments ?? [];
    const segmentNodes = objectSegments
      .filter((segment) => segment.object_id === objectId || segment.object_id === objectName)
      .reduce((sum, segment) => sum + Math.max(0, Number(segment.node_count ?? 0)), 0);
    if (segmentNodes > 0) return segmentNodes;
    const meshParts = model.femMesh?.mesh_parts ?? [];
    const partNodes = meshParts
      .filter((part) => part.object_id === objectId || part.object_id === objectName)
      .reduce((sum, part) => sum + Math.max(0, Number(part.node_count ?? 0)), 0);
    return partNodes > 0 ? partNodes : null;
  }, [model.femMesh?.mesh_parts, model.femMesh?.object_segments, sceneObject]);
  const magnetizationAssetHash = useMemo(() => {
    if (!sceneObject || !magnetizationAsset) {
      return null;
    }
    return buildMagnetizationAssetFingerprint({
      objectId: sceneObject.id,
      asset: magnetizationAsset,
    });
  }, [magnetizationAsset, sceneObject]);
  const remoteMagnetizationAssetHash = useMemo(() => {
    if (!sceneObject || !remoteMagnetization) {
      return null;
    }
    return buildMagnetizationAssetFingerprint({
      objectId: sceneObject.id,
      asset: remoteMagnetization,
    });
  }, [remoteMagnetization, sceneObject]);
  const isMagnetizationDirty =
    magnetizationAssetHash != null &&
    magnetizationAssetHash !== remoteMagnetizationAssetHash;
  const presetTextureSyncPercent = useMemo(() => {
    if (presetTextureSync.status === "done") return 100;
    if (presetTextureSync.status === "error") return 100;
    if (presetTextureSync.status === "refreshing") return 88;
    if (presetTextureSync.status !== "syncing") return 0;
    if (
      presetTextureSync.totalSpins != null &&
      presetTextureSync.totalSpins > 0 &&
      presetTextureSync.processedSpins != null
    ) {
      return Math.max(
        2,
        Math.min(99, (presetTextureSync.processedSpins / presetTextureSync.totalSpins) * 100),
      );
    }
    return 55;
  }, [presetTextureSync]);
  const isMagnetizationSyncBusy =
    presetTextureSync.status === "syncing" || presetTextureSync.status === "refreshing";
  const magnetizationApplyState = useMemo(
    () =>
      describeMagnetizationApplyState({
        isDirty: isMagnetizationDirty,
        isSyncBusy: isMagnetizationSyncBusy,
        hasSceneDocument: model.sceneDocument != null,
        kind: magnetizationAsset?.kind ?? "uniform",
      }),
    [isMagnetizationDirty, isMagnetizationSyncBusy, magnetizationAsset?.kind, model.sceneDocument],
  );
  const refreshViewportAfterMagnetizationCommit = useCallback(
    async ({
      committedScene,
      generation,
      totalSpins,
      isPresetTexture,
      nextMagnetizationHash,
    }: {
      committedScene: SceneDocument;
      generation: number;
      totalSpins: number | null;
      isPresetTexture: boolean;
      nextMagnetizationHash: string;
    }) => {
      if (presetTextureSyncGenerationRef.current !== generation) {
        return;
      }

      pendingViewportRefreshRef.current = {
        scene: committedScene,
        magnetizationAssetHash: nextMagnetizationHash,
        totalSpins,
        isPresetTexture,
      };
      model.setSceneDocument(committedScene);
      setPresetTextureSync({
        status: "refreshing",
        totalSpins,
        processedSpins: totalSpins,
        message: "Backend potwierdzil zapis. Odswiezam live snapshot i viewport…",
        canRetryRefresh: false,
      });

      try {
        await model.refreshLiveState({ forceBootstrap: true });
        if (presetTextureSyncGenerationRef.current !== generation) {
          return;
        }
        pendingViewportRefreshRef.current = null;
        setPresetTextureSync({
          status: "done",
          totalSpins,
          processedSpins: totalSpins,
          message:
            totalSpins != null
              ? `Gotowe. Viewport odswiezony po synchronizacji ${totalSpins.toLocaleString()} spinow.`
              : "Gotowe. Live snapshot i viewport zostaly odswiezone.",
          canRetryRefresh: false,
        });
        if (isPresetTexture) {
          presetTextureSyncModalTimerRef.current = setTimeout(() => {
            setPresetTextureModalOpen(false);
            presetTextureSyncModalTimerRef.current = null;
          }, 1800);
        }
      } catch (refreshError) {
        if (presetTextureSyncGenerationRef.current !== generation) {
          return;
        }
        setPresetTextureSync({
          status: "error",
          totalSpins,
          processedSpins: totalSpins,
          message:
            refreshError instanceof Error
              ? `Backend zapisany, ale odswiezenie viewportu nie powiodlo sie: ${refreshError.message}`
              : "Backend zapisany, ale odswiezenie viewportu nie powiodlo sie.",
          canRetryRefresh: true,
        });
        if (isPresetTexture) {
          setPresetTextureModalOpen(true);
        }
      }
    },
    [model, setPresetTextureModalOpen],
  );
  const retryMagnetizationViewportRefresh = useCallback(() => {
    const pendingRefresh = pendingViewportRefreshRef.current;
    if (!pendingRefresh) {
      return;
    }
    const generation = presetTextureSyncGenerationRef.current + 1;
    presetTextureSyncGenerationRef.current = generation;
    if (presetTextureSyncModalTimerRef.current) {
      clearTimeout(presetTextureSyncModalTimerRef.current);
      presetTextureSyncModalTimerRef.current = null;
    }
    setPresetTextureModalOpen(pendingRefresh.isPresetTexture);
    void refreshViewportAfterMagnetizationCommit({
      committedScene: pendingRefresh.scene,
      generation,
      totalSpins: pendingRefresh.totalSpins,
      isPresetTexture: pendingRefresh.isPresetTexture,
      nextMagnetizationHash: pendingRefresh.magnetizationAssetHash,
    });
  }, [refreshViewportAfterMagnetizationCommit, setPresetTextureModalOpen]);
  const applyMagnetizationChanges = useCallback(() => {
    if (!magnetizationAssetHash || !model.sceneDocument) {
      return;
    }
    const isPresetTexture = magnetizationAsset?.kind === "preset_texture";
    const totalSpins = isPresetTexture ? targetSpinCount : null;
    const scenePayload = model.sceneDocument;
    const generation = presetTextureSyncGenerationRef.current + 1;
    presetTextureSyncGenerationRef.current = generation;
    pendingViewportRefreshRef.current = null;
    if (presetTextureSyncTickerRef.current) {
      clearInterval(presetTextureSyncTickerRef.current);
      presetTextureSyncTickerRef.current = null;
    }
    if (presetTextureSyncModalTimerRef.current) {
      clearTimeout(presetTextureSyncModalTimerRef.current);
      presetTextureSyncModalTimerRef.current = null;
    }
    setPresetTextureModalOpen(isPresetTexture);

    setPresetTextureSync({
      status: "syncing",
      totalSpins,
      processedSpins: totalSpins != null ? 0 : null,
      message: isPresetTexture
        ? "Trwa tworzenie tekstury magnetycznej…"
        : "Trwa synchronizacja magnetyzacji…",
      canRetryRefresh: false,
    });

    if (totalSpins != null && totalSpins > 0) {
      const perTick = Math.max(1, Math.floor(totalSpins / 24));
      presetTextureSyncTickerRef.current = setInterval(() => {
        setPresetTextureSync((prev) => {
          if (presetTextureSyncGenerationRef.current !== generation) {
            return prev;
          }
          if (prev.status !== "syncing") {
            return prev;
          }
          const nextProcessed = Math.min(totalSpins - 1, (prev.processedSpins ?? 0) + perTick);
          return {
            ...prev,
            processedSpins: nextProcessed,
          };
        });
      }, 70);
    }

    void liveApi
      .updateSceneDocument(scenePayload)
      .then((committedScene) => {
        if (presetTextureSyncGenerationRef.current !== generation) {
          return;
        }
        if (presetTextureSyncTickerRef.current) {
          clearInterval(presetTextureSyncTickerRef.current);
          presetTextureSyncTickerRef.current = null;
        }
        void refreshViewportAfterMagnetizationCommit({
          committedScene,
          generation,
          totalSpins,
          isPresetTexture,
          nextMagnetizationHash: magnetizationAssetHash,
        });
      })
      .catch((error) => {
        if (presetTextureSyncGenerationRef.current !== generation) {
          return;
        }
        if (presetTextureSyncTickerRef.current) {
          clearInterval(presetTextureSyncTickerRef.current);
          presetTextureSyncTickerRef.current = null;
        }
        setPresetTextureSync({
          status: "error",
          totalSpins,
          processedSpins: null,
          message:
            error instanceof Error
              ? `Błąd synchronizacji magnetyzacji: ${error.message}`
              : "Błąd synchronizacji magnetyzacji z backendem.",
          canRetryRefresh: false,
        });
        setPresetTextureModalOpen(true);
      });
  }, [
    refreshViewportAfterMagnetizationCommit,
    magnetizationAsset?.kind,
    magnetizationAssetHash,
    liveApi,
    model.sceneDocument,
    setPresetTextureModalOpen,
    setPresetTextureSync,
    targetSpinCount,
  ]);

  useEffect(() => {
    return () => {
      if (presetTextureSyncTickerRef.current) {
        clearInterval(presetTextureSyncTickerRef.current);
      }
      if (presetTextureSyncModalTimerRef.current) {
        clearTimeout(presetTextureSyncModalTimerRef.current);
      }
    };
  }, []);

  if (!sceneObject || !materialAsset || !magnetizationAsset) {
    if (!model.material) {
      return <div className="font-mono text-xs text-foreground">Material metadata not available yet.</div>;
    }
    return (
      <SidebarSection title="Material" defaultOpen={true}>
        <div className="flex flex-col gap-0.5">
          <InfoRow label="M_sat" value={model.material.msat != null ? fmtSI(model.material.msat, "A/m") : "—"} />
          <InfoRow label="A_ex" value={model.material.aex != null ? fmtSI(model.material.aex, "J/m") : "—"} />
          <InfoRow label="α" value={model.material.alpha?.toPrecision(3) ?? "—"} />
        </div>
        <div className="flex flex-wrap gap-1.5 pt-1">
          {model.material.exchangeEnabled && <StatusBadge label="Exchange" tone="info" />}
          {model.material.demagEnabled && <StatusBadge label="Demag" tone="info" />}
          {model.material.zeemanField?.some((v) => v !== 0) && <StatusBadge label="Zeeman" tone="accent" />}
        </div>
      </SidebarSection>
    );
  }

  const mat = materialAsset.properties;
  const mag = magnetizationAsset;
  const value = Array.isArray(mag.value) ? mag.value : [0, 0, 1];
  const presetParams = mag.preset_params ?? selectedPresetDescriptor?.defaultParams ?? {};
  const textureTransform = mag.texture_transform ?? {
    ...DEFAULT_TEXTURE_TRANSFORM,
  };
  const displayedPivot = pivotLockedToVortexCore
    ? textureTransform.translation
    : textureTransform.pivot;
  const textureMapping = mag.mapping ?? {
    ...DEFAULT_TEXTURE_MAPPING,
  };
  const activeTextureMode = model.sceneDocument?.editor.gizmo_mode ?? "translate";
  const activeViewportControl =
    model.activeTransformScope === "object"
      ? "object"
      : model.activeTransformScope === "texture"
        ? "texture"
        : "camera";
  const scaleInputUnit = metricScalePreset ? "×" : "m";
  const openNumericTransform = (mode: NumericTransformMode) => {
    setNumericMode(mode);
    if (mode === "rotate") {
      setNumericAbsolute(eulerDegFromQuat(textureTransform.rotation_quat));
    } else if (mode === "scale") {
      setNumericAbsolute([...textureTransform.scale] as [number, number, number]);
    } else {
      setNumericAbsolute([...textureTransform.translation] as [number, number, number]);
    }
    setNumericOffset([0, 0, 0]);
    setNumericTransformOpen(true);
  };

  const applyNumericTransform = () => {
    updateMagnetization((asset) => {
      const currentTransform = asset.texture_transform ?? {
        translation: [0, 0, 0],
        rotation_quat: [0, 0, 0, 1],
        scale: [1, 1, 1],
        pivot: [0, 0, 0],
      };
      const next = {
        ...currentTransform,
      };
      if (numericMode === "translate") {
        next.translation = [
          clampFinite(numericAbsolute[0], currentTransform.translation[0]) +
            clampFinite(numericOffset[0], 0),
          clampFinite(numericAbsolute[1], currentTransform.translation[1]) +
            clampFinite(numericOffset[1], 0),
          clampFinite(numericAbsolute[2], currentTransform.translation[2]) +
            clampFinite(numericOffset[2], 0),
        ];
        if (pivotLockedToVortexCore) {
          next.pivot = [0, 0, 0];
        }
      } else if (numericMode === "scale") {
        next.scale = [
          Math.max(
            1e-12,
            clampFinite(numericAbsolute[0], currentTransform.scale[0]) +
              clampFinite(numericOffset[0], 0),
          ),
          Math.max(
            1e-12,
            clampFinite(numericAbsolute[1], currentTransform.scale[1]) +
              clampFinite(numericOffset[1], 0),
          ),
          Math.max(
            1e-12,
            clampFinite(numericAbsolute[2], currentTransform.scale[2]) +
              clampFinite(numericOffset[2], 0),
          ),
        ];
      } else {
        const base = quatFromEulerDeg(numericAbsolute);
        const delta = quatFromEulerDeg(numericOffset);
        next.rotation_quat = normalizeQuat(multiplyQuat(delta, base));
      }
      return {
        ...asset,
        texture_transform: next,
      };
    });
    setNumericTransformOpen(false);
  };
  const hasDmi = hasObjectInteraction(physicsStack, "interfacial_dmi");
  const hasUniaxial = hasObjectInteraction(physicsStack, "uniaxial_anisotropy");
  const uniaxial = physicsStack.find((entry) => entry.kind === "uniaxial_anisotropy");
  const uniaxialAxisRaw = Array.isArray(uniaxial?.params?.axis) ? uniaxial?.params?.axis : [0, 0, 1];
  const uniaxialAxis = [
    Number(uniaxialAxisRaw[0] ?? 0),
    Number(uniaxialAxisRaw[1] ?? 0),
    Number(uniaxialAxisRaw[2] ?? 1),
  ] as [number, number, number];
  const uniaxialKu1 = Number(uniaxial?.params?.ku1 ?? 0);
  const backendOnlyTerms = physicsCapabilityView.filter(
    (entry) => entry.available && !entry.authorableInObjectPanel,
  );

  return (
    <div className="flex flex-col px-2 pt-4">
      {showFullSections && (
        <SidebarSection title="Material Constants" defaultOpen={true}>
          <div className="grid grid-cols-2 gap-3">
            <TextField label="Ms (Saturation)" defaultValue={mat.Ms ?? ""} onBlur={(e) => handleMatNum("Ms", e.target.value)} unit="A/m" mono tooltip="Saturation magnetization of the material." />
            <TextField label="Aex (Exchange)" defaultValue={mat.Aex ?? ""} onBlur={(e) => handleMatNum("Aex", e.target.value)} unit="J/m" mono tooltip="Exchange stiffness constant coupling adjacent spins." />
            <TextField label="α (Damping)" defaultValue={mat.alpha ?? ""} onBlur={(e) => handleMatNum("alpha", e.target.value)} mono tooltip="Gilbert damping parameter governing spin relaxation rate." />
            <TextField label="Dind (DMI)" defaultValue={mat.Dind ?? ""} onBlur={(e) => handleMatNum("Dind", e.target.value)} unit="J/m²" mono tooltip="Interfacial Dzyaloshinskii-Moriya interaction strength." />
          </div>
        </SidebarSection>
      )}

      {showFullSections && (
        <SidebarSection title="Magnetic Interactions" defaultOpen={true}>
          <div className="flex flex-col gap-3">
            <div className="rounded-lg border border-border/40 bg-card/20 px-3 py-2 text-[0.72rem] text-muted-foreground">
              Exchange i demag są zawsze aktywne dla ferromagnetyka. Interakcje opcjonalne możesz dodawać i konfigurować poniżej.
            </div>
            <div className="grid gap-2">
              {physicsStack.map((interaction) => (
                <div key={interaction.kind} className="rounded-lg border border-border/35 bg-background/35 px-3 py-2">
                  <div className="flex items-center gap-2">
                    <div className="text-xs font-semibold text-foreground">
                      {magneticInteractionLabel(interaction.kind)}
                    </div>
                    {(interaction.kind === "exchange" || interaction.kind === "demag") ? (
                      <span className="rounded border border-emerald-500/25 bg-emerald-500/10 px-1.5 py-0.5 text-[0.6rem] uppercase tracking-[0.1em] text-emerald-300">
                        required
                      </span>
                    ) : null}
                    <div className="ml-auto flex items-center gap-1">
                      <SelectField
                        label=""
                        value={interaction.enabled ? "on" : "off"}
                        onchange={(value) => toggleInteraction(interaction.kind, value === "on")}
                        options={[
                          { value: "on", label: "Enabled" },
                          { value: "off", label: "Disabled" },
                        ]}
                      />
                      {(interaction.kind !== "exchange" && interaction.kind !== "demag") ? (
                        <Button
                          size="sm"
                          variant="outline"
                          type="button"
                          onClick={() => removeInteraction(interaction.kind)}
                        >
                          Remove
                        </Button>
                      ) : null}
                    </div>
                  </div>
                  {getPhysicsCatalogEntry(interaction.kind)?.description ? (
                    <div className="mt-2 text-[0.72rem] text-muted-foreground">
                      {getPhysicsCatalogEntry(interaction.kind)?.description}
                    </div>
                  ) : null}
                  {interaction.kind === "interfacial_dmi" ? (
                    <div className="mt-2 text-[0.72rem] text-muted-foreground">
                      Uses <span className="font-mono text-foreground">Dind</span> from Material Constants.
                    </div>
                  ) : null}
                  {interaction.kind === "uniaxial_anisotropy" ? (
                    <div className="mt-2 grid grid-cols-2 gap-3">
                      <TextField
                        label="Ku1"
                        defaultValue={uniaxialKu1}
                        onBlur={(event) => {
                          const parsed = Number.parseFloat(event.target.value);
                          if (!Number.isFinite(parsed)) return;
                          updateUniaxialParam("ku1", parsed);
                        }}
                        unit="J/m³"
                        mono
                      />
                      <div className="grid grid-cols-3 gap-2">
                        {[0, 1, 2].map((axis) => (
                          <TextField
                            key={`ku-axis-${axis}`}
                            label={`Axis ${["X", "Y", "Z"][axis]}`}
                            defaultValue={uniaxialAxis[axis]}
                            onBlur={(event) => {
                              const parsed = Number.parseFloat(event.target.value);
                              if (!Number.isFinite(parsed)) return;
                              const nextAxis = [...uniaxialAxis] as [number, number, number];
                              nextAxis[axis] = parsed;
                              updateUniaxialParam("axis", nextAxis);
                            }}
                            mono
                          />
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                type="button"
                disabled={hasDmi}
                onClick={() => addInteraction("interfacial_dmi")}
              >
                Add DMI
              </Button>
              <Button
                size="sm"
                variant="outline"
                type="button"
                disabled={hasUniaxial}
                onClick={() => addInteraction("uniaxial_anisotropy")}
              >
                Add Uniaxial Ku
              </Button>
            </div>
            {backendOnlyTerms.length > 0 ? (
              <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-[0.72rem] text-amber-100/90">
                Current backend also exposes: {backendOnlyTerms.map((entry) => entry.label).join(", ")}.
                These semantics exist in runtime/Python, but this object panel still lacks first-class editors for them.
              </div>
            ) : null}
          </div>
        </SidebarSection>
      )}

      <SidebarSection title="Initial Magnetization (m0)" defaultOpen={true}>
        <div className="flex flex-col gap-4">
          <div className="rounded-lg border border-border/40 bg-card/20 px-3 py-2 text-xs text-muted-foreground">
            This editor updates the same magnetization asset referenced by the selected object and its region node.
          </div>
          <SelectField
            label="Texture Kind"
            value={mag.kind}
            onchange={(val) =>
              updateMagnetization((asset) => ({
                ...asset,
                kind: val,
                value: val === "uniform" ? (asset.value ?? [0, 0, 1]) : null,
                seed: val === "random" ? (asset.seed ?? 1) : null,
                source_path: val === "file" || val === "sampled" ? asset.source_path : null,
                source_format: val === "file" || val === "sampled" ? asset.source_format ?? null : null,
                dataset: val === "sampled" ? asset.dataset ?? null : null,
                sample_index: val === "sampled" ? asset.sample_index ?? null : null,
                preset_kind:
                  val === "preset_texture"
                    ? asset.preset_kind ?? "uniform"
                    : null,
                preset_params:
                  val === "preset_texture"
                    ? asset.preset_params ?? structuredClone(MAGNETIC_PRESET_CATALOG[0]?.defaultParams ?? {})
                    : null,
                mapping:
                  val === "preset_texture"
                    ? asset.mapping ?? { ...DEFAULT_TEXTURE_MAPPING }
                    : asset.mapping,
                texture_transform:
                  val === "preset_texture"
                    ? asset.texture_transform ?? { ...DEFAULT_TEXTURE_TRANSFORM }
                    : asset.texture_transform,
                preset_version: val === "preset_texture" ? asset.preset_version ?? 1 : null,
                ui_label:
                  val === "preset_texture"
                    ? asset.ui_label ?? selectedPresetDescriptor?.label ?? "Preset texture"
                    : null,
              }))
            }
            options={[
              { label: "Uniform (Vector)", value: "uniform" },
              { label: "Random", value: "random" },
              { label: "File Source", value: "file" },
              { label: "Sampled Dataset", value: "sampled" },
              { label: "Preset Texture", value: "preset_texture" },
            ]}
            tooltip="Spatial distribution of the starting magnetization vectors."
          />

          {mag.kind === "uniform" && (
            <div className="grid grid-cols-3 gap-3">
              <TextField label="m_x" defaultValue={value[0]} onchange={(e) => handleMagUniform(0, e.target.value)} mono tooltip="Normalized X component." />
              <TextField label="m_y" defaultValue={value[1]} onchange={(e) => handleMagUniform(1, e.target.value)} mono tooltip="Normalized Y component." />
              <TextField label="m_z" defaultValue={value[2]} onchange={(e) => handleMagUniform(2, e.target.value)} mono tooltip="Normalized Z component." />
            </div>
          )}

          {(mag.kind === "file" || mag.kind === "sampled") && (
            <div className="flex flex-col gap-3">
              <TextField label="Source File Path" placeholder="e.g., m0.ovf or ground_state.vtk" defaultValue={mag.source_path ?? ""} onchange={(e) => handleMagStr("source_path", e.target.value)} mono tooltip="Path to an .ovf, .omf, or .vtk file containing the continuous vector field." />
              <div className="grid grid-cols-2 gap-3">
                <TextField label="Source Format" placeholder="(optional)" defaultValue={mag.source_format ?? ""} onchange={(e) => handleMagStr("source_format", e.target.value)} mono tooltip="Optional explicit parser hint." />
                <TextField label="Dataset Key" placeholder="(optional)" defaultValue={mag.dataset ?? ""} onchange={(e) => handleMagStr("dataset", e.target.value)} mono tooltip="Specify the internal dataset name if the file contains multiple." />
              </div>
              {mag.kind === "sampled" && (
                <TextField label="Sample Index" placeholder="(optional)" defaultValue={mag.sample_index?.toString() ?? ""} onchange={(e) => handleMagNum("sample_index", e.target.value)} mono tooltip="Index within the dataset if storing a time series." />
              )}
            </div>
          )}

          {mag.kind === "random" && (
            <TextField label="Random Seed" placeholder="Random (Auto)" defaultValue={mag.seed?.toString() ?? ""} onchange={(e) => handleMagNum("seed", e.target.value)} mono tooltip="Fixed integer seed to reproduce the exact same thermalized noise pattern." />
          )}

          {mag.kind === "preset_texture" && (
            <div className="@container grid grid-cols-1 gap-4">
              {presetTextureSync.status !== "idle" && (
                <div className="rounded-xl border border-border/30 bg-card/15 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-xs font-medium text-foreground">
                      {presetTextureSync.status === "syncing"
                        ? "Trwa tworzenie tekstury magnetycznej…"
                        : presetTextureSync.status === "refreshing"
                          ? "Backend zapisany. Odswiezanie viewportu…"
                        : presetTextureSync.status === "done"
                          ? "Synchronizacja tekstury zakończona"
                        : presetTextureSync.status === "error"
                            ? "Błąd synchronizacji tekstury"
                            : "Synchronizacja tekstury z backendem"}
                    </div>
                    {presetTextureSync.totalSpins != null && (
                      <div className="text-[0.68rem] font-mono text-muted-foreground">
                        {Math.max(0, presetTextureSync.processedSpins ?? 0).toLocaleString()}
                        {" / "}
                        {presetTextureSync.totalSpins.toLocaleString()} spinów
                      </div>
                    )}
                  </div>
                  <div className="mt-2 h-2 w-full overflow-hidden rounded bg-muted/40">
                    <div
                      className={`h-full transition-all duration-150 ${
                        presetTextureSync.status === "error"
                          ? "bg-red-400"
                          : presetTextureSync.status === "done"
                            ? "bg-emerald-400"
                            : "bg-primary"
                      }`}
                      style={{ width: `${presetTextureSyncPercent}%` }}
                    />
                  </div>
                  {presetTextureSync.message && (
                    <div className="mt-2 text-[0.72rem] text-muted-foreground">
                      {presetTextureSync.message}
                    </div>
                  )}
                </div>
              )}

                <div className="rounded-xl border border-border/30 bg-card/15 p-2">
                  <MagneticTextureLibraryPanel
                    selectedKind={selectedPresetKind}
                    onCreatePreset={handlePresetCardSelect}
                    onSelectKind={handlePresetCardSelect}
                  />
                </div>

              {selectedPresetDescriptor && (
                <div className="rounded-xl border border-border/30 bg-card/15 p-3">
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <div>
                      <div className="text-sm font-medium text-foreground">
                        {selectedPresetDescriptor.label}
                      </div>
                      <div className="text-[0.72rem] text-muted-foreground">
                        Proxy: {selectedPresetDescriptor.previewProxy}
                      </div>
                    </div>
                    <div className="text-[0.65rem] font-semibold uppercase tracking-[0.12em] text-primary">
                      Live preset editor
                    </div>
                  </div>

                  <div className="grid grid-cols-1 gap-3 @[560px]:grid-cols-2">
                    {selectedPresetDescriptor.parameters.map((parameter) => {
                      const rawValue =
                        presetParams[parameter.key] ?? selectedPresetDescriptor.defaultParams[parameter.key];

                      if (parameter.type === "vector3") {
                        const vector = Array.isArray(rawValue) ? rawValue : [0, 0, 0];
                        return (
                          <div key={parameter.key} className="grid grid-cols-1 gap-2 @[860px]:col-span-2 @[860px]:grid-cols-3">
                            {[0, 1, 2].map((axis) => (
                              <TextField
                                key={`${parameter.key}-${axis}`}
                                label={`${parameter.label} ${["X", "Y", "Z"][axis]}`}
                                defaultValue={String(Number(vector[axis] ?? 0))}
                                onBlur={(event) => {
                                  const next = [...vector] as [number, number, number];
                                  const parsed = Number.parseFloat(event.target.value);
                                  if (!Number.isFinite(parsed)) return;
                                  next[axis] = parsed;
                                  updatePresetParam(parameter.key, next);
                                }}
                                unit={parameter.unit}
                                mono
                              />
                            ))}
                          </div>
                        );
                      }

                      if (parameter.type === "enum") {
                        return (
                          <SelectField
                            key={parameter.key}
                            label={parameter.label}
                            value={String(rawValue)}
                            onchange={(value) => updatePresetParam(parameter.key, value)}
                            options={(parameter.options ?? []).map((option) => ({
                              label: option.label,
                              value: String(option.value),
                            }))}
                          />
                        );
                      }

                      if (parameter.type === "boolean") {
                        return (
                          <SelectField
                            key={parameter.key}
                            label={parameter.label}
                            value={rawValue ? "true" : "false"}
                            onchange={(value) => updatePresetParam(parameter.key, value === "true")}
                            options={[
                              { label: "True", value: "true" },
                              { label: "False", value: "false" },
                            ]}
                          />
                        );
                      }

                      const isInteger = parameter.type === "integer";
                      return (
                        <TextField
                          key={parameter.key}
                          label={parameter.label}
                          defaultValue={String(rawValue ?? "")}
                          onBlur={(event) => {
                            const parsed = isInteger
                              ? Number.parseInt(event.target.value, 10)
                              : Number.parseFloat(event.target.value);
                            if (!Number.isFinite(parsed)) return;
                            updatePresetParam(parameter.key, parsed);
                          }}
                          unit={parameter.unit}
                          mono
                        />
                      );
                    })}
                  </div>
                </div>
              )}

              <div className="rounded-xl border border-border/30 bg-card/15 p-3">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="text-sm font-medium text-foreground">Texture Transform</div>
                    <div className="text-[0.72rem] text-muted-foreground">
                      Rozdziel nawigację kamerą od edycji obiektu i tekstury. Kamera wyłącza gizmo, Texture włącza Move/Rotate/Scale.
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    <Button
                      size="sm"
                      variant={activeViewportControl === "camera" ? "default" : "outline"}
                      type="button"
                      onClick={() => setViewportControlScope("camera")}
                    >
                      Camera
                    </Button>
                    <Button
                      size="sm"
                      variant={activeViewportControl === "object" ? "default" : "outline"}
                      type="button"
                      onClick={() => setViewportControlScope("object")}
                    >
                      Object
                    </Button>
                    <Button
                      size="sm"
                      variant={activeViewportControl === "texture" ? "default" : "outline"}
                      type="button"
                      onClick={() => setViewportControlScope("texture")}
                    >
                      Texture
                    </Button>
                    <Button size="sm" variant="outline" type="button" onClick={handleFitTextureTransform}>
                      Fit
                    </Button>
                    <Button size="sm" variant="outline" type="button" onClick={handleResetTextureTransform}>
                      Reset
                    </Button>
                    <Button
                      size="sm"
                      variant={activeTextureMode === "translate" ? "default" : "outline"}
                      type="button"
                      onClick={() => setTextureGizmoMode("translate")}
                    >
                      Move
                    </Button>
                    <Button
                      size="sm"
                      variant={activeTextureMode === "rotate" ? "default" : "outline"}
                      type="button"
                      onClick={() => setTextureGizmoMode("rotate")}
                    >
                      Rotate
                    </Button>
                    <Button
                      size="sm"
                      variant={activeTextureMode === "scale" ? "default" : "outline"}
                      type="button"
                      onClick={() => setTextureGizmoMode("scale")}
                    >
                      Scale
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      type="button"
                      onClick={() => openNumericTransform(activeTextureMode as NumericTransformMode)}
                    >
                      Numeric
                    </Button>
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-3">
                  <div className="grid grid-cols-1 gap-2 rounded-lg border border-border/25 bg-background/30 p-2.5">
                    <div className="text-[0.65rem] font-semibold uppercase tracking-widest text-muted-foreground">
                      Mapping
                    </div>
                    <div className="grid grid-cols-1 gap-2 @[720px]:grid-cols-3">
                      <SelectField
                        label="Space"
                        value={textureMapping.space}
                        onchange={(value) =>
                          updateMagnetization((asset) => ({
                            ...asset,
                            mapping: {
                              ...(asset.mapping ?? textureMapping),
                              space: value,
                            },
                          }))
                        }
                        options={[
                          { label: "Object", value: "object" },
                          { label: "World", value: "world" },
                        ]}
                      />
                      <SelectField
                        label="Projection"
                        value={textureMapping.projection}
                        onchange={(value) =>
                          updateMagnetization((asset) => ({
                            ...asset,
                            mapping: {
                              ...(asset.mapping ?? textureMapping),
                              projection: value,
                            },
                          }))
                        }
                        options={[
                          { label: "Object Local", value: "object_local" },
                          { label: "Planar XY", value: "planar_xy" },
                          { label: "Planar XZ", value: "planar_xz" },
                          { label: "Planar YZ", value: "planar_yz" },
                        ]}
                      />
                      <SelectField
                        label="Clamp"
                        value={textureMapping.clamp_mode}
                        onchange={(value) =>
                          updateMagnetization((asset) => ({
                            ...asset,
                            mapping: {
                              ...(asset.mapping ?? textureMapping),
                              clamp_mode: value,
                            },
                          }))
                        }
                        options={[
                          { label: "None", value: "none" },
                          { label: "Clamp", value: "clamp" },
                          { label: "Repeat", value: "repeat" },
                          { label: "Mirror", value: "mirror" },
                        ]}
                      />
                    </div>
                  </div>

                  <div className="rounded-lg border border-border/25 bg-background/30 p-2.5">
                    <div className="mb-2 text-[0.65rem] font-semibold uppercase tracking-widest text-muted-foreground">
                      Translate
                    </div>
                    <div className="grid grid-cols-1 gap-2 @[720px]:grid-cols-3">
                    {[0, 1, 2].map((axis) => (
                      <TextField
                        key={`tx-translation-${axis}-${textureTransform.translation[axis]}`}
                        label={`Translate ${["X", "Y", "Z"][axis]}`}
                        defaultValue={textureTransform.translation[axis]}
                        onBlur={(event) =>
                          handleTextureTransformVectorBlur("translation", axis, event.target.value)
                        }
                        unit="m"
                        mono
                      />
                    ))}
                    </div>
                  </div>

                  <div className="rounded-lg border border-border/25 bg-background/30 p-2.5">
                    <div className="mb-2 text-[0.65rem] font-semibold uppercase tracking-widest text-muted-foreground">
                      Rotation (Quaternion)
                    </div>
                    <div className="grid grid-cols-1 gap-2 @[720px]:grid-cols-2 @[980px]:grid-cols-4">
                    {[0, 1, 2, 3].map((axis) => (
                      <TextField
                        key={`tx-rotation-${axis}-${textureTransform.rotation_quat[axis]}`}
                        label={`Quat ${["X", "Y", "Z", "W"][axis]}`}
                        defaultValue={textureTransform.rotation_quat[axis]}
                        onBlur={(event) => handleTextureRotationQuatBlur(axis, event.target.value)}
                        mono
                      />
                    ))}
                    </div>
                  </div>

                  <div className="rounded-lg border border-border/25 bg-background/30 p-2.5">
                    <div className="mb-2 text-[0.65rem] font-semibold uppercase tracking-widest text-muted-foreground">
                      Scale
                    </div>
                    {metricScalePreset ? (
                      <div className="mb-2 text-[0.68rem] text-muted-foreground">
                        Dla tej tekstury skala jest bezwymiarowa i powinna pozostać równa 1.
                        Rozmiar kontrolujesz przez parametry presetu (np. radius/core_radius).
                      </div>
                    ) : null}
                    <div className="grid grid-cols-1 gap-2 @[720px]:grid-cols-3">
                    {[0, 1, 2].map((axis) => (
                      <TextField
                        key={`tx-scale-${axis}-${textureTransform.scale[axis]}`}
                        label={`Scale ${["X", "Y", "Z"][axis]}`}
                        defaultValue={textureTransform.scale[axis]}
                        onBlur={(event) =>
                          handleTextureTransformVectorBlur("scale", axis, event.target.value)
                        }
                        disabled={metricScalePreset}
                        unit={scaleInputUnit}
                        mono
                      />
                    ))}
                    </div>
                  </div>

                  <div className="rounded-lg border border-border/25 bg-background/30 p-2.5">
                    <div className="mb-2 text-[0.65rem] font-semibold uppercase tracking-widest text-muted-foreground">
                      Pivot
                    </div>
                    <div className="grid grid-cols-1 gap-2 @[720px]:grid-cols-3">
                    {[0, 1, 2].map((axis) => (
                      <TextField
                        key={`tx-pivot-${axis}-${displayedPivot[axis]}`}
                        label={`Pivot ${["X", "Y", "Z"][axis]}`}
                        defaultValue={displayedPivot[axis]}
                        onBlur={(event) =>
                          handleTextureTransformVectorBlur("pivot", axis, event.target.value)
                        }
                        disabled={pivotLockedToVortexCore}
                        unit="m"
                        mono
                      />
                    ))}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          <div className="sticky bottom-0 z-20 rounded-xl border border-border/30 bg-background/90 px-3 py-2.5 backdrop-blur supports-[backdrop-filter]:bg-background/70">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="text-[0.72rem] text-muted-foreground">{magnetizationApplyState.hint}</div>
                {!magnetizationApplyState.canApply && magnetizationApplyState.disabledReason ? (
                  <div className="mt-1 text-[0.72rem] text-amber-200/90">
                    {magnetizationApplyState.disabledReason}
                  </div>
                ) : null}
                {mag.kind !== "preset_texture" &&
                presetTextureSync.status !== "idle" &&
                presetTextureSync.message &&
                (isMagnetizationSyncBusy || !isMagnetizationDirty || presetTextureSync.status === "error") ? (
                  <div
                    className={`mt-1 text-[0.72rem] ${
                      presetTextureSync.status === "error" ? "text-red-300" : "text-muted-foreground"
                    }`}
                  >
                    {presetTextureSync.message}
                  </div>
                ) : null}
                {mag.kind !== "preset_texture" && presetTextureSync.status !== "idle" ? (
                  <div className="mt-2 h-1.5 w-full overflow-hidden rounded bg-muted/40">
                    <div
                      className={`h-full transition-all duration-150 ${
                        presetTextureSync.status === "error"
                          ? "bg-red-400"
                          : presetTextureSync.status === "done"
                            ? "bg-emerald-400"
                            : "bg-primary"
                      }`}
                      style={{ width: `${presetTextureSyncPercent}%` }}
                    />
                  </div>
                ) : null}
              </div>
              <div className="flex items-center gap-2">
                {presetTextureSync.canRetryRefresh ? (
                  <Button
                    size="sm"
                    variant="outline"
                    type="button"
                    disabled={isMagnetizationSyncBusy}
                    onClick={retryMagnetizationViewportRefresh}
                  >
                    Refresh View
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  type="button"
                  disabled={!magnetizationApplyState.canApply}
                  onClick={applyMagnetizationChanges}
                >
                  {presetTextureSync.status === "syncing"
                    ? "Applying…"
                    : presetTextureSync.status === "refreshing"
                      ? "Refreshing…"
                      : "Apply"}
                </Button>
              </div>
            </div>
          </div>
        </div>
      </SidebarSection>
      {mag.kind === "preset_texture" && presetTextureModalOpen && typeof document !== "undefined"
        ? createPortal(
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 px-4 py-6 backdrop-blur-sm">
          <div className="w-full max-w-lg rounded-2xl border border-border/40 bg-background/95 p-4 shadow-[0_20px_90px_rgba(0,0,0,0.55)]">
            <div className="mb-2 text-[0.72rem] font-semibold uppercase tracking-[0.14em] text-primary/90">
              Magnetization Texture Apply
            </div>
            <div className="text-sm font-medium text-foreground">
              {presetTextureSync.status === "syncing"
                ? "Trwa przypisywanie tekstury magnetycznej do spinów/węzłów…"
                : presetTextureSync.status === "refreshing"
                  ? "Backend zapisal zmiany. Odswiezam live snapshot i viewport…"
                : presetTextureSync.status === "done"
                  ? "Przypisanie tekstury zakończone."
                  : "Nie udało się przypisać tekstury."}
            </div>
            {presetTextureSync.totalSpins != null ? (
              <div className="mt-1 text-[0.78rem] text-muted-foreground">
                {Math.max(0, presetTextureSync.processedSpins ?? 0).toLocaleString()}
                {" / "}
                {presetTextureSync.totalSpins.toLocaleString()} węzłów
              </div>
            ) : (
              <div className="mt-1 text-[0.78rem] text-muted-foreground">
                Oczekiwanie na potwierdzenie backendu.
              </div>
            )}
            <div className="mt-3 h-2 w-full overflow-hidden rounded bg-muted/40">
              <div
                className={`h-full transition-all duration-150 ${
                  presetTextureSync.status === "error"
                    ? "bg-red-400"
                    : presetTextureSync.status === "done"
                      ? "bg-emerald-400"
                      : "bg-primary"
                }`}
                style={{ width: `${presetTextureSyncPercent}%` }}
              />
            </div>
            {presetTextureSync.message ? (
              <div className="mt-2 text-[0.8rem] text-muted-foreground">{presetTextureSync.message}</div>
            ) : null}
            <div className="mt-4 flex justify-end">
              {presetTextureSync.canRetryRefresh ? (
                <Button
                  size="sm"
                  variant="outline"
                  type="button"
                  className="mr-2"
                  disabled={isMagnetizationSyncBusy}
                  onClick={retryMagnetizationViewportRefresh}
                >
                  Retry Refresh
                </Button>
              ) : null}
              <Button
                size="sm"
                variant="outline"
                type="button"
                disabled={isMagnetizationSyncBusy}
                onClick={() => setPresetTextureModalOpen(false)}
              >
                {isMagnetizationSyncBusy ? "Working…" : "Close"}
              </Button>
            </div>
          </div>
        </div>,
        document.body,
      )
        : null}
      {numericTransformOpen ? (
        <div className="fixed inset-0 z-[180] flex items-center justify-center bg-black/65 px-6 py-8 backdrop-blur-sm">
          <div className="w-full max-w-xl overflow-hidden rounded-2xl border border-white/12 bg-[linear-gradient(180deg,rgba(20,26,42,0.98),rgba(10,14,24,0.99))] shadow-[0_24px_120px_rgba(0,0,0,0.58)]">
            <div className="border-b border-white/10 px-5 py-3.5">
              <div className="text-[0.65rem] font-semibold uppercase tracking-[0.18em] text-cyan-300/80">
                Transform Type-In
              </div>
              <div className="mt-1 flex items-center justify-between gap-3">
                <div className="text-lg font-semibold text-white">Texture {numericMode}</div>
                <div className="inline-flex items-center rounded-lg border border-white/10 bg-white/5 p-1">
                  {(["translate", "rotate", "scale"] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => {
                        setNumericMode(mode);
                        if (mode === "rotate") {
                          setNumericAbsolute(eulerDegFromQuat(textureTransform.rotation_quat));
                        } else if (mode === "scale") {
                          setNumericAbsolute([...textureTransform.scale] as [number, number, number]);
                        } else {
                          setNumericAbsolute([...textureTransform.translation] as [number, number, number]);
                        }
                        setNumericOffset([0, 0, 0]);
                      }}
                      className={`rounded-md px-3 py-1.5 text-xs font-semibold uppercase tracking-wide transition ${
                        numericMode === mode
                          ? "bg-cyan-400/20 text-cyan-200"
                          : "text-slate-300 hover:bg-white/10"
                      }`}
                    >
                      {mode}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3 p-5">
              <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
                <div className="mb-2 text-[0.62rem] font-bold uppercase tracking-[0.16em] text-slate-400">
                  Absolute
                </div>
                <div className="grid grid-cols-3 gap-2">
                  {(["X", "Y", "Z"] as const).map((axis, idx) => (
                    <label key={`abs-${axis}`} className="flex flex-col gap-1">
                      <span className="text-[0.58rem] font-semibold uppercase tracking-wider text-slate-400">
                        {axis}
                      </span>
                      <input
                        type="number"
                        step={numericMode === "rotate" ? 1 : 0.01}
                        value={numericAbsolute[idx]}
                        onChange={(event) =>
                          setNumericAbsolute((prev) => {
                            const next = [...prev] as [number, number, number];
                            next[idx] = Number(event.target.value);
                            return next;
                          })
                        }
                        className="h-8 rounded-md border border-white/12 bg-slate-950/70 px-2 text-xs font-mono text-white outline-none focus:border-cyan-300/45 focus:ring-1 focus:ring-cyan-300/35"
                      />
                    </label>
                  ))}
                </div>
              </div>
              <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
                <div className="mb-2 text-[0.62rem] font-bold uppercase tracking-[0.16em] text-slate-400">
                  Offset
                </div>
                <div className="grid grid-cols-3 gap-2">
                  {(["X", "Y", "Z"] as const).map((axis, idx) => (
                    <label key={`off-${axis}`} className="flex flex-col gap-1">
                      <span className="text-[0.58rem] font-semibold uppercase tracking-wider text-slate-400">
                        {axis}
                      </span>
                      <input
                        type="number"
                        step={numericMode === "rotate" ? 1 : 0.01}
                        value={numericOffset[idx]}
                        onChange={(event) =>
                          setNumericOffset((prev) => {
                            const next = [...prev] as [number, number, number];
                            next[idx] = Number(event.target.value);
                            return next;
                          })
                        }
                        className="h-8 rounded-md border border-white/12 bg-slate-950/70 px-2 text-xs font-mono text-white outline-none focus:border-cyan-300/45 focus:ring-1 focus:ring-cyan-300/35"
                      />
                    </label>
                  ))}
                </div>
              </div>
            </div>
            <div className="border-t border-white/10 px-5 py-3.5">
              <div className="flex items-center justify-between gap-2">
                <div className="text-[0.68rem] text-slate-400">
                  {numericMode === "rotate" ? "Angles in degrees (XYZ Euler)." : "World-space values for selected texture transform scope."}
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    type="button"
                    onClick={() => setNumericTransformOpen(false)}
                  >
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    type="button"
                    onClick={applyNumericTransform}
                  >
                    Apply
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
