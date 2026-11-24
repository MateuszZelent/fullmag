"use client";

import { Check, Compass, Copy, Move3d } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { primitiveDraftOverlayStore } from "@/kernel/authoring/geometryLifecycleCommands";
import { Button } from "@/shared/ui/Button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/Dialog";
import { DisabledReason } from "@/shared/ui/DisabledReason";

import { LENGTH_UNITS } from "../../../panels/model-roots/SpecInspectorHost";
import type { InspectorSectionSpec } from "../../../template";

import {
  resolvePreviewOverlayDraft,
  updateLastValidDraftSnapshot,
} from "./geometrySerialization";
import {
  bakeScaleIntoDraft,
  canBakeScaleIntoDraft,
  vec3ApproxEqual,
  type ObjectGeometrySpecDraft,
} from "./geometryShared";

/* ── Panel-Level Live Draft Overlay Publisher (Never Tab-Scoped) ── */

export function LiveDraftOverlayPublisher({
  draft,
  baseline,
  invalidFields,
}: {
  draft: ObjectGeometrySpecDraft;
  baseline: ObjectGeometrySpecDraft;
  invalidFields: ReadonlyMap<string, string>;
}) {
  const [lastValidSnapshot, setLastValidSnapshot] = useState<ObjectGeometrySpecDraft>(baseline);
  const [prevDraft, setPrevDraft] = useState<ObjectGeometrySpecDraft>(draft);

  if (draft !== prevDraft) {
    setPrevDraft(draft);
    setLastValidSnapshot((prev) =>
      draft.primitiveKind !== prev.primitiveKind
        ? updateLastValidDraftSnapshot(baseline, draft)
        : updateLastValidDraftSnapshot(prev, draft),
    );
  }

  const overlayDraft = useMemo(
    () =>
      draft.mode === "draft-new"
        ? resolvePreviewOverlayDraft(draft, lastValidSnapshot, invalidFields)
        : null,
    [draft, invalidFields, lastValidSnapshot],
  );

  useEffect(() => {
    if (overlayDraft) {
      primitiveDraftOverlayStore.publish(overlayDraft);
    } else {
      primitiveDraftOverlayStore.clear();
    }
  }, [overlayDraft]);

  useEffect(() => () => primitiveDraftOverlayStore.clear(), []);

  return null;
}

/* ── Code Preview Dialog ── */

export interface GeometryCodePreviewState {
  title: string;
  language: "python" | "json";
  code: string;
}

export function GeometryCodePreviewDialog({
  codePreview,
  copiedCode,
  onCopy,
  onClose,
}: {
  codePreview: GeometryCodePreviewState | null;
  copiedCode: boolean;
  onCopy: () => void;
  onClose: () => void;
}) {
  const codeLanguageLabel =
    codePreview?.language === "json" ? "JSON payload" : "Python authoring snippet";

  return (
    <Dialog
      open={codePreview !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{codePreview?.title ?? "Code preview"}</DialogTitle>
          <DialogDescription>{codeLanguageLabel}</DialogDescription>
        </DialogHeader>
        <pre className="max-h-80 overflow-auto rounded-md border border-[var(--fm-border)] bg-[var(--fm-surface-2)] p-3 font-mono text-xs text-[var(--fm-text)]">
          <code>{codePreview?.code ?? ""}</code>
        </pre>
        <DialogFooter>
          <Button size="sm" type="button" variant="secondary" onClick={onCopy}>
            {copiedCode ? (
              <Check aria-hidden="true" size={14} />
            ) : (
              <Copy aria-hidden="true" size={14} />
            )}
            <span>{copiedCode ? "Copied" : "Copy"}</span>
          </Button>
          <Button size="sm" type="button" variant="secondary" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ── Placement (Transform) Sections ── */

export function buildGeometryTransformSections(): InspectorSectionSpec<ObjectGeometrySpecDraft>[] {
  return [
    {
      id: "geometry-transform-placement",
      modeTabId: "transform",
      title: "Spatial placement & orientation",
      icon: Move3d,
      defaultOpen: true,
      rows: [
        {
          key: "translation",
          type: "vector3",
          label: "Center translation",
          symbol: (
            <>
              r<sub>0</sub>
            </>
          ),
          units: LENGTH_UNITS,
          defaultDisplayUnit: "nm",
        },
        {
          key: "eulerDeg",
          type: "vector3",
          label: "Rotation (Euler XYZ)",
          symbol: <>&theta;</>,
          unitSuffix: "\u00b0",
          axisPresets: true,
        },
        {
          key: "pivotMode",
          type: "segmented",
          label: "Rotation & scale pivot",
          structural: true,
          options: [
            { value: "centroid", label: "Centroid" },
            { value: "origin", label: "World origin" },
            { value: "custom", label: "Custom" },
          ],
        },
        {
          key: "pivotCustom",
          type: "vector3",
          label: "Custom pivot coordinates",
          units: LENGTH_UNITS,
          defaultDisplayUnit: "nm",
          showWhen: (d) => d.pivotMode === "custom",
        },
      ],
    },
    {
      id: "geometry-transform-scale",
      modeTabId: "transform",
      title: "Dimensionless scale multiplier",
      icon: Compass,
      defaultOpen: true,
      rows: [
        {
          key: "uniformScale",
          type: "switch",
          label: "Uniform aspect lock",
        },
        {
          key: "scale",
          type: "vector3",
          label: "Scale factors (sx, sy, sz)",
          validate: (vec) =>
            vec.some((c) => !Number.isFinite(c) || c <= 0)
              ? "All scale factors must be strictly positive."
              : null,
        },
      ],
      footer: (ctx) => {
        const bakeCheck = canBakeScaleIntoDraft(ctx.draft);
        const isIdentityScale = vec3ApproxEqual(ctx.draft.scale, [1, 1, 1], 1e-9);
        const bakeButton = (
          <Button
            disabled={!bakeCheck.ok}
            size="sm"
            type="button"
            variant="secondary"
            onClick={() => {
              if (!bakeCheck.ok) return;
              ctx.patchDraft(bakeScaleIntoDraft(ctx.draft));
            }}
          >
            Bake Scale into Dimensions
          </Button>
        );
        return (
          <div className="flex flex-col gap-1.5">
            <div className="flex flex-wrap gap-1.5">
              {bakeCheck.ok ? (
                bakeButton
              ) : (
                <DisabledReason reason={bakeCheck.reason}>{bakeButton}</DisabledReason>
              )}
              {!isIdentityScale ? (
                <Button
                  size="sm"
                  type="button"
                  variant="ghost"
                  onClick={() => ctx.setField("scale", [1, 1, 1])}
                >
                  Reset Scale [1, 1, 1]
                </Button>
              ) : null}
            </div>
            {!bakeCheck.ok &&
            (ctx.draft.primitiveKind === "ImportedMesh" ||
              ctx.draft.compositeSummary != null) ? (
              <p
                className="text-xs text-[var(--fm-text-muted)]"
                data-slot="bake-scale-restriction-hint"
              >
                {bakeCheck.reason}
              </p>
            ) : null}
          </div>
        );
      },
    },
  ];
}
