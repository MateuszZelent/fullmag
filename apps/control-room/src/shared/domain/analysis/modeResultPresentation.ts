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

interface ModeResultOwner {
  fieldId?: string | null;
  analysisRunId?: string | null;
  analysisStageId?: string | null;
  artifactRevision?: string | number | null;
  sampleIndex?: number | null;
  modeIndex?: number | null;
}

/** A field ID is reused across runs: appearance must belong to the selected artifact. */
export function sameModeResultOwner(a: ModeResultOwner | null | undefined, b: ModeResultOwner | null | undefined): boolean {
  if (!a || !b || !a.fieldId || !a.analysisRunId || !a.analysisStageId || a.artifactRevision == null || a.sampleIndex == null || a.modeIndex == null) return false;
  return a.fieldId === b.fieldId && a.analysisRunId === b.analysisRunId && a.analysisStageId === b.analysisStageId && String(a.artifactRevision) === String(b.artifactRevision) && a.sampleIndex === b.sampleIndex && a.modeIndex === b.modeIndex;
}
