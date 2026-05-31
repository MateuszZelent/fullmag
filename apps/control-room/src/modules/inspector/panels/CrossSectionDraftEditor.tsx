"use client";

import React from "react";

import type {
  CrossSectionPlane,
  CrossSectionQualityMetric,
} from "@/kernel/api/apiTypes";
import { useKernel } from "@/kernel/KernelContext";
import {
  commitCrossSectionDraft,
  updateCrossSectionDraft,
  type CrossSectionDraft,
} from "@/kernel/workspace/crossSectionWorkspace";
import { Button } from "@/shared/ui/Button";
import { Tabs, TabsList, TabsTrigger } from "@/shared/ui/Tabs";

import { FormField } from "../primitives/FormField";
import { InspectorSection } from "../primitives/InspectorSection";
import { MeshResourceEmpty } from "./MeshResourceView";

export function CrossSectionDraftEditor({
  draft,
}: {
  draft: CrossSectionDraft | null;
}) {
  const kernel = useKernel();

  if (!draft) {
    return <MeshResourceEmpty label="No editable cross-section draft." />;
  }

  const updateDraft = (patch: Partial<CrossSectionDraft>) => {
    updateCrossSectionDraft(patch);
  };
  const commitDraft = () => {
    const plot = commitCrossSectionDraft();
    if (!plot) return;

    const nodeId = `model:visualizations-2d:${plot.id}`;
    kernel.selection.set(
      {
        kind: "mesh.cross-section.plot",
        label: plot.name,
        nodeId,
        objectId: null,
        ref: {
          kind: "mesh.cross-section.plot",
          nodeId,
          plotId: plot.id,
          type: "cross-section-plot",
          visualizationTargetId: `cross-section:plot:${plot.id}`,
        },
      },
      "inspector",
    );
    kernel.layout.setActiveViewportMainModule("cross-section-image");
    kernel.layout.setFocusedSlot("viewport-main");
    kernel.layout.setPanelVisible("right", true);
  };

  return (
    <div className="fm-cross-section-inspector">
      <InspectorSection title="Cut Frame">
        <FormField
          label="Name"
          type="text"
          value={draft.name}
          onChange={(event) => updateDraft({ name: event.target.value })}
        />
        <FormField
          label="Frame"
          type="select"
          value={draft.frameExtent}
          onChange={() => updateDraft({ frameExtent: "universe" })}
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
            value={draft.plane}
            onValueChange={(value) =>
              updateDraft({ plane: value as CrossSectionPlane })
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
          <div className="fm-inspector-form-field--inline">
            <label
              className="fm-inspector-form-field__label"
              htmlFor="fm-cross-section-position-input"
            >
              Position
            </label>
            <div className="fm-inspector-form-field__control">
              <input
                aria-label="Position"
                className="fm-inspector-input"
                disabled={false}
                id="fm-cross-section-position-input"
                inputMode="decimal"
                max={100}
                min={0}
                step={0.5}
                type="number"
                value={draft.positionPercent}
                onChange={(event) =>
                  updateDraft({ positionPercent: Number(event.target.value) })
                }
              />
              <span className="fm-inspector-form-field__unit">%</span>
            </div>
          </div>
          <input
            aria-label="Position slider"
            className="fm-inspector-range-slider"
            max={100}
            min={0}
            step={0.5}
            type="range"
            value={draft.positionPercent}
            style={{ "--pct": `${draft.positionPercent}%` } as React.CSSProperties}
            onChange={(event) =>
              updateDraft({ positionPercent: Number(event.target.value) })
            }
          />
        </div>
        <div className="fm-inspector-form-field">
          <div className="fm-inspector-form-field--inline">
            <label
              className="fm-inspector-form-field__label"
              htmlFor="fm-cross-section-rotation-input"
            >
              Rotation
            </label>
            <div className="fm-inspector-form-field__control">
              <input
                aria-label="Rotation"
                className="fm-inspector-input"
                disabled={false}
                id="fm-cross-section-rotation-input"
                inputMode="decimal"
                max={180}
                min={-180}
                step={1}
                type="number"
                value={draft.rotationDegrees}
                onChange={(event) =>
                  updateDraft({ rotationDegrees: Number(event.target.value) })
                }
              />
              <span className="fm-inspector-form-field__unit">deg</span>
            </div>
          </div>
          <input
            aria-label="Rotation slider"
            className="fm-inspector-range-slider"
            max={180}
            min={-180}
            step={1}
            type="range"
            value={draft.rotationDegrees}
            style={
              {
                "--pct": `${((draft.rotationDegrees + 180) / 360) * 100}%`,
              } as React.CSSProperties
            }
            onChange={(event) =>
              updateDraft({ rotationDegrees: Number(event.target.value) })
            }
          />
        </div>
      </InspectorSection>

      <InspectorSection title="Plot Parameters">
        <FormField
          label="Quality metric"
          type="select"
          value={draft.metric}
          onChange={(event) =>
            updateDraft({
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
          value={draft.colorScale}
          onChange={(event) =>
            updateDraft({
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
          type="text"
          value={draft.filterExpression}
          onChange={(event) =>
            updateDraft({ filterExpression: event.target.value })
          }
        />
        <FormField
          checked={draft.includeWireframe}
          label="Wireframe"
          type="checkbox"
          onChange={(event) =>
            updateDraft({ includeWireframe: event.target.checked })
          }
        />
        <FormField
          label="Edge width"
          max={4}
          min={0.5}
          step={0.25}
          type="number"
          value={draft.edgeWidth}
          onChange={(event) =>
            updateDraft({ edgeWidth: Number(event.target.value) })
          }
        />
        <FormField
          label="Shrink"
          max={1}
          min={0.5}
          step={0.05}
          type="number"
          value={draft.shrinkFactor}
          onChange={(event) =>
            updateDraft({ shrinkFactor: Number(event.target.value) })
          }
        />
        <div className="fm-inspector-toolbar">
          <Button size="sm" type="button" variant="primary" onClick={commitDraft}>
            Generate Image
          </Button>
        </div>
      </InspectorSection>
    </div>
  );
}
