"use client";

import { Activity, createContext, useContext, useEffect, useRef, useState, type ReactNode, type PointerEvent as ReactPointerEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { GripVertical, MoreHorizontal, MoveDiagonal2 } from "lucide-react";
import { Button } from "./Button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "./DropdownMenu";

export type PanelMode = "docked" | "floating" | "maximized";
interface Geometry { x: number; y: number; width: number; height: number }
const INITIAL_GEOMETRY: Geometry = { x: 96, y: 144, width: 416, height: 560 };
interface PanelChromeControls {
  move: ReactNode;
  actions: (menuItems?: ReactNode) => ReactNode;
  /** Runs a module's own hide action with the frame's focus and scroll retention. */
  hideWith: (action: () => void) => void;
}
const ChromeContext = createContext<PanelChromeControls | null>(null);

/** One header shared by module tabs/identity and frame controls; `menuItems` join the frame menu. */
export function PanelChrome({ children, className = "", menuItems }: { children: ReactNode; className?: string; menuItems?: ReactNode }) {
  const chrome = useContext(ChromeContext);
  return <div className={`fm-panel-chrome ${className}`}>{chrome?.move}{children}{chrome?.actions(menuItems)}</div>;
}

/** Frame controls of the enclosing PanelFrame, or null outside one. */
export function usePanelChromeControls(): PanelChromeControls | null {
  return useContext(ChromeContext);
}

function constrain(g: Geometry): Geometry {
  const width = Math.max(240, Math.min(g.width, window.innerWidth - 16));
  const height = Math.max(180, Math.min(g.height, window.innerHeight - 16));
  return { width, height, x: Math.max(8, Math.min(g.x, window.innerWidth - width - 8)), y: Math.max(8, Math.min(g.y, window.innerHeight - height - 8)) };
}

interface PanelFrameProps {
  id: string;
  title: string;
  visible: boolean;
  children: ReactNode;
  dockHandle?: ReactNode;
  drawer?: boolean;
  /** Edge a narrow-screen drawer opens from. */
  drawerSide?: "left" | "right";
  /** False pins the frame in the dock: no float, maximize or resize. */
  floatable?: boolean;
  suspendWhenHidden?: boolean;
  onDockChange: (docked: boolean) => void;
  onHide?: () => void;
  onMove?: (direction: -1 | 1) => void;
}

export function PanelFrame({ id, title, visible, children, dockHandle, drawer = false, drawerSide = "right", floatable = true, suspendWhenHidden = true, onDockChange, onHide, onMove }: PanelFrameProps) {
  const storageKey = `fullmag.workspace.panel.${id}.v1`;
  // Keep this frame safe when rendered outside the workspace hydration boundary.
  const [initial] = useState(() => {
    if (typeof window === "undefined") return { mode: "docked" as PanelMode, geometry: INITIAL_GEOMETRY };
    try {
      const raw: unknown = JSON.parse(window.localStorage.getItem(storageKey) ?? "null");
      if (raw && typeof raw === "object") {
        const value = raw as { mode?: unknown; geometry?: Partial<Geometry> };
        const savedMode: PanelMode = value.mode === "floating" || value.mode === "maximized" ? value.mode : "docked";
        const g = value.geometry;
        return { mode: savedMode, geometry: g && [g.x, g.y, g.width, g.height].every(v => typeof v === "number" && Number.isFinite(v)) ? constrain(g as Geometry) : INITIAL_GEOMETRY };
      }
    } catch { /* Invalid layout preferences use the default frame. */ }
    return { mode: "docked" as PanelMode, geometry: INITIAL_GEOMETRY };
  });
  const [mode, setMode] = useState<PanelMode>(initial.mode);
  const restoreMode = useRef<PanelMode>("docked");
  const [geometry, setGeometry] = useState(initial.geometry);
  const frame = useRef<HTMLElement>(null);
  const [maxBounds, setMaxBounds] = useState<{ top: number; left: number; width: number; height: number } | null>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const scroll = useRef<Array<[HTMLElement, number, number]>>([]);
  const gesture = useRef<{ x: number; y: number; geometry: Geometry; kind: "move" | "resize" } | null>(null);
  // A pinned frame ignores any floating/maximized mode saved before it was pinned.
  const effectiveMode = !floatable ? "docked" : drawer && mode === "docked" ? "floating" : mode;
  const docked = effectiveMode === "docked";

  useEffect(() => {
    if (gesture.current) return;
    try { localStorage.setItem(storageKey, JSON.stringify({ mode, geometry })); } catch { /* Layout preference only. */ }
  }, [geometry, mode, storageKey]);

  useEffect(() => { onDockChange(visible && docked); }, [docked, onDockChange, visible]);
  useEffect(() => {
    const measureWorkspace = () => {
      const bounds = frame.current?.closest(".fm-workspace-body")?.getBoundingClientRect();
      if (!bounds) return;
      const next = { top: bounds.top + 8, left: bounds.left + 8, width: Math.max(0, bounds.width - 16), height: Math.max(0, bounds.height - 16) };
      setMaxBounds(previous => previous && previous.top === next.top && previous.left === next.left && previous.width === next.width && previous.height === next.height ? previous : next);
    };
    const workspace = frame.current?.closest(".fm-workspace-body");
    const observer = new ResizeObserver(measureWorkspace);
    if (workspace) observer.observe(workspace);
    measureWorkspace();
    const resize = () => { setGeometry(g => constrain(g)); measureWorkspace(); };
    const reset = () => { setMode("docked"); setGeometry(constrain(INITIAL_GEOMETRY)); };
    window.addEventListener("resize", resize);
    window.addEventListener("fullmag:workspace-layout-restored", reset);
    return () => { observer.disconnect(); window.removeEventListener("resize", resize); window.removeEventListener("fullmag:workspace-layout-restored", reset); };
  }, []);

  // Capture before Activity hides the DOM; restore scroll/focus after its effects return.
  useEffect(() => {
    if (!visible) return;
    const timer = requestAnimationFrame(() => {
      for (const [element, top, left] of scroll.current) { element.scrollTop = top; element.scrollLeft = left; }
      if (previousFocus.current?.isConnected) previousFocus.current.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(timer);
  }, [visible]);

  const hideWith = (action: () => void) => {
    if (frame.current) {
      const active = document.activeElement as HTMLElement | null;
      if (active && frame.current.contains(active) && !active.closest(".fm-panel-chrome")) previousFocus.current = active;
      scroll.current = Array.from(frame.current.querySelectorAll<HTMLElement>("*")).filter(e => e.scrollTop || e.scrollLeft).map(e => [e, e.scrollTop, e.scrollLeft]);
    }
    action();
    requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(`[data-restore-panel="${id}"]`)?.focus());
  };
  const hide = () => hideWith(() => onHide?.());
  const interactionGeometry = (): Geometry => {
    if (!drawer || mode !== "docked") return geometry;
    const bounds = frame.current?.getBoundingClientRect();
    setMode("floating");
    return bounds ? { x: bounds.left, y: bounds.top, width: bounds.width, height: bounds.height } : geometry;
  };
  const begin = (event: ReactPointerEvent<HTMLButtonElement>, kind: "move" | "resize") => {
    if (event.button !== 0 || effectiveMode === "maximized") return;
    event.preventDefault();
    const current = interactionGeometry();
    setGeometry(current);
    gesture.current = { x: event.clientX, y: event.clientY, geometry: current, kind };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const move = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const start = gesture.current;
    if (!start) return;
    const dx = event.clientX - start.x, dy = event.clientY - start.y;
    setGeometry(constrain(start.kind === "move" ? { ...start.geometry, x: start.geometry.x + dx, y: start.geometry.y + dy } : { ...start.geometry, width: start.geometry.width + dx, height: start.geometry.height + dy }));
  };
  const end = () => {
    gesture.current = null;
    try { localStorage.setItem(storageKey, JSON.stringify({ mode, geometry })); } catch { /* Layout preference only. */ }
  };
  const keyboard = (event: ReactKeyboardEvent, kind: "move" | "resize") => {
    if (effectiveMode === "maximized") return;
    const step = event.shiftKey ? 40 : 10;
    const dx = event.key === "ArrowRight" ? step : event.key === "ArrowLeft" ? -step : 0;
    const dy = event.key === "ArrowDown" ? step : event.key === "ArrowUp" ? -step : 0;
    if (!dx && !dy) return;
    event.preventDefault(); event.stopPropagation();
    const current = interactionGeometry();
    setGeometry(constrain(kind === "move" ? { ...current, x: current.x + dx, y: current.y + dy } : { ...current, width: current.width + dx, height: current.height + dy }));
  };
  const controls: PanelChromeControls = {
    move: docked ? dockHandle : <Button size="icon" variant="ghost" aria-label={`Move ${title} with arrow keys`} disabled={effectiveMode === "maximized"} onPointerDown={e => begin(e, "move")} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onKeyDown={e => keyboard(e, "move")}><GripVertical size={14} aria-hidden="true" /></Button>,
    actions: menuItems => <DropdownMenu><DropdownMenuTrigger asChild><Button size="icon" variant="ghost" aria-label={`${title} panel menu`}><MoreHorizontal size={15} aria-hidden="true" /></Button></DropdownMenuTrigger><DropdownMenuContent align="end" onCloseAutoFocus={event => { if (!visible) event.preventDefault(); }}>
      {menuItems ? <>{menuItems}<DropdownMenuSeparator /></> : null}
      {floatable ? <><DropdownMenuItem onSelect={() => setMode(mode === "floating" ? "docked" : "floating")}>{mode === "floating" ? "Dock panel" : "Float panel"}</DropdownMenuItem>
      <DropdownMenuItem onSelect={() => { if (mode === "maximized") setMode(restoreMode.current); else { restoreMode.current = mode; setMode("maximized"); } }}>{mode === "maximized" ? "Restore panel" : "Maximize panel"}</DropdownMenuItem></> : null}
      {onMove ? <><DropdownMenuItem onSelect={() => onMove(-1)}>Move panel left</DropdownMenuItem><DropdownMenuItem onSelect={() => onMove(1)}>Move panel right</DropdownMenuItem></> : null}
      {onHide ? <><DropdownMenuSeparator /><DropdownMenuItem onSelect={hide}>Hide panel</DropdownMenuItem></> : null}
    </DropdownMenuContent></DropdownMenu>,
    hideWith,
  };
  return <section ref={frame} className="fm-panel-frame" data-panel-frame={id} data-panel-mode={effectiveMode} hidden={!visible} aria-label={`${title} panel`}
    onFocusCapture={event => { if (frame.current?.contains(event.target as HTMLElement) && !(event.target as HTMLElement).closest(".fm-panel-chrome")) previousFocus.current = event.target as HTMLElement; }}
    onScrollCapture={() => { if (visible && frame.current) scroll.current = Array.from(frame.current.querySelectorAll<HTMLElement>("*")).filter(e => e.scrollTop || e.scrollLeft).map(e => [e, e.scrollTop, e.scrollLeft]); }} style={!docked ? (effectiveMode === "maximized" ? maxBounds ?? { inset: 8 } : drawer && mode === "docked" ? { ...(drawerSide === "left" ? { left: 8 } : { right: 8 }), top: 144, width: "min(416px, calc(100vw - 16px))", height: "calc(100dvh - 180px)" } : { left: geometry.x, top: geometry.y, width: geometry.width, height: geometry.height }) : undefined}>
    <ChromeContext.Provider value={controls}>
      <Activity mode={!visible && suspendWhenHidden ? "hidden" : "visible"}>{children}</Activity>
    </ChromeContext.Provider>
    {!docked && effectiveMode !== "maximized" ? <Button className="fm-panel-frame__resize" size="icon" variant="ghost" aria-label={`Resize ${title} with arrow keys`} onPointerDown={e => begin(e, "resize")} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onKeyDown={e => keyboard(e, "resize")}><MoveDiagonal2 size={14} aria-hidden="true" /></Button> : null}
  </section>;
}
