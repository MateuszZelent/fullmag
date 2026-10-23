import type { FrozenSpinsDefinition } from "@/kernel/api/apiTypes";

/** Selector changes are atomic: raw text has no canonical AST value yet. */
export function reconcileFrozenSpinsDraft(
  baseline: FrozenSpinsDefinition,
  incoming: FrozenSpinsDefinition,
  draft: FrozenSpinsDefinition,
  hasNumericEdits: boolean,
): { draft: FrozenSpinsDefinition; conflict: boolean } {
  const result: Record<string, unknown> = { ...incoming };
  let conflict = false;
  const keys = new Set([...Object.keys(baseline), ...Object.keys(incoming), ...Object.keys(draft)]);
  for (const key of keys) {
    const field = key as keyof FrozenSpinsDefinition;
    const localChanged = JSON.stringify(draft[field]) !== JSON.stringify(baseline[field]);
    const serverChanged = JSON.stringify(incoming[field]) !== JSON.stringify(baseline[field]);
    const rawSelectorConflict = key === "selector" && hasNumericEdits && serverChanged;
    if (rawSelectorConflict || (localChanged && serverChanged && JSON.stringify(draft[field]) !== JSON.stringify(incoming[field]))) {
      conflict = true;
    }
    if (localChanged || rawSelectorConflict) result[key] = draft[field];
  }
  const next = result as FrozenSpinsDefinition;
  return { draft: JSON.stringify(next) === JSON.stringify(draft) ? draft : next, conflict };
}
