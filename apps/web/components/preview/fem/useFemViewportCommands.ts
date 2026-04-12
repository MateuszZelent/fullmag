import { useCallback } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { MeshEntityViewState } from "../../../lib/session/types";
import type {
  ClipAxis,
  FemColorField,
  FemFerromagnetVisibilityMode,
  FemVectorDomainFilter,
  RenderMode,
} from "./femMeshTypes";
import type { ViewportSelectionScope } from "@/features/viewport-fem/model/femViewportSelection";

interface UseFemViewportCommandsArgs {
  hasMeshParts: boolean;
  toolbarStylePartIds: string[];
  toolbarColorPartIds: string[];
  selectionScope: ViewportSelectionScope;
  onMeshPartViewStatePatch?: (
    partIds: string[],
    patch: Partial<MeshEntityViewState>,
  ) => void;
  onRenderModeChange?: (value: RenderMode) => void;
  onOpacityChange?: (value: number) => void;
  onClipEnabledChange?: (value: boolean) => void;
  onClipAxisChange?: (value: ClipAxis) => void;
  onClipPosChange?: (value: number) => void;
  onShowArrowsChange?: (value: boolean) => void;
  onVectorDomainFilterChange?: (value: FemVectorDomainFilter) => void;
  onFerromagnetVisibilityModeChange?: (value: FemFerromagnetVisibilityMode) => void;
  onShrinkFactorChange?: (value: number) => void;
  setInternalRenderMode: Dispatch<SetStateAction<RenderMode>>;
  setInternalOpacity: Dispatch<SetStateAction<number>>;
  setInternalClipEnabled: Dispatch<SetStateAction<boolean>>;
  setInternalClipAxis: Dispatch<SetStateAction<ClipAxis>>;
  setInternalClipPos: Dispatch<SetStateAction<number>>;
  setInternalClipFlip: Dispatch<SetStateAction<boolean>>;
  setInternalShowArrows: Dispatch<SetStateAction<boolean>>;
  setInternalVectorDomainFilter: Dispatch<SetStateAction<FemVectorDomainFilter>>;
  setInternalFerromagnetVisibilityMode: Dispatch<SetStateAction<FemFerromagnetVisibilityMode>>;
  setInternalShrinkFactor: Dispatch<SetStateAction<number>>;
  field: FemColorField;
  setField: Dispatch<SetStateAction<FemColorField>>;
  clipEnabled: boolean;
  partExplorerOpen: boolean;
  setOpenPopover: Dispatch<SetStateAction<
    "quantity" | "color" | "clip" | "display" | "vectors" | "camera" | "panels" | null
  >>;
  setLegendOpen: Dispatch<SetStateAction<boolean>>;
  setInternalPartExplorerOpen: Dispatch<SetStateAction<boolean>>;
}

type PopoverId =
  | "quantity"
  | "color"
  | "clip"
  | "display"
  | "vectors"
  | "camera"
  | "panels"
  | null;

export interface FemViewportCommands {
  applyToolbarRenderMode: (next: RenderMode) => void;
  applyToolbarOpacity: (next: number) => void;
  applyToolbarColorField: (next: FemColorField) => void;
  syncFieldFromProps: (next: FemColorField) => void;
  setClipEnabled: (next: boolean) => void;
  toggleClip: () => void;
  setClipAxis: (next: ClipAxis) => void;
  setClipPos: (next: number) => void;
  setClipFlip: (next: boolean) => void;
  setArrowsVisible: (next: boolean) => void;
  setVectorDomainFilter: (next: FemVectorDomainFilter) => void;
  setFerromagnetVisibilityMode: (next: FemFerromagnetVisibilityMode) => void;
  setShrinkFactor: (next: number) => void;
  toggleLegend: () => void;
  togglePartExplorer: () => void;
}

interface RenderModeCommandArgs {
  hasMeshParts: boolean;
  toolbarStylePartIds: string[];
  selectionScope: ViewportSelectionScope;
  onMeshPartViewStatePatch?: (
    partIds: string[],
    patch: Partial<MeshEntityViewState>,
  ) => void;
  onRenderModeChange?: (value: RenderMode) => void;
  setInternalRenderMode: Dispatch<SetStateAction<RenderMode>>;
  setOpenPopover: Dispatch<SetStateAction<PopoverId>>;
}

interface OpacityCommandArgs {
  hasMeshParts: boolean;
  toolbarStylePartIds: string[];
  onMeshPartViewStatePatch?: (
    partIds: string[],
    patch: Partial<MeshEntityViewState>,
  ) => void;
  onOpacityChange?: (value: number) => void;
  setInternalOpacity: Dispatch<SetStateAction<number>>;
}

interface ColorFieldCommandArgs {
  hasMeshParts: boolean;
  toolbarColorPartIds: string[];
  selectionScope: ViewportSelectionScope;
  onMeshPartViewStatePatch?: (
    partIds: string[],
    patch: Partial<MeshEntityViewState>,
  ) => void;
  setField: Dispatch<SetStateAction<FemColorField>>;
}

interface ClipEnabledCommandArgs {
  onClipEnabledChange?: (value: boolean) => void;
  setInternalClipEnabled: Dispatch<SetStateAction<boolean>>;
}

export function applyToolbarRenderModeCommand(
  args: RenderModeCommandArgs,
  next: RenderMode,
): void {
  if (args.hasMeshParts && args.toolbarStylePartIds.length > 0 && args.onMeshPartViewStatePatch) {
    args.onMeshPartViewStatePatch(args.toolbarStylePartIds, { renderMode: next });
    if (args.selectionScope.kind === "universe") {
      args.onRenderModeChange?.(next);
    }
  } else if (args.onRenderModeChange) {
    args.onRenderModeChange(next);
  } else {
    args.setInternalRenderMode(next);
  }
  args.setOpenPopover(null);
}

export function applyToolbarOpacityCommand(
  args: OpacityCommandArgs,
  next: number,
): void {
  if (args.hasMeshParts && args.toolbarStylePartIds.length > 0 && args.onMeshPartViewStatePatch) {
    args.onMeshPartViewStatePatch(args.toolbarStylePartIds, { opacity: next });
    return;
  }
  if (args.onOpacityChange) {
    args.onOpacityChange(next);
    return;
  }
  args.setInternalOpacity(next);
}

export function applyToolbarColorFieldCommand(
  args: ColorFieldCommandArgs,
  next: FemColorField,
): void {
  if (args.hasMeshParts && args.toolbarColorPartIds.length > 0 && args.onMeshPartViewStatePatch) {
    args.onMeshPartViewStatePatch(args.toolbarColorPartIds, { colorField: next });
    if (args.selectionScope.kind === "universe") {
      args.setField(next);
    }
    return;
  }
  args.setField(next);
}

export function setClipEnabledCommand(
  args: ClipEnabledCommandArgs,
  next: boolean,
): void {
  if (args.onClipEnabledChange) {
    args.onClipEnabledChange(next);
    return;
  }
  args.setInternalClipEnabled(next);
}

export function toggleClipCommand(
  args: ClipEnabledCommandArgs & { clipEnabled: boolean },
): void {
  setClipEnabledCommand(args, !args.clipEnabled);
}

export function useFemViewportCommands({
  hasMeshParts,
  toolbarStylePartIds,
  toolbarColorPartIds,
  selectionScope,
  onMeshPartViewStatePatch,
  onRenderModeChange,
  onOpacityChange,
  onClipEnabledChange,
  onClipAxisChange,
  onClipPosChange,
  onShowArrowsChange,
  onVectorDomainFilterChange,
  onFerromagnetVisibilityModeChange,
  onShrinkFactorChange,
  setInternalRenderMode,
  setInternalOpacity,
  setInternalClipEnabled,
  setInternalClipAxis,
  setInternalClipPos,
  setInternalClipFlip,
  setInternalShowArrows,
  setInternalVectorDomainFilter,
  setInternalFerromagnetVisibilityMode,
  setInternalShrinkFactor,
  field,
  setField,
  clipEnabled,
  partExplorerOpen,
  setOpenPopover,
  setLegendOpen,
  setInternalPartExplorerOpen,
}: UseFemViewportCommandsArgs): FemViewportCommands {
  const applyToolbarRenderMode = useCallback((next: RenderMode) => {
    applyToolbarRenderModeCommand({
      hasMeshParts,
      toolbarStylePartIds,
      selectionScope,
      onMeshPartViewStatePatch,
      onRenderModeChange,
      setInternalRenderMode,
      setOpenPopover,
    }, next);
  }, [
    hasMeshParts,
    onMeshPartViewStatePatch,
    onRenderModeChange,
    selectionScope.kind,
    setInternalRenderMode,
    setOpenPopover,
    toolbarStylePartIds,
  ]);

  const applyToolbarOpacity = useCallback((next: number) => {
    applyToolbarOpacityCommand({
      hasMeshParts,
      toolbarStylePartIds,
      onMeshPartViewStatePatch,
      onOpacityChange,
      setInternalOpacity,
    }, next);
  }, [
    hasMeshParts,
    onMeshPartViewStatePatch,
    onOpacityChange,
    setInternalOpacity,
    toolbarStylePartIds,
  ]);

  const applyToolbarColorField = useCallback((next: FemColorField) => {
    applyToolbarColorFieldCommand({
      hasMeshParts,
      toolbarColorPartIds,
      selectionScope,
      onMeshPartViewStatePatch,
      setField,
    }, next);
  }, [
    hasMeshParts,
    onMeshPartViewStatePatch,
    selectionScope.kind,
    setField,
    toolbarColorPartIds,
  ]);

  const syncFieldFromProps = useCallback((next: FemColorField) => {
    if (field !== next) {
      setField(next);
    }
  }, [field, setField]);

  const setClipEnabled = useCallback((next: boolean) => {
    setClipEnabledCommand({
      onClipEnabledChange,
      setInternalClipEnabled,
    }, next);
  }, [onClipEnabledChange, setInternalClipEnabled]);

  const toggleClip = useCallback(() => {
    toggleClipCommand({
      clipEnabled,
      onClipEnabledChange,
      setInternalClipEnabled,
    });
  }, [clipEnabled, onClipEnabledChange, setInternalClipEnabled]);

  const setClipAxis = useCallback((next: ClipAxis) => {
    if (onClipAxisChange) {
      onClipAxisChange(next);
      return;
    }
    setInternalClipAxis(next);
  }, [onClipAxisChange, setInternalClipAxis]);

  const setClipPos = useCallback((next: number) => {
    if (onClipPosChange) {
      onClipPosChange(next);
      return;
    }
    setInternalClipPos(next);
  }, [onClipPosChange, setInternalClipPos]);

  const setClipFlip = useCallback((next: boolean) => {
    setInternalClipFlip(next);
  }, [setInternalClipFlip]);

  const setArrowsVisible = useCallback((next: boolean) => {
    if (onShowArrowsChange) {
      onShowArrowsChange(next);
      return;
    }
    setInternalShowArrows(next);
  }, [onShowArrowsChange, setInternalShowArrows]);

  const setVectorDomainFilter = useCallback((next: FemVectorDomainFilter) => {
    if (onVectorDomainFilterChange) {
      onVectorDomainFilterChange(next);
      return;
    }
    setInternalVectorDomainFilter(next);
  }, [onVectorDomainFilterChange, setInternalVectorDomainFilter]);

  const setFerromagnetVisibilityMode = useCallback((next: FemFerromagnetVisibilityMode) => {
    if (onFerromagnetVisibilityModeChange) {
      onFerromagnetVisibilityModeChange(next);
      return;
    }
    setInternalFerromagnetVisibilityMode(next);
  }, [onFerromagnetVisibilityModeChange, setInternalFerromagnetVisibilityMode]);

  const setShrinkFactor = useCallback((next: number) => {
    if (onShrinkFactorChange) {
      onShrinkFactorChange(next);
      return;
    }
    setInternalShrinkFactor(next);
  }, [onShrinkFactorChange, setInternalShrinkFactor]);

  const toggleLegend = useCallback(() => {
    setLegendOpen((prev) => !prev);
  }, [setLegendOpen]);

  const togglePartExplorer = useCallback(() => {
    setInternalPartExplorerOpen(!partExplorerOpen);
  }, [partExplorerOpen, setInternalPartExplorerOpen]);

  return {
    applyToolbarRenderMode,
    applyToolbarOpacity,
    applyToolbarColorField,
    syncFieldFromProps,
    setClipEnabled,
    toggleClip,
    setClipAxis,
    setClipPos,
    setClipFlip,
    setArrowsVisible,
    setVectorDomainFilter,
    setFerromagnetVisibilityMode,
    setShrinkFactor,
    toggleLegend,
    togglePartExplorer,
  };
}
