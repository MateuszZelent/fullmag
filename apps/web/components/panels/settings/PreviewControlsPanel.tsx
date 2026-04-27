"use client";

import { useViewport } from "../../runs/control-room/context-hooks";
import { fmtPreviewEveryN, fmtPreviewMaxPoints, type PreviewComponent } from "../../runs/control-room/shared";
import { displayPatchFromPreviewComponentOnly } from "@/src/api/displaySelection";
import { Button } from "../../ui/button";
import { SidebarSection, InfoRow, ToggleRow } from "./primitives";
import SelectField from "../../ui/SelectField";

export default function PreviewControlsPanel() {
  const ctx = useViewport();
  return (
    <div className="flex flex-col pt-4 px-2">
      <SidebarSection title="Active Preview State" defaultOpen={true}>
        <div className="flex flex-col gap-0.5">
          <InfoRow label="Quantity" value={ctx.selectedQuantity ?? "—"} />
          <InfoRow label="Component" value={ctx.requestedPreviewComponent ?? "—"} />
        </div>

        <div className="mt-3 flex flex-wrap items-center justify-start gap-1.5">
          {ctx.quickPreviewTargets.map((target) => (
            <Button
              key={target.id}
              size="sm"
              variant={ctx.requestedPreviewQuantity === target.id ? "solid" : "outline"}
              tone={ctx.requestedPreviewQuantity === target.id ? "accent" : "default"}
              disabled={!target.available || ctx.previewBusy}
              onClick={() => ctx.requestPreviewQuantity(target.id)}
            >
              {target.shortLabel}
            </Button>
          ))}
        </div>
      </SidebarSection>

      {ctx.previewControlsActive && (
        <SidebarSection title="Preview Controls" defaultOpen={true}>
          <div className="grid grid-cols-2 gap-3">
            <SelectField
              label="Quantity"
              value={ctx.selectedQuantity}
              onchange={(val) => ctx.requestPreviewQuantity(val)}
              disabled={ctx.previewBusy}
              options={ctx.quantityOptions.map((o) => ({ value: o.value, label: o.label, disabled: o.disabled }))}
              tooltip="Select the physical quantity to render in the active viewport."
            />
            <SelectField
              label="Component"
              value={ctx.requestedPreviewComponent}
              onchange={(val) => void ctx.patchDisplay(displayPatchFromPreviewComponentOnly(val as PreviewComponent))}
              disabled={ctx.previewBusy}
              options={[
                { value: "3D", label: "3D Vector" },
                { value: "x", label: "x scalar" },
                { value: "y", label: "y scalar" },
                { value: "z", label: "z scalar" },
              ]}
              tooltip="Select which spatial component (or the full 3D vector) of the field to preview."
            />
            <SelectField
              label="Refresh Rate"
              value={String(ctx.requestedPreviewEveryN)}
              onchange={(val) => void ctx.patchDisplay({ vector_density: Number(val) })}
              disabled={ctx.previewBusy}
              options={ctx.previewEveryNOptions.map((v) => ({ value: String(v), label: fmtPreviewEveryN(v) }))}
              tooltip="Control how frequently the live preview fetches standard fields from the running GPU block."
            />
            <SelectField
              label="Max Points"
              value={String(ctx.requestedPreviewMaxPoints)}
              onchange={(val) => void ctx.patchDisplay({ max_points: Number(val) })}
              disabled={ctx.previewBusy}
              options={ctx.previewMaxPointOptions.map((v) => ({ value: String(v), label: fmtPreviewMaxPoints(v) }))}
              tooltip="Limit the number of rendering points to improve browser frame rates during live playback."
            />

            <div className="col-span-2">
              <ToggleRow
                label="Auto-fit Camera Bounds"
                checked={ctx.requestedPreviewAutoScale}
                onChange={(next) => void ctx.patchDisplay({ auto_contrast: next })}
                disabled={ctx.previewBusy}
              />
            </div>
          </div>
        </SidebarSection>
      )}
    </div>
  );
}
