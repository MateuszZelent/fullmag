import { formatFrequencyHz } from "./frequencyUnits";

/** Display only: never use a rounded label as a sample or branch identity. */
export function formatModeWavevector(value: unknown): string {
  if (!Array.isArray(value) || value.length !== 3 || !value.every(v => typeof v === "number" && Number.isFinite(v))) return "Wavevector not published";
  if (value.every(v => v === 0)) return "Γ · k = 0";
  const active = value.flatMap((v, i) => v === 0 ? [] : [i]);
  const number = (v: number) => Number((v / 1e6).toPrecision(5)).toString();
  if (active.length === 1) {
    const i = active[0];
    return `k${["ₓ", "ᵧ", "z"][i]} = ${value[i] > 0 ? "+" : ""}${number(value[i])} rad/µm`;
  }
  return `k = (${value.map(number).join(", ")}) rad/µm`;
}

export function modeResultLabel(wavevector: unknown, frequencyHz: number | null | undefined): string {
  return `${formatModeWavevector(wavevector)} · ${formatFrequencyHz(frequencyHz)}`;
}
