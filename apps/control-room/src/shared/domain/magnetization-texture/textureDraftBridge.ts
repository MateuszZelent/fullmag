import type { TargetMetricBounds } from "./boundsResolver";
import type { MagneticTextureDraft } from "./presetDefaults";
import type { MagnetizationTextureTarget } from "./types";

export type TextureGizmoMode = "view" | "translate" | "rotate" | "scale";
export type TransformScopeMode = "object" | "texture";

export interface TextureInspectorDraftBinding {
  readonly target: MagnetizationTextureTarget;
  readonly draft: MagneticTextureDraft;
  readonly bounds: TargetMetricBounds;
  readonly patchDraft: (partial: Partial<MagneticTextureDraft>) => void;
  readonly fitCharacteristicSize: () => void;
  readonly resetTransform: () => void;
}

export interface TextureInspectorUiSnapshot {
  readonly gizmoEnabled: boolean;
  readonly gizmoMode: TextureGizmoMode;
  readonly transformScope: TransformScopeMode;
  readonly gestureActive: boolean;
  readonly tabRequest: {
    readonly targetKey: string;
    readonly tabId: "preset" | "field-file";
    readonly seq: number;
  } | null;
}

export interface TextureDraftBridgeSnapshot extends TextureInspectorUiSnapshot {
  readonly activeBinding: TextureInspectorDraftBinding | null;
}

type Listener = () => void;

let currentUiSnapshot: TextureInspectorUiSnapshot = {
  gizmoEnabled: false,
  gizmoMode: "translate",
  transformScope: "object",
  gestureActive: false,
  tabRequest: null,
};

let currentSnapshot: TextureDraftBridgeSnapshot = {
  ...currentUiSnapshot,
  activeBinding: null,
};

let bindingOwner: symbol | null = null;
const listeners = new Set<Listener>();

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

function commitUiSnapshot(nextUi: TextureInspectorUiSnapshot): void {
  currentUiSnapshot = nextUi;
  currentSnapshot = {
    ...nextUi,
    activeBinding: currentSnapshot.activeBinding,
  };
  emit();
}

export function subscribeTextureDraftBridge(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getTextureDraftBridgeSnapshot(): TextureDraftBridgeSnapshot {
  return currentSnapshot;
}

export function getTextureInspectorUiSnapshot(): TextureInspectorUiSnapshot {
  return currentUiSnapshot;
}

export function resetTextureDraftBridgeForTests(): void {
  bindingOwner = null;
  currentUiSnapshot = {
    gizmoEnabled: false,
    gizmoMode: "translate",
    transformScope: "object",
    gestureActive: false,
    tabRequest: null,
  };
  currentSnapshot = {
    ...currentUiSnapshot,
    activeBinding: null,
  };
  emit();
}

export function registerTextureInspectorBinding(
  owner: symbol,
  binding: TextureInspectorDraftBinding,
): void {
  bindingOwner = owner;
  if (currentSnapshot.activeBinding === binding) return;
  currentSnapshot = {
    ...currentUiSnapshot,
    activeBinding: binding,
  };
  emit();
}

export function unregisterTextureInspectorBinding(owner: symbol): void {
  if (bindingOwner !== owner) return;
  bindingOwner = null;
  currentUiSnapshot = {
    ...currentUiSnapshot,
    gizmoEnabled: false,
    gizmoMode: "view",
    transformScope: "object",
    gestureActive: false,
  };
  currentSnapshot = {
    ...currentUiSnapshot,
    activeBinding: null,
  };
  emit();
}

export function resolveActiveTextureGizmoMode(
  snapshot: Pick<TextureInspectorUiSnapshot, "gizmoEnabled" | "gizmoMode">,
): TextureGizmoMode {
  return snapshot.gizmoEnabled ? snapshot.gizmoMode : "view";
}

export function isTextureGizmoHandleModeActive(
  snapshot: TextureDraftBridgeSnapshot,
  selectedObjectId?: string | null,
): boolean {
  if (!snapshot.gizmoEnabled || snapshot.gizmoMode === "view") return false;
  const binding = snapshot.activeBinding;
  if (!binding) return false;
  if (selectedObjectId && binding.target.objectId !== selectedObjectId) return false;
  if (
    binding.target.kind === "region" &&
    binding.draft.inheritanceMode === "inherit"
  ) {
    return false;
  }
  if (binding.draft.sourceMode === "field-file") {
    return false;
  }
  return true;
}

export function toggleTextureGizmo(force?: boolean): boolean {
  const nextEnabled = force ?? !currentUiSnapshot.gizmoEnabled;
  const nextMode: TextureGizmoMode =
    nextEnabled && currentUiSnapshot.gizmoMode === "view"
      ? "translate"
      : currentUiSnapshot.gizmoMode;
  commitUiSnapshot({
    ...currentUiSnapshot,
    gizmoEnabled: nextEnabled,
    gizmoMode: nextMode,
    transformScope: nextEnabled ? "texture" : "object",
  });
  return nextEnabled;
}

export function setTextureGizmoMode(mode: TextureGizmoMode): void {
  const nextScope: TransformScopeMode = mode === "view" ? "object" : "texture";
  if (
    currentUiSnapshot.gizmoMode === mode &&
    currentUiSnapshot.gizmoEnabled &&
    currentUiSnapshot.transformScope === nextScope
  ) {
    return;
  }
  commitUiSnapshot({
    ...currentUiSnapshot,
    gizmoEnabled: true,
    gizmoMode: mode,
    transformScope: nextScope,
  });
}

export function setTransformScope(scope: TransformScopeMode): void {
  const gizmoEnabled = scope === "texture" ? true : false;
  if (
    currentUiSnapshot.transformScope === scope &&
    currentUiSnapshot.gizmoEnabled === gizmoEnabled
  ) {
    return;
  }
  commitUiSnapshot({
    ...currentUiSnapshot,
    transformScope: scope,
    gizmoEnabled,
  });
}

export function beginTextureGizmoGesture(): void {
  if (currentUiSnapshot.gestureActive) return;
  commitUiSnapshot({
    ...currentUiSnapshot,
    gestureActive: true,
  });
}

export function endTextureGizmoGesture(): void {
  if (!currentUiSnapshot.gestureActive) return;
  commitUiSnapshot({
    ...currentUiSnapshot,
    gestureActive: false,
  });
}

export function patchActiveTextureDraft(partial: Partial<MagneticTextureDraft>): boolean {
  const binding = currentSnapshot.activeBinding;
  if (!binding) return false;
  binding.patchDraft(partial);
  return true;
}

export function runActiveTextureFitCharacteristicSize(): boolean {
  const binding = currentSnapshot.activeBinding;
  if (!binding) return false;
  binding.fitCharacteristicSize();
  return true;
}

export function runActiveTextureResetTransform(): boolean {
  const binding = currentSnapshot.activeBinding;
  if (!binding) return false;
  binding.resetTransform();
  return true;
}

export function formatTextureTargetKey(target: MagnetizationTextureTarget): string {
  return target.kind === "region"
    ? `region:${target.objectId}:${target.regionId}`
    : `object:${target.objectId}`;
}

export function requestTextureInspectorTab(
  target: MagnetizationTextureTarget,
  tabId: "preset" | "field-file",
): void {
  commitUiSnapshot({
    ...currentUiSnapshot,
    tabRequest: {
      targetKey: formatTextureTargetKey(target),
      tabId,
      seq: (currentUiSnapshot.tabRequest?.seq ?? 0) + 1,
    },
  });
}

export function handleTextureGizmoShortcutKey(rawKey: string): boolean {
  const key = rawKey.toLowerCase();
  if (key === "t") {
    toggleTextureGizmo();
    return true;
  }
  if (key === "q") {
    setTextureGizmoMode("view");
    return true;
  }
  if (key === "w") {
    setTextureGizmoMode("translate");
    return true;
  }
  if (key === "e") {
    setTextureGizmoMode("rotate");
    return true;
  }
  if (key === "r") {
    setTextureGizmoMode("scale");
    return true;
  }
  return false;
}
