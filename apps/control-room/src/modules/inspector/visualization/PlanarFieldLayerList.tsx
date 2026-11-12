"use client";

import { useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import { Eye, EyeOff, GripVertical, MoveUpRight, Plus, Square, Trash2 } from "lucide-react";

import { isDirectionColormap } from "@/shared/visualization/directionColor";
import { Button } from "@/shared/ui/Button";

import {
  effectivePass,
  moveFieldLayer,
  patchFieldLayer,
  PLANAR_FIELD_LAYERS_MAX,
  removeFieldLayer,
  layerPassFlag,
  layerPassPatch,
  layerVisible,
  type PlanarFieldLayer,
  type PlanarFieldLayerTarget,
  type PlanarLayerPass,
  type PlanarLayerState,
} from "./planarFieldLayers";

export interface PlanarFieldLayerCandidate {
  /** Layer id the target would own (`all`, `airbox`, `object:<id>`). */
  id: string;
  label: string;
  target: PlanarFieldLayerTarget;
}

export const PLANAR_FIELD_LAYERS_FULL_REASON =
  `The 2D view holds at most ${PLANAR_FIELD_LAYERS_MAX} field layers. Remove a layer to add another.`;

/** Short component name of a layer row; direction colouring names the direction. */
export function planarLayerComponentLabel(layer: PlanarFieldLayer): string {
  return isDirectionColormap(layer.colormap) ? "direction" : String(layer.component).replaceAll("_", " ");
}

export function planarLayerRowLabel(layer: PlanarFieldLayer, targetLabel: string): string {
  return `${targetLabel} · ${layer.quantity_id} · ${planarLayerComponentLabel(layer)}`;
}

/**
 * Ordered field layers of the 2D view (spec 23 §5). The first row is drawn on
 * top. Every edit sends the complete list with the touched layer id.
 */
export function PlanarFieldLayerList({
  candidates,
  layers,
  selectedLayerId,
  targetLabel,
  viewMasks,
  onAdd,
  onSelect,
  onWrite,
}: {
  /** Targets without a layer, in menu order (All objects, Airbox, objects). */
  candidates: readonly PlanarFieldLayerCandidate[];
  layers: readonly PlanarFieldLayer[];
  selectedLayerId: string | null;
  targetLabel: (layer: PlanarFieldLayer) => string;
  viewMasks: PlanarLayerState;
  onAdd: (candidate: PlanarFieldLayerCandidate) => void;
  onSelect: (layerId: string) => void;
  onWrite: (layers: PlanarFieldLayer[], touchedLayerId: string) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const draggedId = useRef<string | null>(null);
  const full = layers.length >= PLANAR_FIELD_LAYERS_MAX;

  const move = (id: string, toIndex: number) => {
    const next = moveFieldLayer(layers, id, toIndex);
    if (next.every((layer, index) => layer.id === layers[index]?.id)) return;
    onWrite(next, id);
  };
  const patch = (id: string, value: Partial<PlanarFieldLayer>) => onWrite(patchFieldLayer(layers, id, value), id);

  const onRowKeyDown = (event: KeyboardEvent<HTMLLIElement>, index: number, id: string) => {
    if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
    event.preventDefault();
    move(id, index + (event.key === "ArrowUp" ? -1 : 1));
  };
  const onDrop = (event: DragEvent<HTMLLIElement>, index: number) => {
    event.preventDefault();
    const id = draggedId.current ?? event.dataTransfer?.getData("text/plain") ?? null;
    draggedId.current = null;
    if (id) move(id, index);
  };

  const toggleMenu = () => {
    if (full) {
      setMenuOpen(false);
      setRefusal(PLANAR_FIELD_LAYERS_FULL_REASON);
      return;
    }
    setRefusal(null);
    setMenuOpen((open) => !open);
  };

  const passChip = (layer: PlanarFieldLayer, label: string, pass: PlanarLayerPass) => {
    const state = effectivePass(layer, viewMasks, pass);
    const configured = layerPassFlag(layer, pass);
    const name = targetLabel(layer);
    return (
      <button
        aria-label={`${label} for ${name}`}
        aria-pressed={state !== "off"}
        className={`fm-planar-layer-row__chip${state !== "off" ? " fm-planar-layer-row__chip--on" : ""}`}
        data-pass-state={state}
        disabled={!layerVisible(layer)}
        title={state === "masked" ? `${label}: hidden in the toolbar` : label}
        type="button"
        onClick={() => patch(layer.id, layerPassPatch(pass, !configured))}
      >
        {pass === "raster"
          ? <Square aria-hidden="true" size={13} strokeWidth={1.75} />
          : <MoveUpRight aria-hidden="true" size={13} strokeWidth={1.75} />}
      </button>
    );
  };

  return (
    <div className="fm-planar-layer-list" data-slot="planar-field-layer-list">
      {layers.length === 0 ? (
        <p className="fm-planar-layer-list__empty">No field layers. The 2D view shows only the section frame.</p>
      ) : (
        <ul aria-label="Field layers" className="fm-planar-layer-list__rows">
          {layers.map((layer, index) => {
            const name = targetLabel(layer);
            const visible = layerVisible(layer);
            const selected = layer.id === selectedLayerId;
            return (
              <li
                key={layer.id}
                aria-current={selected ? "true" : undefined}
                className="fm-planar-layer-row"
                data-layer-id={layer.id}
                data-selected={selected || undefined}
                data-visible={visible}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => onDrop(event, index)}
                onKeyDown={(event) => onRowKeyDown(event, index, layer.id)}
              >
                <span
                  aria-label={`Reorder ${name}. Alt+Up or Alt+Down moves the layer.`}
                  className="fm-planar-layer-row__handle"
                  draggable
                  role="img"
                  onDragEnd={() => { draggedId.current = null; }}
                  onDragStart={(event) => {
                    draggedId.current = layer.id;
                    event.dataTransfer?.setData("text/plain", layer.id);
                  }}
                >
                  <GripVertical aria-hidden="true" size={14} strokeWidth={1.75} />
                </span>
                <button
                  aria-label={`${visible ? "Hide" : "Show"} ${name}`}
                  aria-pressed={visible}
                  className="fm-planar-layer-row__eye"
                  type="button"
                  onClick={() => patch(layer.id, { visible: !visible })}
                >
                  {visible
                    ? <Eye aria-hidden="true" size={14} strokeWidth={1.75} />
                    : <EyeOff aria-hidden="true" size={14} strokeWidth={1.75} />}
                </button>
                <button
                  aria-label={`Edit ${planarLayerRowLabel(layer, name)}`}
                  className="fm-planar-layer-row__label"
                  type="button"
                  onClick={() => onSelect(layer.id)}
                >
                  {planarLayerRowLabel(layer, name)}
                </button>
                {passChip(layer, "Raster", "raster")}
                {passChip(layer, "Vectors", "vectors")}
                <button
                  aria-label={`Remove ${name}`}
                  className="fm-planar-layer-row__remove"
                  type="button"
                  onClick={() => onWrite(removeFieldLayer(layers, layer.id), layer.id)}
                >
                  <Trash2 aria-hidden="true" size={14} strokeWidth={1.75} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <div className="fm-planar-layer-list__add">
        <Button
          aria-expanded={menuOpen}
          aria-haspopup="menu"
          size="sm"
          type="button"
          variant="secondary"
          onClick={toggleMenu}
        >
          <Plus aria-hidden="true" size={14} /> Add field
        </Button>
        {refusal ? <p className="fm-planar-layer-list__refusal" role="status">{refusal}</p> : null}
        {menuOpen ? (
          candidates.length === 0 ? (
            <p className="fm-planar-layer-list__refusal" role="status">Every target already has a field layer.</p>
          ) : (
            <div aria-label="Add field for" className="fm-planar-layer-list__menu" role="menu">
              {candidates.map((candidate) => (
                <button
                  key={candidate.id}
                  className="fm-planar-layer-list__menu-item"
                  role="menuitem"
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    onAdd(candidate);
                  }}
                >
                  {candidate.label}
                </button>
              ))}
            </div>
          )
        ) : null}
      </div>
    </div>
  );
}
