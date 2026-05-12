/**
 * ViewportHost — Layer 8
 *
 * Unified component that wraps ViewportRouter and resolves
 * `componentKey` → concrete JSX elements. This is the replacement
 * path for the legacy `ViewportCanvasArea` monolith.
 *
 * The host receives bridge props and delegates them to whichever
 * view presenter the router resolves.
 */

"use client";

import { memo, useCallback, type ReactNode } from "react";
import { ViewportRouter, type ViewportRouterProps } from "../routing/ViewportRouter";
import type { ViewRegistryEntry, WorkspaceViewContext } from "../registry/viewRegistry";
import type { ViewHostProps } from "../routing/viewportBridgeTypes";

// ── Component-key → lazy render map ──────────────────────────

/**
 * A render function that maps component keys to JSX.
 * Consumers inject this via props to avoid circular imports
 * between the viewport-core feature and concrete scene renderers.
 */
export type ComponentKeyRenderer = (
  componentKey: string,
  hostProps: ViewHostProps,
) => ReactNode;

// ── Props ────────────────────────────────────────────────────

export interface ViewportHostProps extends ViewHostProps {
  /** Current workspace view context for the view registry. */
  context: WorkspaceViewContext;
  /**
   * Map from `ViewRegistryEntry.componentKey` → concrete JSX.
   * Each presenter receives the bridge props.
   */
  renderComponent: ComponentKeyRenderer;
  /** Fallback when no component key matches. */
  fallback?: ReactNode;
}

// ── Component ────────────────────────────────────────────────

export const ViewportHost = memo(function ViewportHost({
  context,
  renderComponent,
  fallback,
  selection,
  selectionActions,
  overlays,
  diagnosticFlags,
}: ViewportHostProps) {
  const hostProps: ViewHostProps = {
    selection,
    selectionActions,
    overlays,
    diagnosticFlags,
  };

  const renderView = useCallback(
    (entry: ViewRegistryEntry): ReactNode => {
      const rendered = renderComponent(entry.componentKey, hostProps);
      return rendered ?? fallback ?? null;
    },
    [renderComponent, hostProps, fallback],
  );

  return <ViewportRouter context={context} renderView={renderView} />;
});
