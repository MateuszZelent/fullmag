/**
 * @module shell
 *
 * Ribbon registry — declarative ribbon group contributions.
 */

export {
  registerRibbonContribution,
  resolveRibbonGroups,
  resolveContextualGroups,
  suggestedTabForDomain,
  clearContributions,
  allContributions,
  type RibbonAction,
  type RibbonGroup,
  type RibbonTabId,
  type ContextualTabId,
  type RibbonContribution,
  type RibbonBuildContext,
} from "./registry/ribbonRegistry";
