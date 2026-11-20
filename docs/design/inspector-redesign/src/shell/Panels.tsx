import { useEffect, useMemo, useState, type ComponentType, type ReactNode } from "react"
import {
  AlertCircle, ChevronDown, CircleAlert, Copy, Cpu, Database, FileText, Gauge, History, LineChart, ListTree, Library,
  ScrollText, Search, SlidersHorizontal, Table2, Wifi, Workflow, Code2, Monitor,
  Image as ImageIcon, Clock, Play,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from "@/components/ui/item"
import { Progress } from "@/components/ui/progress"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { TelemetryChart } from "@/inspector/custom"
import { SHADOW, sci, thin } from "@/lib/format"
import { cn } from "@/lib/utils"

type Icon = ComponentType<{ className?: string }>
export interface RailItem { id: string; label: string; icon: Icon; badge?: number; tone?: "err" | "info" }

/* ---------- Icon rail (Photoshop-style). Clicking the open item collapses its panel. ---------- */
export function Rail({ side, items, active, onChange, footer }: {
  side: "left" | "right"; items: RailItem[]; active: string | null; onChange: (id: string | null) => void; footer?: ReactNode
}) {
  return (
    <nav aria-label={side === "left" ? "Model builder panels" : "Inspector panels"} className={cn("flex w-12 shrink-0 flex-col items-center gap-1 rounded-[20px] py-2 glass glass-hi", SHADOW.md)}>
      {items.map((it) => {
        const on = it.id === active
        return (
          <Tooltip key={it.id}>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={it.label}
                aria-pressed={on}
                onClick={() => onChange(on ? null : it.id)}
                className={cn(
                  "relative grid size-9 place-items-center rounded-xl text-muted-foreground transition-all outline-none hover:bg-foreground/[.07] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60",
                  on && "bg-raised text-primary " + SHADOW.sm + " dark:shadow-none dark:ring-1 dark:ring-white/10",
                )}
              >
                <it.icon className="size-[18px]" />
                <span className={cn("absolute top-1.5 h-5 w-[3px] rounded-full bg-primary transition-transform", side === "left" ? "-left-[7px]" : "-right-[7px]", on ? "scale-y-100" : "scale-y-0")} />
                {it.badge ? <span className={cn("absolute -top-0.5 -right-0.5 grid h-4 min-w-4 place-items-center rounded-full px-1 text-[9px] font-bold text-white", it.tone === "err" ? "bg-destructive" : "bg-primary")}>{it.badge}</span> : null}
              </button>
            </TooltipTrigger>
            <TooltipContent side={side === "left" ? "right" : "left"}>{it.label}{on ? " (click to collapse)" : ""}</TooltipContent>
          </Tooltip>
        )
      })}
      {footer ? <div className="mt-auto flex flex-col items-center gap-1">{footer}</div> : null}
    </nav>
  )
}

export function PanelShell({ title, icon: I, actions, children, className }: { title: string; icon: Icon; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section aria-label={title} className={cn("flex h-full min-h-0 flex-col overflow-hidden rounded-[22px] glass glass-hi animate-rise", SHADOW.md, className)}>
      <header className="flex h-12 shrink-0 items-center gap-2 px-4">
        <I className="size-4 text-muted-foreground" />
        <h2 className="text-[13px] font-semibold">{title}</h2>
        <div className="ml-auto flex items-center gap-1">{actions}</div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2 [scrollbar-width:thin]">{children}</div>
    </section>
  )
}

export function PanelSearch({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <InputGroup className="mx-1 mb-2 h-8 w-[calc(100%-0.5rem)] rounded-full bg-field">
      <InputGroupAddon><Search /></InputGroupAddon>
      <InputGroupInput value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />
    </InputGroup>
  )
}

/* ---------- Left panels other than the model tree ---------- */
export function ResultsPanel({ onOpen }: { onOpen: (msg: string) => void }) {
  const rows: [string, string, Icon, string][] = [
    ["Table Autosave 3", "Scalar table, 1 row every 10 ps", Table2, "table"],
    ["m snapshots", "Field frames from Run 4", ImageIcon, "frames"],
    ["mid_plane", "Planar monitor, waits for Run 10", FileText, "monitor"],
    ["Relax 2 state", "Relaxed magnetization, not written yet", Database, "state"],
  ]
  return (
    <ItemGroup className="gap-1.5 px-1">
      {rows.map(([t, d, I]) => (
        <Item key={t} size="sm" asChild className="rounded-2xl bg-foreground/[.025] ring-1 ring-border/70 ring-inset hover:bg-foreground/[.05]">
          <button type="button" onClick={() => onOpen(`Opened ${t} in Data Preview`)}>
            <ItemMedia variant="icon" className="rounded-xl bg-[color-mix(in_oklab,var(--h-visualization)_14%,transparent)] text-[var(--h-visualization)]"><I /></ItemMedia>
            <ItemContent><ItemTitle className="text-[13px]">{t}</ItemTitle><ItemDescription className="text-xs">{d}</ItemDescription></ItemContent>
          </button>
        </Item>
      ))}
      <p className="px-2 pt-2 text-xs text-muted-foreground">Example result list for this mockup.</p>
    </ItemGroup>
  )
}

function Spark({ seed, color }: { seed: number; color: string }) {
  const pts = Array.from({ length: 32 }, (_, i) => {
    const t = i / 31
    const y = 0.5 + 0.38 * Math.exp(-t * 2.2) * Math.sin(t * (9 + seed * 3)) + (seed === 2 ? -0.3 * t : 0)
    return `${(t * 100).toFixed(1)},${(30 - y * 26).toFixed(1)}`
  }).join(" ")
  return (
    <svg viewBox="0 0 100 30" className="h-7 w-16 shrink-0" aria-hidden>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}
export function ChartsPanel({ onOpen }: { onOpen: () => void }) {
  const rows: [string, string, string][] = [["⟨m⟩ versus time", "mx, my, mz", "var(--chart-1)"], ["Energy terms", "Exchange, demag, Zeeman", "var(--chart-4)"], ["Max torque", "Relaxation progress", "var(--chart-3)"]]
  return (
    <ItemGroup className="gap-1.5 px-1">
      {rows.map(([t, d, c], i) => (
        <Item key={t} size="sm" asChild className="rounded-2xl bg-foreground/[.025] ring-1 ring-border/70 ring-inset hover:bg-foreground/[.05]">
          <button type="button" onClick={onOpen}>
            <ItemContent><ItemTitle className="text-[13px]">{t}</ItemTitle><ItemDescription className="text-xs">{d}</ItemDescription></ItemContent>
            <ItemActions><Spark seed={i} color={c} /></ItemActions>
          </button>
        </Item>
      ))}
      <p className="px-2 pt-2 text-xs text-muted-foreground">Sparklines are illustrative.</p>
    </ItemGroup>
  )
}

export const LIB_ROWS: [string, string, boolean][] = [
  ["film material", "Ms 521 kA/m, Aex 15 pJ/m, α 0.045", true],
  ["Permalloy (Ni80Fe20)", "Ms 800 kA/m, Aex 13 pJ/m, α 0.01", false],
  ["YIG", "Ms 140 kA/m, Aex 3.65 pJ/m, α 1e−4", false],
  ["CoFeB", "Ms 1100 kA/m, Aex 15 pJ/m, α 0.004", false],
  ["Cobalt", "Ms 1400 kA/m, Aex 30 pJ/m, α 0.01", false],
]
export function LibraryPanel({ onPick }: { onPick: (name: string, inModel: boolean) => void }) {
  const [q, setQ] = useState("")
  const rows = LIB_ROWS.filter((r) => r[0].toLowerCase().includes(q.toLowerCase()))
  return (
    <div className="flex flex-col">
      <PanelSearch value={q} onChange={setQ} placeholder="Search materials" />
      <ItemGroup className="gap-1.5 px-1">
        {rows.map(([t, d, inModel]) => (
          <Item key={t} size="sm" asChild className="rounded-2xl bg-foreground/[.025] ring-1 ring-border/70 ring-inset hover:bg-foreground/[.05]">
            <button type="button" onClick={() => onPick(t, inModel)}>
              <ItemMedia variant="icon" className="rounded-xl bg-[color-mix(in_oklab,var(--h-material)_14%,transparent)] text-[var(--h-material)]"><Library /></ItemMedia>
              <ItemContent><ItemTitle className="text-[13px]">{t}</ItemTitle><ItemDescription className="text-xs tabular-nums">{d}</ItemDescription></ItemContent>
              {inModel ? <ItemActions><Badge variant="secondary" className="rounded-full">In model</Badge></ItemActions> : null}
            </button>
          </Item>
        ))}
      </ItemGroup>
    </div>
  )
}

/* ---------- Right panels other than the inspector ---------- */
export interface HistoryEntry { time: string; title: string; detail: string; id: string }
export function HistoryPanel({ entries, onOpen }: { entries: HistoryEntry[]; onOpen: (id: string) => void }) {
  return (
    <ol className="relative flex flex-col gap-1 px-2 pt-1">
      <span aria-hidden className="absolute top-3 bottom-3 left-[19px] w-px bg-border" />
      {entries.map((e, i) => (
        <li key={i}>
          <button type="button" onClick={() => onOpen(e.id)} className="relative flex w-full gap-3 rounded-2xl px-1.5 py-2 text-left hover:bg-foreground/[.04]">
            <span className={cn("relative z-10 mt-1 size-2.5 shrink-0 rounded-full ring-4 ring-[var(--glass-strong)]", i === 0 ? "bg-primary" : "bg-muted-foreground/50")} />
            <span className="flex min-w-0 flex-col">
              <span className="text-[13px] font-medium">{e.title}</span>
              <span className="text-xs text-muted-foreground">{e.detail}</span>
              <span className="text-[11px] text-muted-foreground/70 tabular-nums">{e.time}</span>
            </span>
          </button>
        </li>
      ))}
    </ol>
  )
}

export function PythonPanel({ title, code, onCopy }: { title: string; code: string; onCopy: () => void }) {
  return (
    <div className="flex flex-col gap-2 px-2">
      <p className="text-xs text-muted-foreground">Canonical script for <span className="font-medium text-foreground">{title}</span>. It follows the draft as you edit.</p>
      <pre className="overflow-x-auto rounded-2xl bg-field p-3 font-mono text-[11.5px] leading-relaxed text-foreground/85 ring-1 ring-border ring-inset">{code}</pre>
      <Button size="sm" variant="outline" className="self-start rounded-full" onClick={onCopy}><Copy data-icon="inline-start" />Copy script</Button>
    </div>
  )
}

/* ---------- Bottom dock ---------- */
export interface Problem { tone: "err" | "warn"; text: string; node: string; target: string }

export function Dock({ tab, setTab, open, setOpen, problems, history, onOpen, running }: {
  tab: string; setTab: (t: string) => void; open: boolean; setOpen: (v: boolean) => void
  problems: Problem[]; history: HistoryEntry[]; onOpen: (target: string) => void; running: boolean
}) {
  const tabs: [string, string, Icon, number?][] = [
    ["telemetry", "Telemetry", Gauge], ["problems", "Problems", CircleAlert, problems.length], ["logs", "Logs", ScrollText],
    ["operations", "Operations", Workflow, history.length], ["engine", "Engine", Cpu], ["chart", "Quick chart", LineChart],
  ]
  const logs = useMemo(() => [
    ["10:41:02.118", "info", "runtime", "Session fdm_stt_pma_pulse attached to Local API"],
    ["10:41:02.904", "info", "plan", "Execution plan revision 8 accepted, 10 stages"],
    ["10:41:03.250", "warn", "plan", "Relax 2: execution lane is unresolved"],
    ["10:41:05.611", "info", "fdm", "Grid 512 × 256 × 1 ready, 131 072 cells"],
    ["10:41:06.002", "info", "solver", "Run 4 started, LLG + RK23 on GPU (double)"],
    ["10:41:19.774", "info", "io", "Table Autosave 3 wrote row 765"],
  ], [])
  return (
    <section aria-label="Bottom dock" className={cn("flex min-h-0 flex-col overflow-hidden rounded-[22px] glass glass-hi", SHADOW.md)}>
      <div className="flex h-11 shrink-0 items-center gap-2 px-2">
        <Tabs value={tab} onValueChange={(t) => { setTab(t); setOpen(true) }} className="min-w-0">
          <TabsList className="h-8 gap-0.5 overflow-x-auto rounded-full bg-transparent p-0 [scrollbar-width:none]">
            {tabs.map(([v, l, I, n]) => (
              <TabsTrigger key={v} value={v} className="h-8 flex-none rounded-full px-3 text-xs data-active:bg-raised data-active:shadow-[0px_2px_3px_-1px_rgba(0,0,0,0.1),0px_1px_0px_0px_rgba(25,28,33,0.02),0px_0px_0px_1px_rgba(25,28,33,0.08)] dark:data-active:border-transparent dark:data-active:shadow-none">
                <I className="size-3.5" />{l}
                {n ? <Badge className={cn("h-4 min-w-4 rounded-full px-1 text-[10px]", v === "problems" ? "bg-destructive text-white" : "bg-primary/15 text-primary")}>{n}</Badge> : null}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <span className={cn("ml-auto flex shrink-0 items-center gap-1.5 text-xs max-md:hidden", running ? "text-live" : "text-muted-foreground")}>
          <span className={cn("size-1.5 rounded-full bg-current", running && "animate-pulse-dot")} />{running ? "Running, Run 4" : "Idle"}
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" className="rounded-full text-muted-foreground" aria-label={open ? "Collapse dock" : "Expand dock"} aria-expanded={open} onClick={() => setOpen(!open)}>
              <ChevronDown className={cn("transition-transform", !open && "rotate-180")} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{open ? "Collapse dock" : "Expand dock"}</TooltipContent>
        </Tooltip>
      </div>
      <div className={cn("grid transition-[grid-template-rows] duration-300 ease-out-soft", open ? "grid-rows-[1fr]" : "grid-rows-[0fr]")}>
        <div className="min-h-0 overflow-hidden">
          <div key={tab} className="h-[188px] animate-rise overflow-y-auto px-3 pb-3 [scrollbar-width:thin]">
            {tab === "telemetry" ? (
              <TelemetryBoard running={running} />
            ) : tab === "problems" ? (
              problems.length ? (
                <ul className="flex flex-col gap-1">
                  {problems.map((p, i) => (
                    <li key={i}>
                      <button type="button" onClick={() => onOpen(p.target)} className="flex w-full items-start gap-2.5 rounded-xl px-2 py-1.5 text-left hover:bg-foreground/[.05]">
                        <AlertCircle className={cn("mt-0.5 size-4 shrink-0", p.tone === "err" ? "text-err" : "text-warn")} />
                        <span className="min-w-0 flex-1 text-[13px]">{p.text}</span>
                        <Badge variant="outline" className="shrink-0 rounded-full">{p.node}</Badge>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <Empty className="border-0 py-6"><EmptyHeader><EmptyMedia variant="icon"><CircleAlert /></EmptyMedia><EmptyTitle className="text-sm">No problems</EmptyTitle><EmptyDescription>The plan validates for every stage.</EmptyDescription></EmptyHeader></Empty>
              )
            ) : tab === "logs" ? (
              <ul className="flex flex-col font-mono text-[11.5px] leading-relaxed">
                {logs.map(([t, lvl, src, msg]) => (
                  <li key={t} className="flex gap-3 rounded-md px-1.5 hover:bg-foreground/[.04]">
                    <span className="text-muted-foreground tabular-nums">{t}</span>
                    <span className={cn("w-9", lvl === "warn" ? "text-warn" : "text-info")}>{lvl}</span>
                    <span className="w-14 text-muted-foreground">{src}</span>
                    <span className="min-w-0 flex-1 truncate">{msg}</span>
                  </li>
                ))}
              </ul>
            ) : tab === "operations" ? (
              <ul className="flex flex-col gap-1">
                {history.map((h, i) => (
                  <li key={i} className="flex items-center gap-3 rounded-xl px-2 py-1.5 text-[13px] hover:bg-foreground/[.04]">
                    <Clock className="size-3.5 text-muted-foreground" /><span className="font-medium">{h.title}</span><span className="truncate text-muted-foreground">{h.detail}</span><span className="ml-auto text-xs text-muted-foreground tabular-nums">{h.time}</span>
                  </li>
                ))}
              </ul>
            ) : tab === "engine" ? (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {([["GPU whole device", 71, "var(--chart-1)"], ["GPU memory", 38, "var(--chart-2)"], ["CPU per core", 24, "var(--chart-3)"], ["Process memory", 17, "var(--chart-4)"]] as const).map(([l, v, c]) => (
                  <div key={l} className="flex flex-col gap-1.5 rounded-xl bg-field p-3 ring-1 ring-border ring-inset">
                    <div className="flex items-baseline justify-between text-xs"><span className="text-muted-foreground">{l}</span><span className="font-medium tabular-nums">{v}%</span></div>
                    <Progress value={v} className="h-1.5 [&>[data-slot=progress-indicator]]:bg-[var(--c)]" style={{ "--c": c } as React.CSSProperties} />
                  </div>
                ))}
                <p className="col-span-full text-xs text-muted-foreground">Example resource readings.</p>
              </div>
            ) : (
              <div className="max-w-xl"><TelemetryChart /></div>
            )}
          </div>
        </div>
      </div>
    </section>
  )
}

/* ---------- Status bar ---------- */
export function StatusBar({ running, problems, onAction, sel }: { running: boolean; problems: number; onAction: (a: string) => void; sel: string }) {
  const Sep = () => <span className="h-3.5 w-px bg-border" />
  return (
    <footer className="flex h-8 items-center gap-2.5 overflow-x-auto border-t border-glass-line bg-[color-mix(in_oklab,var(--glass-strong)_80%,transparent)] px-3 text-[11.5px] whitespace-nowrap text-muted-foreground backdrop-blur-xl [scrollbar-width:none]">
      <span className={cn("flex items-center gap-1.5 font-medium", running ? "text-live" : "text-foreground/80")}>
        <span className={cn("size-1.5 rounded-full bg-current", running && "animate-pulse-dot")} />{running ? "Running" : "Ready"}
      </span>
      <Sep /><span className="font-mono text-[11px]">fdm_stt_pma_pulse</span>
      <Sep /><span>0.1.0-dev.20261119</span>
      <Sep /><span>Mesh rev 1</span>
      <Sep /><span>Selection: <span className="text-foreground/80">{sel}</span></span>
      <span className="ml-auto" />
      <button type="button" onClick={() => onAction("dock:problems")} className={cn("flex items-center gap-1.5 rounded-full px-2 py-0.5 hover:bg-foreground/[.06]", problems ? "text-err" : "text-ok")}>
        <CircleAlert className="size-3.5" />{problems ? `${problems} problems` : "No problems"}
      </button>
      <Sep /><span className="flex items-center gap-1.5 text-ok"><Wifi className="size-3.5" />Realtime connected</span>
      <Sep /><span className="flex items-center gap-1.5"><Monitor className="size-3.5" />Status ready</span>
      <Sep />
      <Badge variant="outline" className="h-5 rounded-full font-mono text-[10.5px]">FDM GPU double</Badge>
      <Button size="xs" className="h-6 rounded-full" onClick={() => onAction(running ? "toast:Already computing" : "run")}><Play data-icon="inline-start" className="fill-current" />Compute</Button>
    </footer>
  )
}

export const RAIL_LEFT: RailItem[] = [
  { id: "model", label: "Model builder", icon: ListTree },
  { id: "results", label: "Results", icon: Database },
  { id: "charts", label: "Live charts", icon: LineChart },
  { id: "library", label: "Material library", icon: Library },
]
export const RAIL_RIGHT_BASE: RailItem[] = [
  { id: "inspector", label: "Inspector", icon: SlidersHorizontal },
  { id: "view3d", label: "3D View", icon: Monitor },
  { id: "history", label: "History", icon: History },
  { id: "python", label: "Python script", icon: Code2 },
]

/* ---------- Telemetry board: four groups instead of a flat tile grid ---------- */
function Group({ title, children, aside, className }: { title: string; children: ReactNode; aside?: ReactNode; className?: string }) {
  return (
    <section className={cn("@container/g flex min-w-0 flex-col gap-2 rounded-2xl bg-foreground/[.025] p-3 ring-1 ring-border/70 ring-inset", className)}>
      <header className="flex items-center justify-between gap-2">
        <h3 className="text-[11.5px] font-semibold text-muted-foreground">{title}</h3>
        {aside}
      </header>
      {children}
    </section>
  )
}
function Kv({ k, v, u }: { k: ReactNode; v: ReactNode; u?: string }) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-2 text-[12.5px]">
      <span className="shrink-0 text-muted-foreground">{k}</span>
      <span className="min-w-0 truncate text-right font-medium tabular-nums">{v}{u ? <span className="ml-1 text-[11px] font-normal text-muted-foreground">{u}</span> : null}</span>
    </div>
  )
}
function Diverge({ label, v, color }: { label: ReactNode; v: number; color: string }) {
  const w = Math.min(1, Math.abs(v)) * 50
  return (
    <div className="grid grid-cols-[2.6rem_1fr_4.2rem] items-center gap-2 text-[12.5px]">
      <span className="sym text-muted-foreground">{label}</span>
      <span className="relative h-2 rounded-full bg-foreground/[.07]">
        <span className="absolute inset-y-0 left-1/2 w-px bg-foreground/25" />
        <span className="absolute inset-y-0 rounded-full transition-all duration-500" style={{ background: color, width: `${w}%`, left: v >= 0 ? "50%" : `${50 - w}%` }} />
      </span>
      <span className="text-right font-medium tabular-nums">{v.toFixed(4).replace(/^-/, "−")}</span>
    </div>
  )
}
function TorqueSpark({ t }: { t: number }) {
  const pts = Array.from({ length: 48 }, (_, i) => {
    const x = (i / 47) * t
    const y = Math.log10(0.2 * Math.exp(-x / 1.6) + 2e-3 + 4e-4 * Math.sin(x * 9))
    return [i / 47, (y + 3) / 2.5] as const
  })
  const d = pts.map(([x, y], i) => `${i ? "L" : "M"}${(x * 100).toFixed(2)},${(36 - y * 32).toFixed(2)}`).join(" ")
  return (
    <svg viewBox="0 0 100 36" preserveAspectRatio="none" className="h-14 w-full" aria-label="Max torque decreasing over time, illustrative" role="img">
      <defs>
        <linearGradient id="tq" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="var(--chart-3)" stopOpacity=".35" /><stop offset="1" stopColor="var(--chart-3)" stopOpacity="0" /></linearGradient>
      </defs>
      <path d={`${d} L100,36 L0,36 Z`} fill="url(#tq)" />
      <path d={d} fill="none" stroke="var(--chart-3)" strokeWidth="1.6" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  )
}
function EnergySpark({ t }: { t: number }) {
  const pts = Array.from({ length: 48 }, (_, i) => {
    const x = (i / 47) * t
    const y = 0.15 + 0.7 * Math.exp(-x / 2.2) + 0.05 * Math.exp(-x / 3) * Math.sin(x * 7.1)
    return `${i ? "L" : "M"}${((i / 47) * 100).toFixed(2)},${(30 - y * 28).toFixed(2)}`
  }).join(" ")
  return (
    <svg viewBox="0 0 100 30" preserveAspectRatio="none" className="hidden h-10 w-full @[21rem]/g:block" role="img" aria-label="Total energy decreasing over time, illustrative">
      <path d={pts} fill="none" stroke="var(--chart-4)" strokeWidth="1.6" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  )
}
function TelemetryBoard({ running }: { running: boolean }) {
  const [t, setT] = useState(7.653)
  useEffect(() => {
    if (!running || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return
    const id = window.setInterval(() => setT((v) => (v >= 9.99 ? 7.653 : +(v + 0.011).toFixed(3))), 700)
    return () => window.clearInterval(id)
  }, [running])
  const step = Math.round(18204 + (t - 7.653) * 2380)
  const mx = 0.0411 + 0.012 * Math.sin(t * 7.1) * Math.exp(-(t - 7.6) / 4)
  const mz = 0.0012 + 0.006 * Math.cos(t * 7.1) * Math.exp(-(t - 7.6) / 4)
  const my = Math.sqrt(Math.max(0, 1 - mx * mx - mz * mz))
  const energies: [string, number][] = [["Exchange", 4.0e-21], ["Demag", 1.2e-19], ["Zeeman", -4.4e-19], ["Anisotropy", -8.42e-33], ["DMI", 0]]
  const total = energies.reduce((a, [, v]) => a + v, 0)
  return (
    <div className="grid h-full gap-2 sm:grid-cols-2 lg:grid-cols-[1.15fr_1fr_1.35fr_1fr]">
      <Group title="Run" aside={<Badge variant="outline" className="h-5 rounded-full text-[10.5px]">Run 4, stage 4 of 10</Badge>}>
        <div className="flex items-baseline gap-1.5">
          <span className="text-2xl leading-none font-semibold tracking-tight tabular-nums">{t.toFixed(3)}</span>
          <span className="text-xs text-muted-foreground">of 10 ns simulated</span>
        </div>
        <Progress value={(t / 10) * 100} className="h-1.5" />
        <div className="grid grid-cols-2 gap-x-3 gap-y-1">
          <Kv k="Step" v={thin(step)} />
          <Kv k="dt" v="0.42" u="ps" />
          <Kv k="Rate" v="412" u="steps/s" />
          <Kv k="Solver" v="LLG + RK23" />
        </div>
      </Group>
      <Group title="Magnetization" aside={<span className="text-[11px] text-muted-foreground">mean over film</span>}>
        <div className="flex flex-1 flex-col justify-center gap-2.5">
          <Diverge label={<>⟨m<sub>x</sub>⟩</>} v={mx} color="var(--ax-x)" />
          <Diverge label={<>⟨m<sub>y</sub>⟩</>} v={my} color="var(--ax-y)" />
          <Diverge label={<>⟨m<sub>z</sub>⟩</>} v={mz} color="var(--ax-z)" />
        </div>
      </Group>
      <Group title="Energy" aside={<span className="text-[11px] text-muted-foreground">total, J</span>}>
        <div className="grid min-w-0 grid-cols-1 gap-1.5 @[21rem]/g:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] @[21rem]/g:gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            {energies.map(([k, v]) => (
              <div key={k} className="flex items-baseline justify-between gap-2 text-[12px]">
                <span className="text-muted-foreground">{k}</span>
                <span className="font-medium whitespace-nowrap tabular-nums">{sci(v)}</span>
              </div>
            ))}
          </div>
          <div className="flex min-w-0 items-baseline justify-between gap-2 border-t border-border/70 pt-1.5 @[21rem]/g:flex-col @[21rem]/g:items-stretch @[21rem]/g:border-t-0 @[21rem]/g:border-l @[21rem]/g:pt-0 @[21rem]/g:pl-3">
            <span className="text-[12px] text-muted-foreground @[21rem]/g:hidden">Total</span>
            <span className="text-[13px] leading-none font-semibold tracking-tight whitespace-nowrap tabular-nums @[21rem]/g:text-lg">{sci(total)}</span>
            <EnergySpark t={t} />
            <span className="hidden text-[11px] text-muted-foreground @[21rem]/g:block">E<sub>total</sub>(t), illustrative</span>
          </div>
        </div>
      </Group>
      <Group title="Convergence" aside={<span className="text-xs font-medium text-ok tabular-nums">2.1 × 10<sup>−3</sup></span>}>
        <TorqueSpark t={t} />
        <div className="flex items-center justify-between text-[11px] text-muted-foreground"><span>max |m × H<sub>eff</sub>|</span><span>log scale, illustrative</span></div>
      </Group>
    </div>
  )
}
