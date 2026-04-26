"use client";

import { useCallback, useRef, useState } from "react";

export function useCanvasHost<T extends HTMLElement = HTMLDivElement>() {
  const [hostNode, setHostNode] = useState<T | null>(null);
  const hostNodeRef = useRef<T | null>(null);

  const hostRef = useCallback((node: T | null) => {
    if (node === null) {
      hostNodeRef.current = null;
      return;
    }
    if (hostNodeRef.current === node) {
      return;
    }
    hostNodeRef.current = node;
    setHostNode(node);
  }, []);

  return { hostRef, hostNode };
}
