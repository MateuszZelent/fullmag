import type { SceneResource } from "@/kernel/api/apiTypes";

export type AntennaCompositionKind =
  | "conductor"
  | "port"
  | "solution"
  | "projection"
  | "drive"
  | "spectrum";

type AntennaSolveStage = NonNullable<
  SceneResource["antenna_field_solve_stages"]
>[number];
type AntennaProjection = NonNullable<
  SceneResource["antenna_target_projections"]
>[number];
type AntennaDrive = NonNullable<SceneResource["solved_antenna_drives"]>[number];
type AntennaSpectrumRequest = NonNullable<
  SceneResource["antenna_spectrum_requests"]
>[number];

export interface AntennaRuntimeIds {
  solutionId: string | null;
  spectrumOutputId: string | null;
  stageId: string | null;
}

function fieldSolutionOutputId(stage: AntennaSolveStage | undefined): string | null {
  return (
    stage?.outputs.find((output) => output.quantity === "H_ant_basis")?.id ??
    null
  );
}

export function resolveAntennaRuntimeIds(
  kind: AntennaCompositionKind | null,
  resourceId: string | null,
  scene: SceneResource | null,
): AntennaRuntimeIds {
  if (!kind || !resourceId || !scene) {
    return { solutionId: null, spectrumOutputId: null, stageId: null };
  }

  switch (kind) {
    case "solution": {
      const stage = scene.antenna_field_solve_stages?.find(
        (candidate) => candidate.id === resourceId,
      ) as AntennaSolveStage | undefined;
      return {
        solutionId: fieldSolutionOutputId(stage),
        spectrumOutputId: null,
        stageId: stage?.id ?? null,
      };
    }
    case "projection": {
      const projection = scene.antenna_target_projections?.find(
        (candidate) => candidate.id === resourceId,
      ) as AntennaProjection | undefined;
      return {
        solutionId: projection?.solution.output_id ?? null,
        spectrumOutputId: null,
        stageId: projection?.solution.stage_id ?? null,
      };
    }
    case "drive": {
      const drive = scene.solved_antenna_drives?.find(
        (candidate) => candidate.id === resourceId,
      ) as AntennaDrive | undefined;
      const projection = scene.antenna_target_projections?.find(
        (candidate) => candidate.id === drive?.projection_ref,
      ) as AntennaProjection | undefined;
      return {
        solutionId: projection?.solution.output_id ?? null,
        spectrumOutputId: null,
        stageId: projection?.solution.stage_id ?? null,
      };
    }
    case "spectrum": {
      const request = scene.antenna_spectrum_requests?.find(
        (candidate) => candidate.id === resourceId,
      ) as AntennaSpectrumRequest | undefined;
      return {
        solutionId: request?.solution_ref.output_id ?? null,
        spectrumOutputId: request?.output_id ?? null,
        stageId: request?.solution_ref.stage_id ?? null,
      };
    }
    case "conductor":
    case "port":
      return { solutionId: null, spectrumOutputId: null, stageId: null };
  }
}
