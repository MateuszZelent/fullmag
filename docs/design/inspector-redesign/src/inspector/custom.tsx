import { useEffect, useMemo, useRef, useState } from "react"
import { Area, AreaChart, CartesianGrid, Line, LineChart, ReferenceLine, XAxis, YAxis } from "recharts"
import { BookMarked, Check, ChevronsUpDown, Code2, Database, Hammer, Library } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart"
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from "@/components/ui/item"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Progress } from "@/components/ui/progress"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { fmt, SHADOW } from "@/lib/format"
import type { Draft, InspectorApi, RowCtx } from "./types"
import { STAGES, cmapGradient } from "./constants"

export function ColormapBar({ cmap }: { cmap: string }) {
  return (
    <div className="flex w-full flex-col gap-1">
      <div className="h-2.5 w-full rounded-full ring-1 ring-black/10 ring-inset" style={{ background: cmapGradient(cmap) }} />
      <div className="flex justify-between text-[11px] text-muted-foreground tabular-nums">
        <span>−1</span><span>0</span><span>+1</span>
      </div>
    </div>
  )
}

export function PipelineStrip({ current }: { current: number }) {
  return (
    <div className="flex w-full flex-col gap-2">
      <div className="grid grid-cols-10 gap-1" role="img" aria-label={`Stage ${current + 1} of ${STAGES.length}`}>
        {STAGES.map((s, i) => (
          <Tooltip key={s}>
            <TooltipTrigger asChild>
              <span
                className={cn(
                  "h-2 rounded-full bg-foreground/10 transition-colors",
                  /Spin Torque/.test(s) && "bg-[color-mix(in_oklab,var(--h-physics)_55%,transparent)]",
                  i === current && "bg-[var(--h-study)] ring-2 ring-[color-mix(in_oklab,var(--h-study)_35%,transparent)]"
                )}
              />
            </TooltipTrigger>
            <TooltipContent>{s}</TooltipContent>
          </Tooltip>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        Runs after <span className="font-medium text-foreground/80">Set Spin Torque 1</span> and before{" "}
        <span className="font-medium text-foreground/80">Table Autosave 3</span>
      </p>
    </div>
  )
}

/** Small arrow field preview of the initial magnetization preset. */
export function TexturePreview({ d }: { d: Draft }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const c = ref.current
    if (!c) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const w = c.clientWidth, h = c.clientHeight
    c.width = w * dpr; c.height = h * dpr
    const g = c.getContext("2d")!
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.clearRect(0, 0, w, h)
    const cs = getComputedStyle(document.documentElement)
    const fg = cs.getPropertyValue("--foreground").trim()
    const hue = cs.getPropertyValue("--h-material").trim()
    const nx = 22, ny = 9
    for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
      const x = (i + 0.5) / nx, y = (j + 0.5) / ny
      const px = x * w, py = y * h
      let mx = 0, my = 0, mz = 0
      const dx = (x - 0.5) * 2.4, dy = (y - 0.5) * 1
      const r = Math.hypot(dx, dy)
      if (d.preset === "Uniform") { const n = Math.hypot(...d.dir) || 1; [mx, my, mz] = d.dir.map((v: number) => v / n) }
      else if (d.preset === "Vortex") { const s = d.chir === "CW" ? -1 : 1; const core = Math.exp(-(r * r) / 0.02); mx = -s * dy / (r || 1) * (1 - core); my = s * dx / (r || 1) * (1 - core); mz = core }
      else if (d.preset === "Néel skyrmion") { const th = Math.PI * Math.max(0, 1 - r / 0.45); mx = Math.sin(th) * dx / (r || 1); my = Math.sin(th) * -dy / (r || 1); mz = Math.cos(th) }
      else { const a = Math.sin(i * 12.9898 + j * 78.233 + d.seed) * 43758.5453; const t = (a - Math.floor(a)) * Math.PI * 2; mx = Math.cos(t); my = Math.sin(t) * 0.8; mz = Math.sin(t * 1.7) }
      const ip = Math.hypot(mx, my)
      g.globalAlpha = 0.35 + 0.65 * Math.min(1, ip + Math.abs(mz) * 0.3)
      g.strokeStyle = mz > 0.5 ? hue : fg; g.fillStyle = g.strokeStyle; g.lineWidth = 1.3; g.lineCap = "round"
      const L = Math.min(w / nx, h / ny) * 0.42
      if (ip < 0.25) { g.beginPath(); g.arc(px, py, 2.2, 0, Math.PI * 2); g.fill(); continue }
      const ux = mx / ip, uy = -my / ip
      const ex = px + ux * L * ip, ey = py + uy * L * ip
      g.beginPath(); g.moveTo(px - ux * L * ip, py - uy * L * ip); g.lineTo(ex, ey); g.stroke()
      const a = Math.atan2(ey - py, ex - px)
      g.beginPath(); g.moveTo(ex, ey); g.lineTo(ex - 4 * Math.cos(a - 0.5), ey - 4 * Math.sin(a - 0.5)); g.lineTo(ex - 4 * Math.cos(a + 0.5), ey - 4 * Math.sin(a + 0.5)); g.closePath(); g.fill()
    }
  }, [d.preset, d.dir, d.chir, d.seed])
  return <canvas ref={ref} className="h-28 w-full rounded-xl bg-field ring-1 ring-border ring-inset" aria-label={`${d.preset} texture preview`} role="img" />
}

const sincConfig = { b: { label: "B(t) / B₀", color: "var(--chart-4)" } } satisfies ChartConfig
export function SincChart({ d }: { d: Draft }) {
  const data = useMemo(() => {
    const fc = d.fc > 0 ? d.fc : 10e9
    const t0 = d.profile === "Sinc pulse" ? d.t0 : 0
    const span = Math.min(1.2e-9, Math.max(0.1e-9, 12 / fc))
    const start = d.profile === "Sinc pulse" ? Math.max(0, t0 - span / 2) : 0
    return Array.from({ length: 241 }, (_, i) => {
      const t = start + (i / 240) * span
      const x = 2 * Math.PI * fc * (t - t0)
      const v = d.profile === "Sine" ? Math.sin(2 * Math.PI * fc * t) : Math.abs(x) < 1e-9 ? 1 : Math.sin(x) / x
      return { t: +(t / 1e-9).toFixed(4), b: +v.toFixed(4) }
    })
  }, [d.fc, d.t0, d.profile])
  return (
    <div className="flex w-full flex-col gap-1.5">
      <ChartContainer config={sincConfig} className="aspect-auto h-32 w-full">
        <AreaChart data={data} margin={{ left: 0, right: 4, top: 6, bottom: 0 }}>
          <defs>
            <linearGradient id="fillB" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="var(--color-b)" stopOpacity={0.35} />
              <stop offset="95%" stopColor="var(--color-b)" stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} strokeDasharray="3 3" />
          <XAxis dataKey="t" type="number" domain={["dataMin", "dataMax"]} tickLine={false} axisLine={false} tickMargin={6} tickCount={5} tickFormatter={(v) => `${(+v).toFixed(2)} ns`} fontSize={10} />
          <YAxis hide domain={[-1.05, 1.05]} />
          <ReferenceLine y={0} stroke="var(--border)" />
          <ChartTooltip content={<ChartTooltipContent labelFormatter={(v) => `t = ${v} ns`} />} />
          <Area dataKey="b" type="monotone" stroke="var(--color-b)" strokeWidth={1.8} fill="url(#fillB)" isAnimationActive />
        </AreaChart>
      </ChartContainer>
      <p className="text-xs text-muted-foreground">Normalized drive B(t)/B₀ around the pulse.</p>
    </div>
  )
}

const teleConfig = {
  mx: { label: "⟨mx⟩", color: "var(--chart-1)" },
  mz: { label: "⟨mz⟩", color: "var(--chart-4)" },
} satisfies ChartConfig
export function TelemetryChart() {
  const [t, setT] = useState(7.65)
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return
    const id = window.setInterval(() => setT((v) => (v >= 9.95 ? 7.65 : +(v + 0.05).toFixed(2))), 900)
    return () => window.clearInterval(id)
  }, [])
  const data = useMemo(() => Array.from({ length: 80 }, (_, i) => {
    const tt = (i / 79) * t
    return {
      t: +tt.toFixed(2),
      mx: +(0.041 + 0.06 * Math.exp(-tt / 2.4) * Math.sin(2 * Math.PI * 1.9 * tt)).toFixed(4),
      mz: +(0.02 * Math.exp(-tt / 3) * Math.cos(2 * Math.PI * 1.9 * tt)).toFixed(4),
    }
  }), [t])
  return (
    <div className="flex w-full flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <div className="flex items-baseline justify-between text-xs">
          <span className="text-muted-foreground">Simulated time</span>
          <span className="font-medium tabular-nums">{t.toFixed(2)} of 10 ns</span>
        </div>
        <Progress value={(t / 10) * 100} className="h-1.5" />
      </div>
      <ChartContainer config={teleConfig} className="aspect-auto h-36 w-full">
        <LineChart data={data} margin={{ left: 0, right: 4, top: 6, bottom: 0 }}>
          <CartesianGrid vertical={false} strokeDasharray="3 3" />
          <XAxis dataKey="t" tickLine={false} axisLine={false} tickMargin={6} fontSize={10} tickFormatter={(v) => `${v}`} minTickGap={24} />
          <YAxis hide domain={[-0.06, 0.12]} />
          <ChartTooltip content={<ChartTooltipContent labelFormatter={(v) => `t = ${v} ns`} />} />
          <Line dataKey="mx" type="monotone" stroke="var(--color-mx)" strokeWidth={1.8} dot={false} isAnimationActive={false} />
          <Line dataKey="mz" type="monotone" stroke="var(--color-mz)" strokeWidth={1.8} dot={false} isAnimationActive={false} />
        </LineChart>
      </ChartContainer>
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span className="flex items-center gap-3">
          <span className="flex items-center gap-1.5"><span className="size-2 rounded-full bg-chart-1" />⟨mx⟩</span>
          <span className="flex items-center gap-1.5"><span className="size-2 rounded-full bg-chart-4" />⟨mz⟩</span>
        </span>
        <Badge variant="outline">Illustrative data</Badge>
      </div>
    </div>
  )
}

export function RegionsTable() {
  const rows = [["region-1", "1", "film", "magnetic"], ["region-250", "2", "film", "magnetic"]]
  return (
    <div className="w-full overflow-hidden rounded-xl bg-field ring-1 ring-border ring-inset">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="h-8 text-xs">Region</TableHead>
            <TableHead className="h-8 text-xs">ID</TableHead>
            <TableHead className="h-8 text-xs">Object</TableHead>
            <TableHead className="h-8 text-xs">Support</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r[0]}>
              <TableCell className="font-mono text-xs">{r[0]}</TableCell>
              <TableCell className="tabular-nums">{r[1]}</TableCell>
              <TableCell>{r[2]}</TableCell>
              <TableCell><Badge variant="secondary">{r[3]}</Badge></TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

export function BuildHistory() {
  return (
    <ItemGroup className="w-full gap-1.5">
      <Item variant="outline" size="sm" className="rounded-xl bg-field">
        <ItemMedia variant="icon"><Hammer /></ItemMedia>
        <ItemContent>
          <ItemTitle>Build 1</ItemTitle>
          <ItemDescription>Voxelized from geometry revision 1, 512 × 256 × 1 cells</ItemDescription>
        </ItemContent>
        <ItemActions><Badge className="bg-[color-mix(in_oklab,var(--ok)_18%,transparent)] text-ok">Current</Badge></ItemActions>
      </Item>
      <p className="px-1 text-xs text-muted-foreground">Earlier builds appear here after you re-voxelize.</p>
    </ItemGroup>
  )
}

const LIBRARY = [
  { id: "py", name: "Permalloy (Ni80Fe20)", ms: 800e3, aex: 13e-12, alpha: 0.01 },
  { id: "yig", name: "YIG", ms: 140e3, aex: 3.65e-12, alpha: 1e-4 },
  { id: "cofeb", name: "CoFeB", ms: 1.1e6, aex: 15e-12, alpha: 0.004 },
  { id: "co", name: "Cobalt", ms: 1.4e6, aex: 30e-12, alpha: 0.01 },
]
export function MaterialLibrary({ ctx }: { ctx: RowCtx }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="flex flex-wrap gap-2 pt-1">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm" className="rounded-full" aria-expanded={open}>
            <Library data-icon="inline-start" />
            Load from library
            <ChevronsUpDown data-icon="inline-end" className="opacity-60" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className={cn("w-72 rounded-2xl p-0", SHADOW.md)} align="start">
          <Command className="bg-transparent">
            <CommandInput placeholder="Search materials" />
            <CommandList>
              <CommandEmpty>No material matches.</CommandEmpty>
              <CommandGroup heading="Example library">
                {LIBRARY.map((m) => (
                  <CommandItem
                    key={m.id}
                    value={m.name}
                    onSelect={() => {
                      ctx.set("ms", m.ms); ctx.set("aex", m.aex); ctx.set("alpha", m.alpha)
                      setOpen(false)
                      ctx.api.toast(`Loaded ${m.name} parameters`, "Review the three fields, then apply.")
                    }}
                    className="flex flex-col items-start gap-0.5 rounded-xl"
                  >
                    <span className="font-medium">{m.name}</span>
                    <span className="text-xs text-muted-foreground tabular-nums">
                      Ms {fmt(m.ms / 1e3)} kA/m, Aex {fmt(m.aex / 1e-12)} pJ/m, α {fmt(m.alpha)}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      <SaveToLibrary api={ctx.api} />
    </div>
  )
}
function SaveToLibrary({ api }: { api: InspectorApi }) {
  const [saved, setSaved] = useState(false)
  return (
    <Button
      variant="ghost"
      size="sm"
      className="rounded-full"
      disabled={saved}
      onClick={() => { setSaved(true); api.toast("Saved film material to the library") }}
    >
      {saved ? <Check data-icon="inline-start" /> : <BookMarked data-icon="inline-start" />}
      {saved ? "Saved to library" : "Save copy to library"}
    </Button>
  )
}

export function JsonButton({ api, d }: { api: InspectorApi; d: Draft }) {
  const body = JSON.stringify({
    torque_id: d.tid, model: d.model,
    drive: { kind: d.dkind === "Constant" ? "constant" : "signed_scalar", current_density_Apm2: d.j, sigma_hat: d.sigma },
    xi_dl: d.xidl, xi_fl: d.xifl,
  }, null, 2)
  return (
    <div className="flex gap-2 pt-1">
      <Button variant="outline" size="sm" className="rounded-full" onClick={() => api.openJson("spin_hall_pulse definition", body)}>
        <Code2 data-icon="inline-start" />
        View as JSON
      </Button>
      <Button variant="ghost" size="sm" className="rounded-full" onClick={() => api.toast("Copied Python snippet", "fm.spin_orbit_torque(...)")}>
        <Database data-icon="inline-start" />
        Copy as Python
      </Button>
    </div>
  )
}
