import { type FrequencyDomainResponsePointAction } from "../FrequencyDomainTables";

export function buildFrequencyResponsePlotCommandInput({
  fieldId,
  frequencyIndex,
  label,
  phaseRad,
  view,
}: {
  fieldId: string;
  frequencyIndex?: number | null;
  label: string;
  phaseRad: number;
  view: FrequencyDomainResponsePointAction;
}) {
  return {
    fieldId,
    ...(frequencyIndex == null ? {} : { frequencyIndex }),
    label,
    phaseRad,
    source: "frequency-response" as const,
    view,
  };
}
