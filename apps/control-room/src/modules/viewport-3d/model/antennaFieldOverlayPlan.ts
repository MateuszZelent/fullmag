import type { AntennaFieldSolutionResource, AntennaStageOutputCatalogResource } from "@/kernel/api/apiTypes";
import { antennaFieldPayloadEtag } from "@/kernel/resources/antennaResources";
import type { ResourceState } from "@/kernel/resources/resourceState";
import type { AntennaFieldIntent } from "@/kernel/visualization/antennaFieldIntent";

import { antennaDisplayShape } from "./antennaFieldOverlayModel";

export function resolveAntennaBasisOverlayPlan(
  intent: AntennaFieldIntent | null,
  solution: Pick<ResourceState<AntennaFieldSolutionResource>, "data" | "status">,
  catalog: Pick<ResourceState<AntennaStageOutputCatalogResource>, "data" | "status">,
) {
  if (!intent || intent.kind !== "basis" || solution.status !== "ready" || catalog.status !== "ready") return null;
  const data = solution.data;
  const stage = catalog.data;
  const outputs = stage?.outputs.filter((item) => item.output_id === intent.solutionId);
  const output = outputs?.length === 1 ? outputs[0] : null;
  if (!data || !stage || data.status !== "ready" || stage.status !== "ready" ||
      data.solution_id !== intent.solutionId || data.stage_id !== intent.stageId || data.quantity !== "H_ant_basis" ||
      data.source_object_id !== intent.sourceObjectId || data.content_digest !== intent.contentDigest ||
      data.session_id !== intent.sessionId || data.session_epoch !== intent.sessionEpoch || data.request_scope_epoch !== intent.requestScopeEpoch ||
      stage.stage_id !== intent.stageId || stage.session_id !== intent.sessionId || stage.session_epoch !== intent.sessionEpoch || stage.request_scope_epoch !== intent.requestScopeEpoch ||
      output?.solution_ref.content_digest !== intent.contentDigest || output.solution_ref.asset_id !== data.asset_id ||
      output.solution_ref.stage_id !== intent.stageId || output.solution_ref.output_id !== intent.solutionId) return null;
  const bases = data.bases.filter((candidate) => candidate.port_mode_id === intent.portModeId);
  if (bases.length !== 1) return null;
  const basis = bases[0];
  const quantity = intent.quantity;
  if (quantity === "device_potential" || quantity === "current_density" || quantity === "magnetic_field") return null;
  const positionKind = quantity === "magnetic_field_per_ampere" ? "sample_positions" as const : "conductor_positions" as const;
  const positions = data[positionKind];
  const values = basis[quantity];
  try {
    const count = antennaDisplayShape(positions, values, intent);
    return { count, quantity, positionKind, positions, values,
      positionEtag: antennaFieldPayloadEtag(data, positionKind),
      fieldEtag: antennaFieldPayloadEtag(data, quantity, intent.portModeId) };
  } catch { return null; }
}
