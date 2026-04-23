"use client";

import { useCallback, useState } from "react";

export function useCanvasHost<T extends HTMLElement = HTMLDivElement>() {
  const [hostNode, setHostNode] = useState<T | null>(null);

  const hostRef = useCallback((node: T | null) => {
    setHostNode((current) => (current === node ? current : node));
  }, []);

  return { hostRef, hostNode };
}
