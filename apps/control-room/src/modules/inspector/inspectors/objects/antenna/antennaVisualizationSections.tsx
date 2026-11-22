"use client";

import type { ReactNode } from "react";

import type { useSessionResourceIdentity } from "@/kernel/resources/useSessionStatus";
import type {
  AntennaFieldIntent,
  AntennaFieldQuantity,
} from "@/kernel/visualization/antennaFieldIntent";
import type {
  useObjectVisualizationController,
  useObjectVisualizationSelector,
} from "@/kernel/visualization/useObjectVisualization";
import { SegmentedControl } from "@/shared/ui/SegmentedControl";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/Select";
import { Switch } from "@/shared/ui/Switch";

import { RadixAntennaColorRangeControl } from "../../../panels/antenna/AntennaExcitationComposers";
import { ANTENNA_BASIS_QUANTITIES } from "../../../panels/antenna/AntennaFieldBasisPreviewModel";
import {
  ANTENNA_CLOSED_LOOP_QUANTITIES,
  ANTENNA_RAW_QUANTITIES,
} from "../../../panels/antenna/AntennaVisualizationQuantity";
import { FieldRow } from "../../../primitives/FieldRow";
import { InspectorPropertyRow } from "../../../primitives/InspectorPropertyRow";
import {
  VisualizationDisplayPassesControl,
  VisualizationRenderModeControl,
  type VisualizationRenderModeValue,
} from "../../../visualization/VisualizationInspectorControls";

export interface AntennaVizHostDraft {
  representation: "inspection" | "basis";
}

type AntennaDisplayStatus = ReturnType<
  typeof useObjectVisualizationSelector<
    ReturnType<
      ReturnType<typeof useObjectVisualizationController>["getSnapshot"]
    >["antennaFieldDisplayStatus"]
  >
>;

export function AntennaBasisDisplayPassControls({
  active,
  available,
  basisAvailable,
  carrierLabel,
  closedLoop,
  currentAvailable,
  displayStatus,
  effectiveQuantity,
  inspectionMode,
  onClearIntent,
  onPatchDisplay,
  onSelectDisplaySource,
  onSelectPort,
  onSelectQuantity,
  perAmpereInspection,
  port,
  ports,
  quantityComponents,
  quantityLabel,
  quantityUnit,
  rawAvailable,
  renderModes,
  renderReason,
  statusReason,
  surfaceAvailable,
}: {
  active: AntennaFieldIntent | null;
  available: boolean | null;
  basisAvailable: boolean;
  carrierLabel: string;
  closedLoop: boolean;
  currentAvailable: boolean;
  displayStatus: AntennaDisplayStatus;
  effectiveQuantity: AntennaFieldQuantity;
  inspectionMode: boolean;
  onClearIntent: () => void;
  onPatchDisplay: (patch: Partial<AntennaFieldIntent>) => void;
  onSelectDisplaySource: (source: string) => void;
  onSelectPort: (portId: string) => void;
  onSelectQuantity: (qty: AntennaFieldQuantity) => void;
  perAmpereInspection: boolean;
  port: string;
  ports: readonly string[];
  quantityComponents: number;
  quantityLabel: string;
  quantityUnit: string;
  rawAvailable: boolean;
  renderModes: Array<VisualizationRenderModeValue | "vectors">;
  renderReason: string;
  statusReason: string;
  surfaceAvailable: boolean;
}): ReactNode {
  const quantityCatalog = inspectionMode
    ? closedLoop
      ? ANTENNA_CLOSED_LOOP_QUANTITIES
      : ANTENNA_RAW_QUANTITIES
    : ANTENNA_BASIS_QUANTITIES;
  const currentRenderMode = active?.surface
    ? active.wireframe
      ? "surface+edges"
      : "surface"
    : active?.wireframe
      ? "wireframe"
      : active?.points
        ? "points"
        : active?.vectors
          ? "vectors"
          : "off";

  return (
    <>
      <VisualizationDisplayPassesControl
        items={[
          {
            disabled: !surfaceAvailable || !port,
            id: "surface",
            label: "Surface",
            onToggle: () => onPatchDisplay({ surface: !active?.surface }),
            pressed: active?.surface ?? false,
          },
          {
            disabled: !surfaceAvailable || !port,
            id: "wireframe",
            label: "Wireframe",
            onToggle: () => onPatchDisplay({ wireframe: !active?.wireframe }),
            pressed: active?.wireframe ?? false,
          },
          {
            disabled: !available || !port,
            id: "points",
            label: "Points",
            onToggle: () => onPatchDisplay({ points: !active?.points }),
            pressed: active?.points ?? false,
          },
          {
            disabled: !available || !port || quantityComponents === 1,
            id: "vectors",
            label: "Vectors",
            onToggle: () => onPatchDisplay({ vectors: !active?.vectors }),
            pressed: active?.vectors ?? false,
          },
        ]}
      />

      <VisualizationRenderModeControl
        disabled={!available || !port}
        options={renderModes}
        value={currentRenderMode}
        onValueChange={(val) =>
          onPatchDisplay({
            points: val === "points",
            surface: val === "surface" || val === "surface+edges",
            vectors:
              val === "vectors"
                ? true
                : val === "off"
                  ? false
                  : (active?.vectors ?? false),
            wireframe: val === "wireframe" || val === "surface+edges",
          })
        }
      />

      <InspectorPropertyRow label="Antenna quantity">
        <Select
          disabled={!available}
          value={effectiveQuantity}
          onValueChange={(val) => {
            const nextQty = val as AntennaFieldQuantity;
            onSelectQuantity(nextQty);
            onPatchDisplay({
              quantity: nextQty,
              surface: false,
              vectors:
                nextQty === "electric_potential_per_ampere" ||
                nextQty === "device_potential"
                  ? false
                  : (active?.vectors ?? false),
              wireframe: false,
            });
          }}
        >
          <SelectTrigger aria-label="Antenna quantity">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="fm-inspector-select-content">
            {Object.entries(quantityCatalog).map(([id, qSpec]) =>
              id !== "current_density" || currentAvailable ? (
                <SelectItem key={id} value={id}>
                  {qSpec.label} [{qSpec.unit}]
                </SelectItem>
              ) : null,
            )}
          </SelectContent>
        </Select>
      </InspectorPropertyRow>

      <InspectorPropertyRow label="Snapshot">
        <Select
          value={inspectionMode ? "inspection" : "basis"}
          onValueChange={(val) => {
            onSelectQuantity(effectiveQuantity);
            onSelectDisplaySource(val);
            onClearIntent();
          }}
        >
          <SelectTrigger aria-label="Snapshot">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="fm-inspector-select-content">
            <SelectItem disabled={!basisAvailable} value="basis">
              Published per-ampere basis
            </SelectItem>
            <SelectItem disabled={!rawAvailable} value="inspection">
              Inspection only · raw current · NOT VERIFIED
            </SelectItem>
          </SelectContent>
        </Select>
      </InspectorPropertyRow>

      <InspectorPropertyRow label="Port mode">
        <Select
          disabled={!available || ports.length === 0}
          value={port || "__none__"}
          onValueChange={(val) => {
            if (val === "__none__") return;
            onSelectPort(val);
            onPatchDisplay({ portModeId: val });
          }}
        >
          <SelectTrigger aria-label="Port mode">
            <SelectValue placeholder="Select a published port" />
          </SelectTrigger>
          <SelectContent className="fm-inspector-select-content">
            <SelectItem disabled value="__none__">
              Select a published port
            </SelectItem>
            {ports.map((id) => (
              <SelectItem key={id} value={id}>
                {id}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </InspectorPropertyRow>

      <FieldRow label="Carrier" value={carrierLabel} />

      <InspectorPropertyRow label="Component">
        <Select
          disabled={!available || !port || quantityComponents === 1}
          value={
            quantityComponents === 1
              ? "scalar"
              : (active?.component ?? "magnitude")
          }
          onValueChange={(val) =>
            onPatchDisplay({
              component: val as AntennaFieldIntent["component"],
            })
          }
        >
          <SelectTrigger aria-label="Component">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="fm-inspector-select-content">
            <SelectItem disabled value="scalar">
              Scalar
            </SelectItem>
            <SelectItem value="magnitude">Magnitude</SelectItem>
            <SelectItem value="x">x</SelectItem>
            <SelectItem value="y">y</SelectItem>
            <SelectItem value="z">z</SelectItem>
          </SelectContent>
        </Select>
      </InspectorPropertyRow>

      <p className="fm-inspector-hint" role="status">
        {available
          ? inspectionMode
            ? `${perAmpereInspection ? "Signed per-A snapshot" : "Raw recorded drive"} ${quantityLabel} [${quantityUnit}], inspection only · NOT VERIFIED.`
            : "Per-ampere published snapshot; waveform scaling is not applied."
          : statusReason}
      </p>
      <p className="fm-inspector-hint">{renderReason}</p>

      {active && displayStatus?.intentKey === JSON.stringify(active) ? (
        <>
          <FieldRow
            label="Field display"
            value={`${displayStatus.status}: ${displayStatus.reason}`}
          />
          {displayStatus.status === "ready" ? (
            <>
              <FieldRow
                label="Rendered samples"
                value={String(displayStatus.sampleCount)}
              />
              <FieldRow
                label="Automatic color range"
                unit={quantityUnit}
                value={`${displayStatus.minimum?.toExponential(4)} … ${displayStatus.maximum?.toExponential(4)}`}
              />
            </>
          ) : null}
        </>
      ) : null}
    </>
  );
}

export function AntennaSurfaceColoringControls({
  active,
  available,
  displayStatus,
  effectiveQuantity,
  inspectionMode,
  objectId,
  onPatchDisplay,
  owner,
  port,
  quantityLabel,
  quantityUnit,
  stageId,
}: {
  active: AntennaFieldIntent | null;
  available: boolean | null;
  displayStatus: AntennaDisplayStatus;
  effectiveQuantity: AntennaFieldQuantity;
  inspectionMode: boolean;
  objectId: string;
  onPatchDisplay: (patch: Partial<AntennaFieldIntent>) => void;
  owner: ReturnType<typeof useSessionResourceIdentity>;
  port: string;
  quantityLabel: string;
  quantityUnit: string;
  stageId: string | null;
}): ReactNode {
  return (
    <div className="fm-inspector-stack">
      <FieldRow label="Color source" value={quantityLabel} />
      <RadixAntennaColorRangeControl
        context={JSON.stringify([
          owner,
          objectId,
          stageId,
          inspectionMode,
          active?.solutionId,
          active?.runtimeStageId,
          active?.runId,
          active?.contentDigest,
          effectiveQuantity,
          port,
          active?.component ?? "magnitude",
        ])}
        data={
          displayStatus?.status === "ready" &&
          displayStatus.intentKey === JSON.stringify(active) &&
          displayStatus.minimum !== undefined &&
          displayStatus.maximum !== undefined
            ? {
                maximum: displayStatus.maximum,
                minimum: displayStatus.minimum,
              }
            : undefined
        }
        disabled={!available || !port}
        range={active?.colorRange}
        unit={quantityUnit}
        onApply={(colorRange) => onPatchDisplay({ colorRange })}
      />
      <InspectorPropertyRow label="Point / vector palette">
        <SegmentedControl
          aria-label="Point / vector palette"
          columns={2}
          options={[
            {
              disabled: !available || !port,
              label: "Viridis",
              value: "viridis",
            },
            {
              disabled: !available || !port,
              label: "Coolwarm",
              value: "coolwarm",
            },
          ]}
          value={active?.palette ?? "viridis"}
          onValueChange={(val) =>
            onPatchDisplay({
              palette: val as AntennaFieldIntent["palette"],
            })
          }
        />
      </InspectorPropertyRow>
    </div>
  );
}

export function AntennaVectorGlyphControls({
  active,
  available,
  onPatchDisplay,
  port,
  quantityComponents,
}: {
  active: AntennaFieldIntent | null;
  available: boolean | null;
  onPatchDisplay: (patch: Partial<AntennaFieldIntent>) => void;
  port: string;
  quantityComponents: number;
}): ReactNode {
  const vectorsDisabled = !available || !port || quantityComponents === 1;
  return (
    <div className="fm-inspector-stack">
      <InspectorPropertyRow label="Show vectors">
        <Switch
          aria-label="Show vectors"
          checked={active?.vectors ?? false}
          disabled={vectorsDisabled}
          onCheckedChange={(checked) => onPatchDisplay({ vectors: checked })}
        />
      </InspectorPropertyRow>
      <InspectorPropertyRow label="Glyph length">
        <SegmentedControl
          aria-label="Glyph length"
          columns={3}
          options={[
            {
              disabled: vectorsDisabled,
              label: "Standard (1×)",
              value: "1",
            },
            {
              disabled: vectorsDisabled,
              label: "2× length",
              value: "2",
            },
            {
              disabled: vectorsDisabled,
              label: "4× length",
              value: "4",
            },
          ]}
          value={String(active?.glyphLengthScale ?? 1)}
          onValueChange={(val) =>
            onPatchDisplay({
              glyphLengthScale: Number(val) as 1 | 2 | 4,
            })
          }
        />
      </InspectorPropertyRow>
      <InspectorPropertyRow label="Vector width">
        <SegmentedControl
          aria-label="Vector width"
          columns={3}
          options={[
            {
              disabled: vectorsDisabled,
              label: "Standard (1×)",
              value: "1",
            },
            {
              disabled: vectorsDisabled,
              label: "2× width",
              value: "2",
            },
            {
              disabled: vectorsDisabled,
              label: "4× width",
              value: "4",
            },
          ]}
          value={String(active?.vectorThickness ?? 1)}
          onValueChange={(val) =>
            onPatchDisplay({
              vectorThickness: Number(val) as 1 | 2 | 4,
            })
          }
        />
      </InspectorPropertyRow>
      <InspectorPropertyRow label="Vector occlusion">
        <SegmentedControl
          aria-label="Vector occlusion"
          columns={2}
          options={[
            {
              disabled: vectorsDisabled,
              label: "Surface depth",
              value: "depth",
            },
            {
              disabled: vectorsDisabled,
              label: "Through surfaces",
              value: "overlay",
            },
          ]}
          value={active?.vectorsOnTop ? "overlay" : "depth"}
          onValueChange={(val) =>
            onPatchDisplay({ vectorsOnTop: val === "overlay" })
          }
        />
      </InspectorPropertyRow>
      <FieldRow
        label="Vector component"
        value={
          quantityComponents === 1
            ? "Not applicable (scalar)"
            : "Cartesian vector"
        }
      />
    </div>
  );
}
