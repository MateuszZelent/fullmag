import { readStudyStageSource } from "@/shared/domain/study/studyStageSource";

interface StageOption {
  id: string;
  label: string;
  enabled: boolean;
  groupIds: string[];
}

export interface FrozenSpinsStageCatalog {
  ready: boolean;
  error: string | null;
  options: StageOption[];
}

/** Activation accepts group IDs as well as leaves; runtime execution IDs are unrelated. */
export function frozenSpinsStageCatalog(study: unknown, ready: boolean): FrozenSpinsStageCatalog {
  const source = readStudyStageSource(study);
  if (source.kind === "invalid") return { ready: false, error: source.error, options: [] };
  if (source.kind !== "pipeline") return { ready, error: null, options: [] };
  const document = (study as { study_pipeline: { nodes?: Record<string, unknown>[] } }).study_pipeline;
  const options: StageOption[] = [];
  const visit = (nodes: Record<string, unknown>[], enabled: boolean, groupIds: string[]) => {
    for (const node of nodes) {
      const id = node.id as string; // Validated by the canonical authoring source reader above.
      const active = enabled && node.enabled !== false;
      const kind = node.node_kind === "group" ? "group" : String(node.stage_kind ?? node.macro_kind);
      const name = typeof node.label === "string" && node.label ? `${node.label} (${id})` : id;
      options.push({ id, label: `${name} · ${kind}${active ? "" : " · disabled"}`, enabled: active, groupIds: [...groupIds] });
      if (node.node_kind === "group") visit((node.children ?? []) as Record<string, unknown>[], active, [...groupIds, id]);
    }
  };
  visit(document.nodes ?? [], true, []);
  return { ready, error: null, options };
}

export function frozenSpinsStageIssue(ids: readonly string[], catalog: FrozenSpinsStageCatalog): string | undefined {
  if (!catalog.ready) return catalog.error ?? "Confirm the current study stage catalog before using selected stages.";
  if (!ids.length || ids.some((id) => !id.trim())) return "Select at least one activation stage.";
  if (new Set(ids).size !== ids.length) return "Activation stage IDs must be unique. Remove duplicate entries.";
  const missing = ids.find((id) => !catalog.options.some((option) => option.id === id));
  return missing === undefined ? undefined : `Activation stage is unavailable: ${missing}`;
}
