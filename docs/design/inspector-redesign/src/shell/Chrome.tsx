import { useState, type ComponentType } from "react"
import {
  Atom, BookOpen, Box, Braces, Check, ChevronUp, Command as CommandIcon, Cpu, Cylinder, Database, Download, Eye, FileCode2,
  FilePlus2, FileText, Gauge, Grid3x3, HelpCircle, Home, Layers3, LayoutDashboard, LineChart, Magnet, Menu, Monitor, Moon,
  Move3d, Orbit, Pause, Play, Radar, Redo2, RotateCcw, Rotate3d, Save, Scan, ScanSearch,
  Search, SkipForward, Sparkles, Square, SquareDashed, Sun, TerminalSquare, Timer, Undo2, Upload, Waves, X, Zap,
  Activity, Camera, Combine, Ruler, Shapes, Table2, Workflow, Columns2, Target, Plus, Compass, ListChecks,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ButtonGroup } from "@/components/ui/button-group"
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Kbd } from "@/components/ui/kbd"
import {
  Menubar, MenubarCheckboxItem, MenubarContent, MenubarGroup, MenubarItem, MenubarMenu, MenubarSeparator, MenubarShortcut,
  MenubarSub, MenubarSubContent, MenubarSubTrigger, MenubarTrigger,
} from "@/components/ui/menubar"
import { Segmented } from "@/components/ui/segmented"
import { Separator } from "@/components/ui/separator"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { SHADOW } from "@/lib/format"
import { cn } from "@/lib/utils"

type Icon = ComponentType<{ className?: string }>
export type ShellAction = (id: string) => void

/* ---------- Instance tabs ---------- */
export function InstanceTabs({ onAction }: { onAction: ShellAction }) {
  return (
    <div className="flex h-9 items-end gap-1 border-b border-glass-line bg-[color-mix(in_oklab,var(--glass-strong)_70%,transparent)] px-2 backdrop-blur-xl">
      <button type="button" onClick={() => onAction("toast:Home shows recent sessions and templates")} className="flex h-7 items-center gap-1.5 rounded-t-lg px-3 text-xs text-muted-foreground hover:text-foreground">
        <Home className="size-3.5" />Home
      </button>
      <div className="relative flex h-8 items-center gap-2 rounded-t-xl bg-glass px-3 text-xs font-medium ring-1 ring-glass-line">
        <span className="size-1.5 animate-pulse-dot rounded-full bg-live" />
        <span className="font-mono text-[11px]">fdm_stt_pma_pulse</span>
        <button type="button" aria-label="Close session tab" className="grid size-4 place-items-center rounded-full text-muted-foreground hover:bg-foreground/10 hover:text-foreground" onClick={() => onAction("toast:Closing a running session asks first")}>
          <X className="size-3" />
        </button>
        <span className="absolute inset-x-3 -bottom-px h-0.5 rounded-full bg-primary" />
      </div>
      <Tooltip>
        <TooltipTrigger asChild>
          <button type="button" aria-label="New session" className="mb-1 grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-foreground/10 hover:text-foreground" onClick={() => onAction("toast:New session starts from a template or a script")}>
            <Plus className="size-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent>New session</TooltipContent>
      </Tooltip>
    </div>
  )
}

/* ---------- App bar with main menu ---------- */
const MENU: { label: string; items: ([string, Icon, string?, string?] | "-" | { sub: string; items: [string, string][] } | { radio: string; items: string[]; value: string })[] }[] = [
  { label: "File", items: [
    ["New Problem", FilePlus2, "Ctrl+N"], ["New Project", FilePlus2, "Ctrl+Shift+N"], ["Open Project", Upload, "Ctrl+O"], ["Restore Runtime State", Upload, "Ctrl+Shift+O"], "-",
    ["Save Project", Save, "Ctrl+S"], ["Save canonical copy as…", FileCode2], { sub: "Export", items: [["3D model…", "toast:Export 3D model"], ["Figure…", "toast:Export figure"]] }, "-",
    ["Close Project", X, "Ctrl+W"],
  ] },
  { label: "Edit", items: [
    ["Apply Inspector Changes", Check, "Ctrl+Shift+Enter", "apply"], ["Reset Inspector Changes", RotateCcw, undefined, "revert"], "-",
    ["Undo", Undo2, "Ctrl+Z"], ["Redo", Redo2, "Ctrl+Y"], "-", ["Command Palette", CommandIcon, "Ctrl+K", "palette"],
  ] },
  { label: "View", items: [
    ["3D Workspace", Box, "1", "view:3D"], ["2D Slice Workspace", LayoutDashboard, "2", "view:2D"], "-",
    { radio: "Panels", items: ["Explorer", "Inspector", "Bottom dock"], value: "" },
    ["Visualization Settings", Eye, undefined, "select:viz"], ["3D View Settings", Monitor, undefined, "right:view3d"],
  ] },
  { label: "Simulation", items: [
    ["Prepare Live Study", Layers3], ["Compute Study", Play, "F5", "run"], ["Pause", Pause, undefined, "pause"], ["Stop", Square, undefined, "stop"], ["Skip Stage", SkipForward], "-",
    { sub: "Execution Target", items: [["FDM CPU", "toast:Target FDM CPU"], ["FDM GPU", "toast:Target FDM GPU"], ["FEM CPU", "toast:Target FEM CPU"], ["FEM GPU", "toast:Target FEM GPU"]] },
  ] },
  { label: "Tools", items: [
    ["Material database", BookOpen, undefined, "left:library"], ["Data Preview", Database, undefined, "left:results"], ["Diagnostic Recorder", Cpu], ["Solver Profiler", Timer], "-",
    ["Diagnostics", Gauge, undefined, "dock:engine"], ["API Console", TerminalSquare, undefined, "dock:logs"], ["Script View", Braces, undefined, "right:python"], ["Visualization Registry", ListChecks],
  ] },
  { label: "Help", items: [["Search Docs", Search], ["Reference", BookOpen], ["About", HelpCircle]] },
]

export function AppBar({ onAction, running, theme, setTheme, problems }: {
  onAction: ShellAction; running: boolean; theme: string; setTheme: (t: string) => void; problems: number
}) {
  const [panels, setPanels] = useState({ Explorer: true, Inspector: true, "Bottom dock": true } as Record<string, boolean>)
  return (
    <div className="flex h-12 items-center gap-2 border-b border-glass-line bg-glass px-2 backdrop-blur-xl">
      <div className="flex items-center gap-2 pr-1">
        <span className="grid size-8 place-items-center rounded-xl text-white shadow-[inset_0_1px_0_rgba(255,255,255,.35)]" style={{ background: "linear-gradient(140deg, var(--h-geometry), var(--h-material))" }}>
          <Atom className="size-4" />
        </span>
        <div className="flex flex-col leading-tight max-sm:hidden">
          <span className="text-[13px] font-semibold">Fullmag</span>
          <span className="text-[10.5px] text-muted-foreground">Control Room</span>
        </div>
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" className="rounded-full xl:hidden" aria-label="Main menu"><Menu /></Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className={cn("w-56 rounded-2xl", SHADOW.md)} align="start">
          {MENU.map((m) => (
            <DropdownMenuGroup key={m.label}>
              <DropdownMenuLabel className="text-xs text-muted-foreground">{m.label}</DropdownMenuLabel>
              {m.items.filter((i): i is [string, Icon, string?, string?] => Array.isArray(i)).slice(0, 4).map(([l, I, , act]) => (
                <DropdownMenuItem key={l} className="rounded-lg" onSelect={() => onAction(act ?? `toast:${l}`)}><I />{l}</DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <Menubar className="h-8 gap-0.5 border-0 bg-transparent p-0 shadow-none max-xl:hidden">
        {MENU.map((m) => (
          <MenubarMenu key={m.label}>
            <MenubarTrigger className="rounded-full px-3 text-[13px] font-normal data-[state=open]:bg-foreground/[.07]">{m.label}</MenubarTrigger>
            <MenubarContent className={cn("min-w-60 rounded-2xl p-1.5", SHADOW.md)}>
              {m.items.map((it, i) => {
                if (it === "-") return <MenubarSeparator key={i} />
                if ("sub" in it) {
                  return (
                    <MenubarSub key={i}>
                      <MenubarSubTrigger className="rounded-lg">{it.sub}</MenubarSubTrigger>
                      <MenubarSubContent className={cn("rounded-xl", SHADOW.md)}>
                        {it.items.map(([l, a]) => <MenubarItem key={l} className="rounded-lg" onSelect={() => onAction(a)}>{l}</MenubarItem>)}
                      </MenubarSubContent>
                    </MenubarSub>
                  )
                }
                if ("radio" in it) {
                  return (
                    <MenubarGroup key={i}>
                      {it.items.map((p) => (
                        <MenubarCheckboxItem key={p} className="rounded-lg" checked={panels[p]} onCheckedChange={(v) => { setPanels((s) => ({ ...s, [p]: !!v })); onAction(`panel:${p}:${v ? "on" : "off"}`) }}>{p}</MenubarCheckboxItem>
                      ))}
                      <MenubarSeparator />
                    </MenubarGroup>
                  )
                }
                const [l, I, sc, act] = it
                return (
                  <MenubarItem key={l} className="rounded-lg" onSelect={() => onAction(act ?? `toast:${l}`)}>
                    <I />{l}{sc ? <MenubarShortcut>{sc}</MenubarShortcut> : null}
                  </MenubarItem>
                )
              })}
            </MenubarContent>
          </MenubarMenu>
        ))}
      </Menubar>
      <Separator orientation="vertical" className="mx-1 h-5! max-xl:hidden" />
      <div className="flex items-center gap-0.5 max-md:hidden">
        {([["Save Project", Save, "toast:Saved project"], ["Undo", Undo2, "toast:Undo"], ["Redo", Redo2, "toast:Redo"]] as const).map(([l, I, a]) => (
          <Tooltip key={l}>
            <TooltipTrigger asChild><Button variant="ghost" size="icon-sm" className="rounded-full text-muted-foreground" aria-label={l} onClick={() => onAction(a)}><I /></Button></TooltipTrigger>
            <TooltipContent>{l}</TooltipContent>
          </Tooltip>
        ))}
      </div>
      <button
        type="button"
        onClick={() => onAction("palette")}
        className={cn("mx-auto flex h-8 min-w-0 items-center gap-2 rounded-full bg-field px-3 text-[13px] text-muted-foreground ring-1 ring-border ring-inset transition-colors hover:text-foreground sm:w-[300px]")}
      >
        <Search className="size-3.5 shrink-0" />
        <span className="truncate max-sm:hidden">Search nodes, properties, actions</span>
        <span className="ml-auto flex gap-1 max-sm:hidden"><Kbd>Ctrl</Kbd><Kbd>K</Kbd></span>
      </button>
      <Badge className="h-7 gap-1.5 rounded-full bg-[color-mix(in_oklab,var(--ok)_12%,transparent)] px-2.5 text-ok ring-1 ring-[color-mix(in_oklab,var(--ok)_28%,transparent)] ring-inset max-lg:hidden">
        <span className="size-1.5 rounded-full bg-current" />Local API
      </Badge>
      <ButtonGroup className="rounded-full max-sm:hidden">
        <Button size="sm" className="rounded-l-full pl-2.5" onClick={() => onAction(running ? "toast:Run 4 is already computing" : "run")}>
          <Play data-icon="inline-start" className="fill-current" />{running ? "Computing" : "Compute"}
          <Kbd className="ml-0.5 h-5 rounded-full bg-primary-foreground/15 px-1.5 text-[10px] text-primary-foreground">F5</Kbd>
        </Button>
        <Button size="icon-sm" variant="outline" aria-label="Pause" onClick={() => onAction("pause")} disabled={!running}><Pause className="fill-current" /></Button>
        <Button size="icon-sm" variant="outline" aria-label="Stop" onClick={() => onAction("stop")} disabled={!running}><Square className="fill-current" /></Button>
        <Button size="icon-sm" variant="outline" className="rounded-r-full" aria-label="Skip stage" onClick={() => onAction("toast:Skipped to the next stage")} disabled={!running}><SkipForward /></Button>
      </ButtonGroup>
      <Segmented
        size="sm"
        className="w-[96px] max-md:hidden"
        value={theme}
        onValueChange={setTheme}
        aria-label="Theme"
        options={[{ value: "light", label: <Sun />, title: "Light" }, { value: "system", label: <Monitor />, title: "System" }, { value: "dark", label: <Moon />, title: "Dark" }]}
      />
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon-sm" className="relative rounded-full text-muted-foreground" aria-label={`${problems} problems`} onClick={() => onAction("dock:problems")}>
            <Activity />
            {problems ? <span className="absolute top-0.5 right-0.5 grid size-3.5 place-items-center rounded-full bg-destructive text-[9px] font-bold text-white">{problems}</span> : null}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{problems} problems</TooltipContent>
      </Tooltip>
    </div>
  )
}

/* ---------- Ribbon ---------- */
type RB = { label: string; icon: Icon; act: string; hue?: string; menu?: [string, string][] }
type RG = { title: string; sub: string; items: RB[] }
const H = (d: string) => `var(--h-${d})`
export const RIBBON: Record<string, RG[]> = {
  Workspace: [
    { title: "Project", sub: "files", items: [
      { label: "Open", icon: FileText, act: "toast:Open project", hue: H("geometry"), menu: [["New problem", "toast:New problem"], ["Open project", "toast:Open project"], ["Open example", "toast:Open example"], ["Recent sessions", "toast:Recent sessions"]] },
      { label: "Save Field", icon: Save, act: "toast:Saved field state", hue: H("geometry") },
      { label: "Load Field", icon: Upload, act: "toast:Load field state", hue: H("material") },
    ] },
    { title: "Workspace", sub: "layout", items: [
      { label: "Rotation", icon: Rotate3d, act: "right:view3d", hue: H("visualization"), menu: [["Free camera", "toast:Free camera"], ["Object orbit", "toast:Object orbit"]] },
      { label: "Panels", icon: Columns2, act: "toast:Panels", hue: H("visualization"), menu: [["Explorer", "panel:Explorer:toggle"], ["Inspector", "panel:Inspector:toggle"], ["Bottom dock", "panel:Bottom dock:toggle"], ["Reset layout", "layout:reset"]] },
      { label: "Focus", icon: Target, act: "fit", hue: H("visualization") },
    ] },
  ],
  View: [
    { title: "Global display", sub: "3D render defaults", items: [
      { label: "Surface", icon: Box, act: "select:viz", hue: H("visualization") },
      { label: "Quantity", icon: Sparkles, act: "focus:viz:quantity", hue: H("visualization") },
      { label: "Vectors", icon: Move3d, act: "toggle:vectors", hue: H("visualization") },
    ] },
    { title: "Orientation", sub: "3D box and HSL", items: [
      { label: "Axes", icon: Compass, act: "toggle:axes", hue: H("mesh") },
      { label: "Grid", icon: Grid3x3, act: "toggle:grid", hue: H("mesh") },
    ] },
    { title: "2D view", sub: "planar monitor", items: [{ label: "Slice", icon: Scan, act: "view:2D", hue: H("definition") }, { label: "Monitor", icon: ScanSearch, act: "select:monitor", hue: H("definition") }] },
    { title: "Snapshot", sub: "output", items: [{ label: "Capture", icon: Camera, act: "toast:Captured the current frame", hue: H("geometry") }, { label: "Export 3D", icon: Download, act: "toast:Export 3D model", hue: H("geometry") }] },
  ],
  Geometry: [
    { title: "Primitives", sub: "add object", items: [
      { label: "Box", icon: Box, act: "toast:Box primitive draft", hue: H("geometry") },
      { label: "Cylinder", icon: Cylinder, act: "toast:Cylinder primitive draft", hue: H("geometry") },
      { label: "Shapes", icon: Shapes, act: "toast:More primitives", hue: H("geometry"), menu: [["Ellipsoid", "toast:Ellipsoid"], ["Disk", "toast:Disk"], ["Import STL…", "toast:Import STL"]] },
    ] },
    { title: "Transform", sub: "selected object", items: [
      { label: "Move", icon: Move3d, act: "focus:object:center", hue: H("geometry") },
      { label: "Size", icon: Ruler, act: "focus:object:size", hue: H("geometry") },
      { label: "Boolean", icon: Combine, act: "toast:Boolean operations", hue: H("geometry") },
    ] },
    { title: "Domain", sub: "universe", items: [{ label: "Airbox", icon: SquareDashed, act: "select:airbox", hue: H("mesh") }] },
  ],
  Materials: [
    { title: "Parameters", sub: "selected object", items: [{ label: "Material", icon: Magnet, act: "select:material", hue: H("material") }, { label: "Library", icon: BookOpen, act: "left:library", hue: H("material") }] },
    { title: "Initial state", sub: "magnetic texture", items: [{ label: "Texture", icon: Orbit, act: "select:texture", hue: H("material") }, { label: "Load", icon: Upload, act: "toast:Load texture from file", hue: H("material") }] },
  ],
  Physics: [
    { title: "Interactions", sub: "energy terms", items: [
      { label: "Exchange", icon: Waves, act: "focus:material:aex", hue: H("physics") },
      { label: "Zeeman", icon: Radar, act: "select:zeeman", hue: H("physics") },
      { label: "More", icon: Atom, act: "toast:Interactions", hue: H("physics"), menu: [["Demagnetization", "toast:Demagnetization"], ["Anisotropy", "toast:Anisotropy"], ["DMI", "toast:DMI"]] },
    ] },
    { title: "Transport", sub: "currents", items: [{ label: "Spin torque", icon: Zap, act: "select:torque", hue: H("physics") }] },
    { title: "Boundary", sub: "edges", items: [{ label: "Absorbing", icon: Waves, act: "focus:material:absorb", hue: H("physics") }] },
  ],
  Mesh: [
    { title: "Realization", sub: "FDM grid", items: [{ label: "Mesh", icon: Grid3x3, act: "select:mesh", hue: H("mesh") }, { label: "Cell size", icon: Ruler, act: "focus:airbox:cell", hue: H("mesh") }] },
    { title: "Inspect", sub: "quality", items: [{ label: "Regions", icon: Table2, act: "select:mesh", hue: H("mesh") }, { label: "Section", icon: Scan, act: "view:2D", hue: H("mesh") }] },
  ],
  Study: [
    { title: "Stages", sub: "pipeline", items: [
      { label: "Relax", icon: Workflow, act: "select:stage", hue: H("study") },
      { label: "Run", icon: Play, act: "select:run", hue: H("study") },
      { label: "Add", icon: Plus, act: "toast:Add stage", hue: H("study"), menu: [["Eigenmodes", "toast:Eigenmodes stage"], ["Hysteresis", "toast:Hysteresis stage"], ["Autosave", "toast:Autosave stage"]] },
    ] },
    { title: "Execution", sub: "compute", items: [
      { label: "Compute", icon: Play, act: "run", hue: H("study") },
      { label: "Target", icon: Cpu, act: "focus:stage:device", hue: H("study"), menu: [["FDM CPU", "toast:FDM CPU"], ["FDM GPU", "toast:FDM GPU"], ["FEM CPU", "toast:FEM CPU"]] },
    ] },
  ],
  Results: [
    { title: "Data", sub: "published", items: [{ label: "Browser", icon: Database, act: "left:results", hue: H("visualization") }, { label: "Charts", icon: LineChart, act: "left:charts", hue: H("visualization") }] },
    { title: "Analysis", sub: "spectra", items: [{ label: "Dispersion", icon: Activity, act: "toast:Dispersion analysis", hue: H("visualization") }, { label: "Resonance", icon: Radar, act: "toast:Resonance analysis", hue: H("visualization") }] },
    { title: "Export", sub: "files", items: [{ label: "Export", icon: Download, act: "toast:Export results", hue: H("visualization") }, { label: "Python", icon: FileCode2, act: "right:python", hue: H("visualization") }] },
  ],
}

function RibbonButton({ b, onAction }: { b: RB; onAction: ShellAction }) {
  const inner = (
    <>
      <span className="grid size-8 place-items-center rounded-xl transition-transform group-hover/rb:-translate-y-px" style={{ color: b.hue, background: `color-mix(in oklab, ${b.hue} 14%, transparent)` }}>
        <b.icon className="size-[18px]" />
      </span>
      <span className="flex items-center gap-0.5 text-[11px] leading-none text-foreground/80">{b.label}{b.menu ? <ChevronUp className="size-2.5 rotate-180 opacity-60" /> : null}</span>
    </>
  )
  const cls = "group/rb flex h-[60px] min-w-14 flex-col items-center justify-center gap-1.5 rounded-xl px-1.5 outline-none hover:bg-foreground/[.06] focus-visible:ring-2 focus-visible:ring-ring/60 data-[state=open]:bg-foreground/[.08]"
  if (!b.menu) return <button type="button" className={cls} onClick={() => onAction(b.act)}>{inner}</button>
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild><button type="button" className={cls}>{inner}</button></DropdownMenuTrigger>
      <DropdownMenuContent className={cn("min-w-44 rounded-xl", SHADOW.md)}>
        <DropdownMenuGroup>
          {b.menu.map(([l, a]) => <DropdownMenuItem key={l} className="rounded-lg" onSelect={() => onAction(a)}>{l}</DropdownMenuItem>)}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function Ribbon({ tab, setTab, open, setOpen, onAction }: { tab: string; setTab: (t: string) => void; open: boolean; setOpen: (v: boolean) => void; onAction: ShellAction }) {
  return (
    <div className="border-b border-glass-line bg-glass backdrop-blur-xl">
      <div className="flex h-9 items-center gap-1 px-2">
        <div role="tablist" aria-label="Ribbon" className="flex min-w-0 items-center gap-0.5 overflow-x-auto [scrollbar-width:none]">
          {Object.keys(RIBBON).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={t === tab}
              onClick={() => { setTab(t); setOpen(true) }}
              className={cn("relative h-7 shrink-0 rounded-full px-3 text-[12.5px] text-muted-foreground transition-colors hover:text-foreground", t === tab && "bg-raised font-medium text-foreground " + SHADOW.sm + " dark:shadow-none")}
            >
              {t}
            </button>
          ))}
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-xs" className="ml-auto rounded-full text-muted-foreground" aria-label={open ? "Collapse ribbon" : "Expand ribbon"} aria-expanded={open} onClick={() => setOpen(!open)}>
              <ChevronUp className={cn("transition-transform", !open && "rotate-180")} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{open ? "Collapse ribbon" : "Expand ribbon"}</TooltipContent>
        </Tooltip>
      </div>
      <div className={cn("grid transition-[grid-template-rows] duration-300 ease-out-soft", open ? "grid-rows-[1fr]" : "grid-rows-[0fr]")}>
        <div className="min-h-0 overflow-hidden">
          <div key={tab} className="flex animate-rise items-stretch gap-1 overflow-x-auto px-2 pb-2 [scrollbar-width:none]">
            {RIBBON[tab].map((g, gi) => (
              <div key={g.title} className="flex shrink-0 items-stretch">
                {gi > 0 ? <Separator orientation="vertical" className="mx-1.5 my-1 h-auto!" /> : null}
                <div className="flex flex-col">
                  <div className="flex items-center gap-0.5">{g.items.map((b) => <RibbonButton key={b.label} b={b} onAction={onAction} />)}</div>
                  <div className="px-1.5 text-[10.5px] leading-none text-muted-foreground"><span className="font-medium text-foreground/70">{g.title}</span> <span>{g.sub}</span></div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

