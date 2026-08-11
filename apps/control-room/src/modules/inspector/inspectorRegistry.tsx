import type { Selection } from "@/kernel/selection/selectionTypes";

import { resolveInspectorRoute } from "./inspectorRouteCatalog";
import type { InspectorPanelContribution } from "./inspectorTypes";

export { FREQUENCY_DOMAIN_INSPECTOR_SELECTION_KINDS } from "./inspectorRouteCatalog";
export {
  PBC_INSPECTOR_CONTEXT_IDS,
  resolvePbcInspectorContext,
} from "./panels/pbcInspectorModel";
export type {
  PbcInspectorContext,
  PbcInspectorContextModel,
} from "./panels/pbcInspectorModel";

export function resolveInspectorPanel(
  selection: Pick<Selection, "kind">,
): InspectorPanelContribution | null {
  if (!selection.kind) return null;
  return resolveInspectorRoute(selection.kind)?.contribution ?? null;
}
