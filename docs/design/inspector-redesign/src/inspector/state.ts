import { useCallback, useMemo, useState } from "react"

import { clone, eq } from "@/lib/format"
import { SPECS } from "./specs"
import type { Draft, Row, Section, Spec } from "./types"

export type RowEntry = [string, Row, Section]

export function rowsOf(spec: Spec): RowEntry[] {
  const out: RowEntry[] = []
  for (const sec of spec.sections) for (const r of sec.rows) if (r.k) out.push([r.k, r, sec])
  return out
}
export const isLive = (spec: Spec, sec: Section) => spec.mode === "live" || !!sec.live

export function rowError(row: Row, d: Draft): string | null {
  if (row.when && !row.when(d)) return null
  if (!row.k) return null
  const v = d[row.k]
  if (row.type === "num" && !(typeof v === "number" && Number.isFinite(v))) return "Enter a number, for example 2.6e10."
  if (row.type === "vec" && (v as unknown[]).some((x) => !(typeof x === "number" && Number.isFinite(x)))) return "Each component must be a number."
  if (row.validate) {
    const m = row.validate(v, d)
    if (m) return m
  }
  if (row.serverError) return row.serverError(d)
  return null
}

export interface Stats { staged: number; live: number; errors: number; firstError?: string }
export function stats(spec: Spec, d: Draft, o: Draft): Stats {
  let staged = 0, live = 0, errors = 0
  let firstError: string | undefined
  for (const [k, r, sec] of rowsOf(spec)) {
    if (!(k in o)) continue
    if (r.when && !r.when(d)) continue
    const dirty = !eq(d[k], o[k])
    if (dirty) { if (isLive(spec, sec)) live++; else staged++ }
    if (rowError(r, d) && (dirty || r.serverError)) { errors++; firstError ??= k }
  }
  return { staged, live, errors, firstError }
}

export interface Store {
  sel: string
  d: Record<string, Draft>
  o: Record<string, Draft>
  unit: Record<string, Record<string, string>>
  open: Record<string, Record<string, boolean>>
  tab: Record<string, string | undefined>
  rev: Record<string, number>
  applied: Record<string, number>
  flash: { id: string; keys: string[]; kind: "applied" | "live" | "focus"; nonce: number } | null
}

function initial(): Store {
  const s: Store = { sel: "object", d: {}, o: {}, unit: {}, open: {}, tab: {}, rev: {}, applied: {}, flash: null }
  for (const spec of Object.values(SPECS)) {
    const d: Draft = {}, unit: Record<string, string> = {}, open: Record<string, boolean> = {}
    for (const sec of spec.sections) open[sec.id] = sec.open !== false
    open.__details = false
    for (const [k, r] of rowsOf(spec)) {
      if (!("value" in r) || r.value === undefined) continue
      d[k] = clone(r.value)
      if (r.type === "num" && r.units) unit[k] = r.unit0 ?? r.units[0][0]
    }
    s.d[spec.id] = d
    s.o[spec.id] = Object.fromEntries(Object.entries(d).map(([k, v]) => [k, clone(v)]))
    s.unit[spec.id] = unit
    s.open[spec.id] = open
    s.tab[spec.id] = spec.tabs?.[0][0]
    s.rev[spec.id] = 1
    s.applied[spec.id] = 0
  }
  return s
}

let nonce = 0
export function useInspectorStore() {
  const [s, setS] = useState<Store>(initial)

  const setVal = useCallback((id: string, k: string, v: unknown) => {
    setS((p) => {
      const spec = SPECS[id]
      const entry = rowsOf(spec).find((e) => e[0] === k)
      const live = entry ? isLive(spec, entry[2]) : false
      return {
        ...p,
        d: { ...p.d, [id]: { ...p.d[id], [k]: v } },
        applied: { ...p.applied, [id]: 0 },
        flash: live ? { id, keys: [k], kind: "live", nonce: ++nonce } : p.flash,
      }
    })
  }, [])

  const actions = useMemo(() => ({
    select: (id: string) => setS((p) => ({ ...p, sel: id })),
    setVal,
    setUnit: (id: string, k: string, u: string) => setS((p) => ({ ...p, unit: { ...p.unit, [id]: { ...p.unit[id], [k]: u } } })),
    setOpen: (id: string, sec: string, open: boolean) => setS((p) => ({ ...p, open: { ...p.open, [id]: { ...p.open[id], [sec]: open } } })),
    setAllOpen: (id: string, open: boolean) => setS((p) => ({ ...p, open: { ...p.open, [id]: Object.fromEntries(Object.keys(p.open[id]).map((k) => [k, k === "__details" ? false : open])) } })),
    setTab: (id: string, t: string) => setS((p) => ({ ...p, tab: { ...p.tab, [id]: t } })),
    apply: (id: string) => setS((p) => {
      const spec = SPECS[id]
      const o = { ...p.o[id] }
      const keys: string[] = []
      for (const [k, , sec] of rowsOf(spec)) {
        if (!(k in o) || isLive(spec, sec)) continue
        if (!eq(p.d[id][k], o[k])) { o[k] = clone(p.d[id][k]); keys.push(k) }
      }
      return { ...p, o: { ...p.o, [id]: o }, rev: { ...p.rev, [id]: p.rev[id] + 1 }, applied: { ...p.applied, [id]: Date.now() }, flash: { id, keys, kind: "applied", nonce: ++nonce } }
    }),
    revertAll: (id: string) => setS((p) => {
      const spec = SPECS[id]
      const d = { ...p.d[id] }
      for (const [k, , sec] of rowsOf(spec)) {
        if (!(k in p.o[id])) continue
        if (spec.mode === "live" || !isLive(spec, sec)) d[k] = clone(p.o[id][k])
      }
      return { ...p, d: { ...p.d, [id]: d } }
    }),
    revertOne: (id: string, k: string) => setS((p) => ({ ...p, d: { ...p.d, [id]: { ...p.d[id], [k]: clone(p.o[id][k]) } } })),
    focus: (id: string, k: string) => setS((p) => {
      const spec = SPECS[id]
      const entry = rowsOf(spec).find((e) => e[0] === k)
      if (!entry) return { ...p, sel: id }
      const sec = entry[2]
      return {
        ...p, sel: id,
        tab: sec.tab ? { ...p.tab, [id]: sec.tab } : p.tab,
        open: { ...p.open, [id]: { ...p.open[id], [sec.id]: true } },
        flash: { id, keys: [k], kind: "focus", nonce: ++nonce },
      }
    }),
    clearApplied: (id: string) => setS((p) => ({ ...p, applied: { ...p.applied, [id]: 0 } })),
  }), [setVal])

  return [s, actions] as const
}
export type StoreActions = ReturnType<typeof useInspectorStore>[1]
