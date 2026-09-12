import { useCallback, useMemo } from "react";
import type { ViewportMeshRenderMode } from "@/components/shell/ribbon/command-registry";
import { useSelectedObjectId } from "@/features/selection";
import { defaultMeshEntityViewState } from "@/lib/session/types";
import type { ModelContextValue } from "./context-hooks";

export function useSelectedObjectRibbonDisplay(
  model: Pick<
    ModelContextValue,
    | "meshEntityViewState"
    | "meshParts"
    | "setMeshEntityViewState"
  >,
) {
  const selectedObjectId = useSelectedObjectId();
  const selectedObjectPartIds = useMemo(
    () =>
      selectedObjectId
        ? model.meshParts
            .filter((part) => part.object_id === selectedObjectId || part.geometry_id === selectedObjectId)
            .map((part) => part.id)
        : [],
    [model.meshParts, selectedObjectId],
  );
  const selectedObjectRepresentativePart = selectedObjectPartIds[0]
    ? model.meshParts.find((part) => part.id === selectedObjectPartIds[0]) ?? null
    : null;
  const selectedObjectOpacity = selectedObjectRepresentativePart
    ? (model.meshEntityViewState[selectedObjectRepresentativePart.id]?.opacity
      ?? defaultMeshEntityViewState(selectedObjectRepresentativePart).opacity)
    : null;
  const selectedObjectRenderMode: ViewportMeshRenderMode | "inherit" | null = selectedObjectRepresentativePart
    ? (selectedObjectPartIds.some((partId) => model.meshEntityViewState[partId]?.renderMode !== undefined)
      ? ((model.meshEntityViewState[selectedObjectRepresentativePart.id]?.renderMode ?? null) as ViewportMeshRenderMode | null)
      : "inherit")
    : null;
  const selectedObjectTextureVisible = selectedObjectRepresentativePart
    ? ((model.meshEntityViewState[selectedObjectRepresentativePart.id]?.colorField
      ?? defaultMeshEntityViewState(selectedObjectRepresentativePart).colorField) !== "none")
    : null;

  const handleSelectedObjectOpacity = useCallback((opacity: number) => {
    if (selectedObjectPartIds.length === 0) return;
    model.setMeshEntityViewState((previous) => {
      let changed = false;
      const next = { ...previous };
      for (const partId of selectedObjectPartIds) {
        const part = model.meshParts.find((entry) => entry.id === partId);
        if (!part) continue;
        const current = next[partId] ?? defaultMeshEntityViewState(part);
        if (current.opacity === opacity) continue;
        next[partId] = { ...current, opacity };
        changed = true;
      }
      return changed ? next : previous;
    });
  }, [model, selectedObjectPartIds]);

  const handleSelectedObjectRenderMode = useCallback(
    (mode: ViewportMeshRenderMode | "inherit") => {
      if (mode === "inherit") {
        if (selectedObjectPartIds.length === 0) return;
        model.setMeshEntityViewState((previous) => {
          let changed = false;
          const next = { ...previous };
          for (const partId of selectedObjectPartIds) {
            if (!(partId in next)) continue;
            delete next[partId];
            changed = true;
          }
          return changed ? next : previous;
        });
        return;
      }
      if (selectedObjectPartIds.length === 0) return;
      model.setMeshEntityViewState((previous) => {
        let changed = false;
        const next = { ...previous };
        for (const partId of selectedObjectPartIds) {
          const part = model.meshParts.find((entry) => entry.id === partId);
          if (!part) continue;
          const current = next[partId] ?? defaultMeshEntityViewState(part);
          if (current.renderMode === mode) continue;
          next[partId] = { ...current, renderMode: mode };
          changed = true;
        }
        return changed ? next : previous;
      });
    },
    [model, selectedObjectPartIds],
  );

  const handleSelectedObjectTextureVisible = useCallback(
    (visible: boolean) => {
      if (selectedObjectPartIds.length === 0) return;
      model.setMeshEntityViewState((previous) => {
        let changed = false;
        const next = { ...previous };
        for (const partId of selectedObjectPartIds) {
          const part = model.meshParts.find((entry) => entry.id === partId);
          if (!part || part.role !== "magnetic_object") continue;
          const current = next[partId] ?? defaultMeshEntityViewState(part);
          const nextColorField = visible ? "orientation" : "none";
          if (current.colorField === nextColorField) continue;
          next[partId] = { ...current, colorField: nextColorField };
          changed = true;
        }
        return changed ? next : previous;
      });
    },
    [model, selectedObjectPartIds],
  );

  const handleClearSelectedDisplayOverrides = useCallback(() => {
    if (selectedObjectPartIds.length === 0) return;
    model.setMeshEntityViewState((previous) => {
      let changed = false;
      const next = { ...previous };
      for (const partId of selectedObjectPartIds) {
        if (!(partId in next)) continue;
        delete next[partId];
        changed = true;
      }
      return changed ? next : previous;
    });
  }, [model, selectedObjectPartIds]);

  return {
    selectedObjectOpacity,
    selectedObjectRenderMode,
    selectedObjectTextureVisible,
    handleClearSelectedDisplayOverrides,
    handleSelectedObjectOpacity,
    handleSelectedObjectRenderMode,
    handleSelectedObjectTextureVisible,
  };
}
