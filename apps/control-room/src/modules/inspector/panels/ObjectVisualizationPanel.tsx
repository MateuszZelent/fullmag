"use client";

import { Info, RotateCcw } from "lucide-react";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { FieldCatalogResource, LiveStatusResource } from "@/kernel/api/apiTypes";
import { useKernel } from "@/kernel/KernelContext";
import {
  airboxLocalVisualizationPatchFromTargetPatch,
  airboxVisualizationStatePatchFromTargetPatch,
  DEFAULT_AIRBOX_VISUALIZATION,
  displayLabelForVisualizationTarget,
  hasVisualizationStatePatch,
  mergeVisualizationStateTargetOverride,
  renderModePatch,
  resolveTargetVisualization,
  resolveVisualizationTargetFromSelection,
  visualizationTargetKey,
  type ObjectVisualizationSnapshot,
  type VisualizationGeometryScope,
  type VisualizationRenderMode,
  type SurfaceColorSource,
  type VisualizationStoredTargetPatch,
  type VisualizationTargetKind,
  type VisualizationTargetPatch,
  type VisualizationTargetRef,
  type VisualizationTargetSettings,
} from "@/kernel/visualization/ObjectVisualizationController";
import { useSessionStatusSelector } from "@/kernel/resources/useSessionStatus";
import {
  shouldLoadRuntimeMeshManifest,
  useFieldCatalogResource,
} from "@/kernel/resources/studyRuntimeResources";
import {
  useObjectVisualizationController,
  useObjectVisualizationSelector,
} from "@/kernel/visualization/useObjectVisualization";
import {
  useVisualizationStateResource,
} from "@/kernel/visualization/useVisualizationStateResource";
import { Button } from "@/shared/ui/Button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/Dialog";
import {
  useMeshSharedDomainManifestResource,
  useSceneResource,
} from "@/kernel/resources/geometryLifecycleResources";

import type { InspectorPanelProps } from "../inspectorTypes";
import { FeedbackBanner } from "../primitives/FeedbackBanner";
import { FieldRow } from "../primitives/FieldRow";
import { FormField } from "../primitives/FormField";
import { InspectorSection } from "../primitives/InspectorSection";
import {
  buildAirboxVectorDiagnostic,
  buildAirboxVisibilityDiagnostic,
  buildVisualizationVectorBudgetDiagnostic,
  buildVisualizationPanelSections,
  colorPickerInputValue,
  resolveVisualizationVectorBudgetRange,
  resolveObjectVisualizationPanelTopologyFreshness,
  resolveVisualizationRenderResolution,
  shouldLoadObjectVisualizationFieldCatalog,
  SURFACE_COLOR_SOURCE_ITEMS,
  geometryScopeDisplayPatch,
  surfaceDisplayPassPatch,
  surfaceSolidColorPatch,
  VISUALIZATION_COLOR_MODE_ITEMS,
  type VisualizationVectorBudgetRange,
  visualizationQuantityItems,
} from "./ObjectVisualizationPanelModel";
import { formatCount } from "./MeshResourceView";

const RENDER_MODES: Array<{
  label: string;
  value: VisualizationRenderMode;
}> = [
  { label: "Shaded", value: "surface" },
  { label: "Shaded + wireframe", value: "surface+edges" },
  { label: "Wire", value: "wireframe" },
  { label: "Points", value: "points" },
];

const GEOMETRY_SCOPES: Array<{
  label: string;
  value: VisualizationGeometryScope;
}> = [
  { label: "Surface", value: "surface" },
  { label: "Full", value: "full" },
];

type ObjectVisualizationManifestStatus = {
  capabilities: Pick<LiveStatusResource["capabilities"], "explicit_topology">;
  domain: Pick<LiveStatusResource["domain"], "discretization">;
  resources: Pick<LiveStatusResource["resources"], "mesh_revision">;
};

function selectObjectVisualizationManifestStatus(status: {
  data: LiveStatusResource | null;
}): ObjectVisualizationManifestStatus | null {
  if (!status.data) return null;
  return {
    capabilities: {
      explicit_topology: status.data.capabilities.explicit_topology,
    },
    domain: {
      discretization: status.data.domain.discretization,
    },
    resources: {
      mesh_revision: status.data.resources.mesh_revision,
    },
  };
}

function objectVisualizationManifestStatusEquals(
  previous: ObjectVisualizationManifestStatus | null,
  next: ObjectVisualizationManifestStatus | null,
): boolean {
  if (previous === next) return true;
  if (!previous || !next) return previous === next;
  return (
    previous.capabilities.explicit_topology ===
      next.capabilities.explicit_topology &&
    previous.domain.discretization === next.domain.discretization &&
    previous.resources.mesh_revision === next.resources.mesh_revision
  );
}

const OBJECT_VISUALIZATION_TARGET_KINDS: readonly VisualizationTargetKind[] = [
  "airbox",
  "object",
  "part",
  "region",
];

function selectObjectVisualizationPanelSnapshot(
  snapshot: ObjectVisualizationSnapshot,
  targets: readonly VisualizationTargetRef[],
): ObjectVisualizationSnapshot {
  const defaults: ObjectVisualizationSnapshot["defaults"] = {};
  const overrides: ObjectVisualizationSnapshot["overrides"] = {};

  for (const target of targets) {
    const defaultPatch = snapshot.defaults[target.kind];
    if (defaultPatch) {
      defaults[target.kind] = defaultPatch;
    }

    const override = snapshot.overrides[visualizationTargetKey(target)];
    if (override) {
      overrides[visualizationTargetKey(target)] = override;
    }
  }

  return {
    defaults,
    overrides,
    version: snapshot.version,
  };
}

function objectVisualizationPanelSnapshotEquals(
  previous: ObjectVisualizationSnapshot,
  next: ObjectVisualizationSnapshot,
): boolean {
  for (const kind of OBJECT_VISUALIZATION_TARGET_KINDS) {
    if (!visualizationTargetPatchEquals(previous.defaults[kind], next.defaults[kind])) {
      return false;
    }
  }

  const overrideKeys = new Set([
    ...Object.keys(previous.overrides),
    ...Object.keys(next.overrides),
  ]);
  for (const key of overrideKeys) {
    if (!visualizationTargetPatchEquals(previous.overrides[key], next.overrides[key])) {
      return false;
    }
  }

  return true;
}

function visualizationTargetPatchEquals(
  previous: VisualizationStoredTargetPatch | undefined,
  next: VisualizationStoredTargetPatch | undefined,
): boolean {
  if (previous === next) return true;
  if (!previous || !next) return previous === next;

  const keys = new Set([
    ...Object.keys(previous),
    ...Object.keys(next),
  ] as Array<keyof VisualizationStoredTargetPatch>);
  for (const key of keys) {
    if (!Object.is(previous[key], next[key])) {
      return false;
    }
  }

  return true;
}

function surfaceFieldStatus(
  source: SurfaceColorSource,
  fieldCatalog: FieldCatalogResource | null | undefined,
  fetchStatus: string,
): string {
  if (source === "solid") return "not required";
  const revision =
    fieldCatalog?.quantities.reduce(
      (latest, quantity) =>
        quantity.available ? Math.max(latest, quantity.field_revision) : latest,
      0,
    ) ?? 0;
  if (revision > 0) {
    return `available r${revision}`;
  }
  return fetchStatus === "ready" ? "none" : fetchStatus;
}

type PatchVisualizationTarget = (patchValue: VisualizationTargetPatch) => Promise<void>;
type SectionDisabled = (
  id: ReturnType<typeof buildVisualizationPanelSections>[number]["id"],
) => boolean;

function remoteVisualizationTargetPatch(
  patch: VisualizationTargetPatch,
): VisualizationTargetPatch {
  const remotePatch = { ...patch };
  delete remotePatch.vectorCenteringEnabled;
  delete remotePatch.vectorSurfaceOffsetEnabled;
  delete remotePatch.vectorSurfaceOffsetScale;
  delete remotePatch.primitiveVisible;
  return remotePatch;
}

function VisualizationDisplayPassesSection({
  airboxPartIds,
  displaySettings,
  fieldCatalog,
  onFieldCatalogRequest,
  passControlsDisabled,
  patch,
  pending,
  renderWarning,
  settings,
  targetKind,
  vectorDomain,
}: {
  airboxPartIds: readonly string[];
  displaySettings: VisualizationTargetSettings;
  fieldCatalog: ReturnType<typeof useFieldCatalogResource>;
  onFieldCatalogRequest: () => void;
  passControlsDisabled: boolean;
  patch: PatchVisualizationTarget;
  pending: boolean;
  renderWarning: string | null;
  settings: VisualizationTargetSettings;
  targetKind: VisualizationTargetKind;
  vectorDomain: string;
}) {
  const [airboxDiagnosticOpen, setAirboxDiagnosticOpen] = useState(false);
  const airboxDiagnostic =
    targetKind === "airbox"
      ? buildAirboxVisibilityDiagnostic({
          displaySettings,
          renderWarning,
          settings,
        })
      : null;
  const airboxVectorDiagnostic =
    targetKind === "airbox"
      ? buildAirboxVectorDiagnostic({
          airboxPartIds,
          displaySettings,
          fieldCatalog: fieldCatalog.data,
          fieldCatalogStatus: fieldCatalog.status,
          renderWarning,
          settings,
          vectorDomain,
        })
      : null;

  function handleVisibleClick(): void {
    const nextVisible = !settings.visible;
    void patch({ visible: nextVisible });
    if (targetKind === "airbox" && nextVisible) {
      setAirboxDiagnosticOpen(true);
    } else if (targetKind === "airbox") {
      setAirboxDiagnosticOpen(false);
    }
  }

  function handleDiagnosticClick(): void {
    onFieldCatalogRequest();
    setAirboxDiagnosticOpen(true);
  }

  return (
    <InspectorSection title="Display Passes">
      {renderWarning ? (
        <FeedbackBanner kind="warning" message={renderWarning} />
      ) : null}
      <div className="fm-visualization-toggle-grid">
        {targetKind === "airbox" ? (
          <Button
            aria-label="Airbox visualization diagnostics"
            className="fm-visualization-toggle"
            size="sm"
            title="Airbox visualization diagnostics"
            type="button"
            variant="secondary"
            onClick={handleDiagnosticClick}
          >
            <Info size={14} />
          </Button>
        ) : null}
        <ToggleButton
          active={displaySettings.visible}
          disabled={pending}
          label="Visible"
          onClick={handleVisibleClick}
        />
        <ToggleButton active={displaySettings.shaderVisible} disabled={passControlsDisabled} label="Surface" onClick={() => void patch(surfaceDisplayPassPatch(settings))} />
        <ToggleButton active={displaySettings.wireframeVisible} disabled={passControlsDisabled} label="Wireframe" onClick={() => void patch({ wireframeVisible: !settings.wireframeVisible })} />
        <ToggleButton active={displaySettings.boundsVisible} disabled={passControlsDisabled} label="Frame" onClick={() => void patch({ boundsVisible: !settings.boundsVisible })} />
        <ToggleButton active={displaySettings.pointsVisible} disabled={passControlsDisabled} label="Points" onClick={() => void patch({ pointsVisible: !settings.pointsVisible })} />
        <ToggleButton active={displaySettings.vectorsVisible} disabled={passControlsDisabled} label="Vectors" onClick={() => void patch({ vectorsVisible: !settings.vectorsVisible })} />
        {targetKind === "object" ? (
          <ToggleButton
            active={Boolean(displaySettings.primitiveVisible)}
            disabled={passControlsDisabled}
            label="Primitive"
            onClick={() =>
              void patch({ primitiveVisible: !settings.primitiveVisible })
            }
          />
        ) : null}
      </div>
      <Dialog
        open={
          airboxDiagnosticOpen &&
          (airboxDiagnostic !== null || airboxVectorDiagnostic !== null)
        }
        onOpenChange={setAirboxDiagnosticOpen}
      >
        <DialogContent aria-describedby="fm-airbox-diagnostic-description">
          <DialogHeader>
            <DialogTitle>
              Airbox visualization diagnostic
            </DialogTitle>
            <DialogDescription id="fm-airbox-diagnostic-description">
              {airboxVectorDiagnostic?.message ??
                airboxDiagnostic?.message ??
                "Airbox visibility state is not available."}
            </DialogDescription>
          </DialogHeader>
          <div>
            {airboxVectorDiagnostic ? (
              <>
                <FieldRow label="Vector status" value={airboxVectorDiagnostic.title} />
                {airboxVectorDiagnostic.details.map((detail) => (
                  <FieldRow
                    key={`vector:${detail.label}`}
                    label={detail.label}
                    value={detail.value}
                  />
                ))}
              </>
            ) : null}
            {airboxDiagnostic ? (
              <FieldRow label="Visibility status" value={airboxDiagnostic.title} />
            ) : null}
            {airboxDiagnostic?.details.map((detail) => (
              <FieldRow
                key={`visibility:${detail.label}`}
                label={detail.label}
                value={detail.value}
              />
            ))}
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button size="sm" type="button" variant="secondary">
                Close
              </Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </InspectorSection>
  );
}

function VisualizationRenderModeSection({
  displaySettings,
  passControlsDisabled,
  patch,
}: {
  displaySettings: VisualizationTargetSettings;
  passControlsDisabled: boolean;
  patch: PatchVisualizationTarget;
}) {
  return (
    <InspectorSection title="Render Mode">
      <fieldset className="fm-visualization-segments" aria-label="Render mode">
        {RENDER_MODES.map((mode) => (
          <Button
            key={mode.value}
            size="sm"
            type="button"
            disabled={passControlsDisabled}
            variant={displaySettings.visible && displaySettings.renderMode === mode.value ? "primary" : "secondary"}
            onClick={() => void patch(renderModePatch(mode.value))}
          >
            {mode.label}
          </Button>
        ))}
      </fieldset>
    </InspectorSection>
  );
}

function VisualizationSurfaceColoringSection({
  patch,
  patchColor,
  pending,
  sectionDisabled,
  fieldCatalog,
  onFieldCatalogRequest,
  settings,
}: {
  patch: PatchVisualizationTarget;
  patchColor: (
    field: "pointColor" | "shaderMonoColor" | "vectorMonoColor" | "wireframeColor",
    value: string,
  ) => void;
  pending: boolean;
  sectionDisabled: SectionDisabled;
  fieldCatalog: ReturnType<typeof useFieldCatalogResource>;
  onFieldCatalogRequest: () => void;
  settings: VisualizationTargetSettings;
}) {
  return (
    <InspectorSection title="Surface Coloring" collapsible>
      <FormField
        disabled={pending || sectionDisabled("surface-coloring")}
        label="Color source"
        type="select"
        value={settings.surfaceColorSource}
        onChange={(event) => {
          const surfaceColorSource = event.target.value as SurfaceColorSource;
          if (surfaceColorSource !== "solid") {
            onFieldCatalogRequest();
          }
          void patch({ surfaceColorSource });
        }}
      >
        {SURFACE_COLOR_SOURCE_ITEMS.map((source) => (
          <option key={source.value} value={source.value}>
            {source.label}
          </option>
        ))}
      </FormField>
      <ColorField
        disabled={pending || sectionDisabled("surface-coloring")}
        label="Solid color"
        value={settings.shaderMonoColor}
        onChange={(value) => patchColor("shaderMonoColor", value)}
      />
      <FieldRow
        label="Field status"
        value={surfaceFieldStatus(
          settings.surfaceColorSource,
          fieldCatalog.data,
          fieldCatalog.status,
        )}
      />
    </InspectorSection>
  );
}

function VisualizationQuantitySection({
  patch,
  pending,
  settings,
}: {
  patch: PatchVisualizationTarget;
  pending: boolean;
  settings: VisualizationTargetSettings;
}) {
  return (
    <InspectorSection title="Quantity Source">
      <FormField
        disabled={pending}
        label="Quantity source"
        type="select"
        value={settings.activeQuantityId}
        onChange={(event) =>
          void patch({ activeQuantityId: event.target.value })
        }
      >
        {visualizationQuantityItems(settings.activeQuantityId).map((quantity) => (
          <option key={quantity.value} value={quantity.value}>
            {quantity.label}
          </option>
        ))}
      </FormField>
    </InspectorSection>
  );
}

function VisualizationPointsSection({
  patchColor,
  pending,
  sectionDisabled,
  settings,
}: {
  patchColor: (field: "pointColor", value: string) => void;
  pending: boolean;
  sectionDisabled: SectionDisabled;
  settings: VisualizationTargetSettings;
}) {
  return (
    <InspectorSection title="Points">
      <ColorField
        disabled={pending || sectionDisabled("points")}
        label="Point color"
        value={settings.pointColor}
        onChange={(value) => patchColor("pointColor", value)}
      />
    </InspectorSection>
  );
}

function VisualizationWireframeSection({
  patchColor,
  patchNumber,
  pending,
  sectionDisabled,
  settings,
}: {
  patchColor: (field: "wireframeColor", value: string) => void;
  patchNumber: (field: "wireframeOpacityPercent", value: number) => void;
  pending: boolean;
  sectionDisabled: SectionDisabled;
  settings: VisualizationTargetSettings;
}) {
  return (
    <InspectorSection title="Wireframe">
      <ColorField disabled={pending || sectionDisabled("wireframe")} label="Wireframe color" value={settings.wireframeColor} onChange={(value) => patchColor("wireframeColor", value)} />
      <NumberField disabled={pending || sectionDisabled("wireframe")} label="Wireframe opacity" max={100} min={0} step={1} unit="%" value={settings.wireframeOpacityPercent} onChange={(value) => patchNumber("wireframeOpacityPercent", value)} />
    </InspectorSection>
  );
}

function VisualizationVectorsSection({
  meshParts,
  onTogglePartVectors,
  patch,
  patchColor,
  patchNumber,
  pending,
  sectionDisabled,
  settings,
  vectorBudgetRange,
}: {
  meshParts?: ReadonlyArray<{
    id: string;
    label: string;
    vectorsVisible: boolean;
  }>;
  onTogglePartVectors?: (partId: string, visible: boolean) => void;
  patch: PatchVisualizationTarget;
  patchColor: (field: "vectorMonoColor", value: string) => void;
  patchNumber: (
    field:
      | "vectorAlphaPercent"
      | "vectorBudget"
      | "vectorLengthScale"
      | "vectorSurfaceOffsetScale"
      | "vectorThickness",
    value: number,
  ) => void;
  pending: boolean;
  sectionDisabled: SectionDisabled;
  settings: VisualizationTargetSettings;
  vectorBudgetRange: VisualizationVectorBudgetRange;
}) {
  const vectorBudgetValue = Math.max(
    vectorBudgetRange.min,
    Math.min(vectorBudgetRange.max, settings.vectorBudget),
  );
  const vectorBudgetDiagnostic = buildVisualizationVectorBudgetDiagnostic({
    requestedBudget: vectorBudgetValue,
    vectorBudgetRange,
  });

  return (
    <InspectorSection title="Vectors">
      <fieldset className="fm-visualization-segments" aria-label="Vector coloring">
        {VISUALIZATION_COLOR_MODE_ITEMS.map((mode) => (
          <Button
            key={mode.value}
            size="sm"
            type="button"
            disabled={pending || sectionDisabled("vectors")}
            variant={settings.vectorColorMode === mode.value ? "primary" : "secondary"}
            onClick={() => void patch({ vectorColorMode: mode.value })}
          >
            {mode.label}
          </Button>
        ))}
      </fieldset>
      <ColorField disabled={pending || sectionDisabled("vectors")} label="Vector mono color" value={settings.vectorMonoColor} onChange={(value) => patchColor("vectorMonoColor", value)} />
      <NumberField disabled={pending || sectionDisabled("vectors")} label="Vector alpha" max={100} min={0} step={1} unit="%" value={settings.vectorAlphaPercent} onChange={(value) => patchNumber("vectorAlphaPercent", value)} />
      <NumberField disabled={pending || sectionDisabled("vectors")} label="Vector thickness" max={8} min={0.1} step={0.1} value={settings.vectorThickness} onChange={(value) => patchNumber("vectorThickness", value)} />
      <NumberField disabled={pending || sectionDisabled("vectors")} label="Arrow length" max={5} min={0.1} step={0.1} unit="×" value={settings.vectorLengthScale} onChange={(value) => patchNumber("vectorLengthScale", value)} />
      <NumberField
        disabled={pending || sectionDisabled("vectors")}
        label="Arrow budget"
        max={vectorBudgetRange.max}
        min={vectorBudgetRange.min}
        step={vectorBudgetRange.step}
        value={vectorBudgetValue}
        onChange={(value) => patchNumber("vectorBudget", value)}
      />
      <FieldRow
        label="Arrow samples"
        value={`${formatCount(vectorBudgetDiagnostic.displayedGlyphCount)} / ${formatCount(vectorBudgetDiagnostic.availableNodeCount)}${vectorBudgetDiagnostic.exact ? "" : " est."}`}
      />
      <div className="fm-visualization-toggle-grid">
        <ToggleButton
          active={settings.vectorCenteringEnabled}
          disabled={pending || sectionDisabled("vectors")}
          label="Centered arrows"
          onClick={() =>
            void patch({
              vectorCenteringEnabled: !settings.vectorCenteringEnabled,
            })
          }
        />
        <ToggleButton
          active={settings.vectorSurfaceOffsetEnabled}
          disabled={pending || sectionDisabled("vectors")}
          label="Lift above surface"
          onClick={() =>
            void patch({
              vectorSurfaceOffsetEnabled:
                !settings.vectorSurfaceOffsetEnabled,
            })
          }
        />
      </div>
      {settings.vectorSurfaceOffsetEnabled ? (
        <NumberField disabled={pending || sectionDisabled("vectors")} label="Extra surface gap" max={1} min={0} step={0.01} value={settings.vectorSurfaceOffsetScale} onChange={(value) => patchNumber("vectorSurfaceOffsetScale", value)} />
      ) : null}
      <fieldset className="fm-visualization-segments" aria-label="Arrow extent">
        {GEOMETRY_SCOPES.map((scope) => (
          <Button
            key={scope.value}
            size="sm"
            type="button"
            disabled={pending || sectionDisabled("vectors")}
            variant={settings.geometryScope === scope.value ? "primary" : "secondary"}
            onClick={() => void patch({ geometryScope: scope.value })}
          >
            {scope.label}
          </Button>
        ))}
      </fieldset>
      {meshParts && meshParts.length > 1 && onTogglePartVectors && (
        <fieldset className="fm-visualization-part-toggles" aria-label="Per-part vector visibility">
          <span className="fm-visualization-part-toggles__label">Surfaces</span>
          {meshParts.map((part) => (
            <label key={part.id} className="fm-visualization-part-toggle">
              <input
                type="checkbox"
                checked={part.vectorsVisible}
                disabled={pending || sectionDisabled("vectors")}
                onChange={(e) => onTogglePartVectors(part.id, e.target.checked)}
              />
              <span>{part.label}</span>
            </label>
          ))}
        </fieldset>
      )}
    </InspectorSection>
  );
}

function VisualizationGeometryScopeSection({
  passControlsDisabled,
  patch,
  settings,
}: {
  passControlsDisabled: boolean;
  patch: PatchVisualizationTarget;
  settings: VisualizationTargetSettings;
}) {
  return (
    <InspectorSection title="Geometry Scope">
      <fieldset className="fm-visualization-segments" aria-label="Geometry scope">
        {GEOMETRY_SCOPES.map((scope) => (
          <Button
            key={scope.value}
            size="sm"
            type="button"
            disabled={passControlsDisabled}
            variant={settings.visible && settings.geometryScope === scope.value ? "primary" : "secondary"}
            onClick={() => void patch(geometryScopeDisplayPatch(settings, scope.value))}
          >
            {scope.label}
          </Button>
        ))}
      </fieldset>
    </InspectorSection>
  );
}

function VisualizationOpacitySection({
  patch,
  settings,
}: {
  patch: PatchVisualizationTarget;
  settings: VisualizationTargetSettings;
}) {
  return (
    <InspectorSection title="Opacity">
      <NumberField
        disabled={false}
        label="Opacity"
        max={100}
        min={0}
        step={1}
        unit="%"
        value={settings.opacityPercent}
        onChange={(value) => void patch({ opacityPercent: value })}
      />
    </InspectorSection>
  );
}

function VisualizationOverridesSection({
  feedback,
  onReset,
  pending,
}: {
  feedback: string | null;
  onReset: () => void;
  pending: boolean;
}) {
  return (
    <InspectorSection title="Overrides">
      <div className="fm-inspector-toolbar">
        <Button size="sm" type="button" disabled={pending} variant="ghost" onClick={onReset}>
          <RotateCcw size={12} aria-hidden="true" />
          Reset display
        </Button>
      </div>
      {feedback && <FeedbackBanner kind="error" message={feedback} />}
    </InspectorSection>
  );
}

function useObjectVisualizationPanelState(
  selection: InspectorPanelProps["selection"],
) {
  const target = resolveVisualizationTargetFromSelection(selection);
  const { visualizationSync } = useKernel();
  const visualization = useObjectVisualizationController();
  const visualizationState = useVisualizationStateResource();
  const manifestStatus = useSessionStatusSelector(
    selectObjectVisualizationManifestStatus,
    {
      enabled: Boolean(target),
      isEqual: objectVisualizationManifestStatusEquals,
    },
  );
  const [feedback, setFeedback] = useState<string | null>(null);
  const [fieldCatalogRequestedTargetKey, setFieldCatalogRequestedTargetKey] =
    useState<string | null>(null);
  const pending = false;
  const scene = useSceneResource({ enabled: Boolean(target) });
  const manifest = useMeshSharedDomainManifestResource({
    enabled: shouldLoadRuntimeMeshManifest(Boolean(target), manifestStatus),
  });
  const visualizationTargets = useMemo(() => {
    const targets: VisualizationTargetRef[] = [];
    if (target) {
      targets.push(target);
      if (target.kind === "region" && selection.objectId) {
        targets.push({
          id: selection.objectId,
          kind: "object",
          label: selection.label,
        });
      }
    }

    for (const part of manifest.data?.mesh_parts ?? []) {
      if (part.role === "air" || part.role === "airbox") continue;
      targets.push(
        part.object_id
          ? { id: part.object_id, kind: "object", label: part.label }
          : { id: part.id, kind: "part", label: part.label },
      );
    }

    return targets;
  }, [manifest.data?.mesh_parts, selection.label, selection.objectId, target]);
  const selectPanelSnapshot = useCallback(
    (snapshot: ObjectVisualizationSnapshot) =>
      selectObjectVisualizationPanelSnapshot(snapshot, visualizationTargets),
    [visualizationTargets],
  );
  const snapshot = useObjectVisualizationSelector(selectPanelSnapshot, {
    isEqual: objectVisualizationPanelSnapshotEquals,
  });
  const inheritedSettings =
    target?.kind === "region" && selection.objectId
      ? resolveTargetVisualization({
          snapshot,
          target: {
            id: selection.objectId,
            kind: "object",
            label: selection.label,
          },
          visualizationState: visualizationState.data,
        }).settings
      : undefined;
  const targetVisualization = target
    ? resolveTargetVisualization({
        inheritedSettings,
        snapshot,
        target,
        visualizationState: visualizationState.data,
      })
    : null;
  const settings = targetVisualization?.settings ?? null;
  const effectiveSettings = targetVisualization?.effectiveSettings ?? null;
  const targetKey = target ? visualizationTargetKey(target) : null;
  const fieldCatalogRequested =
    targetKey !== null && fieldCatalogRequestedTargetKey === targetKey;
  const fieldCatalog = useFieldCatalogResource({
    enabled: shouldLoadObjectVisualizationFieldCatalog({
      requested: fieldCatalogRequested,
      surfaceColorSource: settings?.surfaceColorSource,
      targetActive: Boolean(target),
    }),
  });
  const airboxPartIds =
    manifest.data?.mesh_parts?.flatMap((part) =>
      part.role === "air" || part.role === "airbox" ? [part.id] : [],
    ) ?? [];
  const vectorDomain = visualizationState.data?.layers?.vectors?.domain ?? "auto";
  const topologyFreshness = target
    ? resolveObjectVisualizationPanelTopologyFreshness({
        manifest: manifest.data,
        scene: scene.data,
        targetKind: target.kind,
      })
    : null;
  const renderResolution = settings && effectiveSettings
    ? resolveVisualizationRenderResolution({
        effectiveSettings,
        settings,
        topologyFreshness,
      })
    : null;
  const sections = settings && effectiveSettings
    ? buildVisualizationPanelSections({
        effectiveSettings: renderResolution?.finalSettings ?? effectiveSettings,
        settings,
      })
    : [];
  const passControlsDisabled = pending || !settings?.visible;
  const revision = targetVisualization?.revision ?? snapshot.version;

  async function patch(patchValue: VisualizationTargetPatch): Promise<void> {
    if (!target) return;
    if (target.kind === "airbox") {
      const localPatch =
        airboxLocalVisualizationPatchFromTargetPatch(patchValue);
      const statePatch = airboxVisualizationStatePatchFromTargetPatch(
        patchValue,
        visualizationState.data?.overrides,
      );
      if (Object.keys(localPatch).length > 0) {
        visualization.patchTarget(target, localPatch);
      }
      if (!hasVisualizationStatePatch(statePatch)) {
        setFeedback(null);
        return;
      }

      visualizationSync.queuePatch(statePatch);
      setFeedback(null);
      return;
    }

    if (!visualizationState.data) {
      visualization.patchTarget(target, patchValue);
      return;
    }

    const remotePatch = remoteVisualizationTargetPatch(patchValue);
    if (Object.keys(remotePatch).length > 0) {
      visualizationSync.queuePatch({
        overrides: mergeVisualizationStateTargetOverride(
          visualizationState.data.overrides ?? [],
          target,
          remotePatch,
        ),
      });
    }
    // Keep the patch locally for immediate inspector/ribbon feedback until the
    // revision-driven resource refetch lands.
    visualization.patchTarget(target, patchValue);
    setFeedback(null);
  }

  async function resetTarget(): Promise<void> {
    if (!target) return;
    if (target.kind === "airbox") {
      visualizationSync.queuePatch(
        airboxVisualizationStatePatchFromTargetPatch(
          DEFAULT_AIRBOX_VISUALIZATION,
        ),
      );
      visualization.clearTarget(target);
      setFeedback(null);
      return;
    }

    if (!visualizationState.data) {
      visualization.clearTarget(target);
      return;
    }

    visualizationSync.queuePatch({
      overrides: (visualizationState.data.overrides ?? []).filter(
        (entry) =>
          !(entry.scope === target.kind && entry.scope_id === target.id),
      ),
    });
    visualization.clearTarget(target);
    setFeedback(null);
  }

  function sectionDisabled(
    id: ReturnType<typeof buildVisualizationPanelSections>[number]["id"],
  ): boolean {
    return sections.find((section) => section.id === id)?.disabled ?? true;
  }

  function patchColor(
    field: "pointColor" | "shaderMonoColor" | "vectorMonoColor" | "wireframeColor",
    value: string,
  ) {
    if (field === "pointColor") {
      void patch({ pointColor: value });
      return;
    }
    if (field === "shaderMonoColor") {
      void patch(surfaceSolidColorPatch(value));
      return;
    }
    if (field === "vectorMonoColor") {
      void patch({ vectorMonoColor: value });
      return;
    }
    void patch({ wireframeColor: value });
  }

  function patchNumber(
    field:
      | "vectorAlphaPercent"
      | "vectorBudget"
      | "vectorLengthScale"
      | "vectorSurfaceOffsetScale"
      | "vectorThickness"
      | "wireframeOpacityPercent",
    value: number,
  ) {
    if (field === "vectorAlphaPercent") {
      void patch({ vectorAlphaPercent: value });
      return;
    }
    if (field === "vectorBudget") {
      void patch({ vectorBudget: value });
      return;
    }
    if (field === "vectorLengthScale") {
      void patch({ vectorLengthScale: value });
      return;
    }
    if (field === "vectorSurfaceOffsetScale") {
      void patch({ vectorSurfaceOffsetScale: value });
      return;
    }
    if (field === "vectorThickness") {
      void patch({ vectorThickness: value });
      return;
    }
    void patch({ wireframeOpacityPercent: value });
  }

  // Build per-part arrow visibility list from manifest.
  const vectorMeshParts = (() => {
    const parts = manifest.data?.mesh_parts;
    if (!parts || parts.length === 0) return undefined;
    // Filter to magnetic parts only (exclude airbox).
    const magneticParts = parts.filter(
      (p) => p.role !== "air" && p.role !== "airbox",
    );
    if (magneticParts.length <= 1) return undefined;
    return magneticParts.map((p) => {
      const partTarget = p.object_id
        ? { id: p.object_id, kind: "object" as const }
        : { id: p.id, kind: "part" as const };
      const partSettings = resolveTargetVisualization({
        snapshot,
        target: partTarget,
        visualizationState: visualizationState.data,
      }).settings;
      return {
        id: p.id,
        label: p.label,
        objectId: p.object_id ?? null,
        vectorsVisible: partSettings.vectorsVisible,
      };
    });
  })();

  const displaySettings = settings
    ? renderResolution?.finalSettings ?? effectiveSettings ?? settings
    : null;
  const renderWarning = renderResolution?.degradedReasons[0]?.message ?? null;
  const vectorBudgetRange = resolveVisualizationVectorBudgetRange({
    geometryScope: settings?.geometryScope,
    meshParts: manifest.data?.mesh_parts,
    target,
  });

  function onTogglePartVectors(partId: string, visible: boolean) {
    const part = manifest.data?.mesh_parts?.find((p) => p.id === partId);
    if (!part || !visualizationState.data) return;
    const partTarget = part.object_id
      ? { id: part.object_id, kind: "object" as const, label: part.label }
      : { id: part.id, kind: "part" as const, label: part.label };
    visualizationSync.queuePatch({
      overrides: mergeVisualizationStateTargetOverride(
        visualizationState.data.overrides ?? [],
        partTarget,
        { vectorsVisible: visible },
      ),
    });
  }

  return {
    displaySettings,
    effectiveSettings,
    airboxPartIds,
    feedback,
    fieldCatalog,
    onFieldCatalogRequest: () => setFieldCatalogRequestedTargetKey(targetKey),
    onTogglePartVectors,
    passControlsDisabled,
    patch,
    patchColor,
    patchNumber,
    pending,
    renderResolution,
    renderWarning,
    resetTarget,
    revision,
    sectionDisabled,
    settings,
    target,
    vectorDomain,
    vectorBudgetRange,
    vectorMeshParts,
  } as const;
}

type ObjectVisualizationPanelState = ReturnType<
  typeof useObjectVisualizationPanelState
>;
type ResolvedObjectVisualizationPanelState = Omit<
  ObjectVisualizationPanelState,
  "displaySettings" | "settings" | "target"
> & {
  displaySettings: VisualizationTargetSettings;
  settings: VisualizationTargetSettings;
  target: VisualizationTargetRef;
};

export function ObjectVisualizationPanel({ selection }: InspectorPanelProps) {
  const panel = useObjectVisualizationPanelState(selection);
  const { displaySettings, settings, target } = panel;

  if (!target || !settings || !displaySettings) {
    return (
      <div className="fm-inspector-panel">
        <InspectorSection title="Visualization">
          <FieldRow label="Target" value="No visualization target" />
        </InspectorSection>
      </div>
    );
  }

  return (
    <ObjectVisualizationPanelView
      panel={{ ...panel, displaySettings, settings, target }}
    />
  );
}

function ObjectVisualizationPanelView({
  panel,
}: {
  panel: ResolvedObjectVisualizationPanelState;
}) {
  const {
    displaySettings,
    airboxPartIds,
    feedback,
    fieldCatalog,
    onFieldCatalogRequest,
    onTogglePartVectors,
    passControlsDisabled,
    patch,
    patchColor,
    patchNumber,
    pending,
    renderResolution,
    renderWarning,
    resetTarget,
    revision,
    sectionDisabled,
    settings,
    target,
    vectorDomain,
    vectorBudgetRange,
    vectorMeshParts,
  } = panel;

  return (
    <div className="fm-inspector-panel" data-visualization-revision={revision}>
      <InspectorSection title="Visualization Target">
        <FieldRow label="Name" value={displayLabelForVisualizationTarget(target)} />
        <FieldRow label="Target ID" value={target.kind === "airbox" ? "airbox" : target.id} />
        <FieldRow label="Kind" value={target.kind} />
        <FieldRow
          label="Render state"
          value={
            renderResolution?.degradedReasons[0]?.message ??
            (settings.renderMode === "surface+edges"
              ? "Shaded + wireframe"
              : settings.renderMode)
          }
        />
      </InspectorSection>
      <VisualizationDisplayPassesSection
        airboxPartIds={airboxPartIds}
        displaySettings={displaySettings}
        fieldCatalog={fieldCatalog}
        onFieldCatalogRequest={onFieldCatalogRequest}
        passControlsDisabled={passControlsDisabled}
        patch={patch}
        pending={pending}
        renderWarning={renderWarning}
        settings={settings}
        targetKind={target.kind}
        vectorDomain={vectorDomain}
      />

      <VisualizationRenderModeSection
        displaySettings={displaySettings}
        passControlsDisabled={passControlsDisabled}
        patch={patch}
      />
      <VisualizationQuantitySection
        patch={patch}
        pending={pending}
        settings={settings}
      />
      <VisualizationSurfaceColoringSection
        patch={patch}
        patchColor={patchColor}
        pending={pending}
        sectionDisabled={sectionDisabled}
        fieldCatalog={fieldCatalog}
        onFieldCatalogRequest={onFieldCatalogRequest}
        settings={settings}
      />
      <VisualizationPointsSection
        patchColor={patchColor}
        pending={pending}
        sectionDisabled={sectionDisabled}
        settings={settings}
      />
      <VisualizationWireframeSection
        patchColor={patchColor}
        patchNumber={patchNumber}
        pending={pending}
        sectionDisabled={sectionDisabled}
        settings={settings}
      />
      <VisualizationVectorsSection
        meshParts={vectorMeshParts}
        onTogglePartVectors={onTogglePartVectors}
        patch={patch}
        patchColor={patchColor}
        patchNumber={patchNumber}
        pending={pending}
        sectionDisabled={sectionDisabled}
        settings={settings}
        vectorBudgetRange={vectorBudgetRange}
      />
      <VisualizationGeometryScopeSection
        passControlsDisabled={passControlsDisabled}
        patch={patch}
        settings={settings}
      />
      <VisualizationOpacitySection patch={patch} settings={settings} />
      <VisualizationOverridesSection
        feedback={feedback}
        onReset={() => void resetTarget()}
        pending={pending}
      />
    </div>
  );
}

function ColorField({
  disabled,
  label,
  onChange,
  value,
}: {
  disabled: boolean;
  label: string;
  onChange: (value: string) => void;
  value: string;
}) {
  const pickerValue = colorPickerInputValue(value);

  return (
    <label className="fm-visualization-color-field">
      <span>{label}</span>
      <div className="fm-visualization-color-field__control">
        <input
          aria-label={`${label} picker`}
          className="fm-visualization-color-field__picker"
          disabled={disabled}
          type="color"
          value={pickerValue}
          onChange={(event) => onChange(event.target.value)}
        />
        <input
          className="fm-visualization-color-field__value"
          disabled={disabled}
          type="text"
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      </div>
    </label>
  );
}

function NumberField({
  disabled,
  label,
  max,
  min,
  onChange,
  step,
  unit,
  value,
}: {
  disabled: boolean;
  label: string;
  max: number;
  min: number;
  onChange: (value: number) => void;
  step: number;
  unit?: string;
  value: number;
}) {
  const [draftOverride, setDraftOverride] = useState<number | null>(null);
  const latestOnChangeRef = useRef(onChange);
  const pendingValueRef = useRef<number | null>(null);
  const displayValue = draftOverride ?? value;

  useEffect(() => {
    latestOnChangeRef.current = onChange;
  }, [onChange]);

  const flushDraft = useCallback(() => {
    const pendingValue = pendingValueRef.current;
    pendingValueRef.current = null;
    setDraftOverride(null);
    if (pendingValue !== null) {
      latestOnChangeRef.current(pendingValue);
    }
  }, []);

  const scheduleDraft = useCallback(
    (nextValue: number) => {
      pendingValueRef.current = nextValue;
      setDraftOverride(nextValue);
    },
    [],
  );

  const valueRange = max - min;
  const pct =
    valueRange > 0
      ? Math.max(0, Math.min(100, ((displayValue - min) / valueRange) * 100))
      : 0;

  return (
    <label className="fm-visualization-range">
      <span>
        {unit ? `${label}: ${displayValue}${unit}` : `${label}: ${displayValue}`}
      </span>
      <input
        disabled={disabled}
        max={max}
        min={min}
        step={step}
        style={{ "--pct": `${pct}%` } as React.CSSProperties}
        type="range"
        value={displayValue}
        onBlur={flushDraft}
        onChange={(event) => scheduleDraft(Number(event.target.value))}
        onKeyUp={flushDraft}
        onPointerCancel={flushDraft}
        onPointerUp={flushDraft}
      />
    </label>
  );
}

function ToggleButton({
  active,
  disabled = false,
  label,
  onClick,
}: {
  active: boolean;
  disabled?: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <Button
      className="fm-visualization-toggle"
      data-active={active}
      disabled={disabled}
      size="sm"
      type="button"
      variant={active ? "primary" : "secondary"}
      onClick={onClick}
    >
      {label}
    </Button>
  );
}
