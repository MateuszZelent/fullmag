import type {
  AntennaFieldSolutionResource,
  AntennaSourceSpectrumResource,
  AntennaStageOutputCatalogResource,
  SceneResource,
} from "@/kernel/api/apiTypes";

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
  spectrumRequestId: string | null;
  stageId: string | null;
  publishedRef: { assetId: string; contentDigest: string; stageId: string } | null;
}

function fieldSolutionOutputId(stage: AntennaSolveStage | undefined): string | null {
  return (
    stage?.outputs.find((output) => output.quantity === "H_ant_basis")?.id ??
    null
  );
}

function authoredStageId(
  reference: AntennaProjection["solution"] | AntennaSpectrumRequest["solution_ref"] | undefined,
): string | null {
  return reference && "kind" in reference && reference.kind === "stage_output"
    ? reference.stage_id
    : null;
}

function publishedReference(
  reference: AntennaProjection["solution"] | AntennaSpectrumRequest["solution_ref"] | undefined,
): AntennaRuntimeIds["publishedRef"] {
  return reference && "asset_id" in reference && "content_digest" in reference
    ? {
        assetId: reference.asset_id,
        contentDigest: reference.content_digest,
        stageId: reference.stage_id,
      }
    : null;
}

export function antennaFieldSolutionIdentityStatus(
  ids: AntennaRuntimeIds,
  field: { data: AntennaFieldSolutionResource | null; status: string },
  catalog: { data: AntennaStageOutputCatalogResource | null; status: string },
): string {
  if (!ids.solutionId) return "not attached";
  if (field.status !== "ready") return field.status;
  const data = field.data;
  if (!data) return "missing";
  if (data.status !== "ready" || data.solution_id !== ids.solutionId || data.quantity !== "H_ant_basis") {
    return "identity mismatch";
  }
  if (ids.publishedRef) {
    return data.asset_id === ids.publishedRef.assetId &&
      data.content_digest === ids.publishedRef.contentDigest &&
      data.stage_id === ids.publishedRef.stageId
      ? "ready"
      : "identity mismatch";
  }
  if (!ids.stageId || catalog.status !== "ready" || !catalog.data) {
    return "awaiting stage catalog";
  }
  const output = catalog.data.outputs.find((item) => item.output_id === ids.solutionId);
  if (
    catalog.data.status !== "ready" ||
    catalog.data.stage_id !== ids.stageId ||
    catalog.data.session_id !== data.session_id ||
    catalog.data.session_epoch !== data.session_epoch ||
    catalog.data.request_scope_epoch !== data.request_scope_epoch ||
    !output ||
    output.solution_ref.stage_id !== ids.stageId ||
    output.solution_ref.asset_id !== data.asset_id ||
    output.solution_ref.content_digest !== data.content_digest
  ) {
    return "identity mismatch";
  }
  return "ready";
}

export function antennaSpectrumIdentityStatus(
  ids: AntennaRuntimeIds,
  spectrum: { data: AntennaSourceSpectrumResource | null; status: string },
  catalog: { data: AntennaStageOutputCatalogResource | null; status: string },
): string {
  if (!ids.spectrumOutputId || !ids.spectrumRequestId) return "not attached";
  if (spectrum.status !== "ready") return spectrum.status;
  const data = spectrum.data;
  if (!data) return "missing";
  if (
    data.output_id !== ids.spectrumOutputId ||
    data.request_id !== ids.spectrumRequestId ||
    data.solution_id !== ids.solutionId ||
    data.sampling.solution_id !== ids.solutionId
  ) {
    return "identity mismatch";
  }
  if (ids.publishedRef) {
    return data.solution_content_digest === ids.publishedRef.contentDigest
      ? "ready"
      : "identity mismatch";
  }
  if (!ids.stageId || catalog.status !== "ready" || !catalog.data) {
    return "awaiting stage catalog";
  }
  const output = catalog.data.outputs.find((item) => item.output_id === ids.solutionId);
  if (
    catalog.data.status !== "ready" ||
    catalog.data.stage_id !== ids.stageId ||
    catalog.data.session_id !== data.session_id ||
    catalog.data.session_epoch !== data.session_epoch ||
    catalog.data.request_scope_epoch !== data.request_scope_epoch ||
    !output ||
    output.solution_ref.stage_id !== ids.stageId ||
    output.solution_ref.content_digest !== data.solution_content_digest
  ) {
    return "identity mismatch";
  }
  return "ready";
}

export function resolveAntennaRuntimeIds(
  kind: AntennaCompositionKind | null,
  resourceId: string | null,
  scene: SceneResource | null,
): AntennaRuntimeIds {
  if (!kind || !resourceId || !scene) {
    return { solutionId: null, spectrumOutputId: null, spectrumRequestId: null, stageId: null, publishedRef: null };
  }

  switch (kind) {
    case "solution": {
      const stage = scene.antenna_field_solve_stages?.find(
        (candidate) => candidate.id === resourceId,
      ) as AntennaSolveStage | undefined;
      return {
        solutionId: fieldSolutionOutputId(stage),
        spectrumOutputId: null,
        spectrumRequestId: null,
        stageId: stage?.id ?? null,
        publishedRef: null,
      };
    }
    case "projection": {
      const projection = scene.antenna_target_projections?.find(
        (candidate) => candidate.id === resourceId,
      ) as AntennaProjection | undefined;
      return {
        solutionId: projection?.solution.output_id ?? null,
        spectrumOutputId: null,
        spectrumRequestId: null,
        stageId: authoredStageId(projection?.solution),
        publishedRef: publishedReference(projection?.solution),
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
        spectrumRequestId: null,
        stageId: authoredStageId(projection?.solution),
        publishedRef: publishedReference(projection?.solution),
      };
    }
    case "spectrum": {
      const request = scene.antenna_spectrum_requests?.find(
        (candidate) => candidate.id === resourceId,
      ) as AntennaSpectrumRequest | undefined;
      return {
        solutionId: request?.solution_ref.output_id ?? null,
        spectrumOutputId: request?.output_id ?? null,
        spectrumRequestId: request?.id ?? null,
        stageId: authoredStageId(request?.solution_ref),
        publishedRef: publishedReference(request?.solution_ref),
      };
    }
    case "conductor":
    case "port":
      return { solutionId: null, spectrumOutputId: null, spectrumRequestId: null, stageId: null, publishedRef: null };
  }
}
