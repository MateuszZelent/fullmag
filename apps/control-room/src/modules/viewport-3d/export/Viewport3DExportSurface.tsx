"use client";

import {
  lazy,
  Suspense,
  useCallback,
  useRef,
  useSyncExternalStore,
  type ComponentPropsWithRef,
  type ElementType,
  type MouseEventHandler,
  type PointerEventHandler,
  type ReactElement,
} from "react";
import { Download } from "lucide-react";

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/shared/ui/ContextMenu";
import { useInstanceTabHidden } from "@/kernel/layout/instanceTabVisibility";

import type { ViewportModelSource } from "./Viewport3DExportDialog";
import { viewport3dStore } from "../viewport3dStore";

const ExportDialog = lazy(() => import("./Viewport3DExportDialog"));
const isExportOpen = () => viewport3dStore.getSnapshot().widgets.export3dDialogOpen;
const subscribe = (listener: () => void) => viewport3dStore.subscribe(listener);

export function Viewport3DExportOutlet({ getSource }: { getSource: () => Promise<ViewportModelSource> }) {
  const open = useSyncExternalStore(subscribe, isExportOpen, () => false);
  const hidden = useInstanceTabHidden();
  return open && !hidden ? (
    <Suspense fallback={null}>
      <ExportDialog getSource={getSource} />
    </Suspense>
  ) : null;
}

type ViewportTriggerProps = ComponentPropsWithRef<"div">;

function ViewportContextTrigger({
  children,
  onContextMenu,
  ...props
}: Omit<ViewportTriggerProps, "children"> & { children: ReactElement<ViewportTriggerProps> }) {
  const rightButton = useRef<{ x: number; y: number; moved: boolean } | null>(null);

  const onPointerDownCapture = useCallback<PointerEventHandler<HTMLDivElement>>((event) => {
    rightButton.current = event.button === 2 ? { x: event.clientX, y: event.clientY, moved: false } : null;
  }, []);
  const onPointerMoveCapture = useCallback<PointerEventHandler<HTMLDivElement>>((event) => {
    const start = rightButton.current;
    if (start && (event.buttons & 2) && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4) {
      start.moved = true;
    }
  }, []);
  // OrbitControls suppresses the native menu on the canvas in the target/bubble phase.
  const onContextMenuCapture = useCallback<MouseEventHandler<HTMLDivElement>>((event) => {
    const wasDrag = event.button === 2 && rightButton.current?.moved;
    rightButton.current = null;
    if (wasDrag) event.preventDefault();
    else onContextMenu?.(event);
  }, [onContextMenu]);

  const Viewport = children.type as ElementType<ViewportTriggerProps>;
  return (
    <Viewport
      key={children.key}
      {...children.props}
      {...props}
      style={{ ...children.props.style, ...props.style }}
      onPointerDownCapture={onPointerDownCapture}
      onPointerMoveCapture={onPointerMoveCapture}
      onContextMenuCapture={onContextMenuCapture}
    />
  );
}

export function Viewport3DExportMenu({
  children,
  onCommand,
}: {
  children: ReactElement<ViewportTriggerProps>;
  onCommand: (command: string) => void;
}) {
  return (
    <ContextMenu modal={false}>
      <ContextMenuTrigger asChild>
        <ViewportContextTrigger>{children}</ViewportContextTrigger>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => onCommand("viewport-3d.export-model")}>
          <Download aria-hidden="true" size={14} />
          Export 3D model…
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
