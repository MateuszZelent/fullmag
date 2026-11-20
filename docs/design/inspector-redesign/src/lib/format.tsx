import type { ReactNode } from "react"

/** Beautiful-shadows elevation scale (exact utilities from the beautiful-shadows skill). */
export const SHADOW = {
  sm: "shadow-[0px_2px_3px_-1px_rgba(0,0,0,0.1),0px_1px_0px_0px_rgba(25,28,33,0.02),0px_0px_0px_1px_rgba(25,28,33,0.08)]",
  md: "shadow-[0px_0px_0px_1px_rgba(0,0,0,0.06),0px_1px_1px_-0.5px_rgba(0,0,0,0.06),0px_3px_3px_-1.5px_rgba(0,0,0,0.06),_0px_6px_6px_-3px_rgba(0,0,0,0.06),0px_12px_12px_-6px_rgba(0,0,0,0.06),0px_24px_24px_-12px_rgba(0,0,0,0.06)]",
  lg: "shadow-[0_2.8px_2.2px_rgba(0,_0,_0,_0.034),_0_6.7px_5.3px_rgba(0,_0,_0,_0.048),_0_12.5px_10px_rgba(0,_0,_0,_0.06),_0_22.3px_17.9px_rgba(0,_0,_0,_0.072),_0_41.8px_33.4px_rgba(0,_0,_0,_0.086),_0_100px_80px_rgba(0,_0,_0,_0.12)]",
} as const

export const minus = (s: string) => s.replace(/^-/, "−").replace(/e-/, "e−")

export function fmt(x: unknown): string {
  if (typeof x !== "number" || !Number.isFinite(x)) return String(x ?? "")
  if (x === 0) return "0"
  const a = Math.abs(x)
  if (a >= 1e5 || a < 1e-3) {
    const [m, e] = x.toExponential(3).split("e")
    return `${parseFloat(m)}e${parseInt(e, 10)}`
  }
  return String(parseFloat(x.toPrecision(6)))
}

export function sci(x: number): ReactNode {
  if (x === 0) return "0"
  const a = Math.abs(x)
  if (a >= 1e5 || a < 1e-3) {
    const e = Math.floor(Math.log10(a))
    const m = parseFloat((x / 10 ** e).toPrecision(3))
    return (
      <>
        {minus(String(m))} × 10<sup>{minus(String(e))}</sup>
      </>
    )
  }
  return minus(fmt(x))
}

export function parseNum(s: string): number {
  const t = String(s)
    .trim()
    .replace(/−/g, "-")
    .replace(/,/g, ".")
    .replace(/\s/g, "")
    .replace(/[×x*]10\^?/i, "e")
  if (t === "" || t === "-" || t === ".") return NaN
  return Number(t)
}

export const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`
export const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
export const clone = <T,>(v: T): T => (Array.isArray(v) ? ([...v] as T) : v)
export const thin = (n: number) => n.toLocaleString("en-US").replace(/,/g, " ")
