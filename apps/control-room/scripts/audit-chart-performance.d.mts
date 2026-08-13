export function buildChartAuditSurfacePlan(): ReadonlyArray<{
  id: "dynamics" | "resonance-fmr" | "dispersion" | "comparison";
  label: string;
}>;
export function hasChartOwnedAnimationFrameWork(input: {
  activeFrames: number;
  callbacks: number;
}): boolean;
