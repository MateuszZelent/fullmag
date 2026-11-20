import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import {
  ArrowUpRight, Box, Boxes, Check, CircleDot, Columns2, Command as CommandIcon, Copy, Crosshair, Eye, EyeOff, ListTree,
  Moon, MousePointerClick, PanelLeft, Settings, SlidersHorizontal, Square, Sun, Target, HelpCircle, Library, Database, LineChart,
  History, Code2, Monitor, Play,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Command, CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator, CommandShortcut } from "@/components/ui/command"
import { ContextMenu, ContextMenuContent, ContextMenuGroup, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Kbd } from "@/components/ui/kbd"
import { Segmented } from "@/components/ui/segmented"
import { Separator } from "@/components/ui/separator"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Toggle } from "@/components/ui/toggle"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useTheme } from "@/components/theme-provider"
import { InspectorTemplate, pythonFor } from "@/inspector/InspectorTemplate"
import { SPECS, TREE } from "@/inspector/specs"
import { stats, useInspectorStore } from "@/inspector/state"
import type { InspectorApi, Spec } from "@/inspector/types"
import { SHADOW, plural } from "@/lib/format"
import { cn } from "@/lib/utils"
import { Viewport } from "@/viewport/Viewport"
import { AppBar, InstanceTabs, Ribbon } from "@/shell/Chrome"
import {
  ChartsPanel, Dock, HistoryPanel, LibraryPanel, PanelSearch, PanelShell, PythonPanel, RAIL_LEFT, RAIL_RIGHT_BASE, Rail,
  ResultsPanel, StatusBar, type HistoryEntry, type Problem,
} from "@/shell/Panels"

function useResolvedTheme() {
  const { theme } = useTheme()
  const read = () => (document.documentElement.classList.contains("dark") ? "dark" : "light")
  const [sys, setSys] = useState(read)
  useEffect(() => {
    const mo = new MutationObserver(() => setSys(read()))
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] })
    return () => mo.disconnect()
  }, [])
  useEffect(() => { setSys(read()) }, [theme])
  return sys
}
function useHeight<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [h, setH] = useState(0)
  useLayoutEffect(() => {
    if (!ref.current) return
    const ro = new ResizeObserver(([e]) => setH(Math.round(e.borderBoxSize?.[0]?.blockSize ?? e.contentRect.height)))
    ro.observe(ref.current)
    return () => ro.disconnect()
  }, [])
  return [ref, h] as const
}
function useIsDesktop() {
  const [d, setD] = useState(() => window.matchMedia("(min-width: 1024px)").matches)
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)")
    const on = () => setD(mq.matches)
    mq.addEventListener("change", on)
    return () => mq.removeEventListener("change", on)
  }, [])
  return d
}
const now = () => new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" })
const SM = "shadow-[0px_2px_3px_-1px_rgba(0,0,0,0.1),0px_1px_0px_0px_rgba(25,28,33,0.02),0px_0px_0px_1px_rgba(25,28,33,0.08)]"

function ModelTree({ store, onSelect, onCopy, filter }: { store: ReturnType<typeof useInspectorStore>[0]; onSelect: (id: string) => void; onCopy: (id: string) => void; filter: string }) {
  const q = filter.trim().toLowerCase()
  return (
    <nav aria-label="Model tree" className="flex flex-col gap-0.5">
      {TREE.filter((n) => !q || n.group || n.label.toLowerCase().includes(q)).map((n, i) => {
        if (n.group) {
          return (
            <div key={`${n.label}-${i}`} className="mt-2 flex items-center gap-2 px-2.5 pb-1 text-[11px] font-medium text-muted-foreground first:mt-0">
              <n.icon className="size-3.5" />{n.label}
            </div>
          )
        }
        const id = n.target
        const active = id === store.sel
        let dot: "dirty" | "err" | null = null
        if (id) {
          const st = stats(SPECS[id], store.d[id], store.o[id])
          if (SPECS[id].state(store.d[id]).tone === "err" || (st.errors && st.staged)) dot = "err"
          else if (st.staged) dot = "dirty"
        }
        const btn = (
          <button
            type="button"
            disabled={!id}
            aria-current={active || undefined}
            onClick={() => id && onSelect(id)}
            style={{ paddingLeft: `${10 + (n.level - 1) * 14}px` }}
            className={cn(
              "group/tn relative flex h-8 w-full items-center gap-2 rounded-xl pr-2.5 text-left text-[13px] text-foreground/80 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
              id ? "hover:bg-foreground/[.06] hover:text-foreground" : "cursor-default opacity-45",
              active && `bg-raised text-foreground ${SM} dark:bg-[color-mix(in_oklab,var(--primary)_16%,transparent)] dark:shadow-none dark:ring-1 dark:ring-[color-mix(in_oklab,var(--primary)_28%,transparent)]`,
            )}
          >
            <n.icon className={cn("size-4 shrink-0 text-muted-foreground", active && "text-primary")} />
            <span className="truncate">{n.label}</span>
            {dot ? <span className={cn("ml-auto size-1.5 shrink-0 rounded-full animate-in zoom-in", dot === "err" ? "bg-destructive" : "bg-primary")} /> : null}
          </button>
        )
        if (!id) {
          return (
            <Tooltip key={`${n.label}-${i}`}>
              <TooltipTrigger asChild><span>{btn}</span></TooltipTrigger>
              <TooltipContent side="right">Not part of this mockup</TooltipContent>
            </Tooltip>
          )
        }
        return (
          <ContextMenu key={`${n.label}-${i}`}>
            <ContextMenuTrigger asChild>{btn}</ContextMenuTrigger>
            <ContextMenuContent className={cn("w-52 rounded-xl", SHADOW.md)}>
              <ContextMenuGroup>
                <ContextMenuItem onSelect={() => onSelect(id)}><MousePointerClick /> Open inspector</ContextMenuItem>
                <ContextMenuItem onSelect={() => onCopy(id)}><Copy /> Copy node ID</ContextMenuItem>
              </ContextMenuGroup>
            </ContextMenuContent>
          </ContextMenu>
        )
      })}
    </nav>
  )
}

export function App() {
  const [store, act] = useInspectorStore()
  const { theme, setTheme } = useTheme()
  const resolved = useResolvedTheme()
  const desktop = useIsDesktop()
  const [cmdOpen, setCmdOpen] = useState(false)
  const [compare, setCompare] = useState(false)
  const [anat, setAnat] = useState(false)
  const [treeSheet, setTreeSheet] = useState(false)
  const [json, setJson] = useState<{ title: string; body: string } | null>(null)
  const [iw, setIw] = useState(392)
  const [fit, setFit] = useState(0)
  const [drag, setDrag] = useState(false)
  const [leftTab, setLeftTab] = useState<string | null>("model")
  const [rightTab, setRightTab] = useState<string | null>("inspector")
  const [ribbonTab, setRibbonTab] = useState("Workspace")
  const [ribbonOpen, setRibbonOpen] = useState(true)
  const [dockTab, setDockTab] = useState("telemetry")
  const [dockOpen, setDockOpen] = useState(true)
  const [running, setRunning] = useState(true)
  const [treeFilter, setTreeFilter] = useState("")
  const [history, setHistory] = useState<HistoryEntry[]>([
    { time: "10:41:06", title: "Run 4 started", detail: "LLG + RK23 on GPU, double precision", id: "run" },
    { time: "10:41:02", title: "Plan accepted", detail: "Execution revision 8, 10 stages", id: "stage" },
    { time: "10:40:51", title: "Session opened", detail: "fdm_stt_pma_pulse from script", id: "object" },
  ])
  const [chromeRef, chromeH] = useHeight<HTMLDivElement>()
  const [dockRef, dockH] = useHeight<HTMLDivElement>()
  const selRef = useRef(store.sel)
  selRef.current = store.sel
  const spec = SPECS[store.sel]

  const api: InspectorApi = useMemo(() => ({
    select: (id) => { act.select(id); setRightTab("inspector") },
    setVal: (id, k, v) => act.setVal(id, k, v),
    focusRow: (k) => act.focus(selRef.current, k),
    toast: (msg, desc) => toast(msg, { description: desc }),
    openJson: (title, body) => setJson({ title, body }),
  }), [act])

  const select = useCallback((id: string) => {
    const go = () => { act.select(id); setRightTab("inspector") }
    const doc = document as Document & { startViewTransition?: (cb: () => void) => void }
    if (doc.startViewTransition && !matchMedia("(prefers-reduced-motion: reduce)").matches) doc.startViewTransition(go)
    else go()
  }, [act])

  const problems: Problem[] = useMemo(() => Object.values(SPECS).flatMap((sp) =>
    (sp.notices?.(store.d[sp.id]) ?? []).filter((n) => n.tone !== "info").map((n) => ({ tone: n.tone as "err" | "warn", text: n.text, node: sp.title(store.d[sp.id]), target: sp.id }))), [store.d])

  const onAction = useCallback((a: string) => {
    const [kind, ...rest] = a.split(":")
    const arg = rest.join(":")
    switch (kind) {
      case "toast": toast(arg); break
      case "select": select(arg); break
      case "focus": { const [id, k] = rest; act.focus(id, k); setRightTab("inspector"); break }
      case "left": setLeftTab(arg); break
      case "right": setRightTab(arg); break
      case "dock": setDockTab(arg); setDockOpen(true); break
      case "palette": setCmdOpen(true); break
      case "fit": setFit((n) => n + 1); break
      case "view": act.setVal("viz", "view", arg); break
      case "toggle":
        if (arg === "vectors") { const o = store.d.viz.overlays as string[]; act.setVal("viz", "overlays", o.includes("vectors") ? o.filter((x) => x !== "vectors") : [...o, "vectors"]) }
        else act.setVal("view3d", arg, !store.d.view3d[arg])
        break
      case "run": setRunning(true); toast("Computing study", { description: "Run 4 continues on FDM GPU." }); setHistory((h) => [{ time: now(), title: "Compute", detail: "Study resumed", id: "run" }, ...h]); break
      case "pause": setRunning(false); toast("Paused at the next step"); break
      case "stop": setRunning(false); toast("Stopped", { description: "Results written so far stay in the session." }); break
      case "apply": {
        const st = stats(SPECS[selRef.current], store.d[selRef.current], store.o[selRef.current])
        if (st.staged && !st.errors) { act.apply(selRef.current); toast(`Applied ${plural(st.staged, "change")}`) } else toast("Nothing to apply in this inspector")
        break
      }
      case "revert": act.revertAll(selRef.current); break
      case "panel": {
        const [name, mode] = rest
        const next = (cur: string | null, on: string) => (mode === "toggle" ? (cur ? null : on) : mode === "on" ? on : null)
        if (name === "Explorer") setLeftTab((c) => next(c, "model"))
        if (name === "Inspector") setRightTab((c) => next(c, "inspector"))
        if (name === "Bottom dock") setDockOpen((c) => (mode === "toggle" ? !c : mode === "on"))
        break
      }
      case "layout": setLeftTab("model"); setRightTab("inspector"); setDockOpen(true); setRibbonOpen(true); setIw(392); toast("Layout reset"); break
      default: toast(a)
    }
  }, [act, select, store.d, store.o])

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setCmdOpen((v) => !v) }
      if (e.key === "F5") { e.preventDefault(); onAction("run") }
    }
    window.addEventListener("keydown", on)
    return () => window.removeEventListener("keydown", on)
  }, [onAction])

  const startDrag = (e: React.PointerEvent) => {
    e.preventDefault()
    const x0 = e.clientX, w0 = iw
    setDrag(true)
    const mv = (ev: PointerEvent) => setIw(Math.round(Math.min(620, Math.max(340, w0 - (ev.clientX - x0)))))
    const up = () => { setDrag(false); window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up) }
    window.addEventListener("pointermove", mv)
    window.addEventListener("pointerup", up)
  }

  const onApplied = useCallback((sp: Spec, n: number) => {
    setHistory((h) => [{ time: now(), title: `Applied ${plural(n, "change")}`, detail: `${sp.title(store.d[sp.id])}, scene revision ${store.rev[sp.id] + 1}`, id: sp.id }, ...h])
  }, [store.d, store.rev])

  const viz = store.d.viz
  const allProps = useMemo(() => Object.values(SPECS).flatMap((sp) => sp.sections.flatMap((sec) => sec.rows.filter((r) => r.k && r.label).map((r) => ({ spec: sp, row: r })))), [])
  const insetLeft = desktop ? 8 + 48 + 8 + (leftTab ? 264 + 8 : 0) : 0
  const insetRight = desktop ? 8 + 48 + 8 + (rightTab ? iw + 8 : 0) : 0
  const railRight = RAIL_RIGHT_BASE.map((r) => (r.id === "history" ? { ...r, badge: history.length > 3 ? history.length - 3 : undefined } : r))
  const leftMeta: Record<string, [string, typeof ListTree]> = { model: ["Model builder", ListTree], results: ["Results", Database], charts: ["Live charts", LineChart], library: ["Material library", Library] }
  const rightMeta: Record<string, [string, typeof History]> = { history: ["History", History], python: ["Python script", Code2] }

  return (
    <div className={cn("min-h-svh px-3 py-8 sm:px-6 lg:px-8", anat && "show-anat")}>
      <div className="mx-auto flex max-w-[1680px] flex-col gap-10">
        <header className="flex flex-col gap-3" lang="pl">
          <Badge variant="outline" className="w-fit rounded-full bg-glass px-3 backdrop-blur">Makieta 3: pełna aplikacja</Badge>
          <h1 className="max-w-[24ch] text-[clamp(28px,3.4vw,44px)] leading-[1.05] font-semibold tracking-[-0.03em] text-balance">Fullmag Control Room w jednej, spójnej stylistyce</h1>
          <p className="max-w-[78ch] text-[15px] leading-relaxed text-muted-foreground">
            Pasek instancji, menu główne, ribbon, listwy ikon po lewej i prawej, panele, dok i pasek statusu zbudowane z tych samych komponentów shadcn/ui i tego samego szkła co Inspector.
            Kliknięcie aktywnej ikony na listwie zwija panel. Spróbuj <Kbd>Ctrl</Kbd> <Kbd>K</Kbd>, <Kbd>F5</Kbd>, menu File albo zakładek ribbonu.
          </p>
        </header>

        <div className={cn("relative isolate flex flex-col overflow-hidden rounded-[28px] ring-1 ring-border lg:h-[1040px]", SHADOW.lg)} lang="en" style={{ "--iw": `${iw}px` } as React.CSSProperties}>
          <div className="relative order-2 h-72 lg:absolute lg:inset-0 lg:order-none lg:h-auto">
            <Viewport viz={viz} obj={store.d.object} view={store.d.view3d} sel={store.sel} insetLeft={insetLeft} insetRight={insetRight} insetTop={desktop ? chromeH : 0} insetBottom={desktop ? dockH + 8 + 32 : 0} theme={resolved} fitNonce={fit} />
            <Button variant="outline" size="sm" className="absolute top-3 right-3 z-10 rounded-full bg-glass backdrop-blur lg:hidden" onClick={() => setTreeSheet(true)}><ListTree data-icon="inline-start" />Model</Button>
          </div>

          <div ref={chromeRef} className="relative z-20 order-1">
            <InstanceTabs onAction={onAction} />
            <AppBar onAction={onAction} running={running} theme={theme} setTheme={(t) => setTheme(t as "light" | "dark" | "system")} problems={problems.length} />
            <Ribbon tab={ribbonTab} setTab={setRibbonTab} open={ribbonOpen} setOpen={setRibbonOpen} onAction={onAction} />
          </div>

          <div className="relative z-10 order-3 flex min-h-0 flex-1 gap-2 p-2 max-lg:flex-col">
            <div className="hidden lg:flex">
              <Rail
                side="left"
                items={RAIL_LEFT}
                active={leftTab}
                onChange={setLeftTab}
                footer={<>
                  <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon-sm" className="rounded-xl text-muted-foreground" aria-label="Settings" onClick={() => onAction("toast:Settings")}><Settings /></Button></TooltipTrigger><TooltipContent side="right">Settings</TooltipContent></Tooltip>
                  <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon-sm" className="rounded-xl text-muted-foreground" aria-label="Help" onClick={() => onAction("toast:Docs")}><HelpCircle /></Button></TooltipTrigger><TooltipContent side="right">Help</TooltipContent></Tooltip>
                </>}
              />
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <div className="flex min-h-0 flex-1 gap-2 max-lg:flex-col">
                {leftTab ? (
                  <div key={leftTab} className="hidden w-[264px] shrink-0 lg:block">
                    <PanelShell
                      title={leftMeta[leftTab][0]}
                      icon={leftMeta[leftTab][1]}
                      actions={<Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon-xs" className="rounded-full text-muted-foreground" aria-label="Collapse panel" onClick={() => setLeftTab(null)}><PanelLeft /></Button></TooltipTrigger><TooltipContent>Collapse panel</TooltipContent></Tooltip>}
                    >
                      {leftTab === "model" ? (
                        <>
                          <PanelSearch value={treeFilter} onChange={setTreeFilter} placeholder="Filter nodes" />
                          <ModelTree store={store} filter={treeFilter} onSelect={select} onCopy={(id) => { navigator.clipboard?.writeText(SPECS[id].idv).catch(() => {}); toast("Copied node ID", { description: SPECS[id].idv }) }} />
                        </>
                      ) : leftTab === "results" ? (
                        <ResultsPanel onOpen={(m) => toast(m)} />
                      ) : leftTab === "charts" ? (
                        <ChartsPanel onOpen={() => onAction("dock:chart")} />
                      ) : (
                        <LibraryPanel onPick={(name, inModel) => (inModel ? select("material") : toast(`${name} is in the library`, { description: "Open Magnetic parameters and use Load from library to assign it." }))} />
                      )}
                    </PanelShell>
                  </div>
                ) : null}

                <div className="@container/vp relative hidden min-w-0 flex-1 lg:block">
                  <div className="absolute inset-0">
                    <Badge variant="outline" className="absolute bottom-1 left-1 rounded-full bg-glass text-muted-foreground backdrop-blur">Illustrative preview</Badge>
                    <div className="absolute inset-x-0 top-0 flex justify-center">
                      <div className={cn("flex h-11 items-center gap-1 rounded-full px-1.5 glass glass-hi", SHADOW.md)}>
                        <ToggleGroup type="single" value={viz.render} onValueChange={(v) => v && act.setVal("viz", "render", v)} spacing={1} aria-label="Render mode" className="hidden @[30rem]/vp:flex">
                          {([["Shaded", Box], ["Shaded + wire", Boxes], ["Wireframe", Square], ["Points", CircleDot], ["Off", EyeOff]] as const).map(([v, Icon]) => (
                            <Tooltip key={v}>
                              <TooltipTrigger asChild>
                                <ToggleGroupItem value={v} aria-label={v} size="sm" className="rounded-full data-[state=on]:bg-raised data-[state=on]:text-[var(--h-visualization)] data-[state=on]:shadow-[0px_2px_3px_-1px_rgba(0,0,0,0.1),0px_1px_0px_0px_rgba(25,28,33,0.02),0px_0px_0px_1px_rgba(25,28,33,0.08)] dark:data-[state=on]:shadow-none"><Icon /></ToggleGroupItem>
                              </TooltipTrigger>
                              <TooltipContent>{v}</TooltipContent>
                            </Tooltip>
                          ))}
                        </ToggleGroup>
                        <Separator orientation="vertical" className="mx-1 hidden h-5! @[30rem]/vp:block" />
                        <Segmented size="sm" className="w-[88px]" value={viz.view} onValueChange={(v) => act.setVal("viz", "view", v)} aria-label="Projection" options={[{ value: "3D", label: "3D" }, { value: "2D", label: "2D" }]} />
                        <Tooltip><TooltipTrigger asChild><Toggle size="sm" className="rounded-full" aria-label="Vector glyphs" pressed={viz.overlays.includes("vectors")} onPressedChange={() => onAction("toggle:vectors")}><ArrowUpRight /></Toggle></TooltipTrigger><TooltipContent>Vector glyphs</TooltipContent></Tooltip>
                        <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon-sm" className="rounded-full" aria-label="Fit view" onClick={() => setFit((n) => n + 1)}><Crosshair /></Button></TooltipTrigger><TooltipContent>Fit view</TooltipContent></Tooltip>
                        <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon-sm" className="rounded-full" aria-label="3D View settings" onClick={() => setRightTab("view3d")}><Monitor /></Button></TooltipTrigger><TooltipContent>3D View settings</TooltipContent></Tooltip>
                      </div>
                    </div>
                  </div>
                </div>
                {rightTab ? (
                  <div className="relative h-[780px] shrink-0 lg:h-auto lg:w-[var(--iw)]" style={{ viewTransitionName: "inspector" }}>
                    <div
                      role="separator"
                      aria-orientation="vertical"
                      aria-label="Resize right panel"
                      aria-valuenow={iw}
                      tabIndex={0}
                      onPointerDown={startDrag}
                      onKeyDown={(e) => { if (e.key === "ArrowLeft") setIw((w) => Math.min(620, w + 20)); if (e.key === "ArrowRight") setIw((w) => Math.max(340, w - 20)) }}
                      className="group/handle absolute top-1/2 -left-2.5 z-20 hidden h-24 w-3 -translate-y-1/2 cursor-col-resize items-center justify-center outline-none lg:flex"
                    >
                      <span className={cn("h-10 w-1 rounded-full bg-foreground/20 transition-all group-hover/handle:h-16 group-hover/handle:bg-primary group-focus-visible/handle:bg-primary", drag && "h-16 bg-primary")} />
                      {drag ? <span className="absolute right-4 rounded-full bg-foreground px-2 py-0.5 text-[11px] text-background tabular-nums">{iw}px</span> : null}
                    </div>
                    {rightTab === "inspector" || rightTab === "view3d" ? (
                      <InspectorTemplate
                        key={rightTab}
                        spec={rightTab === "view3d" ? SPECS.view3d : spec}
                        store={store}
                        act={act}
                        api={api}
                        onFit={() => setFit((n) => n + 1)}
                        onCompare={() => setCompare(true)}
                        onApplied={onApplied}
                        className="animate-rise"
                      />
                    ) : (
                      <PanelShell title={rightMeta[rightTab][0]} icon={rightMeta[rightTab][1]}>
                        {rightTab === "history" ? (
                          <HistoryPanel entries={history} onOpen={(id) => select(id)} />
                        ) : (
                          <PythonPanel title={spec.title(store.d[spec.id])} code={pythonFor(spec, store.d[spec.id])} onCopy={() => { navigator.clipboard?.writeText(pythonFor(spec, store.d[spec.id])).catch(() => {}); toast("Copied script") }} />
                        )}
                      </PanelShell>
                    )}
                  </div>
                ) : null}

              </div>
                <div ref={dockRef}>
                  <Dock tab={dockTab} setTab={setDockTab} open={dockOpen} setOpen={setDockOpen} problems={problems} history={history} running={running} onOpen={(t) => select(t)} />
                </div>
            </div>
            <div className="hidden lg:flex">
              <Rail side="right" items={railRight} active={rightTab} onChange={setRightTab} />
            </div>
          </div>
          <div className="relative z-20 order-4">
            <StatusBar running={running} problems={problems.length} onAction={onAction} sel={spec.title(store.d[spec.id])} />
          </div>

        </div>

        <div className="flex flex-wrap items-center gap-2" lang="pl">
          <Button variant="outline" size="sm" className="rounded-full" onClick={() => setCompare(true)}><Columns2 data-icon="inline-start" />Porównaj z obecnym inspektorem</Button>
          <Toggle variant="outline" size="sm" className="rounded-full" pressed={anat} onPressedChange={setAnat}><Target data-icon="inline-start" />Pokaż anatomię szablonu</Toggle>
        </div>

        <Docs />
      </div>

      <CommandDialog open={cmdOpen} onOpenChange={setCmdOpen} title="Search Fullmag" description="Jump to a node, a property or an action" className={cn("rounded-3xl! glass sm:max-w-xl", SHADOW.lg)}>
        <Command className="bg-transparent">
          <CommandInput placeholder="Search nodes, properties and actions" />
          <CommandList className="max-h-[420px]">
            <CommandEmpty>No result. Try a symbol name such as damping.</CommandEmpty>
            <CommandGroup heading="Inspectors">
              {Object.values(SPECS).map((sp) => (
                <CommandItem key={sp.id} value={`${sp.title(store.d[sp.id])} ${sp.kind}`} onSelect={() => { if (sp.id === "view3d") setRightTab("view3d"); else select(sp.id); setCmdOpen(false) }} className="rounded-xl">
                  <sp.icon style={{ color: `var(--h-${sp.domain})` }} />
                  <span>{sp.title(store.d[sp.id])}</span>
                  <span className="text-xs text-muted-foreground">{sp.kind}</span>
                  {store.sel === sp.id ? <Check className="ml-auto" /> : null}
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandSeparator />
            <CommandGroup heading="Properties">
              {allProps.map(({ spec: sp, row }) => (
                <CommandItem key={`${sp.id}.${row.k}`} value={`${row.label} ${sp.title(store.d[sp.id])} ${sp.id}.${row.k}`} onSelect={() => { act.focus(sp.id, row.k!); setRightTab(sp.id === "view3d" ? "view3d" : "inspector"); setCmdOpen(false) }} className="rounded-xl">
                  <SlidersHorizontal className="text-muted-foreground" />
                  <span>{row.label}</span>
                  <span className="truncate text-xs text-muted-foreground">{sp.title(store.d[sp.id])}</span>
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandSeparator />
            <CommandGroup heading="Actions">
              <CommandItem className="rounded-xl" onSelect={() => { onAction("run"); setCmdOpen(false) }}><Play />Compute study<CommandShortcut>F5</CommandShortcut></CommandItem>
              <CommandItem className="rounded-xl" onSelect={() => { setTheme(resolved === "dark" ? "light" : "dark"); setCmdOpen(false) }}>{resolved === "dark" ? <Sun /> : <Moon />}Switch to {resolved === "dark" ? "light" : "dark"} theme<CommandShortcut>D</CommandShortcut></CommandItem>
              <CommandItem className="rounded-xl" onSelect={() => { setCompare(true); setCmdOpen(false) }}><Columns2 />Compare with the current inspector</CommandItem>
              <CommandItem className="rounded-xl" onSelect={() => { onAction("layout:reset"); setCmdOpen(false) }}><Target />Reset layout</CommandItem>
            </CommandGroup>
          </CommandList>
          <div className="flex items-center gap-3 border-t px-3 py-2 text-[11px] text-muted-foreground">
            <span className="flex items-center gap-1"><Kbd>↑</Kbd><Kbd>↓</Kbd> move</span>
            <span className="flex items-center gap-1"><Kbd>↵</Kbd> open</span>
            <span className="ml-auto flex items-center gap-1"><CommandIcon className="size-3" /> Fullmag Control Room</span>
          </div>
        </Command>
      </CommandDialog>

      <Sheet open={compare} onOpenChange={setCompare}>
        <SheetContent side="left" className={cn("w-[min(440px,92vw)] gap-0 rounded-r-3xl glass sm:max-w-none", SHADOW.lg)}>
          <SheetHeader>
            <SheetTitle lang="pl">Obecny inspektor</SheetTitle>
            <SheetDescription lang="pl">Zrzut z działającej grupy fullmag-master dla węzła „{spec.title(store.d[spec.id])}”.</SheetDescription>
          </SheetHeader>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
            {spec.before ? (
              <img src={spec.before} alt={`Current inspector for ${spec.title(store.d[spec.id])}`} className={cn("w-full rounded-2xl", SHADOW.md)} />
            ) : (
              <Empty className="border-0" lang="pl">
                <EmptyHeader>
                  <EmptyMedia variant="icon"><Eye /></EmptyMedia>
                  <EmptyTitle>Brak zrzutu dla tego węzła</EmptyTitle>
                  <EmptyDescription>Zrzuty są dla obiektu, materiału, wizualizacji, momentu SOT, pola zewnętrznego, Airboxa i etapu Relax 2.</EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
          </div>
        </SheetContent>
      </Sheet>

      <Sheet open={treeSheet} onOpenChange={setTreeSheet}>
        <SheetContent side="left" className="w-[280px] glass">
          <SheetHeader><SheetTitle>Model</SheetTitle><SheetDescription>Pick a node to inspect.</SheetDescription></SheetHeader>
          <div className="overflow-y-auto px-2 pb-4">
            <ModelTree store={store} filter="" onSelect={(id) => { select(id); setTreeSheet(false) }} onCopy={() => {}} />
          </div>
        </SheetContent>
      </Sheet>

      <Dialog open={!!json} onOpenChange={(v) => !v && setJson(null)}>
        <DialogContent className={cn("rounded-3xl glass sm:max-w-lg", SHADOW.lg)}>
          <DialogHeader>
            <DialogTitle>{json?.title}</DialogTitle>
            <DialogDescription>Read-only. Edit the fields in the inspector; this view follows them.</DialogDescription>
          </DialogHeader>
          <pre className="max-h-[360px] overflow-auto rounded-2xl bg-field p-4 font-mono text-xs leading-relaxed text-foreground/85 ring-1 ring-border ring-inset">{json?.body}</pre>
          <div className="flex justify-end">
            <Button size="sm" className="rounded-full" onClick={() => { navigator.clipboard?.writeText(json?.body ?? "").catch(() => {}); toast("Copied to clipboard") }}><Copy data-icon="inline-start" />Copy</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

const SHELL: [string, string][] = [
  ["Pasek instancji", "Home i karty sesji z kropką stanu; nowa sesja z szablonu lub skryptu."],
  ["Pasek aplikacji", "Logo, menu File/Edit/View/Simulation/Tools/Help z pozycjami z Control Room, zapis, cofnij, wyszukiwarka Ctrl+K, status API, Compute/Pause/Stop/Skip, motyw, licznik problemów."],
  ["Ribbon", "Osiem zakładek z grupami jak w Control Room. Przyciski otwierają właściwe inspektory i pola. Zwija się do samych zakładek."],
  ["Listwy ikon", "Lewa: Model builder, Results, Live charts, Material library. Prawa: Inspector, 3D View, History, Python. Kliknięcie aktywnej ikony zwija panel."],
  ["Dok", "Telemetry, Problems (z walidacji etapów), Logs, Operations (z historią zatwierdzeń), Engine, Quick chart. Zwijany."],
  ["Pasek statusu", "Stan obliczeń, sesja, wersja, rewizja siatki, zaznaczenie, problemy, połączenie, cel FDM GPU double, Compute."],
]
const ANATOMY: [string, string, string][] = [
  ["Ścieżka i akcje", "Breadcrumb, wyszukiwanie pola, dopasowanie widoku, menu akcji.", "Breadcrumb, Tooltip, DropdownMenu"],
  ["Tożsamość", "Ikona w kolorze domeny, nazwa, rodzaj, ID do skopiowania, jedna pigułka stanu.", "Badge"],
  ["Fakty", "Do czterech kluczowych wartości. Chowają się przy przewijaniu.", "dl na tokenach"],
  ["Karty", "Tylko gdy obiekt ma tryby.", "Tabs"],
  ["Komunikaty", "Ton, tytuł, opis i szybka naprawa albo skok do pola.", "Alert, Button"],
  ["Sekcja", "Zwijana karta szkła z podsumowaniem i kropką zmiany.", "Collapsible, Empty"],
  ["Wiersz właściwości", "Etykieta, symbol z definicją, pole z jednostką, cofnięcie, błąd.", "Field, InputGroup, Select, Segmented, Slider, Switch, ToggleGroup, HoverCard, ContextMenu"],
  ["Pasek zmian", "Revert i Apply z licznikiem, Ctrl+Enter, potwierdzenia.", "Button, Kbd, Spinner, AlertDialog, Sonner"],
]

function Docs() {
  return (
    <div className="flex flex-col gap-8" lang="pl">
      <section className="flex flex-col gap-4" aria-labelledby="h-shell">
        <h2 id="h-shell" className="text-2xl font-semibold tracking-tight">Powłoka aplikacji</h2>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {SHELL.map(([t, d]) => (
            <Card key={t} className={cn("gap-1.5 rounded-3xl py-4 glass glass-hi", SHADOW.sm)}>
              <CardHeader className="px-4"><CardTitle className="text-[15px]">{t}</CardTitle><CardDescription className="text-[13px] leading-relaxed">{d}</CardDescription></CardHeader>
            </Card>
          ))}
        </div>
      </section>
      <section className="flex flex-col gap-4" aria-labelledby="h-anat">
        <h2 id="h-anat" className="text-2xl font-semibold tracking-tight">Anatomia inspektora</h2>
        <ol className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {ANATOMY.map(([t, d, c], i) => (
            <li key={t}>
              <Card className={cn("h-full gap-2 rounded-3xl py-4 glass glass-hi", SHADOW.sm)}>
                <CardHeader className="px-4">
                  <CardTitle className="flex items-center gap-2 text-[15px]"><span className="grid size-6 place-items-center rounded-full bg-[#ea76cb] text-[11px] font-bold text-white">{i + 1}</span>{t}</CardTitle>
                  <CardDescription className="text-[13px] leading-relaxed">{d}</CardDescription>
                </CardHeader>
                <CardContent className="mt-auto px-4"><p className="font-mono text-[11px] text-foreground/60">{c}</p></CardContent>
              </Card>
            </li>
          ))}
        </ol>
      </section>
      <section className="flex flex-col gap-4" aria-labelledby="h-impl">
        <h2 id="h-impl" className="text-2xl font-semibold tracking-tight">Co jest prawdziwe, a co przykładowe</h2>
        <div className={cn("overflow-x-auto rounded-3xl glass glass-hi", SHADOW.sm)}>
          <Table className="min-w-[640px]">
            <TableHeader><TableRow className="hover:bg-transparent"><TableHead className="px-5">Z działającej sesji i kodu</TableHead><TableHead className="px-5">Przykładowe w makiecie</TableHead></TableRow></TableHeader>
            <TableBody>
              <TableRow>
                <TableCell className="w-1/2 px-5 py-3 align-top whitespace-normal">Menu główne i grupy ribbonu (z appMenuModel i ribbonTabViews), Mₛ 521 kA/m, A_ex 1.5 × 10⁻¹¹ J/m, α 0.045, J 2.6 × 10¹⁰ A/m², ξ_DL −0.21, siatka 512 × 256 × 1, komórka 3.125 nm, LLG + RK23, czas 7.65 ns, ⟨mx⟩ 0.0411, ⟨my⟩ 0.999, lista etapów, błędy Relax 2.</TableCell>
                <TableCell className="px-5 py-3 align-top whitespace-normal text-muted-foreground">Pole zewnętrzne, monitor płaski, biblioteka materiałów, tolerancje, czas trwania Run 4, część telemetrii (tempo, krok, dt, energie), logi, zasoby GPU, wyniki, wykresy i podgląd ściany domenowej.</TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>
      </section>
    </div>
  )
}

export default App
