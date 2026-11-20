import type { LucideIcon } from "lucide-react"
import type { ReactNode } from "react"

export type Tone = "ok" | "warn" | "err" | "info" | "live" | "neutral"
export type Domain = "geometry" | "material" | "physics" | "study" | "visualization" | "mesh" | "definition"
export type Draft = Record<string, any>

export interface SymbolInfo {
  name: string
  definition: string
  unit: string
  range?: string
}

export interface RowCtx {
  specId: string
  d: Draft
  set: (k: string, v: unknown) => void
  api: InspectorApi
}

interface RowBase {
  k?: string
  label?: string
  sym?: ReactNode
  symInfo?: SymbolInfo
  hint?: string
  wide?: boolean
  when?: (d: Draft) => boolean
  validate?: (v: any, d: Draft) => string | null
  serverError?: (d: Draft) => string | null
  /** A change of this field rebuilds the visible rows (conditional fields). */
  structural?: boolean
}

export type Row = RowBase &
  (
    | { type: "text"; value: string; mono?: boolean }
    | { type: "area"; value: string; placeholder?: string }
    | { type: "num"; value: number; units?: [string, number][]; unit0?: string; unitText?: string; step?: number; scrub?: "log" | "lin" }
    | { type: "vec"; value: number[]; unit?: string; note?: (v: number[]) => [Tone, string] }
    | { type: "select"; value: string; options: [string, string][]; swatch?: (v: string) => string }
    | { type: "seg"; value: string; options: [string, string][] }
    | { type: "tiles"; value: string; options: [string, string, LucideIcon][] }
    | { type: "toggles"; value: string[]; options: [string, string, LucideIcon][] }
    | { type: "switch"; value: boolean }
    | { type: "range"; value: number; min: number; max: number; step: number; suffix?: string }
    | { type: "color"; value: string }
    | { type: "ro"; value?: string; get?: (d: Draft) => ReactNode; mono?: boolean; copy?: boolean }
    | { type: "chips"; value: string[] }
    | { type: "custom"; value?: unknown; render: (ctx: RowCtx) => ReactNode }
  )

export interface Section {
  id: string
  title: string
  icon: LucideIcon
  tab?: string
  live?: boolean
  open?: boolean
  summary?: (d: Draft) => string
  rows: Row[]
  empty?: { title: string; text: string; icon?: LucideIcon; action?: string }
  /** Rendered after the rows; used for section-level actions. */
  footer?: (ctx: RowCtx) => ReactNode
}

export interface Fact {
  label: ReactNode
  value: ReactNode
  tone?: Tone
}

export interface Notice {
  tone: "info" | "warn" | "err"
  title?: string
  text: string
  action?: { label: string; run: (api: InspectorApi) => void; ghost?: boolean }
}

export interface Spec {
  id: string
  domain: Domain
  icon: LucideIcon
  kind: string
  idv: string
  path: string[]
  mode: "staged" | "live"
  title: (d: Draft) => string
  rename?: string
  state: (d: Draft) => { tone: Tone; label: string }
  facts: (d: Draft) => Fact[]
  tabs?: [string, string][]
  notices?: (d: Draft) => Notice[]
  sections: Section[]
  details: [string, string, boolean?][]
  before?: string
  /** Applying asks for confirmation first (for example, a grid rebuild). */
  confirmApply?: { title: string; text: string; action: string }
  headerAction?: { label: string; icon: LucideIcon; confirm: { title: string; text: string; action: string } }
}

export interface InspectorApi {
  select: (id: string) => void
  setVal: (id: string, k: string, v: unknown) => void
  focusRow: (k: string) => void
  toast: (msg: string, desc?: string) => void
  openJson: (title: string, body: string) => void
}
