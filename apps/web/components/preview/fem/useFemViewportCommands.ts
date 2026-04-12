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
    if (hasMeshParts && toolbarStylePartIds.length > 0 && onMeshPartViewStatePatch) {
      onMeshPartViewStatePatch(toolbarStylePartIds, { renderMode: next });
      if (selectionScope.kind === "universe") {
        onRenderModeChange?.(next);
      }
    } else if (onRenderModeChange) {
      onRenderModeChange(next);
    } else {
      setInternalRenderMode(next);
    }
    setOpenPopover(null);
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
    if (hasMeshParts && toolbarStylePartIds.length > 0 && onMeshPartViewStatePatch) {
      onMeshPartViewStatePatch(toolbarStylePartIds, { opacity: next });
      return;
    }
    if (onOpacityChange) {
      onOpacityChange(next);
      return;
    }
    setInternalOpacity(next);
  }, [
    hasMeshParts,
    onMeshPartViewStatePatch,
    onOpacityChange,
    setInternalOpacity,
    toolbarStylePartIds,
  ]);

  const applyToolbarColorField = useCallback((next: FemColorField) => {
    if (hasMeshParts && toolbarColorPartIds.length > 0 && onMeshPartViewStatePatch) {
      onMeshPartViewStatePatch(toolbarColorPartIds, { colorField: next });
      if (selectionScope.kind === "universe") {
        setField(next);
      }
      return;
    }
    setField(next);
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
    if (onClipEnabledChange) {
      onClipEnabledChange(next);
      return;
    }
    setInternalClipEnabled(next);
  }, [onClipEnabledChange, setInternalClipEnabled]);

  const toggleClip = useCallback(() => {
    setClipEnabled(!clipEnabled);
  }, [clipEnabled, setClipEnabled]);

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
