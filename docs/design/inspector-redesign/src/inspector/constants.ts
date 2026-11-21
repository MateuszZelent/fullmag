export const STAGES = [
  "Set Spin Torque 1", "Relax 2", "Table Autosave 3", "Run 4", "Table Autosave 5",
  "Relax 6", "Table Autosave 7", "Autosave 8", "Set Spin Torque 9", "Run 10",
]

export const QTY: Record<string, string> = { m: "Magnetization m", hd: "Demagnetization field", heff: "Effective field" }

export function cmapGradient(v: string) {
  if (v === "vir") return "linear-gradient(90deg,#440154,#3b528b,#21918c,#5ec962,#fde725)"
  if (v === "hue") return "linear-gradient(90deg,hsl(0 70% 60%),hsl(60 70% 60%),hsl(120 60% 55%),hsl(180 60% 55%),hsl(240 70% 66%),hsl(300 70% 62%),hsl(360 70% 60%))"
  return "linear-gradient(90deg,var(--cm-lo),var(--cm-mid),var(--cm-hi))"
}

export const SWATCHES: [string, string, string][] = [
  ["blue", "Surface magnetic", "var(--h-geometry)"],
  ["mauve", "Mauve", "var(--h-material)"],
  ["teal", "Teal", "var(--h-visualization)"],
  ["peach", "Peach", "var(--h-physics)"],
  ["overlay", "Neutral", "color-mix(in oklab, var(--foreground) 45%, transparent)"],
]
