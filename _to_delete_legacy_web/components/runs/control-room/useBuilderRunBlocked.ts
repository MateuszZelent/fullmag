import { useGeometryBuilderStore } from "@/features/geometry-builder/store/useGeometryBuilderStore";
import { useWorkspaceStore } from "@/lib/workspace/workspace-store";

export function useBuilderRunBlocked(): boolean {
  const currentStage = useWorkspaceStore((state) => state.currentStage);
  const activeCoreTab = useWorkspaceStore((state) => state.activeCoreTab);
  return useGeometryBuilderStore((state) =>
    currentStage === "build" && activeCoreTab === "Geometry" && state.builderMode.enabled
      ? state.isRunBlocked()
      : false,
  );
}
