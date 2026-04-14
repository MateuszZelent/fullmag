import { useCallback, useEffect, useState } from "react";
import type { MeshSelectionSnapshot } from "../fem/femMeshTypes";

export interface FaceInteractionState {
  hoveredFace: { idx: number; x: number; y: number } | null;
  ctxMenu: { x: number; y: number; faceIdx: number } | null;
  selectedFaces: number[];
}

export interface FaceInteractionHandlers {
  handleFaceHover: (e: any) => void;
  handleFaceUnhover: () => void;
  handleFaceClick: (e: any) => void;
  handleFaceContextMenu: (e: any) => void;
  setSelectedFaces: React.Dispatch<React.SetStateAction<number[]>>;
  setHoveredFace: React.Dispatch<
    React.SetStateAction<{ idx: number; x: number; y: number } | null>
  >;
  setCtxMenu: React.Dispatch<
    React.SetStateAction<{ x: number; y: number; faceIdx: number } | null>
  >;
}

interface UseFemFaceInteractionOptions {
  topologySignature: string;
  geometryPointerInteractionsEnabled: boolean;
  onSelectionChange?: (selection: MeshSelectionSnapshot) => void;
}

export function useFemFaceInteraction({
  topologySignature,
  geometryPointerInteractionsEnabled,
  onSelectionChange,
}: UseFemFaceInteractionOptions): FaceInteractionState & FaceInteractionHandlers {
  const [hoveredFace, setHoveredFace] = useState<{
    idx: number;
    x: number;
    y: number;
  } | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{
    x: number;
    y: number;
    faceIdx: number;
  } | null>(null);
  const [selectedFaces, setSelectedFaces] = useState<number[]>([]);

  // Reset on topology change
  useEffect(() => {
    queueMicrotask(() => {
      setSelectedFaces([]);
      setHoveredFace(null);
      setCtxMenu(null);
    });
  }, [topologySignature]);

  // Publish selection
  useEffect(() => {
    onSelectionChange?.({
      selectedFaceIndices: selectedFaces,
      primaryFaceIndex:
        selectedFaces.length > 0
          ? selectedFaces[selectedFaces.length - 1]
          : null,
    });
  }, [onSelectionChange, selectedFaces]);

  // Dismiss when pointer interactions disabled
  useEffect(() => {
    if (geometryPointerInteractionsEnabled) return;
    queueMicrotask(() => {
      setHoveredFace(null);
      setCtxMenu(null);
      setSelectedFaces([]);
    });
  }, [geometryPointerInteractionsEnabled]);

  // Auto-dismiss context menu on click
  useEffect(() => {
    if (!ctxMenu) return;
    const dismiss = () => setCtxMenu(null);
    window.addEventListener("click", dismiss, { once: true });
    return () => window.removeEventListener("click", dismiss);
  }, [ctxMenu]);

  const handleFaceHover = useCallback((e: any) => {
    if (e.faceIndex != null)
      setHoveredFace({ idx: e.faceIndex, x: e.clientX, y: e.clientY });
  }, []);

  const handleFaceUnhover = useCallback(() => setHoveredFace(null), []);

  const handleFaceClick = useCallback((e: any) => {
    if (e.button !== 0 || e.faceIndex == null) return;
    e.stopPropagation();
    const fIdx = e.faceIndex;
    setSelectedFaces((prev) => {
      if (e.shiftKey || e.ctrlKey)
        return prev.includes(fIdx)
          ? prev.filter((i) => i !== fIdx)
          : [...prev, fIdx];
      if (prev.length === 1 && prev[0] === fIdx) return [];
      return [fIdx];
    });
  }, []);

  const handleFaceContextMenu = useCallback((e: any) => {
    e?.stopPropagation?.();
    e?.preventDefault?.();
    e?.nativeEvent?.preventDefault?.();
    if (e.faceIndex != null)
      setCtxMenu({ x: e.clientX, y: e.clientY, faceIdx: e.faceIndex });
  }, []);

  return {
    hoveredFace,
    ctxMenu,
    selectedFaces,
    handleFaceHover,
    handleFaceUnhover,
    handleFaceClick,
    handleFaceContextMenu,
    setSelectedFaces,
    setHoveredFace,
    setCtxMenu,
  };
}
