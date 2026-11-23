"use client";

import { BookOpen, Calculator, Compass, Database, Gauge } from "lucide-react";
import { createElement, useCallback, useMemo, useState } from "react";

import { createCommandContext } from "@/kernel/commands/commandContext";
import { useKernel } from "@/kernel/KernelContext";
import { useSceneResource } from "@/kernel/resources/geometryLifecycleResources";
import { useObjectTopologicalChargeResource } from "@/kernel/resources/studyRuntimeResources";

import type { InspectorPanelProps } from "../../inspectorTypes";
import {
  buildObjectSelection,
  buildRootSelection,
} from "../../panels/model-roots/SpecInspectorHost";
import {
  InspectorTemplate,
  useInspectorSpecController,
  type InspectorFact,
  type InspectorNotice,
  type InspectorSpec,
  type InspectorTone,
} from "../../template";
import { resolveTopologicalChargePanelModel } from "./topologicalChargeModel";

/* ── Accessible Pure MathML Equations (Zero Raw LaTeX in DOM) ── */

const magnetizationHat = createElement(
  "mover",
  { accent: "true" },
  createElement("mi", null, "m"),
  createElement("mo", null, "^"),
);
const oneOverFourPi = createElement(
  "mfrac",
  null,
  createElement("mn", null, "1"),
  createElement("mrow", null, createElement("mn", null, "4"), createElement("mi", null, "\u03c0")),
);

const continuumEquation = createElement(
  "math",
  {
    display: "block",
    "aria-label":
      "Q Sigma equals one over four pi times the integral over Sigma of m hat dot partial u m hat cross partial v m hat",
  },
  createElement(
    "mrow",
    null,
    createElement("msub", null, createElement("mi", null, "Q"), createElement("mi", null, "\u03a3")),
    createElement("mo", null, "="),
    oneOverFourPi,
    createElement("msub", null, createElement("mo", null, "\u222b"), createElement("mi", null, "\u03a3")),
    magnetizationHat,
    createElement("mo", null, "\u00b7"),
    createElement(
      "mrow",
      null,
      createElement("mo", null, "("),
      createElement("msub", null, createElement("mo", null, "\u2202"), createElement("mi", null, "u")),
      magnetizationHat,
      createElement("mo", null, "\u00d7"),
      createElement("msub", null, createElement("mo", null, "\u2202"), createElement("mi", null, "v")),
      magnetizationHat,
      createElement("mo", null, ")"),
    ),
    createElement("mspace", { width: "0.2em" }),
    createElement("mi", null, "d"),
    createElement("mi", null, "u"),
    createElement("mspace", { width: "0.1em" }),
    createElement("mi", null, "d"),
    createElement("mi", null, "v"),
  ),
);

const discreteEquation = createElement(
  "math",
  {
    display: "block",
    "aria-label":
      "Q h of s i equals one over four pi times sum of oriented triangle solid angles",
  },
  createElement(
    "mrow",
    null,
    createElement("msub", null, createElement("mi", null, "Q"), createElement("mi", null, "h")),
    createElement("mo", null, "("),
    createElement("msub", null, createElement("mi", null, "s"), createElement("mi", null, "i")),
    createElement("mo", null, ")"),
    createElement("mo", null, "="),
    oneOverFourPi,
    createElement("munder", null, createElement("mo", null, "\u2211"), createElement("mi", null, "\u25b5")),
    createElement("mn", null, "2"),
    createElement("mi", null, "atan2"),
    createElement("mo", null, "("),
    createElement(
      "mrow",
      null,
      createElement("mi", null, "a"),
      createElement("mo", null, "\u00b7"),
      createElement("mo", null, "("),
      createElement("mi", null, "b"),
      createElement("mo", null, "\u00d7"),
      createElement("mi", null, "c"),
      createElement("mo", null, ")"),
    ),
    createElement("mo", null, ","),
    createElement(
      "mrow",
      null,
      createElement("mn", null, "1"),
      createElement("mo", null, "+"),
      createElement("mi", null, "a"),
      createElement("mo", null, "\u00b7"),
      createElement("mi", null, "b"),
      createElement("mo", null, "+"),
      createElement("mi", null, "b"),
      createElement("mo", null, "\u00b7"),
      createElement("mi", null, "c"),
      createElement("mo", null, "+"),
      createElement("mi", null, "c"),
      createElement("mo", null, "\u00b7"),
      createElement("mi", null, "a"),
    ),
    createElement("mo", null, ")"),
  ),
);

type TopologicalChargeCalculationMode = "on_demand" | "continuous";
type TopologicalChargePlane = "auto" | "xy" | "xz" | "yz";
type TopologicalChargeSupport = "midplane" | "layer_profile";
type TopologicalChargeProfileSamples = "auto" | "17" | "33" | "65";

interface ProfileRow {
  readonly _rowId: string;
  readonly index: number;
  readonly coordNm: string;
  readonly weightNm: string;
  readonly chargeText: string;
  readonly statusLabel: string;
  readonly trustLabel: string;
}

interface TopologicalChargeDraft {
  calculationMode: TopologicalChargeCalculationMode;
  plane: TopologicalChargePlane;
  support: TopologicalChargeSupport;
  profileSamples: TopologicalChargeProfileSamples;
  chargeText: string | null;
  nearestIntText: string | null;
  intErrorText: string | null;
  statusLabel: string;
  trustLabel: string;
  resolvedPlaneLabel: string;
  resolvedSupportLabel: string;
  samplingLabel: string;
  supportProfileLabel: string;
  methodIdLabel: string;
  quantityLabel: string;
  schemaLabel: string;
  fieldRevisionLabel: string;
  meshRevisionLabel: string;
  domainGenerationLabel: string;
  meshGenerationLabel: string;
  requestedExecutionLabel: string;
  resolvedExecutionLabel: string;
  profileRows: readonly ProfileRow[];
}

function formatCleanLabel(raw: string | null | undefined, fallback: string): string {
  if (!raw || !raw.trim()) return fallback;
  return raw.replace(/_/g, " ");
}

function lookupModelRow(
  rows: readonly { label: string; value: string }[],
  label: string,
  fallback = "\u2014",
): string {
  return rows.find((row) => row.label === label)?.value ?? fallback;
}

/**
 * Berg-Lüscher Topological Charge inspector rendered directly on the 8-slot
 * `InspectorTemplate` (replaces legacy `InspectorGroup` surface while keeping
 * object extensions independent from Accordion sections).
 */
export function TopologicalChargeExtensionPanel({ selection }: InspectorPanelProps) {
  const kernel = useKernel();
  const scene = useSceneResource();
  const objectId =
    selection.ref?.type === "scene-object" ? selection.ref.objectId : selection.objectId;
  const sceneObj = useMemo(
    () => (objectId ? scene.data?.objects?.find((o) => o.id === objectId) : undefined),
    [objectId, scene.data?.objects],
  );
  const objectName = sceneObj?.name?.trim() || objectId || "Object";

  const [calculationMode, setCalculationMode] =
    useState<TopologicalChargeCalculationMode>("on_demand");
  const [plane, setPlane] = useState<TopologicalChargePlane>("auto");
  const [support, setSupport] = useState<TopologicalChargeSupport>("midplane");
  const [profileSamples, setProfileSamples] =
    useState<TopologicalChargeProfileSamples>("auto");

  const numericSamples =
    profileSamples === "auto" ? "auto" : (Number(profileSamples) as 17 | 33 | 65);
  const resource = useObjectTopologicalChargeResource(objectId, {
    pauseLoad: calculationMode === "on_demand",
    query: {
      plane,
      support,
      profile_samples: support === "layer_profile" ? numericSamples : undefined,
    },
  });

  const model = useMemo(
    () => resolveTopologicalChargePanelModel(resource.status, resource.data),
    [resource.data, resource.status],
  );
  const busy = resource.status === "loading";

  const baseline = useMemo<TopologicalChargeDraft>(() => {
    const data = resource.data;
    const profileRows: ProfileRow[] = (data?.profile ?? []).map((sample) => ({
      _rowId: `sample-${sample.index}`,
      index: sample.index,
      coordNm: Number((sample.coordinate_m * 1e9).toFixed(3)).toString(),
      weightNm: Number((sample.integration_weight_m * 1e9).toFixed(3)).toString(),
      chargeText:
        typeof sample.charge === "number" && Number.isFinite(sample.charge)
          ? sample.charge.toFixed(6)
          : "\u2014",
      statusLabel: formatCleanLabel(sample.status, "ready"),
      trustLabel: formatCleanLabel(sample.trust, "pending"),
    }));

    const hasQuality = Boolean(data?.quality);
    return {
      calculationMode,
      plane,
      support,
      profileSamples,
      chargeText:
        typeof data?.charge === "number" && Number.isFinite(data.charge)
          ? data.charge.toFixed(6)
          : null,
      nearestIntText:
        typeof data?.nearest_integer === "number" && Number.isFinite(data.nearest_integer)
          ? String(data.nearest_integer)
          : null,
      intErrorText:
        typeof data?.integer_error === "number" && Number.isFinite(data.integer_error)
          ? data.integer_error.toFixed(6)
          : null,
      statusLabel: data
        ? formatCleanLabel(data.status, "ready")
        : busy
          ? "Computing"
          : "Awaiting evaluation",
      trustLabel: data ? formatCleanLabel(data.trust, "diagnostic") : "Not yet evaluated",
      resolvedPlaneLabel: data?.resolved_support?.plane
        ? data.resolved_support.plane.toUpperCase()
        : plane.toUpperCase(),
      resolvedSupportLabel: formatCleanLabel(
        data?.resolved_support?.support ?? support,
        support,
      ),
      samplingLabel: hasQuality
        ? lookupModelRow(model.rows, "Sampling")
        : "Click Compute to sample 2D support",
      supportProfileLabel: lookupModelRow(model.rows, "Support profile"),
      methodIdLabel: lookupModelRow(model.rows, "Method"),
      quantityLabel: lookupModelRow(model.rows, "Quantity", "m"),
      schemaLabel: lookupModelRow(model.rows, "Schema"),
      fieldRevisionLabel: lookupModelRow(model.rows, "Field revision"),
      meshRevisionLabel: lookupModelRow(model.rows, "Mesh revision"),
      domainGenerationLabel: lookupModelRow(model.rows, "Domain generation"),
      meshGenerationLabel: lookupModelRow(model.rows, "Mesh generation"),
      requestedExecutionLabel: lookupModelRow(model.rows, "Requested execution"),
      resolvedExecutionLabel: lookupModelRow(model.rows, "Resolved execution"),
      profileRows,
    };
  }, [busy, calculationMode, model.rows, plane, profileSamples, resource.data, support]);

  const sortedWarnings = useMemo(() => {
    const list = [...(resource.data?.warnings ?? [])];
    const rank = (sev: string) =>
      sev === "error" || sev === "critical" ? 0 : sev === "warning" ? 1 : 2;
    return list.sort((a, b) => rank(String(a.severity)) - rank(String(b.severity)));
  }, [resource.data?.warnings]);

  const handleLiveFieldChange = useCallback(
    <K extends keyof TopologicalChargeDraft & string>(
      key: K,
      value: TopologicalChargeDraft[K],
    ) => {
      if (key === "calculationMode") {
        setCalculationMode(value as TopologicalChargeCalculationMode);
      } else if (key === "plane") {
        setPlane(value as TopologicalChargePlane);
      } else if (key === "support") {
        setSupport(value as TopologicalChargeSupport);
      } else if (key === "profileSamples") {
        setProfileSamples(value as TopologicalChargeProfileSamples);
      }
    },
    [],
  );

  const spec = useMemo<InspectorSpec<TopologicalChargeDraft>>(
    () => ({
      id: "object.extension.topological-charge",
      header: {
        breadcrumbs: objectId
          ? [
              {
                id: "objects",
                label: "Objects",
                selection: buildRootSelection("objects.root", "model:objects", "Objects"),
              },
              {
                id: "object",
                label: objectName,
                selection: buildObjectSelection(objectId, "object.root", objectName),
              },
              { id: "q", label: "Topological Charge" },
            ]
          : [{ id: "q", label: "Topological Charge" }],
        searchable: false,
        primaryHeaderAction: {
          label: busy ? "Computing" : "Compute",
          icon: Calculator,
          disabledReason: busy ? "Topological charge computation is in progress." : undefined,
          onRun: () => {
            resource.refetch();
          },
        },
      },
      identity: {
        domain: "physics",
        icon: Compass,
        title: () => "Topological Charge Q",
        kindLabel: "Berg-Lüscher skyrmion winding diagnostic",
        entityId: objectId ? `${objectId}:topological-charge` : undefined,
        statePill: (d): { tone: InspectorTone; label: string } => {
          if (busy) return { tone: "live", label: "Computing" };
          if (d.chargeText !== null) return { tone: "ok", label: `Q = ${d.chargeText}` };
          return { tone: "info", label: d.statusLabel };
        },
      },
      facts: (d): readonly InspectorFact[] => [
        { id: "q", label: "Charge Q", value: d.chargeText, tone: "ok" },
        { id: "int", label: "Nearest Z", value: d.nearestIntText },
        { id: "err", label: "|Q - Z|", value: d.intErrorText },
        { id: "plane", label: "Plane", value: d.resolvedPlaneLabel },
      ],
      notices: (): readonly InspectorNotice<TopologicalChargeDraft>[] => {
        const notices: InspectorNotice<TopologicalChargeDraft>[] = sortedWarnings.map(
          (w, idx) => ({
            id: `tc-warn-${w.code ?? idx}`,
            tone: String(w.severity) === "error" ? "err" : "warn",
            title: formatCleanLabel(w.code, "Diagnostic notice"),
            text: w.message,
          }),
        );
        if (notices.length === 0 && resource.data && resource.data.status !== "ready") {
          notices.push({
            id: "tc-status",
            tone: "warn",
            title: "Support diagnostic",
            text: `Computation status: ${formatCleanLabel(resource.data.status, "pending")}.`,
          });
        }
        return notices;
      },
      sections: [
        {
          id: "tc-controls",
          title: "Evaluation & 2D support configuration",
          icon: Compass,
          defaultOpen: true,
          live: true,
          rows: [
            {
              key: "calculationMode",
              type: "segmented",
              label: "Evaluation mode",
              options: [
                { value: "on_demand", label: "On demand" },
                { value: "continuous", label: "Continuous" },
              ],
            },
            {
              key: "plane",
              type: "segmented",
              label: "Oriented support plane",
              options: [
                { value: "auto", label: "Auto" },
                { value: "xy", label: "XY" },
                { value: "xz", label: "XZ" },
                { value: "yz", label: "YZ" },
              ],
            },
            {
              key: "support",
              type: "segmented",
              label: "Support carrier",
              structural: true,
              options: [
                { value: "midplane", label: "Midplane" },
                { value: "layer_profile", label: "Layer profile" },
              ],
            },
            {
              key: "profileSamples",
              type: "segmented",
              label: "Profile cut samples",
              showWhen: (d) => d.support === "layer_profile",
              options: [
                { value: "auto", label: "Auto" },
                { value: "17", label: "17" },
                { value: "33", label: "33" },
                { value: "65", label: "65" },
              ],
            },
          ],
        },
        {
          id: "tc-results",
          title: "Computed winding & scientific trust",
          icon: Gauge,
          defaultOpen: true,
          rows: [
            {
              type: "readonly",
              label: "Topological charge Q",
              mono: true,
              format: (d) => d.chargeText ?? "Not yet computed",
            },
            {
              type: "readonly",
              label: "Nearest integer",
              mono: true,
              format: (d) => d.nearestIntText ?? "\u2014",
            },
            {
              type: "readonly",
              label: "Integer error",
              mono: true,
              format: (d) => d.intErrorText ?? "\u2014",
            },
            {
              type: "readonly",
              label: "Computation status",
              format: (d) => d.statusLabel,
            },
            {
              type: "readonly",
              label: "Scientific trust",
              format: (d) => d.trustLabel,
            },
            {
              type: "readonly",
              label: "Resolved support",
              format: (d) => `${d.resolvedPlaneLabel} / ${d.resolvedSupportLabel}`,
            },
            {
              type: "readonly",
              label: "Mesh support sampling",
              mono: true,
              format: (d) => d.samplingLabel,
            },
            {
              type: "readonly",
              label: "Support profile",
              mono: true,
              format: (d) => d.supportProfileLabel,
            },
            {
              type: "custom",
              label: "Through-thickness profile Q(s)",
              wide: true,
              showWhen: (d) => d.profileRows.length > 0,
              render: ({ draft: d }) => (
                <div className="fm-inspector-table" data-slot="topological-charge-profile-table">
                  <div className="fm-inspector-table__wrap">
                    <table
                      aria-label="Through-thickness topological charge profile"
                      className="fm-inspector-table__el"
                    >
                      <thead>
                        <tr>
                          <th scope="col">i</th>
                          <th scope="col">s (nm)</th>
                          <th scope="col">{"\u0394s (nm)"}</th>
                          <th data-align="right" scope="col">
                            Q(s)
                          </th>
                          <th scope="col">Status</th>
                          <th data-align="right" scope="col">
                            Trust
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {d.profileRows.map((row) => (
                          <tr key={row._rowId} data-row-key={row._rowId}>
                            <td className="font-mono tabular-nums">{row.index}</td>
                            <td className="font-mono tabular-nums">{row.coordNm}</td>
                            <td className="font-mono tabular-nums">{row.weightNm}</td>
                            <td className="font-mono tabular-nums" data-align="right">
                              {row.chargeText}
                            </td>
                            <td>{row.statusLabel}</td>
                            <td data-align="right">{row.trustLabel}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ),
            },
          ],
        },
        {
          id: "tc-provenance",
          title: "Provenance & method metadata",
          icon: Database,
          defaultOpen: true,
          rows: [
            {
              type: "readonly",
              label: "Method",
              mono: true,
              format: (d) => d.methodIdLabel,
            },
            {
              type: "readonly",
              label: "Quantity",
              mono: true,
              format: (d) => d.quantityLabel,
            },
            {
              type: "readonly",
              label: "Schema",
              mono: true,
              format: (d) => d.schemaLabel,
            },
            {
              type: "readonly",
              label: "Field revision",
              mono: true,
              format: (d) => d.fieldRevisionLabel,
            },
            {
              type: "readonly",
              label: "Mesh revision",
              mono: true,
              format: (d) => d.meshRevisionLabel,
            },
            {
              type: "readonly",
              label: "Domain generation",
              mono: true,
              format: (d) => d.domainGenerationLabel,
            },
            {
              type: "readonly",
              label: "Mesh generation",
              mono: true,
              format: (d) => d.meshGenerationLabel,
            },
            {
              type: "readonly",
              label: "Requested execution",
              mono: true,
              format: (d) => d.requestedExecutionLabel,
            },
            {
              type: "readonly",
              label: "Resolved execution",
              mono: true,
              format: (d) => d.resolvedExecutionLabel,
            },
          ],
        },
        {
          id: "tc-formulation",
          title: "Berg-Lüscher discrete solid-angle formulation",
          icon: BookOpen,
          defaultOpen: true,
          rows: [
            {
              type: "custom",
              wide: true,
              render: () => (
                <div className="flex flex-col gap-2" data-slot="topological-charge-mathml">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <p className="text-xs text-[var(--fm-text-muted)]">
                      {model.method.description}
                    </p>
                    {model.method.sampleQuality !== "\u2014" ? (
                      <span className="font-mono text-xs text-[var(--fm-text)]">
                        {model.method.sampleQuality}
                      </span>
                    ) : null}
                  </div>
                  <div className="fm-math-equation rounded border border-[var(--fm-border)] bg-[var(--fm-surface-2)] p-2">
                    <span className="mb-1 block text-xs font-semibold text-[var(--fm-text-muted)]">
                      Continuum surface integral
                    </span>
                    {continuumEquation}
                  </div>
                  <div className="fm-math-equation rounded border border-[var(--fm-border)] bg-[var(--fm-surface-2)] p-2">
                    <span className="mb-1 block text-xs font-semibold text-[var(--fm-text-muted)]">
                      Discrete oriented triangles
                    </span>
                    {discreteEquation}
                  </div>
                  <dl className="grid grid-cols-1 gap-1 text-xs">
                    {model.method.terms.map((term) => (
                      <div key={term.symbol} className="flex gap-2">
                        <dt className="w-8 shrink-0 font-serif italic text-[var(--fm-text)]">
                          {term.symbol}
                        </dt>
                        <dd className="text-[var(--fm-text-muted)]">{term.meaning}</dd>
                      </div>
                    ))}
                  </dl>
                  <ul className="list-disc space-y-1 pl-4 text-xs text-[var(--fm-text-muted)]">
                    {model.method.notes.map((note) => (
                      <li key={note}>{note}</li>
                    ))}
                  </ul>
                </div>
              ),
            },
          ],
        },
      ],
      commitBar: {
        mode: "readOnly",
        statusMessage: () =>
          "Diagnostic observable computed non-destructively from magnetization field m",
      },
    }),
    [
      busy,
      model.method.description,
      model.method.notes,
      model.method.sampleQuality,
      model.method.terms,
      objectId,
      objectName,
      resource,
      sortedWarnings,
    ],
  );

  const controller = useInspectorSpecController(spec, selection, baseline, undefined, {
    onLiveFieldChange: handleLiveFieldChange,
  });

  return (
    <InspectorTemplate
      activeModeTabId={controller.activeModeTabId}
      animationKey={controller.animationKey}
      appliedFlash={controller.appliedFlash}
      applyError={controller.applyError}
      applying={controller.applying}
      baseline={controller.baseline}
      dirtyFields={controller.dirtyFields}
      displayUnits={controller.displayUnits}
      draft={controller.draft}
      forceShowErrors={controller.forceShowErrors}
      invalidFields={controller.invalidFields}
      selection={selection}
      spec={spec}
      touchedFields={controller.touchedFields}
      onActiveModeTabChange={controller.setActiveModeTabId}
      onApply={controller.requestApply}
      onDisplayUnitChange={controller.setDisplayUnit}
      onFieldChange={controller.setField}
      onFieldTouch={controller.touchField}
      onFitView={(commandId) => {
        void kernel.commands.execute(
          commandId ?? "viewport-3d.fit-selection",
          createCommandContext("inspector", kernel),
        );
      }}
      onFocusField={(key) => controller.focusField(key as keyof TopologicalChargeDraft & string)}
      onHideInspector={() => {
        kernel.layout.setPanelVisible?.("right", false);
      }}
      onNotify={() => undefined}
      onOpenCodePreview={() => undefined}
      onParseErrorChange={controller.setParseError}
      onPatchDraft={controller.patchDraft}
      onResetDisplay={controller.resetDisplay}
      onRevertAll={controller.revertAll}
      onRevertField={controller.revertField}
      onSelectNode={(next) => {
        kernel.selection.set(next, "inspector");
      }}
    />
  );
}
