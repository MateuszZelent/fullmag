import { useCallback, useRef, useState } from "react";
import type { ObjectTransform, TransformSession, TransformTool, SnapConfig } from "./types";
import { snappedTranslation } from "./transformMath";
import type { TransformSpace } from "./types";

interface UseTransformSessionOptions {
  /** Called when drag ends with the final delta */
  onCommit: (objectId: string, delta: ObjectTransform) => void;
  space: TransformSpace;
  snap: SnapConfig;
}

interface TransformSessionAPI {
  session: TransformSession | null;
  /** Begin a drag on an object */
  onDragStart: (objectId: string, tool: TransformTool, baseline: ObjectTransform) => void;
  /** Update preview during drag */
  onDrag: (delta: ObjectTransform) => void;
  /** Commit the transform */
  onDragEnd: () => void;
  /** Cancel without committing */
  onCancel: () => void;
}

export function useTransformSession({
  onCommit,
  space,
  snap,
}: UseTransformSessionOptions): TransformSessionAPI {
  void space;
  const [session, setSession] = useState<TransformSession | null>(null);
  const sessionRef = useRef<TransformSession | null>(null);

  const onDragStart = useCallback(
    (objectId: string, tool: TransformTool, baseline: ObjectTransform) => {
      const s: TransformSession = { objectId, tool, baseline, preview: null };
      sessionRef.current = s;
      setSession(s);
    },
    [],
  );

  const onDrag = useCallback(
    (delta: ObjectTransform) => {
      const s = sessionRef.current;
      if (!s) return;

      // Apply snapping to raw delta
      const snapped: ObjectTransform = {
        translation: snappedTranslation(delta.translation, snap),
        rotation: delta.rotation,
        scale: delta.scale,
      };

      const next: TransformSession = { ...s, preview: snapped };
      sessionRef.current = next;
      setSession(next);
    },
    [snap],
  );

  const onDragEnd = useCallback(() => {
    const s = sessionRef.current;
    if (!s || !s.preview) {
      sessionRef.current = null;
      setSession(null);
      return;
    }
    onCommit(s.objectId, s.preview);
    sessionRef.current = null;
    setSession(null);
  }, [onCommit]);

  const onCancel = useCallback(() => {
    sessionRef.current = null;
    setSession(null);
  }, []);

  return { session, onDragStart, onDrag, onDragEnd, onCancel };
}
