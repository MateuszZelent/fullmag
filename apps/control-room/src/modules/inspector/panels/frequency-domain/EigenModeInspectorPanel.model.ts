export interface EigenModeIdentityViewModel {
  branchId: string | null;
  fieldId: string | null;
  label: string;
  modeIndex: number | null;
  resourceRef: string | null;
  sampleIndex: number | null;
}

export function buildEigenModeIdentityViewModel(input: {
  branchId?: string | null;
  fieldId?: string | null;
  modeIndex?: number | null;
  resourceRef?: string | null;
  sampleIndex?: number | null;
}): EigenModeIdentityViewModel {
  const sampleIndex = input.sampleIndex ?? null;
  const modeIndex = input.modeIndex ?? null;
  return {
    branchId: input.branchId ?? null,
    fieldId: input.fieldId ?? null,
    label:
      sampleIndex == null || modeIndex == null
        ? "not selected"
        : `sample ${sampleIndex}, mode ${modeIndex}`,
    modeIndex,
    resourceRef: input.resourceRef ?? null,
    sampleIndex,
  };
}
