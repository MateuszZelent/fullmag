import type * as THREE from "three";
import ViewCube from "../ViewCube";
import HslSphere from "../HslSphere";

interface ViewportGizmoStackProps {
  sceneRef: React.MutableRefObject<any>;
  onRotate?: (quat: THREE.Quaternion) => void;
  onReset?: () => void;
  showOrientationSphere?: boolean;
  orientationSphereAxisConvention?: "identity" | "swapYZ";
  orientationSpherePositionClassName?: string;
  compact?: boolean;
  embedded?: boolean;
  className?: string;
}

export default function ViewportGizmoStack({
  sceneRef,
  onRotate,
  onReset,
  showOrientationSphere = false,
  orientationSphereAxisConvention = "identity",
  orientationSpherePositionClassName,
  compact = false,
  embedded = false,
  className,
}: ViewportGizmoStackProps) {
  return (
    <div className={embedded ? `flex flex-col items-end gap-2 ${className ?? ""}`.trim() : className}>
      <ViewCube
        sceneRef={sceneRef}
        onRotate={onRotate}
        onReset={onReset}
        cubeClassName="top-3 right-3"
        axisClassName="bottom-5 right-5"
        embedded={embedded}
      />
      {showOrientationSphere ? (
        <HslSphere
          sceneRef={sceneRef}
          axisConvention={orientationSphereAxisConvention}
          anchorClassName={orientationSpherePositionClassName}
          size={compact ? 112 : 144}
          compact={compact}
          embedded={embedded}
        />
      ) : null}
    </div>
  );
}
