"use client";

import { useMemo, type KeyboardEvent } from "react";
import { Copy, X } from "lucide-react";

import { usePlanarActiveTool, usePlanarCursorUv, type PlanarCursorUv } from "@/kernel/visualization/planarToolStore";
import { Button } from "@/shared/ui/Button";

import { usePlanarNodeProbes, type PlanarFieldLayerRuntime, type PlanarNodeProbeResult } from "../hooks/usePlanarNodeProbes";
import { uvToCanvasPercent } from "../model/planarToolGeometry";
import { PlanarNodeRing } from "../renderer/PlanarToolOverlay";
import { resultHeading, resultRows, planarNodeReadoutText } from "./PlanarNodeReadout.model";

type UvBounds = readonly [number, number, number, number];

export interface PlanarNodeReadoutProps {
  results: readonly PlanarNodeProbeResult[];
  pinned: boolean;
  /** Anchor in percent of the canvas box. */
  anchor: { left: number; top: number };
  formatPosition: (uv: PlanarCursorUv) => string;
  formatLength: (metres: number) => string;
  onClose?: () => void;
}

/**
 * Nearest-node reading of the visible layers (plan §2.3): one block per
 * occupied layer, in list order. The pinned variant can copy its values and
 * be closed (button or Escape).
 */
export function PlanarNodeReadout({
  results,
  pinned,
  anchor,
  formatPosition,
  formatLength,
  onClose,
}: PlanarNodeReadoutProps) {
  const name = pinned ? "Pinned planar probe" : "Planar node readout";
  // Keep the card inside the canvas: open towards the larger free side.
  const className = [
    "fm-planar-node-readout",
    pinned ? "fm-planar-node-readout--pinned" : null,
    anchor.left > 55 ? "fm-planar-node-readout--flip-x" : null,
    anchor.top > 55 ? "fm-planar-node-readout--flip-y" : null,
  ].filter(Boolean).join(" ");
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape" || !onClose) return;
    event.preventDefault();
    event.stopPropagation();
    onClose();
  };
  return (
    <div
      className={className}
      data-planar-node-readout={pinned ? "pinned" : "hover"}
      role="group"
      aria-label={name}
      style={{ left: `${Math.min(100, Math.max(0, anchor.left))}%`, top: `${Math.min(100, Math.max(0, anchor.top))}%` }}
      onKeyDown={onKeyDown}
    >
      <table aria-label={name} className="fm-planar-node-readout__table">
        <caption>{name}</caption>
        {results.length === 0 ? (
          <tbody>
            <tr><td colSpan={2}>No visible field layer at this point</td></tr>
          </tbody>
        ) : results.map((result) => (
          <tbody key={result.layerId} data-planar-node-status={result.status}>
            <tr>
              <th className="fm-planar-node-readout__heading" colSpan={2} scope="colgroup">{resultHeading(result)}</th>
            </tr>
            {resultRows(result, formatPosition, formatLength).map((row) => (
              <tr key={row.label}>
                <th scope="row">{row.label}</th>
                <td>{row.text}</td>
              </tr>
            ))}
          </tbody>
        ))}
      </table>
      {pinned ? (
        <span className="fm-planar-node-readout__actions">
          <Button
            aria-label="Copy probe values"
            size="icon"
            type="button"
            variant="ghost"
            onClick={() => {
              void globalThis.navigator?.clipboard?.writeText(
                planarNodeReadoutText(results, formatPosition, formatLength),
              );
            }}
          >
            <Copy aria-hidden="true" size={12} />
          </Button>
          {onClose ? (
            <Button aria-label="Close pinned probe" size="icon" type="button" variant="ghost" onClick={onClose}>
              <X aria-hidden="true" size={12} />
            </Button>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}

export interface PlanarNodeInspectorProps {
  layers: readonly PlanarFieldLayerRuntime[];
  viewport: UvBounds;
  pinned: PlanarCursorUv | null;
  onClosePinned: () => void;
  formatPosition: (uv: PlanarCursorUv) => string;
  formatLength: (metres: number) => string;
}

/**
 * The inspect tool's canvas layer: a hover readout that follows the cursor
 * while the tool is active and a pinned readout that stays after a tool
 * change, each with node rings. It subscribes to the cursor itself so the
 * pointer never re-renders the 2D module.
 */
export function PlanarNodeInspector({
  layers,
  viewport,
  pinned,
  onClosePinned,
  formatPosition,
  formatLength,
}: PlanarNodeInspectorProps) {
  const activeTool = usePlanarActiveTool();
  const cursor = usePlanarCursorUv();
  const hovering = activeTool === "inspect" && cursor !== null;
  const hover = usePlanarNodeProbes({ enabled: hovering, layers, uv: hovering ? cursor : null });
  const pinnedResults = usePlanarNodeProbes({ enabled: pinned !== null, layers, uv: pinned });
  // One ring per probed layer and readout; layer ids are unique in the list.
  const rings = useMemo(() => {
    const ringOf = (readout: "hover" | "pinned") => (result: PlanarNodeProbeResult) =>
      result.node ? [{ key: `${readout}:${result.layerId}`, node: result.node }] : [];
    return [...(hovering ? hover.flatMap(ringOf("hover")) : []), ...pinnedResults.flatMap(ringOf("pinned"))];
  }, [hover, hovering, pinnedResults]);
  return (
    <>
      {rings.map(({ key, node }) => (
        <PlanarNodeRing key={key} node={node} viewport={viewport} />
      ))}
      {pinned ? (
        <PlanarNodeReadout
          anchor={uvToCanvasPercent(pinned.u_m, pinned.v_m, viewport)}
          formatLength={formatLength}
          formatPosition={formatPosition}
          pinned
          results={pinnedResults}
          onClose={onClosePinned}
        />
      ) : null}
      {hovering && cursor ? (
        <PlanarNodeReadout
          anchor={uvToCanvasPercent(cursor.u_m, cursor.v_m, viewport)}
          formatLength={formatLength}
          formatPosition={formatPosition}
          pinned={false}
          results={hover}
        />
      ) : null}
    </>
  );
}
