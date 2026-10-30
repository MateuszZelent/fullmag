import { useEffect, useRef, type RefObject } from "react";
export interface DockBounds { left: number; top: number; width: number; height: number }
/** Only anchors participate in the splitter. Renderer parents never move. */
export function DockAnchor({ id, surface, onBounds }: {
  id: string;
  surface: RefObject<HTMLDivElement | null>;
  onBounds: (id: string, bounds: DockBounds) => void;
}) {
  const anchor = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = anchor.current;
    const host = surface.current;
    if (!node || !host) return;
    const measure = () => {
      const rect = node.getBoundingClientRect(), parent = host.getBoundingClientRect();
      onBounds(id, { left: rect.left - parent.left, top: rect.top - parent.top, width: rect.width, height: rect.height });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    observer.observe(host);
    measure();
    return () => observer.disconnect();
  }, [id, onBounds, surface]);
  return <div ref={anchor} className="fm-viewport-dock-anchor" data-dock-anchor={id} aria-hidden="true" />;
}
