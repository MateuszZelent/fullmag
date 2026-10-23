"use client";

import React, { type ReactNode } from "react";

import type {
  CrossSectionPlane,
  CrossSectionQualityMetric,
} from "@/kernel/api/apiTypes";
import type {
  CrossSectionDraft,
  CrossSectionFrameExtent,
} from "@/kernel/workspace/crossSectionWorkspace";
import { Tabs, TabsList, TabsTrigger } from "@/shared/ui/Tabs";

import {
  QuantityField,
  useQuantityFieldDraftKeys,
  type QuantityFieldParseResult,
} from "../primitives/QuantityField";
import { FormField } from "../primitives/FormField";
import { InspectorGroup } from "../primitives/InspectorGroup";

const POSITION_DRAFT_KEY = "cross-section.position-percent";
const ROTATION_DRAFT_KEY = "cross-section.rotation-degrees";

const NUMBER_TEXT_PATTERN = /^[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:[eE][+-]?\d+)?$/;
const INCOMPLETE_NUMBER_TEXT_PATTERNS = [
  /^[+-]?$/,
  /^[+-]?\.$/,
  /^[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))[eE][+-]?$/,
];

function parseCrossSectionNumber(
  text: string,
  minimum: number,
  maximum: number,
): QuantityFieldParseResult<number> {
  if (
    text === "" ||
    INCOMPLETE_NUMBER_TEXT_PATTERNS.some((pattern) => pattern.test(text))
  ) {
    return { ok: false, status: "incomplete", message: "Complete the numeric value." };
  }
  if (!NUMBER_TEXT_PATTERN.test(text)) {
    return { ok: false, status: "invalid", message: "Enter a finite decimal number." };
  }

  const parsed = Number(text);
  if (!Number.isFinite(parsed)) {
    return { ok: false, status: "invalid", message: "Enter a finite decimal number." };
  }
  if (parsed < minimum || parsed > maximum) {
    return {
      ok: false,
      status: "invalid",
      message: `Enter a value between ${minimum} and ${maximum}.`,
    };
  }
  return { ok: true, value: parsed };
}

function CrossSectionNumberField({
  draftKey,
  label,
  maximum,
  minimum,
  onCommit,
  unit,
  value,
}: {
  draftKey: string;
  label: string;
  maximum: number;
  minimum: number;
  onCommit: (value: number) => void;
  unit?: string;
  value: number;
}) {
  return (
    <QuantityField<number>
      draftKey={draftKey}
      format={(current) => String(current)}
      invalidMessage="Enter a finite value within the allowed range."
      label={label}
      parse={(text) => parseCrossSectionNumber(text, minimum, maximum)}
      unit={unit}
      value={value}
      onCommit={onCommit}
    />
  );
}

interface CrossSectionSettingsValue {
  colorScale: CrossSectionDraft["colorScale"];
  edgeWidth: number;
  filterExpression: string;
  frameExtent: CrossSectionFrameExtent;
  includeWireframe: boolean;
  metric: CrossSectionQualityMetric;
  name: string;
  plane: CrossSectionPlane;
  positionPercent: number;
  rotationDegrees: number;
  shrinkFactor: number;
}

interface CrossSectionSettingsEditorProps {
  action: ReactNode;
  value: CrossSectionSettingsValue;
  onChange: (patch: Partial<CrossSectionDraft>) => void;
}

export function CrossSectionSettingsEditor({
  action,
  value,
  onChange,
}: CrossSectionSettingsEditorProps) {
  const positionDraft = useQuantityFieldDraftKeys([POSITION_DRAFT_KEY]);
  const rotationDraft = useQuantityFieldDraftKeys([ROTATION_DRAFT_KEY]);

  return (
    <>
      <InspectorGroup title="Cut Frame">
        <FormField
          label="Name"
          mono={false}
          type="text"
          value={value.name}
          onChange={(event) => onChange({ name: event.target.value })}
        />
        <FormField
          label="Frame"
          type="select"
          value={value.frameExtent}
          onChange={() => onChange({ frameExtent: "universe" })}
        >
          <option value="universe">Universe</option>
          <option disabled value="magnetic_domain">Magnetic domain</option>
          <option disabled value="object_bounds">Object bounds</option>
          <option disabled value="custom">Custom</option>
        </FormField>
        <div className="fm-inspector-form-field fm-inspector-form-field--inline">
          <span className="fm-inspector-form-field__label">Plane</span>
          <Tabs
            className="fm-inspector-axis-tabs"
            value={value.plane}
            onValueChange={(nextPlane) =>
              onChange({ plane: nextPlane as CrossSectionPlane })
            }
          >
            <TabsList aria-label="Cut plane axis">
              <TabsTrigger
                value="xy"
                className="fm-inspector-axis-tab"
                data-axis="z"
              >
                XY
              </TabsTrigger>
              <TabsTrigger
                value="xz"
                className="fm-inspector-axis-tab"
                data-axis="y"
              >
                XZ
              </TabsTrigger>
              <TabsTrigger
                value="yz"
                className="fm-inspector-axis-tab"
                data-axis="x"
              >
                YZ
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
        <div className="fm-inspector-form-field">
          <CrossSectionNumberField
            draftKey={POSITION_DRAFT_KEY}
            label="Position"
            maximum={100}
            minimum={0}
            value={value.positionPercent}
            unit="%"
            onCommit={(positionPercent) => onChange({ positionPercent })}
          />
          <input
            aria-label="Position slider"
            className="fm-inspector-range-slider"
            max={100}
            min={0}
            step={0.5}
            type="range"
            value={value.positionPercent}
            style={{ "--pct": `${value.positionPercent}%` } as React.CSSProperties}
            onChange={(event) => {
              positionDraft.remove();
              onChange({ positionPercent: Number(event.target.value) });
            }}
          />
        </div>
        <div className="fm-inspector-form-field">
          <CrossSectionNumberField
            draftKey={ROTATION_DRAFT_KEY}
            label="Rotation"
            maximum={180}
            minimum={-180}
            value={value.rotationDegrees}
            unit="deg"
            onCommit={(rotationDegrees) => onChange({ rotationDegrees })}
          />
          <input
            aria-label="Rotation slider"
            className="fm-inspector-range-slider"
            max={180}
            min={-180}
            step={1}
            type="range"
            value={value.rotationDegrees}
            style={
              {
                "--pct": `${((value.rotationDegrees + 180) / 360) * 100}%`,
              } as React.CSSProperties
            }
            onChange={(event) => {
              rotationDraft.remove();
              onChange({ rotationDegrees: Number(event.target.value) });
            }}
          />
        </div>
      </InspectorGroup>

      <InspectorGroup title="Plot Parameters">
        <FormField
          label="Quality metric"
          type="select"
          value={value.metric}
          onChange={(event) =>
            onChange({
              metric: event.target.value as CrossSectionQualityMetric,
            })
          }
        >
          <option value="skewness">Skewness</option>
          <option value="gamma">Gamma</option>
          <option value="sicn">SICN</option>
          <option value="volume">Volume</option>
          <option value="aspect_ratio">Aspect ratio</option>
          <option value="max_angle">Max angle</option>
          <option value="min_edge">Min edge</option>
        </FormField>
        <FormField
          label="Color scale"
          type="select"
          value={value.colorScale}
          onChange={(event) =>
            onChange({
              colorScale: event.target.value as CrossSectionDraft["colorScale"],
            })
          }
        >
          <option value="jet">Jet</option>
          <option value="viridis">Viridis</option>
          <option value="hot">Hot</option>
          <option value="coolwarm">Coolwarm</option>
          <option value="plasma">Plasma</option>
          <option value="inferno">Inferno</option>
        </FormField>
        <FormField
          label="Element filter"
          mono={false}
          type="text"
          value={value.filterExpression}
          onChange={(event) =>
            onChange({ filterExpression: event.target.value })
          }
        />
        <FormField
          checked={value.includeWireframe}
          label="Wireframe"
          type="checkbox"
          onChange={(event) =>
            onChange({ includeWireframe: event.target.checked })
          }
        />
        <CrossSectionNumberField
          draftKey="cross-section.edge-width"
          label="Edge width"
          maximum={4}
          minimum={0.5}
          value={value.edgeWidth}
          onCommit={(edgeWidth) => onChange({ edgeWidth })}
        />
        <CrossSectionNumberField
          draftKey="cross-section.shrink-factor"
          label="Shrink"
          maximum={1}
          minimum={0.5}
          value={value.shrinkFactor}
          onCommit={(shrinkFactor) => onChange({ shrinkFactor })}
        />
        <div className="fm-inspector-toolbar">{action}</div>
      </InspectorGroup>
    </>
  );
}
