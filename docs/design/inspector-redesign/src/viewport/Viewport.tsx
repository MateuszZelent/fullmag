import { useEffect, useRef } from "react"

import type { Draft } from "@/inspector/types"

type RGB = [number, number, number]
function parseColor(c: string): RGB {
  c = c.trim()
  if (c.startsWith("#")) { const n = parseInt(c.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255] }
  const m = c.match(/[\d.]+/g)
  return m ? [Number(m[0]), Number(m[1]), Number(m[2])] : [128, 128, 128]
}
const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const mix = (a: RGB, b: RGB, t: number): RGB => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)]
const VIR = ["#440154", "#3b528b", "#21918c", "#5ec962", "#fde725"].map(parseColor)

/** Illustrative Néel domain wall in a PMA film: m_z = +1 on the left, −1 on the right. */
function mAt(u: number, v: number): [number, number, number] {
  const x0 = 0.5 + 0.07 * Math.sin(v * Math.PI * 2.4) + 0.025 * Math.sin(v * Math.PI * 9)
  const th = 2 * Math.atan(Math.exp((u - x0) / 0.04))
  const ip = Math.sin(th)
  return [ip * Math.cos(0.5 * Math.sin(v * 5)), ip * Math.sin(0.5 * Math.sin(v * 5)), Math.cos(th)]
}

export function Viewport({ viz, obj, view, sel, insetLeft, insetRight, insetBottom = 0, insetTop = 0, theme, fitNonce }: {
  viz: Draft; obj: Draft; view: Draft; sel: string; insetLeft: number; insetRight: number; insetBottom?: number; insetTop?: number; theme: string; fitNonce: number
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  const wrap = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const c = ref.current, w = wrap.current
    if (!c || !w) return
    let raf = 0
    const draw = () => {
      const rect = c.getBoundingClientRect()
      if (rect.width < 10 || rect.height < 10) return
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      c.width = Math.round(rect.width * dpr); c.height = Math.round(rect.height * dpr)
      const g = c.getContext("2d")!
      g.setTransform(dpr, 0, 0, dpr, 0, 0)
      const cs = getComputedStyle(document.documentElement)
      const col = (n: string) => cs.getPropertyValue(n).trim()
      const W = rect.width, H = rect.height
      g.clearRect(0, 0, W, H)
      const availL = Math.min(insetLeft, W * 0.4), availR = Math.min(insetRight, W * 0.5)
      const AW = Math.max(200, W - availL - availR), ox0 = availL
      const is2D = viz.view === "2D"
      let O: [number, number], A: [number, number], B: [number, number]
      if (is2D) {
        const s = Math.min(AW * 0.8, (H - insetBottom - insetTop) * 0.62 * 2)
        O = [ox0 + (AW - s) / 2, insetTop + (H - insetBottom - insetTop) / 2 + s / 4]; A = [s, 0]; B = [0, -s / 2]
      } else {
        const s = Math.min(AW / 0.96, (H - insetBottom - insetTop) / 0.42) * 0.9
        A = [s * 0.6, -s * 0.09]; B = [s * 0.22, -s * 0.26]
        const bw = A[0] + B[0], bh = -(A[1] + B[1])
        O = [ox0 + (AW - bw) / 2, (H - insetBottom + bh) / 2 + 18]
      }
      const P = (u: number, v: number): [number, number] => [O[0] + u * A[0] + v * B[0], O[1] + u * A[1] + v * B[1]]
      const T = is2D ? 0 : Math.max(4, Math.hypot(...A) * 0.014)

      g.strokeStyle = col("--vp-grid"); g.lineWidth = 1
      if (!is2D && view.grid) {
        for (let i = -6; i <= 16; i++) { const a = P(i / 10, -1.2), b = P(i / 10, 2.2); g.beginPath(); g.moveTo(a[0], a[1] + 40); g.lineTo(b[0], b[1] + 40); g.stroke() }
        for (let j = -12; j <= 22; j++) { const a = P(-0.6, j / 10), b = P(1.6, j / 10); g.beginPath(); g.moveTo(a[0], a[1] + 40); g.lineTo(b[0], b[1] + 40); g.stroke() }
      }
      // soft contact shadow under the film
      if (!is2D) {
        const cx = P(0.5, 0.5)
        const grd = g.createRadialGradient(cx[0], cx[1] + 30, 10, cx[0], cx[1] + 30, Math.hypot(...A) * 0.7)
        grd.addColorStop(0, theme === "dark" ? "rgba(0,0,0,0.3)" : "rgba(40,44,70,0.12)"); grd.addColorStop(1, "rgba(0,0,0,0)")
        g.fillStyle = grd; g.beginPath(); g.ellipse(cx[0], cx[1] + 34, Math.hypot(...A) * 0.62, Math.hypot(...B) * 0.5, -0.12, 0, Math.PI * 2); g.fill()
      }
      const lo = parseColor(col("--cm-lo")), hi = parseColor(col("--cm-hi")), mid = parseColor(col("--cm-mid"))
      const colorOf = (m: [number, number, number]) => {
        if (viz.cmap === "hue") { const a = ((Math.atan2(m[1], m[0]) / Math.PI) * 180 + 360) % 360; return `hsl(${a} 68% ${52 + m[2] * 14}%)` }
        const s = viz.comp === "x" ? m[0] : viz.comp === "y" ? m[1] : viz.comp === "z" ? m[2] : Math.hypot(...m)
        const t = (Math.max(-1, Math.min(1, s)) + 1) / 2
        let rgb: RGB
        if (viz.cmap === "vir") { const x = t * (VIR.length - 1), i = Math.min(VIR.length - 2, Math.floor(x)); rgb = mix(VIR[i], VIR[i + 1], x - i) }
        else rgb = t < 0.5 ? mix(lo, mid, t * 2) : mix(mid, hi, (t - 0.5) * 2)
        return `rgb(${rgb.map(Math.round).join(",")})`
      }
      const clip = viz.plane !== "Off" ? viz.clipAt / 100 : 1
      const inClip = (u: number, v: number) => (viz.plane === "X" ? u <= clip : viz.plane === "Y" ? v <= clip : true)
      const visible = obj.visible !== false && viz.render !== "Off"

      if (!is2D && visible) {
        g.fillStyle = col("--vp-side")
        const uEnd = viz.plane === "X" ? clip : 1, vEnd = viz.plane === "Y" ? clip : 1
        const a = P(0, 0), b = P(uEnd, 0), cc = P(uEnd, vEnd)
        g.beginPath(); g.moveTo(...a); g.lineTo(...b); g.lineTo(b[0], b[1] + T); g.lineTo(a[0], a[1] + T); g.closePath(); g.fill()
        g.beginPath(); g.moveTo(...b); g.lineTo(...cc); g.lineTo(cc[0], cc[1] + T); g.lineTo(b[0], b[1] + T); g.closePath(); g.fill()
      }
      const N = 72, M = 36
      g.globalAlpha = (obj.opacity ?? 100) / 100
      if (visible && (viz.render === "Shaded" || viz.render === "Shaded + wire")) {
        for (let i = 0; i < N; i++) for (let j = 0; j < M; j++) {
          const u0 = i / N, u1 = (i + 1) / N, v0 = j / M, v1 = (j + 1) / M
          if (!inClip(u0, v0)) continue
          g.fillStyle = colorOf(mAt((u0 + u1) / 2, (v0 + v1) / 2))
          const p = [P(u0, v0), P(u1, v0), P(u1, v1), P(u0, v1)]
          g.beginPath(); g.moveTo(...p[0]); g.lineTo(...p[1]); g.lineTo(...p[2]); g.lineTo(...p[3]); g.closePath(); g.fill()
          g.strokeStyle = g.fillStyle; g.lineWidth = 0.6; g.stroke()
        }
        // specular sheen
        if (!is2D) {
          const a = P(0, 1), b = P(1, 0)
          const sh = g.createLinearGradient(a[0], a[1], b[0], b[1])
          sh.addColorStop(0, "rgba(255,255,255,0.16)"); sh.addColorStop(0.45, "rgba(255,255,255,0)"); sh.addColorStop(1, "rgba(255,255,255,0.05)")
          g.fillStyle = sh
          const q = [P(0, 0), P(viz.plane === "X" ? clip : 1, 0), P(viz.plane === "X" ? clip : 1, viz.plane === "Y" ? clip : 1), P(0, viz.plane === "Y" ? clip : 1)]
          g.beginPath(); g.moveTo(...q[0]); g.lineTo(...q[1]); g.lineTo(...q[2]); g.lineTo(...q[3]); g.closePath(); g.fill()
        }
      }
      g.globalAlpha = 1
      if (visible && (viz.render === "Shaded + wire" || viz.render === "Wireframe")) {
        g.strokeStyle = viz.render === "Wireframe" ? col("--h-visualization") : "rgba(0,0,0,.16)"; g.lineWidth = 0.8
        for (let i = 0; i <= N; i += 3) { const u = i / N; if (!inClip(u, 0)) continue; const a = P(u, 0), b = P(u, viz.plane === "Y" ? clip : 1); g.beginPath(); g.moveTo(...a); g.lineTo(...b); g.stroke() }
        for (let j = 0; j <= M; j += 3) { const v = j / M; if (!inClip(0, v)) continue; const a = P(0, v), b = P(viz.plane === "X" ? clip : 1, v); g.beginPath(); g.moveTo(...a); g.lineTo(...b); g.stroke() }
      }
      if (visible && viz.render === "Points") {
        for (let i = 0; i < N; i += 2) for (let j = 0; j < M; j += 2) {
          const u = (i + 1) / N, v = (j + 1) / M
          if (!inClip(u, v)) continue
          const p = P(u, v); g.fillStyle = colorOf(mAt(u, v)); g.beginPath(); g.arc(p[0], p[1], 1.8, 0, Math.PI * 2); g.fill()
        }
      }
      if (visible && viz.overlays.includes("vectors")) {
        const step = viz.density, scale = viz.vscale / 100
        const ua: [number, number] = [A[0] / N, A[1] / N], vb: [number, number] = [B[0] / M, B[1] / M]
        const nu = Math.hypot(...ua), nv = Math.hypot(...vb)
        const cell = Math.min(nu, nv) * step
        g.lineWidth = 1.2; g.lineCap = "round"
        const fg = col("--foreground")
        for (let i = step / 2; i < N; i += step) for (let j = step / 2; j < M; j += step) {
          const u = i / N, v = j / M
          if (!inClip(u, v)) continue
          const m = mAt(u, v), p = P(u, v), ip = Math.hypot(m[0], m[1])
          g.strokeStyle = fg; g.fillStyle = fg; g.globalAlpha = 0.6
          if (ip < 0.3) {
            g.beginPath(); g.arc(p[0], p[1], cell * 0.16, 0, Math.PI * 2); g.stroke()
            if (m[2] > 0) { g.beginPath(); g.arc(p[0], p[1], 1, 0, Math.PI * 2); g.fill() }
            else { const r = cell * 0.1; g.beginPath(); g.moveTo(p[0] - r, p[1] - r); g.lineTo(p[0] + r, p[1] + r); g.moveTo(p[0] + r, p[1] - r); g.lineTo(p[0] - r, p[1] + r); g.stroke() }
          } else {
            const dx = (m[0] * ua[0]) / nu + (m[1] * vb[0]) / nv, dy = (m[0] * ua[1]) / nu + (m[1] * vb[1]) / nv
            const L = cell * 0.42 * scale * ip, n = Math.hypot(dx, dy) || 1
            const ex = p[0] + (dx / n) * L, ey = p[1] + (dy / n) * L, sx = p[0] - (dx / n) * L, sy = p[1] - (dy / n) * L
            g.beginPath(); g.moveTo(sx, sy); g.lineTo(ex, ey); g.stroke()
            const ah = Math.max(2.5, L * 0.45), ang = Math.atan2(ey - sy, ex - sx)
            g.beginPath(); g.moveTo(ex, ey); g.lineTo(ex - ah * Math.cos(ang - 0.45), ey - ah * Math.sin(ang - 0.45)); g.lineTo(ex - ah * Math.cos(ang + 0.45), ey - ah * Math.sin(ang + 0.45)); g.closePath(); g.fill()
          }
          g.globalAlpha = 1
        }
      }
      const outline = (u0: number, v0: number, u1: number, v1: number, color: string, dash: number[] = [], lw = 1.5) => {
        g.save(); g.strokeStyle = color; g.lineWidth = lw; g.setLineDash(dash)
        const p = [P(u0, v0), P(u1, v0), P(u1, v1), P(u0, v1)]
        g.beginPath(); g.moveTo(...p[0]); g.lineTo(...p[1]); g.lineTo(...p[2]); g.lineTo(...p[3]); g.closePath(); g.stroke(); g.restore()
      }
      if (viz.overlays.includes("bounds") || !visible) outline(0, 0, 1, 1, col("--muted-foreground"), [4, 4], 1)
      if (viz.plane !== "Off") {
        g.save(); g.fillStyle = col("--warn"); g.globalAlpha = 0.2
        const a = viz.plane === "X" ? P(clip, -0.08) : P(-0.05, clip), b = viz.plane === "X" ? P(clip, 1.08) : P(1.05, clip)
        const up = is2D ? 6 : Math.hypot(...A) * 0.06
        g.beginPath(); g.moveTo(a[0], a[1] + up * 0.4); g.lineTo(b[0], b[1] + up * 0.4); g.lineTo(b[0], b[1] - up); g.lineTo(a[0], a[1] - up); g.closePath(); g.fill(); g.restore()
      }
      const hue: Record<string, string> = { object: "--h-geometry", material: "--h-material", texture: "--h-material", torque: "--h-physics", viz: "--h-visualization", mesh: "--h-mesh" }
      if (hue[sel]) { g.save(); g.shadowColor = col(hue[sel]); g.shadowBlur = view.glow ? 14 : 0; outline(0, 0, 1, 1, col(hue[sel]), [], 2); g.restore() }
      if (sel === "airbox") outline(-0.015, -0.03, 1.015, 1.03, col("--h-mesh"), [6, 4], 1.6)
      if (sel === "monitor") {
        g.save(); g.fillStyle = col("--h-definition"); g.globalAlpha = 0.16
        const q = [P(-0.04, -0.06), P(1.04, -0.06), P(1.04, 1.06), P(-0.04, 1.06)]
        g.beginPath(); q.forEach((p, i) => (i ? g.lineTo(p[0], p[1] - 10) : g.moveTo(p[0], p[1] - 10))); g.closePath(); g.fill(); g.globalAlpha = 0.8
        g.strokeStyle = col("--h-definition"); g.setLineDash([5, 4]); g.stroke(); g.restore()
      }
      const o: [number, number] = [ox0 + 30, H - insetBottom - 34]
      const ax: [[number, number], string, string][] = [[A, "--ax-x", "x"], [B, "--ax-y", "y"]]
      if (!is2D) ax.push([[0, -40], "--ax-z", "z"])
      g.font = "600 10px Inter, system-ui, sans-serif"; g.lineWidth = 1.6
      if (view.axes) for (const [vec, cc, l] of ax) {
        const n = Math.hypot(...vec), e: [number, number] = [o[0] + (vec[0] / n) * 18, o[1] + (vec[1] / n) * 18]
        g.strokeStyle = col(cc); g.fillStyle = col(cc)
        g.beginPath(); g.moveTo(...o); g.lineTo(...e); g.stroke(); g.fillText(l, e[0] + 3, e[1] + 3)
      }
    }
    const schedule = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(draw) }
    schedule()
    const ro = new ResizeObserver(schedule)
    ro.observe(w)
    return () => { cancelAnimationFrame(raf); ro.disconnect() }
  }, [viz, obj, view, sel, insetLeft, insetRight, insetBottom, insetTop, theme])

  useEffect(() => {
    if (!fitNonce || !ref.current) return
    ref.current.animate?.([{ transform: "scale(1)" }, { transform: "scale(1.03)" }, { transform: "scale(1)" }], { duration: 520, easing: "cubic-bezier(.3,.7,.2,1)" })
  }, [fitNonce])

  return (
    <div
      ref={wrap}
      className="absolute inset-0"
      style={{ background: "radial-gradient(900px 520px at 22% 8%, var(--vp-glow-a), transparent 65%), radial-gradient(800px 600px at 78% 100%, var(--vp-glow-b), transparent 60%), var(--vp-base)" }}
    >
      <canvas ref={ref} className="absolute inset-0 size-full" role="img" aria-label="Viewport: illustrative domain wall in the film" />
    </div>
  )
}
