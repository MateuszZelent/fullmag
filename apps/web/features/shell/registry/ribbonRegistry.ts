/**
 * @module shell/registry/ribbonRegistry
 *
 * Registry-based ribbon group construction.
 *
 * Instead of a monolithic `build<Tab>Groups()` per tab, each feature
 * module registers its ribbon contributions declaratively.  The
 * RibbonBar resolves contributions at render time using:
 *
 *   1. Active tab → which ribbon groups to show
 *   2. Selected NodeKind → which contextual groups to inject
 *   3. Capability flags → which actions are enabled
 *
 * Contribution files live under `../contributions/` and are
 * auto-registered via `../contributions/index.ts`.
 */

import type { ReactNode } from "react";
import type { NodeKind, NodeDomain } from "../../model-builder/types";
import type { StudyNodeContext } from "@/lib/study-builder/node-context";
import type { RibbonCommand } from "@/components/shell/ribbon/command-registry";
import type { CapabilityMap } from "@/src/api/types";

// ---------------------------------------------------------------------------
// Core ribbon types — canonical, used by contributions AND the renderer
// ---------------------------------------------------------------------------

export interface RibbonMenuItem {
  id: string;
  label: string;
  icon?: ReactNode;
  description?: string;
  disabled?: boolean;
  hidden?: boolean;
  active?: boolean;
  separator?: boolean;
  action?: () => void;
}

export interface RibbonAction {
  id: string;
  icon: ReactNode;
  label: string;
  tooltip?: string;
  shortcut?: string;
  disabled?: boolean;
  hidden?: boolean;
  active?: boolean;
  accent?: boolean;
  iconColor?: string;
  action?: () => void;
  menuItems?: RibbonMenuItem[];
}

export interface RibbonGroup {
  id: string;
  title: string;
  subtitle?: string;
  tone?: "neutral" | "authoring" | "compose" | "compute" | "selection" | "sync";
  actions: RibbonAction[];
}

// ---------------------------------------------------------------------------
// Ribbon Tab
// ---------------------------------------------------------------------------

export type RibbonTabId =
  | "home"
  | "definitions"
  | "geometry"
  | "materials"
  | "physics"
  | "mesh"
  | "study"
  | "results"
  | "automation";

export type ContextualTabId =
  | "interface"
  | "work-plane"
  | "mesh-quality"
  | "plot"
  | "table";

// ---------------------------------------------------------------------------
// Contribution descriptor
// ---------------------------------------------------------------------------

/**
 * A ribbon contribution is a factory that produces groups for a
 * specific tab.  The factory receives a rich, read-only context bag
 * so it stays decoupled from `RibbonBarProps`.
 */
export interface RibbonContribution {
  /** Which tab this contribution targets. */
  tab: RibbonTabId | ContextualTabId;
  /**
   * Optional: only show this contribution when the tree selection
   * matches one of these NodeKinds.  Omit for always-visible groups.
   */
  forNodeKinds?: NodeKind[];
  /**
   * Optional: only show when the selection domain matches.
   */
  forDomain?: NodeDomain;
  /** Priority for ordering among contributions on the same tab. */
  priority?: number;
  /**
   * Factory that builds the groups.
   */
  buildGroups: (ctx: RibbonBuildContext) => RibbonGroup[];
}

/**
 * Rich, read-only context passed to contribution factories.
 *
 * Carries all state a contribution may need to build its groups.
 * Dispatch helpers execute commands through the existing command registry.
 */
export interface RibbonBuildContext {
  // ── Core solver/execution state ──
  isFemBackend: boolean;
  domainCapabilities: CapabilityMap | null;
  canRun: boolean;
  canRelax: boolean;
  canPause: boolean;
  canStop: boolean;
  canSkip: boolean;
  runAction: string;
  runLabel: string;

  // ── Mesh state ──
  meshGenerating: boolean;
  meshConfigDirty: boolean;
  meshTargetLabel: string | null;

  // ── Selection state ──
  selectedObjectId: string | null;
  selectedNodeId: string | null;
  selectedNodeKind: NodeKind | null;
  activeTransformScope: "object" | "texture" | null;

  // ── Viewport state ──
  viewMode: string | null;
  sidebarVisible: boolean;
  previewPending: boolean;

  // ── Study context ──
  studyNodeContext: StudyNodeContext | null;

  // ── Results/preview context ──
  quickPreviewTargets: Array<{
    id: string;
    shortLabel: string;
    available: boolean;
  }>;
  selectedQuantity: string | null;

  // ── Antenna context ──
  antennaSources: Array<{
    name: string;
    kind: string;
    currentA: number;
  }>;
  selectedAntennaName: string | null;

  // ── Script sync state ──
  canSyncScriptBuilder: boolean;
  scriptSyncBusy: boolean;

  // ── Command dispatch ──
  /** Execute a ribbon command. */
  run: (command: RibbonCommand) => void;
  /** Check whether a command can currently execute. */
  can: (command: RibbonCommand) => boolean;

  // ── Geometry Builder state ──
  builderEnabled: boolean;
  builderDirtyGeometry: boolean;
  builderDirtyMesh: boolean;
  builderHasRealization: boolean;
  builderSelectedPrimitiveId: string | null;
}

// ---------------------------------------------------------------------------
// Registry storage
// ---------------------------------------------------------------------------

const contributions: RibbonContribution[] = [];

// ---------------------------------------------------------------------------
// Registration API
// ---------------------------------------------------------------------------

/**
 * Register a ribbon contribution.
 * Typically called at module-init time inside a feature's `registry/` folder.
 *
 * @example
 * registerRibbonContribution({
 *   tab: "mesh",
 *   forDomain: "build",
 *   priority: 50,
 *   buildGroups: (ctx) => [{
 *     id: "mesh-ops",
 *     title: "Mesh Operations",
 *     actions: [
 *       { id: "mesh-build-all", label: "Build All", icon: "grid-3x3",
 *         disabled: ctx.meshGenerating,
 *         execute: () => ctx.dispatch("mesh.build-all") },
 *     ],
 *   }],
 * });
 */
export function registerRibbonContribution(contribution: RibbonContribution): void {
  contributions.push(contribution);
}

// ---------------------------------------------------------------------------
// Resolution API
// ---------------------------------------------------------------------------

/**
 * Resolve all registered contributions for a given tab + selection.
 *
 * Returns an ordered list of RibbonGroup[], ready to render.
 */
export function resolveRibbonGroups(
  tab: RibbonTabId | ContextualTabId,
  ctx: RibbonBuildContext,
): RibbonGroup[] {
  const matching = contributions
    .filter((c) => {
      if (c.tab !== tab) return false;
      if (c.forNodeKinds && ctx.selectedNodeKind && !c.forNodeKinds.includes(ctx.selectedNodeKind))
        return false;
      // Domain filtering (optional)
      // (domain check is intentionally relaxed — only filters if both are set)
      return true;
    })
    .sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));

  return matching.flatMap((c) => c.buildGroups(ctx));
}

/**
 * Resolve contextual groups that should appear regardless of active tab.
 * These are contributions targeting contextual tabs whose `forNodeKinds`
 * match the current selection.
 */
export function resolveContextualGroups(ctx: RibbonBuildContext): RibbonGroup[] {
  const contextualTabs: ContextualTabId[] = [
    "interface",
    "work-plane",
    "mesh-quality",
    "plot",
    "table",
  ];

  return contextualTabs.flatMap((tab) => resolveRibbonGroups(tab, ctx));
}

// ---------------------------------------------------------------------------
// Suggested tab for a given NodeKind
// ---------------------------------------------------------------------------

const DOMAIN_TO_TAB: Record<NodeDomain, RibbonTabId> = {
  build:   "geometry",
  study:   "study",
  analyze: "results",
  results: "results",
  global:  "home",
};

/**
 * Suggest the most relevant ribbon tab for a given node domain.
 * Used for auto-tab-switching when the tree selection changes.
 */
export function suggestedTabForDomain(domain: NodeDomain): RibbonTabId {
  return DOMAIN_TO_TAB[domain] ?? "home";
}

// ---------------------------------------------------------------------------
// Dev / testing helpers
// ---------------------------------------------------------------------------

/**
 * Return all registered contributions (for Storybook / tests).
 */
export function allContributions(): readonly RibbonContribution[] {
  return contributions;
}

/**
 * Clear all contributions (for test isolation).
 */
export function clearContributions(): void {
  contributions.length = 0;
}
