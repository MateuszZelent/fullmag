import { useEffect, useId, useRef, useState, type ReactNode } from "react"
import { Check, ChevronDown, Copy, CornerUpLeft, TriangleAlert } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ContextMenu, ContextMenuContent, ContextMenuGroup, ContextMenuItem, ContextMenuSeparator, ContextMenuShortcut, ContextMenuTrigger } from "@/components/ui/context-menu"
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field"
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card"
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput, InputGroupText, InputGroupTextarea } from "@/components/ui/input-group"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Segmented } from "@/components/ui/segmented"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { eq, fmt, minus, parseNum, SHADOW } from "@/lib/format"
import { SWATCHES } from "./constants"
import type { Draft, InspectorApi, Row } from "./types"

const FIELD = "h-8 rounded-[10px] bg-field shadow-none dark:bg-field"

/* ---------- Number with unit menu ---------- */
function NumberField({ id, row, value, unit, onUnit, onChange, invalid }: {
  id: string; row: Extract<Row, { type: "num" }>; value: unknown; unit?: string
  onUnit: (u: string) => void; onChange: (v: unknown) => void; invalid: boolean
}) {
  const f = row.units && unit ? row.units.find((u) => u[0] === unit)?.[1] ?? 1 : 1
  const display = typeof value === "number" && Number.isFinite(value) ? minus(fmt(value / f)) : String(value ?? "")
  const [text, setText] = useState(display)
  const focused = useRef(false)
  useEffect(() => { if (!focused.current) setText(display) }, [display])
  return (
    <InputGroup className={FIELD}>
      <InputGroupInput
        id={id}
        inputMode="decimal"
        autoComplete="off"
        spellCheck={false}
        aria-invalid={invalid || undefined}
        value={text}
        className="tabular-nums"
        onFocus={() => { focused.current = true }}
        onBlur={() => { focused.current = false; setText(display) }}
        onChange={(e) => {
          setText(e.target.value)
          const n = parseNum(e.target.value)
          onChange(Number.isNaN(n) ? e.target.value : n * f)
        }}
      />
      {row.units ? (
        <InputGroupAddon align="inline-end">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <InputGroupButton size="xs" variant="ghost" className="rounded-full text-muted-foreground" aria-label={`${row.label} unit`}>
                {unit}
                <ChevronDown data-icon="inline-end" />
              </InputGroupButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className={cn("min-w-28 rounded-xl", SHADOW.md)}>
              <DropdownMenuRadioGroup value={unit} onValueChange={onUnit}>
                {row.units.map(([u]) => <DropdownMenuRadioItem key={u} value={u}>{u}</DropdownMenuRadioItem>)}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </InputGroupAddon>
      ) : row.unitText ? (
        <InputGroupAddon align="inline-end"><InputGroupText>{row.unitText}</InputGroupText></InputGroupAddon>
      ) : null}
    </InputGroup>
  )
}

function AxisInput({ id, axis, value, onChange, label, invalid }: { id: string; axis: "x" | "y" | "z"; value: unknown; onChange: (v: unknown) => void; label: string; invalid: boolean }) {
  const display = typeof value === "number" ? minus(fmt(value)) : String(value ?? "")
  const [text, setText] = useState(display)
  const focused = useRef(false)
  useEffect(() => { if (!focused.current) setText(display) }, [display])
  return (
    <InputGroup className={cn(FIELD, "min-w-0")}>
      <InputGroupAddon className="pl-2">
        <InputGroupText className={cn("font-mono text-[11px] font-semibold", axis === "x" ? "text-ax-x" : axis === "y" ? "text-ax-y" : "text-ax-z")}>{axis}</InputGroupText>
      </InputGroupAddon>
      <InputGroupInput
        id={id}
        inputMode="decimal"
        autoComplete="off"
        aria-label={`${label} ${axis}`}
        aria-invalid={invalid || undefined}
        className="min-w-0 pr-2 text-right tabular-nums"
        value={text}
        onFocus={() => { focused.current = true }}
        onBlur={() => { focused.current = false; setText(display) }}
        onChange={(e) => {
          setText(e.target.value)
          const n = parseNum(e.target.value)
          onChange(Number.isNaN(n) ? e.target.value : n)
        }}
      />
    </InputGroup>
  )
}

function TextField({ id, value, mono, onChange, invalid }: { id: string; value: string; mono?: boolean; onChange: (v: string) => void; invalid: boolean }) {
  return (
    <InputGroup className={FIELD}>
      <InputGroupInput id={id} value={value} spellCheck={false} autoComplete="off" aria-invalid={invalid || undefined} className={cn(mono && "font-mono text-xs")} onChange={(e) => onChange(e.target.value)} />
    </InputGroup>
  )
}

function CopyButton({ text, api }: { text: string; api: InspectorApi }) {
  const [done, setDone] = useState(false)
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          className="rounded-full text-muted-foreground"
          aria-label="Copy"
          onClick={() => {
            navigator.clipboard?.writeText(text).catch(() => {})
            setDone(true); api.toast("Copied to clipboard", text)
            window.setTimeout(() => setDone(false), 1200)
          }}
        >
          {done ? <Check /> : <Copy />}
        </Button>
      </TooltipTrigger>
      <TooltipContent>Copy</TooltipContent>
    </Tooltip>
  )
}

function ColorField({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
  const cur = SWATCHES.find((s) => s[0] === value) ?? SWATCHES[0]
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button id={id} variant="outline" size="sm" className={cn(FIELD, "w-full justify-start gap-2 px-2 font-normal")}>
          <span className="size-4 rounded-md ring-1 ring-black/10 ring-inset" style={{ background: cur[2] }} />
          {cur[1]}
          <ChevronDown data-icon="inline-end" className="ml-auto opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className={cn("w-60 rounded-2xl p-3", SHADOW.md)}>
        <div className="flex flex-col gap-3">
          <p className="text-xs font-medium text-muted-foreground">Theme colors</p>
          <div role="radiogroup" aria-label="Color" className="grid grid-cols-5 gap-2">
            {SWATCHES.map(([v, name, css]) => (
              <button
                key={v}
                type="button"
                role="radio"
                aria-checked={v === value}
                aria-label={name}
                title={name}
                onClick={() => onChange(v)}
                className={cn("aspect-square rounded-xl ring-1 ring-black/10 ring-inset transition-transform hover:scale-105 focus-visible:ring-2 focus-visible:ring-ring", v === value && "ring-2 ring-offset-2 ring-offset-popover ring-[var(--c)]")}
                style={{ background: css, "--c": css } as React.CSSProperties}
              />
            ))}
          </div>
          <p className="text-xs text-muted-foreground">Viewport colors follow the light and dark theme automatically.</p>
        </div>
      </PopoverContent>
    </Popover>
  )
}

/* ---------- Symbol with definition card and scrubbing ---------- */
function Symbol({ row, onScrub, value }: { row: Row; value: unknown; onScrub?: (v: number) => void }) {
  const start = useRef<{ x: number; v: number } | null>(null)
  const sym = (
    <span
      className={cn("sym rounded-md px-1 text-[15px] text-muted-foreground", onScrub && "cursor-ew-resize hover:bg-[color-mix(in_oklab,var(--hue)_16%,transparent)] hover:text-foreground")}
      onPointerDown={(e) => {
        if (!onScrub || typeof value !== "number") return
        e.preventDefault(); (e.target as HTMLElement).setPointerCapture(e.pointerId)
        start.current = { x: e.clientX, v: value }
      }}
      onPointerMove={(e) => {
        if (!start.current || !onScrub || row.type !== "num") return
        const dx = e.clientX - start.current.x
        let v = row.scrub === "log" ? start.current.v * Math.pow(1.01, dx) : start.current.v + dx * (row.step ?? 0.01)
        if (row.step) v = Math.round(v / row.step) * row.step
        onScrub(parseFloat(v.toPrecision(4)))
      }}
      onPointerUp={() => { start.current = null }}
      onPointerCancel={() => { start.current = null }}
    >
      {row.sym}
    </span>
  )
  if (!row.symInfo) return sym
  return (
    <HoverCard openDelay={350} closeDelay={80}>
      <HoverCardTrigger asChild>{sym}</HoverCardTrigger>
      <HoverCardContent side="left" align="start" className={cn("w-72 rounded-2xl", SHADOW.md)}>
        <div className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-sm font-semibold">{row.symInfo.name}</span>
            <span className="sym text-lg text-[var(--hue)]">{row.sym}</span>
          </div>
          <p className="text-[13px] leading-relaxed text-muted-foreground">{row.symInfo.definition}</p>
          <div className="flex flex-wrap gap-1.5">
            <Badge variant="secondary">SI unit: {row.symInfo.unit}</Badge>
            {row.symInfo.range ? <Badge variant="outline">{row.symInfo.range}</Badge> : null}
          </div>
          {row.type === "num" ? <p className="text-[11px] text-muted-foreground">Drag the symbol sideways to adjust the value.</p> : null}
        </div>
      </HoverCardContent>
    </HoverCard>
  )
}

/* ---------- One row for every property in every inspector ---------- */
export function PropertyRow({ specId, row, d, o, unit, onUnit, set, revert, api, flash, liveRow }: {
  specId: string; row: Row; d: Draft; o: Draft; unit?: string; onUnit: (u: string) => void
  set: (k: string, v: unknown) => void; revert: (k: string) => void; api: InspectorApi
  flash?: "applied" | "live" | "focus"; liveRow: boolean
}) {
  const uid = useId()
  const k = row.k ?? ""
  const id = `${specId}-${k || uid}`
  const v = k ? d[k] : "value" in row ? row.value : undefined
  const dirty = !!k && k in o && !eq(d[k], o[k])
  const err = (() => {
    if (!k) return null
    const vv = d[k]
    if (row.type === "num" && !(typeof vv === "number" && Number.isFinite(vv))) return "Enter a number, for example 2.6e10."
    if (row.type === "vec" && (vv as unknown[]).some((x) => !(typeof x === "number" && Number.isFinite(x)))) return "Each component must be a number."
    return row.validate?.(vv, d) ?? row.serverError?.(d) ?? null
  })()
  const showErr = !!err && (dirty || !!row.serverError)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (flash === "focus" && ref.current) {
      ref.current.scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" })
      const c = ref.current.querySelector<HTMLElement>("input, textarea, button[role=radio], [role=combobox], button")
      window.setTimeout(() => c?.focus({ preventScroll: true }), 300)
    }
  }, [flash])

  let control: ReactNode = null
  switch (row.type) {
    case "text": control = <TextField id={id} value={String(v ?? "")} mono={row.mono} invalid={showErr} onChange={(x) => set(k, x)} />; break
    case "area": control = (
      <InputGroup className="rounded-[10px] bg-field dark:bg-field">
        <InputGroupTextarea id={id} rows={2} value={String(v ?? "")} placeholder={row.placeholder} onChange={(e) => set(k, e.target.value)} className="min-h-14 text-sm" />
      </InputGroup>
    ); break
    case "num": control = <NumberField id={id} row={row} value={v} unit={unit} onUnit={onUnit} invalid={showErr} onChange={(x) => set(k, x)} />; break
    case "vec": control = (
      <div className="flex w-full min-w-0 items-center gap-1.5">
        <div className="grid min-w-0 flex-1 grid-cols-3 gap-1.5">
          {(["x", "y", "z"] as const).map((a, i) => (
            <AxisInput key={a} id={i === 0 ? id : `${id}-${a}`} axis={a} label={row.label ?? ""} invalid={showErr} value={(v as unknown[])[i]} onChange={(x) => { const arr = [...(d[k] as unknown[])]; arr[i] = x; set(k, arr) }} />
          ))}
        </div>
        {row.unit ? <span className="shrink-0 text-xs text-muted-foreground">{row.unit}</span> : null}
      </div>
    ); break
    case "select": control = (
      <Select value={String(v)} onValueChange={(x) => set(k, x)}>
        <SelectTrigger id={id} size="sm" className={cn(FIELD, "w-full")}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent className={cn("rounded-xl", SHADOW.md)} position="popper" align="end">
          <SelectGroup>
            {row.options.map(([val, label]) => (
              <SelectItem key={val} value={val} className="rounded-lg">
                {row.swatch ? <span className="h-2.5 w-8 rounded-full" style={{ background: row.swatch(val) }} /> : null}
                {label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    ); break
    case "seg": control = <Segmented id={id} value={String(v)} invalid={showErr} onValueChange={(x) => set(k, x)} options={row.options.map(([value, label]) => ({ value, label }))} aria-label={row.label} />; break
    case "tiles": control = (
      <ToggleGroup type="single" value={String(v)} onValueChange={(x) => x && set(k, x)} aria-label={row.label} className="grid w-full auto-rows-fr grid-cols-[repeat(auto-fill,minmax(4.6rem,1fr))] items-stretch gap-1.5" spacing={1}>
        {row.options.map(([val, label, Icon]) => (
          <ToggleGroupItem key={val} value={val} aria-label={label} className="flex h-full min-w-0 flex-col justify-center gap-1.5 rounded-xl! bg-field px-1 py-2.5 text-[11.5px] leading-tight font-medium text-muted-foreground ring-1 ring-border ring-inset hover:text-foreground data-[state=on]:bg-raised data-[state=on]:text-foreground data-[state=on]:ring-[color-mix(in_oklab,var(--hue)_45%,transparent)] data-[state=on]:shadow-[0px_2px_3px_-1px_rgba(0,0,0,0.1),0px_1px_0px_0px_rgba(25,28,33,0.02),0px_0px_0px_1px_rgba(25,28,33,0.08)] dark:data-[state=on]:shadow-none [&_svg]:size-[18px]! data-[state=on]:[&_svg]:text-[var(--hue)]">
            <Icon />
            <span className="line-clamp-2 w-full text-center text-balance">{label}</span>
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    ); break
    case "toggles": control = (
      <ToggleGroup type="multiple" value={v as string[]} onValueChange={(x) => set(k, x)} aria-label={row.label} className="flex flex-wrap gap-1.5" spacing={1}>
        {row.options.map(([val, label, Icon]) => (
          <ToggleGroupItem key={val} value={val} size="sm" className="rounded-full! bg-field px-3 text-muted-foreground ring-1 ring-border ring-inset data-[state=on]:bg-raised data-[state=on]:text-foreground data-[state=on]:ring-[color-mix(in_oklab,var(--hue)_45%,transparent)] data-[state=on]:shadow-[0px_2px_3px_-1px_rgba(0,0,0,0.1),0px_1px_0px_0px_rgba(25,28,33,0.02),0px_0px_0px_1px_rgba(25,28,33,0.08)] dark:data-[state=on]:shadow-none data-[state=on]:[&_svg]:text-[var(--hue)]">
            <Icon data-icon="inline-start" />
            {label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    ); break
    case "switch": control = <Switch id={id} checked={!!v} onCheckedChange={(x) => set(k, x)} />; break
    case "range": control = (
      <div className="flex w-full items-center gap-3">
        <Slider id={id} value={[Number(v)]} min={row.min} max={row.max} step={row.step} onValueChange={([x]) => set(k, x)} className="flex-1" aria-label={row.label} />
        <output htmlFor={id} className="min-w-14 text-right text-xs text-muted-foreground tabular-nums">{String(v)}{row.suffix}</output>
      </div>
    ); break
    case "color": control = <ColorField id={id} value={String(v)} onChange={(x) => set(k, x)} />; break
    case "ro": {
      const val = row.get ? row.get(d) : row.value
      control = (
        <div className="flex min-w-0 items-center gap-1">
          <span className={cn("min-w-0 text-[13px] break-words text-foreground", row.mono && "truncate font-mono text-xs text-foreground/80")}>{val}</span>
          {row.copy && typeof val === "string" ? <CopyButton text={val} api={api} /> : null}
        </div>
      )
      break
    }
    case "chips": control = <div className="flex flex-wrap gap-1.5">{row.value.map((c) => <Badge key={c} variant="secondary" className="rounded-full">{c}</Badge>)}</div>; break
    case "custom": control = row.render({ specId, d, set, api }); break
  }

  const note = row.type === "vec" && row.note ? row.note(v as number[]) : null
  const wide = row.wide || !row.label
  const label = row.label ? (
    <div className="flex min-w-0 items-center gap-1">
      <FieldLabel htmlFor={["switch", "seg", "tiles", "toggles", "chips", "ro", "custom", "color"].includes(row.type) ? undefined : id} className="min-w-0 text-[13px] font-normal text-muted-foreground group-data-[invalid=true]/field:text-destructive">
        {row.label}
      </FieldLabel>
      {row.sym ? <Symbol row={row} value={v} onScrub={row.type === "num" ? (x) => set(k, x) : undefined} /> : null}
      {dirty ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-xs" className="ml-auto rounded-full text-primary animate-in fade-in zoom-in-75" aria-label={`Revert ${row.label}`} onClick={() => revert(k)}>
              <CornerUpLeft />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Revert to {Array.isArray(o[k]) ? `(${(o[k] as number[]).map(fmt).join(", ")})` : typeof o[k] === "number" ? fmt(o[k]) : String(o[k])}</TooltipContent>
        </Tooltip>
      ) : null}
    </div>
  ) : null

  const body = (
    <Field
      ref={ref}
      data-row={k}
      data-invalid={showErr || undefined}
      className={cn(
        "relative -mx-2 grid w-[calc(100%+1rem)] grid-cols-1 gap-1.5 rounded-xl px-2 py-1.5 transition-colors *:w-auto",
        !wide && row.type !== "vec" && "@[22rem]/insp:grid-cols-[minmax(6.5rem,34%)_minmax(0,1fr)] @[22rem]/insp:items-center @[22rem]/insp:gap-x-3",
        !wide && row.type === "vec" && "@[30rem]/insp:grid-cols-[minmax(6.5rem,30%)_minmax(0,1fr)] @[30rem]/insp:items-center @[30rem]/insp:gap-x-3",
        flash === "applied" && "animate-row-flash",
        flash === "live" && "animate-row-flash-live",
        flash === "focus" && "animate-row-focus",
        liveRow && "",
      )}
    >
      <span
        aria-hidden
        className={cn("absolute top-2.5 bottom-2.5 left-0 w-[3px] origin-center scale-y-0 rounded-full bg-primary transition-transform duration-200", (dirty || showErr) && !liveRow && "scale-y-100", showErr && "bg-destructive")}
      />
      {label}
      <div className="flex min-w-0 items-center">{control}</div>
      {row.hint ? <FieldDescription className={cn("text-xs", !wide && (row.type === "vec" ? "@[30rem]/insp:col-start-2" : "@[22rem]/insp:col-start-2"))}>{row.hint}</FieldDescription> : null}
      {note ? (
        <p className={cn("flex items-center gap-1.5 text-xs", note[0] === "ok" ? "text-ok" : "text-warn", !wide && (row.type === "vec" ? "@[30rem]/insp:col-start-2" : "@[22rem]/insp:col-start-2"))}>
          {note[0] === "ok" ? <Check className="size-3.5" /> : <TriangleAlert className="size-3.5" />}
          {note[1]}
        </p>
      ) : null}
      {showErr ? <FieldError className={cn("text-xs animate-in fade-in slide-in-from-top-1", !wide && (row.type === "vec" ? "@[30rem]/insp:col-start-2" : "@[22rem]/insp:col-start-2"))}>{err}</FieldError> : null}
    </Field>
  )

  if (!k || row.type === "custom") return body
  const valueText = Array.isArray(v) ? `(${(v as number[]).map(fmt).join(", ")})` : typeof v === "number" ? fmt(v) : String(v)
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{body}</ContextMenuTrigger>
      <ContextMenuContent className={cn("w-56 rounded-xl", SHADOW.md)}>
        <ContextMenuGroup>
          <ContextMenuItem onSelect={() => { navigator.clipboard?.writeText(valueText).catch(() => {}); api.toast("Copied value", valueText) }}>
            <Copy /> Copy value
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => { const py = `${specId}.${k} = ${Array.isArray(v) ? `(${(v as number[]).map(fmt).join(", ")})` : typeof v === "number" ? fmt(v) : JSON.stringify(v)}`; navigator.clipboard?.writeText(py).catch(() => {}); api.toast("Copied as Python", py) }}>
            <Copy /> Copy as Python
          </ContextMenuItem>
        </ContextMenuGroup>
        <ContextMenuSeparator />
        <ContextMenuGroup>
          <ContextMenuItem disabled={!dirty} onSelect={() => revert(k)}>
            <CornerUpLeft /> Revert field <ContextMenuShortcut>Esc</ContextMenuShortcut>
          </ContextMenuItem>
        </ContextMenuGroup>
      </ContextMenuContent>
    </ContextMenu>
  )
}
