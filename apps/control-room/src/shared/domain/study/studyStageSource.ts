/** Read the executable source without overwriting definition IDs with queue IDs. */
export interface StudyStageSourceEntry {
  payload: Record<string, unknown>;
  queueId: string | null;
  stageKind: string | null;
  label: string | null;
  enabled: boolean;
  groupIds: readonly string[];
}

export interface StudyStageSource {
  kind: "flat" | "pipeline" | "invalid";
  entries: StudyStageSourceEntry[];
  error: string | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

export function readStudyStageSource(value: unknown): StudyStageSource {
  const study = record(value);
  const pipeline = study?.study_pipeline;
  if (pipeline === undefined || pipeline === null) {
    const stages = Array.isArray(study?.stages) ? study.stages : [];
    return { kind: "flat", error: null, entries: stages.map((payload) => ({
      payload: record(payload) ?? {}, queueId: null, stageKind: null, label: null,
      enabled: true, groupIds: [],
    })) };
  }
  const document = record(pipeline);
  const entries: StudyStageSourceEntry[] = [];
  const ids = new Set<string>();
  const fail = (error: string): StudyStageSource => ({ kind: "invalid", entries: [], error });
  const nodes = document?.nodes === undefined ? [] : document.nodes;
  const version = document?.version === undefined ? "study_pipeline.v1" : document.version;
  if (!document || version !== "study_pipeline.v1" || !Array.isArray(nodes)) {
    return fail("Unsupported or malformed study pipeline; the dormant flat list is not used.");
  }
  const visit = (nodes: unknown[], enabled: boolean, groups: string[]): string | null => {
    for (const value of nodes) {
      const node = record(value);
      if (!node || typeof node.id !== "string" || !node.id.trim() || ids.has(node.id)) {
        return "Missing or duplicate study pipeline node ID.";
      }
      ids.add(node.id);
      if (node.enabled !== undefined && typeof node.enabled !== "boolean") {
        return "Malformed study pipeline enabled flag.";
      }
      const active = enabled && node.enabled !== false;
      if (node.node_kind === "group") {
        const children = node.children === undefined ? [] : node.children;
        if (!Array.isArray(children)) return "Malformed study pipeline group children.";
        const error = visit(children, active, [...groups, node.id]);
        if (error) return error;
      } else if (node.node_kind === "primitive" || node.node_kind === "macro") {
        const value = node.node_kind === "macro" ? node.config : node.payload;
        const payload = record(value === undefined ? {} : value);
        const stageKind = node.node_kind === "primitive" ? node.stage_kind : node.macro_kind;
        if (!payload || typeof stageKind !== "string" || !stageKind.trim()) {
          return "Malformed study pipeline stage payload or kind.";
        }
        entries.push({ payload, queueId: node.id,
          label: typeof node.label === "string" ? node.label : null,
          stageKind: node.node_kind === "macro" ? `macro:${stageKind}` : stageKind,
          enabled: active, groupIds: [...groups] });
      } else return "Unsupported study pipeline node kind.";
    }
    return null;
  };
  const error = visit(nodes, true, []);
  return error ? fail(error) : { kind: "pipeline", entries, error: null };
}
