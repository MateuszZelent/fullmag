"use client";

import type { ReactNode } from "react";

export interface UnifiedViewport3DPresenterProps {
  showGeometryAuthoringViewport: boolean;
  isFemMeshMode: boolean;
  isFem3DMode: boolean;
  renderGeometryAuthoring: () => ReactNode;
  renderFemMesh: () => ReactNode;
  renderFem3D: () => ReactNode;
  renderFdm: () => ReactNode;
}

export default function UnifiedViewport3DPresenter({
  showGeometryAuthoringViewport,
  isFemMeshMode,
  isFem3DMode,
  renderGeometryAuthoring,
  renderFemMesh,
  renderFem3D,
  renderFdm,
}: UnifiedViewport3DPresenterProps) {
  if (showGeometryAuthoringViewport) {
    return <>{renderGeometryAuthoring()}</>;
  }
  if (isFemMeshMode) {
    return <>{renderFemMesh()}</>;
  }
  if (isFem3DMode) {
    return <>{renderFem3D()}</>;
  }
  return <>{renderFdm()}</>;
}
