import { useEffect, useMemo, useRef, useState } from "react"
import {
  Check, ChevronRight, ChevronsDownUp, ChevronsUpDown, CircleAlert, Copy, Crosshair, Ellipsis, Info, Pin,
  RotateCcw, Search, Columns2, Trash2, TriangleAlert, X, FileCode2, ListTree,
} from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from "@/components/ui/breadcrumb"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { FieldGroup } from "@/components/ui/field"
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput, InputGroupText } from "@/components/ui/input-group"
import { Kbd } from "@/components/ui/kbd"
import { Spinner } from "@/components/ui/spinner"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { plural, SHADOW } from "@/lib/format"
import { PropertyRow } from "./controls"
import { isLive, rowError, stats, type Store, type StoreActions } from "./state"
import type { InspectorApi, Notice, Section, Spec, Tone } from "./types"

const TONE: Record<Tone, string> = {
  ok: "text-ok bg-[color-mix(in_oklab,var(--ok)_14%,transparent)] ring-[color-mix(in_oklab,var(--ok)_30%,transparent)]",
  warn: "text-warn bg-[color-mix(in_oklab,var(--warn)_14%,transparent)] ring-[color-mix(in_oklab,var(--warn)_32%,transparent)]",
  err: "text-err bg-[color-mix(in_oklab,var(--err)_14%,transparent)] ring-[color-mix(in_oklab,var(--err)_32%,transparent)]",
  info: "text-info bg-[color-mix(in_oklab,var(--info)_14%,transparent)] ring-[color-mix(in_oklab,var(--info)_30%,transparent)]",
  live: "text-live bg-[color-mix(in_oklab,var(--live)_14%,transparent)] ring-[color-mix(in_oklab,var(--live)_30%,transparent)]",
  neutral: "text-muted-foreground bg-foreground/[.06] ring-border",
}

export function StatePill({ tone, label }: { tone: Tone; label: string }) {
  return (
    <Badge className={cn("h-6 shrink-0 gap-1.5 rounded-full px-2.5 ring-1 ring-inset", TONE[tone])}>
      <span className={cn("size-1.5 rounded-full bg-current", tone === "live" && "animate-pulse-dot")} />
      {label}
    </Badge>
  )
}

function NoticeView({ n, api }: { n: Notice; api: InspectorApi }) {
  const Icon = n.tone === "err" ? CircleAlert : n.tone === "warn" ? TriangleAlert : Info
  const tone = n.tone === "err" ? "err" : n.tone === "warn" ? "warn" : "info"
  return (
    <Alert
      role={n.tone === "err" ? "alert" : "status"}
      className={cn(
        "animate-rise rounded-2xl border-0 px-3 py-2.5 ring-1 ring-inset",
        tone === "err" && "bg-[color-mix(in_oklab,var(--err)_9%,transparent)] ring-[color-mix(in_oklab,var(--err)_26%,transparent)] [&>svg]:text-err",
        tone === "warn" && "bg-[color-mix(in_oklab,var(--warn)_9%,transparent)] ring-[color-mix(in_oklab,var(--warn)_26%,transparent)] [&>svg]:text-warn",
        tone === "info" && "bg-[color-mix(in_oklab,var(--info)_8%,transparent)] ring-[color-mix(in_oklab,var(--info)_22%,transparent)] [&>svg]:text-info",
      )}
    >
      <Icon />
      {n.title ? <AlertTitle className="text-[13px]">{n.title}</AlertTitle> : null}
      <AlertDescription className="flex flex-col items-start gap-2 text-[13px] leading-relaxed text-foreground/80">
        <span>{n.text}</span>
        {n.action ? (
          <Button size="xs" variant={n.action.ghost ? "ghost" : "secondary"} className="rounded-full" onClick={() => n.action!.run(api)}>
            {n.action.label}
          </Button>
        ) : null}
      </AlertDescription>
    </Alert>
  )
}

function SectionView({ spec, sec, store, act, api, first, filter }: {
  spec: Spec; sec: Section; store: Store; act: StoreActions; api: InspectorApi; first: boolean; filter: string
}) {
  const id = spec.id
  const d = store.d[id], o = store.o[id]
  const open = filter ? true : store.open[id][sec.id]
  const q = filter.trim().toLowerCase()
  const rows = sec.rows.filter((r) => (!r.when || r.when(d)) && (!q || (r.label ?? "").toLowerCase().includes(q) || sec.title.toLowerCase().includes(q)))
  if (q && rows.length === 0) return null
  const live = isLive(spec, sec)
  const hasDirty = !live && sec.rows.some((r) => r.k && r.k in o && (!r.when || r.when(d)) && JSON.stringify(d[r.k]) !== JSON.stringify(o[r.k]))
  const hasErr = sec.rows.some((r) => r.k && rowError(r, d) && (r.serverError || JSON.stringify(d[r.k]) !== JSON.stringify(o[r.k])))
  const Icon = sec.icon
  const flash = store.flash && store.flash.id === id ? store.flash : null
  const ctx = { specId: id, d, set: (k: string, v: unknown) => act.setVal(id, k, v), api }

  return (
    <Collapsible
      open={open}
      onOpenChange={(v) => act.setOpen(id, sec.id, v)}
      className="group/sec rounded-2xl bg-foreground/[.025] ring-1 ring-border/70 ring-inset transition-colors data-[state=open]:bg-foreground/[.035]"
    >
      <CollapsibleTrigger
        data-pin={first ? "6" : undefined}
        className="flex h-10 w-full items-center gap-2 rounded-2xl px-3 text-left outline-none hover:bg-foreground/[.03] focus-visible:ring-2 focus-visible:ring-ring/60"
      >
        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform duration-200 group-data-[state=open]/sec:rotate-90" />
        <Icon className="size-4 shrink-0 text-muted-foreground transition-colors group-data-[state=open]/sec:text-[var(--hue)]" />
        <span className="truncate text-[13px] font-semibold">{sec.title}</span>
        {live && spec.mode !== "live" ? <Badge className={cn("h-5 rounded-full px-1.5 text-[10.5px] ring-1 ring-inset", TONE.live)}>Live</Badge> : null}
        <span className="ml-auto min-w-0 truncate pl-2 text-right text-xs text-muted-foreground transition-opacity group-data-[state=open]/sec:opacity-0">
          {sec.summary?.(d)}
        </span>
        <span className={cn("size-1.5 shrink-0 scale-0 rounded-full bg-primary transition-transform", (hasDirty || hasErr) && "scale-100", hasErr && "bg-destructive")} />
      </CollapsibleTrigger>
      <CollapsibleContent className="overflow-hidden data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down">
        {sec.empty ? (
          <Empty className="gap-3 border-0 px-4 py-8">
            <EmptyHeader>
              <EmptyMedia variant="icon" className="rounded-2xl bg-[color-mix(in_oklab,var(--hue)_15%,transparent)] text-[var(--hue)]">
                {sec.empty.icon ? <sec.empty.icon /> : <Icon />}
              </EmptyMedia>
              <EmptyTitle className="text-sm">{sec.empty.title}</EmptyTitle>
              <EmptyDescription className="text-[13px]">{sec.empty.text}</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button size="sm" variant="outline" className="rounded-full" onClick={() => api.toast("Study start is disabled in this mockup")}>Run study from here</Button>
            </EmptyContent>
          </Empty>
        ) : (
          <FieldGroup className="gap-0.5 px-3 pt-0.5 pb-3">
            {rows.map((r, i) => (
              <PropertyRow
                key={r.k ?? `${sec.id}-${i}`}
                specId={id}
                row={r}
                d={d}
                o={o}
                unit={r.k ? store.unit[id][r.k] : undefined}
                onUnit={(u) => r.k && act.setUnit(id, r.k, u)}
                set={ctx.set}
                revert={(k) => act.revertOne(id, k)}
                api={api}
                liveRow={live}
                flash={flash && r.k && flash.keys.includes(r.k) ? flash.kind : undefined}
              />
            ))}
            {sec.footer ? sec.footer(ctx) : null}
          </FieldGroup>
        )}
      </CollapsibleContent>
    </Collapsible>
  )
}

export function InspectorTemplate({ spec, store, act, api, onCompare, onFit, onApplied, className }: {
  spec: Spec; store: Store; act: StoreActions; api: InspectorApi; onCompare?: () => void; onFit: () => void; onApplied?: (spec: Spec, count: number) => void; className?: string
}) {
  const id = spec.id
  const d = store.d[id], o = store.o[id]
  const st = stats(spec, d, o)
  const state = spec.state(d)
  const notices = spec.notices?.(d) ?? []
  const tab = store.tab[id]
  const [scrolled, setScrolled] = useState(false)
  const [filterOpen, setFilterOpen] = useState(false)
  const [filter, setFilter] = useState("")
  const [confirm, setConfirm] = useState<null | { title: string; text: string; action: string; run: () => void }>(null)
  const [applying, setApplying] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)
  const live = spec.mode === "live"

  useEffect(() => { bodyRef.current?.scrollTo({ top: 0 }); setFilter(""); setFilterOpen(false); setScrolled(false) }, [id])
  useEffect(() => {
    if (!store.applied[id]) return
    const t = window.setTimeout(() => act.clearApplied(id), 3000)
    return () => window.clearTimeout(t)
  }, [store.applied, id, act])

  const sections = spec.sections.filter((s) => !s.tab || s.tab === tab)
  const matchCount = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return 0
    return spec.sections.flatMap((s) => s.rows).filter((r) => (r.label ?? "").toLowerCase().includes(q)).length
  }, [filter, spec])

  const doApply = () => {
    if (!st.staged || st.errors || applying) return
    const run = () => {
      setApplying(true)
      window.setTimeout(() => { act.apply(id); setApplying(false); onApplied?.(spec, st.staged); api.toast(`Applied ${plural(st.staged, "change")}`, `${spec.title(d)} is now scene revision ${store.rev[id] + 1}.`) }, 550)
    }
    if (spec.confirmApply) setConfirm({ ...spec.confirmApply, run })
    else run()
  }

  const onKey = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); doApply() }
  }

  let msg: React.ReactNode
  let dot = "bg-muted-foreground/50"
  if (live) { msg = "Live. Changes apply to the viewport immediately."; dot = "bg-live" }
  else if (st.errors && (st.staged || state.tone === "err")) { msg = `Fix ${plural(st.errors, "field")} to apply`; dot = "bg-destructive" }
  else if (st.staged) { msg = plural(st.staged, "unapplied change"); dot = "bg-primary" }
  else if (store.applied[id]) { msg = `Applied as scene revision ${store.rev[id]}`; dot = "bg-ok" }
  else msg = spec.sections.some((s) => s.live) ? "Draft is clean. Display settings apply immediately." : `Up to date with scene revision ${store.rev[id]}`
  const showBtns = live ? st.live > 0 : st.staged > 0

  return (
    <section
      aria-label="Inspector"
      onKeyDown={onKey}
      className={cn("@container/insp relative flex h-full min-h-0 flex-col overflow-hidden rounded-[22px] glass glass-hi text-sm", SHADOW.md, className)}
      style={{ "--hue": `var(--h-${spec.domain})` } as React.CSSProperties}
    >
      {/* Header */}
      <header className={cn("relative z-10 flex flex-col gap-3 px-4 pt-3 pb-3 transition-shadow", scrolled && "shadow-[0_10px_20px_-16px_rgba(0,0,0,0.45)]")}>
        <div className="flex items-center gap-1" data-pin="1">
          <Breadcrumb className="min-w-0 flex-1">
            <BreadcrumbList className="flex-nowrap gap-1 text-xs sm:gap-1">
              {spec.path.map((p, i) => (
                <span key={`${p}-${i}`} className="contents">
                  {i > 0 ? <BreadcrumbSeparator className="[&>svg]:size-3" /> : null}
                  <BreadcrumbItem className="min-w-0">
                    {i === spec.path.length - 1 ? <BreadcrumbPage className="truncate text-xs">{p}</BreadcrumbPage> : <BreadcrumbLink href="#" onClick={(e) => e.preventDefault()} className="truncate">{p}</BreadcrumbLink>}
                  </BreadcrumbItem>
                </span>
              ))}
            </BreadcrumbList>
          </Breadcrumb>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" className="rounded-full text-muted-foreground" aria-label="Find a property" aria-pressed={filterOpen} onClick={() => { setFilterOpen((v) => !v); setFilter("") }}>
                <Search />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Find a property</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" className="rounded-full text-muted-foreground" aria-label="Fit view to selection" onClick={onFit}>
                <Crosshair />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Fit view to selection</TooltipContent>
          </Tooltip>
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon-sm" className="rounded-full text-muted-foreground" aria-label="More actions">
                    <Ellipsis />
                  </Button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent>More actions</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="end" className={cn("w-60 rounded-2xl p-1.5", SHADOW.md)}>
              <DropdownMenuLabel className="text-xs text-muted-foreground">{spec.kind}</DropdownMenuLabel>
              <DropdownMenuGroup>
                <DropdownMenuItem className="rounded-lg" onSelect={() => { navigator.clipboard?.writeText(spec.idv).catch(() => {}); api.toast("Copied node ID", spec.idv) }}><Copy /> Copy node ID</DropdownMenuItem>
                <DropdownMenuItem className="rounded-lg" onSelect={() => api.openJson(`${spec.title(d)} as Python`, pythonFor(spec, d))}><FileCode2 /> Show as Python</DropdownMenuItem>
                <DropdownMenuItem className="rounded-lg" onSelect={() => api.toast("Revealed in the model tree")}><ListTree /> Reveal in model tree</DropdownMenuItem>
                <DropdownMenuItem className="rounded-lg" onSelect={() => api.toast("Pinned. Selection changes no longer replace this inspector.")}><Pin /> Pin inspector</DropdownMenuItem>
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuItem className="rounded-lg" onSelect={() => act.setAllOpen(id, true)}><ChevronsUpDown /> Expand all sections</DropdownMenuItem>
                <DropdownMenuItem className="rounded-lg" onSelect={() => act.setAllOpen(id, false)}><ChevronsDownUp /> Collapse all sections</DropdownMenuItem>
                {onCompare ? <DropdownMenuItem className="rounded-lg" onSelect={onCompare}><Columns2 /> Compare with current<DropdownMenuShortcut>C</DropdownMenuShortcut></DropdownMenuItem> : null}
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" className="rounded-lg" onSelect={() => setConfirm({ title: `Delete ${spec.title(d)}?`, text: "This removes the node from the model. Undo is available from the history panel.", action: "Delete", run: () => api.toast("Delete is disabled in this mockup") })}>
                <Trash2 /> Delete…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div className="flex items-center gap-3" data-pin="2">
          <span
            aria-hidden
            className="grid size-11 shrink-0 place-items-center rounded-2xl text-[var(--hue)] ring-1 ring-[color-mix(in_oklab,var(--hue)_30%,transparent)] ring-inset [&_svg]:size-5"
            style={{ background: "linear-gradient(145deg, color-mix(in oklab, var(--hue) 30%, transparent), color-mix(in oklab, var(--hue) 8%, transparent))", boxShadow: "inset 0 1px 0 0 var(--glass-hi)" }}
          >
            <spec.icon />
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            {spec.rename ? (
              <input
                value={d[spec.rename]}
                onChange={(e) => act.setVal(id, spec.rename!, e.target.value)}
                aria-label="Name"
                spellCheck={false}
                className="-ml-1.5 w-full rounded-lg border border-transparent bg-transparent px-1.5 text-[17px] leading-tight font-semibold tracking-tight outline-none hover:border-border focus:border-ring focus:bg-field"
              />
            ) : (
              <h2 className="line-clamp-2 text-[17px] leading-tight font-semibold tracking-tight text-balance">{spec.title(d)}</h2>
            )}
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              <span>{spec.kind}</span>
              <button
                type="button"
                onClick={() => { navigator.clipboard?.writeText(spec.idv).catch(() => {}); api.toast("Copied ID", spec.idv) }}
                className="group/id inline-flex max-w-full items-center gap-1 rounded-full bg-field px-2 py-0.5 font-mono text-[11px] text-foreground/75 ring-1 ring-border ring-inset hover:text-foreground"
              >
                <span className="truncate">{spec.idv}</span>
                <Copy className="size-3 opacity-50 group-hover/id:opacity-100" />
              </button>
            </div>
          </div>
          <StatePill tone={state.tone} label={state.label} />
        </div>

        <div className={cn("grid transition-[grid-template-rows,opacity] duration-300 ease-out-soft", scrolled ? "grid-rows-[0fr] opacity-0" : "grid-rows-[1fr] opacity-100")} data-pin="3">
          <div className="min-h-0 overflow-hidden">
            <dl className={cn("grid grid-cols-2 overflow-hidden rounded-2xl bg-field ring-1 ring-border ring-inset @[26rem]/insp:grid-cols-4", SHADOW.sm)}>
              {spec.facts(d).map((f, i) => (
                <div key={i} className="flex min-w-0 flex-col gap-0.5 border-border px-3 py-2 not-first:border-l [&:nth-child(3)]:border-l-0 @[26rem]/insp:[&:nth-child(3)]:border-l [&:nth-child(n+3)]:border-t @[26rem]/insp:[&:nth-child(n+3)]:border-t-0">
                  <dt className="truncate text-[11px] text-muted-foreground">{f.label}</dt>
                  <dd className={cn("text-[13px] leading-snug font-medium break-words tabular-nums", f.tone === "ok" && "text-ok", f.tone === "warn" && "text-warn", f.tone === "err" && "text-err")}>{f.value}</dd>
                </div>
              ))}
            </dl>
          </div>
        </div>

        {spec.headerAction ? (
          <div className="flex justify-end -mt-1">
            <Button
              size="sm"
              variant={spec.headerAction.label.startsWith("Stop") ? "destructive" : "outline"}
              className="rounded-full"
              onClick={() => setConfirm({ ...spec.headerAction!.confirm, run: () => api.toast(`${spec.headerAction!.label} requested`, "The mockup does not talk to the solver.") })}
            >
              <spec.headerAction.icon data-icon="inline-start" />
              {spec.headerAction.label}
            </Button>
          </div>
        ) : null}

        {filterOpen ? (
          <InputGroup className="h-9 animate-rise rounded-full bg-field">
            <InputGroupAddon><Search /></InputGroupAddon>
            <InputGroupInput autoFocus placeholder="Find a property" value={filter} onChange={(e) => setFilter(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") { setFilterOpen(false); setFilter("") } }} />
            <InputGroupAddon align="inline-end">
              {filter ? <InputGroupText className="text-xs tabular-nums">{plural(matchCount, "match")}</InputGroupText> : null}
              <InputGroupButton size="icon-xs" className="rounded-full" aria-label="Close search" onClick={() => { setFilterOpen(false); setFilter("") }}><X /></InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
        ) : null}

        {spec.tabs && !filter ? (
          <Tabs value={tab} onValueChange={(t) => act.setTab(id, t)} data-pin="4">
            <TabsList className="h-9 w-full rounded-full bg-field p-[3px] ring-1 ring-border ring-inset">
              {spec.tabs.map(([t, l]) => (
                <TabsTrigger key={t} value={t} className="rounded-full text-xs data-active:bg-raised data-active:shadow-[0px_2px_3px_-1px_rgba(0,0,0,0.1),0px_1px_0px_0px_rgba(25,28,33,0.02),0px_0px_0px_1px_rgba(25,28,33,0.08)] dark:data-active:border-transparent dark:data-active:shadow-none">{l}</TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        ) : null}
      </header>

      {/* Body */}
      <div
        ref={bodyRef}
        className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-24 [scrollbar-gutter:stable] [scrollbar-width:thin]"
        onScroll={(e) => {
          const y = e.currentTarget.scrollTop
          if (!scrolled && y > 40) setScrolled(true)
          else if (scrolled && y < 4) setScrolled(false)
        }}
      >
        <div key={`${id}:${tab}`} className="flex animate-rise flex-col gap-2 pt-1">
          {notices.length ? <div className="flex flex-col gap-2" data-pin="5">{notices.map((n, i) => <NoticeView key={`${n.text}-${i}`} n={n} api={api} />)}</div> : null}
          {sections.map((sec, i) => (
            <SectionView key={sec.id} spec={spec} sec={sec} store={store} act={act} api={api} first={i === 0} filter={filter} />
          ))}
          {filter && matchCount === 0 ? <p className="px-2 py-6 text-center text-[13px] text-muted-foreground">No property matches “{filter}”.</p> : null}
          {!filter ? (
            <Collapsible open={store.open[id].__details} onOpenChange={(v) => act.setOpen(id, "__details", v)} className="group/sec rounded-2xl">
              <CollapsibleTrigger className="flex h-9 w-full items-center gap-2 rounded-2xl px-3 text-left text-muted-foreground outline-none hover:bg-foreground/[.03] focus-visible:ring-2 focus-visible:ring-ring/60">
                <ChevronRight className="size-3.5 transition-transform group-data-[state=open]/sec:rotate-90" />
                <Info className="size-4" />
                <span className="text-[13px] font-medium">Details</span>
                <span className="ml-auto text-xs">{plural(spec.details.length, "field")}</span>
              </CollapsibleTrigger>
              <CollapsibleContent className="overflow-hidden data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down">
                <dl className="grid grid-cols-[minmax(6.5rem,34%)_minmax(0,1fr)] gap-x-3 gap-y-2 px-3 pt-1 pb-3 text-[13px]">
                  {spec.details.map(([l, v, mono]) => (
                    <div key={l} className="contents">
                      <dt className="text-muted-foreground">{l}</dt>
                      <dd className={cn("min-w-0 break-words text-foreground/80", mono && "font-mono text-xs")}>{v}</dd>
                    </div>
                  ))}
                </dl>
              </CollapsibleContent>
            </Collapsible>
          ) : null}
        </div>
      </div>

      {/* Commit bar */}
      <footer
        data-pin="8"
        className={cn(
          "absolute inset-x-3 bottom-3 z-10 flex min-h-11 flex-nowrap items-center gap-2 rounded-2xl px-3 py-1.5 glass glass-hi transition-colors duration-300",
          SHADOW.md,
          st.staged && !st.errors && "bg-[color-mix(in_oklab,var(--primary)_10%,var(--glass-strong))]",
          st.errors && (st.staged || state.tone === "err") && "bg-[color-mix(in_oklab,var(--err)_9%,var(--glass-strong))]",
          !st.staged && "bg-glass-strong",
        )}
      >
        <button
          type="button"
          className={cn("flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left text-xs text-muted-foreground", st.staged && "font-medium text-foreground", st.errors && st.firstError && "cursor-pointer text-err underline decoration-err/40 underline-offset-4")}
          onClick={() => { if (st.errors && st.firstError) act.focus(id, st.firstError) }}
        >
          <span className={cn("size-2 shrink-0 rounded-full transition-colors", dot, live && "animate-pulse-dot")} />
          <span className="truncate">{msg}</span>
          {store.applied[id] && !st.staged ? <Check className="size-3.5 text-ok" /> : null}
        </button>
        <div className={cn("ml-auto flex shrink-0 gap-1.5 overflow-hidden transition-[max-width,opacity,translate] duration-300 ease-out-soft", showBtns ? "max-w-[280px] translate-y-0 opacity-100" : "pointer-events-none max-w-0 translate-y-2 opacity-0")}>
          <Button variant="ghost" size="sm" className="rounded-full" onClick={() => act.revertAll(id)}>
            <RotateCcw data-icon="inline-start" />
            {live ? "Reset display" : "Revert"}
          </Button>
          {!live ? (
            <Button size="sm" className="rounded-full pr-1.5" disabled={!!st.errors || applying} onClick={doApply}>
              {applying ? <Spinner data-icon="inline-start" /> : <Check data-icon="inline-start" />}
              {applying ? "Applying" : "Apply"}
              <Kbd className="hidden h-5 rounded-full bg-primary-foreground/15 px-1.5 text-[10px] text-primary-foreground @[24rem]/insp:inline-flex">Ctrl ↵</Kbd>
            </Button>
          ) : null}
        </div>
      </footer>

      <AlertDialog open={!!confirm} onOpenChange={(v) => !v && setConfirm(null)}>
        <AlertDialogContent className={cn("rounded-3xl glass", SHADOW.lg)}>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm?.title}</AlertDialogTitle>
            <AlertDialogDescription>{confirm?.text}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="rounded-full">Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="rounded-full"
              variant={confirm?.action === "Delete" || confirm?.action === "Stop run" ? "destructive" : "default"}
              onClick={() => { confirm?.run(); setConfirm(null) }}
            >
              {confirm?.action}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}

export function pythonFor(spec: Spec, d: Record<string, any>): string {
  const lines = [`# ${spec.kind}: ${spec.title(d)}`, `node = study.get("${spec.idv}")`]
  for (const sec of spec.sections) for (const r of sec.rows) {
    if (!r.k || !("value" in r) || r.type === "custom" || r.type === "ro") continue
    if (r.when && !r.when(d)) continue
    const v = d[r.k]
    lines.push(`node.${r.k} = ${Array.isArray(v) ? `(${v.join(", ")})` : typeof v === "string" ? JSON.stringify(v) : String(v)}`)
  }
  return lines.join("\n")
}
