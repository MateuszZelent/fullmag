"use client";

import { useThree } from "@react-three/fiber";
import { useEffect } from "react";
import { Mesh, Vector2, type Intersection } from "three";

import {
  planarMonitorFramePreviewStore,
  usePlanarMonitorDraftEditorId,
  usePlanarMonitorPickFaceArmed,
} from "@/kernel/workspace/planarMonitorFramePreview";

import { orthonormalFrame } from "./planarNormalHandleGeometry";

/** A visible, opaque-enough object face; gizmos and overlays are not faces. */
function isPickableFace(hit: Intersection): boolean {
  const object = hit.object;
  if (!(object instanceof Mesh) || !hit.face || !object.visible || object.userData.gizmo) return false;
  const materials = Array.isArray(object.material) ? object.material : [object.material];
  return materials.some((material) => material.visible !== false && (material.opacity ?? 1) > 0.05);
}

/**
 * Pick-from-face for planar monitor drafts (F6 B5). While armed from the
 * Inspector, the next primary click on an object face proposes a frame with
 * the face normal through the hit point to the draft owner, then disarms.
 * The click does not orbit or select.
 */
export function PlanarMonitorFacePicker() {
  const armed = usePlanarMonitorPickFaceArmed();
  const editorMonitorId = usePlanarMonitorDraftEditorId();
  const { camera, gl, raycaster, scene } = useThree();

  useEffect(() => {
    if (!armed || !editorMonitorId) return;
    const element = gl.domElement;
    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      const rect = element.getBoundingClientRect();
      const pointer = new Vector2(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObjects(scene.children, true).find(isPickableFace);
      if (!hit?.face) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const normal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
      const frame = orthonormalFrame([normal.x, normal.y, normal.z], [1, 0, 0]);
      planarMonitorFramePreviewStore.proposeDraftFrame(editorMonitorId, {
        normal: frame.normal,
        origin_m: [hit.point.x, hit.point.y, hit.point.z],
        u_axis: frame.uAxis,
        v_axis: frame.vAxis,
      });
      planarMonitorFramePreviewStore.setPickFaceArmed(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") planarMonitorFramePreviewStore.setPickFaceArmed(false);
    };
    element.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      element.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [armed, camera, editorMonitorId, gl, raycaster, scene]);

  return null;
}
