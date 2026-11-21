"use client";

import { ArrowRight, Check, Copy } from "lucide-react";
import { useCallback, useMemo, useState, type ReactNode } from "react";

import type { ResourceRevision, SceneResource } from "@/kernel/api/apiTypes";
import { createCommandContext } from "@/kernel/commands/commandContext";
import { useKernel } from "@/kernel/KernelContext";

export type SceneObjectItem = NonNullable<SceneResource["objects"]> extends readonly (infer T)[]
  ? T
  : never;

let wave4InvalidationCounter = 0;

/** Guarantees a valid non-undefined ResourceRevision for `resources.invalidate`. */
export function fallbackRevision(
  revision: number | string | null | undefined,
): ResourceRevision {
  if (typeof revision === "number" || typeof revision === "string") {
    return revision;
  }
  wave4InvalidationCounter += 1;
  return `wave4-rev-${wave4InvalidationCounter}`;
}
import {
  visualizationTargetIdForSceneObject,
  type Selection,
} from "@/kernel/selection/selectionTypes";
import { Badge } from "@/shared/ui/Badge";
import { Button } from "@/shared/ui/Button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/Dialog";

import {
  InspectorTemplate,
  useInspectorSpecController,
  type InspectorSpec,
  type InspectorTone,
  type UnitOption,
  type UseInspectorSpecControllerOptions,
} from "../../template";

/* ── Canonical SI Unit Option Catalogs (Volume III) ── */

export const LENGTH_UNITS: readonly [UnitOption, ...UnitOption[]] = [
  { unit: "nm", toSiFactor: 1e-9 },
  { unit: "\u00b5m", toSiFactor: 1e-6 },
  { unit: "mm", toSiFactor: 1e-3 },
  { unit: "m", toSiFactor: 1 },
];

export const ANGLE_UNITS: readonly [UnitOption, ...UnitOption[]] = [
  { unit: "deg", toSiFactor: Math.PI / 180 },
  { unit: "rad", toSiFactor: 1 },
];

export const MAGNETIZATION_UNITS: readonly [UnitOption, ...UnitOption[]] = [
  { unit: "kA/m", toSiFactor: 1e3 },
  { unit: "MA/m", toSiFactor: 1e6 },
  { unit: "A/m", toSiFactor: 1 },
];

export const EXCHANGE_UNITS: readonly [UnitOption, ...UnitOption[]] = [
  { unit: "pJ/m", toSiFactor: 1e-12 },
  { unit: "fJ/m", toSiFactor: 1e-15 },
  { unit: "J/m", toSiFactor: 1 },
];

export const ANISOTROPY_UNITS: readonly [UnitOption, ...UnitOption[]] = [
  { unit: "kJ/m\u00b3", toSiFactor: 1e3 },
  { unit: "MJ/m\u00b3", toSiFactor: 1e6 },
  { unit: "J/m\u00b3", toSiFactor: 1 },
];

export const DMI_UNITS: readonly [UnitOption, ...UnitOption[]] = [
  { unit: "mJ/m\u00b2", toSiFactor: 1e-3 },
  { unit: "\u00b5J/m\u00b2", toSiFactor: 1e-6 },
  { unit: "J/m\u00b2", toSiFactor: 1 },
];

export const INTERLAYER_UNITS: readonly [UnitOption, ...UnitOption[]] = [
  { unit: "mJ/m\u00b2", toSiFactor: 1e-3 },
  { unit: "\u00b5J/m\u00b2", toSiFactor: 1e-6 },
  { unit: "J/m\u00b2", toSiFactor: 1 },
];

export const GYRO_UNITS: readonly [UnitOption, ...UnitOption[]] = [
  { unit: "GHz/T", toSiFactor: 2 * Math.PI * 1e9 },
  { unit: "rad/(s\u00b7T)", toSiFactor: 1 },
];

export const CONDUCTIVITY_UNITS: readonly [UnitOption, ...UnitOption[]] = [
  { unit: "MS/m", toSiFactor: 1e6 },
  { unit: "kS/m", toSiFactor: 1e3 },
  { unit: "S/m", toSiFactor: 1 },
];

export const DENSITY_UNITS: readonly [UnitOption, ...UnitOption[]] = [
  { unit: "kg/m\u00b3", toSiFactor: 1 },
  { unit: "g/cm\u00b3", toSiFactor: 1e3 },
];

export const ELASTIC_MODULUS_UNITS: readonly [UnitOption, ...UnitOption[]] = [
  { unit: "GPa", toSiFactor: 1e9 },
  { unit: "MPa", toSiFactor: 1e6 },
  { unit: "Pa", toSiFactor: 1 },
];

export const MAGNETOELASTIC_B_UNITS: readonly [UnitOption, ...UnitOption[]] = [
  { unit: "MJ/m\u00b3", toSiFactor: 1e6 },
  { unit: "kJ/m\u00b3", toSiFactor: 1e3 },
  { unit: "J/m\u00b3", toSiFactor: 1 },
];

export const FIELD_TESLA_UNITS: readonly [UnitOption, ...UnitOption[]] = [
  { unit: "mT", toSiFactor: 1e-3 },
  { unit: "\u00b5T", toSiFactor: 1e-6 },
  { unit: "T", toSiFactor: 1 },
];

export const FREQUENCY_UNITS: readonly [UnitOption, ...UnitOption[]] = [
  { unit: "GHz", toSiFactor: 1e9 },
  { unit: "MHz", toSiFactor: 1e6 },
  { unit: "Hz", toSiFactor: 1 },
];

export const TIME_UNITS: readonly [UnitOption, ...UnitOption[]] = [
  { unit: "ps", toSiFactor: 1e-12 },
  { unit: "ns", toSiFactor: 1e-9 },
  { unit: "\u00b5s", toSiFactor: 1e-6 },
  { unit: "s", toSiFactor: 1 },
];

export const TEMPERATURE_UNITS: readonly [UnitOption, ...UnitOption[]] = [
  { unit: "K", toSiFactor: 1 },
  { unit: "mK", toSiFactor: 1e-3 },
];

export const CURRENT_UNITS: readonly [UnitOption, ...UnitOption[]] = [
  { unit: "mA", toSiFactor: 1e-3 },
  { unit: "\u00b5A", toSiFactor: 1e-6 },
  { unit: "A", toSiFactor: 1 },
];

export const VOLTAGE_UNITS: readonly [UnitOption, ...UnitOption[]] = [
  { unit: "mV", toSiFactor: 1e-3 },
  { unit: "\u00b5V", toSiFactor: 1e-6 },
  { unit: "V", toSiFactor: 1 },
];

export const CURRENT_DENSITY_UNITS: readonly [UnitOption, ...UnitOption[]] = [
  { unit: "GA/m\u00b2", toSiFactor: 1e9 },
  { unit: "TA/m\u00b2", toSiFactor: 1e12 },
  { unit: "A/m\u00b2", toSiFactor: 1 },
];

export const MIXING_CONDUCTANCE_UNITS: readonly [UnitOption, ...UnitOption[]] = [
  { unit: "TS/m\u00b2", toSiFactor: 1e12 },
  { unit: "GS/m\u00b2", toSiFactor: 1e9 },
  { unit: "S/m\u00b2", toSiFactor: 1 },
];

export const MU0_SI = 4 * Math.PI * 1e-7;
export const ELECTRON_GAMMA_PER_G = 8.79410005e10; // rad/(s*T) per Lande g=1 (e / (2 m_e))

/* ── Compact SI Formatters (never emitting "unknown" or "unavailable") ── */

export function formatLengthAuto(meters: number | null | undefined): string | null {
  if (typeof meters !== "number" || !Number.isFinite(meters)) return null;
  const abs = Math.abs(meters);
  if (abs === 0) return "0 nm";
  if (abs >= 1e-2) return `${Number((meters * 1e3).toPrecision(4))} mm`;
  if (abs >= 1e-6) return `${Number((meters * 1e6).toPrecision(4))} \u00b5m`;
  return `${Number((meters * 1e9).toPrecision(4))} nm`;
}

export function formatSpanAuto(
  span: readonly [number, number, number] | null | undefined,
): string | null {
  if (!span || span.some((v) => !Number.isFinite(v))) return null;
  const maxAbs = Math.max(Math.abs(span[0]), Math.abs(span[1]), Math.abs(span[2]));
  if (maxAbs >= 1e-3) {
    return `${span.map((v) => Number((v * 1e3).toPrecision(4))).join(" \u00d7 ")} mm`;
  }
  if (maxAbs >= 1e-6) {
    return `${span.map((v) => Number((v * 1e6).toPrecision(4))).join(" \u00d7 ")} \u00b5m`;
  }
  return `${span.map((v) => Number((v * 1e9).toPrecision(4))).join(" \u00d7 ")} nm`;
}

export function formatVolumeAuto(cubicMeters: number | null | undefined): string | null {
  if (typeof cubicMeters !== "number" || !Number.isFinite(cubicMeters) || cubicMeters <= 0) {
    return null;
  }
  if (cubicMeters >= 1e-18) {
    return `${Number((cubicMeters * 1e18).toPrecision(4))} \u00b5m\u00b3`;
  }
  return `${Number((cubicMeters * 1e27).toPrecision(4))} nm\u00b3`;
}

export function formatAreaAuto(squareMeters: number | null | undefined): string | null {
  if (typeof squareMeters !== "number" || !Number.isFinite(squareMeters) || squareMeters <= 0) {
    return null;
  }
  if (squareMeters >= 1e-12) {
    return `${Number((squareMeters * 1e12).toPrecision(4))} \u00b5m\u00b2`;
  }
  return `${Number((squareMeters * 1e18).toPrecision(4))} nm\u00b2`;
}

export function vectorNorm(vec: readonly [number, number, number]): number {
  return Math.hypot(vec[0], vec[1], vec[2]);
}

export function normalizeVector3(
  vec: readonly [number, number, number],
  fallback: readonly [number, number, number] = [0, 0, 1],
): [number, number, number] {
  const norm = vectorNorm(vec);
  if (!Number.isFinite(norm) || norm < 1e-15) {
    return [fallback[0], fallback[1], fallback[2]];
  }
  return [vec[0] / norm, vec[1] / norm, vec[2] / norm];
}

/** Extrinsic XYZ Euler angles in degrees -> unit quaternion [x, y, z, w]. */
export function eulerDegToQuat(
  eulerDeg: readonly [number, number, number],
): [number, number, number, number] {
  const rx = (eulerDeg[0] * Math.PI) / 360;
  const ry = (eulerDeg[1] * Math.PI) / 360;
  const rz = (eulerDeg[2] * Math.PI) / 360;
  const cx = Math.cos(rx);
  const sx = Math.sin(rx);
  const cy = Math.cos(ry);
  const sy = Math.sin(ry);
  const cz = Math.cos(rz);
  const sz = Math.sin(rz);

  const x = sx * cy * cz - cx * sy * sz;
  const y = cx * sy * cz + sx * cy * sz;
  const z = cx * cy * sz - sx * sy * cz;
  const w = cx * cy * cz + sx * sy * sz;
  const norm = Math.hypot(x, y, z, w) || 1;
  return [x / norm, y / norm, z / norm, w / norm];
}

/** Unit quaternion [x, y, z, w] -> intrinsic XYZ Euler angles in degrees. */
export function quatToEulerDeg(
  quat: readonly number[] | null | undefined,
): [number, number, number] {
  if (!quat || quat.length < 4 || quat.some((c) => typeof c !== "number" || !Number.isFinite(c))) {
    return [0, 0, 0];
  }
  const norm = Math.hypot(quat[0]!, quat[1]!, quat[2]!, quat[3]!) || 1;
  const x = quat[0]! / norm;
  const y = quat[1]! / norm;
  const z = quat[2]! / norm;
  const w = quat[3]! / norm;

  const sinp = Math.max(-1, Math.min(1, 2 * (w * y - z * x)));
  const ry = Math.asin(sinp);
  let rx: number;
  let rz: number;
  if (Math.abs(sinp) < 0.999999) {
    rx = Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y));
    rz = Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z));
  } else {
    rx = Math.atan2(-2 * (y * z - w * x), 1 - 2 * (x * x + z * z));
    rz = 0;
  }
  const toDeg = (rad: number) => {
    const deg = (rad * 180) / Math.PI;
    return Math.abs(deg) < 1e-9 ? 0 : Number(deg.toFixed(4));
  };
  return [toDeg(rx), toDeg(ry), toDeg(rz)];
}

/* ── Canonical Selection Navigation Builders ── */

export function buildRootSelection(
  kind: Selection["kind"],
  nodeId: string,
  label: string,
): Omit<Selection, "moduleSource"> {
  if (kind === "study.root") {
    return {
      kind,
      label,
      nodeId,
      objectId: null,
      ref: { kind, nodeId, type: "study" },
    };
  }
  return {
    kind,
    label,
    nodeId,
    objectId: null,
    ref: null,
  };
}

export function buildObjectSelection(
  objectId: string,
  kind:
    | "object.root"
    | "object.geometry"
    | "object.material"
    | "object.regions"
    | "object.magnetic-texture"
    | "object.mesh"
    | "object.visualization"
    | "object.absorbing-boundary"
    | "object.physics"
    | "object.extension.topological-charge"
    | "object.antenna"
    | "object.antenna.geometry",
  label: string,
  extra?: { extensionId?: string; nodeId?: string; objectRole?: "antenna" | "auxiliary" | "magnet" },
): Omit<Selection, "moduleSource"> {
  const suffixMap: Record<string, string> = {
    "object.root": "",
    "object.geometry": ":geometry",
    "object.antenna": ":antenna",
    "object.antenna.geometry": ":geometry",
    "object.material": ":material",
    "object.regions": ":regions",
    "object.magnetic-texture": ":magnetic-texture",
    "object.mesh": ":mesh",
    "object.visualization": ":visualization",
    "object.absorbing-boundary": ":absorbing-boundary",
    "object.physics": ":physics",
    "object.extension.topological-charge": `:extensions:${extra?.extensionId ?? "topological-charge"}`,
  };
  const nodeId = extra?.nodeId ?? `model:object:${objectId}${suffixMap[kind] ?? ""}`;
  return {
    kind,
    label,
    nodeId,
    objectId,
    ref: {
      ...(extra?.extensionId ? { extensionId: extra.extensionId } : {}),
      kind,
      nodeId,
      objectId,
      ...(extra?.objectRole ? { objectRole: extra.objectRole } : {}),
      type: "scene-object",
      visualizationTargetId: visualizationTargetIdForSceneObject(objectId),
    },
  };
}

export function buildRegionSelection(
  objectId: string,
  regionId: string,
  kind:
    | "object.region"
    | "object.region.magnetic-parameters"
    | "object.region.mesh"
    | "object.region.texture"
    | "object.region.visualization",
  label: string,
): Omit<Selection, "moduleSource"> {
  const baseId = `model:object:${objectId}:regions:${regionId}`;
  const suffixMap: Record<string, string> = {
    "object.region": "",
    "object.region.magnetic-parameters": ":magnetic-parameters",
    "object.region.mesh": ":mesh",
    "object.region.texture": ":texture",
    "object.region.visualization": ":visualization",
  };
  const nodeId = `${baseId}${suffixMap[kind] ?? ""}`;
  return {
    kind,
    label,
    nodeId,
    objectId,
    ref: {
      kind,
      nodeId,
      objectId,
      regionId,
      type: "scene-object",
      visualizationTargetId: visualizationTargetIdForSceneObject(objectId, regionId),
    },
  };
}

export function buildBuilderPrimitiveSelection(
  primitiveSlug: string,
  label: string,
): Omit<Selection, "moduleSource"> {
  return {
    kind: "builder.primitive",
    label,
    nodeId: `builder:primitive:${primitiveSlug}`,
    objectId: null,
    ref: null,
  };
}

/* ── Reusable Shortcut Card List (for clean Parent -> Child overview navigation) ── */

export interface InspectorShortcutCardItem {
  id: string;
  title: string;
  subtitle?: string;
  badge?: string;
  tone?: InspectorTone;
  selection: Omit<Selection, "moduleSource">;
}

export function InspectorShortcutCards({
  items,
  onSelect,
}: {
  items: readonly InspectorShortcutCardItem[];
  onSelect: (selection: Omit<Selection, "moduleSource">) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5" data-slot="inspector-shortcut-cards">
      {items.map((item) => (
        <div
          key={item.id}
          className="flex items-center justify-between gap-2 rounded-md border border-[var(--fm-border)] bg-[var(--fm-surface-2)] px-2.5 py-2"
        >
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-xs font-medium text-[var(--fm-text)]">
                {item.title}
              </span>
              {item.badge ? (
                <Badge className="shrink-0" data-tone={item.tone ?? "neutral"}>
                  {item.badge}
                </Badge>
              ) : null}
            </div>
            {item.subtitle ? (
              <p className="mt-0.5 truncate text-xs text-[var(--fm-text-muted)]">
                {item.subtitle}
              </p>
            ) : null}
          </div>
          <Button
            aria-label={`Open ${item.title}`}
            size="sm"
            type="button"
            variant="ghost"
            onClick={() => onSelect(item.selection)}
          >
            <span>Open</span>
            <ArrowRight aria-hidden="true" size={12} />
          </Button>
        </div>
      ))}
    </div>
  );
}

/* ── Host Component Connecting `useInspectorSpecController` + `Kernel` to `InspectorTemplate` ── */

export interface SpecInspectorHostProps<TDraft extends object> {
  spec: InspectorSpec<TDraft>;
  selection: Selection;
  baseline: TDraft;
  serverFieldErrors?: Readonly<Record<string, string | null | undefined>>;
  options?: UseInspectorSpecControllerOptions<TDraft>;
  children?: ReactNode;
}

export function SpecInspectorHost<TDraft extends object>({
  spec,
  selection,
  baseline,
  serverFieldErrors,
  options,
  children,
}: SpecInspectorHostProps<TDraft>) {
  const kernel = useKernel();
  const controller = useInspectorSpecController(
    spec,
    selection,
    baseline,
    serverFieldErrors,
    options,
  );

  const [codePreview, setCodePreview] = useState<{
    title: string;
    language: "python" | "json";
    code: string;
  } | null>(null);
  const [copiedCode, setCopiedCode] = useState(false);
  const [statusToast, setStatusToast] = useState<string | null>(null);

  const handleSelectNode = useCallback(
    (next: Omit<Selection, "moduleSource">) => {
      kernel.selection.set(next, "inspector");
    },
    [kernel.selection],
  );

  const handleFitView = useCallback(
    (commandId?: Parameters<typeof kernel.commands.execute>[0]) => {
      const resolvedId = commandId ?? "viewport-3d.fit-selection";
      void kernel.commands.execute(resolvedId, createCommandContext("inspector", kernel));
    },
    [kernel],
  );

  const handleHideInspector = useCallback(() => {
    kernel.layout.setPanelVisible("right", false);
  }, [kernel.layout]);

  const handleOpenCodePreview = useCallback(
    (title: string, language: "python" | "json", code: string) => {
      setCopiedCode(false);
      setCodePreview({ title, language, code });
    },
    [],
  );

  const handleNotify = useCallback((title: string, description?: string) => {
    setStatusToast(description ? `${title}: ${description}` : title);
  }, []);

  const codeLanguageLabel = useMemo(
    () => (codePreview?.language === "json" ? "JSON payload" : "Python authoring snippet"),
    [codePreview?.language],
  );

  return (
    <>
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
        onFitView={handleFitView}
        onFocusField={(key) => controller.focusField(key as keyof TDraft & string)}
        onHideInspector={handleHideInspector}
        onNotify={handleNotify}
        onOpenCodePreview={handleOpenCodePreview}
        onParseErrorChange={controller.setParseError}
        onPatchDraft={controller.patchDraft}
        onResetDisplay={controller.resetDisplay}
        onRevertAll={controller.revertAll}
        onRevertField={controller.revertField}
        onSelectNode={handleSelectNode}
      />

      {statusToast ? (
        <span className="sr-only" role="status">
          {statusToast}
        </span>
      ) : null}

      {children}

      <Dialog
        open={codePreview !== null}
        onOpenChange={(open) => {
          if (!open) setCodePreview(null);
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
            <Button
              size="sm"
              type="button"
              variant="secondary"
              onClick={() => {
                if (codePreview) {
                  void navigator.clipboard?.writeText(codePreview.code).catch(() => undefined);
                  setCopiedCode(true);
                }
              }}
            >
              {copiedCode ? <Check aria-hidden="true" size={14} /> : <Copy aria-hidden="true" size={14} />}
              <span>{copiedCode ? "Copied" : "Copy"}</span>
            </Button>
            <Button
              size="sm"
              type="button"
              variant="primary"
              onClick={() => setCodePreview(null)}
            >
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
