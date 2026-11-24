"use client";

import { useMemo } from "react";
import { OrbitControls, PerspectiveCamera } from "@react-three/drei";
import { useThree } from "@react-three/fiber";
import type { SceneResource } from "@/kernel/api/apiTypes";
import { useKernel } from "@/kernel/KernelContext";
import { DEFAULT_OBJECT_VISUALIZATION } from "@/kernel/visualization/ObjectVisualizationController";
import { useViewport3DColors } from "./hooks/useViewport3DColors";
import { PrimitiveObjectLayer } from "./layers/PrimitiveObjectLayer";
import { Viewport3DBackground } from "./layers/Viewport3DBackground";
import { resolveViewport3DMaterialProfile } from "./layers/viewport3DMaterialProfile";
import { Viewport3DCanvas } from "./Viewport3DCanvas";
import { Viewport3DErrorBoundary } from "./Viewport3DErrorBoundary";
import { Viewport3DResourceTracker } from "./viewport3dDiagnostics";
import { buildViewport3DPrimitiveRenderModel } from "./viewport3dPrimitiveModel";
import { DEFAULT_VIEWPORT_3D_VISUAL_PROFILE_ID, getViewport3DVisualProfile } from "./viewport3dVisualProfile";
import { savedCameraDistance } from "./model/savedResultsPlaybackModel";
import { combineViewport3DBounds, type Viewport3DBounds } from "./viewport3dRenderModel";

const materialProfile = resolveViewport3DMaterialProfile(
  getViewport3DVisualProfile(DEFAULT_VIEWPORT_3D_VISUAL_PROFILE_ID),
  { lightingMode: "studio" },
);
const authoredGeometrySettings = { ...DEFAULT_OBJECT_VISUALIZATION, primitiveVisible: true };
const previewSettings = () => authoredGeometrySettings;
const ignorePick = () => {};

function PreviewCamera({ bounds }: { bounds: Viewport3DBounds }) {
  const size = useThree((state) => state.size);
  const aspect = size.width && size.height ? size.width / size.height : 1;
  const distance = savedCameraDistance(bounds.size, aspect);
  const [x, y, z] = bounds.center;
  return (
    <>
      <PerspectiveCamera
        far={distance * 1000}
        makeDefault
        near={distance / 1000}
        position={[x + distance * 0.38, y - distance * 0.76, z + distance * 0.52]}
      />
      <OrbitControls enableDamping={false} makeDefault target={bounds.center} />
    </>
  );
}

export function SessionPreviewViewport({ scene }: { scene: SceneResource }) {
  const { colors, colorsUnavailable } = useViewport3DColors();
  const { diagnosticRecorder } = useKernel();
  const previewDiagnostics = useMemo(() => ({
    record: (record: Parameters<typeof diagnosticRecorder.record>[0]) => diagnosticRecorder.record(record),
  }), [diagnosticRecorder]);
  const tracker = useMemo(() => new Viewport3DResourceTracker(), []);
  const model = useMemo(() => buildViewport3DPrimitiveRenderModel(scene, null), [scene]);
  const bounds = useMemo(
    () => combineViewport3DBounds(model.objects.map((object) => object.bounds)),
    [model],
  );

  const importedSurfaceCount = scene.objects?.filter(
    (object) => object.geometry?.geometry_kind === "ImportedGeometry",
  ).length ?? 0;
  const importedSurfaceNotice = importedSurfaceCount > 0 && (
    <p className="m-0 px-4 py-2 text-fm-xs text-fm-secondary">
      Open the model in the authoring workspace to view its imported STL surfaces.
    </p>
  );
  if (!bounds) return importedSurfaceNotice || <p className="px-4 py-2">This model has no geometry available for preview.</p>;
  if (colorsUnavailable) {
    return <p className="px-4 py-2" role="alert">The viewport theme is unavailable.</p>;
  }
  if (!colors) return <p className="px-4 py-2" role="status">Loading viewport…</p>;
  return (
    <>
      {importedSurfaceNotice}
      <Viewport3DErrorBoundary diagnosticRecorder={previewDiagnostics}>
        <Viewport3DCanvas className="min-h-0 flex-1" data-session-preview-viewport="" frameloop="demand">
          <Viewport3DBackground colors={colors} mode="solid" strength={0} tracker={tracker} />
          <ambientLight intensity={0.75} />
          <directionalLight intensity={2} position={[3, -4, 6]} />
          <PreviewCamera bounds={bounds} />
          <PrimitiveObjectLayer colors={colors} getObjectSettings={previewSettings}
            materialProfile={materialProfile} onSelectObject={ignorePick} primitiveModel={model} tracker={tracker} />
        </Viewport3DCanvas>
      </Viewport3DErrorBoundary>
    </>
  );
}
